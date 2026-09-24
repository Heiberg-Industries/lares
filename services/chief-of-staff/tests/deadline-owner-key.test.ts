/**
 * ONE owner key for the whole deadline feature — a source-level guard (review fix, ORB-180).
 *
 * The defect this exists to stop is not a failing query; it is a silent split. Every deadline
 * WRITE used `CANONICAL_USER_ID` ("bendik", a literal in `lib/identity-client.ts`) while every
 * READ used `ownerId()` (`lib/principals.ts`, which reads `AGENT_OWNER_USER_ID` and falls back to
 * the same string). Identical today, so no test could fail; the morning a second install sets
 * `AGENT_OWNER_USER_ID`, every deadline written would become invisible to the brief that asked
 * for it, and nothing would error.
 *
 * A behavioural test cannot catch that — both halves agree under the default environment, which is
 * the environment tests run in. So this reads the files as TEXT, the same instrument
 * `services/console/tests/engine-drift.test.ts` uses for its mirrors, and asserts the identifier
 * never reaches a `deadlines-store` function again.
 *
 * The six tools and the ladder schedule must not mention `CANONICAL_USER_ID` at all — they have no
 * other store to talk to. `morning-brief.ts` legitimately still uses it for the identity aliases,
 * the OBLIGATIONS store and the standing facts, so it is checked the narrower way: no
 * `deadlines-store` call may carry it in its arguments.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

const TOOL_FILES = [
  "catalogue/deadline_add.ts",
  "catalogue/deadline_list.ts",
  "catalogue/deadline_done.ts",
  "catalogue/deadline_dismiss.ts",
  "catalogue/deadline_mint_statutory.ts",
  "catalogue/deadline_reset.ts",
] as const;

const LADDER = "agent/schedules/deadlines.ts";
const BRIEF = "agent/schedules/morning-brief.ts";

/** Every function `lib/deadlines-store.ts` exports — read from the store itself, so a seventh
 *  function added later is covered without anyone remembering to list it here. */
function storeExports(): string[] {
  const src = read("lib/deadlines-store.ts");
  return [...src.matchAll(/^export async function (\w+)\(/gmu)].map((m) => m[1]!);
}

/** The text between the parens of every `name(` call in `src`, paren-balanced so a nested call
 *  (`upsertCandidate(pool, { ...c, owner: ownerId() })`) is captured whole rather than cut at its
 *  first inner `)`. */
function callArguments(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(String.raw`\b${name}\s*\(`, "gu");
  for (const m of src.matchAll(re)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      i += 1;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

describe("the deadline feature has exactly one owner key", () => {
  it("the store exports the functions this guard walks (it found some)", () => {
    expect(storeExports().length).toBeGreaterThan(5);
  });

  for (const file of [...TOOL_FILES, LADDER]) {
    it(`${file} never mentions CANONICAL_USER_ID — it uses ownerId()`, () => {
      const src = read(file);
      expect(src, `${file} still carries CANONICAL_USER_ID`).not.toMatch(/\bCANONICAL_USER_ID\b/u);
      expect(src, `${file} never resolves the owner at all`).toMatch(/\bownerId\(/u);
    });
  }

  it("lib/deadlines-store.ts defaults `owner` to ownerId(), not to the registry literal", () => {
    const src = read("lib/deadlines-store.ts");
    expect(src).toMatch(/d\.owner \?\? ownerId\(\)/u);
    expect(src).not.toMatch(/^import .*CANONICAL_USER_ID/mu);
  });

  it("morning-brief.ts passes CANONICAL_USER_ID to no deadlines-store function", () => {
    const src = read(BRIEF);
    const offenders: string[] = [];
    for (const fn of storeExports()) {
      for (const args of callArguments(src, fn)) {
        if (/\bCANONICAL_USER_ID\b/u.test(args)) offenders.push(`${fn}(${args.trim()})`);
      }
    }
    expect(offenders, "a deadline write on the brief's own owner key").toEqual([]);
  });

  it("morning-brief.ts records candidates under ownerId()", () => {
    expect(read(BRIEF)).toMatch(/upsertCandidate\(pool, \{ \.\.\.c, owner: ownerId\(\) \}\)/u);
  });
});
