/**
 * THE TURN AFTER AN ANSWERED CARD (eve 1.0), acceptance tests T2–T10 and S2, S4, S6 that need no
 * database. What each drives is named in its title; the rest of the list (T1, T4, S1, S3, S5) lives
 * in the files named in the PR description.
 *
 * On eve 1.0 an answered card starts no new turn: the paused turn carries on as the person who
 * ASKED. These tests drive Lares's own pieces in the order eve runs them: the card's opening hook,
 * the response policy, the settle hook, then the continuation (the model seam for web chat, the
 * ungated-write check for every door). eve's durable session state (`defineState`) is a store the
 * test keeps; a "restart" throws the module graph away and keeps only that store.
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
// No database: every query finds nothing (no ledger row, no prepared personal send), which is not under test.
vi.mock("@lares/agent-kit/db", async (original) => ({
  ...(await original<typeof import("@lares/agent-kit/db")>()),
  getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("@lares/agent-kit/model-purpose-client", () => ({ modelPurposeRequest: requestMock }));

const INCARNATION = "123e4567-e89b-42d3-a456-426614174000";
const MESSAGE_RECEIPT = "r".repeat(43), ANSWER_RECEIPT = "a".repeat(43);
// A managed agent (an incarnation is set) reads its door allow-lists from the LARES_*_PRINCIPAL names.
const ENV = { LARES_SLACK_PRINCIPAL: "U0OWNER,U0SECOND", LARES_TELEGRAM_PRINCIPAL: "4242,4343" } as const;
const DOORS = {
  Slack: {
    owner: { authenticator: "slack-webhook", principalType: "user", principalId: "U0OWNER", attributes: { user_id: "U0OWNER", channel_id: "D0OWNER" } },
    second: { authenticator: "slack-webhook", principalType: "user", principalId: "U0SECOND", attributes: { user_id: "U0SECOND", channel_id: "D0OWNER" } },
  },
  Telegram: {
    owner: { authenticator: "telegram-webhook", principalType: "user", principalId: "4242", attributes: { user_id: 4242 } },
    second: { authenticator: "telegram-webhook", principalType: "user", principalId: "4343", attributes: { user_id: 4343 } },
  },
} as const;
/** A scheduled job's own identity: the requester of a scheduled card. */
const APP = { authenticator: "app", principalType: "app", principalId: "chief-of-staff", attributes: { lane: "track-routing" } };
/** A web-chat member who asked, with the model-purpose receipt of their message. */
const member = (memberId = "member-1", nonce = "n".repeat(43)) => ({ authenticator: "lares-console", attributes: {
  lares_member_id: memberId, lares_admission_nonce: nonce, lares_purpose: "human",
  lares_model_purpose_required: "1", lares_model_pending_receipt: MESSAGE_RECEIPT } });

type Hook = { events: Record<string, (e: unknown, c: unknown) => Promise<void>> };
async function load() {
  const hook = (await import("../agent/hooks/approval-record.js")).default as unknown as Hook;
  const approvals = await import("../lib/approvals.js");
  const seam = await import("../agent/lib/model-purpose.js");
  const store = await import("@lares/agent-kit/private-console-resume");
  const { captureModelInvocation } = await import("@lares/agent-kit/model-invocation");
  return { hook, approvals, seam, store, captureModelInvocation };
}
type Loaded = Awaited<ReturnType<typeof load>>;

const sessionOf = (id: string, current: unknown, turnId = "turn_2", initiator: unknown = current) =>
  ({ id, turn: { id: turnId, sequence: Number(turnId.slice(5)) }, auth: { current, initiator } });
const opened = (turnId: string, interactionId: string) => ({ type: "interaction.opened", scope: { turnId },
  data: { interactionId, subject: { callId: `call_${interactionId}` },
    request: { kind: "approval", prompt: "Approve?", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] } } });
const settled = (turnId: string, interactionId: string, outcome: string, optionId?: string) => ({ type: "interaction.settled", scope: { turnId },
  data: { interactionId, outcome, ...(optionId ? { response: { optionId } } : {}) } });
const step = (turnId: string, stepIndex = 7) => ({ type: "step.started" as const, data: { turnId, sequence: Number(turnId.slice(5)), stepIndex } });

