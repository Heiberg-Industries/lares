// ADR-0015 rule 11's gate, in file form.
//
// The pair of files per role under `../snapshots/` is the only record of what each role's MODEL
// sees on the eve version they were captured against. They are captured by
// `scripts/capture-snapshot.sh` (see `../snapshots/README.md` for the method and the exact
// normalisation), never written by hand, and never regenerated as a side effect of another change.
//
// This file asserts only the properties that make the files USABLE as a before/after comparison:
// that they exist, that they are not empty, and that the tool list is sorted and duplicate-free so
// a later `diff` is readable. The comparison itself — before the eve bump against after — is a
// later slice's job and needs no code here: it is `git diff` on these files.
//
// A snapshot test that silently records nothing passes forever afterwards and proves nothing, so
// the emptiness checks below are the load-bearing ones, and the capture script refuses to write an
// empty file for the same reason.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const ROLES = ["chief-of-staff", "travel", "creative"] as const;
const snap = (p: string) => fileURLToPath(new URL(`../snapshots/${p}`, import.meta.url));

export interface RoleSnapshot {
  /** Role directory name under services/, e.g. "chief-of-staff". Never a persona name. */
  readonly role: string;
  /** The assembled agent/persona.md, byte for byte. */
  readonly instructions: string;
  /** The WHOLE system prompt eve sent, of which `instructions` is one ingredient — eve's own
   *  preamble and skills block wrap it, our dynamic blocks are appended. Normalised: see
   *  ../snapshots/README.md. Expected to differ after an eve bump wherever eve changed its own
   *  wording. */
  readonly systemPrompt: string;
  /** Model-visible tool names, sorted, one per line, no blank lines. */
  readonly tools: readonly string[];
  /** The eve version the snapshot was taken against, read from the role's package.json. */
  readonly eveVersion: string;
}

/**
 * Reads one role's committed pair back.
 *
 * `eveVersion` is read LIVE from `services/<role>/package.json`, which is what the interface this
 * slice publishes says it is — so after an eve bump it reports the NEW version while the two text
 * files still hold the old capture. That is deliberate and is how a reader tells a stale snapshot
 * from a fresh one; the version the files were actually captured on is written down in
 * `../snapshots/README.md`.
 */
export function readRoleSnapshot(role: string): RoleSnapshot {
  const instructions = readFileSync(snap(`instructions-${role}.txt`), "utf8");
  const systemPrompt = readFileSync(snap(`system-prompt-${role}.txt`), "utf8");
  const tools = readFileSync(snap(`tools-${role}.txt`), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../services/${role}/package.json`, import.meta.url)), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const eveVersion = pkg.dependencies?.["eve"];
  if (eveVersion === undefined) throw new Error(`services/${role}/package.json does not depend on eve`);
  return { role, instructions, systemPrompt, tools, eveVersion };
}

describe("ADR-0015 rule 11: the runtime-resolved instructions and tool list are byte-identical", () => {
  for (const role of ROLES) {
    it(`${role} has a non-empty committed instructions snapshot`, () => {
      const f = snap(`instructions-${role}.txt`);
      expect(existsSync(f)).toBe(true);
      expect(readFileSync(f, "utf8").length).toBeGreaterThan(0);
    });

    it(`${role} has a non-empty committed tool-list snapshot with no duplicates`, () => {
      const f = snap(`tools-${role}.txt`);
      expect(existsSync(f)).toBe(true);
      const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      expect(new Set(lines).size).toBe(lines.length);
      expect([...lines].sort()).toEqual(lines); // sorted, so a diff is readable
    });

    it(`${role} has a non-empty committed system-prompt snapshot that still contains its persona`, () => {
      const f = snap(`system-prompt-${role}.txt`);
      expect(existsSync(f)).toBe(true);
      const prompt = readFileSync(f, "utf8");
      expect(prompt.length).toBeGreaterThan(0);
      // The persona is one ingredient of the system prompt, not the whole of it. Pinning its
      // FIRST heading is the cheapest check that eve is still being handed our instructions at
      // all: if a release stops merging them in, this line is what says so.
      const heading = readFileSync(snap(`instructions-${role}.txt`), "utf8")
        .split("\n")
        .find((l) => l.startsWith("# "));
      expect(heading).toBeDefined();
      expect(prompt).toContain(heading);
    });
  }

  it("every role's pair reads back through readRoleSnapshot, against a known eve version", () => {
    for (const role of ROLES) {
      const s = readRoleSnapshot(role);
      expect(s.role).toBe(role);
      expect(s.instructions.length).toBeGreaterThan(0);
      expect(s.systemPrompt.length).toBeGreaterThan(s.instructions.length);
      expect(s.tools.length).toBeGreaterThan(0);
      expect(s.eveVersion).toMatch(/^\d+\.\d+\.\d+/u);
    }
  });
});

// The AFTER gate's Docker-free half. Whether an eve bump changed the model-visible TOOL LIST can
// only be answered by a real `eve invoke` against a disposable Postgres — `scripts/capture-
// snapshot.sh` does that; `pnpm -C packages/board-evals run snapshot:compare` runs it into a throw-
// away directory and diffs it against these committed files. `scripts/model-visible-tools-probe.sh`
// is NOT used for this (W2-s1's finding): it is a verifier that confirms a guessed list of names is
// present, never an enumerator, and it prints no list a test could compare against.
//
// What CAN be checked here, fast and without Docker: that the instructions half of the pair is
// still exactly what today's tree assembles. `assemble:check` (run as a separate targeted command,
// not here) already fails if the committed `agent/persona.md` isn't what the assembler produces;
// this test additionally pins that the LIVE assembled file matches the snapshot captured on eve
// 0.32.0 byte for byte, which is the instructions half of ADR-0015 rule 11 without needing Docker.
describe("the assembled instructions on this tree still match the eve-0.32.0 BEFORE snapshot", () => {
  for (const role of ROLES) {
    it(`${role}: agent/persona.md is byte-identical to the committed instructions-${role}.txt`, () => {
      const committed = readFileSync(snap(`instructions-${role}.txt`), "utf8");
      const now = readFileSync(
        fileURLToPath(new URL(`../../../services/${role}/agent/persona.md`, import.meta.url)),
        "utf8",
      );
      expect(now).toBe(committed);
    });
  }
});
