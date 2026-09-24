import { describe, it, expect, afterEach } from "vitest";

import {
  summarizeApproval,
  coversApproval,
  detailsForApproval,
  registerApprovalSummary,
  DETAILS_MAX_LENGTH,
  shortenedNotice,
} from "../src/approval-summary.js";
import { inboxNotePath } from "../src/note-paths.js";

describe("summarizeApproval — what Bendik reads before authorising a write", () => {
  it("names the recipient and subject on a send, the two fields that decide safety", () => {
    expect(summarizeApproval("gmail_send", { to: ["jonas@finago.com"], subject: "Re: Orakel" }))
      .toBe('Send email to jonas@finago.com — "Re: Orakel"');
  });

  // 2026-09-08: changing who an existing draft goes to. Every address named, never counted —
  // the card is the moment to see exactly who is added to or dropped from a real email.
  it("names every address a recipients change adds or removes", () => {
    expect(summarizeApproval("gmail_draft_recipients", { draftId: "d1", add: ["Kjetil <kjetil@example.com>"], remove: ["eli@example.no"] }))
      .toBe("Change the draft's recipients — add Kjetil <kjetil@example.com>; remove eli@example.no");
    expect(summarizeApproval("gmail_draft_recipients", { threadId: "t1", add: ["a@x.no", "b@x.no"] }))
      .toBe("Change the draft's recipients — add a@x.no, b@x.no");
    expect(summarizeApproval("gmail_draft_recipients", { draftId: "d1" })).toBe("Change the draft's recipients");
  });

  it("counts extra recipients rather than hiding them", () => {
    expect(summarizeApproval("gmail_send", { to: ["a@x.com", "b@x.com", "c@x.com"], subject: "Hi" }))
      .toBe('Send email to a@x.com and 2 more — "Hi"');
  });

  it("shouts on destructive actions — a delete must not read like an update", () => {
    expect(summarizeApproval("agent-kit__vault_drop", { path: "inbox/note.md" })).toBe("DELETE Brain note inbox/note.md");
    expect(summarizeApproval("calendar_delete_event", { eventId: "evt_123" })).toBe("Calendar: DELETE event evt_123");
    expect(summarizeApproval("twenty_do_not_contact", { recordId: "r1", reason: "unsubscribed" }))
      .toBe('CRM: mark DO-NOT-CONTACT — "unsubscribed"');
  });

  // LAR-59-s4 — the delete-event card names the reason a stale booking is being removed, and
  // which calendar/account it lives on (LAR-59-s1's fields), so the owner sees WHY and WHERE
  // before he taps Approve. The pinned assertion two lines above this block (a bare `eventId`)
  // is the "byte-identical without one" acceptance case — it is not touched by this addition.
  describe("calendar_delete_event names the reason (LAR-59-s4)", () => {
    it("shows the reason, verbatim, with the honesty marker", () => {
      const reason = 'Cancellation mail from The Standard, 18 Aug 2026: "Your reservation has been cancelled".';
      expect(summarizeApproval("calendar_delete_event", { eventId: "e1", reason })).toBe(
        `Calendar: DELETE event e1 — reason given by the agent: "${reason}"`,
      );
    });

    it("a card with no reason is byte-identical to today's", () => {
      expect(summarizeApproval("calendar_delete_event", { eventId: "e1" })).toBe("Calendar: DELETE event e1");
      expect(summarizeApproval("calendar_delete_event", { eventId: "e1", notify: true }))
        .toBe("Calendar: DELETE event e1 (guests notified)");
    });

    it("a non-string reason is ignored", () => {
      expect(summarizeApproval("calendar_delete_event", { eventId: "e1", reason: 42 })).toBe("Calendar: DELETE event e1");
      expect(summarizeApproval("calendar_delete_event", { eventId: "e1", reason: { note: "x" } }))
        .toBe("Calendar: DELETE event e1");
      expect(summarizeApproval("calendar_delete_event", { eventId: "e1", reason: "" })).toBe("Calendar: DELETE event e1");
    });

    it("a 500-character reason is truncated to 160", () => {
      const long = "x".repeat(500);
      const result = summarizeApproval("calendar_delete_event", { eventId: "e1", reason: long });
      const clause = /reason given by the agent: "([^"]*)"/u.exec(result ?? "");
      expect(clause?.[1]).toHaveLength(160);
      expect(clause?.[1]?.endsWith("…")).toBe(true);
    });

    it("names which account/calendar the event lives on, additively", () => {
      expect(summarizeApproval("calendar_delete_event", { eventId: "e1", account: "second@example.invalid", calendarId: "vdn" }))
        .toBe("Calendar: DELETE event e1 on second@example.invalid (calendar vdn)");
    });
  });

  it("states side effects that reach other humans", () => {
    // `notify` is the difference between a private calendar edit and mail landing in
    // someone else's inbox. Dropping it for brevity would be the exact failure this
    // module exists to prevent.
    // Explicit offsets: a bare "2026-09-01T10:00" is parsed as HOST-local by JS, which would
    // make this suite pass or fail depending on the machine's timezone.
    expect(summarizeApproval("calendar_create_event", { summary: "Intro", start: "2026-09-01T10:00:00+02:00", attendees: ["a@x.com"], notify: true }))
      .toBe('Calendar: create "Intro" at Tuesday 2026-09-01 10:00 (Europe/Oslo) with a@x.com (guests notified)');
    expect(summarizeApproval("calendar_create_event", { summary: "Solo block", start: "2026-09-01T10:00:00+02:00" }))
      .toBe('Calendar: create "Solo block" at Tuesday 2026-09-01 10:00 (Europe/Oslo)');
  });

  it("surfaces a recurrence — one ping and a standing one are different asks", () => {
    // "tomorrow 09:00" is not a parseable date — it falls through unchanged rather than
    // rendering "Invalid Date".
    expect(summarizeApproval("remind_set", { message: "file VAT", dueAt: "tomorrow 09:00", recurrence: "monthly", door: "telegram" }))
      .toBe('Set reminder "file VAT" for tomorrow 09:00 repeating monthly via telegram');
  });

  it("renders the CRM writes distinctly, including the conditional one", () => {
    expect(summarizeApproval("twenty_comm_state", { recordId: "r1", state: "EMAIL_SENT" }))
      .toBe("CRM: set comm-state to EMAIL_SENT");
    expect(summarizeApproval("twenty_comm_state", { recordId: "r1", state: "REPLIED", expectedPrevious: "EMAIL_SENT" }))
      .toBe("CRM: set comm-state to REPLIED (only if currently EMAIL_SENT)");
    expect(summarizeApproval("notion_resolve_proposal", { id: "p_1", decision: "approve" }))
      .toBe("Notion proposal — APPROVE (p_1)");
  });

  describe("ORB-135 — eve-calliope's two gated tools", () => {
    it("names the title AND the derived path on an Atlas write", () => {
      // The tool takes a TITLE and derives the path (fix round 1). The card shows both: the
      // title is what Bendik recognises, the path is what says whether an existing _inbox note
      // is about to be replaced.
      expect(summarizeApproval("vault_write", { title: "Zero7 positioning", body: "…" }))
        .toBe('Write Atlas note "Zero7 positioning" → _inbox/zero7-positioning.md');
    });

    it("derives that path with the SAME function the tool writes with", () => {
      // Not a re-implementation: `approval-summary.ts` imports `inboxNotePath`. Asserted
      // against the shared function rather than against a hand-typed literal, because the
      // failure this guards is a card naming one file while the tool writes another.
      const title = "Vol de Nuit — launch angles!";
      expect(summarizeApproval("vault_write", { title })).toBe(
        `Write Atlas note ${'"'}${title}${'"'} → ${inboxNotePath(title)}`,
      );
    });

    it("still names a path for a title that looks like a traversal attempt", () => {
      // The card must not print `../../etc/passwd` and imply that is where the write lands.
      // It shows the real destination, which is inside _inbox and always was.
      expect(summarizeApproval("vault_write", { title: "../../etc/passwd", body: "…" }))
        .toBe('Write Atlas note "../../etc/passwd" → _inbox/etc-passwd.md');
    });

    it("shows the brief on a studio run — the field that decides whether ten model calls are wanted", () => {
      expect(summarizeApproval("studio_ideate", { brief: "launch angles for Vol de Nuit" }))
        .toBe('Run the studio on "launch angles for Vol de Nuit"');
    });

    it("truncates a long brief rather than flooding the card", () => {
      const summary = summarizeApproval("studio_ideate", { brief: "why ".repeat(80) })!;
      expect(summary.length).toBeLessThan(100);
      expect(summary).toContain("…");
    });

    it("truncates BOTH halves of an Atlas write, so a long title cannot flood the card", () => {
      // The path is derived FROM the title, so an untruncated path would smuggle the same long
      // string back onto the card a second time.
      const summary = summarizeApproval("vault_write", { title: "positioning ".repeat(20) })!;
      expect(summary.length).toBeLessThan(200);
      expect(summary.match(/…/gu)?.length).toBe(2);
    });

    it("falls through instead of rendering a bare label when the key field is missing", () => {
      // input is model-supplied and schema-validated only AFTER approval (invariant 1), so at
      // render time `path`/`brief` may be missing, null, or the wrong type.
      //
      // The assertion that matters is what these do NOT say. Written as a plain `line(...)`
      // call — the shape most formatters above use — a missing title renders the literal
      // "Write Atlas note": a card that looks finished, invites a tap, and states nothing
      // about what is being written. Falling through to generic() is the honest answer.
      expect(summarizeApproval("vault_write", {})).toBe("Approve tool call: vault_write");
      expect(summarizeApproval("vault_write", { body: "no title at all" }))
        .toBe("vault_write — body: no title at all");
      expect(summarizeApproval("studio_ideate", { brief: null })).toBe("Approve tool call: studio_ideate");
      // A non-string scalar is still informative, so `str()` keeps it rather than dropping it.
      expect(summarizeApproval("studio_ideate", { brief: 42 })).toBe('Run the studio on "42"');
    });
  });

  it("truncates a long field instead of flooding the card", () => {
    const summary = summarizeApproval("agent-kit__vault_write", { title: "x".repeat(200) })!;
    expect(summary.length).toBeLessThan(100);
    expect(summary).toContain("…");
  });

  describe("ORB-143 — renamed tools must resolve under their new agent-kit__ names", () => {
    // The failure mode ORB-144 exists to catch: a rename that misses this map does NOT
    // throw — it silently degrades to generic()'s "toolName — field: value" instead of the
    // hand-written line. Every Brain write formatter must be keyed on the MOUNTED name, and
    // the OLD bare name must no longer resolve to it.
    it("agent-kit__vault_write renders the specific title, not the generic fallback", () => {
      const summary = summarizeApproval("agent-kit__vault_write", { title: "Q3 positioning notes" });
      expect(summary).toBe('Write Brain note "Q3 positioning notes"');
      expect(summary).not.toContain("title:"); // generic()'s shape, must not appear
    });

    it("agent-kit__vault_file and agent-kit__vault_drop also resolve to their specific titles", () => {
      expect(summarizeApproval("agent-kit__vault_file", { path: "_inbox/x.md", destination: "writing-seeds" }))
        .toBe("Move Brain note _inbox/x.md → writing-seeds");
      expect(summarizeApproval("agent-kit__vault_drop", { path: "_inbox/x.md" })).toBe("DELETE Brain note _inbox/x.md");
    });

    it("the bare name of a mounted tool has no formatter — it falls through to generic()", () => {
      // Guards against exactly the silent-fallback failure this test block exists to catch:
      // if a future edit re-adds a "vault_file" (bare) key alongside the mounted one, this
      // starts failing loudly instead of the degradation staying invisible.
      //
      // `vault_file`, not `vault_write`: since W5C-s4 the bare `vault_write` IS a real tool of
      // its own (the creative role's shared-area write) with its own formatter, so it is no
      // longer an example of a name that must fall through.
      expect(summarizeApproval("vault_file", { path: "_inbox/x.md", destination: "writing-seeds" }))
        .toBe("vault_file — path: _inbox/x.md, destination: writing-seeds");
    });
  });

  describe("it must never throw, and never render an empty card", () => {
    // input is model-supplied and is schema-validated only AFTER approval, so at render
    // time any field may be missing, null, or the wrong type.
    it("falls back for an unknown tool by showing its fields", () => {
      expect(summarizeApproval("some_new_tool", { alpha: "one", beta: 2 })).toBe("some_new_tool — alpha: one, beta: 2");
    });

    it("returns eve's own wording when there is nothing useful to say", () => {
      expect(summarizeApproval("some_new_tool", {})).toBe("Approve tool call: some_new_tool");
    });

    it("survives wrong-typed, null and missing input without throwing", () => {
      expect(() => summarizeApproval("gmail_send", null)).not.toThrow();
      expect(() => summarizeApproval("gmail_send", "not an object")).not.toThrow();
      expect(() => summarizeApproval("gmail_send", { to: 42, subject: null })).not.toThrow();
      expect(() => summarizeApproval("agent-kit__vault_drop", undefined)).not.toThrow();
      expect(summarizeApproval(undefined, {})).toBeUndefined();
    });

    it("drops absent clauses rather than rendering empty quotes", () => {
      expect(summarizeApproval("gmail_send", { to: ["a@x.com"] })).toBe("Send email to a@x.com");
    });
  });
});

