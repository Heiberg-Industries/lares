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

// Who owns the agent, as `lib/agent-mailbox.js`'s `loadOwner` would read it (web chat only).
const owner = vi.hoisted(() => ({ value: "member-owner" as string | null, reads: 0 }));
vi.mock("../lib/agent-mailbox.js", () => ({ loadOwner: async () => { owner.reads += 1; return owner.value; } }));

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

/**
 * Web chat: a turn there carries the console's member admission and no door `user_id`, so the door
 * allow-list can never match it. `ownerTurnRefusal` judges that turn, and only that one, by the same
 * owner check the owner-only web chat tools are re-checked with when they run (`callerIsAgentOwner`).
 */
describe("ownerTurnRefusal: web chat's owner may add a deadline; every other turn is judged as before", () => {
  const WEB = (member: string, purpose = "human") => ({ authenticator: "lares-console", principalType: "user", principalId: member,
    attributes: { lares_member_id: member, lares_admission_nonce: "a".repeat(43), lares_purpose: purpose } });
  const webOn = (current: unknown, turnId: string, initiator: unknown = WEB("member-owner")) =>
    ({ id: "sess_web", turn: { id: turnId, sequence: Number(turnId.slice(5)) }, auth: { current, initiator } });
  async function load() {
    const m = await fresh();
    const { ownerTurnRefusal, humanTurnRefusal } = await import("../lib/approvals.js");
    return { ...m,
      owner: (session: unknown) => ownerTurnRefusal(session as never, "Not saved.", ENV),
      human: (session: unknown) => humanTurnRefusal(session as never, "Not saved.", ENV) };
  }
  beforeEach(() => {
    vi.stubEnv("LARES_AGENT_NAME", "helper");
    vi.stubEnv("LARES_AGENT_INCARNATION", "11111111-1111-4111-8111-111111111111");
    owner.value = "member-owner"; owner.reads = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("a Slack or Telegram turn gets exactly the answer humanTurnRefusal gives, and no owner lookup is made", async () => {
    const m = await load();
    const stranger = { authenticator: "slack-webhook", principalType: "user", principalId: "U0OTHER", attributes: { user_id: "U0OTHER", channel_id: "D0OTHER" } };
    const room = { authenticator: "slack-webhook", principalType: "user", principalId: "U0OWNER", attributes: { user_id: "U0OWNER", channel_id: "C0ROOM" } };
    const schedule = { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: {} };
    const sessions = [
      ...Object.values(DOORS).map((auth) => sessionOn(auth, "turn_1")),
      sessionOn(stranger, "turn_1"), sessionOn(room, "turn_1"), sessionOn(schedule, "turn_1"), sessionOn(null, "turn_1"),
      { id: "sess_d1", auth: { current: DOORS.Slack, initiator: DOORS.Slack } }, // no turn id
    ];
    for (const session of sessions) expect(await m.owner(session)).toBe(m.human(session));
    // The owner's Slack and Telegram turns pass; a stranger is refused.
    expect(await m.owner(sessionOn(DOORS.Slack, "turn_1"))).toBeNull();
    expect(await m.owner(sessionOn(DOORS.Telegram, "turn_1"))).toBeNull();
    expect(await m.owner(sessionOn(stranger, "turn_1"))).toContain("not as the owner");
    // A turn that asked a card is refused by both, the same way.
    await m.hook.events["interaction.opened"]!(opened("turn_5", "int_5"), { session: sessionOn(DOORS.Slack, "turn_5"), agent: { name: "chief-of-staff" } });
    expect(await m.owner(sessionOn(DOORS.Slack, "turn_5"))).toBe(m.human(sessionOn(DOORS.Slack, "turn_5")));
    expect(m.human(sessionOn(DOORS.Slack, "turn_5"))).toContain("no new human instruction");
    expect(owner.reads).toBe(0);
  });

  it("web chat: the owner's own message passes; the door check alone refuses it", async () => {
    const m = await load();
    const turn = webOn(WEB("member-owner"), "turn_1");
    expect(m.human(turn)).toContain("not as the owner");
    expect(await m.owner(turn)).toBeNull();
  });

  it("web chat: a member who is not the owner, a changed owner, or an owner that cannot be read is refused", async () => {
    const m = await load();
    expect(await m.owner(webOn(WEB("member-other"), "turn_1", WEB("member-other")))).toContain("does not come from this agent's owner");
    // The message is from another member than the one who opened the conversation.
    expect(await m.owner(webOn(WEB("member-other"), "turn_1"))).toContain("does not come from this agent's owner");
    owner.value = "member-new-owner";
    expect(await m.owner(webOn(WEB("member-owner"), "turn_1"))).toContain("does not come from this agent's owner");
    owner.value = null;
    expect(await m.owner(webOn(WEB("member-owner"), "turn_1"))).toContain("does not come from this agent's owner");
  });

  it("web chat: a turn with no current message, an answer to a card, or a turn that asked a card is refused", async () => {
    const m = await load();
    expect(await m.owner(webOn(null, "turn_1"))).toContain("does not come from this agent's owner");
    expect(await m.owner(webOn(WEB("member-owner", "resolver"), "turn_1"))).toContain("no new human instruction");
    await m.hook.events["interaction.opened"]!(opened("turn_2", "int_2"), { session: webOn(WEB("member-owner"), "turn_2"), agent: { name: "chief-of-staff" } });
    expect(await m.owner(webOn(WEB("member-owner"), "turn_2"))).toContain("no new human instruction");
    expect(await m.owner({ id: "sess_web", auth: { current: WEB("member-owner"), initiator: WEB("member-owner") } })).toContain("no new human instruction");
  });

  it("deadline_add: the web chat owner's call reaches the date check; another member's is refused with nothing written", async () => {
    await fresh();
    const add = (await import("../catalogue/deadline_add.js")).default as unknown as { execute: (i: unknown, c: unknown) => Promise<unknown> };
    const input = { entity: "Example Co", title: "Annual report", dueDate: "2000-01-01" };
    await expect(add.execute(input, { session: webOn(WEB("member-owner"), "turn_1") })).rejects.toThrow(/is in the past/);
    expect(await add.execute(input, { session: webOn(WEB("member-other"), "turn_1", WEB("member-other")) })).toMatchObject({ added: false });
  });
});
