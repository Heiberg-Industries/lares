import { describe, it, expect } from "vitest";

import type { BriefContent, NightBeforeMeeting, Obligation } from "../lib/brief-content.js";
import { organisationLookupClause } from "../lib/brief-content.js";
import { buildEveningPrompt } from "../agent/schedules/evening-brief.js";
import { buildMorningPrompt } from "../agent/schedules/morning-brief.js";
import { buildRePingPrompt } from "../agent/schedules/reping.js";
import { buildWeeklySummaryPrompt, makeWeeklySummaryTick } from "../agent/schedules/weekly-summary.js";
import type { PreferenceRow } from "../lib/dream-store.js";
import type { StandingFact } from "../lib/standing-facts.js";

/**
 * Task 12 fix round — Important finding: buildEveningPrompt/buildMorningPrompt/buildRePingPrompt
 * are pure, exported functions that directly implement this task's central guard-rail promise
 * (never say "nothing outstanding") yet had zero coverage. This closes that gap, and covers the
 * Critical-finding fix's own buildWeeklySummaryPrompt (lib/dream-store.ts-backed weekly summary)
 * for consistency.
 *
 * The tone-rule sentence is asserted with whitespace normalised (collapse runs of whitespace,
 * including the `\n` evening/morning wrap it across two joined lines, to a single space) — the
 * WORDS must match verbatim; the line-wrap is a formatting choice, not part of the contract.
 */

const NO_NEGATIVE_ASSURANCE = [/nothing outstanding/i, /no one is waiting/i];
const TONE_RULE =
  "Write to inform, not to prove checking happened. Never state that nothing is outstanding.";

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

function assertNoNegativeAssurance(text: string): void {
  for (const re of NO_NEGATIVE_ASSURANCE) expect(text).not.toMatch(re);
}

function meeting(overrides: Partial<NightBeforeMeeting> = {}): NightBeforeMeeting {
  return {
    title: "Pilot kickoff",
    startsAt: new Date("2026-08-13T09:00:00Z"),
    participants: ["lars@partner.example"],
    // ORB-165 — every meeting row now carries a kind; an attendee with no venue is a remote call.
    kind: "remote-call",
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
    ...overrides,
  };
}

describe("buildEveningPrompt", () => {
  const content: BriefContent = {
    meetings: [meeting()],
    obligations: [obligation({ isRePing: true, unansweredCount: 2 })],
    picks: [],
  };

  it("never says nothing is outstanding / no one is waiting", () => {
    assertNoNegativeAssurance(buildEveningPrompt(content));
  });

  it("carries the tone-rule sentence verbatim (whitespace-normalised)", () => {
    expect(normalizeWhitespace(buildEveningPrompt(content))).toContain(TONE_RULE);
  });

  it("includes the meeting and obligation facts", () => {
    const prompt = buildEveningPrompt(content);
    expect(prompt).toContain("Pilot kickoff");
    expect(prompt).toContain("Lars Eriksen");
    expect(prompt).toContain("lars@partner.example");
  });
});

describe("buildMorningPrompt", () => {
  const content: BriefContent = {
    meetings: [],
    obligations: [obligation()],
    picks: [{ title: "A saved article", url: "https://example.com/a", path: "a.md", created: "2026-08-12" }],
  };

  it("never says nothing is outstanding / no one is waiting", () => {
    assertNoNegativeAssurance(buildMorningPrompt(content));
  });

  it("carries the tone-rule sentence verbatim (whitespace-normalised)", () => {
    expect(normalizeWhitespace(buildMorningPrompt(content))).toContain(TONE_RULE);
  });

  it("includes the obligation and pick facts", () => {
    const prompt = buildMorningPrompt(content);
    expect(prompt).toContain("Lars Eriksen");
    expect(prompt).toContain("A saved article");
  });
});

/** LAR-16-s4 — the brief's clock times follow the owner's actual timezone, carried through
 *  `render.tz`, rather than a Europe/Oslo literal baked into `lib/brief-content.ts`. */
