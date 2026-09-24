import { describe, it, expect, vi } from "vitest";

// Stubbed so the execute() tests below never touch a real Google client — they exist to
// prove WHO is allowed to run, not to re-prove gmail.send's own request shape (tests/
// tools-gmail.test.ts already owns that).
const sendMock = vi.fn(async () => ({ gmailMessageId: "m1", gmailThreadId: "t1", sentAt: "2026-08-24T00:00:00.000Z" }));
vi.mock("../lib/google.js", () => ({
  googleClients: () => ({ gmail: async () => ({ send: sendMock }) }),
}));

import meetingFollowupSend, { followupApproval } from "../catalogue/meeting_followup_send.js";
import { UnauthorizedApproverError } from "../lib/approvals.js";
import { fingerprintRecipients } from "../lib/meeting-followup-store.js";

const RECIPIENTS = ["sam@example.com", "taylor@example.com"];

/** A policy wired to fixed answers, so each case states exactly one fact. */
function policy(opts: { level?: "autonomous" | "gated" | "never"; lastFingerprint?: string | null }) {
  return followupApproval({
    level: async () => opts.level ?? "gated",
    lastFingerprint: async () => opts.lastFingerprint ?? null,
  });
}

describe("followupApproval (ORB-156)", () => {
  it("asks a human when the series has not been opted in", async () => {
    const decide = policy({ level: "gated" });
    expect(await decide({ toolInput: { seriesKey: "s1", to: RECIPIENTS } } as never))
      .toBe("user-approval");
  });

  it("asks a human for a one-off meeting, whatever the capability default says", async () => {
    // A meeting with no recurrence id can never be opted in, because there is nothing to
    // opt in. It must not inherit a capability-wide 'autonomous' default by accident.
    const decide = policy({ level: "autonomous" });
    expect(await decide({ toolInput: { seriesKey: "", to: RECIPIENTS } } as never))
      .toBe("user-approval");
  });

  it("asks a human for a derived series' first occurrence even if its key is opted in", async () => {
    const decide = policy({ level: "autonomous" });
    expect(await decide({
      toolInput: { seriesKey: "title:folkepuls sync:mon", to: RECIPIENTS, forceApproval: true },
    } as never)).toBe("user-approval");
  });

  it("sends without asking once the series is opted in and the recipients match", async () => {
    const decide = policy({
      level: "autonomous",
      lastFingerprint: fingerprintRecipients(RECIPIENTS),
    });
    expect(await decide({ toolInput: { seriesKey: "s1", to: RECIPIENTS } } as never))
      .toBe("approved");
  });

  it("sends without asking on the FIRST autonomous send, which has no previous recipients", async () => {
    const decide = policy({ level: "autonomous", lastFingerprint: null });
    expect(await decide({ toolInput: { seriesKey: "s1", to: RECIPIENTS } } as never))
      .toBe("approved");
  });

  it("pauses and asks once when an opted-in series gains a recipient", async () => {
    // The safety valve. The opt-in survives — this returns user-approval, not a denial and
    // not a revoke — because the risk in an autonomous send is WHO receives it.
    const decide = policy({
      level: "autonomous",
      lastFingerprint: fingerprintRecipients(RECIPIENTS),
    });
    expect(await decide({
      toolInput: { seriesKey: "s1", to: [...RECIPIENTS, "newperson@external.example"] },
    } as never)).toBe("user-approval");
  });

  it("does not fire on a reordered or recased recipient list", async () => {
    const decide = policy({
      level: "autonomous",
      lastFingerprint: fingerprintRecipients(RECIPIENTS),
    });
    expect(await decide({
      toolInput: { seriesKey: "s1", to: ["TAYLOR@EXAMPLE.COM", "sam@example.com"] },
    } as never)).toBe("approved");
  });

  it("refuses outright when a series is set to never", async () => {
    const decide = policy({ level: "never" });
    const result = await decide({ toolInput: { seriesKey: "s1", to: RECIPIENTS } } as never);
    expect(result).toMatchObject({ type: "denied" });
  });

  it("asks a human when the ratchet cannot be read", async () => {
    // Fail closed. A database blip must never be the reason an email goes out unreviewed.
    const decide = followupApproval({
      level: async () => { throw new Error("db unreachable"); },
      lastFingerprint: async () => null,
    });
    expect(await decide({ toolInput: { seriesKey: "s1", to: RECIPIENTS } } as never))
      .toBe("user-approval");
  });

  it("asks a human when toolInput is missing entirely", async () => {
    // eve documents toolInput as possibly undefined; a policy that throws here would take
    // the whole approval card down with it.
    const decide = policy({ level: "autonomous" });
    expect(await decide({} as never)).toBe("user-approval");
  });

  it("finding 4: keeps a series gated forever when a recipient is a group/alias address, even fully opted in", async () => {
    // Spec Q4: an alias hides who actually receives the mail, so the series must stay
    // gated no matter what the ratchet or the recipient-fingerprint history says. Checked
    // BEFORE the ratchet — a matching fingerprint on an otherwise-autonomous series must not
    // be able to override it.
    const decide = policy({
      level: "autonomous",
      lastFingerprint: fingerprintRecipients(["sam@example.com", "post@company.no"]),
    });
    expect(await decide({
      toolInput: { seriesKey: "s1", to: ["sam@example.com", "post@company.no"] },
    } as never)).toBe("user-approval");
  });

  it("finding 4: an ordinary personal-address list is unaffected — still approves autonomously", async () => {
    const decide = policy({
      level: "autonomous",
      lastFingerprint: fingerprintRecipients(RECIPIENTS),
    });
    expect(await decide({ toolInput: { seriesKey: "s1", to: RECIPIENTS } } as never))
      .toBe("approved");
  });
});

