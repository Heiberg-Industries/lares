import { describe, it, expect } from "vitest";
import { nameSeries } from "../lib/meeting-series";

describe("nameSeries (ORB-156)", () => {
  it("prefers the calendar title", () => {
    expect(nameSeries("s1", { calendarTitle: "Folkepuls", lastRecipients: "a@b.co" }))
      .toBe("Folkepuls");
  });

  it("falls back to the last recipients when the calendar has nothing", () => {
    // A revoked or deleted recurrence still has history, and "the weekly one with Stefan
    // and Kjetil" is a name a human can act on. The raw id is not.
    expect(nameSeries("s1", { calendarTitle: null, lastRecipients: "stefan@x.co, kjetil@y.co" }))
      .toBe("stefan@x.co, kjetil@y.co");
  });

  it("falls back to the id last, never to an empty string", () => {
    // An empty label next to a revoke button is the worst possible outcome.
    expect(nameSeries("s1", { calendarTitle: null, lastRecipients: "" })).toBe("s1");
  });
});
