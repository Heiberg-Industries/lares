/**
 * The approver re-check every gated write calls, on both channels.
 *
 * Extracted from `agent/tools/echo_note.ts`'s original local `assertApproverAllowed` (Task
 * 9) and widened from Slack-only to whichever channel `lib/principals.ts` knows about.
 */
import { approvalLedger, assertApprovedCall, callIdFrom } from "@lares/agent-kit/approval-ledger";

import { declaredApprover, isAllowedPrincipal, principalFromAuth } from "./principals.js";

/**
 * Refused because the person who approved is not the person allowed to, on THIS channel.
 *
 * Typed, and distinct from a write failure, because these two are the ones an operator
 * must never confuse: "the gate stopped someone" and "the disk was full" look identical in
 * a transcript otherwise.
 */
export class UnauthorizedApproverError extends Error {
  constructor(readonly approver: string) {
    super(
      `approval refused: ${approver} is not an allowed approver for this agent. ` +
        `A Slack or Telegram approval button can be clicked by anyone who can see the ` +
        `message, so the approver is re-checked here against lib/principals.ts.`,
    );
    this.name = "UnauthorizedApproverError";
  }
}

/** The normalised shape a caller extracts from its channel's auth context (e.g. via
 *  `principalFromAuth`) before calling `assertApprover`. `absent` is set ONLY for a
 *  null/undefined auth context; `assertApprover` refuses it — only `approverFrom`'s
 *  initiator fallback consumes the marker. */
export interface ApprovalPrincipal {
  authenticator?: string;
  userId?: string;
  absent?: boolean;
}

/** The `ctx.session.auth` projection every eve tool receives. */
export interface SessionAuthLike {
  current?: unknown;
  initiator?: unknown;
}

/**
 * The approver for a gated tool call, resolved from the session's auth contexts.
 *
 * `current` — the identity that triggered THIS resume — wins whenever it exists. When it
 * is ABSENT (null/undefined), the approval is attributed to the session's INITIATOR — the
 * channel-verified identity that opened the session — and checked against the allowlist
 * exactly like any other principal.
 *
 * Why the fallback exists (verified in the bundled dist, eve 0.32,
 * `channels/telegram/telegramChannel.js` `dispatchCallbackQuery`): eve resumes Telegram
 * HITL button taps with `.respond(..., { auth: null })` — the tap itself carries no
 * identity, by the framework's construction. The session's initiator, though, is real and
 * verified: a Telegram session only exists because a secret-token-verified update from an
 * allowlisted user id in a private chat opened it, and that inline-keyboard card only
 * exists inside that same chat. Attributing the anonymous tap to the initiator states the
 * actual security fact — "whoever can tap this card is whoever opened this session" — and
 * stays fail-closed everywhere else: a session with an unknown or missing initiator
 * refuses, whatever channel or route produced it, today or in a future eve version.
 */