describe("buildMorningPrompt honors render.tz (LAR-16-s4)", () => {
  const withMeeting: BriefContent = {
    meetings: [meeting({ startsAt: new Date("2026-08-25T14:00:00Z"), kind: "remote-call" })],
    obligations: [],
    picks: [],
  };

  it("omitting tz is byte-identical to passing Europe/Oslo (DEFAULT_HOME_TZ) explicitly", () => {
    const withoutTz = buildMorningPrompt(withMeeting);
    const withOslo = buildMorningPrompt(withMeeting, [], undefined, [], null, { tz: "Europe/Oslo" });
    expect(withoutTz).toBe(withOslo);
    expect(withoutTz).toContain("16:00"); // CEST, unchanged from before this ticket
  });

  it("America/New_York — a 14:00Z meeting prints 10:00, not 16:00", () => {
    const prompt = buildMorningPrompt(withMeeting, [], undefined, [], null, { tz: "America/New_York" });
    expect(prompt).toContain("10:00");
    expect(prompt).not.toContain("16:00");
  });
});

/** LAR-16-s4 — same contract, the evening pass. `buildEveningPrompt` had no `render` parameter
 *  before this ticket; it gains one here, trailing and defaulted, for the same reason every
 *  other optional parameter on these two functions is trailing and defaulted. */
describe("buildEveningPrompt honors render.tz (LAR-16-s4)", () => {
  const withMeeting: BriefContent = {
    meetings: [meeting({ startsAt: new Date("2026-08-25T14:00:00Z"), kind: "remote-call" })],
    obligations: [],
    picks: [],
  };

  it("omitting tz is byte-identical to passing Europe/Oslo (DEFAULT_HOME_TZ) explicitly", () => {
    const withoutTz = buildEveningPrompt(withMeeting);
    const withOslo = buildEveningPrompt(withMeeting, [], undefined, [], { tz: "Europe/Oslo" });
    expect(withoutTz).toBe(withOslo);
    expect(withoutTz).toContain("16:00");
  });

  it("America/New_York — a 14:00Z meeting prints 10:00, not 16:00", () => {
    const prompt = buildEveningPrompt(withMeeting, [], undefined, [], { tz: "America/New_York" });
    expect(prompt).toContain("10:00");
    expect(prompt).not.toContain("16:00");
  });
});

/** ORB-167 — the standing-facts block, asserted on BOTH briefs from one table so the two can
 *  never drift apart on it. */
describe("standing facts in the briefs", () => {
  const facts: StandingFact[] = [
    {
      id: 7,
      fact: "jeg tar alltid toget til Tønsberg",
      category: "travel",
      sourceTurn: "turn_1",
      userId: "fixture-owner",
      statedAt: new Date("2026-08-25T06:00:00Z"),
      retiredAt: null,
      // The rest of what a stored row carries: `origin` (sql/004) and the three dated-facts
      // fields (sql/005). `tsconfig.json` excludes `tests/`, so nothing but this comment would
      // have told the next person the literal had fallen behind the interface.
      origin: "owner",
      recordedAt: new Date("2026-08-25T06:00:00Z"),
      source: "remember",
      supersededBy: null,
    },
  ];

  const eveningContent: BriefContent = { meetings: [meeting()], obligations: [obligation()], picks: [] };
  const morningContent: BriefContent = { meetings: [], obligations: [obligation()], picks: [] };

  const briefs: Array<[string, (facts?: readonly StandingFact[]) => string]> = [
    ["evening", (f) => buildEveningPrompt(eveningContent, f)],
    ["morning", (f) => buildMorningPrompt(morningContent, f)],
  ];

  for (const [name, build] of briefs) {
    describe(name, () => {
      it("carries his facts as a labeled block, with the id he would name to forget one", () => {
        const prompt = build(facts);
        expect(prompt).toContain("## Standing facts — his words");
        expect(prompt).toContain("[7] jeg tar alltid toget til Tønsberg (travel)");
      });

      it("tells her to apply them without being asked — the whole point of storing them", () => {
        expect(normalizeWhitespace(build(facts))).toContain(
          "Apply these without being asked; they are his words.",
        );
      });

      it("drops the block AND its sentence entirely when there are no facts", () => {
        const prompt = build([]);
        expect(prompt).not.toContain("Standing facts");
        expect(prompt).not.toContain("Apply these without being asked");
      });

      it("behaves identically when no facts argument is passed at all", () => {
        expect(build()).toBe(build([]));
      });

      it("leaves the rest of the brief intact", () => {
        // ORB-164's dropped-source block and ORB-165's travel block are siblings, not
        // casualties — this is the assertion that a later block never displaced an earlier one.
        assertNoNegativeAssurance(build(facts));
        expect(normalizeWhitespace(build(facts))).toContain(TONE_RULE);
        expect(build(facts)).toContain("Lars Eriksen");
      });
    });
  }
});

