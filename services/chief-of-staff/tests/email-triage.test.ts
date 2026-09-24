import { describe, it, expect, vi, beforeEach } from "vitest";
import { triageOneMessage, notifyTextFor, splitDraft, hasHumanReplyAfter, type EmailTriageDeps } from "../lib/email-triage.js";
import type { VoiceAccess } from "../lib/voice-store.js";
import type { GmailClient, MailMessage, ThreadMessage } from "../lib/google.js";
import { groundingClause, noCommitmentsClause } from "@lares/compose-contract";
import { detectProposedWindow } from "../lib/proposed-time.js";

vi.mock("../lib/llm-complete.js", () => ({ gatewayComplete: vi.fn() }));
vi.mock("../catalogue/twenty_lookup.js", () => ({ twentyLookup: vi.fn(async () => ({ people: [], companies: [] })) }));

import { gatewayComplete } from "../lib/llm-complete.js";
import { twentyLookup } from "../catalogue/twenty_lookup.js";

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "m1", threadId: "t1", from: "Prospect <p@example.com>", to: ["owner@project.example"],
    subject: "Question about pricing", bodyText: "Hi, what does this cost?", sentAt: "2026-08-16",
    messageId: "<orig@example.com>", references: "", isCalendarNotice: false, cc: [],
    ...overrides,
  };
}

function threadMessage(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "tm1", threadId: "t1", from: "them@x.com", to: ["owner@project.example"], subject: "s", bodyText: "b",
    sentAt: "2026-08-16T10:00:00Z", messageId: "<tm1@x.com>", references: "", isCalendarNotice: false, cc: [],
    headers: {},
    ...overrides,
  };
}

function fakeGmail(overrides: Partial<GmailClient> = {}): GmailClient {
  return {
    search: vi.fn(async () => []),
    searchThreadIds: vi.fn(async () => []),
    read: vi.fn(async () => null),
    readThread: vi.fn(async () => []),
    send: vi.fn(async () => ({ gmailMessageId: "sent1", gmailThreadId: "t1" })),
    draft: vi.fn(async () => ({ gmailDraftId: "d1", gmailMessageId: "dm1", gmailThreadId: "t1" })),
    getSignature: vi.fn(async () => ""),
    hasDraftForThread: vi.fn(async () => false),
    ...overrides,
  };
}

const noVoice: VoiceAccess = { getProfile: async () => null, retrieve: async () => [] };

beforeEach(() => {
  vi.mocked(gatewayComplete).mockReset();
  vi.mocked(twentyLookup).mockClear();
});