/** The web-chat answer as the exact response policy records it once it has accepted it. */
function webChatAnswer(m: Loaded, session: ReturnType<typeof sessionOf>, card: string, decision: "approve" | "deny") {
  m.store.rememberAcceptedAnswer({ request: { interactionId: card },
    response: { decision, principal: { attributes: { lares_model_pending_receipt: ANSWER_RECEIPT } } },
    session: { id: session.id, turn: session.turn } }, { memberId: "member-1", admissionNonce: "n".repeat(43) });
}
const nativeAnswer = (card: string, sessionId: string, principal: unknown, decision: "approve" | "deny") =>
  ({ request: { interactionId: card, callId: `call_${card}`, toolName: "track_add_item", toolInput: {}, principal: null },
    response: { decision, principal }, session: { id: sessionId, turn: { id: "turn_2", sequence: 2 } } });
const REFUSED = "no new human instruction";

let m: Loaded;
beforeEach(async () => {
  vi.resetModules();
  durable.values.clear();
  requestMock.mockReset();
  requestMock.mockImplementation(async (op: string) => op === "turn.open"
    ? { capability: "c".repeat(43), expiresAt: Date.now() + 5 * 60_000 }
    : op === "step.claim" ? { claim: "k".repeat(43), expiresAt: Date.now() + 30_000 } : { closed: true });
  vi.stubEnv("LARES_AGENT_NAME", "helper");
  vi.stubEnv("LARES_AGENT_INCARNATION", INCARNATION);
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  m = await load();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("web chat", () => {
  it("T2: Deny: the reply opens (behind Keeper's Deny check) with the Deny answer's receipt, as the asker", async () => {
    const session = sessionOf("sess_t2", member());
    const ctx = { session, agent: { name: "chief-of-staff" } };
    await m.hook.events["interaction.opened"]!(opened("turn_2", "int_t2"), ctx);
    webChatAnswer(m, session, "int_t2", "deny");
    await m.hook.events["interaction.settled"]!(settled("turn_2", "int_t2", "declined", "deny"), ctx);
    expect(requestMock).toHaveBeenCalledWith("turn.open", expect.objectContaining({ pendingReceipt: ANSWER_RECEIPT,
      context: { session: expect.objectContaining({ auth: { current: session.auth.current, initiator: session.auth.initiator } }) } }));
    m.seam.prepareModelPurposeInvocation(step("turn_2"), session as never);
    await expect(m.seam.claimModelPurposeForInvocation(m.captureModelInvocation(step("turn_2"), session as never, "lares-brain"))).resolves.toBeUndefined();
  });

  for (const outcome of ["expired", "withdrawn"] as const) {
    it(`T3 / D4: a card that ${outcome} without an answer opens nothing, and the reply says so`, async () => {
      const session = sessionOf(`sess_t3_${outcome}`, member());
      const ctx = { session, agent: { name: "chief-of-staff" } };
      await m.hook.events["interaction.opened"]!(opened("turn_2", "int_t3"), ctx);
      await m.hook.events["interaction.settled"]!(settled("turn_2", "int_t3", outcome), ctx);
      expect(requestMock).not.toHaveBeenCalled();
      m.seam.prepareModelPurposeInvocation(step("turn_2"), session as never);
      await expect(m.seam.claimModelPurposeForInvocation(m.captureModelInvocation(step("turn_2"), session as never, "lares-brain")))
        .rejects.toThrow("The approval in this turn ended without an answer");
      expect(requestMock).not.toHaveBeenCalled();
    });
  }

  it("S2: an answer opens nothing in another turn, conversation or run (incarnation)", async () => {
    const session = sessionOf("sess_s2", member());
    webChatAnswer(m, session, "int_s2", "approve");
    m.store.settleAcceptedAnswer("int_s2", session.id, "approve");
    await m.seam.openContinuationAfterSettle("turn_3", sessionOf("sess_s2", member(), "turn_3") as never);
    await m.seam.openContinuationAfterSettle("turn_2", sessionOf("sess_other", member()) as never);
    vi.stubEnv("LARES_AGENT_INCARNATION", "223e4567-e89b-42d3-a456-426614174000");
    await m.seam.openContinuationAfterSettle("turn_2", session as never);
    expect(requestMock).not.toHaveBeenCalled();
    vi.stubEnv("LARES_AGENT_INCARNATION", INCARNATION);
    await m.seam.openContinuationAfterSettle("turn_2", session as never); // its own point still opens, once
    expect(requestMock.mock.calls.filter(([op]) => op === "turn.open")).toHaveLength(1);
  });

  it("S4: the original message's receipt cannot reopen the paused point", async () => {
    const session = sessionOf("sess_s4", member());
    await m.seam.openModelPurposeTurn({ type: "turn.started", data: { turnId: "turn_2" } }, session as never);
    expect(requestMock).toHaveBeenLastCalledWith("turn.open", expect.objectContaining({ pendingReceipt: MESSAGE_RECEIPT }));
    // The card opens; eve pauses the turn and the paused hook closes the message's slot.
    await m.seam.closeModelPurposeTurn({ type: "turn.paused", data: { turnId: "turn_2" } }, session as never);
    requestMock.mockClear();
    // No answer was accepted: neither the turn hook nor the model seam reopens it with the message receipt.
    await expect(m.seam.openModelPurposeTurn({ type: "turn.started", data: { turnId: "turn_2" } }, session as never)).rejects.toThrow();
    m.seam.prepareModelPurposeInvocation(step("turn_2"), session as never);
    await expect(m.seam.claimModelPurposeForInvocation(m.captureModelInvocation(step("turn_2"), session as never, "lares-brain"))).rejects.toThrow();
    expect(requestMock.mock.calls.filter(([op]) => op === "turn.open")).toHaveLength(0);
  });

  it("S6: a restart between the answer and the continuation fails closed, with the 'answer applied' sentence", async () => {
    const session = sessionOf("sess_s6", member());
    const ctx = { session, agent: { name: "chief-of-staff" } };
    await m.hook.events["interaction.opened"]!(opened("turn_2", "int_s6"), ctx);
    webChatAnswer(m, session, "int_s6", "approve");
    // The settle line is written and its hook runs (the durable marks), then the process dies before the reply.
    requestMock.mockRejectedValueOnce(new Error("keeper unreachable"));
    await m.hook.events["interaction.settled"]!(settled("turn_2", "int_s6", "accepted", "approve"), ctx);
    vi.resetModules();
    m = await load();
    m.seam.prepareModelPurposeInvocation(step("turn_2"), session as never);
    await expect(m.seam.claimModelPurposeForInvocation(m.captureModelInvocation(step("turn_2"), session as never, "lares-brain")))
      .rejects.toThrow("The reply after an approval answer was refused");
  });
});

describe("Slack and Telegram", () => {
  for (const [door, who] of Object.entries(DOORS)) {
    for (const [label, outcome, optionId, decision] of [
      ["T5: the owner approves", "accepted", "approve", "approve"],
      ["T6: the owner denies", "declined", "deny", "deny"],
    ] as const) {
      it(`${door}, ${label}: the answer is accepted from the owner; remember, forget and deadline writes refuse for the rest of the turn`, async () => {
        const session = sessionOf(`sess_${door}_${decision}`, who.owner);
        const ctx = { session, agent: { name: "chief-of-staff" } };
        expect(m.approvals.humanTurnRefusal(session, "Not saved.")).toBeNull(); // the owner's own turn, before the card
        await m.hook.events["interaction.opened"]!(opened("turn_2", "int_n"), ctx);
        expect(m.approvals.nativeAnswerDecision(nativeAnswer("int_n", session.id, who.owner, decision))).toEqual({ status: "allowed" });
        await m.hook.events["interaction.settled"]!(settled("turn_2", "int_n", outcome, optionId), ctx);
        expect(m.approvals.humanTurnRefusal(session, "Not saved.")).toContain(REFUSED);
        // Native turns need no model capability: nothing console-side opened.
        expect(requestMock).not.toHaveBeenCalled();
        // The next message is a new turn and is the owner's again.
        expect(m.approvals.humanTurnRefusal(sessionOf(session.id, who.owner, "turn_3"), "Not saved.")).toBeNull();
      });
    }

    // T7 asks for the D4 sentence on these doors too. That sentence is not built on Slack and Telegram
    // (it waits for the owner's decision; see the PR), so this pins only the part that is: no write.
    for (const outcome of ["expired", "withdrawn"] as const) {
      it(`${door}, T7 (no-write part): a card that ${outcome} without an answer keeps nothing, opens nothing console-side, and ungated writes refuse`, async () => {
        const session = sessionOf(`sess_${door}_${outcome}`, who.owner);
        const ctx = { session, agent: { name: "chief-of-staff" } };
        await m.hook.events["interaction.opened"]!(opened("turn_2", "int_t7"), ctx);
        await m.hook.events["interaction.settled"]!(settled("turn_2", "int_t7", outcome), ctx);
        expect(m.approvals.takeNativeAnswerer("int_t7", session.id)).toBeUndefined();
        expect(m.approvals.humanTurnRefusal(session, "Not saved.")).toContain(REFUSED);
        expect(requestMock).not.toHaveBeenCalled();
        expect(m.approvals.humanTurnRefusal(sessionOf(session.id, who.owner, "turn_3"), "Not saved.")).toBeNull();
      });
    }

    it(`${door}, T8: a second allowed person's tap is refused; nothing is kept and the card stays pending`, async () => {
      const session = sessionOf(`sess_${door}_second`, who.owner);
      for (const decision of ["approve", "deny"] as const) {
        expect(m.approvals.nativeAnswerDecision(nativeAnswer("int_second", session.id, who.second, decision)))
          .toEqual({ status: "rejected", reason: expect.stringContaining("owner") });
      }
      expect(m.approvals.takeNativeAnswerer("int_second", session.id)).toBeUndefined();
    });

    it(`${door}, T9: a scheduled job's card approved by the owner: the turn stays the app's, nothing console-side opens, ungated writes refuse`, async () => {
      const session = sessionOf(`sess_${door}_sched`, APP, "turn_2", APP);
      const ctx = { session, agent: { name: "chief-of-staff" } };
      await m.hook.events["interaction.opened"]!(opened("turn_2", "int_sched"), ctx);
      expect(m.approvals.nativeAnswerDecision({ ...nativeAnswer("int_sched", session.id, who.owner, "approve"),
        request: { ...nativeAnswer("int_sched", session.id, who.owner, "approve").request, principal: APP } })).toEqual({ status: "allowed" });
      await m.hook.events["interaction.settled"]!(settled("turn_2", "int_sched", "accepted", "approve"), ctx);
      expect(session.auth.current).toBe(APP);
      expect(requestMock).not.toHaveBeenCalled();
      expect(m.approvals.humanTurnRefusal(session, "Not saved.")).toContain(REFUSED);
      // The approved write itself is checked against the answerer, the owner (`ctx.approval.responder`).
      await expect(m.approvals.assertApproval({ session, approval: { responder: who.owner } } as never, "track_add_item", {})).resolves.toBeUndefined();
      await expect(m.approvals.assertApproval({ session, approval: { responder: who.second } } as never, "track_add_item", {})).rejects.toThrow();
    });
  }

  it("T10: the owner answers a Telegram card from the console: the continuation stays native, no console capability opens", async () => {
    const session = sessionOf("sess_t10", DOORS.Telegram.owner);
    const ctx = { session, agent: { name: "chief-of-staff" } };
    await m.hook.events["interaction.opened"]!(opened("turn_2", "int_t10"), ctx);
    await m.hook.events["interaction.settled"]!(settled("turn_2", "int_t10", "accepted", "approve"), ctx);
    await m.seam.openContinuationAfterSettle("turn_2", session as never);
    m.seam.prepareModelPurposeInvocation(step("turn_2"), session as never);
    await expect(m.seam.claimModelPurposeForInvocation(m.captureModelInvocation(step("turn_2"), session as never, "lares-brain"))).resolves.toBeUndefined();
    expect(requestMock).not.toHaveBeenCalled();
    expect(session.auth.current).toBe(DOORS.Telegram.owner);
    expect(m.approvals.humanTurnRefusal(session, "Not saved.")).toContain(REFUSED);
  });
});
