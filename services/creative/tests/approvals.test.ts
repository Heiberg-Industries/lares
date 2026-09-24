/**
 * The approval plumbing — `lib/principals.ts` + `lib/approvals.ts` — proven directly.
 *
 * This is the module that decides who may authorise a studio run or an Atlas commit, and it
 * exists per-agent precisely BECAUSE it is a least-privilege boundary that differs between
 * agents (the kit's own docblocks say so). A per-agent copy with no per-agent test is the
 * worst of both: the divergence is real and nothing checks it. So the cases below are chosen
 * for what is different about Calliope — one channel, one approver, no schedules — not merely
 * copied from eve-saga's file.
 *
 * `tests/atlas-tools.test.ts` proves the same guarantee one level up, through a real gated
 * tool's `execute`. This file proves the primitives.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { approverFrom, assertApprover, UnauthorizedApproverError } from "../lib/approvals.js";
import {
  allowedPrincipalIds,
  channelForAuthenticator,
  isAllowedPrincipal,
  isAllowedSlackUserId,
  principalFromAuth,
} from "../lib/principals.js";
import { allowedSlackUserIds, slackUserIdOf } from "../lib/slack-allowlist.js";

const SLACK_BENDIK = "U_EXAMPLE_OWNER";
const SLACK_AUTH = "slack-webhook";

beforeEach(() => {
  process.env["SLACK_ALLOWED_USER_IDS"] = SLACK_BENDIK;
});

afterEach(() => {
  delete process.env["SLACK_ALLOWED_USER_IDS"];
});

describe("assertApprover", () => {
  it("passes for the allowed Slack pair", () => {
    expect(() => assertApprover({ authenticator: SLACK_AUTH, userId: SLACK_BENDIK })).not.toThrow();
  });

  it("throws for a different Slack user in the same workspace", () => {
    // The case the whole re-check exists for: eve's HITL buttons are handled before
    // `onInteraction`, so any workspace member who can see the card can click it.
    expect(() => assertApprover({ authenticator: SLACK_AUTH, userId: "U0BADBADBAD" })).toThrow(
      UnauthorizedApproverError,
    );
  });

  it("throws for an unrecognised authenticator, even with an otherwise-valid userId", () => {
    // An operator who got in through some other route (HTTP Basic, a future channel) can start
    // a session, but a studio run or an Atlas commit wants a named, channel-verified human.
    expect(() => assertApprover({ authenticator: "http-basic", userId: SLACK_BENDIK })).toThrow(
      UnauthorizedApproverError,
    );
    // Specifically including the Telegram authenticator this agent does NOT front. Carrying
    // Bendik's id over from another agent's channel must not work: dropping Telegram from
    // `principals.ts` narrowed the surface, and this pins that it narrowed rather than widened.
    expect(() => assertApprover({ authenticator: "telegram-webhook", userId: SLACK_BENDIK })).toThrow(
      UnauthorizedApproverError,
    );
  });

  it("throws when the userId is missing, and when the approval object is entirely empty", () => {
    expect(() => assertApprover({ authenticator: SLACK_AUTH })).toThrow(UnauthorizedApproverError);
    expect(() => assertApprover({})).toThrow(UnauthorizedApproverError);
  });

  it("throws on an ABSENT auth context rather than exempting it", () => {
    // `absent` is the marker `approverFrom` consumes; `assertApprover` must never treat it as
    // a pass, or every future null-auth path inherits an in-band bypass.
    expect(() => assertApprover({ absent: true })).toThrow(UnauthorizedApproverError);
  });

  it("names what it saw in the refusal, so a gate refusal is not mistaken for a write failure", () => {
    expect(() => assertApprover({ authenticator: SLACK_AUTH, userId: "U0BADBADBAD" })).toThrow(
      /slack-webhook:U0BADBADBAD/u,
    );
    expect(() => assertApprover({})).toThrow(/an unidentified principal/u);
  });
});

describe("fail-closed allowlist", () => {
  it("admits NOBODY when SLACK_ALLOWED_USER_IDS is unset or blank", () => {
    // The single most important property in this file. A misconfigured deploy must make
    // Calliope useless, never unguarded.
    for (const value of [undefined, "", "   ", ",", ",,"]) {
      const env: NodeJS.ProcessEnv = value === undefined ? {} : { SLACK_ALLOWED_USER_IDS: value };
      expect(allowedPrincipalIds("slack", env), `value ${JSON.stringify(value)}`).toEqual([]);
      expect(isAllowedPrincipal(SLACK_AUTH, SLACK_BENDIK, env)).toBe(false);
      expect(() => assertApprover({ authenticator: SLACK_AUTH, userId: SLACK_BENDIK }, env)).toThrow(
        UnauthorizedApproverError,
      );
    }
  });

  it("refuses an empty-string userId even against a list with empty entries", () => {
    const env = { SLACK_ALLOWED_USER_IDS: `,${SLACK_BENDIK},` };
    expect(isAllowedSlackUserId("", env)).toBe(false);
    expect(isAllowedSlackUserId(undefined, env)).toBe(false);
    expect(isAllowedSlackUserId(SLACK_BENDIK, env)).toBe(true);
  });

  it("trims whitespace around ids so a readable env var still matches", () => {
    const env = { SLACK_ALLOWED_USER_IDS: ` ${SLACK_BENDIK} , U2ND ` };
    expect(allowedSlackUserIds(env)).toEqual([SLACK_BENDIK, "U2ND"]);
    expect(isAllowedSlackUserId("U2ND", env)).toBe(true);
  });
});

describe("channelForAuthenticator — one channel, and nothing else resolves", () => {
  it("resolves only eve's Slack authenticator", () => {
    expect(channelForAuthenticator(SLACK_AUTH)).toBe("slack");
    // Verified against eve's bundled dist rather than guessed: a wrong literal here would make
    // every approval refuse, which is safe but silently breaks her only write path.
    for (const other of ["telegram-webhook", "http-basic", "", undefined]) {
      expect(channelForAuthenticator(other), String(other)).toBeUndefined();
    }
  });
});

describe("principalFromAuth — shaping a raw eve auth context", () => {
  it("marks a null/undefined context ABSENT, which is not the same as unrecognised", () => {
    expect(principalFromAuth(null)).toEqual({ absent: true });
    expect(principalFromAuth(undefined)).toEqual({ absent: true });
  });

  it("returns nothing usable for a present-but-unrecognisable context", () => {
    // Present and wrong must NOT become `absent`, or it would inherit the initiator fallback.
    expect(principalFromAuth("not an object")).toEqual({});
    expect(principalFromAuth(42)).toEqual({});
    expect(principalFromAuth({})).toEqual({ authenticator: undefined, userId: undefined });
    expect(principalFromAuth({ authenticator: SLACK_AUTH, attributes: {} })).toEqual({
      authenticator: SLACK_AUTH,
      userId: undefined,
    });
  });

  it("reads the Slack user id out of attributes, stringifying a numeric one", () => {
    expect(principalFromAuth({ authenticator: SLACK_AUTH, attributes: { user_id: SLACK_BENDIK } })).toEqual({
      authenticator: SLACK_AUTH,
      userId: SLACK_BENDIK,
    });
    // Slack's is always a string; the numeric branch is one clause of insurance against a
    // future eve version or a second channel handing over a number instead of crashing.
    expect(principalFromAuth({ authenticator: SLACK_AUTH, attributes: { user_id: 123456789 } }).userId).toBe(
      "123456789",
    );
  });

  it("slackUserIdOf returns an id only for the Slack authenticator", () => {
    expect(slackUserIdOf({ authenticator: SLACK_AUTH, attributes: { user_id: SLACK_BENDIK } })).toBe(SLACK_BENDIK);
    expect(slackUserIdOf({ authenticator: "telegram-webhook", attributes: { user_id: SLACK_BENDIK } })).toBeUndefined();
  });
});

describe("approverFrom — which auth context wins", () => {
  it("prefers `current`, which on Slack is the person who clicked", () => {
    const auth = {
      current: { authenticator: SLACK_AUTH, attributes: { user_id: "U0SOMEONEELSE" } },
      initiator: { authenticator: SLACK_AUTH, attributes: { user_id: SLACK_BENDIK } },
    };
    // Deliberately asserting that the CLICKER is used, not the session opener — otherwise a
    // colleague could authorise a write inside a session Bendik happened to start.
    expect(approverFrom(auth).userId).toBe("U0SOMEONEELSE");
    expect(() => assertApprover(approverFrom(auth))).toThrow(UnauthorizedApproverError);
  });

  it("falls back to the verified INITIATOR only when `current` is absent", () => {
    const auth = {
      current: null,
      initiator: { authenticator: SLACK_AUTH, attributes: { user_id: SLACK_BENDIK } },
    };
    expect(approverFrom(auth)).toEqual({ authenticator: SLACK_AUTH, userId: SLACK_BENDIK });
    expect(() => assertApprover(approverFrom(auth))).not.toThrow();
  });

  it("does NOT fall back to an initiator who is not on the allowlist", () => {
    // The fallback is gated on the allowlist, not on the shape of the authenticator, so an app
    // or a stranger opening the session can never satisfy it by accident.
    const auth = {
      current: null,
      initiator: { authenticator: SLACK_AUTH, attributes: { user_id: "U0STRANGER" } },
    };
    expect(() => assertApprover(approverFrom(auth))).toThrow(UnauthorizedApproverError);
  });

  it("refuses a session with no auth at all", () => {
    for (const auth of [undefined, null, {}, { current: null, initiator: null }]) {
      expect(() => assertApprover(approverFrom(auth)), JSON.stringify(auth)).toThrow(UnauthorizedApproverError);
    }
  });

  it("has no declared-approver path — a schedule cannot authorise anything here", () => {
    // eve-saga carries `declaredApprover` (ORB-146) so a Telegram card in a schedule-opened
    // session can still be attributed. Calliope has no schedules and Slack populates
    // `auth.current` on the very path Telegram leaves null, so that fallback was dropped
    // rather than carried dead. This pins the consequence: attributes that would satisfy
    // eve-saga's declared-approver path do nothing here.
    const auth = {
      current: null,
      initiator: {
        authenticator: "app",
        attributes: { approverChannel: "slack", approverPrincipalId: SLACK_BENDIK },
      },
    };
    expect(() => assertApprover(approverFrom(auth))).toThrow(UnauthorizedApproverError);
  });
});
