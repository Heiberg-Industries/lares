import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doorsOf, hashOf, loadDefinition, parseDefinition } from "../src/definition.js";

const MINIMAL = {
  name: "bookkeeper", display: "Bookkeeper", model: "heiberg-utility", role: "chief-of-staff",
  persona: "agent/instructions.md",
  grants: [{ capability: "gmail", scope: "write-with-confirm" }], autonomy: { gmail: "gated" },
};

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "defn-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}

describe("the definition", () => {
  it("is today's agent.json plus six optional fields", () => {
    const d = parseDefinition({ ...MINIMAL });
    expect(d.gender).toBeUndefined();
    expect(d.description).toBeUndefined();
    expect(d.language).toBeUndefined();   // D3: absent, not "en"
    expect(d.duties).toBe("duties.md");
    expect(d.schedules).toEqual({});
    expect(d.doors).toBeUndefined();
  });

  it("rejects an unknown field, so a typo is never silently ignored", () => {
    expect(() => parseDefinition({ ...MINIMAL, langauge: "no" })).toThrow(/langauge/);
  });

  it("reads a definition folder when LARES_DEFINITION_DIR is set", async () => {
    const d = dir({
      "agent.json": JSON.stringify({ ...MINIMAL, language: "no", doors: [{ kind: "telegram", enabled: true }] }),
      "duties.md": "Keep the books.\n",
      "voice.md": "Dry.\n",
    });
    const loaded = await loadDefinition({ serviceDir: "/nowhere", env: { LARES_DEFINITION_DIR: d } });
    expect(loaded.source).toBe("definition");
    expect(loaded.definition.name).toBe("bookkeeper");
    expect(loaded.definition.language).toBe("no");
    expect(loaded.dutiesMd).toBe("Keep the books.\n");
    expect(doorsOf(loaded.definition)).toEqual([{ kind: "telegram", enabled: true }]);
  });

  it("falls back to the service's own committed neutral files when the env is unset", async () => {
    const svc = new URL("../../../services/creative", import.meta.url).pathname;
    const loaded = await loadDefinition({ serviceDir: svc, env: {} });
    expect(loaded.source).toBe("service");
    expect(loaded.definition.name).toBe("creative");
    expect(loaded.dutiesMd).toBe("");            // no duties.md ships in the engine
    expect(loaded.voiceMd.length).toBeGreaterThan(0);
  });

  it("a missing duties.md is an empty duties section, not an error", async () => {
    const d = dir({ "agent.json": JSON.stringify({ ...MINIMAL }), "voice.md": "Dry.\n" });
    const loaded = await loadDefinition({ serviceDir: "/nowhere", env: { LARES_DEFINITION_DIR: d } });
    expect(loaded.dutiesMd).toBe("");
  });

  it("a missing agent.json in a set LARES_DEFINITION_DIR throws — it never silently falls back", async () => {
    const d = dir({ "voice.md": "Dry.\n" });
    await expect(loadDefinition({ serviceDir: "/nowhere", env: { LARES_DEFINITION_DIR: d } }))
      .rejects.toThrow(/agent\.json/);
  });

  it("hashes the whole definition, so a duties edit changes the hash", () => {
    const base = { definition: parseDefinition({ ...MINIMAL }), dutiesMd: "a", voiceMd: "v" };
    expect(hashOf(base)).toBe(hashOf({ ...base }));
    expect(hashOf(base)).not.toBe(hashOf({ ...base, dutiesMd: "b" }));
  });

  it("derives doors from legacy channels when doors is absent", () => {
    const d = parseDefinition({ ...MINIMAL, channels: ["slack", "telegram"] });
    expect(doorsOf(d)).toEqual([{ kind: "slack", enabled: true }, { kind: "telegram", enabled: true }]);
  });
});