describe("dates on a card are for a human, not a machine", () => {
  // Live 2026-08-18: the card read `Set reminder "Test klokka" for
  // 2026-08-19T09:00:00+02:00 via slack`. The DATE was correct — but an ISO timecode is
  // exactly the raw-JSON illegibility this whole feature exists to remove, and Bendik read
  // it as the date bug returning. Saga's own confirmation line right below it already said
  // "onsdag 2026-08-19 kl 09:00 (Europe/Oslo)". The card must not be the least readable
  // thing in the thread.
  it("renders a reminder's dueAt as a weekday and time, not an ISO string", () => {
    const summary = summarizeApproval("remind_set", {
      message: "Test klokka", dueAt: "2026-08-19T09:00:00+02:00", door: "slack",
    });
    expect(summary).toBe('Set reminder "Test klokka" for Wednesday 2026-08-19 09:00 (Europe/Oslo) via slack');
    expect(summary).not.toContain("T09:00:00");
  });

  it("renders calendar start times the same way", () => {
    expect(summarizeApproval("calendar_create_event", { summary: "Intro", start: "2026-09-01T10:00:00+02:00" }))
      .toBe('Calendar: create "Intro" at Tuesday 2026-09-01 10:00 (Europe/Oslo)');
  });

  it("converts a non-Oslo offset into Oslo, since that is the clock Bendik reads", () => {
    // 08:00 UTC is 10:00 in Oslo (CEST). Showing "08:00" would be true and useless.
    expect(summarizeApproval("remind_set", { message: "x", dueAt: "2026-09-01T08:00:00Z" }))
      .toContain("Tuesday 2026-09-01 10:00 (Europe/Oslo)");
  });

  it("falls back to the raw value when it is not a date — never renders 'Invalid Date'", () => {
    const summary = summarizeApproval("remind_set", { message: "x", dueAt: "sometime next week" });
    expect(summary).toContain("sometime next week");
    expect(summary).not.toMatch(/Invalid/i);
  });

  // ORB-193 final review. The card's clock is a PARAMETER: on a New York trip the turn's own clock
  // block says New York, and a card still saying Europe/Oslo describes the same instant on a second
  // clock inside one exchange. eve-saga passes `ownerTzSync()`; the default stays the home clock.
  it("renders on the OWNER's clock when one is passed, naming that zone", () => {
    expect(summarizeApproval("remind_set", { message: "x", dueAt: "2026-09-01T08:00:00Z" }, "America/New_York"))
      .toContain("Tuesday 2026-09-01 04:00 (America/New_York)");
    expect(summarizeApproval("calendar_create_event", { summary: "Intro", start: "2026-09-01T10:00:00+02:00" }, "America/New_York"))
      .toBe('Calendar: create "Intro" at Tuesday 2026-09-01 04:00 (America/New_York)');
    expect(summarizeApproval("meeting_followup_send", {
      meetingTitle: "Folkepuls", meetingWhen: "2026-09-01T10:00:00+02:00", to: ["a@x.no"],
    }, "America/New_York")).toContain("Tuesday 2026-09-01 04:00 (America/New_York)");
  });

  it("falls back to the home clock when no zone is passed", () => {
    expect(summarizeApproval("remind_set", { message: "x", dueAt: "2026-09-01T08:00:00Z" }))
      .toContain("(Europe/Oslo)");
  });
});