describe("buildRePingPrompt", () => {
  const batch: Obligation[] = [obligation({ isRePing: true, unansweredCount: 3, ageHours: 30 })];

  it("never says nothing is outstanding / no one is waiting", () => {
    assertNoNegativeAssurance(buildRePingPrompt(batch));
  });

  it("carries the tone-rule sentence verbatim (whitespace-normalised)", () => {
    expect(normalizeWhitespace(buildRePingPrompt(batch))).toContain(TONE_RULE);
  });

  it("includes the counterparty and bump-age facts", () => {
    const prompt = buildRePingPrompt(batch);
    expect(prompt).toContain("Lars Eriksen");
    expect(prompt).toContain("30h");
  });
});

// ─── buildWeeklySummaryPrompt (Task 12 fix round — Critical finding) ───────────────────────
// Different tone rule (report warmly, not the obligation guard-rail) — confirmed here only to
// not fabricate claims: it must ground the summary in the listed preferences and instruct a
// report, not an action.

describe("buildWeeklySummaryPrompt", () => {
  const prefs: Pick<PreferenceRow, "text">[] = [
    { text: "Prefers terse Slack replies over long prose" },
    { text: "Reviews contracts before 09:00 Oslo, never after" },
  ];

  it("lists every active preference's text", () => {
    const prompt = buildWeeklySummaryPrompt(prefs);
    expect(prompt).toContain("Prefers terse Slack replies over long prose");
    expect(prompt).toContain("Reviews contracts before 09:00 Oslo, never after");
  });

  it("carries a report-don't-act instruction, not an action prompt", () => {
    const prompt = buildWeeklySummaryPrompt(prefs);
    expect(prompt).toMatch(/report, not/i);
    expect(prompt).toMatch(/take no action and propose nothing/i);
  });

  it("never says nothing is outstanding / no one is waiting", () => {
    assertNoNegativeAssurance(buildWeeklySummaryPrompt(prefs));
  });
});

// ─── makeWeeklySummaryTick gate (Task 12 fix round — Critical finding) ─────────────────────
// Proves the actual gate behaviour with a fully offline fake store/door: empty active
// preferences → zero door.send() calls; non-empty → exactly one send, carrying the preference
// text and the report-don't-act framing.

describe("makeWeeklySummaryTick", () => {
  // ORB-193 — the door now reports whether the message actually went out (the proactivity gate can
  // hold it back). `held` builds the door that says "no".
  function fakeDoor(held = false) {
    const sent: string[] = [];
    return { door: { async send(prompt: string) { sent.push(prompt); return !held; } }, sent };
  }

  it("empty active preferences → sends nothing, and resolves true (a quiet pass is a completed pass — ORB-175)", async () => {
    const { door, sent } = fakeDoor();
    await expect(makeWeeklySummaryTick({ store: { activePreferences: async () => [] }, door }).tick()).resolves.toBe(true);
    expect(sent).toEqual([]);
  });

  it("non-empty active preferences → sends exactly one prompt containing the preference text and the report-don't-act framing", async () => {
    const prefs: PreferenceRow[] = [
      {
        id: "p-1", text: "Prefers terse Slack replies over long prose", kind: "style", subject: "",
        confidence: 0.9, source: null, origin: "agent", valid_from: "2026-08-01T00:00:00Z", valid_to: null,
        superseded_by: null, created_at: "2026-08-01T00:00:00Z",
      },
    ];
    const { door, sent } = fakeDoor();
    await expect(makeWeeklySummaryTick({ store: { activePreferences: async () => prefs }, door }).tick()).resolves.toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Prefers terse Slack replies over long prose");
    expect(sent[0]).toMatch(/report, not/i);
  });

  // ORB-193 — a HELD-BACK send is still a completed pass (the schedule ran and did what the owner's
  // settings asked), unlike a FAILED one below. The distinction is the whole reason the door reports
  // a boolean rather than nothing.
  it("a send the gate held back still resolves true — a suppressed summary is not a dead schedule", async () => {
    const prefs: PreferenceRow[] = [
      {
        id: "p-1", text: "x", kind: "style", subject: "", confidence: 0.9, source: null, origin: "agent",
        valid_from: "2026-08-01T00:00:00Z", valid_to: null, superseded_by: null,
        created_at: "2026-08-01T00:00:00Z",
      },
    ];
    const { door, sent } = fakeDoor(true);
    await expect(
      makeWeeklySummaryTick({ store: { activePreferences: async () => prefs }, door }).tick(),
    ).resolves.toBe(true);
    expect(sent).toHaveLength(1); // the door WAS asked; the gate is what said no
  });

  // ORB-175 fix round 1 (controller ruling) — a failed send is a FAILED pass: tick() must not
  // throw (the caller's schedule survives it), but it must resolve false so the caller does not
  // stamp the heartbeat on a pass that never delivered.
  it("a send that throws does not throw out of tick(), and resolves false", async () => {
    const prefs: PreferenceRow[] = [
      {
        id: "p-1", text: "x", kind: "style", subject: "", confidence: 0.9, source: null, origin: "agent",
        valid_from: "2026-08-01T00:00:00Z", valid_to: null, superseded_by: null,
        created_at: "2026-08-01T00:00:00Z",
      },
    ];
    const door = { async send(): Promise<boolean> { throw new Error("send failed"); } };
    await expect(
      makeWeeklySummaryTick({ store: { activePreferences: async () => prefs }, door }).tick(),
    ).resolves.toBe(false);
  });
});

