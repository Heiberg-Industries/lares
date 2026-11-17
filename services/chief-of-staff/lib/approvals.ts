// Binds the kit's approval rules (`@lares/agent-kit/approval-policy`) to this role: its doors, its
// exact-approval adapters and its own checks. Below the binding, what only this role has.
import { approvalPolicy, type SessionAuthLike } from "@lares/agent-kit/approval-policy";
import { principalFromAuth } from "@lares/agent-kit/principals";
import { isPrivateConsoleContext } from "@lares/agent-kit/private-console-surface";
import { isApprovalRecheck, type ApprovedExecution } from "@lares/agent-kit/approval-execution";
import { consoleAdmission, consoleResolverOnly, type ConsoleAuthorityContext } from "@lares/agent-kit/console-turn-authority";
import { getPool } from "@lares/agent-kit/db";
import { personalSendApprovalRequest, personalSendApprovalResponse, requirePersonalSendCall } from "./personal-send-approval.js";
import { callerIsAgentOwner } from "./webchat-owner.js";
import { deadlineApprovalAdapter } from "./deadlines-store.js";
import { canApproveCompanyTrack, tracksApprovalAdapter, twentyTracksApprovalAdapter } from "./tracks-approval.js";
import { calendarApprovalAdapter } from "./calendar-approval.js";
import { vaultNoteApprovalAdapter } from "./vault-note-write.js";
import * as principals from "./principals.js";
import { declaredApprover, isAllowedPrincipal } from "./principals.js";
import { outwardActionAfterAnswerRefusal, turnAskedACard } from "./approval-card-turns.js";

const companyHome = (input: unknown) => !!input && typeof input === 'object' && !Array.isArray(input) && (input as Record<string, unknown>).home === 'twenty';
const adapterFor = (tool: string, input?: unknown) => {
  return companyHome(input) && twentyTracksApprovalAdapter.toolNames.includes(tool)
    ? twentyTracksApprovalAdapter
    : tracksApprovalAdapter.toolNames.includes(tool) ? tracksApprovalAdapter
    : vaultNoteApprovalAdapter.toolNames.includes(tool) ? vaultNoteApprovalAdapter
    : calendarApprovalAdapter.toolNames.includes(tool) ? calendarApprovalAdapter : deadlineApprovalAdapter;
};
/** Tools whose changes need an exact approved card in a bound console conversation. */
const EXACT_TOOLS = [deadlineApprovalAdapter, tracksApprovalAdapter, twentyTracksApprovalAdapter, calendarApprovalAdapter, vaultNoteApprovalAdapter];

/**
 * WHO ANSWERED A NATIVE CARD. On eve 1.0 the settle hook's `session.auth.current` is the turn's
 * requester (for a scheduled job, the app). The person who answered is only `response.principal`
 * in the response policy, so the policy keeps it here once it has accepted the answer, and the
 * settle hook reads it (for example, to apply the owner's Deny as a track-routing veto).
 *
 * BOUNDED, AND FULL MEANS "NOT YET". An entry lives only from the answer to the card's settle: the
 * settle hook takes the entry of EVERY card it settles, not only a scheduled one's, so the store
 * holds answers eve has accepted but not yet applied (normally for a moment). It is capped per
 * conversation and in total. When an answer cannot be kept, the policy refuses it: the card stays
 * pending and the owner can answer again in a moment. It never accepts an answer whose answerer it
 * would then forget (that silently dropped the owner's Deny veto on a scheduled card), and it never
 * pushes out an answer already kept. The per-conversation cap means one busy conversation fills
 * only its own share, never the whole store.
 */