describe("registerApprovalSummary — the owner clock reaches the global eve reads", () => {
  const saved = {
    summary: globalThis.__eveApprovalSummary,
    covers: globalThis.__eveApprovalCovers,
    details: globalThis.__eveApprovalDetails,
  };
  afterEach(() => {
    globalThis.__eveApprovalSummary = saved.summary;
    globalThis.__eveApprovalCovers = saved.covers;
    globalThis.__eveApprovalDetails = saved.details;
  });

  it("calls the injected tz reader on every card, so a trip that starts mid-session is picked up", () => {
    let zone = "Europe/Oslo";
    registerApprovalSummary({ tz: () => zone });
    const card = () => globalThis.__eveApprovalSummary!("remind_set", { message: "x", dueAt: "2026-09-01T08:00:00Z" });
    expect(card()).toContain("(Europe/Oslo)");
    zone = "America/New_York";
    expect(card()).toContain("Tuesday 2026-09-01 04:00 (America/New_York)");
  });

  it("a THROWING or blank tz reader still renders a card, on the home clock", () => {
    // Invariant 1: a cosmetic title is never worth risking the approval gate it sits on. A clock that
    // cannot be resolved must degrade one step, not take the card down.
    registerApprovalSummary({ tz: () => { throw new Error("no pool"); } });
    expect(globalThis.__eveApprovalSummary!("remind_set", { message: "x", dueAt: "2026-09-01T08:00:00Z" }))
      .toContain("(Europe/Oslo)");
    registerApprovalSummary({ tz: () => "  " });
    expect(globalThis.__eveApprovalSummary!("remind_set", { message: "x", dueAt: "2026-09-01T08:00:00Z" }))
      .toContain("(Europe/Oslo)");
  });

  it("registers with no options at all — every other agent in the fleet keeps its cards", () => {
    registerApprovalSummary();
    expect(globalThis.__eveApprovalSummary!("gmail_send", { to: ["a@x.com"] })).toBe("Send email to a@x.com");
    expect(globalThis.__eveApprovalCovers!("gmail_send")).toBe(true);
  });
});