/**
 * ORB-166 — the organisation clause, asserted on BOTH briefs from one table so the two can never
 * drift apart on it.
 *
 * The shape it exists for: a 16:30 intro call with Connor at Cyrus. `person_lookup` correctly
 * reports UNKNOWN for the PERSON and now also returns an ORGANISATION section naming the notes
 * that hold the relationship — Cyrus is the bridge Ada runs on, self-hosted since May. Without
 * this clause the brief says "first contact, no prior history" and sends him off to research his
 * own vendor.
 */
describe("the organisation clause in the briefs (ORB-166)", () => {
  const eveningContent: BriefContent = { meetings: [meeting()], obligations: [obligation()], picks: [] };
  const morningContent: BriefContent = { meetings: [], obligations: [obligation()], picks: [] };

  const briefs: Array<[string, () => string]> = [
    ["evening", () => buildEveningPrompt(eveningContent)],
    ["morning", () => buildMorningPrompt(morningContent)],
  ];

  for (const [name, build] of briefs) {
    describe(name, () => {
      it("refuses 'no prior history' for an unknown person at a known organisation", () => {
        const prompt = normalizeWhitespace(build());
        expect(prompt).toContain("A lookup that says UNKNOWN is a finding about the PERSON only.");
        expect(prompt).toContain('so this is NOT "no prior history"');
        expect(prompt).toContain(
          "say it is first contact with them, then say what the relationship with the organisation is",
        );
      });

      it("tells her to read the note rather than infer the relationship from its title", () => {
        const prompt = normalizeWhitespace(build());
        expect(prompt).toContain(
          "That section lists NOTES, a store and a path each: read the note before you use it and say only what it says.",
        );
        expect(prompt).toContain("Never infer a relationship from a filename");
      });

      it("sits with the person_lookup instruction, not instead of it", () => {
        const prompt = build();
        expect(prompt).toContain("person_lookup");
        expect(prompt.indexOf("person_lookup")).toBeLessThan(prompt.indexOf("A lookup that says UNKNOWN"));
      });

      it("leaves the rest of the brief intact", () => {
        assertNoNegativeAssurance(build());
        expect(normalizeWhitespace(build())).toContain(TONE_RULE);
        expect(build()).toContain("Lars Eriksen");
      });
    });
  }

  it("is the SAME words in both briefs — one clause, one source", () => {
    const clause = organisationLookupClause().join("\n");
    expect(buildEveningPrompt(eveningContent)).toContain(clause);
    expect(buildMorningPrompt(morningContent)).toContain(clause);
  });
});

/**
 * ORB-167 review fix, Finding 1 — the prompt half. Both tools refuse an app-principal turn
 * outright (tests/standing-facts.test.ts), but a model should be TOLD, not left to discover a
 * refusal: nothing in a brief is something Bendik said, so there is never anything here to
 * remember or retire. The old "no notes" clause named neither tool.
 */
