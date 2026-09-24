import { describe, it, expect } from "vitest";

import type { ThreadMessage } from "../lib/google.js";
import type { CalendarEvent } from "../lib/google.js";
import {
  selectObligations,
  assignSurfaces,
  nightBeforeCoveredDay,
  scanThreads,
  LAST_MESSAGE_MAX_CHARS,
  listTomorrowMeetings,
  readIngestedPicks,
  buildEveningBrief,
  buildMorningBrief,
  commitmentLine,
  travelContextLine,
  travelContextBlock,
  type ThreadSnapshot,
  type Obligation,
  type GmailSourceDeps,
  type CalendarSourceDeps,
  type PicksReader,
  type NightBeforeMeeting,
} from "../lib/brief-content.js";

/**
 * Task 12 — lib/brief-content.ts. Per the task brief's own Step 1, the contract as
 * assertions:
 *   1. zero obligations + zero meetings → buildEveningBrief returns exactly null
 *   2. obligations present → included, and the deterministic (non-model) output never
 *      contains "nothing outstanding" / "no one is waiting"
 *   3. morning after an evening stamp → only the NEW thread appears
 *   4. morning with no delta → null
 *   5. re-ping respects max-3/day
 *
 * Plus the supporting pure/adapter logic ported from services/agent-runtime's
 * lib/obligations/{types,candidate,surfaces,reping-budget}.ts and
 * lib/adapters/{obligations/gmail-source,brief/night-before-calendar,brief/ingested-picks}.ts.
 *
 * ORB-209 — the `gatherOpenObligations` cases, the resolve → read → explain cases and the
 * `dropResolved` cases moved VERBATIM to `tests/obligation-pipeline.test.ts` with the code they
 * cover. Nothing was dropped in the move; look there for the pipeline's contract.
 */

// ─── Fixtures ───────────────────────────────────────────────────────────────────────────────

function snapshot(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    threadId: "t-1",
    subject: "Re: pilot terms",
    counterpartyName: "Lars Eriksen",
    counterpartyAddress: "lars@partner.example",
    lastMessageAt: new Date("2026-08-10T09:00:00Z"),
    lastSpeakerIsThem: true,
    addressedToHim: true,
    isAutomated: false,
    theirUnansweredCount: 1,
    source: "gmail",
    ...overrides,
  };
}

function obligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    threadId: "t-1",
    subject: "Re: pilot terms",
    counterpartyName: "Lars Eriksen",
    counterpartyAddress: "lars@partner.example",
    lastMessageAt: new Date("2026-08-10T09:00:00Z"),
    ageHours: 60,
    isRePing: false,
    unansweredCount: 1,
    source: "gmail",
    ...overrides,
  };
}

const NOW = new Date("2026-08-12T20:00:00Z"); // 22:00 CEST — an evening pass moment

// ─── selectObligations (ported from obligations/candidate.ts) ─────────────────────────────

describe("selectObligations", () => {
  it("drops a dismissed thread — never resurfaces", () => {
    const out = selectObligations([snapshot({ dismissedAt: new Date() })], NOW);
    expect(out).toEqual([]);
  });

  it("drops a thread where he spoke last — the ball is not his", () => {
    const out = selectObligations([snapshot({ lastSpeakerIsThem: false })], NOW);
    expect(out).toEqual([]);
  });

  it("drops an automated sender — a list is not a person waiting", () => {
    const out = selectObligations([snapshot({ isAutomated: true })], NOW);
    expect(out).toEqual([]);
  });

  it("drops a thread where he was only Cc'd, not addressed", () => {
    const out = selectObligations([snapshot({ addressedToHim: false })], NOW);
    expect(out).toEqual([]);
  });

  it("excludes a normal (non-re-ping) thread younger than 48h", () => {
    const out = selectObligations([snapshot({ lastMessageAt: new Date(NOW.getTime() - 47 * 3_600_000), theirUnansweredCount: 1 })], NOW);
    expect(out).toEqual([]);
  });

  it("includes a normal thread at exactly 48h", () => {
    const out = selectObligations([snapshot({ lastMessageAt: new Date(NOW.getTime() - 48 * 3_600_000), theirUnansweredCount: 1 })], NOW);
    expect(out).toHaveLength(1);
  });

  it("a re-ping (unanswered count >= 2) qualifies sooner — at 24h, not 48h", () => {
    const out = selectObligations([snapshot({ lastMessageAt: new Date(NOW.getTime() - 24 * 3_600_000), theirUnansweredCount: 2 })], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.isRePing).toBe(true);
  });

  it("sorts most-overdue first", () => {
    const out = selectObligations(
      [
        snapshot({ threadId: "younger", lastMessageAt: new Date(NOW.getTime() - 50 * 3_600_000) }),
        snapshot({ threadId: "older", lastMessageAt: new Date(NOW.getTime() - 100 * 3_600_000) }),
      ],
      NOW,
    );
    expect(out.map((o) => o.threadId)).toEqual(["older", "younger"]);
  });

  // ─── ORB-45 Task 10 (B1): the new snapshot fields pass through untouched ──────────────────

  it("passes lastMessageText, counterpartyEmails, counterpartySlackUserId and source through unchanged", () => {
    const out = selectObligations(
      [
        snapshot({
          lastMessageText: "hei",
          counterpartyEmails: ["lars@partner.example"],
          counterpartySlackUserId: "U_LARS",
          source: "slack",
        }),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      lastMessageText: "hei",
      counterpartyEmails: ["lars@partner.example"],
      counterpartySlackUserId: "U_LARS",
      source: "slack",
    });
  });
});

