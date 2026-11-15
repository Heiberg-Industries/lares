// What a conversation started in a shared room is told (`@lares/agent-kit/shared-room`,
// `agent/instructions/aa-definition.ts`). The creative role's other instruction files carry nothing
// private (the cache boundary emits only the language line), so only the persona file changes.
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SHARED_ROOM_INSTRUCTIONS } from "@lares/agent-kit/shared-room";

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
const webChat = { authenticator: "http-basic", attributes: {} };
const schedule = { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: {} };

const memo: Memo = async (key) => (Array.isArray(key) && key[0] === "private-console" ? false : "PERSONA_CANARY");
const context = (initiator: unknown) => ({
  session: { id: "room-session", auth: { current: initiator, initiator } },
  turn: { id: "turn_0", status: "running", input: [] },
  memo,
});

describe("creative: what the persona file hands the model", () => {
  it("a conversation started in a Slack channel gets the room text after the persona", async () => {
    expect((await (await resolverOf("aa-definition.ts"))(context(slack("C0ROOM"))))?.content).toBe(`PERSONA_CANARY\n\n${SHARED_ROOM_INSTRUCTIONS}`);
  });

  it("a direct message, web chat, a schedule and a conversation with no identity get the persona alone", async () => {
    for (const initiator of [slack("D0DIRECT"), webChat, schedule, null]) {
      expect((await (await resolverOf("aa-definition.ts"))(context(initiator)))?.content, JSON.stringify(initiator)).toBe("PERSONA_CANARY");
    }
  });
});
