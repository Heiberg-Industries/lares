/**
 * ORB-133 Task 1 — the seven pure digest modules, copied verbatim from the old runtime.
 *
 * These are copies, so the job of this suite is NOT to re-specify behaviour: it is to prove the
 * copy is intact and that the two things the schedule depends on — the Oslo slot arithmetic and
 * the note shape that lands in the vault — survived the move. A failure here means the copy is
 * wrong, never that the fixtures need adjusting.
 */
import { describe, it, expect } from "vitest";

import { PROJECTS, DESTINATIONS, BODY_CHARS_FOR_CLASSIFY, type DigestDecision } from "../lib/digest/types.js";
import { dueScheduledSlot, osloParts, parseSlotHour, parsePositiveInt } from "../lib/digest/schedule.js";
import { slugify, buildNote } from "../lib/digest/filer.js";
import { parseFrontmatter, stripFrontmatter } from "../lib/digest/extract.js";
import { renderDigest } from "../lib/digest/format.js";

const decision = (over: Partial<DigestDecision> = {}): DigestDecision => ({
  route: "file",
  type: "reference",
  destination: "reads",
  title: "A Note About Things",
  summary: "two lines",
  links: [],
  reason: "clear",
  ...over,
});

describe("digest slots — 09:00 and 17:00 on the owner's clock", () => {
  // August is CEST (UTC+2). These fixtures are correct; if they fail, the copy is wrong.
  // ORB-193 — the timezone is now an ARGUMENT (the owner clock, resolved per tick). Passing
  // Europe/Oslo reproduces exactly what these asserted before.
  const OSLO = "Europe/Oslo";
  // LAR-17-s3 — `hours` is required now (no more `= [9, 17]` default inside dueScheduledSlot):
  // the digest's hours are a setting, and these fixtures pass the engine default explicitly,
  // exactly reproducing what the removed default used to supply.
  const DEFAULT_HOURS = [9, 17];

  it("matches the 09:00 Oslo minute", () => {
    expect(dueScheduledSlot(new Date("2026-08-21T07:00:00Z"), OSLO, DEFAULT_HOURS)).toBe("2026-08-21T9");
  });

  it("matches the 17:00 Oslo minute", () => {
    expect(dueScheduledSlot(new Date("2026-08-21T15:00:00Z"), OSLO, DEFAULT_HOURS)).toBe("2026-08-21T17");
  });

  it("is exact-minute — one minute either side is null", () => {
    expect(dueScheduledSlot(new Date("2026-08-21T06:59:00Z"), OSLO, DEFAULT_HOURS)).toBeNull();
    expect(dueScheduledSlot(new Date("2026-08-21T07:01:00Z"), OSLO, DEFAULT_HOURS)).toBeNull();
  });

  it("is null at the right minute of a non-slot hour", () => {
    expect(dueScheduledSlot(new Date("2026-08-21T08:00:00Z"), OSLO, DEFAULT_HOURS)).toBeNull();
  });

  it("follows the OWNER's clock — 09:00 in Tokyo is not 09:00 in Oslo", () => {
    // 2026-08-21T00:00:00Z is 09:00 in Tokyo (UTC+9) and 02:00 in Oslo.
    expect(dueScheduledSlot(new Date("2026-08-21T00:00:00Z"), "Asia/Tokyo", DEFAULT_HOURS)).toBe("2026-08-21T9");
    expect(dueScheduledSlot(new Date("2026-08-21T00:00:00Z"), OSLO, DEFAULT_HOURS)).toBeNull();
  });

  it("honours a configured hour list — not only the engine default", () => {
    expect(dueScheduledSlot(new Date("2026-08-21T07:00:00Z"), OSLO, [7])).toBeNull();
    expect(dueScheduledSlot(new Date("2026-08-21T05:00:00Z"), OSLO, [7])).toBe("2026-08-21T7");
  });

  it("osloParts renders the Oslo wall clock, not UTC", () => {
    expect(osloParts(new Date("2026-08-21T07:00:00Z"))).toEqual({ date: "2026-08-21", hour: 9, minute: 0 });
  });

  it("parseSlotHour falls back AND reports what it rejected — a typo must not silently disable a slot", () => {
    expect(parseSlotHour("8pm", 9)).toEqual({ hour: 9, invalid: "8pm" });
    expect(parseSlotHour("24", 9)).toEqual({ hour: 9, invalid: "24" });
    expect(parseSlotHour("17", 9)).toEqual({ hour: 17 });
    expect(parseSlotHour(undefined, 9)).toEqual({ hour: 9 });
  });

  it("parsePositiveInt refuses NaN — setInterval clamps a NaN delay to 1ms, a hot loop, not a pause", () => {
    expect(parsePositiveInt("bad", 60000)).toEqual({ value: 60000, invalid: "bad" });
    expect(parsePositiveInt("0", 60000)).toEqual({ value: 60000, invalid: "0" });
    expect(parsePositiveInt("30000", 60000)).toEqual({ value: 30000 });
  });
});

