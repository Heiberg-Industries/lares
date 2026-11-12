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

const durable = vi.hoisted(() => ({ values: new Map<string, unknown>(), readable: true }));
vi.mock("eve/context", () => ({
  defineState: (key: string, initial: () => unknown) => ({
    get: () => {
      if (!durable.readable) throw new Error("no active eve context");
      return durable.values.has(key) ? durable.values.get(key) : initial();
    },
    update: (fn: (value: unknown) => unknown) => {
      durable.values.set(key, fn(durable.values.has(key) ? durable.values.get(key) : initial()));
    },
  }),
}));
// No database: every query finds nothing (no ledger row, no prepared personal send), which is not under test.
// Each query is counted, so a refusal can be shown to come before any read or write.
const db = vi.hoisted(() => ({ queries: [] as unknown[] }));
vi.mock("@lares/agent-kit/db", async (original) => ({
  ...(await original<typeof import("@lares/agent-kit/db")>()),
  getPool: () => ({ query: async (...args: unknown[]) => { db.queries.push(args[0]); return { rows: [], rowCount: 0 }; } }),
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
  const send = await import("../lib/personal-send-approval.js");
  const turns = await import("../lib/approval-card-turns.js");
  return { hook, approvals, seam, store, captureModelInvocation, send, turns };
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
  durable.readable = true;
  db.queries.length = 0;
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

/**
 * NO NEW SEND IN THE REPLY TO AN ANSWERED REQUEST (the owner's ruling, sends only). In the turn an
 * answer to a card was applied in, `personal_mailbox_send`'s request policy refuses a new send with
 * one fixed sentence, before any read, draft or card. Driven here through the real opening and
 * settle hooks; the database-backed half (no row, no card, no provider call, the approved send
 * still goes out once, the next turn sends) is in tests/personal-send.test.ts.
 */
describe("no new send in the reply to an answered request", () => {
  const SENTENCE = "A new send cannot be started in the reply to an answered request. Ask again in a new message.";
  const input = { selection: { accountId: "account-1", generation: 0, resourceBindingId: "binding-1" },
    to: ["recipient@example.invalid"], subject: "Second send", body: "Body" };
  const newSend = (session: unknown, callId = "call_new_send") =>
    ({ session, callId, toolName: "personal_mailbox_send", toolInput: structuredClone(input) });
  const refusal = { type: "denied", reason: SENTENCE };

  /** The card opens in turn_2, the member answers it, eve settles it: what the hooks see. */
  async function answeredIn(sessionId: string, decision: "approve" | "deny") {
    const session = sessionOf(sessionId, member());
    const ctx = { session, agent: { name: "chief-of-staff" } };
    await m.hook.events["interaction.opened"]!(opened("turn_2", `int_${sessionId}`), ctx);
    webChatAnswer(m, session, `int_${sessionId}`, decision);
    await m.hook.events["interaction.settled"]!(decision === "approve"
      ? settled("turn_2", `int_${sessionId}`, "accepted", "approve")
      : settled("turn_2", `int_${sessionId}`, "declined", "deny"), ctx);
    db.queries.length = 0;
    return session;
  }

  for (const decision of ["approve", "deny"] as const) {
    it(`web chat, after ${decision === "approve" ? "Approve" : "Deny"}: a new send in the continued turn is refused with the sentence, before any read`, async () => {
      const session = await answeredIn(`sess_send_${decision}`, decision);
      // Through the seam eve actually calls (the catalogue tool's request policy).
      expect(await m.approvals.catalogueApprovalRequest("personal_mailbox_send", newSend(session), undefined)).toEqual(refusal);
      expect(await m.send.personalSendApprovalRequest(newSend(session, "call_again") as never)).toEqual(refusal);
      expect(db.queries).toEqual([]); // nothing read or stored, so no draft and no card
      // The sentence says nothing about the earlier card.
      expect(SENTENCE).not.toContain(`int_sess_send_${decision}`);
    });
  }

  it("the next message is a new turn: the rule no longer applies (the send goes on to its usual checks)", async () => {
    const session = await answeredIn("sess_send_next", "approve");
    const next = sessionOf(session.id, member(), "turn_3");
    expect(m.turns.outwardActionAfterAnswerRefusal(next)).toBeUndefined();
    // With no conversation binding here the usual authority check then refuses, not this rule.
    const error = await m.send.personalSendApprovalRequest(newSend(next) as never).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("answered request");
  });

  it("a card that ended without an answer (expired, withdrawn) is not this rule's: no answer was applied", async () => {
    for (const outcome of ["expired", "withdrawn"]) {
      const session = sessionOf(`sess_send_${outcome}`, member());
      const ctx = { session, agent: { name: "chief-of-staff" } };
      await m.hook.events["interaction.opened"]!(opened("turn_2", `int_${outcome}`), ctx);
      await m.hook.events["interaction.settled"]!(settled("turn_2", `int_${outcome}`, outcome), ctx);
      expect(m.turns.outwardActionAfterAnswerRefusal(session)).toBeUndefined();
    }
  });

  it("a restart between the answer and the continued turn keeps the refusal", async () => {
    const session = await answeredIn("sess_send_restart", "approve");
    vi.resetModules();
    m = await load();
    expect(await m.send.personalSendApprovalRequest(newSend(session) as never)).toEqual(refusal);
    expect(db.queries).toEqual([]);
  });

  it("fails closed: a turn with no id, or session state that cannot be read, is refused", async () => {
    const noTurn = { id: "sess_send_noturn", auth: { current: member(), initiator: member() } };
    expect(await m.send.personalSendApprovalRequest(newSend(noTurn) as never)).toEqual(refusal);
    expect(await m.send.personalSendApprovalRequest(newSend({ ...noTurn, turn: { id: "", sequence: 2 } }) as never)).toEqual(refusal);
    durable.readable = false;
    expect(await m.send.personalSendApprovalRequest(newSend(sessionOf("sess_send_unreadable", member())) as never)).toEqual(refusal);
    expect(db.queries).toEqual([]);
  });

  for (const [door, who] of Object.entries(DOORS)) {
    it(`${door}: after the owner answers a card, a send in the continued turn raises no card`, async () => {
      const session = sessionOf(`sess_send_${door}`, who.owner);
      const ctx = { session, agent: { name: "chief-of-staff" } };
      await m.hook.events["interaction.opened"]!(opened("turn_2", "int_door"), ctx);
      expect(m.approvals.nativeAnswerDecision(nativeAnswer("int_door", session.id, who.owner, "approve"))).toEqual({ status: "allowed" });
      await m.hook.events["interaction.settled"]!(settled("turn_2", "int_door", "accepted", "approve"), ctx);
      db.queries.length = 0;
      // The send tool is never offered on this door; a replayed call is refused before its policy.
      await expect(m.approvals.catalogueApprovalRequest("personal_mailbox_send", newSend(session), undefined)).rejects.toThrow();
      // And the rule itself is not tied to a door: the policy refuses this turn with the sentence too.
      expect(await m.send.personalSendApprovalRequest(newSend(session) as never)).toEqual(refusal);
      expect(db.queries).toEqual([]);
    });
  }
});

/**
 * THE SAME RULE FOR THE OTHER ACTIONS THAT REACH OTHER PEOPLE (the owner's ruling): calendar create,
 * update and delete (they email the attendees), and `gmail_send` and `meeting_followup_send` on
 * Slack and Telegram. In the turn an answer to a card was applied in, a call that would raise a card
 * is refused with one sentence; a tool the owner set to "autonomous" is left as it is; eve's recheck
 * of the answered card's own approved call still passes. Here through the real catalogue seam
 * (`catalogueApprovalRequest`) with the authored policy as a recording stand-in for the permissions
 * table at "gated", so nothing else (and no provider) is reached. Web chat calendar cards, which
 * need the real owner check, are driven against a database in tests/webchat-calendar-approval.test.ts.
 */
describe("nothing that reaches other people in the reply to an answered request (Slack and Telegram)", () => {
  const SENTENCE = "That cannot be started in the reply to an answered request. Ask again in a new message.";
  const refusal = { type: "denied", reason: SENTENCE };
  const TOOLS = {
    gmail_send: { to: ["guest@example.invalid"], subject: "Hello", body: "Body" },
    meeting_followup_send: { seriesKey: "", to: ["guest@example.invalid"], subject: "Notes", bodyText: "Body", meetingTitle: "Sync", meetingWhen: "today", from: "owner@example.invalid" },
    calendar_create_event: { summary: "Sync", start: "2026-01-01T10:00:00Z", end: "2026-01-01T10:30:00Z", attendees: ["guest@example.invalid"] },
    calendar_update_event: { eventId: "e1", start: "2026-01-02T10:00:00Z", end: "2026-01-02T10:30:00Z" },
    calendar_delete_event: { eventId: "e1" },
  } as const;
  const call = (name: string, session: unknown, callId = `call_${name}`) => ({ session, callId, toolName: name, toolInput: structuredClone(TOOLS[name as keyof typeof TOOLS]) });
  /** eve's own re-check of an approved call: the real evaluateApproval with recheck on. */
  const evalUrl = new URL("../node_modules/eve/dist/src/approval/evaluation.js", import.meta.url).href;
  const recheck = async (policy: (c: unknown) => unknown, ctx: unknown) =>
    ((await import(evalUrl)) as { evaluateApproval: (p: unknown, c: unknown, o: unknown) => Promise<{ denied: boolean }> }).evaluateApproval(policy, ctx, { recheck: true });

  async function ownerAnswered(door: keyof typeof DOORS, decision: "approve" | "deny", sessionId: string) {
    const owner = DOORS[door].owner, session = sessionOf(sessionId, owner), ctx = { session, agent: { name: "chief-of-staff" } };
    await m.hook.events["interaction.opened"]!(opened("turn_2", "int_out"), ctx);
    expect(m.approvals.nativeAnswerDecision(nativeAnswer("int_out", session.id, owner, decision))).toEqual({ status: "allowed" });
    await m.hook.events["interaction.settled"]!(decision === "approve"
      ? settled("turn_2", "int_out", "accepted", "approve") : settled("turn_2", "int_out", "declined", "deny"), ctx);
    db.queries.length = 0;
    return session;
  }

  for (const door of Object.keys(DOORS) as (keyof typeof DOORS)[]) {
    for (const decision of ["approve", "deny"] as const) {
      it(`${door}, after ${decision === "approve" ? "Approve" : "Deny"}: each such tool at "gated" is refused with the sentence, before any card or provider call`, async () => {
        const session = await ownerAnswered(door, decision, `sess_out_${door}_${decision}`);
        for (const name of Object.keys(TOOLS)) {
          const gated = vi.fn(() => "user-approval");
          expect(await m.approvals.catalogueApprovalRequest(name, call(name, session), gated), name).toEqual(refusal);
          expect(gated, name).toHaveBeenCalledOnce(); // only the level was read: nothing outward
        }
        expect(db.queries).toEqual([]);
      });
    }

    it(`${door}: a tool the owner set to run on its own ("autonomous") is left as it is in that reply`, async () => {
      const session = await ownerAnswered(door, "approve", `sess_out_${door}_auto`);
      for (const name of Object.keys(TOOLS)) {
        expect(await m.approvals.catalogueApprovalRequest(name, call(name, session), () => "not-applicable"), name).toBe("not-applicable");
        expect(await m.approvals.catalogueApprovalRequest(name, call(name, session), () => "approved"), name).toBe("approved");
      }
    });

    it(`${door}: every form of eve's approval status is recognised in that reply; an unknown form is refused (fails closed)`, async () => {
      const session = await ownerAnswered(door, "approve", `sess_out_${door}_forms`);
      const denial = { type: "denied", reason: "Follow-ups are switched off." };
      for (const name of Object.keys(TOOLS)) {
        // No card: passed through unchanged.
        for (const decision of ["not-applicable", false, "approved", "denied", denial] as const)
          expect(await m.approvals.catalogueApprovalRequest(name, call(name, session), () => decision), `${name} ${JSON.stringify(decision)}`).toEqual(decision);
        // Asks a person, in either form, or a form eve does not document: refused with the sentence.
        for (const decision of ["user-approval", true, "ask-later", { type: "user-approval" }, undefined])
          expect(await m.approvals.catalogueApprovalRequest(name, call(name, session), () => decision), `${name} ${JSON.stringify(decision)}`).toEqual(refusal);
      }
    });

    it(`${door}: the answered card's own approved call still passes eve's recheck, once per tool`, async () => {
      const session = await ownerAnswered(door, "approve", `sess_out_${door}_recheck`);
      for (const name of Object.keys(TOOLS)) {
        const gated = vi.fn(() => "user-approval");
        await expect(recheck((c) => m.approvals.catalogueApprovalRequest(name, c, gated), call(name, session)), name).resolves.toMatchObject({ denied: false });
        expect(gated, name).toHaveBeenCalledOnce();
      }
    });

    it(`${door}: the next message is a new turn, and each such tool raises its card as before`, async () => {
      const session = await ownerAnswered(door, "approve", `sess_out_${door}_next`);
      const next = sessionOf(session.id, DOORS[door].owner, "turn_3");
      for (const name of Object.keys(TOOLS)) expect(await m.approvals.catalogueApprovalRequest(name, call(name, next), () => "user-approval"), name).toBe("user-approval");
    });
  }

  it("a restart between the answer and the continued turn keeps the refusal", async () => {
    const session = await ownerAnswered("Slack", "approve", "sess_out_restart");
    vi.resetModules();
    m = await load();
    for (const name of Object.keys(TOOLS)) expect(await m.approvals.catalogueApprovalRequest(name, call(name, session), () => "user-approval"), name).toEqual(refusal);
  });

  it("fails closed: a turn with no id, or session state that cannot be read, is refused", async () => {
    const owner = DOORS.Telegram.owner;
    const noTurn = { id: "sess_out_noturn", auth: { current: owner, initiator: owner } };
    for (const name of Object.keys(TOOLS)) expect(await m.approvals.catalogueApprovalRequest(name, call(name, noTurn), () => "user-approval"), name).toEqual(refusal);
    durable.readable = false;
    for (const name of Object.keys(TOOLS)) expect(await m.approvals.catalogueApprovalRequest(name, call(name, sessionOf("sess_out_unreadable", owner)), () => "user-approval"), name).toEqual(refusal);
  });

  it("other tools that ask first (a CRM note, a reminder) are not this rule's and still raise their card", async () => {
    const session = await ownerAnswered("Slack", "approve", "sess_out_others");
    for (const name of ["twenty_note", "remind_set", "notion_resolve_proposal"]) {
      expect(await m.approvals.catalogueApprovalRequest(name, { session, callId: `call_${name}`, toolName: name, toolInput: {} }, () => "user-approval"), name).toBe("user-approval");
    }
  });

  it("the settle hook marks the hook's own turn too, should eve ever give the event another turn: the rule then refuses in both", async () => {
    const owner = DOORS.Slack.owner, session = sessionOf("sess_out_turns", owner, "turn_9"), ctx = { session, agent: { name: "chief-of-staff" } };
    await m.hook.events["interaction.opened"]!(opened("turn_2", "int_turns"), ctx);
    await m.hook.events["interaction.settled"]!(settled("turn_2", "int_turns", "accepted", "approve"), ctx);
    for (const turnId of ["turn_2", "turn_9"]) {
      expect(await m.approvals.catalogueApprovalRequest("gmail_send", call("gmail_send", sessionOf(session.id, owner, turnId)), () => "user-approval"), turnId).toEqual(refusal);
    }
    expect(await m.approvals.catalogueApprovalRequest("gmail_send", call("gmail_send", sessionOf(session.id, owner, "turn_10")), () => "user-approval")).toBe("user-approval");
  });

  // KNOWN GAP (Slack and Telegram). The answer mark is written only by the settle hook. If the agent
  // stops after eve wrote the settle line but before that hook's state was saved, eve does not run the
  // hook again, so the mark is lost and the continued turn is not recognised. Web chat is covered
  // another way: after any restart the continuation's model call is refused (next test), so no new
  // action can be proposed. On these doors a native turn needs no model capability, so the rule does
  // not fire. This test says what should happen; it fails today, which `it.fails` records.
  it.fails("Slack, a crash before the settle hook's mark was saved: a new gmail_send card in the continued turn is refused", async () => {
    const owner = DOORS.Slack.owner, session = sessionOf("sess_out_lost", owner), ctx = { session, agent: { name: "chief-of-staff" } };
    await m.hook.events["interaction.opened"]!(opened("turn_2", "int_lost"), ctx);
    expect(m.approvals.nativeAnswerDecision(nativeAnswer("int_lost", session.id, owner, "approve"))).toEqual({ status: "allowed" });
    // The settle hook never ran (lost to the crash); the restarted process continues the turn.
    vi.resetModules();
    m = await load();
    expect(await m.approvals.catalogueApprovalRequest("gmail_send", call("gmail_send", session), () => "user-approval")).toEqual(refusal);
  });

  it("web chat, a crash before the settle hook's mark was saved: the continued turn's model call is refused, so nothing new can be proposed", async () => {
    const session = sessionOf("sess_out_lost_web", member()), ctx = { session, agent: { name: "chief-of-staff" } };
    await m.hook.events["interaction.opened"]!(opened("turn_2", "int_lost_web"), ctx);
    webChatAnswer(m, session, "int_lost_web", "approve");
    vi.resetModules();
    m = await load();
    m.seam.prepareModelPurposeInvocation(step("turn_2"), session as never);
    await expect(m.seam.claimModelPurposeForInvocation(m.captureModelInvocation(step("turn_2"), session as never, "lares-brain"))).rejects.toThrow();
    expect(requestMock.mock.calls.filter(([op]) => op === "turn.open")).toHaveLength(0);
  });
});
