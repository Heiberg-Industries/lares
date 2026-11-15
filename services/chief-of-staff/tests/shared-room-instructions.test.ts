// What a conversation started in a shared room is told, and what is left out of its system prompt
// (`@lares/agent-kit/shared-room`, the files under `agent/instructions/`).
//
// A room is read by everyone in it, so its prompt carries the persona, the language line, the clock
// and one fixed paragraph saying where it is. It does not carry what is connected, the standing
// facts, or the correction to them, and it writes no "what was read" row. A direct message, web chat
// and a conversation a schedule started are unchanged.
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PROMPT_CACHE_BOUNDARY } from "@lares/agent-kit/prompt-cache";
import { SHARED_ROOM_INSTRUCTIONS } from "@lares/agent-kit/shared-room";

const reads = vi.hoisted(() => ({ recordRead: vi.fn(async () => undefined), correction: vi.fn(async () => "CORRECTION_CANARY") }));
vi.mock("../lib/memory-reads.js", () => ({ recordRead: reads.recordRead }));
vi.mock("../agent/instructions/standing-facts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/instructions/standing-facts.js")>()),
  standingFactsCorrectionBlock: reads.correction,
}));
vi.mock("../lib/connections.js", () => ({
  readConnections: vi.fn(async () => ({})),
  connectionsMarkdown: () => "CONNECTIONS_CANARY",
}));

const DIR = join(__dirname, "../agent/instructions");
type Memo = (key: unknown, fn: (occurrence: unknown) => unknown) => Promise<unknown>;
type Resolve = (ctx: unknown) => Promise<{ content: string } | null>;

async function resolverOf(file: string): Promise<Resolve> {
  const mod = (await import(join(DIR, file))) as { default: object };
  const resolve = Reflect.get(mod.default, Symbol.for("eve.dynamic"));
  if (typeof resolve !== "function") throw new Error(`${file} is not a defineDynamic() value`);
  return resolve as Resolve;
}

const slack = (channel_id: string) => ({ authenticator: "slack-webhook", attributes: { user_id: "U0OWNER", channel_id } });
const telegram = (chat_type: string) => ({ authenticator: "telegram-webhook", attributes: { user_id: "1001", chat_type } });
const webChat = { authenticator: "http-basic", attributes: {} };
const schedule = { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: {} };

/** Not private; every memoised block gets a canned text, so nothing here reads a database. */
const canned: Memo = async (key) => {
  if (Array.isArray(key) && key[0] === "private-console") return false;
  if (Array.isArray(key) && key[0] === "persona") return "PERSONA_CANARY";
  return `kept ${String(Array.isArray(key) ? key[0] : key)}`;
};
/** eve's memo for a per-turn block: the function runs. */
const real: Memo = async (_key, fn) => fn({});
const context = (initiator: unknown, memo: Memo = canned) => ({
  session: { id: "room-session", auth: { current: initiator, initiator } },
  turn: { id: "turn_0", status: "running", input: [] },
  memo,
});

beforeEach(() => { vi.clearAllMocks(); });

describe("chief-of-staff: a conversation started in a shared room", () => {
  for (const [name, initiator] of [["a Slack channel", slack("C0ROOM")], ["a Telegram group", telegram("supergroup")]] as const) {
    it(`${name}: the persona is followed by the room text, once`, async () => {
      const out = await (await resolverOf("aa-definition.ts"))(context(initiator));
      expect(out?.content).toBe(`PERSONA_CANARY\n\n${SHARED_ROOM_INSTRUCTIONS}`);
    });

    it(`${name}: no connections block, no standing facts, and no "what was read" row`, async () => {
      const keys: unknown[] = [];
      const memo: Memo = async (key, fn) => { keys.push(key); return canned(key, fn); };
      expect(await (await resolverOf("ac-connections.ts"))(context(initiator, memo))).toBeNull();
      expect(await (await resolverOf("standing-facts.ts"))(context(initiator, memo))).toBeNull();
      expect(keys.filter((key) => Array.isArray(key) && key[0] !== "private-console")).toEqual([]);
      expect(reads.recordRead).not.toHaveBeenCalled();
    });

    it(`${name}: after the marker the clock is there and the standing-facts correction is neither built nor shown`, async () => {
      const out = await (await resolverOf("zz-cache-boundary.ts"))(context(initiator, real));
      expect(out?.content.startsWith(PROMPT_CACHE_BOUNDARY)).toBe(true);
      expect(out?.content.slice(PROMPT_CACHE_BOUNDARY.length)).toMatch(/\d{4}-\d{2}-\d{2}/u);
      expect(out?.content).not.toContain("CORRECTION_CANARY");
      expect(reads.correction).not.toHaveBeenCalled();
    });
  }
});

describe("chief-of-staff: every other conversation is unchanged", () => {
  const others: ReadonlyArray<readonly [string, unknown]> = [
    ["a Slack direct message", slack("D0DIRECT")],
    ["a Telegram private chat", telegram("private")],
    ["web chat", webChat],
    ["a conversation a schedule started", schedule],
  ];
  for (const [name, initiator] of others) {
    it(`${name}: persona alone, connections and standing facts present`, async () => {
      expect((await (await resolverOf("aa-definition.ts"))(context(initiator)))?.content).toBe("PERSONA_CANARY");
      expect((await (await resolverOf("ac-connections.ts"))(context(initiator)))?.content).toBe("kept connections");
      expect((await (await resolverOf("standing-facts.ts"))(context(initiator)))?.content).toBe("kept standing-facts");
    });
  }

  it("a conversation with no initiator and no current identity is unchanged too", async () => {
    const ctx = { ...context(null), session: { id: "s", auth: { current: null, initiator: null } } };
    expect((await (await resolverOf("aa-definition.ts"))(ctx))?.content).toBe("PERSONA_CANARY");
    expect((await (await resolverOf("standing-facts.ts"))(ctx))?.content).toBe("kept standing-facts");
  });

  it("a direct message keeps the standing-facts correction after the marker, and the clock", async () => {
    const out = await (await resolverOf("zz-cache-boundary.ts"))(context(slack("D0DIRECT"), real));
    expect(out?.content.startsWith(PROMPT_CACHE_BOUNDARY)).toBe(true);
    expect(out?.content).toContain("CORRECTION_CANARY");
    expect(out?.content).toMatch(/\d{4}-\d{2}-\d{2}/u);
  });

  it("web chat and a schedule keep the standing-facts correction", async () => {
    for (const initiator of [webChat, schedule]) {
      const out = await (await resolverOf("zz-cache-boundary.ts"))(context(initiator, real));
      expect(out?.content).toContain("CORRECTION_CANARY");
    }
  });
});