describe("triageOneMessage", () => {
  // 2026-09-08, Bendik: "she only adds one recipient on multi-recipient emails". The draft now
  // goes to everyone on the original — sender first, then the other To recipients, Cc kept —
  // minus the member's own addresses (deps.selfEmails; the account alone when not given).
  it("replies to everyone on the original, minus the member's own addresses", async () => {
    vi.mocked(gatewayComplete).mockResolvedValueOnce("needs_reply").mockResolvedValueOnce("Subject: Re: x\n\nHei alle");
    const gmail = fakeGmail();
    const result = await triageOneMessage(
      { gmail, voice: noVoice, selfEmails: ["owner@project.example", "owner@owner.example"] },
      "owner@project.example",
      message({
        from: "Stefan <stefan@example.com>",
        to: ["owner@project.example", "Kjetil <kjetil@example.com>"],
        cc: ["eli@example.no", "owner@owner.example"],
      }),
    );
    expect(gmail.draft).toHaveBeenCalledWith(expect.objectContaining({
      to: ["Stefan <stefan@example.com>", "Kjetil <kjetil@example.com>"],
      cc: ["eli@example.no"],
    }));
    // The drafted result carries the Gmail draft id and thread id so the schedule can remember
    // them (sql/034) — that is what lets "add Kjetil to the reply to Stefan" find the draft.
    expect(result).toMatchObject({ outcome: "drafted", draftId: "d1", threadId: "t1" });
  });

  it("a calendar notice is automated — never reaches classifySender or the model", async () => {
    const gmail = fakeGmail();
    const result = await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", message({ isCalendarNotice: true }));
    expect(result).toEqual({ outcome: "automated", reason: "calendar-notice", from: "Prospect <p@example.com>", subject: "Question about pricing" });
    expect(gatewayComplete).not.toHaveBeenCalled();
  });

  it("an automated sender is caught before any model call", async () => {
    const gmail = fakeGmail();
    const result = await triageOneMessage(
      { gmail, voice: noVoice }, "owner@project.example",
      message({ from: "no-reply@newsletter.com" }),
    );
    expect(result).toMatchObject({ outcome: "automated", reason: "automated-sender" });
    expect(gatewayComplete).not.toHaveBeenCalled();
  });

  it("the model classifying 'fyi' returns fyi, no draft", async () => {
    vi.mocked(gatewayComplete).mockResolvedValueOnce("fyi");
    const gmail = fakeGmail();
    const result = await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", message());
    expect(result).toEqual({ outcome: "fyi", from: "Prospect <p@example.com>", subject: "Question about pricing" });
    expect(gmail.draft).not.toHaveBeenCalled();
  });

  it("the model classifying 'automated' returns automated with reason 'model'", async () => {
    vi.mocked(gatewayComplete).mockResolvedValueOnce("automated");
    const gmail = fakeGmail();
    const result = await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", message());
    expect(result).toMatchObject({ outcome: "automated", reason: "model" });
  });

  it("an unparseable model response defaults to fyi, not needs_reply", async () => {
    vi.mocked(gatewayComplete).mockResolvedValueOnce("I'm not sure, maybe reply?");
    const gmail = fakeGmail();
    const result = await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", message());
    expect(result.outcome).toBe("fyi");
  });

  it("needs_reply with an existing draft on the thread advances as draft-pending, no new draft", async () => {
    vi.mocked(gatewayComplete).mockResolvedValueOnce("needs_reply");
    const gmail = fakeGmail({ hasDraftForThread: vi.fn(async () => true) });
    const result = await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", message());
    expect(result).toEqual({ outcome: "draft-pending", from: "Prospect <p@example.com>", subject: "Question about pricing", account: "owner@project.example" });
    expect(gmail.draft).not.toHaveBeenCalled();
  });

  it("needs_reply with no existing draft composes and creates one, with proper threading", async () => {
    vi.mocked(gatewayComplete)
      .mockResolvedValueOnce("needs_reply")
      .mockResolvedValueOnce("Subject: Re: Question about pricing\n\nHappy to help — it's $10/mo.");
    const gmail = fakeGmail();
    const result = await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", message());
    expect(result).toMatchObject({ outcome: "drafted", from: "Prospect <p@example.com>", subject: "Re: Question about pricing", account: "owner@project.example" });
    expect(gmail.draft).toHaveBeenCalledWith(expect.objectContaining({
      account: "owner@project.example", from: "owner@project.example", to: ["Prospect <p@example.com>"],
      subject: "Re: Question about pricing", bodyText: "Happy to help — it's $10/mo.",
      threadId: "t1", inReplyTo: "<orig@example.com>",
    }));
  });

  // ORB-176 — "still missing context" was undiagnosable: every context read fails soft through
  // tryOrNull, so an empty CRM record and an unreachable CRM looked identical in the draft. The
  // drafted result now carries a per-block status and one log line says the same, so a draft
  // Bendik judges thin can be traced to the block that was empty, failed, or never attempted.
  it("reports which context blocks were ok, empty, failed or skipped — a thin draft becomes diagnosable (ORB-176)", async () => {
    vi.mocked(gatewayComplete)
      .mockResolvedValueOnce("needs_reply")
      .mockResolvedValueOnce("Subject: Re: hi\n\nBody text.");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const gmail = fakeGmail();
    const result = await triageOneMessage(
      { gmail, voice: noVoice, dossier: async () => { throw new Error("dossier boom"); } },
      "owner@project.example",
      message(),
    );
    expect(result).toMatchObject({
      outcome: "drafted",
      context: {
        "CRM record": "empty", // the lookup answered, with nobody in it
        "Sent history (last 30 days)": "empty",
        Person: "failed", // the dossier read threw — not the same thing as an empty dossier
        Calendar: "skipped", // no proposed time, so never attempted
        "Voice profile": "empty",
        "Voice examples": "empty",
      },
    });
    expect((result as { context?: Record<string, string> }).context?.["Thread so far"]).toMatch(/^(ok|empty)$/);
    const line = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes("email-triage: context"));
    expect(line).toContain("Person=failed");
    expect(line).toContain("Calendar=skipped");
    expect(line).not.toContain("dossier boom"); // the reason is not the message text — one line, no stack
    info.mockRestore();
  });

  it("a voice-retrieval failure never blocks the draft", async () => {
    vi.mocked(gatewayComplete)
      .mockResolvedValueOnce("needs_reply")
      .mockResolvedValueOnce("Subject: Re: hi\n\nBody text.");
    const gmail = fakeGmail();
    const brokenVoice: VoiceAccess = {
      getProfile: async () => { throw new Error("gateway down"); },
      retrieve: async () => { throw new Error("gateway down"); },
    };
    const result = await triageOneMessage({ gmail, voice: brokenVoice }, "owner@project.example", message());
    expect(result.outcome).toBe("drafted");
  });

  it("a CRM lookup failure never blocks the draft", async () => {
    vi.mocked(twentyLookup).mockRejectedValueOnce(new Error("Twenty is down"));
    vi.mocked(gatewayComplete)
      .mockResolvedValueOnce("needs_reply")
      .mockResolvedValueOnce("Subject: Re: hi\n\nBody text.");
    const gmail = fakeGmail();
    const result = await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", message());
    expect(result.outcome).toBe("drafted");
  });

  // ORB-92 — twentyLookup(from) used to pass the raw "Name <email>" header straight through;
  // twentyLookup's own exact-match-on-@ path never matches a real stored email against that
  // whole string, so CRM grounding was silently empty in EVERY draft. Must be parsed first.
  it("looks up the CRM by the PARSED address, not the raw 'Name <email>' header", async () => {
    vi.mocked(gatewayComplete)
      .mockResolvedValueOnce("needs_reply")
      .mockResolvedValueOnce("Subject: Re: hi\n\nBody text.");
    const gmail = fakeGmail();
    await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", message({ from: "Prospect <p@example.com>" }));
    expect(twentyLookup).toHaveBeenCalledWith("p@example.com");
  });

  it("with a real signature, the draft prompt tells the model not to add its own sign-off", async () => {
    vi.mocked(gatewayComplete).mockImplementation(async (prompt: string) => {
      if (prompt.includes("Classify")) return "needs_reply";
      expect(prompt).toContain("Do NOT write any closing line or sign-off");
      return "Subject: Re: hi\n\nBody text.";
    });
    const gmail = fakeGmail({ getSignature: vi.fn(async () => "<p>Bendik</p>") });
    const result = await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", message());
    expect(result.outcome).toBe("drafted");
    expect(gmail.draft).toHaveBeenCalledWith(expect.objectContaining({ signatureHtml: "<p>Bendik</p>" }));
  });

  // ORB-94 REGRESSION PIN — email-triage.ts used to import a trimmed local fork of
  // compose-contract.ts that lacked the groundingClause toolResults option and
  // absentBlockClause entirely. Now both runtimes import @lares/compose-contract, so the
  // draft prompt must carry the exact canonical clause text — if a local fork ever creeps
  // back in with different wording, this test is the one that catches it.
  it("the draft prompt carries the canonical (unforked) grounding clause from @lares/compose-contract", async () => {
    vi.mocked(gatewayComplete).mockImplementation(async (prompt: string) => {
      if (prompt.includes("Classify")) return "needs_reply";
      expect(prompt).toContain(groundingClause());
      return "Subject: Re: hi\n\nBody text.";
    });
    const gmail = fakeGmail();
    const result = await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", message());
    expect(result.outcome).toBe("drafted");
  });

  // ORB-147 Task 3 — the Stefan case: on 2026-08-23 a live draft told a commercial counterpart
  // a meeting summary was "still coming" five days after it had actually been sent. The thread
  // (already in hand, no fetch) and the sent-history fetch (deps.gmail.search/read, 30d) both
  // carry the fact that the artefact already went out; noCommitments bans the model from
  // promising it again regardless.
  it("the Stefan case — a thread where the account already sent the artefact carries the thread and sent-history blocks, plus the no-commitments clause", async () => {
    vi.mocked(gatewayComplete).mockImplementation(async (prompt: string) => {
      if (prompt.includes("Classify")) return "needs_reply";
      expect(prompt).toContain("Sent the meeting summary over"); // from the thread block
      expect(prompt).toContain("Meeting summary attached"); // from the sent-history block
      expect(prompt).toContain(noCommitmentsClause());
      return "Subject: Re: Meeting recap\n\nThanks, Stefan!";
    });
    const gmail = fakeGmail({
      search: vi.fn(async () => ["sent1"]),
      read: vi.fn(async (id: string) =>
        id === "sent1"
          // A DIFFERENT thread from the current one ("t1") — an earlier, separate exchange
          // where the artefact went out. Distinct from the current-thread messages below on
          // purpose: proves the sent-history fetch is pulling in real OUT-of-thread history,
          // not just re-surfacing what the thread block already carries (ORB-147 review, Minor 2).
          ? {
              id: "sent1", threadId: "t0-earlier", from: "owner@project.example", to: ["stefan@rocket.example"],
              subject: "Meeting summary attached",
              bodyText: "Here's the meeting summary you asked about — let me know if anything's missing.",
              sentAt: "2026-08-19T09:00:00Z", messageId: "<sent1@project.example>", references: "", isCalendarNotice: false, cc: [],
            }
          : null,
      ),
    });
    const thread: ThreadMessage[] = [
      threadMessage({
        id: "m0", from: "Stefan <stefan@rocket.example>", sentAt: "2026-08-16T09:00:00Z",
        subject: "Meeting recap", bodyText: "Could you share the notes from our call?",
      }),
      threadMessage({
        id: "m2", from: "Bendik <owner@project.example>", sentAt: "2026-08-19T09:00:00Z",
        subject: "Re: Meeting recap", bodyText: "Sent the meeting summary over — let me know if anything's missing.",
      }),
    ];
    const msg = message({
      id: "m1", from: "Stefan <stefan@rocket.example>", subject: "Re: Meeting recap",
      bodyText: "Just checking on the notes from our call.",
    });
    const result = await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", msg, thread);
    expect(result.outcome).toBe("drafted");
  });

  // ORB-147 Task 3 — the collision case: an inbound message proposing a time must trigger a
  // free/busy check, and a busy block returned must reach the drafter.
  it("the collision case — a message proposing a time triggers freeBusy with the detected window, and the busy block reaches the prompt", async () => {
    const now = () => new Date("2026-08-24T08:00:00Z");
    const body = "Can we meet on 2026-09-03 at 14:00?";
    const expectedWindow = detectProposedWindow(body, now());
    expect(expectedWindow).not.toBeNull();

    const freeBusy = vi.fn(async () => [{ start: "2026-09-03T13:30:00.000Z", end: "2026-09-03T14:30:00.000Z" }]);
    vi.mocked(gatewayComplete).mockImplementation(async (prompt: string) => {
      if (prompt.includes("Classify")) return "needs_reply";
      expect(prompt).toContain("2026-09-03T13:30:00.000Z");
      expect(prompt).toContain("2026-09-03T14:30:00.000Z");
      return "Subject: Re: Meeting\n\nLet's find another time.";
    });
    const gmail = fakeGmail();
    const msg = message({ subject: "Meeting?", bodyText: body });
    const result = await triageOneMessage({ gmail, voice: noVoice, freeBusy, now }, "owner@project.example", msg);
    expect(result.outcome).toBe("drafted");
    expect(freeBusy).toHaveBeenCalledWith(expect.objectContaining({ timeMin: expectedWindow!.timeMin, timeMax: expectedWindow!.timeMax }));
  });

  it("the mirror — a message proposing no time never calls freeBusy at all", async () => {
    vi.mocked(gatewayComplete)
      .mockResolvedValueOnce("needs_reply")
      .mockResolvedValueOnce("Subject: Re: hi\n\nBody text.");
    const freeBusy = vi.fn(async () => []);
    const gmail = fakeGmail();
    const msg = message({ subject: "Question", bodyText: "What does this cost?" });
    const result = await triageOneMessage({ gmail, voice: noVoice, freeBusy, now: () => new Date("2026-08-24T08:00:00Z") }, "owner@project.example", msg);
    expect(result.outcome).toBe("drafted");
    expect(freeBusy).not.toHaveBeenCalled();
  });

  it("a dossier failure never blocks the draft", async () => {
    vi.mocked(gatewayComplete)
      .mockResolvedValueOnce("needs_reply")
      .mockResolvedValueOnce("Subject: Re: hi\n\nBody text.");
    const gmail = fakeGmail();
    const dossier = vi.fn(async () => { throw new Error("person.lookup down"); });
    const result = await triageOneMessage({ gmail, voice: noVoice, dossier }, "owner@project.example", message());
    expect(result.outcome).toBe("drafted");
  });

  // ORB-147 review, Minor 1: the failure case above proves dossier errors don't block the
  // draft, but nothing proved the HAPPY path actually reaches the prompt — including a
  // COULD NOT READ marker, which must survive verbatim (a gap in OUR reading is not an
  // absence in the world; see person/render.ts).
  it("dossier text reaches the prompt verbatim, including a COULD NOT READ marker", async () => {
    const dossierText = [
      "PERSON LOOKUP: Stefan Rocket — Rocket AS",
      "Last engagement: 2026-08-19 (mail).",
      "Sources consulted:",
      "- crm: read OK",
      "- pulse: COULD NOT READ (timeout)",
    ].join("\n");
    vi.mocked(gatewayComplete).mockImplementation(async (prompt: string) => {
      if (prompt.includes("Classify")) return "needs_reply";
      expect(prompt).toContain("PERSON LOOKUP: Stefan Rocket — Rocket AS");
      expect(prompt).toContain("COULD NOT READ (timeout)");
      return "Subject: Re: hi\n\nBody text.";
    });
    const gmail = fakeGmail();
    const dossier = vi.fn(async () => dossierText);
    const result = await triageOneMessage({ gmail, voice: noVoice, dossier }, "owner@project.example", message());
    expect(result.outcome).toBe("drafted");
  });

  // ORB-147 fix wave, Finding 1: the ## Person block must carry a `note` telling the model
  // this text is reference material written for a different assistant — never to be quoted
  // or to leak the CRM/sources/tool names into the reply. Pinned on the exact string that
  // reaches gatewayComplete, not on render.ts (out of scope for this fix — see its header).
  it("the Person block carries a note warning the model never to quote it or name the CRM/tools", async () => {
    vi.mocked(gatewayComplete).mockImplementation(async (prompt: string) => {
      if (prompt.includes("Classify")) return "needs_reply";
      expect(prompt).toContain(
        "## Person (internal notes written for a different assistant, not for this reply — " +
        "never quote it, and never name the CRM, its sources, or any tool to the counterpart; " +
        "take only the plain facts as background)",
      );
      return "Subject: Re: hi\n\nBody text.";
    });
    const gmail = fakeGmail();
    const dossier = vi.fn(async () => "PERSON LOOKUP: Someone — Somewhere");
    const result = await triageOneMessage({ gmail, voice: noVoice, dossier }, "owner@project.example", message());
    expect(result.outcome).toBe("drafted");
  });

  // ORB-147 fix wave, Finding 2: the ## Calendar block must (a) name the specific calendar
  // that was checked in the "no conflicts" text, via the new optional `calendarLabel` dep,
  // and (b) carry a `note` scoping the claim — one calendar of two accounts, only relevant
  // when a time was actually proposed, never volunteered.
  it("the Calendar block names the checked calendar in 'no conflicts' and carries the scoping note", async () => {
    const now = () => new Date("2026-08-24T08:00:00Z");
    const body = "Can we meet on 2026-09-03 at 14:00?";
    const freeBusy = vi.fn(async () => []);
    vi.mocked(gatewayComplete).mockImplementation(async (prompt: string) => {
      if (prompt.includes("Classify")) return "needs_reply";
      expect(prompt).toContain("Checked owner@owner.example's primary calendar for");
      expect(prompt).toContain("no conflicts");
      expect(prompt).toContain(
        "## Calendar (one calendar of two enrolled accounts, checked only because a time was " +
        "proposed — never volunteer availability nobody asked about)",
      );
      return "Subject: Re: Meeting\n\nWorks for me.";
    });
    const gmail = fakeGmail();
    const msg = message({ subject: "Meeting?", bodyText: body });
    const result = await triageOneMessage(
      { gmail, voice: noVoice, freeBusy, now, calendarLabel: "owner@owner.example's primary calendar" },
      "owner@project.example", msg,
    );
    expect(result.outcome).toBe("drafted");
  });

  // Mirror of the above: with no calendarLabel wired (every pre-existing test/caller), the
  // rendered text falls back to the old generic wording rather than breaking.
  it("with no calendarLabel dep, the Calendar block falls back to the old generic wording", async () => {
    const now = () => new Date("2026-08-24T08:00:00Z");
    const body = "Can we meet on 2026-09-03 at 14:00?";
    const freeBusy = vi.fn(async () => []);
    vi.mocked(gatewayComplete).mockImplementation(async (prompt: string) => {
      if (prompt.includes("Classify")) return "needs_reply";
      expect(prompt).toContain("Checked availability for");
      expect(prompt).toContain("no conflicts");
      return "Subject: Re: Meeting\n\nWorks for me.";
    });
    const gmail = fakeGmail();
    const msg = message({ subject: "Meeting?", bodyText: body });
    const result = await triageOneMessage({ gmail, voice: noVoice, freeBusy, now }, "owner@project.example", msg);
    expect(result.outcome).toBe("drafted");
  });

  it("a freeBusy failure never blocks the draft", async () => {
    vi.mocked(gatewayComplete)
      .mockResolvedValueOnce("needs_reply")
      .mockResolvedValueOnce("Subject: Re: hi\n\nBody text.");
    const gmail = fakeGmail();
    const freeBusy = vi.fn(async () => { throw new Error("calendar down"); });
    const msg = message({ subject: "Meeting?", bodyText: "Can we meet on 2026-09-03 at 14:00?" });
    const result = await triageOneMessage(
      { gmail, voice: noVoice, freeBusy, now: () => new Date("2026-08-24T08:00:00Z") },
      "owner@project.example", msg,
    );
    expect(result.outcome).toBe("drafted");
  });

  // ORB-147 review, Important finding: renderBusyBlock used to collapse a SUCCESSFUL read
  // that came back empty into the same "" as "never checked"/"failed" — the one fact this
  // fetch exists to establish (conflict vs. no conflict) only ever reached the prompt on the
  // conflict half. These two tests pin both halves of the fix.
  it("free/busy that succeeds with NO conflicts is a fact, not silence — 'no conflicts' reaches the prompt", async () => {
    const now = () => new Date("2026-08-24T08:00:00Z");
    const body = "Can we meet on 2026-09-03 at 14:00?";
    const freeBusy = vi.fn(async () => []);
    vi.mocked(gatewayComplete).mockImplementation(async (prompt: string) => {
      if (prompt.includes("Classify")) return "needs_reply";
      expect(prompt).toContain("no conflicts");
      return "Subject: Re: Meeting\n\nWorks for me.";
    });
    const gmail = fakeGmail();
    const msg = message({ subject: "Meeting?", bodyText: body });
    const result = await triageOneMessage({ gmail, voice: noVoice, freeBusy, now }, "owner@project.example", msg);
    expect(result.outcome).toBe("drafted");
  });

  it("free/busy that THROWS puts nothing in the prompt — not 'no conflicts', not silence claimed as fact", async () => {
    const now = () => new Date("2026-08-24T08:00:00Z");
    const body = "Can we meet on 2026-09-03 at 14:00?";
    const freeBusy = vi.fn(async () => { throw new Error("calendar down"); });
    vi.mocked(gatewayComplete).mockImplementation(async (prompt: string) => {
      if (prompt.includes("Classify")) return "needs_reply";
      expect(prompt).not.toContain("no conflicts");
      expect(prompt).not.toContain("Checked availability");
      return "Subject: Re: Meeting\n\nWorks for me.";
    });
    const gmail = fakeGmail();
    const msg = message({ subject: "Meeting?", bodyText: body });
    const result = await triageOneMessage({ gmail, voice: noVoice, freeBusy, now }, "owner@project.example", msg);
    expect(result.outcome).toBe("drafted");
  });

  // ORB-147 review, Minor 2: the sent-history query also matches the account's own messages
  // IN THE CURRENT THREAD, which the thread block already renders in full — filtered out so
  // the two blocks stay disjoint rather than duplicating content.
  it("sent-history results already in the current thread are filtered out — the thread block already carries them", async () => {
    vi.mocked(gatewayComplete).mockImplementation(async (prompt: string) => {
      if (prompt.includes("Classify")) return "needs_reply";
      expect(prompt).not.toContain("Sent history");
      return "Subject: Re: hi\n\nBody text.";
    });
    const gmail = fakeGmail({
      search: vi.fn(async () => ["same-thread-1"]),
      read: vi.fn(async (id: string) =>
        id === "same-thread-1"
          ? {
              id: "same-thread-1", threadId: "t1", from: "owner@project.example", to: ["p@example.com"],
              subject: "Old reply", bodyText: "Already covered in the thread.",
              sentAt: "2026-08-15T09:00:00Z", messageId: "<x@x>", references: "", isCalendarNotice: false, cc: [],
            }
          : null,
      ),
    });
    // message()'s default threadId is "t1" — matches the sent-history result above.
    const result = await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", message());
    expect(result.outcome).toBe("drafted");
  });

  // ORB-147 review, Controller ruling on Minor 3: the thread block is capped
  // (THREAD_BLOCK_MAX_CHARS) rather than rendered "in full" unconditionally — these two tests
  // cover both sides of the cap.
  it("under the cap, every thread message is rendered with no omitted marker", async () => {
    vi.mocked(gatewayComplete).mockImplementation(async (prompt: string) => {
      if (prompt.includes("Classify")) return "needs_reply";
      expect(prompt).toContain("FIRST-MESSAGE-MARKER");
      expect(prompt).toContain("SECOND-MESSAGE-MARKER");
      expect(prompt).not.toContain("earlier message(s) omitted");
      return "Subject: Re: hi\n\nBody text.";
    });
    const gmail = fakeGmail();
    const thread: ThreadMessage[] = [
      threadMessage({ id: "m0", sentAt: "2026-08-16T09:00:00Z", bodyText: "FIRST-MESSAGE-MARKER" }),
      threadMessage({ id: "m2", sentAt: "2026-08-17T09:00:00Z", bodyText: "SECOND-MESSAGE-MARKER" }),
    ];
    const result = await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", message(), thread);
    expect(result.outcome).toBe("drafted");
  });

  it("over the cap, the oldest message is dropped with an explicit omitted marker, newest kept", async () => {
    vi.mocked(gatewayComplete).mockImplementation(async (prompt: string) => {
      if (prompt.includes("Classify")) return "needs_reply";
      expect(prompt).toContain("NEWEST-MARKER");
      expect(prompt).toContain("MIDDLE-MARKER");
      expect(prompt).not.toContain("OLDEST-MARKER");
      expect(prompt).toContain("…1 earlier message(s) omitted");
      return "Subject: Re: hi\n\nBody text.";
    });
    const gmail = fakeGmail();
    // Thread message ids deliberately avoid "m1" — message()'s own default id — so none of
    // them is mistaken for "the message being replied to" and silently excluded.
    const thread: ThreadMessage[] = [
      threadMessage({ id: "t-oldest", sentAt: "2026-08-16T09:00:00Z", bodyText: `OLDEST-MARKER-${"x".repeat(4200)}` }),
      threadMessage({ id: "t-middle", sentAt: "2026-08-17T09:00:00Z", bodyText: `MIDDLE-MARKER-${"y".repeat(4000)}` }),
      threadMessage({ id: "t-newest", sentAt: "2026-08-18T09:00:00Z", bodyText: "NEWEST-MARKER" }),
    ];
    const result = await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", message(), thread);
    expect(result.outcome).toBe("drafted");
  });

  it("a sent-history search failure never blocks the draft", async () => {
    vi.mocked(gatewayComplete)
      .mockResolvedValueOnce("needs_reply")
      .mockResolvedValueOnce("Subject: Re: hi\n\nBody text.");
    const gmail = fakeGmail({ search: vi.fn(async () => { throw new Error("gmail search down"); }) });
    const result = await triageOneMessage({ gmail, voice: noVoice }, "owner@project.example", message());
    expect(result.outcome).toBe("drafted");
  });
});

