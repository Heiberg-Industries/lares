/**
 * D1: a turn that asked an approval card carries no new human instruction, AND A RESTART CANNOT
 * REOPEN IT.
 *
 * On eve 1.0 the turn after an answered card runs as the person who asked, so on Slack and Telegram
 * `remember`, `forget`, `deadline_add` and `deadline_reset` would see the owner on `auth.current`
 * and run as if the owner had just said so. The mark that refuses them lives in eve's durable
 * session state (`defineState`), written by the approval-record hook when the card OPENS.
 *
 * eve's `defineState` is replaced here by a store that the test keeps across a "restart": the
 * module graph is thrown away (`vi.resetModules`), every module-level Map with it, and only the
 * durable store survives, as eve's session state does. The previous in-memory mark failed this
 * test: after the restart the owner's `remember` was allowed again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const durable = vi.hoisted(() => ({ values: new Map<string, unknown>(), readable: true }));
vi.mock("eve/context", () => ({
  defineState: (key: string, initial: () => unknown) => ({
    get: () => {
      if (!durable.readable) throw new Error("no active eve context");
      return durable.values.has(key) ? durable.values.get(key) : initial();
    },
    update: (fn: (value: unknown) => unknown) => {
      if (!durable.readable) throw new Error("no active eve context");
      durable.values.set(key, fn(durable.values.has(key) ? durable.values.get(key) : initial()));
    },
  }),
}));
// The opening hook also writes the card to the approval ledger; that write has no database here
// and is caught and warned by the hook, which is not what this test is about.
vi.mock("@lares/agent-kit/db", async (original) => ({
  ...(await original<typeof import("@lares/agent-kit/db")>()),
  getPool: () => ({ query: async () => { throw new Error("no database in this test"); } }),
}));

const ENV = { SLACK_ALLOWED_USER_IDS: "U0OWNER", TELEGRAM_PRINCIPAL_ID: "4242" } as NodeJS.ProcessEnv;
const DOORS = {
  Slack: { authenticator: "slack-webhook", principalType: "user", principalId: "U0OWNER", attributes: { user_id: "U0OWNER", channel_id: "D0OWNER" } },
  Telegram: { authenticator: "telegram-webhook", principalType: "user", principalId: "4242", attributes: { user_id: 4242 } },
} as const;

const sessionOn = (auth: unknown, turnId: string) => ({ id: "sess_d1", turn: { id: turnId, sequence: Number(turnId.slice(5)) }, auth: { current: auth, initiator: auth } });
const opened = (turnId: string, interactionId: string) => ({
  type: "interaction.opened",
  scope: { turnId },
  data: { interactionId, subject: { callId: `call_${interactionId}` },
    request: { kind: "approval", prompt: "Approve?", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] } },
});

async function fresh() {
  vi.resetModules();
  const hook = (await import("../agent/hooks/approval-record.js")).default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void>> };
  const { humanTurnRefusal } = await import("../lib/approvals.js");
  return { hook, refusal: (session: unknown) => humanTurnRefusal(session as never, "Not saved.", ENV) };
}

beforeEach(() => { durable.values.clear(); durable.readable = true; vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe("the turn after an answered card, across a restart", () => {
  for (const [door, auth] of Object.entries(DOORS)) {
    it(`${door}: an ungated owner write stays refused for the rest of a turn that asked a card, after a restart`, async () => {
      const before = await fresh();
      const turn = sessionOn(auth, "turn_3");
      expect(before.refusal(turn)).toBeNull(); // the owner's own turn, no card yet

      await before.hook.events["interaction.opened"]!(opened("turn_3", "int_1"), { session: turn, agent: { name: "chief-of-staff" } });
      expect(before.refusal(turn)).toContain("no new human instruction");

      // Restart: every in-memory record is gone; the settle hook never ran for this card.
      const after = await fresh();
      expect(after.refusal(turn)).toContain("no new human instruction");
      // The owner's next message is a new turn and is the owner's again.
      expect(after.refusal(sessionOn(auth, "turn_4"))).toBeNull();
    });
  }

  it("refuses when the durable state cannot be read, and when the turn has no id", async () => {
    const { refusal } = await fresh();
    durable.readable = false;
    expect(refusal(sessionOn(DOORS.Slack, "turn_1"))).toContain("no new human instruction");
    durable.readable = true;
    expect(refusal({ id: "sess_d1", auth: { current: DOORS.Slack, initiator: DOORS.Slack } })).toContain("no new human instruction");
  });

  it("fails the opening hook, rather than leave the turn unmarked, when the mark cannot be written", async () => {
    const { hook } = await fresh();
    durable.readable = false;
    await expect(hook.events["interaction.opened"]!(opened("turn_2", "int_2"), { session: sessionOn(DOORS.Telegram, "turn_2") })).rejects.toThrow();
  });
});
