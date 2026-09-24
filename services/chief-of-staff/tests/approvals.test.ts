import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { assertApprover, UnauthorizedApproverError } from "../lib/approvals.js";
import {
  allowedPrincipalIds,
  channelForAuthenticator,
  isAllowedPrincipal,
  isAllowedPrincipalId,
  principalFromAuth,
} from "../lib/principals.js";

/**
 * Task 3 — the approver re-check, extracted from `echo_note.ts` (Task 9) and widened from
 * Slack-only to two channels. `tests/gate.test.ts` keeps proving the Slack-specific,
 * echo_note-integrated path unmodified; this file proves the shared plumbing directly,
 * including the scenario that only exists once a second channel does: a principal id
 * carried across channels must never be honoured.
 */

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

describe("assertApprover", () => {
  it("passes for Slack's allowed pair", () => {
    expect(() => assertApprover({ authenticator: "slack-webhook", userId: SLACK_BENDIK })).not.toThrow();
  });

  it("passes for Telegram's allowed pair", () => {
    expect(() =>
      assertApprover({ authenticator: "telegram-webhook", userId: TELEGRAM_BENDIK }),
    ).not.toThrow();
  });

  it("throws for the wrong Slack user", () => {
    expect(() => assertApprover({ authenticator: "slack-webhook", userId: "U0BADBADBAD" })).toThrow(
      UnauthorizedApproverError,
    );
  });

  it("throws for the wrong Telegram user", () => {
    expect(() => assertApprover({ authenticator: "telegram-webhook", userId: "000000" })).toThrow(
      UnauthorizedApproverError,
    );
  });

  it("throws for an unrecognised authenticator, even with an otherwise-valid userId", () => {
    expect(() => assertApprover({ authenticator: "http-basic", userId: SLACK_BENDIK })).toThrow(
      UnauthorizedApproverError,
    );
  });

  it("throws when the userId is missing", () => {
    expect(() => assertApprover({ authenticator: "slack-webhook" })).toThrow(UnauthorizedApproverError);
  });

  it("throws when the approval object is entirely empty (unauthenticated session)", () => {
    expect(() => assertApprover({})).toThrow(UnauthorizedApproverError);
  });

  describe("cross-channel id carry", () => {
    it("refuses a Telegram-allowed id presented with the Slack authenticator", () => {
      expect(() =>
        assertApprover({ authenticator: "slack-webhook", userId: TELEGRAM_BENDIK }),
      ).toThrow(UnauthorizedApproverError);
    });

    it("refuses a Slack-allowed id presented with the Telegram authenticator", () => {
      expect(() =>
        assertApprover({ authenticator: "telegram-webhook", userId: SLACK_BENDIK }),
      ).toThrow(UnauthorizedApproverError);
    });

    it("checks even an identical raw id against the presented channel only", () => {
      // Same literal id valid on BOTH channels — proves the check is channel-scoped, not
      // just "is this id on some allowlist somewhere".
      process.env["SLACK_ALLOWED_USER_IDS"] = "999";
      process.env["TELEGRAM_PRINCIPAL_ID"] = "999";
      expect(() => assertApprover({ authenticator: "slack-webhook", userId: "999" })).not.toThrow();
      expect(() => assertApprover({ authenticator: "telegram-webhook", userId: "999" })).not.toThrow();
      // An authenticator that names neither channel still refuses it.
      expect(() => assertApprover({ authenticator: "http-basic", userId: "999" })).toThrow(
        UnauthorizedApproverError,
      );
    });
  });

  describe("fail-closed allowlists", () => {
    it("throws for every principal when both allowlists are unset", () => {
      delete process.env["SLACK_ALLOWED_USER_IDS"];
      delete process.env["TELEGRAM_PRINCIPAL_ID"];
      expect(() => assertApprover({ authenticator: "slack-webhook", userId: SLACK_BENDIK })).toThrow(
        UnauthorizedApproverError,
      );
      expect(() =>
        assertApprover({ authenticator: "telegram-webhook", userId: TELEGRAM_BENDIK }),
      ).toThrow(UnauthorizedApproverError);
    });

    it("throws when an allowlist is set but blank", () => {
      process.env["TELEGRAM_PRINCIPAL_ID"] = "   ";
      expect(() =>
        assertApprover({ authenticator: "telegram-webhook", userId: TELEGRAM_BENDIK }),
      ).toThrow(UnauthorizedApproverError);
    });

    it("never admits an empty id, however the list is punctuated", () => {
      process.env["SLACK_ALLOWED_USER_IDS"] = ",,";
      expect(() => assertApprover({ authenticator: "slack-webhook", userId: "" })).toThrow(
        UnauthorizedApproverError,
      );
    });
  });

  it("names the approver and the channel, without leaking anything else", () => {
    let thrown: unknown;
    try {
      assertApprover({ authenticator: "slack-webhook", userId: "U0BADBADBAD" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnauthorizedApproverError);
    expect((thrown as Error).message).toContain("U0BADBADBAD");
    expect((thrown as Error).message).toContain("slack-webhook");
  });

  it("accepts an explicit env override instead of process.env", () => {
    const env = { TELEGRAM_PRINCIPAL_ID: "42" } as NodeJS.ProcessEnv;
    expect(() => assertApprover({ authenticator: "telegram-webhook", userId: "42" }, env)).not.toThrow();
    // process.env's TELEGRAM_PRINCIPAL_ID (set in beforeEach) must not leak into this call.
    expect(() =>
      assertApprover({ authenticator: "telegram-webhook", userId: TELEGRAM_BENDIK }, env),
    ).toThrow(UnauthorizedApproverError);
  });
});

describe("lib/principals.ts", () => {
  it("allowedPrincipalIds fails closed when unset or blank, per channel", () => {
    delete process.env["SLACK_ALLOWED_USER_IDS"];
    expect(allowedPrincipalIds("slack")).toEqual([]);
    process.env["TELEGRAM_PRINCIPAL_ID"] = "  ";
    expect(allowedPrincipalIds("telegram")).toEqual([]);
  });

  it("allowedPrincipalIds reads a comma-separated list and trims whitespace", () => {
    process.env["SLACK_ALLOWED_USER_IDS"] = ` ${SLACK_BENDIK} , U2 `;
    expect(allowedPrincipalIds("slack")).toEqual([SLACK_BENDIK, "U2"]);
  });

  it("isAllowedPrincipalId never admits an empty id", () => {
    process.env["TELEGRAM_PRINCIPAL_ID"] = ",,";
    expect(isAllowedPrincipalId("telegram", "")).toBe(false);
    expect(isAllowedPrincipalId("telegram", undefined)).toBe(false);
  });

  it("channelForAuthenticator maps eve's real authenticator strings and nothing else", () => {
    expect(channelForAuthenticator("slack-webhook")).toBe("slack");
    expect(channelForAuthenticator("telegram-webhook")).toBe("telegram");
    expect(channelForAuthenticator("http-basic")).toBeUndefined();
    expect(channelForAuthenticator(undefined)).toBeUndefined();
  });

  it("principalFromAuth extracts and stringifies Telegram's numeric user_id", () => {
    // eve's real defaultTelegramAuth shape (dist/src/public/channels/telegram/defaults.js):
    // attributes.user_id is the Telegram user id as a NUMBER, not a string.
    const auth = {
      attributes: { chat_id: 555, chat_type: "private", user_id: 123456789 },
      authenticator: "telegram-webhook",
      principalId: "telegram:123456789",
      principalType: "user",
    };
    expect(principalFromAuth(auth)).toEqual({ authenticator: "telegram-webhook", userId: "123456789" });
  });

  it("principalFromAuth extracts Slack's already-string user_id unchanged", () => {
    const auth = {
      attributes: { user_id: SLACK_BENDIK, channel_id: "D123" },
      authenticator: "slack-webhook",
    };
    expect(principalFromAuth(auth)).toEqual({ authenticator: "slack-webhook", userId: SLACK_BENDIK });
  });

  it("principalFromAuth marks a MISSING auth context as absent; present-but-garbage stays unmarked", () => {
    // absent:true is the Telegram HITL shape (auth:null on button taps — see principals.ts);
    // a PRESENT but unrecognisable context must never earn the marker.
    expect(principalFromAuth(null)).toEqual({ absent: true });
    expect(principalFromAuth(undefined)).toEqual({ absent: true });
    expect(principalFromAuth("not an object")).toEqual({});
    expect(principalFromAuth({})).toEqual({ authenticator: undefined, userId: undefined });
  });

  it("isAllowedPrincipal is false for an unrecognised authenticator even with a matching id", () => {
    expect(isAllowedPrincipal("http-basic", SLACK_BENDIK)).toBe(false);
  });
});