const NATIVE_ANSWER_MS = 10 * 60_000, MAX_NATIVE_ANSWERS = 1024, MAX_NATIVE_ANSWERS_PER_SESSION = 16;
const nativeAnswers = new Map<string, { sessionId: string; principal: unknown; expiresAt: number }>();
/** Keeps one accepted answer; returns why it cannot, or null once kept. */
function rememberNativeAnswer(requestId: unknown, sessionId: unknown, principal: unknown, now = Date.now()): string | null {
  if (typeof requestId !== "string" || !requestId || typeof sessionId !== "string" || !sessionId) return "this answer is not tied to a card in a conversation";
  for (const [k, v] of nativeAnswers) if (v.expiresAt <= now) nativeAnswers.delete(k);
  const earlier = nativeAnswers.get(requestId);
  if (earlier && earlier.sessionId !== sessionId) return "this answer is not tied to a card in a conversation";
  if (!earlier) {
    let mine = 0;
    for (const v of nativeAnswers.values()) if (v.sessionId === sessionId) mine++;
    if (mine >= MAX_NATIVE_ANSWERS_PER_SESSION || nativeAnswers.size >= MAX_NATIVE_ANSWERS) {
      return "too many answers are waiting to be applied; please answer again in a moment";
    }
  }
  // eve applies the latest answer from the same responder, so a later accepted answer replaces the earlier one.
  nativeAnswers.set(requestId, { sessionId, principal, expiresAt: now + NATIVE_ANSWER_MS });
  return null;
}
/** The accepted answerer of one native card in this conversation, used up on read (the settle hook
 *  calls it for every card it settles, so nothing outlives its card). Another conversation's take
 *  finds nothing and leaves the entry. */
export function takeNativeAnswerer(requestId: string, sessionId: unknown, now = Date.now()): unknown {
  const v = nativeAnswers.get(requestId);
  if (!v || v.sessionId !== sessionId) return undefined;
  nativeAnswers.delete(requestId);
  return v.expiresAt > now ? v.principal : undefined;
}
/** Tests only. */
export function clearNativeAnswersForTests(): void { nativeAnswers.clear(); }

/** The catalogue tools that reach other people and are refused in the reply to an answered request
 *  (`outwardActionAfterAnswerRefusal`, lib/approval-card-turns.ts): calendar writes email the attendees,
 *  and the two door sends mail them. The personal mail send applies the same rule in its own policy. */
const OUTWARD_AFTER_ANSWER_TOOLS: ReadonlySet<string> = new Set(['calendar_create_event','calendar_update_event','calendar_delete_event','gmail_send','meeting_followup_send']);
/** Every approval status eve 1.0 accepts that raises NO card, as its own reader defines them
 *  (`normalizeApprovalStatus` and `approvalDecision`, eve `dist/src/approval/status.js`): `undefined`
 *  and `false` and `"not-applicable"` continue with no prompt, `"approved"` runs without a person,
 *  `"denied"` denies, and the object forms `{ type }` of those three (`approved` and `denied` may
 *  carry a reason). The forms that pause for a person are `"user-approval"`, `true` and
 *  `{ type: "user-approval" }`. Anything else is not a status eve accepts; it is treated as asking
 *  (fails closed), so in the reply to an answered request it is refused like a card. */
const NO_CARD_TYPES: ReadonlySet<unknown> = new Set(['not-applicable', 'approved', 'denied']);
const raisesNoCard = (decision: unknown) => decision === undefined || decision === false || NO_CARD_TYPES.has(decision) ||
  (typeof decision === 'object' && decision !== null && NO_CARD_TYPES.has((decision as { type?: unknown }).type));
/** The shared rule, for a call that is about to raise a card. Never for eve's recheck of a call that
 *  is already approved: that is the answered card's own action, and it runs as before. */
const outwardRefusal = (name: string, ctx: unknown) => OUTWARD_AFTER_ANSWER_TOOLS.has(name) && !isApprovalRecheck(ctx)
  ? outwardActionAfterAnswerRefusal((ctx as ConsoleAuthorityContext | undefined)?.session as never) : undefined;

