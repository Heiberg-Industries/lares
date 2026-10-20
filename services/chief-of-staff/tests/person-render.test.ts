// services/chief-of-staff/tests/person-render.test.ts
// `renderDossier(d, { bounded })`. Pure, no I/O: the fixture below is a
// hand-built PersonDossier, not run through gatherPerson/Docker, because render.ts's job is
// "dossier → text" and that boundary is exactly what these tests hold fixed.
import { describe, it, expect } from "vitest";
import { renderDossier } from "../lib/person/render.js";
import type { PersonDossier, MailItem, MeetingItem, TranscriptItem } from "../lib/person/gather.js";

const d = (s: string) => new Date(s);

const freshMail: MailItem = {
  at: d("2026-08-15T09:00:00Z"), threadId: "t-fresh", subject: "Re: pilot rollout",
  fromThem: true, lastSpeakerIsThem: true,
};
const freshMeeting: MeetingItem = {
  at: d("2026-08-18T10:00:00Z"), eventId: "e-fresh", title: "Pilot check-in", upcoming: true,
};
const freshTranscript: TranscriptItem = {
  at: d("2026-08-16T00:00:00Z"), path: "people/transcripts/2026-08-16-per.md",
  excerpt: "Per said the rollout is on track.",
};
const historyMail: MailItem = {
  at: d("2026-05-01T09:00:00Z"), threadId: "t-old", subject: "Intro",
  fromThem: false, lastSpeakerIsThem: false,
};
const historyMeeting: MeetingItem = {
  at: d("2026-05-05T10:00:00Z"), eventId: "e-old", title: "Kickoff", upcoming: false,
};
const historyTranscript: TranscriptItem = {
  at: d("2026-05-06T00:00:00Z"), path: "people/transcripts/2026-05-06-per.md",
  excerpt: "Per introduced the team.",
};

/** A fixture exercising every optional section renderDossier can produce: matchedLoosely,
 *  setAside, an anchor, owed mail, all three NEW SINCE sections, all three EARLIER sections,
 *  a found company, and — the part `bounded` must never drop — a COULD NOT READ source line. */
const fixture: PersonDossier = {
  query: { name: "Per" },
  resolution: {
    kind: "resolved",
    person: { source: "twenty", sourceId: "p1", displayName: "Per Hansen", emails: ["per@partner.example"] },
    alsoSeenIn: ["other"],
    setAside: [{ source: "other", sourceId: "p9", displayName: "Per Hansen", emails: [] }],
    matchedLoosely: { asked: "Per", matched: "Per Hansen" },
  },
  anchor: { at: d("2026-07-01T00:00:00Z"), kind: "meeting", ref: "e-anchor" },
  fresh: { mail: [freshMail], meetings: [freshMeeting], transcripts: [freshTranscript] },
  history: { mail: [historyMail], meetings: [historyMeeting], transcripts: [historyTranscript] },
  owed: [freshMail],
  sources: {
    crm: { status: "found", source: "crm", data: [] },
    mail: { status: "found", source: "mail", data: [freshMail, historyMail] },
    meetings: { status: "found", source: "meetings", data: [freshMeeting, historyMeeting] },
    // A real gap in OUR reading — bounded must keep this line exactly as-is; it is not
    // history, and it is not something the mode gets to make invisible.
    transcripts: { status: "failed", source: "transcripts", reason: "vault index locked" },
    company: { status: "found", source: "company", data: { name: "Northwind Audio", note: "logistics software" } },
    // — the organisation stage: notes in BOTH stores, plus the CRM company on the domain.
    organisation: {
      status: "found", source: "organisation",
      data: {
        asked: { name: "Northwind Audio", domain: "partner.example" },
        notes: [
          { store: "brain", path: "companies/northwind-audio.md" },
          { store: "atlas", path: "ventures/acme/northwind-pilot.md" },
        ],
        crm: { name: "Northwind Audio AS", domain: "partner.example", orgNumber: "999" },
      },
    },
    identity: { status: "found", source: "identity", data: ["owner@owner.example"] },
  },
};

