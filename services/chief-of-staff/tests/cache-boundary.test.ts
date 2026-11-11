// The prompt-cache boundary sits after every block that is stable for the conversation and
// before every block that changes from turn to turn (`@lares/agent-kit/prompt-cache`,
// `agent/instructions/zz-cache-boundary.ts`).
//
// eve 1.0 places this directory's instructions in filename order (`localeCompare`) and has no
// other ordering: 0.60.1 put every per-conversation result ahead of every per-turn one whatever
// the filenames, and that grouping is gone. eve also runs each resolver before EVERY model call
// now, not once per session or turn. So the boundary is in the right place exactly when:
//
//  - the boundary file is the LAST file, and it is what emits the per-turn blocks, after the
//    marker;
//  - every file that sorts before it keeps its text for the whole conversation;
//  - the files that only build a per-turn block contribute nothing of their own;
//  - the per-turn text is kept for the turn, so it does not move between two model calls.
//
// A new file named after `zz-`, or a per-turn block emitted from its own file, would break the
// cache with nothing else going red; this test is what says so.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROMPT_CACHE_BOUNDARY } from "@lares/agent-kit/prompt-cache";

const DIR = join(__dirname, "../agent/instructions");
const BOUNDARY_FILE = "zz-cache-boundary.ts";
/** Files whose block changes from turn to turn. They build it; the boundary file emits it. */
const PER_TURN_BUILDERS = ["ab-language.ts", "clock.ts"];
/** Files that emit their own block, and the memo key that keeps it for the conversation. */
const KEPT_FOR_THE_CONVERSATION: Record<string, string> = {
  "aa-definition.ts": "persona",
  "ac-connections.ts": "connections",
  "standing-facts.ts": "standing-facts",
};

type Memo = (key: unknown, fn: (occurrence: unknown) => unknown) => Promise<unknown>;
type Resolve = (ctx: unknown) => Promise<{ content: string } | null>;

/** The function eve 1.0 calls: a `defineDynamic()` value keeps it under this symbol. */
async function resolverOf(file: string): Promise<Resolve> {
  const mod = (await import(join(DIR, file))) as { default: object };
  const resolve = Reflect.get(mod.default, Symbol.for("eve.dynamic"));
  if (typeof resolve !== "function") throw new Error(`${file} does not default-export a defineDynamic() value`);
  return resolve as Resolve;
}

const context = (memo: Memo, turnId = "turn_0", sessionId = "boundary-session") => ({
  session: { id: sessionId, auth: { current: null, initiator: null } },
  turn: { id: turnId, status: "running", input: [] },
  memo,
});

/** eve's memo, as far as these tests need it: a key's result is computed once and kept. */
function keepingMemo(): { memo: Memo; keys: string[] } {
  const kept = new Map<string, unknown>();
  const keys: string[] = [];
  return {
    keys,
    memo: async (key, fn) => {
      const id = JSON.stringify(key);
      keys.push(id);
      if (!kept.has(id)) kept.set(id, await fn({}));
      return kept.get(id);
    },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("chief-of-staff prompt-cache boundary", () => {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort((a, b) => a.localeCompare(b));

  it("the boundary file is the last instruction file, and every file is accounted for", () => {
    expect(files.at(-1)).toBe(BOUNDARY_FILE);
    expect(files).toEqual([...Object.keys(KEPT_FOR_THE_CONVERSATION), ...PER_TURN_BUILDERS, BOUNDARY_FILE].sort((a, b) => a.localeCompare(b)));
  });

  it("every file ahead of the boundary keeps its text for the whole conversation", async () => {
    for (const [file, name] of Object.entries(KEPT_FOR_THE_CONVERSATION)) {
      const keys: unknown[] = [];
      // Not private; every other key gets a canned text, so nothing here reads a database.
      const memo: Memo = async (key) => { keys.push(key); return Array.isArray(key) && key[0] === "private-console" ? false : `kept ${name}`; };
      const first = await (await resolverOf(file))(context(memo, "turn_0"));
      const later = await (await resolverOf(file))(context(memo, "turn_7"));
      expect(first?.content, file).toBe(`kept ${name}`);
      expect(later?.content, file).toBe(`kept ${name}`);
      // The text is keyed on the session and on nothing that changes within it.
      expect(keys.filter((key) => Array.isArray(key) && key[0] !== "private-console"), file).toEqual([[name, "boundary-session"], [name, "boundary-session"]]);
    }
  });

  it("a file that only builds a per-turn block contributes nothing of its own", async () => {
    for (const file of PER_TURN_BUILDERS) {
      const { memo, keys } = keepingMemo();
      expect(await (await resolverOf(file))(context(memo)), file).toBeNull();
      expect(keys, file).toEqual([]);
    }
  });

  it("emits the marker first, then the per-turn blocks, with the clock among them", async () => {
    const { memo } = keepingMemo();
    const out = await (await resolverOf(BOUNDARY_FILE))(context(memo));
    expect(out?.content.startsWith(PROMPT_CACHE_BOUNDARY)).toBe(true);
    // The marker appears once, and something follows it: at the least, the clock.
    expect(out?.content.split(PROMPT_CACHE_BOUNDARY)).toHaveLength(2);
    expect(out?.content.slice(PROMPT_CACHE_BOUNDARY.length)).toMatch(/\d{4}-\d{2}-\d{2}/u);
  });

  it("the bytes after the marker are identical for every model call of one turn, and rebuilt on the next", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-04T08:15:00Z"));
    const { memo, keys } = keepingMemo();
    const resolve = await resolverOf(BOUNDARY_FILE);
    const firstCall = await resolve(context(memo, "turn_0"));
    // Seven minutes later, the same turn's next model call.
    vi.setSystemTime(new Date("2026-03-04T08:22:00Z"));
    const laterCall = await resolve(context(memo, "turn_0"));
    expect(laterCall?.content).toBe(firstCall?.content);
    // The next turn gets a fresh clock.
    const nextTurn = await resolve(context(memo, "turn_1"));
    expect(nextTurn?.content).not.toBe(firstCall?.content);
    expect(nextTurn?.content.startsWith(PROMPT_CACHE_BOUNDARY)).toBe(true);
    // One memo per turn, and nothing else.
    expect(keys).toEqual(['["per-turn","turn_0"]', '["per-turn","turn_0"]', '["per-turn","turn_1"]']);
  });
});
