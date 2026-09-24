import { describe, it, expect } from "vitest";

import { buildWeeklySummaryPrompt } from "../agent/schedules/weekly-summary.js";

// 2026-09-06: the Saturday weekly summary arrived in English while every brief around it was
// Norwegian — the prompt named no language, and the learned preferences it summarises are stored
// in English. Bendik reads his briefs in Norwegian; the summary is one of them.
describe("buildWeeklySummaryPrompt — Norwegian, like the briefs", () => {
  it("tells the model to write in Norwegian", () => {
    const p = buildWeeklySummaryPrompt([{ text: "prefers short answers" }]);
    expect(p).toContain("Skriv på norsk");
  });

  it("still forbids any action on this turn", () => {
    const p = buildWeeklySummaryPrompt([{ text: "x" }]);
    expect(p).toContain("take no action and propose nothing this turn");
  });
});

/**
 * LAR-17-s3 — PIN, asserted against the source: `weeklyHour`/`WEEKLY_SUMMARY_HOUR` are gone (the
 * hour is a setting now, `packages/agent-kit/src/schedule-settings.ts`'s `weekly-summary` key),
 * and the live tick asks `scheduleHours` before ever computing the slot.
 */
describe("weekly-summary.ts reads its hour from the setting (LAR-17-s3)", () => {
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