describe("renderDossier — default (no opts) is unchanged", () => {
  const text = renderDossier(fixture);

  it("keeps the header, MATCHED LOOSELY, ALSO FOUND NOT MERGED, and the anchor line", () => {
    expect(text).toContain("PERSON LOOKUP: Per Hansen");
    expect(text).toContain('MATCHED LOOSELY: you asked for "Per"');
    expect(text).toContain("ALSO FOUND, NOT MERGED: 1 other record(s)");
    expect(text).toContain("Last engagement: 2026-07-01 (meeting).");
  });

  it("keeps YOU OWE A REPLY and all three NEW SINCE sections", () => {
    expect(text).toContain("YOU OWE A REPLY");
    expect(text).toContain("NEW SINCE — mail:");
    expect(text).toContain("NEW SINCE — meetings:");
    expect(text).toContain("NEW SINCE — what was said:");
    expect(text).toContain('"Re: pilot rollout"');
  });

  it("keeps all three EARLIER sections", () => {
    expect(text).toContain("EARLIER — mail:");
    expect(text).toContain("EARLIER — meetings:");
    expect(text).toContain("EARLIER — what was said:");
    expect(text).toContain('"Intro"');
    expect(text).toContain("Kickoff");
  });

  it("keeps COMPANY, Sources consulted with the COULD NOT READ line, and the window note", () => {
    expect(text).toContain("COMPANY — Northwind Audio");
    expect(text).toContain("Sources consulted:");
    expect(text).toContain("- transcripts: COULD NOT READ (vault index locked)");
    expect(text).toContain("Windows searched:");
  });

  it("renderDossier(d) and renderDossier(d, {}) are byte-identical — the opt-in changes nothing by default", () => {
    expect(renderDossier(fixture, {})).toBe(text);
  });
});

describe("renderDossier — bounded: true drops the three EARLIER sections and ORGANISATION (four in all)", () => {
  const text = renderDossier(fixture, { bounded: true });

  it("drops all three EARLIER sections and their content", () => {
    expect(text).not.toContain("EARLIER — mail:");
    expect(text).not.toContain("EARLIER — meetings:");
    expect(text).not.toContain("EARLIER — what was said:");
    expect(text).not.toContain('"Intro"');
    expect(text).not.toContain("Kickoff");
    expect(text).not.toContain("Per introduced the team");
  });

  it("keeps the header, MATCHED LOOSELY, ALSO FOUND NOT MERGED, and the anchor line", () => {
    expect(text).toContain("PERSON LOOKUP: Per Hansen");
    expect(text).toContain('MATCHED LOOSELY: you asked for "Per"');
    expect(text).toContain("ALSO FOUND, NOT MERGED: 1 other record(s)");
    expect(text).toContain("Last engagement: 2026-07-01 (meeting).");
  });

  it("keeps YOU OWE A REPLY and all three NEW SINCE sections", () => {
    expect(text).toContain("YOU OWE A REPLY");
    expect(text).toContain("NEW SINCE — mail:");
    expect(text).toContain("NEW SINCE — meetings:");
    expect(text).toContain("NEW SINCE — what was said:");
    expect(text).toContain('"Re: pilot rollout"');
  });

  it("keeps COMPANY, and Sources consulted WITH the COULD NOT READ line — a gap in reading is not history", () => {
    expect(text).toContain("COMPANY — Northwind Audio");
    expect(text).toContain("Sources consulted:");
    expect(text).toContain("- transcripts: COULD NOT READ (vault index locked)");
  });

  it("keeps the window note and the closing COULD-NOT-READ / not-searchable explainer", () => {
    expect(text).toContain("Windows searched:");
    expect(text).toContain("A source marked COULD NOT READ is a gap in YOUR reading, not an absence in the world.");
  });

  // The subtraction list grew by one. The ORGANISATION section joins the
  // three EARLIER blocks in what bounded removes (its one caller is the outbound email
  // drafter). This assertion is the guard that it removes those FOUR and still nothing else.
  it("bounded output is exactly the default minus the EARLIER blocks and ORGANISATION — nothing else moves", () => {
    const full = renderDossier(fixture);
    const subtracted = full
      .replace(/EARLIER — mail:\n(?:.*\n)*?\n/, "")
      .replace(/EARLIER — meetings:\n(?:.*\n)*?\n/, "")
      .replace(/EARLIER — what was said:\n(?:.*\n)*?\n/, "")
      .replace(/ORGANISATION — (?:.*\n)*?\n/, "");
    expect(text).toBe(subtracted);
  });
});