describe("meeting_followup_send default export — the approval gate is actually attached (ORB-156 review)", () => {
  it("carries an approval policy — deleting the `approval:` line would make every follow-up send unconditional and leave the suite green", async () => {
    // Every case above proves followupApproval decides correctly IN ISOLATION, injected with
    // fixed deps. None of them proves the exported tool's `approval:` field is wired to it at
    // all. gmail_send.ts already carries always(), so agent-declaration.test.ts's aggregate
    // "every write-with-confirm capability has at least one gated tool" check passes on
    // `gmail` regardless of what THIS tool does — deleting `approval:` here would make every
    // follow-up send fire unconditionally and the full suite would stay 1071/1071 green. Go
    // through the DEFAULT EXPORT and its live KitRatchet/lastRecipientsFingerprint wiring, not
    // the injected-deps helper, so this is a test of the wiring, not the function. The
    // empty-series-key input short-circuits to "user-approval" before either one touches
    // Postgres, so no database is needed here.
    const approval = meetingFollowupSend.approval;
    expect(approval).toBeDefined();
    const decision = await approval!({ toolInput: { seriesKey: "", to: RECIPIENTS } } as never);
    expect(decision).toBe("user-approval");
  });
});

// eve's own documented shape for a schedule-dispatched turn (node_modules/eve/docs/tools/
// human-in-the-loop.md, "Skipping approval for schedule-dispatched turns" — match all three
// fields).
const APP_PRINCIPAL = { authenticator: "app", principalId: "eve:app", principalType: "runtime" };

const INPUT = {
  notionPageId: "page1",
  seriesKey: "s1",
  to: RECIPIENTS,
  subject: "Follow-up: sync",
  bodyText: "Notes...",
  meetingTitle: "Weekly sync",
  meetingWhen: "2026-08-24T09:00:00.000Z",
  from: "owner@owner.example",
};

function ctxWithAuth(current: unknown, initiator: unknown = current) {
  return { session: { id: "s1", auth: { current, initiator } } } as never;
}

describe("meeting_followup_send execute() — the app-principal exemption (ORB-156 review)", () => {
  it("the app principal — the ONLY dispatcher an autonomous send ever has — is not asked to re-prove itself", async () => {
    // This is the review finding: the brief's original `principal.absent !== true` check never
    // fires for a real autonomous dispatch, because eve's schedule dispatcher sets `current` to
    // the app principal, not to null — approverFrom would return it unchanged at its FIRST
    // branch, and assertApprover refuses "app" like any other unrecognised identity. Match all
    // three fields eve stamps itself, and this is the one shape that must sail through.
    sendMock.mockClear();
    const result = await meetingFollowupSend.execute(INPUT, ctxWithAuth(APP_PRINCIPAL, APP_PRINCIPAL));
    expect(result).toEqual({ gmailMessageId: "m1", gmailThreadId: "t1", sentAt: "2026-08-24T00:00:00.000Z" });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("a fully-absent auth still refuses — the exemption did not become a general absence bypass", async () => {
    // The whole reason the exemption is an EXACT three-field match and not "current is not
    // null" or "principal.absent is not true": those looser checks both let this exact shape
    // through, which is precisely the in-band bypass the 2026-08-16 security review refused.
    sendMock.mockClear();
    await expect(meetingFollowupSend.execute(INPUT, ctxWithAuth(null, null))).rejects.toThrow(UnauthorizedApproverError);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
