import { describe, it, expect } from "vitest";
import { extractConfirmMarkers, needsYourAnswer } from "../src/confirm-markers.js";

describe("extractConfirmMarkers", () => {
  it("reads each marker once, in order", () => {
    expect(extractConfirmMarkers("A [confirm: date] b [confirm: price] c [confirm: date]")).toEqual(["date", "price"]);
  });
  it("is case-insensitive and trims", () => {
    expect(extractConfirmMarkers("[Confirm:   new date  ]")).toEqual(["new date"]);
  });
  it("ignores other brackets, empty markers and unclosed ones", () => {
    expect(extractConfirmMarkers("[Name] [confirm: ] [confirm: open")).toEqual([]);
  });
  it("does not span lines", () => {
    expect(extractConfirmMarkers("[confirm: a\nb]")).toEqual([]);
  });
  it("never throws on non-text", () => {
    expect(extractConfirmMarkers(undefined)).toEqual([]);
    expect(extractConfirmMarkers(42)).toEqual([]);
  });
});

describe("needsYourAnswer", () => {
  it("joins the questions, or is null when there are none", () => {
    expect(needsYourAnswer("[confirm: date] [confirm: price]")).toBe("Needs your answer: date; price");
    expect(needsYourAnswer("nothing here")).toBeNull();
  });
});