// ─── assignSurfaces (ported from obligations/surfaces.ts) ──────────────────────────────────

describe("assignSurfaces", () => {
  it("puts an obligation owed to a tomorrow's-meeting participant in nightBefore, not brief", () => {
    const { nightBefore, brief } = assignSurfaces(
      [obligation({ counterpartyAddress: "lars@partner.example" })],
      new Set(["lars@partner.example"]),
      new Map(),
    );
    expect(nightBefore).toHaveLength(1);
    expect(brief).toHaveLength(0);
  });

  it("matches case-insensitively", () => {
    const { nightBefore } = assignSurfaces(
      [obligation({ counterpartyAddress: "Lars@partner.example" })],
      new Set(["lars@partner.example"]),
      new Map(),
    );
    expect(nightBefore).toHaveLength(1);
  });

  it("puts everyone else in brief", () => {
    const { nightBefore, brief } = assignSurfaces(
      [obligation({ counterpartyAddress: "someone-else@example.com" })],
      new Set(["lars@partner.example"]),
      new Map(),
    );
    expect(nightBefore).toHaveLength(0);
    expect(brief).toHaveLength(1);
  });

  it("an empty counterpartyAddress never matches an empty participant set", () => {
    const { nightBefore, brief } = assignSurfaces([obligation({ counterpartyAddress: "" })], new Set(), new Map());
    expect(nightBefore).toHaveLength(0);
    expect(brief).toHaveLength(1);
  });

  it("interrupt: a re-ping never announced before qualifies", () => {
    const { interrupt } = assignSurfaces([obligation({ isRePing: true, unansweredCount: 2 })], new Set(), new Map());
    expect(interrupt).toHaveLength(1);
  });

  it("interrupt: a non-re-ping never qualifies, however it was announced", () => {
    const { interrupt } = assignSurfaces([obligation({ isRePing: false })], new Set(), new Map());
    expect(interrupt).toHaveLength(0);
  });

  it("interrupt: an UNCHANGED announced count stays quiet — the same bump, not a new one", () => {
    const announced = new Map([["t-1", 2]]);
    const { interrupt } = assignSurfaces([obligation({ isRePing: true, unansweredCount: 2 })], new Set(), announced);
    expect(interrupt).toHaveLength(0);
  });

  it("interrupt: a GROWN count earns one more nudge", () => {
    const announced = new Map([["t-1", 2]]);
    const { interrupt } = assignSurfaces([obligation({ isRePing: true, unansweredCount: 3 })], new Set(), announced);
    expect(interrupt).toHaveLength(1);
  });
});

describe("nightBeforeCoveredDay", () => {
  it("is tomorrow's Oslo calendar day, not today's", () => {
    // 2026-08-12 22:00 CEST — tomorrow (Oslo) is 2026-08-13.
    expect(nightBeforeCoveredDay(NOW)).toBe("2026-08-13");
  });
});

// ─── Re-ping budget — REMOVED by ORB-193 ────────────────────────────────────────────────────
// The local budget (`rePingRemaining`/`rePingRecord`/`EMPTY_REPING_BUDGET`) and its five contract
// tests are gone with it: the cap is now the proactivity gate's central escalation ceiling, proven
// against a real Postgres in `packages/agent-kit/tests/proactivity.test.ts`, and asserted absent
// from this module by `tests/proactivity-wiring.test.ts`.

// ─── scanThreads (ported from adapters/obligations/gmail-source.ts) ────────────────────────

function threadMessage(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "m-1",
    threadId: "t-1",
    from: "Lars Eriksen <lars@partner.example>",
    to: ["Bendik <owner@owner.example>"],
    subject: "Re: pilot terms",
    bodyText: "body",
    sentAt: "2026-08-10T09:00:00Z",
    messageId: "<m1@partner.example>",
    references: "",
    isCalendarNotice: false,
    headers: {},
    ...overrides,
  };
}