export const {
  approverFrom, assertApprover, assertOwnerAnswerer, assertApproval, nativeAnswerDecision,
  catalogueApprovalRequest, catalogueApprovalResponse, guardCatalogueExecution,
} = approvalPolicy({
  role: "chief-of-staff",
  principals,
  approvalDoors: "Slack or Telegram",
  declaredApprover,
  adapterFor,
  reserveRefusal: "deny",
  needsExactCard: (name) => EXACT_TOOLS.some(a => a.toolNames.includes(name)),
  keepAnswer: rememberNativeAnswer,
  callerIsOwner: callerIsAgentOwner,
  // A tool the owner set to run on its own ("autonomous") raises no card and is left as it is; one
  // that would ask first is refused in the reply to an answered request. At "gated" the authored
  // policy answers from the definition and the permissions table alone, before any provider call.
  nativeRequest: (name, ctx, decision) => raisesNoCard(decision) ? decision : outwardRefusal(name, ctx) ?? decision,
  // Web chat: every call of these tools asks first, so the refusal comes before the reservation.
  // The company CRM check is refused before any card or provider read; the adapter repeats it at
  // each later step.
  beforeExactCard: async (name, c) => {
    const answered = outwardRefusal(name, c);
    if (answered) return answered;
    const asking = consoleAdmission(c.session?.auth?.current);
    if (companyHome(c.toolInput) && !(asking && await canApproveCompanyTrack(getPool(), asking.memberId))) {
      return { type: 'denied', reason: 'Only the owner can approve a change to the company CRM.' };
    }
    return undefined;
  },
  ownChecks: {
    personal_mailbox_send: {
      request: (ctx) => personalSendApprovalRequest(ctx as never),
      response: (ctx) => personalSendApprovalResponse(ctx as never),
      execution: (ctx, input) => requirePersonalSendCall(ctx as never, input),
    },
  },
});

/**
 * The check an UNGATED, model-called write needs when its authority is "the owner just said so".
 * Returns a refusal sentence, or null when this turn really is the owner's.
 *
 * WHY THIS IS NOT `assertApprover`. That one answers "may this principal APPROVE an external
 * action" and is reached from a card tap, so it accepts the Telegram null-auth resume via
 * `approverFrom`'s initiator fallback. This one answers a different question — "did a human
 * UTTER something on this turn" — and for that only `auth.current` can speak: an initiator
 * fallback would attribute the 08:00 brief's own app turn to whoever opened the chat-day,
 * which is exactly the attribution that must not happen. So: `current`, allowlisted, nothing
 * else. A schedule-dispatched turn (`authenticator: "app"`) and an absent auth both refuse.
 *
 * A RETURNED SENTENCE, NOT A THROW, matching `rejectFact`'s posture in lib/standing-facts.ts:
 * these tools are ungated precisely because a wrong call must be cheap. Refusing the write and
 * telling the model why costs nothing; throwing would cost the owner the turn the owner is in.
 */
export function humanTurnRefusal(
  session: { auth?: SessionAuthLike | null; turn?: { id?: unknown } | null } | null | undefined,
  lead: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const auth = session?.auth;
  // The whole session, never the auth alone: the turn after an answered card runs as the person
  // who asked, so only the durable card mark (lib/approval-card-turns.ts) tells the two apart.
  if (consoleResolverOnly(auth?.current) || turnAskedACard(session)) return `${lead} This turn answers an approval; it contains no new human instruction. Nothing changed.`;
  const current = principalFromAuth(auth?.current);
  if (current.absent !== true && isAllowedPrincipal(current.authenticator, current.userId, env)) {
    return null;
  }
  const saw =
    current.absent === true
      ? "this turn carries no identity at all"
      : `this turn is running as ${[current.authenticator ?? "unknown-channel", current.userId]
          .filter((p): p is string => typeof p === "string" && p.length > 0)
          .join(":")}`;
  return `${lead} But ${saw}, not as the owner — there is nothing the owner said on this turn. Nothing changed.`;
}

/**
 * `humanTurnRefusal`, plus the one turn it cannot judge: a verified web chat (private console) turn.
 *
 * A web chat turn carries the console's member admission, not a door's `user_id`, so the door
 * allow-list above can never match it and every web chat turn would be refused. For that turn, and
 * only that one, the owner is decided by the SAME proof the owner-only web chat tools are re-checked
 * with when they run (the private-surface check, `callerIsAgentOwner`): the member pinned when
 * the conversation began is the agent's current owner. On top of that, `auth.current` must itself be
 * that member's human admission, because only the current message can say something (a turn with no
 * current identity, or an answer to a card, is refused as above). Async because the owner is read
 * from the database. Every other turn (Slack, Telegram, a schedule, no identity) is judged by
 * `humanTurnRefusal` alone, exactly as before, and the owner lookup is never made for it.
 */
