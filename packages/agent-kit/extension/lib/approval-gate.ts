/**
 * The approver re-check the extension's gated vault writes call — `vault_write`,
 * `vault_file`, `vault_drop` (ORB-143 Task 2).
 *
 * Ported from `services/chief-of-staff/lib/approvals.ts`'s `approverFrom`/`assertApprover`/
 * `UnauthorizedApproverError`, which stays live there unchanged for every OTHER gated tool
 * (`gmail_send`, `twenty_*`, `calendar_*`, `remind_*`, `echo_note`, `*_resolve_proposal`) —
 * none of those move in this task. This IS a second, parallel copy: `UnauthorizedApproverError`
 * here is a DIFFERENT class than eve-saga's (different module, different prototype), so an
 * `instanceof` check against one never matches an error thrown by the other. Nothing in the
 * codebase does that check across the boundary — verified by grep before this file was
 * written — each gated tool file imports its OWN approval helpers and nothing compares
 * error identity between tools. If that ever changes, check here first.
 *
 * The one substantive difference from the eve-saga original: `assertApprover` here takes
 * the actual allowlist check as an INJECTED parameter (`isApprovedPrincipal`) instead of
 * importing `isAllowedPrincipal` from `lib/principals.ts` directly. That import is exactly
 * what this extension must never make — `lib/principals.ts`/`lib/approvals.ts` are a
 * deliberate least-privilege boundary that stays local to eve-saga (the parent plan's hard
 * constraint, not a style choice): they know eve-saga's channel allowlist env vars
 * (`SLACK_ALLOWED_USER_IDS`, `TELEGRAM_PRINCIPAL_ID`), which this package has no business
 * reading. `principalFromAuth` has no such coupling — it only shapes a raw `ctx.session.auth`
 * value into `{authenticator, userId, absent}`, so it's ported verbatim with no injection
 * needed.
 *
 * `makeApprovalGate(resolveIsApprovedPrincipal)` mirrors `extension/lib/orakel-client.ts`'s
 * `makeOrakelClient(resolveConfig)` pattern (ORB-143 Task 1, review round 1, "config-based
 * path had zero test coverage"): the core check logic is a plain function taking its
 * resolver as an explicit parameter, so `tests/approval-gate.test.ts` can construct one with
 * a fake in-test predicate — no `globalThis`/`eve.ext-config-scope` binding, no eve loader
 * involved. Production binds the resolver to this extension's own `config.brain` at the
 * bottom of this file; the three Brain write tool files import the bound `assertApprover`/
 * `approverFrom` below exactly as the three write-tool files used to import them from
 * eve-saga's `lib/approvals.ts` — this indirection is invisible to them.
 */
import extension from "../extension.js";

/** Refused because the person who approved is not the person allowed to, on THIS channel. */
export class UnauthorizedApproverError extends Error {
  constructor(readonly approver: string) {
    super(
      `approval refused: ${approver} is not an allowed approver for this agent. ` +
        `A Slack or Telegram approval button can be clicked by anyone who can see the ` +
        `message, so the approver is re-checked here against the injected allowlist.`,
    );
    this.name = "UnauthorizedApproverError";
  }
}

/** The normalised shape a caller extracts from its channel's auth context before calling
 *  `assertApprover`. `absent` is set ONLY for a null/undefined auth context; `assertApprover`
 *  refuses it — only `approverFrom`'s initiator fallback consumes the marker. */
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
 * Extracts `{authenticator, userId}` from an eve session auth context — the shape
 * `ctx.session.auth.current` carries. Ported verbatim from `lib/principals.ts`: pure
 * shaping, no allowlist knowledge, so no injection is needed for this half.
 *
 * `absent: true` marks the one shape that is deliberately NOT refused: a null/undefined
 * auth context (eve's Telegram HITL resume carries `auth: null` — see `approverFrom` below).
 */
export function principalFromAuth(auth: unknown): ApprovalPrincipal {
  if (auth === null || auth === undefined) return { absent: true };
  if (typeof auth !== "object") return {};
  const candidate = auth as { authenticator?: unknown; attributes?: Record<string, unknown> };
  const authenticator = typeof candidate.authenticator === "string" ? candidate.authenticator : undefined;
  const raw = candidate.attributes?.["user_id"];
  const userId = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : undefined;
  return { authenticator, userId };
}

/**
 * The approver for a gated tool call, resolved from the session's auth contexts. Ported
 * verbatim from `lib/approvals.ts` — see that file's docblock for the full Telegram
 * null-auth rationale (eve resumes Telegram HITL taps with `.respond(..., { auth: null })`,
 * so an anonymous resume is attributed to the session's verified INITIATOR, never exempted).
 */
export function approverFrom(auth: SessionAuthLike | null | undefined): ApprovalPrincipal {
  const current = principalFromAuth(auth?.current);
  if (current.absent !== true) return current;
  const initiator = principalFromAuth(auth?.initiator);
  return initiator.absent === true ? {} : initiator;
}

type IsApprovedPrincipal = (authenticator: string | undefined, userId: string | undefined) => boolean;

/**
 * Builds a bound `assertApprover` against an `isApprovedPrincipal` resolver — mirrors
 * `orakel-client.ts`'s `makeOrakelClient(resolveConfig)`. Kept free of any eve import so
 * tests can construct one with a plain fake resolver.
 */
export function makeApprovalGate(resolveIsApprovedPrincipal: () => IsApprovedPrincipal | undefined) {
  function assertApprover(approval: ApprovalPrincipal): void {
    const isApprovedPrincipal = resolveIsApprovedPrincipal();
    const allowed = isApprovedPrincipal !== undefined && isApprovedPrincipal(approval.authenticator, approval.userId);
    if (!allowed) {
      const label =
        approval.userId !== undefined && approval.userId.length > 0
          ? `${approval.authenticator ?? "unknown-channel"}:${approval.userId}`
          : "an unidentified principal";
      throw new UnauthorizedApproverError(label);
    }
  }
  return { assertApprover };
}

// Production binding: resolves against this extension's own bound config, read lazily
// (never at module scope) so it reflects whatever `agent-kit.ts` passed to `isApprovedPrincipal`
// at mount time. Absent config (capability not mounted, or mounted without `brain`) resolves
// to `undefined`, which `assertApprover` treats as "no principal is approved" — fail-closed,
// matching `lib/approvals.ts`'s own posture on every other absent/unrecognised shape.
const boundGate = makeApprovalGate(() => extension.config.brain?.isApprovedPrincipal);

export const assertApprover = boundGate.assertApprover;