describe("scanThreads", () => {
  const mine = ["owner@owner.example"];

  it("builds a snapshot: last message from them, addressed to him, not automated", async () => {
    const deps: GmailSourceDeps = {
      searchThreadIds: async () => ["t-1"],
      readThread: async () => [threadMessage()],
    };
    const { snapshots } = await scanThreads(deps, mine);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      threadId: "t-1",
      counterpartyAddress: "lars@partner.example",
      lastSpeakerIsThem: true,
      addressedToHim: true,
      isAutomated: false,
      theirUnansweredCount: 1,
    });
  });

  it("counts a run of unanswered messages from them at the end of the thread", async () => {
    const deps: GmailSourceDeps = {
      searchThreadIds: async () => ["t-1"],
      readThread: async () => [
        threadMessage({ id: "m0", from: "Bendik <owner@owner.example>", to: ["lars@partner.example"], sentAt: "2026-08-08T09:00:00Z" }),
        threadMessage({ id: "m1", sentAt: "2026-08-09T09:00:00Z" }),
        threadMessage({ id: "m2", sentAt: "2026-08-10T09:00:00Z" }),
      ],
    };
    const { snapshots } = await scanThreads(deps, mine);
    expect(snapshots[0]!.theirUnansweredCount).toBe(2);
  });

  it("drops calendar-notice messages before counting (an RSVP is not a reply owed)", async () => {
    const deps: GmailSourceDeps = {
      searchThreadIds: async () => ["t-1"],
      readThread: async () => [threadMessage({ isCalendarNotice: true })],
    };
    const { snapshots } = await scanThreads(deps, mine);
    expect(snapshots).toEqual([]);
  });

  it("flags an automated sender via List-Unsubscribe", async () => {
    const deps: GmailSourceDeps = {
      searchThreadIds: async () => ["t-1"],
      readThread: async () => [threadMessage({ headers: { "List-Unsubscribe": "<mailto:x@y.com>" } })],
    };
    const { snapshots } = await scanThreads(deps, mine);
    expect(snapshots[0]!.isAutomated).toBe(true);
  });

  // ─── ORB-45 Task 10 (B1): lastMessageText / counterpartyEmails / source in flight ─────────

  it("sets lastMessageText from the last message's bodyText and counterpartyEmails from its sender", async () => {
    const deps: GmailSourceDeps = {
      searchThreadIds: async () => ["t-1"],
      readThread: async () => [threadMessage({ bodyText: "let's ship this Friday" })],
    };
    const { snapshots } = await scanThreads(deps, mine);
    expect(snapshots[0]!.lastMessageText).toBe("let's ship this Friday");
    expect(snapshots[0]!.counterpartyEmails).toEqual(["lars@partner.example"]);
    expect(snapshots[0]!.source).toBe("gmail");
  });

  it("trims lastMessageText to LAST_MESSAGE_MAX_CHARS", async () => {
    const long = "x".repeat(LAST_MESSAGE_MAX_CHARS + 500);
    const deps: GmailSourceDeps = {
      searchThreadIds: async () => ["t-1"],
      readThread: async () => [threadMessage({ bodyText: long })],
    };
    const { snapshots } = await scanThreads(deps, mine);
    expect(snapshots[0]!.lastMessageText).toHaveLength(LAST_MESSAGE_MAX_CHARS);
  });
});

// ─── listTomorrowMeetings (narrowed from adapters/brief/night-before-calendar.ts) ──

function calendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e-1",
    summary: "Pilot kickoff",
    start: "2026-08-13T09:00:00Z",
    end: "2026-08-13T10:00:00Z",
    attendees: [{ email: "lars@partner.example" }],
    ...overrides,
  };
}

describe("listTomorrowMeetings", () => {
  it("includes a meeting with an external attendee, on tomorrow's Oslo date", async () => {
    const deps: CalendarSourceDeps = {
      listEvents: async () => [calendarEvent()],
      myAddresses: async () => ["owner@owner.example"],
    };
    const out = await listTomorrowMeetings(deps, NOW);
    // ORB-165: an external attendee and no venue is a REMOTE call — carried on the row itself.
    expect(out).toEqual([{ title: "Pilot kickoff", startsAt: new Date("2026-08-13T09:00:00Z"), participants: ["lars@partner.example"], kind: "remote-call", endsAt: new Date("2026-08-13T10:00:00Z") }]);
  });

  // ── ORB-118: the 2026-08-17 silence. Every case below would have rendered "(none)". ──

  it("THE FOLKEPULS CASE: a located, multi-hour block with NO attendees counts", async () => {
    const deps: CalendarSourceDeps = {
      listEvents: async () => [calendarEvent({
        summary: "Folkepuls",
        start: "2026-08-13T11:00:00Z",   // 13:00 Oslo
        end: "2026-08-13T13:50:00Z",
        location: "Folio AS Youngstorget 3, 0181 Oslo, Norway",
        attendees: undefined,
      })],
      myAddresses: async () => ["owner@owner.example"],
    };
    expect(await listTomorrowMeetings(deps, NOW)).toEqual([{
      title: "Folkepuls",
      startsAt: new Date("2026-08-13T11:00:00Z"),
      participants: [],
      location: "Folio AS Youngstorget 3, 0181 Oslo, Norway",
      kind: "in-person",
      // Fix round 1 — the end is carried now, so an overlap is read rather than guessed.
      endsAt: new Date("2026-08-13T13:50:00Z"),
    }]);
  });

  it("an attendee-less block of an hour or more counts even with no location", async () => {
    const deps: CalendarSourceDeps = {
      listEvents: async () => [calendarEvent({
        summary: "Klargjøre hus for visning",
        start: "2026-08-13T11:00:00Z",
        end: "2026-08-13T15:00:00Z",
        attendees: undefined,
      })],
      myAddresses: async () => ["owner@owner.example"],
    };
    const out = await listTomorrowMeetings(deps, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "Klargjøre hus for visning", participants: [] });
    expect(out[0]?.allDay).toBeUndefined();
  });

  it("an all-day block counts, and is marked so no clock time is invented from it", async () => {
    const deps: CalendarSourceDeps = {
      listEvents: async () => [calendarEvent({
        summary: "Avreise New York",
        start: "2026-08-13", end: "2026-08-14",
        allDay: true, attendees: undefined,
      })],
      myAddresses: async () => ["owner@owner.example"],
    };
    const out = await listTomorrowMeetings(deps, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "Avreise New York", allDay: true, participants: [] });
  });

  it("a 30-minute call with an external attendee counts — attendees beat the duration floor", async () => {
    const deps: CalendarSourceDeps = {
      listEvents: async () => [calendarEvent({
        summary: "Intro call — Felipe Hefler",
        start: "2026-08-13T08:00:00Z",
        end: "2026-08-13T08:30:00Z",
      })],
      myAddresses: async () => ["owner@owner.example"],
    };
    expect(await listTomorrowMeetings(deps, NOW)).toHaveLength(1);
  });

  it("sorts chronologically across calendars — the fan-out merges several, each ordered only within itself", async () => {
    const deps: CalendarSourceDeps = {
      listEvents: async () => [
        calendarEvent({ id: "late", summary: "Visning", start: "2026-08-13T15:30:00Z", end: "2026-08-13T16:30:00Z", attendees: undefined, location: "Bryggeveien 15" }),
        calendarEvent({ id: "early", summary: "Intro call", start: "2026-08-13T08:00:00Z", end: "2026-08-13T08:30:00Z" }),
      ],
      myAddresses: async () => ["owner@owner.example"],
    };
    expect((await listTomorrowMeetings(deps, NOW)).map((m) => m.title)).toEqual(["Intro call", "Visning"]);
  });

  it("still drops the short attendee-less hold with no location — a personal marker, not a commitment", async () => {
    const deps: CalendarSourceDeps = {
      listEvents: async () => [calendarEvent({
        summary: "Buffer",
        start: "2026-08-13T09:00:00Z",
        end: "2026-08-13T09:15:00Z",
        attendees: [{ email: "owner@owner.example" }],
      })],
      myAddresses: async () => ["owner@owner.example"],
    };
    expect(await listTomorrowMeetings(deps, NOW)).toEqual([]);
  });

  it("drops an event on a neighbouring day — not tomorrow", async () => {
    const deps: CalendarSourceDeps = {
      listEvents: async () => [calendarEvent({ start: "2026-08-14T09:00:00Z" })],
      myAddresses: async () => ["owner@owner.example"],
    };
    expect(await listTomorrowMeetings(deps, NOW)).toEqual([]);
  });

  it("throws on a truncated (exactly-at-ceiling) calendar read — never a silently partial list", async () => {
    const deps: CalendarSourceDeps = {
      listEvents: async () => Array.from({ length: 250 }, (_, i) => calendarEvent({ id: `e-${i}` })),
      myAddresses: async () => ["owner@owner.example"],
    };
    await expect(listTomorrowMeetings(deps, NOW)).rejects.toThrow(/maximum/);
  });

  it("throws when the identity registry has no addresses", async () => {
    const deps: CalendarSourceDeps = { listEvents: async () => [calendarEvent()], myAddresses: async () => [] };
    await expect(listTomorrowMeetings(deps, NOW)).rejects.toThrow(/identity registry/);
  });
});