describe("the card names everyone it is about to reach", () => {
  it("lists all four addresses of a send, never one and a count", () => {
    const out = detailsForApproval("gmail_send", {
      to: ["a@x.example", "b@x.example", "c@x.example", "d@x.example"],
      subject: "Q3",
      bodyText: "Here it is.",
    });
    expect(out).toContain("*To:* a@x.example, b@x.example, c@x.example, d@x.example");
  });

  it("names the guests of a calendar invitation, and says they are invited either way", () => {
    const out = detailsForApproval("calendar_create_event", {
      summary: "Board",
      start: "2026-09-21T09:00:00+02:00",
      attendees: ["a@x.example", "b@x.example"],
      notify: false,
    });
    expect(out).toContain("*Guests:* a@x.example, b@x.example");
    expect(out).toContain("see it on their own calendars");
  });

  it("says how much it had to leave out, instead of ending on a bare ellipsis", () => {
    const out = detailsForApproval("gmail_send", {
      to: ["a@x.example"],
      subject: "Long",
      bodyText: "x".repeat(5000),
    });
    expect(out!.length).toBeLessThanOrEqual(DETAILS_MAX_LENGTH);
    expect(out!.endsWith(shortenedNotice(0).slice(-1))).toBe(true);
    expect(out).toMatch(/shortened — \d+ characters are not shown\.$/);
  });
});