describe("splitDraft", () => {
  it("splits a well-formed Subject/body completion", () => {
    expect(splitDraft("Subject: Hello\n\nBody here.")).toEqual({ subject: "Hello", body: "Body here." });
  });
  it("falls back to a placeholder subject when unparseable and no fallback subject is given", () => {
    expect(splitDraft("just some text")).toEqual({ subject: "(no subject)", body: "just some text" });
  });
  it("falls back to 'Re: <original>' when a fallback subject is given", () => {
    expect(splitDraft("just some text", "Question about pricing")).toEqual({
      subject: "Re: Question about pricing", body: "just some text",
    });
  });
  it("does not double up 'Re: Re:' when the original subject already has one", () => {
    expect(splitDraft("just some text", "Re: Question about pricing")).toEqual({
      subject: "Re: Question about pricing", body: "just some text",
    });
  });

  // ORB-92 — the old unanchored regex matched the FIRST "Subject:\n\n" anywhere in the
  // string. A draft that (despite instructions) echoes back the quoted original before its
  // own reply would have its real content discarded and the quoted subject used instead.
  it("does not lock onto a 'Subject:' line buried inside quoted/echoed content", () => {
    const draft =
      "Sure, here's context on what I'm replying to:\n\n" +
      "Original — From: p@example.com\nSubject: Old thread\n\nSome old quoted text.\n\n" +
      "Subject: My real reply\n\nHere's my actual answer.";
    // Unanchored, this used to match the quoted "Subject: Old thread" and lose everything
    // that came before it. Anchored to the start, this whole draft doesn't lead with
    // "Subject:" at all, so it falls to the fallback — keeping the FULL text as the body
    // rather than silently discarding the real reply.
    const result = splitDraft(draft, "Old thread");
    expect(result.subject).toBe("Re: Old thread");
    expect(result.body).toBe(draft);
  });
  it("still matches when the draft genuinely leads with Subject: even if the body quotes one later", () => {
    const draft = "Subject: My real reply\n\nHere's my answer.\n\nQuoted below:\nSubject: Old thread\n\nOld text.";
    expect(splitDraft(draft)).toEqual({
      subject: "My real reply",
      body: "Here's my answer.\n\nQuoted below:\nSubject: Old thread\n\nOld text.",
    });
  });
});

