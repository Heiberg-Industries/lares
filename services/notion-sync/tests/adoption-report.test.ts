// The adoption report. Report only, zero
// writes: this engine reads two lists and returns buckets, and never gets the
// chance to do anything else — see lib/adoption-report.ts's header for why that is
// a property of the TYPE, and the forbidden-import test at the bottom of this file
// for the proof (the precedent is archive-excluded.ts).
//
// Every filename fixture below follows the shape of real exported vault filenames
// (invented names, real structure) — this is deliberate. A matcher that only ever
// sees filenames an author made easy is not proof it survives a real vault.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  runAdoptionReport, parseVaultFilename,
  type AdoptionMeetingRow, type AdoptionReportDeps,
} from "../lib/adoption-report.js";

function meeting(over: Partial<AdoptionMeetingRow> = {}): AdoptionMeetingRow {
  return {
    pageId: "default-page-id",
    title: "Default Meeting",
    project: "acme",
    startsAt: "2026-01-01T09:00:00.000+01:00",
    ...over,
  };
}

function makeDeps(meetings: AdoptionMeetingRow[], vaultPaths: string[]): AdoptionReportDeps {
  return {
    queryMeetings: async () => meetings,
    listVaultFiles: async () => vaultPaths,
  };
}

/** Every count the report promises, cross-checked against the result's own arrays —
 *  not just `summary`'s text, so a bug that corrupts the ARRAYS while leaving the
 *  string plausible-looking cannot pass silently. Four buckets: title-only is split
 *  out of confident. */
function assertCountsAddUp(result: Awaited<ReturnType<typeof runAdoptionReport>>): void {
  const ambiguousMeetings = result.ambiguous.reduce((n, g) => n + g.meetings.length, 0);
  const ambiguousFiles = result.ambiguous.reduce((n, g) => n + g.vaultPaths.length, 0);
  expect(result.confident.length + result.titleOnly.length + ambiguousMeetings + result.unmatchedMeetings.length)
    .toBe(result.totalMeetings);
  expect(result.confident.length + result.titleOnly.length + ambiguousFiles + result.unmatchedFiles.length)
    .toBe(result.totalVaultFiles);
}