describe("coversApproval (ORB-140)", () => {
  it("is true only for a tool with a dedicated formatter — never for the generic fallback", () => {
    expect(coversApproval("gmail_send")).toBe(true);
    expect(coversApproval("calendar_delete_event")).toBe(true);
    expect(coversApproval("some_tool_nobody_summarised")).toBe(false);
    // Prototype keys are not formatters, and a non-string name is never covered.
    expect(coversApproval("toString")).toBe(false);
    expect(coversApproval(undefined)).toBe(false);
  });
});

// ORB-140 — every gated write must be COVERED (a dedicated formatter under its MOUNTED name),
// because coverage is what lets the eve patch drop the raw-JSON block from the card. The vault
// writes are extension tools and mount under `agent-kit__`; the bare names must stay uncovered
// so a rename that misses the map degrades loudly, not invisibly (the ORB-143 block above).
describe("coversApproval across Saga's gated writes (ORB-140)", () => {
  it("covers every gated write under the name eve mounts it as", () => {
    for (const tool of [
      "agent-kit__vault_write",
      "agent-kit__vault_file",
      "agent-kit__vault_drop",
      "vault_write",
      "atlas_resolve_proposal",
      "twenty_note",
      "twenty_comm_state",
      "twenty_do_not_contact",
      "twenty_create_opportunity",
      "twenty_set_stage",
      "remind_set",
      "remind_cancel",
      "gmail_draft",
      "gmail_send",
      "calendar_create_event",
      "calendar_update_event",
      "calendar_delete_event",
      "notion_resolve_proposal",
      "echo_note",
      "meeting_followup_auto",
      "meeting_followup_send",
      "gmail_draft_recipients",
      "deadline_mint_statutory",
      "deadline_done",
      "deadline_dismiss",
    ])
      expect(coversApproval(tool), tool).toBe(true);
  });

  it("does not cover the bare names of mounted tools", () => {
    // `vault_file`, not `vault_write` — see the note on the generic-fallback case above.
    expect(coversApproval("vault_file")).toBe(false);
    expect(coversApproval("vault_drop")).toBe(false);
  });
});

