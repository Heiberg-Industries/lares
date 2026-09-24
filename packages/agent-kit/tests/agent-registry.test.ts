import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readResolvedTools, registerAgent } from "../src/agent-registry.js";

const here = dirname(fileURLToPath(import.meta.url));
let c: StartedPostgreSqlContainer;
let pool: Pool;
beforeAll(async () => {
  c = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: c.getConnectionUri() });
  for (const f of ["008_ratchet.sql", "038_permissions_board.sql"]) {
    await pool.query(readFileSync(join(here, "../../../services/box/sql", f), "utf8"));
  }
}, 120_000);
afterAll(async () => { await pool?.end(); await c?.stop(); });

// A fake service dir: eve's compiled manifest + a fake eve package exposing its framework tool names.
function fakeService(): string {
  const d = mkdtempSync(join(tmpdir(), "reg-"));
  mkdirSync(join(d, ".output/.eve/compile"), { recursive: true });
  writeFileSync(join(d, ".output/.eve/compile/compiled-agent-manifest.json"), JSON.stringify({
    tools: [{ name: "vault_write" }, { name: "atlas_read" }], disabledFrameworkTools: ["bash"],
  }));
  mkdirSync(join(d, "node_modules/eve/dist/src/runtime/framework-tools"), { recursive: true });
  writeFileSync(join(d, "node_modules/eve/dist/src/runtime/framework-tools/index.js"),
    'export function getAllFrameworkToolNames() { return new Set(["bash", "web_fetch"]); }');
  return d;
}
const manifest = {
  name: "calliope", model: "lares-brain", persona: "agent/instructions.md", role: "creative",
  channels: ["slack"], grants: [{ capability: "vault", scope: "write-with-confirm" }], autonomy: { vault: "gated" },
};

describe("agent registry", () => {
  it("reads the tools /eve/v1/info will list: authored + enabled framework tools", async () => {
    expect(await readResolvedTools(fakeService())).toEqual(["atlas_read", "vault_write", "web_fetch"]);
    expect(await readResolvedTools(mkdtempSync(join(tmpdir(), "empty-")))).toBeNull();
  });
  it("writes one row per agent and replaces it on the next start", async () => {
    const d = fakeService();
    await registerAgent({ manifest, serviceDir: d, pool });
    await registerAgent({ manifest: { ...manifest, autonomy: { vault: "autonomous" } }, serviceDir: d, pool });
    const { rows } = await pool.query("SELECT name, role, autonomy, doors, tools FROM agent_registry");
    // ORB-278 step 2: the registry parses a DEFINITION and stores `doorsOf(m)` — each door's
    // kind plus whether it is switched on — where it stored the bare `channels` list before. A
    // definition with no `doors` array (this one, and all three shipped agents today) derives
    // them from `channels`, every one enabled.
    expect(rows).toEqual([{
      name: "calliope", role: "creative", autonomy: { vault: "autonomous" },
      doors: [{ kind: "slack", enabled: true }], tools: ["atlas_read", "vault_write", "web_fetch"],
    }]);
  });
  it("a definition that declares doors explicitly keeps each door's enabled flag", async () => {
    const d = fakeService();
    await registerAgent({
      manifest: { ...manifest, doors: [{ kind: "slack" }, { kind: "telegram", enabled: false }] },
      serviceDir: d, pool,
    });
    const { rows } = await pool.query("SELECT doors FROM agent_registry WHERE name = 'calliope'");
    expect(rows[0].doors).toEqual([{ kind: "slack", enabled: true }, { kind: "telegram", enabled: false }]);
  });
  it("never throws when the database is unreachable", async () => {
    const broken = new Pool({ connectionString: "postgres://x@127.0.0.1:1/x", connectionTimeoutMillis: 200 });
    await expect(registerAgent({ manifest, serviceDir: fakeService(), pool: broken })).resolves.toBeUndefined();
    await broken.end();
  });
});
