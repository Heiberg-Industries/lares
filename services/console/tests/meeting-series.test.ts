import { describe, it, expect } from "vitest";
import { nameSeries } from "../lib/meeting-series";

describe("nameSeries", () => {
  it("prefers the calendar title", () => {
    expect(nameSeries("s1", { calendarTitle: "Weekly sync", lastRecipients: "a@b.co" }))
      .toBe("Weekly sync");
  });

  it("falls back to the last recipients when the calendar has nothing", () => {
    // A revoked or deleted recurrence still has history, and "the weekly one with Henrik
    // and Mats" is a name a human can act on. The raw id is not.
    expect(nameSeries("s1", { calendarTitle: null, lastRecipients: "henrik@x.co, mats@y.co" }))
      .toBe("henrik@x.co, mats@y.co");
  });

  it("falls back to the id last, never to an empty string", () => {
    // An empty label next to a revoke button is the worst possible outcome.
    expect(nameSeries("s1", { calendarTitle: null, lastRecipients: "" })).toBe("s1");
  });
});