// ─── readIngestedPicks (ported from adapters/brief/ingested-picks.ts) ──────────────────────

function fakeReader(files: Record<string, string>): PicksReader {
  return {
    readdir: () => Object.keys(files),
    readFile: (path) => {
      const name = path.split("/").pop()!;
      const body = files[name];
      if (body === undefined) throw new Error("ENOENT");
      return body;
    },
  };
}

describe("readIngestedPicks", () => {
  it("returns [] when the dir is unset — the input is OFF, no fallback scanning", () => {
    expect(readIngestedPicks(undefined, NOW)).toEqual([]);
  });

  it("includes a note created within the window, with title/url from frontmatter", () => {
    const reader = fakeReader({
      "a.md": "---\ntitle: EU sovereign AI\nsource: https://example.com/a\ncreated: 2026-08-11\n---\nbody",
    });
    const out = readIngestedPicks("/vault/raw", NOW, reader);
    expect(out).toEqual([{ title: "EU sovereign AI", url: "https://example.com/a", path: "a.md", created: "2026-08-11" }]);
  });

  it("excludes a note with no created date — never falls back to file mtime", () => {
    const reader = fakeReader({ "a.md": "---\ntitle: X\n---\nbody" });
    expect(readIngestedPicks("/vault/raw", NOW, reader)).toEqual([]);
  });

  it("excludes a note older than the window", () => {
    const reader = fakeReader({ "a.md": "---\ncreated: 2026-07-01\n---\nbody" });
    expect(readIngestedPicks("/vault/raw", NOW, reader)).toEqual([]);
  });

  it("falls back to a humanised filename when there is no title", () => {
    const reader = fakeReader({ "why-eu-sovereign-ai-matters.md": "---\ncreated: 2026-08-11\n---\nbody" });
    const out = readIngestedPicks("/vault/raw", NOW, reader);
    expect(out[0]!.title).toBe("Why eu sovereign ai matters");
  });

  it("sorts newest-created first and caps at PICKS_MAX (8)", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      const day = `2026-08-${String(11 - (i % 7)).padStart(2, "0")}`;
      files[`note-${i}.md`] = `---\ncreated: ${day}\n---\nbody`;
    }
    const out = readIngestedPicks("/vault/raw", NOW, fakeReader(files));
    expect(out.length).toBeLessThanOrEqual(8);
    const created = out.map((p) => p.created);
    expect([...created].sort().reverse()).toEqual(created);
  });

  it("never throws — an unreadable dir degrades to []", () => {
    const reader: PicksReader = {
      readdir: () => { throw new Error("ENOENT"); },
      readFile: () => "",
    };
    expect(readIngestedPicks("/vault/raw", NOW, reader)).toEqual([]);
  });
});

// ─── buildEveningBrief / buildMorningBrief — the task's own Step-1 contract ────────────────