// ── not-applicable / failed source in a NOT-APPLICABLE-shaped situation still renders a real
// "not searchable this way" line under bounded, same as default (regression guard for the
// sourceLine() four-state distinction surviving the opt-in). ─────────────────────────────────
describe("renderDossier — a not-applicable source line survives bounded too", () => {
  const notApplicableFixture: PersonDossier = {
    ...fixture,
    sources: {
      ...fixture.sources,
      transcripts: { status: "not-applicable", source: "transcripts", reason: "no vault query for a bare email" },
    },
  };

  it("default keeps the not-applicable line", () => {
    expect(renderDossier(notApplicableFixture)).toContain("- transcripts: not searchable this way (no vault query for a bare email)");
  });

  it("bounded keeps the not-applicable line too", () => {
    expect(renderDossier(notApplicableFixture, { bounded: true }))
      .toContain("- transcripts: not searchable this way (no vault query for a bare email)");
  });
});

// ── ambiguous / unknown branches are unchanged in both modes ──────────────────────────────
describe("renderDossier — ambiguous and unknown branches ignore bounded entirely", () => {
  const ambiguous: PersonDossier = {
    ...fixture,
    resolution: {
      kind: "ambiguous",
      candidates: [
        { source: "twenty", sourceId: "p1", displayName: "Per Hansen", emails: ["per@partner.example"] },
        { source: "twenty", sourceId: "p2", displayName: "Per Hansen", emails: ["per@other.co"] },
      ],
      question: "Which Per Hansen did you mean — per@partner.example or per@other.co?",
    },
  };

  it("ambiguous: default and bounded render byte-identically", () => {
    expect(renderDossier(ambiguous, { bounded: true })).toBe(renderDossier(ambiguous));
    expect(renderDossier(ambiguous)).toContain("PERSON LOOKUP — AMBIGUOUS");
  });

  const unknown: PersonDossier = {
    ...fixture,
    resolution: { kind: "unknown" },
    sources: {
      ...fixture.sources,
      crm: { status: "empty", source: "crm" },
    },
  };

  it("unknown: default and bounded render byte-identically", () => {
    expect(renderDossier(unknown, { bounded: true })).toBe(renderDossier(unknown));
    expect(renderDossier(unknown)).toContain("PERSON LOOKUP — UNKNOWN");
  });
});

/**
 * — the ORGANISATION section. Two audiences, and the second is the one the ticket exists
 * for: a RESOLVED person whose company the stores know, and an UNKNOWN address where "no record
 * of the person" is right and "you know nothing about them" is not.
 */
