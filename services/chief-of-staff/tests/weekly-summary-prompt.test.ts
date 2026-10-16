import { describe, it, expect } from "vitest";

import { buildWeeklySummaryPrompt } from "../agent/schedules/weekly-summary.js";

// The weekly summary names its language from the owner's brief-language setting, like the briefs
// around it; the stored preferences are English and nothing else would say which to write in.
describe("buildWeeklySummaryPrompt — the owner's brief language", () => {
  it("writes in English by default", () => {
    const p = buildWeeklySummaryPrompt([{ text: "prefers short answers" }]);
    expect(p).toContain("Write the summary in English");
    expect(p).not.toContain("Skriv på norsk");
  });

  it("names the brief language the owner chose, Norwegian included", () => {
    const p = buildWeeklySummaryPrompt([{ text: "prefers short answers" }], "nb");
    expect(p).toContain("Write the summary in Norwegian (bokmål)");
  });

  it("still forbids any action on this turn", () => {
    const p = buildWeeklySummaryPrompt([{ text: "x" }]);
    expect(p).toContain("take no action and propose nothing this turn");
  });
});

/**
 *-s3 — PIN, asserted against the source: `weeklyHour`/`WEEKLY_SUMMARY_HOUR` are gone (the
 * hour is a setting now, `packages/agent-kit/src/schedule-settings.ts`'s `weekly-summary` key),
 * and the live tick asks `scheduleHours` before ever computing the slot.
 */
describe("weekly-summary.ts reads its hour from the setting (-s3)", () => {
  it("carries no weeklyHour/WEEKLY_SUMMARY_HOUR, and asks scheduleHours before slotIn", async () => {
    const src = await (await import("node:fs/promises")).readFile(
      new URL("../agent/schedules/weekly-summary.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("weeklyHour");
    expect(src).not.toContain("WEEKLY_SUMMARY_HOUR");
    expect(src.indexOf('scheduleHours("weekly-summary")')).toBeGreaterThan(-1);
    expect(src.indexOf('scheduleHours("weekly-summary")')).toBeLessThan(src.indexOf("slotIn("));
  });
});