describe("buildEveningBrief", () => {
  it("CONTRACT 1 — zero obligations and zero meetings → returns exactly null", () => {
    expect(buildEveningBrief({ meetings: [], obligations: [] })).toBeNull();
  });

  it("CONTRACT 2 — obligations owed to a tomorrow participant are included, and the deterministic output never contains a negative assurance", () => {
    const content = buildEveningBrief({
      meetings: [{ title: "Pilot kickoff", startsAt: new Date("2026-08-13T09:00:00Z"), participants: ["lars@partner.example"], kind: "remote-call" as const }],
      obligations: [obligation({ counterpartyAddress: "lars@partner.example" })],
    });
    expect(content).not.toBeNull();
    expect(content!.obligations).toHaveLength(1);
    const rendered = JSON.stringify(content).toLowerCase();
    expect(rendered).not.toContain("nothing outstanding");
    expect(rendered).not.toContain("no one is waiting");
  });

  it("meetings alone (nobody owed) still produce content — not null", () => {
    const content = buildEveningBrief({
      meetings: [{ title: "Pilot kickoff", startsAt: new Date("2026-08-13T09:00:00Z"), participants: ["lars@partner.example"], kind: "remote-call" as const }],
      obligations: [],
    });
    expect(content).not.toBeNull();
    expect(content!.meetings).toHaveLength(1);
    expect(content!.obligations).toEqual([]);
  });

  it("an obligation owed to someone NOT in tomorrow's meetings is excluded — it belongs to the morning brief", () => {
    const content = buildEveningBrief({
      meetings: [],
      obligations: [obligation({ counterpartyAddress: "someone-else@example.com" })],
    });
    expect(content).toBeNull();
  });
});

describe("buildMorningBrief", () => {
  it("CONTRACT 3 — after an evening stamp, only the NEW/unstamped thread appears", () => {
    const content = buildMorningBrief({
      meetings: [],
      obligations: [
        obligation({ threadId: "t-stamped-last-night" }),
        obligation({ threadId: "t-new" }),
      ],
      deliveredLastNight: new Set(["t-stamped-last-night"]),
      picks: [],
    });
    expect(content).not.toBeNull();
    expect(content!.obligations.map((o) => o.threadId)).toEqual(["t-new"]);
  });

  it("CONTRACT 4 — everything stamped and no picks → returns exactly null", () => {
    const content = buildMorningBrief({
      meetings: [],
      obligations: [obligation({ threadId: "t-stamped" })],
      deliveredLastNight: new Set(["t-stamped"]),
      picks: [],
    });
    expect(content).toBeNull();
  });

  it("picks alone (no obligation delta) still produce content — not null", () => {
    const content = buildMorningBrief({
      meetings: [],
      obligations: [],
      deliveredLastNight: new Set(),
      picks: [{ title: "A saved article", path: "a.md", created: "2026-08-12" }],
    });
    expect(content).not.toBeNull();
    expect(content!.picks).toHaveLength(1);
  });

  // ── 2026-08-18: "the morning brief should let me know what's on my plate, probably in a
  //    prio list. Delta is of course important if/when it happens." ──

  it("today's meetings appear even when nothing changed overnight — the plate, not just the delta", () => {
    const content = buildMorningBrief({
      meetings: [{ title: "Visning", startsAt: new Date("2026-08-12T15:30:00Z"), participants: [], location: "Bryggeveien 15", kind: "in-person" as const }],
      obligations: [obligation({ threadId: "t-stamped" })],
      deliveredLastNight: new Set(["t-stamped"]),
      picks: [],
    });
    expect(content).not.toBeNull();
    expect(content!.meetings).toHaveLength(1);
    expect(content!.obligations).toEqual([]);   // the obligation half stays a strict delta
  });

  it("null still means null — no meetings, no delta, no picks", () => {
    expect(buildMorningBrief({
      meetings: [],
      obligations: [obligation({ threadId: "t-stamped" })],
      deliveredLastNight: new Set(["t-stamped"]),
      picks: [],
    })).toBeNull();
  });

  it("the deterministic output never contains a negative assurance", () => {
    const content = buildMorningBrief({
      meetings: [],
      obligations: [obligation()],
      deliveredLastNight: new Set(),
      picks: [],
    });
    const rendered = JSON.stringify(content).toLowerCase();
    expect(rendered).not.toContain("nothing outstanding");
    expect(rendered).not.toContain("no one is waiting");
  });
});

// ─── ORB-172 — travel makes a brief happen ─────────────────────────────────────────────────
//
// The defect, verbatim from the ticket: `buildMorningBrief` returned null before travel was
// ever read, so a New York day with no meetings was silent. The product rule (recorded on the
// ticket, 2026-09-01): a trip whose span covers the brief's day earns the brief. An
// UNAVAILABLE store does not — only a KNOWN trip does; the drop-notice renders when a brief
// happens for other reasons.

import { type BriefTravel } from "../lib/brief-content.js";

function tripCovering(day: string, start: string, end: string): BriefTravel {
  return {
    day,
    dayWord: "today",
    travel: {
      trips: [{
        trip: { slug: "nyc", name: "The Big Apple", start, end, timezone: "America/New_York", destination: "New York" },
        lodging: [], transport: [], other: [], notes: "", itinerary: "",
      }],
    },
  };
}

