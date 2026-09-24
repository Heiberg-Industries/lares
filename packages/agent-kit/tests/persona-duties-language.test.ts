// The instruction stack gains DUTIES and LANGUAGE (ORB-278 step 2, Task 5; spec Part 3).
//
// Spec Part 3's order, and it is load-bearing: 1 who I am · 2 where I run · 3 the role
// (engine-owned, not editable) · 4 the owner's duties · 5 the voice · 6 the language. The
// engine's rules come BEFORE the owner's words, and the owner's words can only add.
//
// THE FIRST CASE IS THE GATE FOR THE WHOLE PLAN. With empty duties and no language, the stack
// must assemble to exactly the bytes each service's committed persona file already holds — that
// is what makes "agents become definitions" a change of WHERE the persona comes from and not a
// change of WHAT it says. If it ever goes red, the fault is a changed render or a stale
// committed file, never something to fix by relaxing the comparison.
//
// Deliberately NOT in tests/persona-assemble.test.ts — that file is LAR-2's and is frozen.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseDefinition } from "../src/definition.js";
import { assemblePersona } from "../src/persona/assemble.js";
import { deployedToolsFor } from "../src/persona/deployed-tools.js";

const SERVICES = ["chief-of-staff", "travel", "creative"] as const;
const root = (s: string) => new URL(`../../../services/${s}`, import.meta.url).pathname;
const templates = new URL("../templates", import.meta.url).pathname;

/** The persona file each service commits, read through its own declaration's `persona` field
 *  rather than a literal — the same property the services' own drift tests rely on, so the
 *  Task 5 rename (agent/instructions.md -> agent/persona.md, because eve reads a root
 *  instructions.md AND agent/instructions/ TOGETHER) needs no edit here. */
function committedPersona(dir: string, personaPath: string): string {
  return readFileSync(`${dir}/${personaPath}`, "utf8");
}

describe("the instruction stack", () => {
  it.each(SERVICES)("%s: empty duties and no language assemble to exactly today's persona file", (svc) => {
    const dir = root(svc);
    const raw = JSON.parse(readFileSync(`${dir}/agent.json`, "utf8")) as { persona: string };
    const manifest = parseDefinition(raw);
    const out = assemblePersona({
      manifest,
      roleMd: readFileSync(`${templates}/${manifest.role}/role.md`, "utf8"),
      voiceMd: readFileSync(`${dir}/agent/voice.md`, "utf8"),
      dutiesMd: "",
      displayName: manifest.display ?? manifest.name,
      deployedTools: deployedToolsFor(dir),
    });
    expect(out).toBe(committedPersona(dir, raw.persona));
  });

  it("puts duties between the role and the voice, in the owner's words", () => {
    const manifest = parseDefinition(JSON.parse(readFileSync(`${root("creative")}/agent.json`, "utf8")));
    const out = assemblePersona({
      manifest, roleMd: "ROLE", voiceMd: "VOICE", dutiesMd: "  Keep the books.  ",
      displayName: "Creative", deployedTools: [],
    });
    expect(out).toMatch(/# Creative — role\nROLE\n\n# Creative — duties\nKeep the books\.\n\n# Creative — voice\nVOICE/u);
  });

  it("puts the language last, and only when the definition sets one", () => {
    const raw = JSON.parse(readFileSync(`${root("creative")}/agent.json`, "utf8")) as Record<string, unknown>;
    const base = parseDefinition(raw);
    const withLang = parseDefinition({ ...raw, language: "no" });
    const args = { roleMd: "ROLE", voiceMd: "VOICE", dutiesMd: "", displayName: "Creative", deployedTools: [] };
    expect(assemblePersona({ ...args, manifest: base })).not.toMatch(/— language/u);
    const out = assemblePersona({ ...args, manifest: withLang });
    expect(out).toMatch(/# Creative — voice\nVOICE\n\n# Creative — language\n/u);
    expect(out).toMatch(/\bno\b/u);
  });

  it("a duties file of only whitespace renders no duties section", () => {
    const manifest = parseDefinition(JSON.parse(readFileSync(`${root("creative")}/agent.json`, "utf8")));
    const out = assemblePersona({ manifest, roleMd: "ROLE", voiceMd: "VOICE", dutiesMd: "\n \n", displayName: "C", deployedTools: [] });
    expect(out).not.toMatch(/— duties/u);
  });
});