describe("parseVaultFilename — the real, messy filenames", () => {
  it("the tidy <date>-<slug> shape", () => {
    expect(parseVaultFilename("acme/transcripts/2026-03-25-sample-review.md")).toEqual({
      vaultPath: "acme/transcripts/2026-03-25-sample-review.md",
      date: "2026-03-25",
      titleSlug: "sample-review",
      pageIdHex: null,
    });
  });

  it("a raw Notion export: title, @Today HH MM, a trailing 32-hex page id", () => {
    expect(parseVaultFilename(
      "acme/transcripts/Owen & Dana @Today 13 00 00000000000040008000000000000003.md",
    )).toEqual({
      vaultPath: "acme/transcripts/Owen & Dana @Today 13 00 00000000000040008000000000000003.md",
      date: null,
      titleSlug: "owen-dana",
      pageIdHex: "00000000000040008000000000000003",
    });
  });

  it("an em dash and a double space before a time with no minutes", () => {
    const path = "acme/transcripts/Intro call — Robin Example @Today 10  " +
      "00000000000040008000000000000007.md";
    expect(parseVaultFilename(path)).toEqual({
      vaultPath: path,
      date: null,
      titleSlug: "intro-call-robin-example",
      pageIdHex: "00000000000040008000000000000007",
    });
  });

  it("non-ASCII and a stray comma-space, no date and no page id", () => {
    const path = "Example Company/transcripts/Sample Notion - Owen Example, Ivo , Åshild.md";
    expect(parseVaultFilename(path)).toEqual({
      vaultPath: path,
      date: null,
      titleSlug: "sample-notion-owen-example-ivo-aashild",
      pageIdHex: null,
    });
  });

  it("a hand-tidied slug that kept its trailing time-of-day fragment", () => {
    expect(parseVaultFilename("acme/transcripts/owen-example-and-jamie-sample-12-00.md")).toEqual({
      vaultPath: "acme/transcripts/owen-example-and-jamie-sample-12-00.md",
      date: null,
      titleSlug: "owen-example-and-jamie-sample",
      pageIdHex: null,
    });
  });

  it("a nested path — analysis/analysis.md two deep — parses from the BASENAME only, no crash", () => {
    expect(parseVaultFilename("acme/transcripts/analysis/analysis.md")).toEqual({
      vaultPath: "acme/transcripts/analysis/analysis.md",
      date: null,
      titleSlug: "analysis",
      pageIdHex: null,
    });
  });

  it("a filename that is NOTHING but the bare 32-hex id (no title, no separator)", () => {
    // TRAILING_PAGE_ID requires a separator BEFORE the id; a bare-id filename has
    // no character left for one. Confirmed live against the un-fixed engine: this
    // used to come back with pageIdHex: null.
    expect(parseVaultFilename("acme/transcripts/00000000000040008000000000000003.md")).toEqual({
      vaultPath: "acme/transcripts/00000000000040008000000000000003.md",
      date: null,
      titleSlug: "",
      pageIdHex: "00000000000040008000000000000003",
    });
  });

  it("NFC and NFD byte encodings of the same filename parse to the IDENTICAL titleSlug", () => {
    // The server is Linux, the owner's clone is macOS — the same logical filename can
    // arrive as different bytes. Constructed here rather than pasted, so the test
    // itself proves the two forms are byte-different before proving they compare equal.
    const nfc = "Example Company/transcripts/Sample Notion - Owen Example, Ivo , Åshild.md".normalize("NFC");
    const nfd = nfc.normalize("NFD");
    expect(nfc).not.toBe(nfd); // sanity: the fixture actually exercises two different byte strings
    expect(parseVaultFilename(nfc).titleSlug).toBe(parseVaultFilename(nfd).titleSlug);
    expect(parseVaultFilename(nfc).date).toBe(parseVaultFilename(nfd).date);
  });
});

