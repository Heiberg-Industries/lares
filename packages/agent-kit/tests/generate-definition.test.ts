import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDefinition, parseDefinition } from "../src/definition.js";
import { assemblePersona, deployedToolsFor } from "../src/persona/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(service = "creative") {
  const dir = mkdtempSync(join(tmpdir(), "lares-generate-test-")); temporary.push(dir);
  const source = join(dir, "source"); mkdirSync(join(source, "agent"), { recursive: true });
  const serviceDir = join(root, "services", service);
  const raw = JSON.parse(readFileSync(join(serviceDir, "agent.json"), "utf8"));
  const voice = readFileSync(join(serviceDir, "agent/voice.md"));
  writeFileSync(join(source, "agent.json"), JSON.stringify(raw));
  writeFileSync(join(source, "agent/voice.md"), voice);
  return { dir, source, out: join(dir, "definition"), serviceDir, raw, voice };
}
function run(f: ReturnType<typeof fixture>, ...extra: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", join(root, "packages/agent-kit/bin/generate-definition.ts"),
    "--agent", f.source, "--role", f.raw.role, "--out", f.out, ...extra], { cwd: root, encoding: "utf8" });
}

describe("offline definition generator", () => {
  it.each(["creative", "travel", "chief-of-staff"])("preserves %s declaration and voice and reproduces committed instructions", async service => {
    const f = fixture(service);
    expect(run(f).status).toBe(0);
    const raw = JSON.parse(readFileSync(join(f.out, "agent.json"), "utf8"));
    expect(raw).toEqual(f.raw);
    expect(() => parseDefinition(raw)).not.toThrow();
    for (const field of ["language", "duties", "doors", "gender"]) expect(raw).not.toHaveProperty(field);
    expect(readFileSync(join(f.out, "voice.md"))).toEqual(f.voice);
    expect(readdirSync(f.out).sort()).toEqual(["agent.json", "voice.md"]);
    const loaded = await loadDefinition({ serviceDir: f.serviceDir, env: { LARES_DEFINITION_DIR: f.out } });
    expect(loaded.dutiesMd).toBe("");
    const assembled = assemblePersona({ manifest: loaded.definition,
      roleMd: readFileSync(join(root, "packages/agent-kit/templates", f.raw.role, "role.md"), "utf8"),
      voiceMd: loaded.voiceMd, dutiesMd: loaded.dutiesMd,
      displayName: loaded.definition.display ?? loaded.definition.name, deployedTools: deployedToolsFor(f.serviceDir) });
    expect(assembled).toBe(readFileSync(join(f.serviceDir, "agent/persona.md"), "utf8"));
    expect(run(f, "--check").status).toBe(0);
  });
  it("adds only a missing role and retains framework tools and exact voice bytes", () => {
    const f = fixture("travel"); const original = { ...f.raw, framework_tools: ["web_search"] }; delete original.role;
    writeFileSync(join(f.source, "agent.json"), JSON.stringify(original));
    const voice = Buffer.from("Voice\r\nUnicode: æøå\r\n\r\n"); writeFileSync(join(f.source, "agent/voice.md"), voice);
    expect(run(f).status).toBe(0);
    expect(JSON.parse(readFileSync(join(f.out, "agent.json"), "utf8"))).toEqual({ ...original, role: "travel" });
    expect(readFileSync(join(f.out, "voice.md"))).toEqual(voice);
  });
  it("retains the source name and both nested commercial and market skills", () => {
    const f = fixture("chief-of-staff");
    const raw = { ...f.raw, name: "example-chief", skills: [
      { name: "commercial", requires: [{ capability: "twenty", scope: "read" }, { capability: "orakel", scope: "read" }] },
      { name: "market-edge", requires: [{ capability: "markets", scope: "read" }] },
    ], grants: [...f.raw.grants.filter((g: {capability: string}) => g.capability !== "markets"), { capability: "markets", scope: "read" }],
      autonomy: { ...f.raw.autonomy, markets: "gated" } };
    writeFileSync(join(f.source, "agent.json"), JSON.stringify(raw));
    expect(run(f).status).toBe(0);
    expect(JSON.parse(readFileSync(join(f.out, "agent.json"), "utf8"))).toEqual(raw);
  });
  it("check refuses missing/stale files and unexpected duties without writing", () => {
    const f = fixture(); expect(run(f, "--check").status).toBe(1); expect(readdirSync(f.dir)).toEqual(["source"]);
    expect(run(f).status).toBe(0);
    writeFileSync(join(f.out, "voice.md"), "changed");
    expect(run(f, "--check").stderr).toContain("STALE");
    expect(readFileSync(join(f.out, "voice.md"), "utf8")).toBe("changed");
    writeFileSync(join(f.out, "voice.md"), f.voice); writeFileSync(join(f.out, "duties.md"), "");
    expect(run(f, "--check").stderr).toContain("no duties");
  });
  it("refuses overwriting an existing directory or a role mismatch", () => {
    const f = fixture(); mkdirSync(f.out); writeFileSync(join(f.out, "sentinel"), "retained");
    expect(run(f).status).toBe(1); expect(readdirSync(f.out)).toEqual(["sentinel"]);
    expect(run(f, "--role", "travel").stderr).toContain("source role differs");
  });
  it.each(["language", "duties", "doors", "gender"])("surfaces forbidden source %s instead of silently changing it", field => {
    const f = fixture(); writeFileSync(join(f.source, "agent.json"), JSON.stringify({ ...f.raw, [field]: null }));
    expect(run(f).stderr).toContain(`source declares ${field}`); expect(readdirSync(f.dir)).toEqual(["source"]);
  });
  it("validates before writing and rejects unknown CLI options", () => {
    const f = fixture(); writeFileSync(join(f.source, "agent.json"), JSON.stringify({ ...f.raw, unknown: true }));
    expect(run(f).status).toBe(1); expect(readdirSync(f.dir)).toEqual(["source"]);
    expect(run(f, "--bogus").status).toBe(2);
  });
});