describe("hasHumanReplyAfter", () => {
  const gmailMessage = (overrides: Partial<import("../lib/google.js").ThreadMessage> = {}) => ({
    id: "m1", threadId: "t1", from: "them@x.com", to: ["owner@project.example"], subject: "s", bodyText: "b",
    sentAt: "2026-08-16T10:00:00Z", messageId: "<m1@x.com>", references: "", isCalendarNotice: false, cc: [],
    headers: {},
    ...overrides,
  });

  it("true when the account sent a message strictly after sentAfter", () => {
    const messages = [
      gmailMessage({ from: "them@x.com", sentAt: "2026-08-16T09:00:00Z" }),
      gmailMessage({ from: "Bendik <owner@project.example>", sentAt: "2026-08-16T11:00:00Z" }),
    ];
    expect(hasHumanReplyAfter(messages, "owner@project.example", "2026-08-16T09:00:00Z")).toBe(true);
  });

  it("false when the account's only message predates sentAfter", () => {
    const messages = [gmailMessage({ from: "owner@project.example", sentAt: "2026-08-16T08:00:00Z" })];
    expect(hasHumanReplyAfter(messages, "owner@project.example", "2026-08-16T09:00:00Z")).toBe(false);
  });

  it("false when only the counterpart replied, never the account", () => {
    const messages = [gmailMessage({ from: "them@x.com", sentAt: "2026-08-16T12:00:00Z" })];
    expect(hasHumanReplyAfter(messages, "owner@project.example", "2026-08-16T09:00:00Z")).toBe(false);
  });
});

describe("notifyTextFor", () => {
  it("returns a ping for 'drafted'", () => {
    const text = notifyTextFor({ outcome: "drafted", from: "a@b.com", subject: "Hi", account: "owner@project.example" });
    expect(text).toContain("Drafted a reply");
    expect(text).toContain("owner@project.example");
  });
  it("returns a distinct reminder for 'draft-pending'", () => {
    const text = notifyTextFor({ outcome: "draft-pending", from: "a@b.com", subject: "Hi", account: "owner@project.example" });
    expect(text).toContain("already pending");
  });
  it("returns null for fyi/automated — no ping", () => {
    expect(notifyTextFor({ outcome: "fyi", from: "a", subject: "s" })).toBeNull();
    expect(notifyTextFor({ outcome: "automated", reason: "model", from: "a", subject: "s" })).toBeNull();
  });
});
