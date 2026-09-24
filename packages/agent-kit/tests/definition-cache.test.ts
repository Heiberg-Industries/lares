import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lastValid, rememberValid, resolveDefinition } from "../src/definition-cache.js";
import { loadDefinition } from "../src/definition.js";

const sql = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../services/box/sql", f), "utf8");

let c: StartedPostgreSqlContainer;
let pool: Pool;
beforeAll(async () => {
  c = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: c.getConnectionUri() });
  await pool.query(sql("039_agent_definitions.sql"));
}, 120_000);
afterAll(async () => {
  await pool?.end();
  await c?.stop();
});

const GOOD = {
  name: "bookkeeper", display: "Bookkeeper", model: "heiberg-utility", persona: "agent/instructions.md",
  role: "chief-of-staff", grants: [{ capability: "gmail", scope: "write-with-confirm" }], autonomy: { gmail: "gated" },
};
const ROLE = "I keep the books.\n";

function folder(agentJson: unknown, duties = "", voice = "Dry.\n"): string {
  const d = mkdtempSync(join(tmpdir(), "defn-"));
  writeFileSync(join(d, "agent.json"), typeof agentJson === "string" ? agentJson : JSON.stringify(agentJson));
  writeFileSync(join(d, "voice.md"), voice);
  if (duties) writeFileSync(join(d, "duties.md"), duties);
  return d;
}

// The agent's identity is always an INPUT (`agentName`) — never inferred from the folder's
// content, which may be exactly what's broken. Defaults to "bookkeeper" to match GOOD.name;
// individual tests override it where they deliberately mount a different agent's folder.
const opts = (dir: string, agentName = "bookkeeper", onInvalid?: (a: string, r: string) => void) =>
  ({ serviceDir: "/nowhere", roleMd: ROLE, deployedTools: [], pool, env: { LARES_DEFINITION_DIR: dir }, agentName, onInvalid });

describe("resolveDefinition", () => {
  it("uses a valid folder and remembers it", async () => {
    const r = await resolveDefinition(opts(folder(GOOD, "Books.\n")));
    expect(r.usedFallback).toBe(false);
    expect(r.loaded.dutiesMd).toBe("Books.\n");
    expect((await lastValid(pool, "bookkeeper"))?.dutiesMd).toBe("Books.\n");
  });

  it("falls back to the last valid one when the folder stops parsing, and says why", async () => {
    await rememberValid(pool, await loadDefinition({ serviceDir: "/nowhere", env: { LARES_DEFINITION_DIR: folder(GOOD, "Books.\n") } }));
    const reasons: string[] = [];
    const r = await resolveDefinition({ ...opts(folder("{ not json"), "bookkeeper", (_a, why) => reasons.push(why)), });
    expect(r.usedFallback).toBe(true);
    expect(r.loaded.dutiesMd).toBe("Books.\n");
    expect(r.reason).toMatch(/not valid JSON/);
    expect(reasons).toHaveLength(1);
  });

  it("falls back when the folder parses but does not VALIDATE", async () => {
    // Own agent name, own seed row: this test must not ride on an earlier test's write to the
    // shared container. Review finding (ORB-278 step 2, second pass): the previous version used
    // the default "bookkeeper" and relied on an earlier test having already remembered it.
    const agentName = "modelbad";
    await rememberValid(pool, await loadDefinition({
      serviceDir: "/nowhere",
      env: { LARES_DEFINITION_DIR: folder({ ...GOOD, name: agentName }, "Modelbad's duties.\n") },
    }));
    const bad = folder({ ...GOOD, name: agentName, model: "claude-opus-5" });
    const r = await resolveDefinition(opts(bad, agentName));
    expect(r.usedFallback).toBe(true);
    expect(r.reason).toMatch(/model-alias/);
    expect(r.loaded.dutiesMd).toBe("Modelbad's duties.\n");
  });

  it("records the invalid status so the console can show it", async () => {
    // Same finding: this used to read back the PREVIOUS test's write to 'bookkeeper'. It now
    // performs its own seed, its own invalid resolve, and its own read — under its own agent
    // name — so the whole cause-and-effect lives inside this one test.
    const agentName = "statuscheck";
    await rememberValid(pool, await loadDefinition({
      serviceDir: "/nowhere",
      env: { LARES_DEFINITION_DIR: folder({ ...GOOD, name: agentName }) },
    }));
    const bad = folder({ ...GOOD, name: agentName, model: "claude-opus-5" });
    await resolveDefinition(opts(bad, agentName));
    const { rows } = await pool.query("SELECT status, status_reason FROM agent_definitions WHERE name = $1", [agentName]);
    expect(rows[0].status).toBe("invalid");
    expect(rows[0].status_reason).toMatch(/model-alias/);
  });

  it("THROWS when the folder is invalid and there is no last valid one — never a half-configured agent", async () => {
    await expect(resolveDefinition({ ...opts(folder({ ...GOOD, name: "stranger", model: "gpt-5" }), "stranger") }))
      .rejects.toThrow(/model-alias/);
  });

  // Review finding (ORB-278 step 2, Task 4 fix report): the sketch this test was reviewed against
  // inferred identity from the broken file itself and only passed because an EARLIER test in the
  // same file had left a process-lifetime memo behind. Proving this test is self-contained — it
  // remembers its own "bookkeeper" row and passes `agentName` explicitly — is the point: run with
  // `vitest run tests/definition-cache.test.ts -t "stops parsing"` and it must still pass alone.

  it("refuses a definition that names a different agent than the one this folder is mounted for, and falls back", async () => {
    await rememberValid(pool, await loadDefinition({ serviceDir: "/nowhere", env: { LARES_DEFINITION_DIR: folder({ ...GOOD, name: "marcel" }, "Marcel's duties.\n") } }));
    const reasons: string[] = [];
    // This folder's own agent.json says "saga" — but it is mounted (agentName) for "marcel".
    const wrongFolder = folder({ ...GOOD, name: "saga" });
    const r = await resolveDefinition(opts(wrongFolder, "marcel", (_a, why) => reasons.push(why)));
    expect(r.usedFallback).toBe(true);
    expect(r.loaded.dutiesMd).toBe("Marcel's duties.\n");
    expect(r.reason).toMatch(/declares agent "saga".*mounted for "marcel"/s);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/declares agent "saga".*mounted for "marcel"/s);
  });

  it("throws on a broken folder with no remembered row for THAT agent — the fail-closed branch, exercised", async () => {
    // A brand-new agent name never remembered in this suite: the fallback lookup must come back
    // empty, and the function must throw rather than boot on nothing.
    await expect(resolveDefinition(opts(folder("{ not json"), "never-seen-before")))
      .rejects.toThrow(/no last valid one to fall back to/);
  });

  it("does not consult the database at all when LARES_DEFINITION_DIR is unset", async () => {
    const svc = new URL("../../../services/creative", import.meta.url).pathname;
    const r = await resolveDefinition({ serviceDir: svc, roleMd: ROLE, deployedTools: [], agentName: "creative", pool: undefined, env: {} });
    expect(r.usedFallback).toBe(false);
    expect(r.loaded.source).toBe("service");
  });
});