describe("buildMorningBrief — travel earns the brief (ORB-172)", () => {
  const empty = { meetings: [], obligations: [], deliveredLastNight: new Set<string>(), picks: [] };

  it("THE REGRESSION: a travel day with no meetings, obligations or picks is NOT silent", () => {
    const content = buildMorningBrief({ ...empty, travel: tripCovering("2026-09-01", "2026-08-30", "2026-09-03") });
    expect(content).not.toBeNull();
  });

  it("a trip in the horizon but NOT covering the day does not earn a brief", () => {
    expect(buildMorningBrief({ ...empty, travel: tripCovering("2026-09-01", "2026-09-04", "2026-09-08") })).toBeNull();
  });

  it("no travel wiring (undefined) keeps the pre-ORB-172 contract exactly", () => {
    expect(buildMorningBrief({ ...empty })).toBeNull();
  });

  it("an UNAVAILABLE store does not earn a brief — only a known trip does", () => {
    const sick: BriefTravel = { day: "2026-09-01", dayWord: "today", travel: { trips: [], unavailable: "store could not be read" } };
    expect(buildMorningBrief({ ...empty, travel: sick })).toBeNull();
  });

  it("the trip's boundary days count — start day and end day are travel days", () => {
    expect(buildMorningBrief({ ...empty, travel: tripCovering("2026-09-01", "2026-09-01", "2026-09-03") })).not.toBeNull();
    expect(buildMorningBrief({ ...empty, travel: tripCovering("2026-09-01", "2026-08-28", "2026-09-01") })).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ORB-180 Task 4 — the `## Frister` block.
//
// Exact strings, asserted, for the same reason `conflictsBlock` has its own cases: this block
// is rendered INTO the prompt as context rather than spoken by the model, so its wording is a
// contract with the reader and not a formatting preference. Norwegian throughout.
// ═══════════════════════════════════════════════════════════════════════════════════════════

import { DEADLINE_LINES_MAX, deadlinesBlock, type CandidateLine, type DeadlineLine } from "../lib/brief-content.js";

function deadlineLine(overrides: Partial<DeadlineLine> = {}): DeadlineLine {
  return {
    id: "d1",
    entity: "Heiberg Industries AS",
    title: "MVA-melding, 3. termin",
    dueDate: "2026-09-08",
    daysToDue: 0,
    consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
    source: "statutory",
    ...overrides,
  };
}

function candidateLine(overrides: Partial<CandidateLine> = {}): CandidateLine {
  return {
    threadId: "t1",
    subject: "MVA-melding 3. termin forfaller 31.08",
    sender: "post@fiken.no",
    ...overrides,
  };
}

describe("deadlinesBlock (ORB-180)", () => {
  it("BY EXCEPTION — both lists empty renders \"\", so the block is dropped entirely", () => {
    expect(deadlinesBlock([], [], "nb")).toBe("");
  });

  it("carries the `## Frister` heading", () => {
    expect(deadlinesBlock([deadlineLine()], [], "nb")).toContain("## Frister");
  });

  it("due today is SISTE FRIST — i dag, with entity, consequence and id", () => {
    expect(deadlinesBlock([deadlineLine()], [], "nb")).toContain(
      "- SISTE FRIST — i dag: MVA-melding, 3. termin (Heiberg Industries AS) — Tvangsmulkt per dag og forsinkelsesrenter [id d1]",
    );
  });

  it("due tomorrow is SISTE FRIST — i morgen", () => {
    expect(deadlinesBlock([deadlineLine({ daysToDue: 1 })], [], "nb")).toContain("- SISTE FRIST — i morgen: MVA-melding, 3. termin");
  });

  it("overdue counts the days since, and 1 day is singular", () => {
    const two = deadlinesBlock([deadlineLine({ id: "d2", entity: "Vol de Nuit AS", title: "Aksjonærregisteroppgaven", daysToDue: -2, consequence: "Gebyr" })], [], "nb");
    expect(two).toContain("- Forfalt for 2 dager siden: Aksjonærregisteroppgaven (Vol de Nuit AS) — Gebyr [id d2]");
    expect(deadlinesBlock([deadlineLine({ daysToDue: -1 })], [], "nb")).toContain("- Forfalt for 1 dag siden: ");
  });

  it("further out names the days AND the date, so the model never has to compute one", () => {
    expect(deadlinesBlock([deadlineLine({ id: "d3", title: "Skattemelding for AS", daysToDue: 8, dueDate: "2026-09-16", consequence: null })], [], "nb"))
      .toContain("- Om 8 dager (2026-09-16): Skattemelding for AS (Heiberg Industries AS) [id d3]");
  });

  it("a row with no consequence omits the em-dash clause entirely — never an empty one", () => {
    const block = deadlinesBlock([deadlineLine({ consequence: null })], [], "nb");
    expect(block).toContain("- SISTE FRIST — i dag: MVA-melding, 3. termin (Heiberg Industries AS) [id d1]");
    expect(block).not.toContain("AS) — [id");
  });

  // ── vendor / amount / currency (LAR-22-s3) ─────────────────────────────────────────────────
  //
  // Pure data, no translated words — asserted here rather than duplicated per language. The
  // pin above (and tests/brief-language.test.ts's byte-identical nb/en assertions) already prove
  // a row with none of the three renders exactly as before; these cover what changes when they
  // are present.
  it("a renewal row appends vendor and amount+currency after the consequence clause", () => {
    const block = deadlinesBlock(
      [deadlineLine({ consequence: null, source: "renewal", vendor: "Domeneshop", amount: 199, currency: "NOK" })],
      [],
      "nb",
    );
    expect(block).toContain(
      "- SISTE FRIST — i dag: MVA-melding, 3. termin (Heiberg Industries AS) — Domeneshop, 199 NOK [id d1]",
    );
  });

  it("vendor and consequence both render, consequence first", () => {
    const block = deadlinesBlock(
      [deadlineLine({ source: "renewal", vendor: "Domeneshop", amount: 199, currency: "NOK" })],
      [],
      "nb",
    );
    expect(block).toContain(
      "- SISTE FRIST — i dag: MVA-melding, 3. termin (Heiberg Industries AS) — " +
        "Tvangsmulkt per dag og forsinkelsesrenter — Domeneshop, 199 NOK [id d1]",
    );
  });

  it("a partial row — vendor only — renders cleanly, no stray comma", () => {
    const block = deadlinesBlock(
      [deadlineLine({ consequence: null, source: "renewal", vendor: "Domeneshop" })],
      [],
      "nb",
    );
    expect(block).toContain("- SISTE FRIST — i dag: MVA-melding, 3. termin (Heiberg Industries AS) — Domeneshop [id d1]");
  });

  it("a partial row — amount without currency — renders the bare number", () => {
    const block = deadlinesBlock(
      [deadlineLine({ consequence: null, source: "renewal", amount: 199 })],
      [],
      "nb",
    );
    expect(block).toContain("- SISTE FRIST — i dag: MVA-melding, 3. termin (Heiberg Industries AS) — 199 [id d1]");
  });

  it("amount format: a whole number has no decimals, a fractional one always shows two", () => {
    const whole = deadlinesBlock([deadlineLine({ consequence: null, source: "renewal", amount: 199 })], [], "nb");
    expect(whole).toContain("— 199 [id d1]");
    const fractional = deadlinesBlock([deadlineLine({ consequence: null, source: "renewal", amount: 199.5 })], [], "nb");
    expect(fractional).toContain("— 199.50 [id d1]");
    const twoDp = deadlinesBlock([deadlineLine({ consequence: null, source: "renewal", amount: 199.99 })], [], "nb");
    expect(twoDp).toContain("— 199.99 [id d1]");
  });

  it("null vendor/amount/currency (the ordinary shape from a pre-LAR-22 row) render nothing extra", () => {
    const block = deadlinesBlock(
      [deadlineLine({ consequence: null, vendor: null, amount: null, currency: null })],
      [],
      "nb",
    );
    expect(block).toContain("- SISTE FRIST — i dag: MVA-melding, 3. termin (Heiberg Industries AS) [id d1]");
  });

  it("ORDERING: overdue and ≤2 days first (most overdue first, then closest), then the rest closest-first", () => {
    const block = deadlinesBlock(
      [
        deadlineLine({ id: "far", daysToDue: 16 }),
        deadlineLine({ id: "today", daysToDue: 0 }),
        deadlineLine({ id: "near", daysToDue: 8 }),
        deadlineLine({ id: "late", daysToDue: -4 }),
        deadlineLine({ id: "soon", daysToDue: 2 }),
      ],
      [],
      "nb",
    );
    const ids = [...block.matchAll(/\[id ([a-z]+)\]/g)].map((m) => m[1]);
    expect(ids).toEqual(["late", "today", "soon", "near", "far"]);
  });

  it("a candidate names the thread and both tools, and rides AFTER every deadline", () => {
    const block = deadlinesBlock([deadlineLine()], [candidateLine()], "nb");
    expect(block).toContain(
      '- Mulig frist fra e-post: "MVA-melding 3. termin forfaller 31.08" fra post@fiken.no — ' +
      "legg til (deadline_add fromThreadId t1) eller ignorer (deadline_dismiss candidateThreadId t1) [thread t1]",
    );
    expect(block.indexOf("[id d1]")).toBeLessThan(block.indexOf("[thread t1]"));
  });

  it("candidates keep the order they were given in", () => {
    const block = deadlinesBlock([], [candidateLine({ threadId: "t1" }), candidateLine({ threadId: "t2" })], "nb");
    expect(block.indexOf("[thread t1]")).toBeLessThan(block.indexOf("[thread t2]"));
  });

  it("candidates ALONE still render the block — a deadline row is not required", () => {
    expect(deadlinesBlock([], [candidateLine()], "nb")).toContain("## Frister");
  });

  // ── The cap (review fix, ORB-180) ─────────────────────────────────────────────────────────
  //
  // A statutory mint is a whole year in one approval — twelve rows for one Norwegian AS — so the
  // morning two entities' 30-day marks coincide, the block was a wall. Eight lines, most urgent
  // kept, and the remainder COUNTED rather than silently dropped.
  it("caps the deadline lines at DEADLINE_LINES_MAX and names the remainder", () => {
    const rows = Array.from({ length: DEADLINE_LINES_MAX + 1 }, (_, i) =>
      deadlineLine({ id: `d${i}`, daysToDue: i }),
    );
    const block = deadlinesBlock(rows, [], "nb");
    const ids = [...block.matchAll(/\[id (d\d+)\]/gu)].map((m) => m[1]);
    expect(ids).toHaveLength(DEADLINE_LINES_MAX);
    expect(block).toContain("- +1 flere frister — se konsollen");
    // The one dropped is the LEAST urgent, never the row that is due first.
    expect(ids).not.toContain(`d${DEADLINE_LINES_MAX}`);
    expect(ids[0]).toBe("d0");
  });

  it("exactly DEADLINE_LINES_MAX rows print no tail at all", () => {
    const rows = Array.from({ length: DEADLINE_LINES_MAX }, (_, i) => deadlineLine({ id: `d${i}`, daysToDue: i }));
    expect(deadlinesBlock(rows, [], "nb")).not.toContain("flere frister");
  });

  it("the cap counts every hidden row, not just the first", () => {
    const rows = Array.from({ length: DEADLINE_LINES_MAX + 5 }, (_, i) => deadlineLine({ id: `d${i}`, daysToDue: i }));
    expect(deadlinesBlock(rows, [], "nb")).toContain("- +5 flere frister — se konsollen");
  });

  it("OVERDUE rows survive the cap — they sort first, which is the point of the daily mention", () => {
    const overdue = Array.from({ length: 3 }, (_, i) => deadlineLine({ id: `late${i}`, daysToDue: -(i + 1) }));
    const rest = Array.from({ length: DEADLINE_LINES_MAX }, (_, i) => deadlineLine({ id: `d${i}`, daysToDue: i + 1 }));
    const block = deadlinesBlock([...rest, ...overdue], [], "nb");
    for (const o of overdue) expect(block).toContain(`[id ${o.id}]`);
    expect(block).toContain("- +3 flere frister — se konsollen");
  });

  it("the candidate cap is UNCHANGED by the deadline cap — candidates are capped at build time, not here", () => {
    const cands = Array.from({ length: 7 }, (_, i) => candidateLine({ threadId: `t${i}` }));
    const block = deadlinesBlock([], cands, "nb");
    expect([...block.matchAll(/\[thread t\d+\]/gu)]).toHaveLength(7);
  });
});

// ─── ORB-180 — deadlines and the morning brief's silence rule ───────────────────────────────

describe("buildMorningBrief — deadlines break the silence, candidates do not (ORB-180)", () => {
  const empty = { meetings: [], obligations: [], deliveredLastNight: new Set<string>(), picks: [] };

  it("a due deadline is a reason to send on an otherwise empty morning", () => {
    const content = buildMorningBrief({ ...empty, deadlines: [deadlineLine()] });
    expect(content).not.toBeNull();
    expect(content!.deadlines).toHaveLength(1);
  });

  it("a candidate ALONE does not — it can wait for a morning that has something else to say", () => {
    expect(buildMorningBrief({ ...empty, deadlineCandidates: [candidateLine()] })).toBeNull();
  });

  it("a candidate rides along on a morning that happens for another reason", () => {
    const content = buildMorningBrief({
      ...empty,
      picks: [{ title: "A saved article", path: "a.md", created: "2026-08-12" }],
      deadlineCandidates: [candidateLine()],
    });
    expect(content!.deadlineCandidates).toEqual([candidateLine()]);
  });

  it("EMPTY lists are omitted from the content entirely — the ORB-139 conflicts pattern", () => {
    const content = buildMorningBrief({
      ...empty,
      picks: [{ title: "A saved article", path: "a.md", created: "2026-08-12" }],
      deadlines: [],
      deadlineCandidates: [],
    });
    expect(content).not.toHaveProperty("deadlines");
    expect(content).not.toHaveProperty("deadlineCandidates");
  });

  it("no deadline wiring at all keeps the pre-ORB-180 contract exactly", () => {
    expect(buildMorningBrief({ ...empty })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LAR-16-s4 — commitment and travel-context clock times follow the owner's clock, not a
// hardcoded Oslo one. `tz` is required on `commitmentLine`/`travelContextLine`, so every case
// below states it explicitly; `travelContextBlock` defaults to `DEFAULT_HOME_TZ` (Europe/Oslo)
// when omitted, which is what keeps its own existing callers unchanged.
// ═══════════════════════════════════════════════════════════════════════════════════════════

function nbMeeting(overrides: Partial<NightBeforeMeeting> = {}): NightBeforeMeeting {
  return {
    title: "Board sync",
    startsAt: new Date("2026-08-25T14:00:00Z"),
    participants: ["a@example.com"],
    kind: "remote-call",
    ...overrides,
  };
}

describe("commitmentLine follows the tz it is given (LAR-16-s4)", () => {
  it("Europe/Oslo (today's default) is unchanged — CEST in August is +2h", () => {
    expect(commitmentLine(nbMeeting(), "Europe/Oslo")).toContain("16:00");
  });

  it("the SAME instant, in America/New_York, prints 10:00 — not 16:00", () => {
    const line = commitmentLine(nbMeeting(), "America/New_York");
    expect(line).toContain("10:00");
    expect(line).not.toContain("16:00");
  });
});

describe("travelContextLine follows the tz it is given (LAR-16-s4)", () => {
  const stay = nbMeeting({ title: "Hotel", kind: "lodging" });

  it("Europe/Oslo (today's default) is unchanged", () => {
    expect(travelContextLine(stay, "Europe/Oslo")).toContain("16:00");
  });

  it("America/New_York prints the wall time in that zone", () => {
    expect(travelContextLine(stay, "America/New_York")).toContain("10:00");
  });
});

describe("travelContextBlock threads tz to every calendar row (LAR-16-s4)", () => {
  const stay = nbMeeting({ title: "Hotel", kind: "lodging" });

  it("defaults to Europe/Oslo (DEFAULT_HOME_TZ) when tz is omitted — unchanged", () => {
    expect(travelContextBlock([stay])).toBe(travelContextBlock([stay], undefined, "Europe/Oslo"));
    expect(travelContextBlock([stay])).toContain("16:00");
  });

  it("America/New_York reaches every row in the block", () => {
    expect(travelContextBlock([stay], undefined, "America/New_York")).toContain("10:00");
  });
});