describe("runAdoptionReport — matching rules, over the real filenames", () => {
  it("CONFIDENT: an exact page-id match — strictly better than fuzzy date+title", async () => {
    const PAGE = "00000000-0000-4000-8000-000000000003"; // dashed, as Notion's API returns it
    const PATH = "acme/transcripts/Owen & Dana @Today 13 00 00000000000040008000000000000003.md";
    const deps = makeDeps(
      [meeting({ pageId: PAGE, title: "Owen & Dana", startsAt: null })],
      [PATH],
    );
    const result = await runAdoptionReport(deps);

    expect(result.confident).toEqual([{
      pageId: PAGE, title: "Owen & Dana", date: null, project: "acme",
      vaultPath: PATH, basis: "page-id",
      reason: "the filename embeds this meeting's Notion page id (00000000000040008000000000000003)",
    }]);
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatchedMeetings).toEqual([]);
    expect(result.unmatchedFiles).toEqual([]);
    expect(result.summary).toContain("1 Meetings rows, 1 vault files");
    expect(result.summary).toContain("1 confident");
    assertCountsAddUp(result);
  });

  it("CONFIDENT: an em-dash, double-space, no-minutes raw export — page id still matches", async () => {
    const PAGE = "00000000-0000-4000-8000-000000000007";
    const PATH = "acme/transcripts/Intro call — Robin Example @Today 10  " +
      "00000000000040008000000000000007.md";
    const deps = makeDeps(
      [meeting({ pageId: PAGE, title: "Intro call — Robin Example", startsAt: null })],
      [PATH],
    );
    const result = await runAdoptionReport(deps);

    expect(result.confident).toHaveLength(1);
    expect(result.confident[0].basis).toBe("page-id");
    expect(result.confident[0].vaultPath).toBe(PATH);
    assertCountsAddUp(result);
  });

  it("CONFIDENT: the tidy <date>-<slug> shape agrees on date AND title, with no competing candidate", async () => {
    const deps = makeDeps(
      [meeting({ pageId: "p-tidy", title: "Sample Review", startsAt: "2026-03-25T14:00:00.000+01:00" })],
      ["acme/transcripts/2026-03-25-sample-review.md"],
    );
    const result = await runAdoptionReport(deps);

    expect(result.confident).toEqual([{
      pageId: "p-tidy", title: "Sample Review", date: "2026-03-25", project: "acme",
      vaultPath: "acme/transcripts/2026-03-25-sample-review.md",
      basis: "date-title",
      reason: 'date 2026-03-25 and title slug "sample-review" both match exactly',
    }]);
    assertCountsAddUp(result);
  });

  it("TITLE-ONLY, a SEPARATE bucket from Confident: no date on either side to corroborate", async () => {
    // The Sample Co file carries no date and no page id — title is the only signal.
    // This must NOT land in `confident` (that bucket is meant to be
    // skimmed and trusted without opening a file, and a title-only match can be
    // a genuine false positive — see the "false positive" test below, executed
    // against this same engine). It must still be reported, not
    // hidden — just in its own bucket, visibly lower-trust.
    const PATH = "Example Company/transcripts/Sample Notion - Owen Example, Ivo , Åshild.md";
    const deps = makeDeps(
      [meeting({
        pageId: "p-semway", title: "Sample Notion - Owen Example, Ivo , Åshild",
        project: "Example Company", startsAt: null,
      })],
      [PATH],
    );
    const result = await runAdoptionReport(deps);

    expect(result.confident).toEqual([]);
    expect(result.titleOnly).toHaveLength(1);
    expect(result.titleOnly[0].basis).toBe("title-only");
    expect(result.titleOnly[0].vaultPath).toBe(PATH);
    expect(result.titleOnly[0].reason).toContain("neither side carries a date");
    assertCountsAddUp(result);
  });

  it("the exact false positive: a generic title prefix-matching an unrelated file", async () => {
    // A short, generic meeting title ("Board Sync") prefix-
    // matching an entirely unrelated personal notes file, with no competing
    // candidate on either side — before the fix this landed in `confident`,
    // skimmable-and-trustable, which is exactly wrong for a coincidental match.
    const deps = makeDeps(
      [meeting({ pageId: "m-boardsync", title: "Board Sync", startsAt: null })],
      ["acme/transcripts/board-sync-notes-from-last-quarter-planning-doc.md"],
    );
    const result = await runAdoptionReport(deps);

    expect(result.confident).toEqual([]);
    expect(result.titleOnly).toEqual([{
      pageId: "m-boardsync", title: "Board Sync", date: null, project: "acme",
      vaultPath: "acme/transcripts/board-sync-notes-from-last-quarter-planning-doc.md",
      basis: "title-only",
      reason: 'title slug "board-sync" matches; neither side carries a date to corroborate it',
    }]);
    assertCountsAddUp(result);
  });

  it("AMBIGUOUS: the same meeting in two files, two naming styles — never a silent pick", async () => {
    const PAGE = "00000000-0000-4000-8000-000000000006";
    const TIDY = "acme/transcripts/owen-example-and-jamie-sample-12-00.md";
    const RAW = "acme/transcripts/Owen Example and Jamie Sample @Today 12 00 00000000000040008000000000000006.md";
    const deps = makeDeps(
      [meeting({ pageId: PAGE, title: "Owen Example and Jamie Sample", startsAt: null })],
      [TIDY, RAW],
    );
    const result = await runAdoptionReport(deps);

    // Never silently resolved to the stronger (page-id) candidate — BOTH files
    // must appear together as one decision for the owner, not as a confident row plus
    // a separately-reported orphan file.
    expect(result.confident).toEqual([]);
    expect(result.unmatchedFiles).toEqual([]);
    expect(result.unmatchedMeetings).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    const group = result.ambiguous[0];
    expect(group.meetings).toEqual([
      { pageId: PAGE, title: "Owen Example and Jamie Sample", date: null, project: "acme" },
    ]);
    expect(group.vaultPaths).toEqual([RAW, TIDY].sort());
    expect(group.candidates).toHaveLength(2);
    // Every candidate is shown with why it matched — one exact, one fuzzy.
    const byPath = new Map(group.candidates.map((c) => [c.vaultPath, c]));
    expect(byPath.get(RAW)?.basis).toBe("page-id");
    expect(byPath.get(TIDY)?.basis).toBe("title-only");
    assertCountsAddUp(result);
  });

  it("AMBIGUOUS: symmetric case — one file, two meetings whose titles slug the same on the same day", async () => {
    const PATH = "acme/transcripts/2026-04-01-weekly-sync.md";
    const deps = makeDeps(
      [
        meeting({ pageId: "p-a", title: "Weekly Sync", startsAt: "2026-04-01T09:00:00.000+02:00" }),
        meeting({ pageId: "p-b", title: "Weekly Sync", startsAt: "2026-04-01T15:00:00.000+02:00" }),
      ],
      [PATH],
    );
    const result = await runAdoptionReport(deps);

    expect(result.confident).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0].meetings.map((m) => m.pageId).sort()).toEqual(["p-a", "p-b"]);
    expect(result.ambiguous[0].vaultPaths).toEqual([PATH]);
    expect(result.ambiguous[0].candidates).toHaveLength(2);
    assertCountsAddUp(result);
  });

  it("a page-id match reaches Confident even when an UNRELATED meeting's stray fuzzy edge touches a shared file", async () => {
    // The adversarial case:
    // M1 "Weekly Sync" exact-title-matches F1 "weekly-sync.md". M2 "Weekly Sync
    // Notes For September Board Update" carries its OWN page id (a different,
    // real file F2) but its long title also happens to prefix-start with F1's
    // slug, giving M2 a second, spurious fuzzy edge to F1. Plain union-find
    // merged all four into one Ambiguous group, burying M2's clean id match. The
    // fix: F2 is uncontested and M2's only OTHER neighbour (F1) has its own real
    // owner (M1) already, so M2 is safe to settle on its own — M1/F1 settle
    // separately, with nothing left over to be ambiguous about.
    //
    // F2's cosmetic title-portion is deliberately unrelated to "weekly sync" —
    // the page-id check runs FIRST and does not care what the filename's text
    // says, so this still proves the id-vs-fuzzy priority without also (by
    // accident) giving M1 a second, unintended fuzzy edge to F2: M1's slug
    // "weekly-sync" is not a prefix of F2's slug, and vice versa, so the ONLY
    // edge touching F2 is the real page-id one.
    const M1 = meeting({ pageId: "m-weekly-sync", title: "Weekly Sync", startsAt: null });
    const M2 = meeting({
      pageId: "00000000-0000-4000-8000-000000000006", title: "Weekly Sync Notes For September Board Update",
      startsAt: null,
    });
    const F1 = "acme/transcripts/weekly-sync.md";
    const F2 = "acme/transcripts/September Board Materials @Today 10 00 00000000000040008000000000000006.md";
    const deps = makeDeps([M1, M2], [F1, F2]);
    const result = await runAdoptionReport(deps);

    expect(result.ambiguous).toEqual([]); // the whole point: no leftover noise
    expect(result.confident).toEqual([{
      pageId: "00000000-0000-4000-8000-000000000006", title: "Weekly Sync Notes For September Board Update",
      date: null, project: "acme", vaultPath: F2, basis: "page-id",
      reason: "the filename embeds this meeting's Notion page id (00000000000040008000000000000006)",
    }]);
    expect(result.titleOnly).toEqual([{
      pageId: "m-weekly-sync", title: "Weekly Sync", date: null, project: "acme",
      vaultPath: F1, basis: "title-only",
      reason: 'title slug "weekly-sync" matches; neither side carries a date to corroborate it',
    }]);
    assertCountsAddUp(result);
  });

  it("a page-id CONFLICT (two files embedding the same id) is never silently resolved either way", async () => {
    // Pathological — real Notion page ids don't collide — but the peeling rule
    // has to not silently pick a winner if it ever happens (e.g. a botched
    // duplicate export). Both files claim the same meeting's id; neither is safe
    // to extract (each would strand the other), so both stay together as one
    // Ambiguous pairing for a human to look at.
    const M = meeting({ pageId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "Duplicate Export", startsAt: null });
    const F1 = "acme/transcripts/Duplicate Export @Today 10 00 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md";
    const F2 = "acme/transcripts/Duplicate Export copy @Today 10 00 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md";
    const result = await runAdoptionReport(makeDeps([M], [F1, F2]));

    expect(result.confident).toEqual([]);
    expect(result.titleOnly).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0].vaultPaths).toEqual([F1, F2].sort());
    expect(result.ambiguous[0].candidates.every((c) => c.basis === "page-id")).toBe(true);
    assertCountsAddUp(result);
  });

  it("peeling runs to a FIXPOINT: one safe extraction can make a second one safe", async () => {
    // M1's page-id file F1 is uncontested, but M1 ALSO has a stray fuzzy edge to
    // F2 — and F2 is M2's OWN page-id file. On the first pass M2-F2 looks
    // contested (both M1's fuzzy edge and M2's page-id edge point at it) and is
    // not yet safe. Extracting M1 (safe on pass 1: its only other neighbour F2
    // has another claimant, M2) drops M1's edges entirely, which frees F2 down to
    // one remaining edge — making M2 safe on the NEXT pass. A single, non-looping
    // pass would leave M2 stuck in a 2-meeting/1-file group with M1 gone from
    // under it. Both must resolve, cleanly, to two independent Confident rows.
    //
    // F1's cosmetic title ("Alpha Kickoff") is unrelated to "Beta" on purpose, so
    // the ONLY edge touching F1 is M1's own page-id one — the fixture isolates
    // the ONE stray edge (M1 -> F2) the test is actually about.
    const M1 = meeting({
      pageId: "00000000-0000-4000-8000-000000000003", title: "Beta Kickoff Extra", startsAt: null,
    });
    const M2 = meeting({
      pageId: "00000000-0000-4000-8000-000000000007", title: "Beta Kickoff", startsAt: null,
    });
    const F1 = "acme/transcripts/Alpha Kickoff @Today 09 00 00000000000040008000000000000003.md";
    // F2 is M2's real page-id file. M1's title "Beta Kickoff Extra" slugs to
    // "beta-kickoff-extra", which is F2's OWN slug ("beta-kickoff") plus a
    // "-extra" tail — the prefix rule's other direction — giving M1 a stray
    // fuzzy edge here without M1 owning this file.
    const F2 = "acme/transcripts/Beta Kickoff @Today 10 00 00000000000040008000000000000007.md";
    const result = await runAdoptionReport(makeDeps([M1, M2], [F1, F2]));

    expect(result.ambiguous).toEqual([]);
    expect(result.titleOnly).toEqual([]);
    expect(result.confident.map((c) => c.pageId).sort()).toEqual([M1.pageId, M2.pageId].sort());
    expect(result.confident.find((c) => c.pageId === M1.pageId)?.vaultPath).toBe(F1);
    expect(result.confident.find((c) => c.pageId === M2.pageId)?.vaultPath).toBe(F2);
    assertCountsAddUp(result);
  });

  it("a meeting title arriving in NFD Unicode still matches a correctly-NFC'd vault file", async () => {
    // transcriptSlug(NFC "Åshild") transliterates å->"aa" and
    // produces "...aashild", but transcriptSlug(NFD "Åshild") never sees the
    // precomposed "å" codepoint the transliteration table keys on (NFD spells it
    // as bare "a" + a separate combining ring), so the mark is simply stripped
    // and the result is "...ashild" — one fewer "a", a different slug for the
    // identical name. Notion's API has no documented normal-form guarantee.
    const nfdTitle = "Åshild Check-in".normalize("NFD");
    const nfcPath = "Example Company/transcripts/Åshild Check-in.md".normalize("NFC");
    expect(nfdTitle).not.toBe("Åshild Check-in".normalize("NFC")); // sanity: genuinely different bytes
    const deps = makeDeps(
      [meeting({ pageId: "m-aashild", title: nfdTitle, project: "Example Company", startsAt: null })],
      [nfcPath],
    );
    const result = await runAdoptionReport(deps);

    expect(result.unmatchedMeetings).toEqual([]);
    expect(result.unmatchedFiles).toEqual([]);
    expect(result.titleOnly).toHaveLength(1);
    expect(result.titleOnly[0].vaultPath).toBe(nfcPath);
    assertCountsAddUp(result);
  });

  it("a file whose name embeds an id-shaped token that matches NO Meetings row is flagged, not silent", async () => {
    const path = "acme/transcripts/Some Old Meeting @Today 10 00 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md";
    const deps = makeDeps(
      [meeting({ pageId: "m-unrelated", title: "Something Completely Different", startsAt: null })],
      [path],
    );
    const result = await runAdoptionReport(deps);

    expect(result.unmatchedFiles).toEqual([{
      vaultPath: path, parsedDate: null, parsedTitleSlug: "some-old-meeting",
      parsedPageIdHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }]);
    assertCountsAddUp(result);
  });

  it("UNMATCHED: a Meetings row with no vault file at all", async () => {
    const deps = makeDeps(
      [meeting({ pageId: "p-lonely", title: "Nobody wrote this one down", startsAt: "2026-05-01T09:00:00.000+02:00" })],
      [],
    );
    const result = await runAdoptionReport(deps);

    expect(result.confident).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatchedMeetings).toEqual([{
      pageId: "p-lonely", title: "Nobody wrote this one down", date: "2026-05-01", project: "acme",
    }]);
    expect(result.unmatchedFiles).toEqual([]);
    assertCountsAddUp(result);
  });

  it("UNMATCHED: a vault file with no Meetings row — the nested analysis/analysis.md, and a plain orphan", async () => {
    const deps = makeDeps(
      [meeting({ pageId: "p-unrelated", title: "Something Else Entirely", startsAt: "2026-06-01T09:00:00.000+02:00" })],
      ["acme/transcripts/analysis/analysis.md", "example-service/transcripts/2026-01-01-orphan-call.md"],
    );
    const result = await runAdoptionReport(deps);

    expect(result.confident).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatchedMeetings).toEqual([{
      pageId: "p-unrelated", title: "Something Else Entirely", date: "2026-06-01", project: "acme",
    }]);
    expect(result.unmatchedFiles).toEqual([
      {
        vaultPath: "acme/transcripts/analysis/analysis.md", parsedDate: null,
        parsedTitleSlug: "analysis", parsedPageIdHex: null,
      },
      {
        vaultPath: "example-service/transcripts/2026-01-01-orphan-call.md", parsedDate: "2026-01-01",
        parsedTitleSlug: "orphan-call", parsedPageIdHex: null,
      },
    ]);
    assertCountsAddUp(result);
  });

  it("NEVER a candidate: titles agree but the dates conflict — reported as unmatched on both sides, not as a weak match", async () => {
    const deps = makeDeps(
      [meeting({ pageId: "p-standup", title: "Standup", startsAt: "2026-01-02T09:00:00.000+01:00" })],
      ["acme/transcripts/2026-01-01-standup.md"],
    );
    const result = await runAdoptionReport(deps);

    expect(result.confident).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatchedMeetings.map((m) => m.pageId)).toEqual(["p-standup"]);
    expect(result.unmatchedFiles.map((f) => f.vaultPath)).toEqual(["acme/transcripts/2026-01-01-standup.md"]);
    assertCountsAddUp(result);
  });

  it("NEVER a candidate: dates agree but titles do not — a bare date match is not evidence", async () => {
    const deps = makeDeps(
      [meeting({ pageId: "p-x", title: "Completely Different Subject", startsAt: "2026-07-01T09:00:00.000+02:00" })],
      ["acme/transcripts/2026-07-01-unrelated-topic.md"],
    );
    const result = await runAdoptionReport(deps);

    expect(result.confident).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatchedMeetings).toHaveLength(1);
    expect(result.unmatchedFiles).toHaveLength(1);
    assertCountsAddUp(result);
  });

  it("an untitled meeting (empty slug) never falsely matches an untitled/unreadable file", async () => {
    const deps = makeDeps(
      [meeting({ pageId: "p-blank", title: "   ", startsAt: "2026-08-01T09:00:00.000+02:00" })],
      ["acme/transcripts/2026-08-01-.md"],
    );
    const result = await runAdoptionReport(deps);
    // Neither side is silently paired just because both slug down to "".
    expect(result.confident).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    assertCountsAddUp(result);
  });

  it("the whole shape at a workable scale: every green-bar fixture together, counts add up exactly", async () => {
    const meetings: AdoptionMeetingRow[] = [
      meeting({ pageId: "p1", title: "Owen & Dana", startsAt: null }), // page-id
      meeting({ pageId: "p2", title: "Sample Review", startsAt: "2026-03-25T14:00:00.000+01:00" }), // date-title
      meeting({ pageId: "p3", title: "Owen Example and Jamie Sample", startsAt: null }), // ambiguous (2 files)
      meeting({ pageId: "p4", title: "Sample Notion - Owen Example, Ivo , Åshild", startsAt: null, project: "Example Company" }), // title-only
      meeting({ pageId: "p5", title: "Nobody wrote this one down", startsAt: "2026-05-01T09:00:00.000+02:00" }), // unmatched meeting
    ];
    const vaultFiles = [
      "acme/transcripts/Owen & Dana @Today 13 00 00000000000040008000000000000003.md",
      "acme/transcripts/2026-03-25-sample-review.md",
      "acme/transcripts/owen-example-and-jamie-sample-12-00.md",
      "acme/transcripts/Owen Example and Jamie Sample @Today 12 00 00000000000040008000000000000006.md",
      "Example Company/transcripts/Sample Notion - Owen Example, Ivo , Åshild.md",
      "acme/transcripts/analysis/analysis.md", // unmatched file, nested two deep
    ];
    // p1's page id must be embedded in its own file for the page-id class to fire —
    // wired to match the filename's embedded hex exactly (dashes stripped, case-folded).
    meetings[0].pageId = "00000000-0000-4000-8000-000000000003";
    meetings[2].pageId = "00000000-0000-4000-8000-000000000006";

    const result = await runAdoptionReport(makeDeps(meetings, vaultFiles));

    expect(result.totalMeetings).toBe(5);
    expect(result.totalVaultFiles).toBe(6);
    // The Sample Co meeting is title-only (no date on either side) and
    // now lands in its OWN bucket, not confident — see the dedicated test above
    // for why (a title-only match can be a genuine false positive).
    expect(result.confident.map((c) => c.vaultPath).sort()).toEqual([
      "acme/transcripts/2026-03-25-sample-review.md",
      "acme/transcripts/Owen & Dana @Today 13 00 00000000000040008000000000000003.md",
    ].sort());
    expect(result.confident).toHaveLength(2);
    expect(result.titleOnly.map((c) => c.vaultPath)).toEqual([
      "Example Company/transcripts/Sample Notion - Owen Example, Ivo , Åshild.md",
    ]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0].meetings.map((m) => m.pageId)).toEqual(["00000000-0000-4000-8000-000000000006"]);
    expect(result.unmatchedMeetings.map((m) => m.pageId)).toEqual(["p5"]);
    expect(result.unmatchedFiles.map((f) => f.vaultPath)).toEqual(["acme/transcripts/analysis/analysis.md"]);

    // The literal accounting: every input on both sides is
    // spoken for exactly once, and the summary states every count in plain text.
    expect(result.summary).toBe(
      "5 Meetings rows, 6 vault files — 2 confident, " +
      "1 title-only match(es) (no date to confirm — worth a quick look), " +
      "1 ambiguous group(s) covering 1 meeting(s) / 2 file(s), " +
      "1 meeting(s) with no file, 1 file(s) with no meeting",
    );
    assertCountsAddUp(result);
  });

  it("the empty case: zero meetings, zero files — counts still add up (0 = 0)", async () => {
    const result = await runAdoptionReport(makeDeps([], []));
    expect(result.summary).toBe(
      "0 Meetings rows, 0 vault files — 0 confident, " +
      "0 title-only match(es) (no date to confirm — worth a quick look), " +
      "0 ambiguous group(s) covering 0 meeting(s) / 0 file(s), " +
      "0 meeting(s) with no file, 0 file(s) with no meeting",
    );
    assertCountsAddUp(result);
  });
});

