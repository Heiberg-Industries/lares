import { describe, it, expect } from "vitest";

import { approverFrom, makeApprovalGate, principalFromAuth, UnauthorizedApproverError } from "../extension/lib/approval-gate.js";

/**
 * The extension's Brain-write approval re-check (ORB-143 Task 2).
 *
 * Ported from `services/chief-of-staff/tests/gate.test.ts` and `services/chief-of-staff/tests/
 * brain-writes.test.ts`'s "gating" describe block — same auth shapes, same cases — adapted
 * to this module's injected-resolver design: `makeApprovalGate` is constructed here with a
 * plain fake `isApprovedPrincipal`, exactly mirroring `tests/orakel-client.test.ts`'s
 * pattern for `makeOrakelClient`. No eve loader, no `globalThis`/`ext-config-scope` binding
 * involved — the bound production export (`extension.config.brain.isApprovedPrincipal`,
 * ultimately `lib/principals.ts`'s `isAllowedPrincipal`) is exercised instead by the live
 * `eve dev` check and the direct `summarizeApproval` check documented in task-2-report.md,
 * since eve-saga's own allowlist policy is out of scope for this package.
 */

const BENDIK = "U_EXAMPLE_OWNER";
const SOMEONE_ELSE = "U0BADBADBAD";

function slackAuth(userId: string) {
  return { attributes: { user_id: userId, channel_id: "D123", thread_ts: "1.0" }, authenticator: "slack-webhook" };
}

/** A fake allowlist: only BENDIK on slack-webhook is approved — mirrors eve-saga's real
 *  policy shape (channel-scoped) without importing anything eve-saga-specific. */
function fakeIsApprovedPrincipal(authenticator: string | undefined, userId: string | undefined): boolean {
  return authenticator === "slack-webhook" && userId === BENDIK;
}

describe("principalFromAuth", () => {
  it("marks a null/undefined auth as absent, not refused outright", () => {
    expect(principalFromAuth(null)).toEqual({ absent: true });
    expect(principalFromAuth(undefined)).toEqual({ absent: true });
  });

  it("extracts authenticator and a stringified numeric user id", () => {
    expect(principalFromAuth({ authenticator: "telegram-webhook", attributes: { user_id: 123456789 } })).toEqual({
      authenticator: "telegram-webhook",
      userId: "123456789",
    });
  });

  it("returns an empty shape for a present-but-unrecognisable auth", () => {
    expect(principalFromAuth("not an object")).toEqual({});
    expect(principalFromAuth({})).toEqual({ authenticator: undefined, userId: undefined });
  });
});

describe("approverFrom", () => {
  it("prefers session.auth.current when present", () => {
    expect(approverFrom({ current: slackAuth(BENDIK), initiator: slackAuth(SOMEONE_ELSE) })).toEqual({
      authenticator: "slack-webhook",
      userId: BENDIK,
    });
  });

  it("falls back to the initiator when current is absent (the Telegram HITL shape)", () => {
    const telegramInitiator = { authenticator: "telegram-webhook", attributes: { user_id: 123456789 } };
    expect(approverFrom({ current: null, initiator: telegramInitiator })).toEqual({
      authenticator: "telegram-webhook",
      userId: "123456789",
    });
  });

  it("refuses (returns {}) when both current and initiator are absent", () => {
    expect(approverFrom({ current: null, initiator: null })).toEqual({});
    expect(approverFrom(null)).toEqual({});
    expect(approverFrom(undefined)).toEqual({});
  });
});

describe("makeApprovalGate(resolver).assertApprover", () => {
  it("allows an approver the resolver approves", () => {
    const { assertApprover } = makeApprovalGate(() => fakeIsApprovedPrincipal);
    expect(() => assertApprover(approverFrom({ current: slackAuth(BENDIK) }))).not.toThrow();
  });

  it("refuses an approver the resolver does not approve", () => {
    const { assertApprover } = makeApprovalGate(() => fakeIsApprovedPrincipal);
    expect(() => assertApprover(approverFrom({ current: slackAuth(SOMEONE_ELSE) }))).toThrow(UnauthorizedApproverError);
  });

  it("refuses a present-but-unidentified caller", () => {
    const { assertApprover } = makeApprovalGate(() => fakeIsApprovedPrincipal);
    expect(() => assertApprover(approverFrom({ current: {} }))).toThrow(UnauthorizedApproverError);
  });

  it("refuses a fully absent session (both current and initiator missing)", () => {
    const { assertApprover } = makeApprovalGate(() => fakeIsApprovedPrincipal);
    expect(() => assertApprover(approverFrom({ current: null, initiator: null }))).toThrow(UnauthorizedApproverError);
  });

  it("refuses a principal that is not Slack-derived, even with a matching id — the resolver decides, not the raw id", () => {
    const { assertApprover } = makeApprovalGate(() => fakeIsApprovedPrincipal);
    expect(() =>
      assertApprover(approverFrom({ current: { ...slackAuth(BENDIK), authenticator: "http-basic" } })),
    ).toThrow(UnauthorizedApproverError);
  });

  it("fail-closed when the resolver itself resolves to undefined (capability not mounted with any config)", () => {
    const { assertApprover } = makeApprovalGate(() => undefined);
    expect(() => assertApprover(approverFrom({ current: slackAuth(BENDIK) }))).toThrow(UnauthorizedApproverError);
  });

  it("names the approver and the reason, without leaking any other detail", () => {
    const { assertApprover } = makeApprovalGate(() => fakeIsApprovedPrincipal);
    expect(() => assertApprover(approverFrom({ current: slackAuth(SOMEONE_ELSE) }))).toThrow(
      new RegExp(SOMEONE_ELSE),
    );
  });

  it("re-reads the resolver on every call, rather than caching it at construction", () => {
    let currentChecker = fakeIsApprovedPrincipal;
    const { assertApprover } = makeApprovalGate(() => currentChecker);
    expect(() => assertApprover(approverFrom({ current: slackAuth(BENDIK) }))).not.toThrow();

    currentChecker = () => false; // e.g. the allowlist changed mid-process
    expect(() => assertApprover(approverFrom({ current: slackAuth(BENDIK) }))).toThrow(UnauthorizedApproverError);
  });
});