describe("the briefs forbid `remember` and `forget` by name (ORB-167)", () => {
  const eveningContent: BriefContent = { meetings: [meeting()], obligations: [obligation()], picks: [] };
  const morningContent: BriefContent = { meetings: [], obligations: [obligation()], picks: [] };

  const prompts: Array<[string, string]> = [
    ["evening", buildEveningPrompt(eveningContent)],
    ["morning", buildMorningPrompt(morningContent)],
    ["weekly summary", buildWeeklySummaryPrompt([{ text: "he prefers the train" }])],
  ];

  for (const [name, prompt] of prompts) {
    it(`${name}: names both tools in its REPORT ONLY prohibition`, () => {
      const text = normalizeWhitespace(prompt);
      // The MORNING brief names a third (ORB-180 review fix) — its own Frister block prints the
      // `deadline_add` call beside every candidate, so the one prompt that can hand the model that
      // call is the one that has to forbid it by name too.
      expect(text).toContain(
        name === "morning"
          ? "Do not call `remember`, `forget` or `deadline_add`"
          : "Do not call `remember` or `forget`",
      );
      expect(text).toContain("a standing fact is only ever his own words");
    });
  }

  it("morning: the deadline prohibition does not leak the block's own heading into a brief without one", () => {
    // The prohibition is unconditional; the `## Frister` block is not. Naming the heading in the
    // prohibition would put the word in every morning prompt, including the ones with no block —
    // which is exactly what the block's own BYTE-IDENTICAL test forbids.
    expect(buildMorningPrompt(morningContent)).not.toContain("Frister");
  });
});

/**
 * ORB-167 review fix — the organisation clause says "never fill the gap from memory" in the SAME
 * prompt that says "apply these standing facts". A literal reader can take the first as licence
 * to suppress the second when writing about a company; one sentence disambiguates them.
 */
