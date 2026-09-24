import { describe, it, expect } from "vitest";

import { detectProposedWindow } from "../lib/proposed-time.js";

/**
 * Task 2 (ORB-147) — detectProposedWindow. Fixed `now` throughout so weekday/relative-day
 * resolution is deterministic: 2026-08-24T09:00:00Z is a Monday in Oslo (confirmed via
 * Intl.DateTimeFormat before writing these expectations, not assumed).
 */
const NOW = new Date("2026-08-24T09:00:00Z"); // Monday, Oslo
const NOW_TUESDAY = new Date("2026-08-25T09:00:00Z"); // Tuesday, Oslo — for the same-day boundary case

describe("detectProposedWindow", () => {
  it("returns null when nothing matches (negative case)", () => {
    expect(detectProposedWindow("Hi, what does this cost?", NOW)).toBeNull();
  });

  it("returns null on empty text", () => {
    expect(detectProposedWindow("", NOW)).toBeNull();
  });

  // --- explicit dates ---------------------------------------------------------------

  it("recognises an ISO date (2026-09-03), whole-day window", () => {
    const r = detectProposedWindow("Does 2026-09-03 work for you?", NOW);
    expect(r).toEqual({
      timeMin: "2026-09-02T22:00:00.000Z",
      timeMax: "2026-09-03T22:00:00.000Z",
      label: "Thursday 3 September",
    });
  });

  it("recognises Norwegian '3. september' day-month form", () => {
    const r = detectProposedWindow("Passer det 3. september?", NOW);
    expect(r).toEqual({
      timeMin: "2026-09-02T22:00:00.000Z",
      timeMax: "2026-09-03T22:00:00.000Z",
      label: "Thursday 3 September",
    });
  });

  it("recognises English 'Sept 3' month-day form", () => {
    const r = detectProposedWindow("Could we meet Sept 3?", NOW);
    expect(r?.label).toBe("Thursday 3 September");
    expect(r?.timeMin).toBe("2026-09-02T22:00:00.000Z");
    expect(r?.timeMax).toBe("2026-09-03T22:00:00.000Z");
  });

  it("recognises English '3 Sept' day-month form", () => {
    const r = detectProposedWindow("Could we meet 3 Sept?", NOW);
    expect(r?.label).toBe("Thursday 3 September");
  });

  it("rolls a bare day+month over to next year once the date has passed this year", () => {
    // now = 2026-08-24; "3 May" has already passed this year, so it resolves to 2027.
    const r = detectProposedWindow("How about 3 May?", NOW);
    expect(r).toEqual({
      timeMin: "2027-05-02T22:00:00.000Z",
      timeMax: "2027-05-03T22:00:00.000Z",
      label: "Monday 3 May",
    });
  });

  it("honours an explicit year over the rollover guess (ORB-147 review, finding 2)", () => {
    // now = 2026-08-24; a bare "3 September" would roll to 2026 (later this year), but the
    // sender stated 2028 explicitly — that signal must win, not the yearless heuristic.
    const r = detectProposedWindow("Could we do 3. september 2028?", NOW);
    expect(r).toEqual({
      timeMin: "2028-09-02T22:00:00.000Z",
      timeMax: "2028-09-03T22:00:00.000Z",
      label: "Sunday 3 September",
    });
  });

  it("honours an explicit year in the month-day form too ('Sept 3 2028')", () => {
    const r = detectProposedWindow("Could we do Sept 3 2028?", NOW);
    expect(r?.label).toBe("Sunday 3 September");
    expect(r?.timeMin).toBe("2028-09-02T22:00:00.000Z");
  });

  it("does NOT mistake a Norwegian postal code for a year ('3. september, 1400 Ski') — falls back to the yearless rollover instead (ORB-147 review, round 3)", () => {
    // "1400" here is a postal code (Ski, Norway), not a year — a bare \d{4} adjacent to the
    // date is not, on its own, evidence of a year. Falls back to the same rollover-guess
    // resolution as the plain "3. september" case (an earlier test, same NOW), not a garbage
    // "year 1400" and not null — the day+month mention itself is still a real signal.
    const r = detectProposedWindow("Kontoret er i 3. september, 1400 Ski", NOW);
    expect(r).toEqual({
      timeMin: "2026-09-02T22:00:00.000Z",
      timeMax: "2026-09-03T22:00:00.000Z",
      label: "Thursday 3 September",
    });
  });

  it("falls back to the rollover guess for an implausible explicit year ('Sept 3 2000')", () => {
    // 2000 is outside the plausible window (now's year - 1 .. now's year + 10 = 2025..2036),
    // so it's treated as not-a-year — same resolution as the bare "Sept 3" case.
    const r = detectProposedWindow("Could we do Sept 3 2000?", NOW);
    expect(r).toEqual({
      timeMin: "2026-09-02T22:00:00.000Z",
      timeMax: "2026-09-03T22:00:00.000Z",
      label: "Thursday 3 September",
    });
  });

  it("returns null for a calendar date that doesn't exist ('31. april') rather than rolling over into May (ORB-147 review, finding 1)", () => {
    expect(detectProposedWindow("Passer det 31. april?", NOW)).toBeNull();
  });

  it("returns null for '30 February' — no year has a 30th of February", () => {
    expect(detectProposedWindow("How about 30 February?", NOW)).toBeNull();
  });

  it("returns null for Feb 29 landing on a non-leap year", () => {
    // 2026 is not a leap year (2026 / 4 is not an integer).
    expect(detectProposedWindow("Could we do 29. februar 2026?", NOW)).toBeNull();
  });

  it("accepts Feb 29 when the explicit year IS a leap year", () => {
    // 2028 is a leap year.
    const r = detectProposedWindow("Could we do 29. februar 2028?", NOW);
    expect(r).toEqual({
      timeMin: "2028-02-28T23:00:00.000Z",
      timeMax: "2028-02-29T23:00:00.000Z",
      label: "Tuesday 29 February",
    });
  });

  it("returns null for an invalid ISO calendar date ('2026-02-30')", () => {
    expect(detectProposedWindow("Does 2026-02-30 work?", NOW)).toBeNull();
  });

  // --- relative days ------------------------------------------------------------------

  it("recognises 'tomorrow' (EN), whole-day window", () => {
    const r = detectProposedWindow("Are you free tomorrow?", NOW);
    expect(r).toEqual({
      timeMin: "2026-08-24T22:00:00.000Z",
      timeMax: "2026-08-25T22:00:00.000Z",
      label: "tomorrow",
    });
  });

  it("recognises 'i morgen' (NO), whole-day window", () => {
    const r = detectProposedWindow("Passer det i morgen?", NOW);
    expect(r).toEqual({
      timeMin: "2026-08-24T22:00:00.000Z",
      timeMax: "2026-08-25T22:00:00.000Z",
      label: "tomorrow",
    });
  });

  it("recognises 'i overmorgen' (NO) as the day after tomorrow", () => {
    const r = detectProposedWindow("Kanskje i overmorgen?", NOW);
    expect(r).toEqual({
      timeMin: "2026-08-25T22:00:00.000Z",
      timeMax: "2026-08-26T22:00:00.000Z",
      label: "the day after tomorrow",
    });
  });

  it("does NOT treat bare Norwegian 'morgen' (morning) as tomorrow", () => {
    // "morgen" alone means "morning" in Norwegian, not "tomorrow" — only "i morgen" does.
    expect(detectProposedWindow("Jeg sjekker mailen i morgentimene.", NOW)).toBeNull();
  });

  // --- weekday names --------------------------------------------------------------------

  it("recognises 'tuesday' (EN), resolving to the next Tuesday from a Monday", () => {
    const r = detectProposedWindow("Can we do tuesday?", NOW);
    expect(r?.label).toBe("Tuesday 25 August");
    expect(r?.timeMin).toBe("2026-08-24T22:00:00.000Z");
    expect(r?.timeMax).toBe("2026-08-25T22:00:00.000Z");
  });

  it("recognises 'tirsdag' (NO), resolving to the next Tuesday from a Monday", () => {
    const r = detectProposedWindow("Passer tirsdag?", NOW);
    expect(r?.label).toBe("Tuesday 25 August");
  });

  it("boundary: when `now` IS the named weekday, resolves to NEXT week's occurrence, not today", () => {
    // Rule (see proposed-time.ts's findWeekdayName comment): a bare weekday name never means
    // "today", even when today happens to be that weekday — "let's do Tuesday" written on a
    // Tuesday reads as next Tuesday, not "right now".
    const r = detectProposedWindow("Passer tirsdag?", NOW_TUESDAY);
    expect(r).toEqual({
      timeMin: "2026-08-31T22:00:00.000Z", // 2026-09-01 00:00 Oslo
      timeMax: "2026-09-01T22:00:00.000Z", // 2026-09-02 00:00 Oslo
      label: "Tuesday 1 September",
    });
  });

  // --- optional clock time narrows the window --------------------------------------------

  it("narrows to a 1-hour window when a 24h time is given", () => {
    const r = detectProposedWindow("Can we do tuesday at 14:00?", NOW);
    expect(r).toEqual({
      timeMin: "2026-08-25T12:00:00.000Z", // 14:00 Oslo
      timeMax: "2026-08-25T13:00:00.000Z", // 15:00 Oslo
      label: "Tuesday 25 August 14:00",
    });
  });

  it("recognises Norwegian 'kl 14' clock form", () => {
    const r = detectProposedWindow("Passer tirsdag kl 14?", NOW);
    expect(r?.timeMin).toBe("2026-08-25T12:00:00.000Z");
    expect(r?.timeMax).toBe("2026-08-25T13:00:00.000Z");
    expect(r?.label).toBe("Tuesday 25 August 14:00");
  });

  it("recognises Norwegian 'kl. 14:30' clock form with minutes", () => {
    const r = detectProposedWindow("Passer tirsdag kl. 14:30?", NOW);
    expect(r?.timeMin).toBe("2026-08-25T12:30:00.000Z");
    expect(r?.label).toBe("Tuesday 25 August 14:30");
  });

  it("recognises English '2pm' clock form", () => {
    const r = detectProposedWindow("Can we do tuesday at 2pm?", NOW);
    expect(r?.timeMin).toBe("2026-08-25T12:00:00.000Z");
    expect(r?.label).toBe("Tuesday 25 August 14:00");
  });

  it("does not mistake a price like '14.00' for a time", () => {
    // Dot-separated is deliberately excluded — see proposed-time.ts's TIME_24H_RE comment.
    // No day-shaped token here either, so the whole message is a miss (null), not just the
    // time — but this specifically exercises that "14.00" alone never resolves an hour.
    expect(detectProposedWindow("The invoice is 14.00 kr, does that work?", NOW)).toBeNull();
  });

  // --- earliest-mention-wins when multiple day-shaped tokens appear ----------------------

  it("picks the earliest day-shaped mention when two appear in the same message", () => {
    // "tomorrow" appears before the unrelated ISO date, so it wins per the documented
    // earliest-in-text rule (not "most specific form wins").
    const r = detectProposedWindow("Are you free tomorrow? (re: our 2020-01-01 invoice)", NOW);
    expect(r?.label).toBe("tomorrow");
  });
});
