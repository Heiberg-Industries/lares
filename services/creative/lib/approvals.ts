/**
 * The approver re-check every gated tool calls.
 *
 * Ported from `services/chief-of-staff/lib/approvals.ts` and narrowed to Calliope's one channel —
 * see `lib/principals.ts` for the full list of what was dropped and why. The one structural
 * difference from eve-saga's copy: her `declaredApprover` fallback (ORB-146, for a Telegram
 * card rendered in a schedule-opened session) is GONE, because the module it came from is gone
 * and because nothing in this service can reach it. Calliope has no schedules, and on Slack
 * the clicker supplies the session auth, so `auth.current` is populated on exactly the path
 * Telegram leaves null.
 */
import { approvalLedger, assertApprovedCall, callIdFrom } from "@lares/agent-kit/approval-ledger";

import { isAllowedPrincipal, principalFromAuth } from "./principals.js";

/**
 * Refused because the person who approved is not the person allowed to.
 *
 * Typed, and distinct from a write failure, because these two are the ones an operator must
 * never confuse: "the gate stopped someone" and "the Atlas push failed" look identical in a
 * transcript otherwise.
 */
export class UnauthorizedApproverError extends Error {
  constructor(readonly approver: string) {
    super(
      `approval refused: ${approver} is not an allowed approver for this agent. ` +
        `A Slack approval button can be clicked by anyone who can see the message, so the ` +
        `approver is re-checked here against lib/principals.ts.`,
    );
    this.name = "UnauthorizedApproverError";
  }
}

/** The normalised shape a caller extracts from the session's auth context (via
 *  `principalFromAuth`) before calling `assertApprover`. `absent` is set ONLY for a
 *  null/undefined auth context; `assertApprover` refuses it — only `approverFrom`'s initiator
 *  fallback consumes the marker. */
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
 * `current` — the identity that triggered THIS resume — wins whenever it exists, and on Slack
 * it normally does: the person who clicks supplies the auth for the resumed session. When it
 * is ABSENT (null/undefined), the approval is attributed to the session's INITIATOR — the
 * channel-verified identity that opened the session — and checked against the allowlist
 * exactly like any other principal.
 *
 * The initiator fallback is kept rather than trimmed with the rest of the Telegram machinery,
 * because it is not Telegram machinery: it is the fail-closed answer to "a resume arrived with
 * no identity at all", whatever produced it. A session with an unknown or missing initiator
 * still refuses. Removing it would turn a future eve change in that direction into a hard
 * refusal of every approval rather than a correct one.
 */
export function approverFrom(
  auth: SessionAuthLike | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ApprovalPrincipal {
  const current = principalFromAuth(auth?.current);
  if (current.absent !== true) return current;

  // A human-opened session: the initiator IS the channel-verified human, and attributing an
  // anonymous resume to them states the real fact. Gated on the allowlist rather than on the
  // shape of the authenticator, so an app initiator can never satisfy it by accident.
  const initiator = principalFromAuth(auth?.initiator);
  if (initiator.absent !== true && isAllowedPrincipal(initiator.authenticator, initiator.userId, env)) {
    return initiator;
  }

  // Nothing resolvable. Return the initiator when there is one, purely so the refusal names
  // what it actually saw instead of "an unidentified principal".
  return initiator.absent === true ? {} : initiator;
}

/**
 * Re-checks WHO approved, which the framework does not.
 *
 * eve's own Slack docs: "Built-in HITL buttons are handled before `onInteraction`, and the
 * person who clicks supplies the auth for the resumed session. Anyone who can interact with
 * the message can answer it." So the channel's inbound allowlist — which gates who may start a
 * turn — does not cover the click that authorises the write: that path never reaches an
 * authored inbound handler. eve's remedy is the one applied here, and it is the tool's job,
 * not the channel's.
 *
 * Fail-closed on every other principal too, including authenticators this agent may front for
 * other purposes (e.g. an HTTP Basic operator route): an operator with the route password can
 * start a session, but a studio run or an Atlas commit wants a named, channel-verified human.
 */
export function assertApprover(
  approval: ApprovalPrincipal,
  env: NodeJS.ProcessEnv = process.env,
): void {
  // Strict, including ABSENT: an approval with no identity refuses. The null-auth reality is
  // handled UPSTREAM by `approverFrom`, which attributes an anonymous resume to the session's
  // verified INITIATOR — never by exempting absence itself, which would be an in-band bypass
  // any future null-auth path would inherit.
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
 * module's header) — which is also this service's whole situation until a later slice adds an
 * `approval_asks` recorder here (W7A-s4's hook is chief-of-staff-only so far), so today this
 * always resolves to "no row" and the check is a no-op that costs nothing.
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
