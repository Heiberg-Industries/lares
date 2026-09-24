/**
 * ORB-146 — a gated write on Telegram must survive a session that a SCHEDULE opened.
 *
 * The live failure (2026-08-23): Bendik asked for a reminder on Telegram, approved the card,
 * and got "couldn't confirm the approver identity". Cause, from `workflow.workflow_hooks`:
 *
 *   06:00 UTC  morning brief   → retired the previous day's token
 *   07:00 UTC  weekly summary  → BOUND the live session
 *   11:42 UTC  Bendik's message → resumed INTO that session
 *
 * eve resumes an inline-keyboard tap with `auth: null`, so `auth.current` is empty; the
 * session's `initiator` was then the APP (the scheduled push), not a human. The old fallback
 * attributed the tap to that initiator and correctly refused — which meant every gated write
 * on Telegram failed on any day a schedule spoke first, i.e. most days.
 *
 * The fix does not loosen the gate: a scheduled push now DECLARES the chat it is addressed to,
 * and the declared principal goes through the same allowlist check as every other.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { approverFrom, assertApprover, UnauthorizedApproverError } from "../lib/approvals.js";
import { telegramPushAttributes, declaredApprover, AUTHENTICATOR_FOR } from "../lib/principals.js";

const SLACK_BENDIK = "U_EXAMPLE_OWNER";
const TELEGRAM_BENDIK = "123456789";

beforeEach(() => {
  process.env["SLACK_ALLOWED_USER_IDS"] = SLACK_BENDIK;
  process.env["TELEGRAM_PRINCIPAL_ID"] = TELEGRAM_BENDIK;
});
afterEach(() => {
  delete process.env["SLACK_ALLOWED_USER_IDS"];
  delete process.env["TELEGRAM_PRINCIPAL_ID"];
});

/** What a scheduled Telegram push puts on the session, after the fix. */
const scheduledPushAuth = (chatId = TELEGRAM_BENDIK) => ({
  authenticator: "app",
  principalId: "eve-saga",
  principalType: "app",
  attributes: telegramPushAttributes("morning-brief", chatId),
});

/** What a human Telegram message puts on the session. `principalFromAuth` reads the user id
 *  from `attributes.user_id` — NOT from `principalId`, which carries the channel address. */
const humanTelegramAuth = (userId = TELEGRAM_BENDIK) => ({
  authenticator: AUTHENTICATOR_FOR.telegram,
  principalId: userId,
  principalType: "user",
  attributes: { user_id: userId },
});

describe("THE ORB-146 CASE — schedule opened the session, human taps the card", () => {
  it("resolves to the declared chat principal and is APPROVED", () => {
    const approver = approverFrom({ current: null, initiator: scheduledPushAuth() });
    expect(approver.userId).toBe(TELEGRAM_BENDIK);
    expect(() => assertApprover(approver)).not.toThrow();
  });

  it("is the whole point: this exact shape used to refuse", () => {
    // Same input minus the declaration — i.e. the pre-fix world.
    const undeclared = { authenticator: "app", principalId: "eve-saga", attributes: { lane: "morning-brief" } };
    expect(() => assertApprover(approverFrom({ current: null, initiator: undeclared })))
      .toThrow(UnauthorizedApproverError);
  });
});

describe("the fix does NOT loosen the gate", () => {
  it("a declared chat that is NOT allowlisted still refuses", () => {
    const approver = approverFrom({ current: null, initiator: scheduledPushAuth("999999") });
    expect(() => assertApprover(approver)).toThrow(UnauthorizedApproverError);
  });

  it("an app initiator with NO declaration refuses — absence is never a pass", () => {
    const bare = { authenticator: "app", principalId: "eve-saga", attributes: {} };
    expect(() => assertApprover(approverFrom({ current: null, initiator: bare })))
      .toThrow(UnauthorizedApproverError);
  });

  it("entirely absent auth refuses", () => {
    expect(() => assertApprover(approverFrom({ current: null, initiator: null })))
      .toThrow(UnauthorizedApproverError);
    expect(() => assertApprover(approverFrom(null))).toThrow(UnauthorizedApproverError);
  });

  it("a declared principal cannot cross channels — a Slack id declared as telegram refuses", () => {
    const crossed = {
      authenticator: "app",
      principalId: "eve-saga",
      attributes: telegramPushAttributes("morning-brief", SLACK_BENDIK),
    };
    expect(() => assertApprover(approverFrom({ current: null, initiator: crossed })))
      .toThrow(UnauthorizedApproverError);
  });
});

describe("unchanged behaviour", () => {
  it("a present `current` still wins over everything", () => {
    const approver = approverFrom({
      current: humanTelegramAuth(),
      initiator: scheduledPushAuth("999999"),
    });
    expect(approver.userId).toBe(TELEGRAM_BENDIK);
    expect(approver.authenticator).toBe(AUTHENTICATOR_FOR.telegram);
  });

  it("a HUMAN-opened session still attributes the anonymous tap to that human", () => {
    const approver = approverFrom({ current: null, initiator: humanTelegramAuth() });
    expect(approver.userId).toBe(TELEGRAM_BENDIK);
    expect(() => assertApprover(approver)).not.toThrow();
  });

  it("a human initiator who is NOT allowlisted still refuses", () => {
    const approver = approverFrom({ current: null, initiator: humanTelegramAuth("111") });
    expect(() => assertApprover(approver)).toThrow(UnauthorizedApproverError);
  });

  it("Slack is untouched — its taps carry `current`, which still wins", () => {
    const slackHuman = {
      authenticator: AUTHENTICATOR_FOR.slack,
      principalId: SLACK_BENDIK,
      principalType: "user",
      attributes: { user_id: SLACK_BENDIK },
    };
    expect(() => assertApprover(approverFrom({ current: slackHuman, initiator: null }))).not.toThrow();
  });
});

describe("declaredApprover reads only well-formed declarations", () => {
  it("returns the pair for a valid declaration", () => {
    expect(declaredApprover(scheduledPushAuth())).toEqual({
      authenticator: AUTHENTICATOR_FOR.telegram,
      userId: TELEGRAM_BENDIK,
    });
  });

  it("ignores an unknown channel name", () => {
    expect(declaredApprover({ attributes: { approverChannel: "carrier-pigeon", approverPrincipalId: "x" } }))
      .toBeUndefined();
  });

  it("ignores a blank or non-string principal", () => {
    expect(declaredApprover({ attributes: { approverChannel: "telegram", approverPrincipalId: "" } })).toBeUndefined();
    expect(declaredApprover({ attributes: { approverChannel: "telegram", approverPrincipalId: 7 } })).toBeUndefined();
  });

  it("ignores missing attributes, null, and non-objects without throwing", () => {
    expect(declaredApprover({ attributes: {} })).toBeUndefined();
    expect(declaredApprover({})).toBeUndefined();
    expect(declaredApprover(null)).toBeUndefined();
    expect(declaredApprover("nope")).toBeUndefined();
  });

  it("still carries the lane, so conversation-log attribution is unaffected", () => {
    expect(telegramPushAttributes("evening-brief", TELEGRAM_BENDIK).lane).toBe("evening-brief");
  });
});