// 2026-09-07: the Folkepuls follow-up card named the meeting and two recipients and not one word
// of the email. ORB-140 had removed the raw "Tool input" JSON from every card with a dedicated
// title — and for a mail send that JSON was the only place the subject and body ever appeared.
// The draft is the thing being authorised; it belongs under the card, from the same registry
// that produces the title, so the two cannot drift on which tools count as mail.
describe("detailsForApproval — the draft itself, rendered under a mail card", () => {
  const input = { to: ["a@x.com"], subject: "Oppsummering", bodyText: "Hei begge,\n\nTakk for i dag." };

  it("renders subject and body for the three tools that send or draft mail", () => {
    for (const tool of ["gmail_send", "gmail_draft", "meeting_followup_send"]) {
      expect(detailsForApproval(tool, input), tool).toBe(
        "*To:* a@x.com\n\n*Subject:* Oppsummering\n\nHei begge,\n\nTakk for i dag.",
      );
    }
  });

  it("is undefined for a tool whose arguments are not a message — ORB-140's card-only shape stays theirs", () => {
    expect(detailsForApproval("calendar_delete_event", { eventId: "e1" })).toBeUndefined();
    expect(detailsForApproval("twenty_note", { recordId: "r1", body: "note" })).toBeUndefined();
  });

  it("is undefined when neither subject nor body resolved, rather than an empty block", () => {
    expect(detailsForApproval("gmail_send", { to: ["a@x.com"] })).toBeUndefined();
    expect(detailsForApproval("gmail_send", { subject: "   ", bodyText: "" })).toBeUndefined();
  });

  it("escapes Slack mrkdwn control characters, so an address in angle brackets is shown, not eaten", () => {
    expect(detailsForApproval("gmail_send", { subject: "A & B", bodyText: "cc <kjetil@x.com>" }))
      .toBe("*Subject:* A &amp; B\n\ncc &lt;kjetil@x.com&gt;");
  });

  it("bounds the block so it fits a Slack section, ending on the shortened notice", () => {
    const out = detailsForApproval("gmail_send", { subject: "S", bodyText: "x".repeat(5000) });
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(DETAILS_MAX_LENGTH);
    expect(out).toMatch(/shortened — \d+ characters are not shown\.$/);
  });

  it("never throws on model-supplied garbage — it renders the approval gate itself", () => {
    expect(() => detailsForApproval("gmail_send", 42)).not.toThrow();
    expect(() => detailsForApproval(null, { bodyText: { nested: true } })).not.toThrow();
    expect(detailsForApproval("gmail_send", { subject: 7, bodyText: ["x"] })).toBe("*Subject:* 7");
  });

  it("registerApprovalSummary publishes it beside the title and covers hooks", () => {
    registerApprovalSummary();
    try {
      expect(globalThis.__eveApprovalDetails).toBeTypeOf("function");
      expect(globalThis.__eveApprovalDetails).toBe(detailsForApproval);
    } finally {
      delete globalThis.__eveApprovalSummary;
      delete globalThis.__eveApprovalCovers;
      delete globalThis.__eveApprovalDetails;
    }
  });
});