describe("filer — the note that lands in the vault", () => {
  it("builds the destination path from the slugified title", () => {
    const note = buildNote(decision(), "original body", "2026-08-21");
    expect(note.destPath).toBe("reads/a-note-about-things.md");
  });

  it("stamps the frontmatter the digest is identified by", () => {
    const note = buildNote(decision(), "original body", "2026-08-21");
    expect(note.frontmatter).toMatchObject({
      title: "A Note About Things",
      type: "reference",
      source: "digest",
      filed_by: "digest",
      captured: "2026-08-21",
    });
  });

  it("keeps the original body under a Source heading", () => {
    const note = buildNote(decision(), "original body", "2026-08-21");
    expect(note.body).toContain("## Source");
    expect(note.body).toContain("original body");
  });

  it("carries the caller's commit message — the vault history says what the digest did", () => {
    const note = buildNote(decision(), "b", "2026-08-21");
    expect(note.message).toBe("digest: file A Note About Things → reads");
  });

  it("renders proposed links as a Related block, and omits it when there are none", () => {
    expect(buildNote(decision({ links: ["[[a]]", "[[b]]"] }), "b", "2026-08-21").body)
      .toContain("## Related");
    expect(buildNote(decision(), "b", "2026-08-21").body).not.toContain("## Related");
  });

  it("slugify never yields an empty slug — a title of punctuation still gets a filename", () => {
    expect(slugify("!!!")).toBe("note");
    expect(slugify("Æ Ø Å?")).not.toBe("");
  });
});

describe("types survived the copy", () => {
  it("PROJECTS still bounds where a transcript may be filed", () => {
    expect(PROJECTS).toContain("zero7");
    expect(PROJECTS.length).toBeGreaterThan(1);
  });

  it("DESTINATIONS maps the non-transcript types", () => {
    expect(DESTINATIONS.reference).toBe("reads");
    expect(DESTINATIONS.inspiration).toBe("inspiration");
    expect(DESTINATIONS["writing-seed"]).toBe("writing-seeds");
  });

  it("the classify window is bounded — cost safety, not a detail", () => {
    expect(BODY_CHARS_FOR_CLASSIFY).toBeGreaterThan(0);
  });
});

describe("extract — frontmatter helpers the enricher and picks reader both use", () => {
  it("parses a simple block", () => {
    expect(parseFrontmatter("---\ntitle: Hello\nurl: https://x.test\n---\n\nbody"))
      .toMatchObject({ title: "Hello", url: "https://x.test" });
  });

  it("returns an empty map for a body with no frontmatter, rather than throwing", () => {
    expect(parseFrontmatter("just prose")).toEqual({});
  });

  it("stripFrontmatter leaves the prose alone", () => {
    expect(stripFrontmatter("---\ntitle: Hello\n---\n\nthe prose").trim()).toBe("the prose");
    expect(stripFrontmatter("no frontmatter here").trim()).toBe("no frontmatter here");
  });
});

describe("format — one Slack message, errors kept out of the headline", () => {
  it("an all-empty pass still renders text (the runner decides whether to send it)", () => {
    const view = renderDigest({ filed: [], asked: [], errors: [] });
    expect(typeof view.text).toBe("string");
  });

  it("errors go to errorDetail, never into the headline text", () => {
    const view = renderDigest({
      filed: [{ title: "T", destination: "reads" }],
      asked: [],
      errors: [{ path: "_inbox/broken.md", error: "boom" }],
    });
    expect(view.errorDetail).toBeTruthy();
    expect(view.errorDetail).toContain("_inbox/broken.md");
    // The path is the thing that must not appear in the main message.
    expect(view.text).not.toContain("_inbox/broken.md");
    expect(view.report.title).not.toContain("📥");
  });

  it("maps asked items, the filed breakdown and commercial pointer to report anatomy", () => {
    const view = renderDigest({
      filed: [{ title: "Saved", destination: "reads" }],
      asked: [{ title: "Where does this go?", suggestedDestination: "projects", reason: "two plausible homes" }],
      errors: [],
    });
    expect(view.report.sections).toEqual([
      { label: "Where does this go?", value: "Suggests projects · two plausible homes" },
      { label: "Filed", value: "1 reads" },
    ]);
    expect(view.report.links).toEqual([
      { label: "Commercial radar", url: "https://slack.com/app_redirect?channel=sales" },
    ]);
  });

  it("a clean pass has no errorDetail to post as a reply", () => {
    const view = renderDigest({ filed: [{ title: "T", destination: "reads" }], asked: [], errors: [] });
    expect(view.errorDetail).toBeFalsy();
  });
});
