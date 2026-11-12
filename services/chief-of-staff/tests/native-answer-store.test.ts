/**
 * The native answer store (lib/approvals.ts): who answered a Slack or Telegram card, kept from the
 * moment the response policy accepts the answer until the card settles.
 *
 * It used to keep every native answer for ten minutes while only scheduled-route cards ever took
 * theirs, so it filled at 1,024 entries; from then on answers were still ACCEPTED but their answerer
 * was silently not kept, and the owner's Deny on a scheduled card no longer counted as a veto.
 * Now: the settle hook takes the entry of every card it settles; a full store REFUSES the new answer
 * (the card stays pending, the owner can answer again) and never pushes out one already kept; and
 * one conversation can fill only its own share.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const durable = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock("eve/context", () => ({
  defineState: (key: string, initial: () => unknown) => ({
    get: () => (durable.values.has(key) ? durable.values.get(key) : initial()),
    update: (fn: (value: unknown) => unknown) => {
      durable.values.set(key, fn(durable.values.has(key) ? durable.values.get(key) : initial()));
    },
  }),
}));
vi.mock("@lares/agent-kit/db", async (original) => ({
  ...(await original<typeof import("@lares/agent-kit/db")>()),
  getPool: () => ({ query: async () => { throw new Error("no database in this test"); } }),
}));

// The scheduled-route veto path, observed: which card's Deny was applied, as whom.
const vetoes = vi.hoisted(() => ({ applied: [] as Array<{ requestId: string; auth: unknown }> }));
vi.mock("../lib/route-decline.js", async (original) => ({
  ...(await original<typeof import("../lib/route-decline.js")>()),
  routeApprovalLinkAudience: async (_db: unknown, requestId: string) =>
    requestId.startsWith("int_sched") ? { door: "slack", identity: { memberId: "member_owner" } } : undefined,
  applyRouteProposalDecline: async (_db: unknown, requestId: string) => { vetoes.applied.push({ requestId, auth: undefined }); },
}));
vi.mock("../lib/conversation-continuity.js", async (original) => ({
  ...(await original<typeof import("../lib/conversation-continuity.js")>()),
  withCurrentNativeContinuity: async (_door: string, auth: unknown, identity: unknown, use: (db: unknown, id: unknown) => Promise<unknown>) => {
    const out = await use({}, identity);
    vetoes.applied[vetoes.applied.length - 1]!.auth = auth;
    return out;
  },
}));

import { clearNativeAnswersForTests, nativeAnswerDecision, takeNativeAnswerer } from "../lib/approvals.js";

const OWNER = { authenticator: "slack-webhook", principalType: "user", principalId: "U0OWNER", attributes: { user_id: "U0OWNER" } };
const answer = (sessionId: string, interactionId: string, decision: "approve" | "deny" = "approve") => ({
  request: { interactionId, callId: `call_${interactionId}`, toolName: "track_add_item", toolInput: {}, principal: null },
  response: { decision, principal: OWNER },
  session: { id: sessionId, turn: { id: "turn_1", sequence: 1 } },
});

beforeEach(() => {
  vi.stubEnv("SLACK_ALLOWED_USER_IDS", "U0OWNER");
  clearNativeAnswersForTests();
  durable.values.clear();
  vetoes.applied.length = 0;
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); clearNativeAnswersForTests(); });

describe("the native answer store", () => {
  it("keeps the owner's answer until the card's own conversation takes it, once", () => {
    expect(nativeAnswerDecision(answer("sess_a", "int_1"))).toEqual({ status: "allowed" });
    expect(takeNativeAnswerer("int_1", "sess_other")).toBeUndefined(); // another conversation finds nothing
    expect(takeNativeAnswerer("int_1", "sess_a")).toEqual(OWNER);
    expect(takeNativeAnswerer("int_1", "sess_a")).toBeUndefined();
  });

  it("refuses an answer it could not tie to a card in a conversation", () => {
    const noSession = { ...answer("x", "int_1"), session: {} };
    expect(nativeAnswerDecision(noSession)).toMatchObject({ status: "rejected" });
    const noCard = { ...answer("sess_a", "int_1"), request: {} };
    expect(nativeAnswerDecision(noCard)).toMatchObject({ status: "rejected" });
  });

  it("one busy conversation fills only its own share: the next answer there is refused, other conversations are not", () => {
    for (let i = 0; i < 16; i++) expect(nativeAnswerDecision(answer("sess_busy", `int_${i}`))).toEqual({ status: "allowed" });
    const refused = nativeAnswerDecision(answer("sess_busy", "int_16"));
    expect(refused).toEqual({ status: "rejected", reason: expect.stringContaining("answer again in a moment") });
    // Answering the same card again (a revised answer) still works: it replaces, it does not add.
    expect(nativeAnswerDecision(answer("sess_busy", "int_3", "deny"))).toEqual({ status: "allowed" });
    // Another conversation is unaffected.
    expect(nativeAnswerDecision(answer("sess_quiet", "int_q"))).toEqual({ status: "allowed" });
    // Every answer already kept is still there for its settle.
    for (let i = 0; i < 16; i++) expect(takeNativeAnswerer(`int_${i}`, "sess_busy")).toEqual(OWNER);
    // Once those cards settled, the busy conversation can be answered again.
    expect(nativeAnswerDecision(answer("sess_busy", "int_16"))).toEqual({ status: "allowed" });
  });

  it("when the whole store is full, a new answer is refused and the kept ones survive", () => {
    for (let s = 0; s < 64; s++) for (let i = 0; i < 16; i++) {
      expect(nativeAnswerDecision(answer(`sess_${s}`, `int_${s}_${i}`))).toEqual({ status: "allowed" });
    }
    expect(nativeAnswerDecision(answer("sess_new", "int_new"))).toMatchObject({ status: "rejected" });
    expect(takeNativeAnswerer("int_0_0", "sess_0")).toEqual(OWNER);
    expect(takeNativeAnswerer("int_63_15", "sess_63")).toEqual(OWNER);
    expect(nativeAnswerDecision(answer("sess_new", "int_new"))).toEqual({ status: "allowed" });
  });

  it("an entry is gone after ten minutes", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(nativeAnswerDecision(answer("sess_a", "int_1"))).toEqual({ status: "allowed" });
    expect(takeNativeAnswerer("int_1", "sess_a", now + 10 * 60_000 + 1)).toBeUndefined();
  });

  it("the settle hook takes the answer of EVERY settled card, not only a scheduled one's", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const hook = (await import("../agent/hooks/approval-record.js")).default as unknown as {
      events: Record<string, (e: unknown, c: unknown) => Promise<void>>;
    };
    const session = { id: "sess_a", turn: { id: "turn_1", sequence: 1 }, auth: { current: OWNER, initiator: OWNER } };
    for (const [id, outcome, optionId] of [["int_ok", "accepted", "approve"], ["int_no", "declined", "deny"], ["int_gone", "withdrawn", undefined]] as const) {
      expect(nativeAnswerDecision(answer("sess_a", id))).toEqual({ status: "allowed" });
      await hook.events["interaction.settled"]!(
        { type: "interaction.settled", scope: { turnId: "turn_1" }, data: { interactionId: id, outcome, ...(optionId ? { response: { optionId } } : {}) } },
        { session, agent: { name: "chief-of-staff" } },
      );
      expect(takeNativeAnswerer(id, "sess_a")).toBeUndefined();
    }
  });

  it("after 1,025 answered and settled cards, the owner's Deny on a scheduled card is still applied as a veto", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const hook = (await import("../agent/hooks/approval-record.js")).default as unknown as {
      events: Record<string, (e: unknown, c: unknown) => Promise<void>>;
    };
    const settle = (sessionId: string, id: string, outcome: string, optionId: string) => hook.events["interaction.settled"]!(
      { type: "interaction.settled", scope: { turnId: "turn_1" }, data: { interactionId: id, outcome, response: { optionId } } },
      { session: { id: sessionId, turn: { id: "turn_1", sequence: 1 }, auth: { current: OWNER, initiator: OWNER } }, agent: { name: "chief-of-staff" } },
    );
    for (let i = 0; i < 1025; i++) {
      expect(nativeAnswerDecision(answer(`sess_${i % 7}`, `int_${i}`))).toEqual({ status: "allowed" });
      await settle(`sess_${i % 7}`, `int_${i}`, "accepted", "approve");
    }
    expect(nativeAnswerDecision(answer("sess_sched", "int_sched_1", "deny"))).toEqual({ status: "allowed" });
    await settle("sess_sched", "int_sched_1", "declined", "deny");
    expect(vetoes.applied).toEqual([{ requestId: "int_sched_1", auth: { authenticator: "slack-webhook", attributes: { user_id: "U0OWNER" } } }]);
  });
});
