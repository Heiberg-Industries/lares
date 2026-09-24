import { describe, it, expect } from "vitest";
import {
  computeLastContacted,
  computeStrengthScore,
  bucketStrength,
  hasReciprocity,
  type Interaction,
} from "../src/index.js";

const NOW = new Date("2026-06-04T00:00:00.000Z");
const daysAgo = (n: number): Date =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("computeLastContacted", () => {
  it("returns null when there are no interactions", () => {
    expect(computeLastContacted([], NOW)).toBeNull();
  });

  it("returns the most recent past interaction timestamp", () => {
    const interactions: Interaction[] = [
      { kind: "email", at: daysAgo(30) },
      { kind: "event", at: daysAgo(3) },
      { kind: "email", at: daysAgo(90) },
    ];
    expect(computeLastContacted(interactions, NOW)).toEqual(daysAgo(3));
  });

  it("ignores future-dated interactions like a scheduled meeting", () => {
    const interactions: Interaction[] = [
      { kind: "email", at: daysAgo(10) },
      { kind: "event", at: daysAgo(-88) }, // 88 days in the future
    ];
    expect(computeLastContacted(interactions, NOW)).toEqual(daysAgo(10));
  });
});

describe("computeStrengthScore", () => {
  it("is zero with no interactions", () => {
    expect(computeStrengthScore([], NOW)).toBe(0);
  });

  it("scores a contact made today at ~1.0", () => {
    const score = computeStrengthScore([{ kind: "email", at: NOW }], NOW);
    expect(score).toBeCloseTo(1, 5);
  });

  it("halves the weight at one half-life (30 days)", () => {
    const score = computeStrengthScore(
      [{ kind: "email", at: daysAgo(30) }],
      NOW,
    );
    expect(score).toBeCloseTo(0.5, 5);
  });

  it("ignores interactions older than the 365-day window", () => {
    const score = computeStrengthScore(
      [{ kind: "email", at: daysAgo(400) }],
      NOW,
    );
    expect(score).toBe(0);
  });

  it("sums the weights of multiple interactions", () => {
    const score = computeStrengthScore(
      [
        { kind: "email", at: NOW }, // 1.0
        { kind: "event", at: daysAgo(30) }, // 0.5
      ],
      NOW,
    );
    expect(score).toBeCloseTo(1.5, 5);
  });

  it("scales an interaction's contribution by its weight", () => {
    const plain = computeStrengthScore([{ kind: "email", at: NOW }], NOW);
    const heavy = computeStrengthScore(
      [{ kind: "event", at: NOW, weight: 3 }],
      NOW,
    );
    expect(plain).toBeCloseTo(1, 5);
    expect(heavy).toBeCloseTo(3, 5);
  });
});

describe("hasReciprocity", () => {
  it("is true when you have emailed them (an outbound email)", () => {
    expect(
      hasReciprocity([{ kind: "email", at: NOW, direction: "outbound" }]),
    ).toBe(true);
  });

  it("is true when there is a meeting", () => {
    expect(hasReciprocity([{ kind: "event", at: NOW }])).toBe(true);
  });

  it("is false for inbound-only (an automated sender you never reply to)", () => {
    expect(
      hasReciprocity([
        { kind: "email", at: NOW, direction: "inbound" },
        { kind: "email", at: daysAgo(2), direction: "inbound" },
      ]),
    ).toBe(false);
  });

  it("is false with no interactions", () => {
    expect(hasReciprocity([])).toBe(false);
  });
});

describe("bucketStrength", () => {
  it("maps a zero score to NO_CONNECTION", () => {
    expect(bucketStrength(0)).toBe("NO_CONNECTION");
  });

  it("maps a small positive score to VERY_WEAK", () => {
    expect(bucketStrength(0.1)).toBe("VERY_WEAK");
  });

  it("maps a sustained-cadence score to GOOD", () => {
    expect(bucketStrength(3)).toBe("GOOD");
  });

  it("maps a high score to VERY_STRONG", () => {
    expect(bucketStrength(50)).toBe("VERY_STRONG");
  });

  it("is monotonic across the thresholds", () => {
    const order = [
      "NO_CONNECTION",
      "VERY_WEAK",
      "WEAK",
      "GOOD",
      "STRONG",
      "VERY_STRONG",
    ];
    const samples = [0, 0.3, 1, 3, 10, 50];
    const levels = samples.map(bucketStrength);
    const indices = levels.map((l) => order.indexOf(l));
    const sorted = [...indices].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
  });
});