export async function ownerTurnRefusal(
  session: { auth?: SessionAuthLike | null; turn?: { id?: unknown } | null } | null | undefined,
  lead: string,
  env: NodeJS.ProcessEnv = process.env,
  isOwner: (ctx: unknown) => Promise<boolean> = callerIsAgentOwner,
): Promise<string | null> {
  if (!isPrivateConsoleContext({ session })) return humanTurnRefusal(session, lead, env);
  const auth = session?.auth;
  if (consoleResolverOnly(auth?.current) || turnAskedACard(session)) return `${lead} This turn answers an approval; it contains no new human instruction. Nothing changed.`;
  if (consoleAdmission(auth?.current)?.purpose === "human" && await isOwner({ session })) return null;
  return `${lead} But this web chat message could not be confirmed as coming from this agent's owner. Nothing changed.`;
}

/** A durable, atomic one-use claim for an exact Twenty Tracks approval, made before provider I/O.
 *  Vault approvals are claimed by Keeper in its write transaction and must not pass through here. */
export async function runApprovedTwentyTrackOnce<T>(approved: ApprovedExecution | undefined,
  write: () => Promise<T>, db = getPool()): Promise<T> {
  if (!approved) return write();
  if (!['track_add_item', 'track_move_item'].includes(approved.toolName) ||
      approved.authority.origin !== 'approval-resume' || !approved.authority.requestId ||
      !approved.authority.actingMemberId || !approved.authority.agentId || !approved.authority.sessionId) {
    throw new Error('Exact Twenty track approval is unavailable');
  }
  const claimed = await db.query(`UPDATE approval_asks
    SET used_at=clock_timestamp(),use_count=use_count+1
    WHERE request_id=$1 AND call_id=$2 AND tool=$3 AND payload_hash=$4 AND outcome='approved' AND used_at IS NULL
      AND acting_member_id=$5 AND resolved_by_member_id=$5 AND session_id=$6 AND agent=$7
    RETURNING request_id`, [approved.authority.requestId, approved.callId, approved.toolName, approved.payloadHash,
      approved.authority.actingMemberId, approved.authority.sessionId, approved.authority.agentId]);
  if (claimed.rows.length !== 1) throw new Error('Exact Twenty track approval was already used or is unavailable');
  return write();
}

/** The same durable one-use claim for an exact calendar event change, made before Google is called.
 *  Without an exact approval (a native channel) the write runs as it always did. */
export async function runApprovedCalendarOnce<T>(approved: ApprovedExecution | undefined,
  write: () => Promise<T>, db = getPool()): Promise<T> {
  if (!approved) return write();
  if (!calendarApprovalAdapter.toolNames.includes(approved.toolName) ||
      approved.authority.origin !== 'approval-resume' || !approved.authority.requestId ||
      !approved.authority.actingMemberId || !approved.authority.agentId || !approved.authority.sessionId) {
    throw new Error('Exact calendar approval is unavailable');
  }
  const claimed = await db.query(`UPDATE approval_asks
    SET used_at=clock_timestamp(),use_count=use_count+1
    WHERE request_id=$1 AND call_id=$2 AND tool=$3 AND payload_hash=$4 AND outcome='approved' AND used_at IS NULL
      AND acting_member_id=$5 AND resolved_by_member_id=$5 AND session_id=$6 AND agent=$7
    RETURNING request_id`, [approved.authority.requestId, approved.callId, approved.toolName, approved.payloadHash,
      approved.authority.actingMemberId, approved.authority.sessionId, approved.authority.agentId]);
  if (claimed.rows.length !== 1) throw new Error('Exact calendar approval was already used or is unavailable');
  return write();
}