describe("runAdoptionReport — has no write capability at all (the zero-writes proof, part 1 of 2)", () => {
  // Part 2 — the WRAPPER (cli.ts's runAdoptionReportOnce) — lives in
  // tests/cli.test.ts, dynamically, for the exact reason archive-excluded.test.ts's
  // own version of this test states: cli.ts legitimately imports writeFileSync and
  // the vault writer FOR OTHER COMMANDS, so a source scan of cli.ts would prove
  // nothing. This test scopes itself to lib/adoption-report.ts alone.
  it("this file's own source never mentions anything that can write — fs, the vault writer, git, or the Notion adapter", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "lib", "adoption-report.ts"), "utf8");
    const forbidden = [
      "node:fs", "from \"fs\"", "vault-writer", "vault-files", "vault-walk",
      "readFileSync", "writeFileSync", "child_process", "execSync", "spawn",
      // Beyond archive-excluded.ts's own list: this
      // engine also has no business importing the Notion HTTP adapter directly —
      // every read it needs arrives already resolved, through AdoptionReportDeps.
      "notion-client", "makeNotionClient",
      // …and no business reaching into the store either — see this file's header
      // on why a point-in-time report needs no store dependency at all.
      "\"./store.js\"", "'./store.js'",
    ];
    for (const name of forbidden) {
      expect(src.includes(name), `adoption-report.ts must not reference ${name}`).toBe(false);
    }
  });

  it("AdoptionReportDeps has exactly two members, and both are reads — the structural half of the proof", () => {
    // Not a runtime assertion (TypeScript structural types have no runtime
    // footprint to introspect) — this is a literal transcription of the
    // interface as a reader would see it, kept here so a future edit that
    // widens the deps type has to touch this test and explain itself, rather
    // than silently drifting past the property that is meant to be load-bearing.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "lib", "adoption-report.ts"), "utf8");
    const depsBlock = src.slice(
      src.indexOf("export interface AdoptionReportDeps"),
      src.indexOf("export interface AdoptionReportResult"),
    );
    const memberNames = [...depsBlock.matchAll(/^\s*(\w+):\s*\(\)/gm)].map((m) => m[1]);
    expect(memberNames.sort()).toEqual(["listVaultFiles", "queryMeetings"]);
  });
});
