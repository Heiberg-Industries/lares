import { describe, it, expect } from "vitest";
import { DO_NOT_LEARN_PATTERNS, isDoNotLearn, SCAFFOLDING_PATTERNS } from "../lib/dream/reflect.js";

const DROPPED: Array<[string, string]> = [
  ["the gateway returned a 500 last Tuesday", "outage"],
  ["the calendar connection expired and had to be renewed", "environment"],
  ["the owner asked to move the 14:00 to Thursday", "one-off task"],
  ["sending that invoice failed and was never resolved", "unresolved failure"],
  ["the search tool is broken", "tools"],
  ["person lookup does not work", "tools"],
  ["e-post-verktøyet fungerer ikke", "tools (nb)"],
];

const KEPT: Array<[string, string]> = [
  ["the owner prefers the train to the coast", "travel"],
  ["the owner will not work with brokers", "vendor policy"],
  ["the owner reads long documents in the evening", "working style"],
  ["the owner broke off the negotiation with the supplier", "decisions"], // "broke", not "broken"
];

describe("the do-not-learn list (ADR-0018 rule 5)", () => {
  it.each(DROPPED)("drops %s", (text, subject) => {
    expect(isDoNotLearn(text, subject)).toBe(true);
  });

  it.each(KEPT)("keeps %s", (text, subject) => {
    expect(isDoNotLearn(text, subject)).toBe(false);
  });

  it("covers all four classes the decision names, and says why for each", () => {
    const labels = DO_NOT_LEARN_PATTERNS.map((p) => p.label).sort();
    expect(labels).toEqual(["environment-failure", "negative-claim-about-a-tool", "one-off-task", "unresolved-failure"]);
    for (const p of DO_NOT_LEARN_PATTERNS) expect(p.why.length).toBeGreaterThan(20);
  });

  it("is a second list, not a replacement for the scaffolding filter", () => {
    expect(SCAFFOLDING_PATTERNS.length).toBeGreaterThan(0);
    expect(isDoNotLearn("the owner uses 👍 to confirm", "approvals")).toBe(false); // scaffolding's job
  });
});