// ── W7D-s3 — the link card ────────────────────────────────────────────────────────────────────
//
// `read_url` asks whenever the turn has already read somebody else's words, and the ONE thing
// that card has to do is let the owner see the address he is about to have fetched. Every case
// below is an address that reads as one thing and resolves as another; each is a published
// phishing shape, not a hypothetical. The rule the cases share: the card never shortens the
// address, never shows only the host, and never renders a character the owner cannot see.
describe("the link card shows the whole address, character for character", () => {
  const card = (url: unknown) => summarizeApproval("read_url", { url });

  it("names the whole address, so a look-alike domain is visible", () => {
    expect(summarizeApproval("read_url", { url: "https://paypa1.example.com/invoice?id=9" }))
      .toBe("Open link https://paypa1.example.com/invoice?id=9");
  });

  // A shortened URL is a shortened decision: the exfiltration payload of a data-carrying link is
  // exactly the part a middle ellipsis would eat. Deliberately NOT `trunc()`ed at any length.
  it("never elides a long address, however long it is", () => {
    const long = `https://example.com/${"a".repeat(400)}?token=${"b".repeat(300)}`;
    const out = card(long)!;
    expect(out).toBe(`Open link ${long}`);
    expect(out).not.toContain("…");
  });

  // `https://good.example@evil.example/` fetches evil.example; everything before the "@" is a
  // username the server never sees. The whole string is shown AND the host that is really
  // resolved is named, because "read the address carefully" has never once worked.
  it("names the host a userinfo address really resolves to", () => {
    expect(card("https://good.example@evil.example/"))
      .toBe("Open link https://good.example@evil.example/ — the fetcher resolves this to evil.example");
  });

  // Cyrillic а (U+0430) in "pаypal". The owner sees latin "paypal"; the resolver sees punycode.
  it("names the punycode form of a mixed-script host, and says it is what gets resolved", () => {
    const spoof = "https://p\u0430ypal.example/reset";
    expect(card(spoof)).toBe(`Open link ${spoof} — the fetcher resolves this to xn--pypal-4ve.example`);
  });

  // A percent-encoded address reads as one thing and means another. The card shows what was
  // supplied (decoding it would be the lie) and then what it decodes to.
  it("says what a percent-encoded address actually reads as", () => {
    expect(card("https://example.com/%2E%2E%2Fadmin"))
      .toBe("Open link https://example.com/%2E%2E%2Fadmin — percent-encoded; it reads https://example.com/../admin");
  });

  // %E2%80%AE is RIGHT-TO-LEFT OVERRIDE: decoded and rendered raw it would reverse the text after
  // it on the card. The decoded reading is escaped too — never rendered.
  it("escapes an invisible character the decoding would otherwise smuggle onto the card", () => {
    const out = card("https://example.com/%E2%80%AEgnp.exe")!;
    expect(out).toContain("\\u202e");
    expect(out).not.toContain("\u202e");
  });

  // Whitespace and control characters in the address itself: shown escaped, never invisibly.
  it("shows whitespace and control characters as escapes, never as gaps", () => {
    const hostile = "https://example.com/a\u0000b c\u200b";
    const out = card(hostile)!;
    expect(out).toBe("Open link https://example.com/a\\u0000b\\u0020c\\u200b");
    expect(out).not.toContain("\u0000");
    expect(out).not.toContain("\u200b");
  });

  it("shows a leading or trailing space rather than trimming it away", () => {
    expect(card(" https://example.com/x ")).toBe("Open link \\u0020https://example.com/x\\u0020");
  });

  // `javascript:`, `data:`, `file:` and a bare string all parse (or fail) into something with no
  // host to fetch. The card says so instead of rendering a line that looks like an ordinary link.
  it("says so when the address is not a web address at all", () => {
    expect(card("javascript:alert(1)/not a url"))
      .toBe("Open link javascript:alert(1)/not\\u0020a\\u0020url — not a web address the fetcher will follow");
    expect(card("file:///etc/passwd"))
      .toBe("Open link file:///etc/passwd — not a web address the fetcher will follow");
    expect(card("not a url")).toBe("Open link not\\u0020a\\u0020url — not a web address the fetcher will follow");
  });

  it("a mere difference of case is not worth a clause", () => {
    expect(card("https://EXAMPLE.com/A")).toBe("Open link https://EXAMPLE.com/A");
  });

  it("falls through to the generic card when there is no address to show", () => {
    expect(summarizeApproval("read_url", {})).toBe("Approve tool call: read_url");
    expect(card("   ")).toBe("Approve tool call: read_url");
    expect(card(42)).toBe("read_url — url: 42");
  });

  it("never throws on model-supplied garbage", () => {
    expect(() => card({ nested: true })).not.toThrow();
    expect(() => card(null)).not.toThrow();
    expect(() => summarizeApproval("read_url", "not an object")).not.toThrow();
  });

  // Covered = the eve patch drops its own raw "Tool input" block from the card, because the line
  // above already carries the whole address.
  it("is covered, so the card is this line and not a JSON dump", () => {
    expect(coversApproval("read_url")).toBe(true);
  });
});