describe("'memory' in the organisation clause is not the standing-facts block (ORB-167)", () => {
  it("says so, in one sentence, in the shared clause both briefs use", () => {
    const clause = normalizeWhitespace(organisationLookupClause().join("\n"));
    expect(clause).toContain("never fill the gap from memory");
    expect(clause).toContain('"Memory" there means your own recollection of the company');
    expect(clause).toContain("His standing facts are not that");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ORB-45 Task 10 (B5) — every obligation line says WHY it is there, and a cross-channel check
// that could not read a source admits it rather than letting the list look complete.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("obligation lines carry a reason (ORB-45 Task 10, B5)", () => {
  const withReason = (reason?: string): BriefContent => ({
    meetings: [],
    obligations: [obligation(reason === undefined ? {} : { reason })],
    picks: [],
  });

  it("morning: the line ends with the reason the item is on the list", () => {
    expect(buildMorningPrompt(withReason("they asked something you have not answered")))
      .toContain("— re: Re: pilot terms — why: they asked something you have not answered");
  });

  it("evening: the same line, from the same shape", () => {
    expect(buildEveningPrompt(withReason("they asked something you have not answered")))
      .toContain("— re: Re: pilot terms — why: they asked something you have not answered");
  });

  it("an item with no reason still says something honest, never nothing", () => {
    expect(buildMorningPrompt(withReason())).toContain("— why: on the radar");
    expect(buildEveningPrompt(withReason())).toContain("— why: on the radar");
  });

  it("morning: names the sources the cross-channel check could not read", () => {
    const prompt = buildMorningPrompt(withReason("could not verify — kept on the radar"), [], undefined, ["calendar", "network"]);
    expect(prompt).toContain("Sources behind that list");
    expect(prompt).toContain("cross-channel check could not read: calendar, network");
  });

  it("evening: the same note, from the same shape", () => {
    const prompt = buildEveningPrompt(withReason(), [], undefined, ["calendar"]);
    expect(prompt).toContain("cross-channel check could not read: calendar");
  });

  it("says nothing about sources when every lookup was readable", () => {
    const prompt = buildMorningPrompt(withReason("they closed the loop"));
    expect(prompt).not.toContain("Sources behind that list");
    expect(prompt).not.toContain("could not read");
  });

  it("morning: a dropped Slack scan AND an unreadable lookup are both disclosed, under one heading", () => {
    const prompt = buildMorningPrompt(
      { meetings: [], obligations: [obligation()], picks: [], slackUnavailable: true },
      [], undefined, ["calendar"],
    );
    expect(prompt.match(/Sources behind that list/g)).toHaveLength(1);
    expect(prompt).toContain("Slack obligations could not be read this morning");
    expect(prompt).toContain("cross-channel check could not read: calendar");
    // ORB-164's lesson: a note the model is not told to pass on is a note he never sees.
    expect(prompt).toContain("could not be read this morning. Say so");
  });

  it("morning: an unreadable lookup ALONE still tells her to say so", () => {
    const prompt = buildMorningPrompt(withReason(), [], undefined, ["network"]);
    expect(prompt).toContain("could not be read this morning. Say so");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ORB-180 Task 4 — the `## Frister` block's POSITION in the morning prompt, and its absence.
//
// Position is the assertion that matters: the block sits under the calendar/clashes/travel and
// ABOVE the "owed a reply" heading, because a statutory due date is a fixed point of his day and
// not something a person is waiting on. Rendered below the obligations it would read as one more
// reply owed — the exact misfiling Workstream B fixes on the other side of the pipeline.
// ═══════════════════════════════════════════════════════════════════════════════════════════

import { deadlinesBlock } from "../lib/brief-content.js";
import type { CandidateLine, DeadlineLine } from "../lib/brief-content.js";

const OWED_HEADING = "New or changed since last night's evening pass — owed a reply:";

const DEADLINE: DeadlineLine = {
  id: "d1",
  entity: "Heiberg Industries AS",
  title: "MVA-melding, 3. termin",
  dueDate: "2026-09-08",
  daysToDue: 0,
  consequence: "Tvangsmulkt per dag og forsinkelsesrenter",
  source: "statutory",
};

const CANDIDATE: CandidateLine = {
  threadId: "t1",
  subject: "MVA-melding 3. termin forfaller 31.08",
  sender: "post@fiken.no",
};

const DEADLINES_CLAUSE =
  "Frister er institusjonelle forfall; gjengi dem som sin egen liste, aldri blandet inn i svar-listen.";

describe("the Frister block in the morning brief (ORB-180)", () => {
  const base: BriefContent = { meetings: [meeting()], obligations: [obligation()], picks: [] };

  it("renders the block, verbatim from deadlinesBlock — the two can never drift", () => {
    const prompt = buildMorningPrompt({ ...base, deadlines: [DEADLINE] }, [], undefined, [], null, { lang: "nb" });
    expect(prompt).toContain(deadlinesBlock([DEADLINE], [], "nb"));
  });

  it("POSITION: after today's calendar and BEFORE the owed-a-reply heading", () => {
    const prompt = buildMorningPrompt({ ...base, deadlines: [DEADLINE] }, [], undefined, [], null, { lang: "nb" });
    const calendar = prompt.indexOf("Today's calendar");
    const frister = prompt.indexOf("## Frister");
    const owed = prompt.indexOf(OWED_HEADING);
    expect(calendar).toBeGreaterThanOrEqual(0);
    expect(frister).toBeGreaterThan(calendar);
    expect(owed).toBeGreaterThan(frister);
  });

  it("a candidate alone still renders the block, in the same place", () => {
    const prompt = buildMorningPrompt({ ...base, deadlineCandidates: [CANDIDATE] }, [], undefined, [], null, { lang: "nb" });
    expect(prompt).toContain("[thread t1]");
    expect(prompt.indexOf("## Frister")).toBeLessThan(prompt.indexOf(OWED_HEADING));
  });

  it("the ONE instruction sentence rides with the block, and only with it", () => {
    expect(buildMorningPrompt({ ...base, deadlines: [DEADLINE] }, [], undefined, [], null, { lang: "nb" })).toContain(DEADLINES_CLAUSE);
    expect(buildMorningPrompt({ ...base, deadlineCandidates: [CANDIDATE] }, [], undefined, [], null, { lang: "nb" })).toContain(DEADLINES_CLAUSE);
    expect(buildMorningPrompt(base, [], undefined, [], null, { lang: "nb" })).not.toContain(DEADLINES_CLAUSE);
  });

  it("the instruction comes AFTER the block it is about", () => {
    const prompt = buildMorningPrompt({ ...base, deadlines: [DEADLINE] }, [], undefined, [], null, { lang: "nb" });
    expect(prompt.indexOf(DEADLINES_CLAUSE)).toBeGreaterThan(prompt.indexOf("## Frister"));
  });

  it("BYTE-IDENTICAL when there is nothing to say: absent fields and empty fields render the same prompt as before", () => {
    const before = buildMorningPrompt(base);
    expect(buildMorningPrompt({ ...base, deadlines: [], deadlineCandidates: [] })).toBe(before);
    expect(before).not.toContain("Frister");
  });

  it("the evening brief gains NOTHING — deadlines are a morning surface only", () => {
    expect(buildEveningPrompt({ ...base, deadlines: [DEADLINE] })).not.toContain("Frister");
  });

  it("still says nothing negative, and still carries the tone rule", () => {
    const prompt = buildMorningPrompt({ ...base, deadlines: [DEADLINE], deadlineCandidates: [CANDIDATE] });
    assertNoNegativeAssurance(prompt);
    expect(normalizeWhitespace(prompt)).toContain(TONE_RULE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ORB-180 Task 4, fix round 1 — WHEN a candidate is stamped, and HOW MANY are offered at once.
//
// Both are schedule-level rules with no I/O in them, which is why they are two exported pure
// functions rather than logic buried in `run()`: the pair "what is rendered" and "what is
// stamped" has to be assertable together, because the whole defect class here is the two
// disagreeing.
// ═══════════════════════════════════════════════════════════════════════════════════════════

import { CANDIDATE_LINES_MAX } from "../lib/brief-content.js";
import { briefCandidateLines, candidatesToStamp } from "../agent/schedules/morning-brief.js";
import type { CandidateRow } from "../lib/deadlines-store.js";

function candidateRow(n: number): CandidateRow {
  return {
    threadId: `t${n}`,
    owner: "bendik",
    subject: `Faktura ${n} forfaller 10.09`,
    sender: "post@fiken.no",
    // The store hands these back `ORDER BY seen_at ASC`; ascending here mirrors that.
    seenAt: new Date(`2026-09-0${n}T08:00:00Z`),
    surfacedAt: null,
    resolution: null,
  };
}

describe("candidatesToStamp — a candidate is stamped on `sent` ONLY (ORB-180 fix 1)", () => {
  const rendered = briefCandidateLines([candidateRow(1), candidateRow(2)]);

  it("a real send stamps exactly what was rendered", () => {
    expect(candidatesToStamp({ sent: true }, rendered)).toEqual(["t1", "t2"]);
  });

  it("THE DEFECT: an alreadySeen outcome stamps NOTHING", () => {
    // The candidate list is recomputed from `unsurfacedCandidates` on every tick, and every tick
    // after the sending one in the same slot comes back `alreadySeen` (`handled === true`). A
    // due notice that arrived in between would be rendered into a prompt nobody receives and
    // then marked offered — a silent, permanent loss. On `sent` only, it simply waits.
    expect(candidatesToStamp({ sent: false }, rendered)).toEqual([]);
  });

  it("a genuine hold (quiet hours, a ceiling) stamps nothing either — the offer rides tomorrow", () => {
    expect(candidatesToStamp({ sent: false }, rendered)).toEqual([]);
  });

  it("a send with nothing rendered stamps nothing — no query for markCandidatesSurfaced to run", () => {
    expect(candidatesToStamp({ sent: true }, [])).toEqual([]);
  });
});

describe("briefCandidateLines — at most CANDIDATE_LINES_MAX per brief (ORB-180 fix 1)", () => {
  const six = [1, 2, 3, 4, 5, 6].map(candidateRow);

  it("the cap is 5", () => {
    expect(CANDIDATE_LINES_MAX).toBe(5);
  });

  it("takes the OLDEST five, in the order the store handed them back", () => {
    expect(briefCandidateLines(six).map((c) => c.threadId)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  it("THE SIXTH IS NEITHER RENDERED NOR STAMPED — it drains on a later morning", () => {
    const rendered = briefCandidateLines(six);
    const prompt = buildMorningPrompt({
      meetings: [meeting()],
      obligations: [obligation()],
      picks: [],
      deadlineCandidates: rendered,
    });
    expect(prompt).toContain("[thread t5]");
    expect(prompt).not.toContain("[thread t6]");
    expect(candidatesToStamp({ sent: true }, rendered)).not.toContain("t6");
  });

  it("a short list is untouched — the cap is a ceiling, not a quota", () => {
    expect(briefCandidateLines([candidateRow(1)]).map((c) => c.threadId)).toEqual(["t1"]);
    expect(briefCandidateLines([])).toEqual([]);
  });

  it("maps the store row onto exactly the three fields the line renders", () => {
    expect(briefCandidateLines([candidateRow(1)])).toEqual([
      { threadId: "t1", subject: "Faktura 1 forfaller 10.09", sender: "post@fiken.no" },
    ]);
  });
});