describe("renderDossier — the Organisation section", () => {
  it("names every hit with its store and its path, and the CRM company on the domain", () => {
    const text = renderDossier(fixture);
    expect(text).toContain("ORGANISATION — Northwind Audio — partner.example:");
    expect(text).toContain("- brain: companies/northwind-audio.md");
    expect(text).toContain("- atlas: ventures/acme/northwind-pilot.md");
    expect(text).toContain("- CRM: Northwind Audio AS (partner.example), org no 999");
    expect(text).toContain("- organisation: read OK");
  });

  it("says the hits are notes to READ, not facts to restate", () => {
    const text = renderDossier(fixture);
    expect(text).toContain("These are NOTES, not findings");
    expect(text).toContain("Read the note (Brain or Atlas, per the marker) before you rely on it");
    expect(text).toContain("Never restate a path as a fact");
  });

  /**
   * The ONE bounded caller is the outbound email drafter
   * (agent/schedules/email-triage.ts), whose prompt writes a reply to an external counterparty.
   * Internal vault paths, CRM org numbers and "go read these notes" are exactly what
   * introduced `bounded` to keep out of that prompt.
   */
  it("is DROPPED under bounded — the outbound drafter must not carry internal vault paths", () => {
    const text = renderDossier(fixture, { bounded: true });
    expect(text).not.toContain("ORGANISATION — ");
    expect(text).not.toContain("companies/northwind-audio.md");
    expect(text).not.toContain("ventures/acme/northwind-pilot.md");
    expect(text).not.toContain("org no 999");
    expect(text).not.toContain("These are NOTES, not findings");
  });

  it("but the SOURCE LINE survives bounded — a gap in our reading is never hidden", () => {
    // Same rule the rest of "Sources consulted" already follows: the line names no path and
    // leaks nothing, and dropping it would let a broken store pass as a quiet one.
    expect(renderDossier(fixture, { bounded: true })).toContain("- organisation: read OK");
    expect(
      renderDossier(
        {
          ...fixture,
          sources: {
            ...fixture.sources,
            organisation: { status: "failed", source: "organisation", reason: "ATLAS_PATH is unset" },
          },
        },
        { bounded: true },
      ),
    ).toContain("- organisation: COULD NOT READ (ATLAS_PATH is unset)");
  });

  it("unbounded still includes it — the difference is the caller, not the dossier", () => {
    expect(renderDossier(fixture)).toContain("ORGANISATION — Northwind Audio — partner.example:");
    expect(renderDossier(fixture)).toContain("- brain: companies/northwind-audio.md");
  });

  it("a store that could not be read is COULD NOT READ, never 'nothing found'", () => {
    const text = renderDossier({
      ...fixture,
      sources: {
        ...fixture.sources,
        organisation: { status: "failed", source: "organisation", reason: "atlas is not configured: ATLAS_PATH is unset" },
      },
    });
    expect(text).toContain("- organisation: COULD NOT READ (atlas is not configured: ATLAS_PATH is unset)");
    expect(text).not.toContain("- organisation: nothing found");
    expect(text).not.toContain("ORGANISATION — ");
  });

  it("a personal mailbox is 'not searchable this way', and prints no heading over a non-question", () => {
    const text = renderDossier({
      ...fixture,
      sources: {
        ...fixture.sources,
        organisation: {
          status: "not-applicable", source: "organisation",
          reason: "no organisation to look up: a personal mailbox with no company on file is not a company",
        },
      },
    });
    expect(text).toContain("- organisation: not searchable this way (no organisation to look up");
    expect(text).not.toContain("ORGANISATION — ");
    // The exact words the ticket forbids.
    expect(text).not.toMatch(/company unknown/i);
  });
});

/** The Dana shape: a first-contact address, no person anywhere — and a company the Brain
 *  knows. The dossier that produced "worth a quick look at Bridgeco" had no way to say this. */
describe("renderDossier — UNKNOWN person, KNOWN organisation", () => {
  const unknownDana: PersonDossier = {
    query: { email: "dana@atbridgeco.example" },
    resolution: { kind: "unknown" },
    anchor: null,
    fresh: { mail: [], meetings: [], transcripts: [] },
    history: { mail: [], meetings: [], transcripts: [] },
    owed: [],
    sources: {
      crm: { status: "empty", source: "crm" },
      mail: { status: "empty", source: "mail" },
      meetings: { status: "empty", source: "meetings" },
      transcripts: { status: "empty", source: "transcripts" },
      company: { status: "empty", source: "company" },
      organisation: {
        status: "found", source: "organisation",
        data: {
          asked: { domain: "atbridgeco.example" },
          notes: [{ store: "brain", path: "tools/bridgeco-tracker-bridge.md" }],
        },
      },
      identity: { status: "found", source: "identity", data: ["owner@owner.example"] },
    },
  };

  it("still reports no record of the PERSON", () => {
    const text = renderDossier(unknownDana);
    expect(text).toContain("PERSON LOOKUP — UNKNOWN: dana@atbridgeco.example");
    expect(text).toContain("No record in the CRM.");
  });

  it("names the organisation and the note behind it, and refuses 'no prior history'", () => {
    const text = renderDossier(unknownDana);
    expect(text).toContain("You do know their ORGANISATION, though");
    expect(text).toContain("that is NOT the same as no prior");
    expect(text).toContain("ORGANISATION — atbridgeco.example:");
    expect(text).toContain("- brain: tools/bridgeco-tracker-bridge.md");
    expect(text).toContain("- organisation: read OK");
  });

  it("adds nothing when the organisation stage found nothing either", () => {
    const text = renderDossier({
      ...unknownDana,
      sources: { ...unknownDana.sources, organisation: { status: "empty", source: "organisation" } },
    });
    expect(text).not.toContain("You do know their ORGANISATION");
    expect(text).toContain("- organisation: nothing found");
  });
});