export function approverFrom(
  auth: SessionAuthLike | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ApprovalPrincipal {
  const current = principalFromAuth(auth?.current);
  if (current.absent !== true) return current;

  // A human-opened session: the initiator IS the channel-verified human, and attributing the
  // anonymous tap to them states the real fact. Gated on the allowlist rather than on the
  // shape of the authenticator, so an app initiator can never satisfy it by accident.
  const initiator = principalFromAuth(auth?.initiator);
  if (initiator.absent !== true && isAllowedPrincipal(initiator.authenticator, initiator.userId, env)) {
    return initiator;
  }

  // A SCHEDULE-opened session (ORB-146). The initiator is the app and says nothing about who
  // tapped — but the push declared which chat it was addressed to, and a card only ever renders
  // in that chat. Fail-closed either way: this principal goes through the same allowlist check
  // as every other, so an unknown or wrong chat still refuses.
  const declared = declaredApprover(auth?.initiator);
  if (declared !== undefined) return declared;

  // Nothing resolvable. Return the initiator when there is one, purely so the refusal names
  // what it actually saw instead of "an unidentified principal".
  return initiator.absent === true ? {} : initiator;
}

/**
 * The check an UNGATED, model-called write needs when its authority is "Bendik just said so"
 * (ORB-167 fix). Returns a refusal sentence, or null when this turn really is his.
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
 * telling the model why costs nothing; throwing would cost Bendik the turn he is in.
 */
export function humanTurnRefusal(
  auth: SessionAuthLike | null | undefined,
  lead: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
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
  return `${lead} But ${saw}, not as him — there is nothing he said on this turn. Nothing changed.`;
}

/**
 * Re-checks WHO approved, which the framework does not.
 *
 * eve's own Slack docs: "Built-in HITL buttons are handled before `onInteraction`, and the
 * person who clicks supplies the auth for the resumed session. Anyone who can interact
 * with the message can answer it." The same holds for Telegram's inline-keyboard HITL. So
 * a channel's inbound allowlist — which gates who may start a turn — does not cover the
 * click that authorises the write: that path never reaches an authored inbound handler.
 * eve's remedy is the one applied here, and it is the tool's job, not the channel's.
 *
 * Fail-closed on every other principal too, including authenticators this agent fronts for
 * other purposes (e.g. an HTTP Basic operator route): an operator with the route password
 * can start a session, but a write wants a named, channel-verified human.
 */
export function assertApprover(
  approval: ApprovalPrincipal,
  env: NodeJS.ProcessEnv = process.env,
): void {
  // Strict, including ABSENT: an approval with no identity refuses. The Telegram
  // null-auth reality is handled UPSTREAM by `approverFrom` (below), which attributes an
  // anonymous resume to the session's verified INITIATOR — never by exempting
  // absence itself (an in-band bypass any null-auth path would inherit; flagged by
  // security review 2026-08-16).
  if (!isAllowedPrincipal(approval.authenticator, approval.userId, env)) {
    const label =
      approval.userId !== undefined && approval.userId.length > 0
        ? `${approval.authenticator ?? "unknown-channel"}:${approval.userId}`
        : "an unidentified principal";
    throw new UnauthorizedApproverError(label);
  }
}

/**
 * The one call a gated tool makes before it acts (W7A-s6): WHO answered (unchanged,
 * unconditional — `assertApprover` first, exactly as every call site had it), then WHICH CARD
 * they answered — the same arguments, and not a stale one (`assertApprovedCall`,
 * `@lares/agent-kit/approval-ledger`, W7A-s5). Never a replacement for `assertApprover`: a
 * missing call id or a missing row PASSES here (evidence never fails an action — see that
 * module's header), so an autonomous call or a box without 086 applied is unaffected.
 *
 * `input` MUST be the tool's own raw first argument, unmodified — never a destructured-and-
 * rebuilt object. `payloadFingerprint` treats a key present with an `undefined` value as
 * different from a key that is absent, so reconstructing `{ ...destructured }` from an input
 * whose optional field was never supplied would mismatch the hash the card was shown with and
 * refuse a call nothing actually changed about.
 *
 * DEVIATION FROM THE PLAN'S SNIPPET: `ctx`'s type drops the plan's
 * `& Record<string, unknown>` — eve's real `ToolContext` (what every call site actually
 * passes) has no index signature, so that intersection does not compile against it
 * (`tsc`: "Index signature for type 'string' is missing in type 'ToolContext'"). `{ session?:
 * { auth?: SessionAuthLike | null } }` alone is exactly what every existing call site's
 * `ctx.session.auth` already satisfied.
 */
export async function assertApproval(
  ctx: { session?: { auth?: SessionAuthLike | null } },
  toolName: string,
  input: unknown,
): Promise<void> {
  assertApprover(approverFrom(ctx?.session?.auth));
  await assertApprovedCall(approvalLedger(), { callId: callIdFrom(ctx), toolName, input });
}
