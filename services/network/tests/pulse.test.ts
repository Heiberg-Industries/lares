import { describe, it, expect } from "vitest";
import { computePulse, isDormantWarm, NETWORK_WEIGHTS, type InteractionRow } from "../lib/pulse.js";

const NOW = new Date("2026-06-10T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function row(partial: Partial<InteractionRow>): InteractionRow {
  return { channel: "imessage", direction: "outbound", at: days(1), ...partial };
}

describe("computePulse", () => {
  it("recent two-way iMessage thread scores warm or better", () => {
    const rows = [0, 2, 5, 9, 14].flatMap((d) => [
      row({ at: days(d), direction: "inbound" }),
      row({ at: days(d), direction: "outbound" }),
    ]);
    const p = computePulse(rows, NOW);
    expect(["GOOD", "STRONG", "VERY_STRONG"]).toContain(p.band);
    expect(p.lastInteractionAt).toBe(days(0));
  });

  it("a lone LinkedIn connection with no messages scores NO_CONNECTION", () => {
    const p = computePulse([], NOW);
    expect(p.band).toBe("NO_CONNECTION");
    expect(p.score).toBe(0);
  });

  it("inbound-only message history has no reciprocity and scores 0", () => {
    const rows = [1, 3, 8].map((d) => row({ at: days(d), direction: "inbound" }));
    const p = computePulse(rows, NOW);
    expect(p.band).toBe("NO_CONNECTION");
  });

  it("calls count as mutual events (reciprocity without outbound messages)", () => {
    const rows = [2, 10].map((d) => row({ channel: "call", direction: "inbound", at: days(d) }));
    const p = computePulse(rows, NOW);
    expect(p.score).toBeGreaterThan(0);
  });

  it("components break down score per channel", () => {
    const rows = [row({ channel: "call", at: days(1) }), row({ channel: "imessage", direction: "outbound", at: days(1) })];
    const p = computePulse(rows, NOW);
    expect(Object.keys(p.components).sort()).toEqual(["call", "imessage"]);
  });
});

describe("isDormantWarm", () => {
  it("true for a once-strong thread silent for 200+ days", () => {
    const rows = [200, 203, 207, 215, 230, 245].flatMap((d) => [
      row({ at: days(d), direction: "inbound" }),
      row({ at: days(d), direction: "outbound" }),
    ]);
    expect(isDormantWarm(rows, NOW)).toBe(true);
  });

  it("false when contact is recent", () => {
    const rows = [row({ at: days(3), direction: "inbound" }), row({ at: days(2), direction: "outbound" })];
    expect(isDormantWarm(rows, NOW)).toBe(false);
  });

  it("false when the old history was never warm (single message)", () => {
    const rows = [row({ at: days(300), direction: "outbound" })];
    expect(isDormantWarm(rows, NOW)).toBe(false);
  });

  it("newsletter pattern: many inbound messages plus one answered call is NOT dormant-warm", () => {
    // 20 inbound iMessages + 1 call, all 200+ days ago — broadcast sender pattern
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => row({ at: days(200 + i), direction: "inbound" })),
      row({ channel: "call", direction: "inbound", at: days(205) }),
    ];
    expect(isDormantWarm(rows, NOW)).toBe(false);
  });

  it("call-only relationship qualifies as dormant-warm (3 calls 200+ days ago)", () => {
    // 3 calls well in the past — genuine call relationship, far above GOOD threshold
    const rows = [200, 210, 220].map((d) => row({ channel: "call", direction: "inbound", at: days(d) }));
    expect(isDormantWarm(rows, NOW)).toBe(true);
  });
});

describe("meta channels", () => {
  it("scores instagram and facebook as social-tier and records per-channel components", () => {
    const rows = [
      row({ channel: "facebook", direction: "inbound", at: days(2) }),
      row({ channel: "instagram", direction: "outbound", at: days(3) }),
    ];
    const p = computePulse(rows, NOW);
    expect(p.score).toBeGreaterThan(0);
    expect(p.components.facebook).toBeGreaterThan(0);
    expect(p.components.instagram).toBeGreaterThan(0);
  });
});

describe("slack channel", () => {
  it("a Slack-only contact (inbound + outbound today) scores GOOD", () => {
    const rows = [
      row({ channel: "slack", direction: "inbound", at: days(0) }),
      row({ channel: "slack", direction: "outbound", at: days(0) }),
    ];
    const p = computePulse(rows, NOW);
    // No decay at age 0: slackInbound (1.2) + slackOutbound (0.8) = 2.0.
    expect(p.score).toBeCloseTo(2.0);
    expect(p.band).toBe("GOOD");
  });

  it("Slack outbound alone (age 0) scores exactly slackOutbound and establishes reciprocity", () => {
    const rows = [row({ channel: "slack", direction: "outbound", at: days(0) })];
    const p = computePulse(rows, NOW);
    // A single non-call outbound message is reciprocal per isReciprocal — same rule
    // that already applies to iMessage — so this must NOT score 0.
    expect(p.score).toBeCloseTo(NETWORK_WEIGHTS.slackOutbound);
    expect(p.score).toBeCloseTo(0.8);
  });

  it("Slack inbound weighs heavier than Slack outbound, pinned exactly (not recomputed)", () => {
    // Reciprocity is established via an unrelated iMessage outbound so this doesn't
    // pollute the slack component below, isolating the inbound weight.
    const rows = [
      row({ channel: "imessage", direction: "outbound", at: days(0) }),
      row({ channel: "slack", direction: "inbound", at: days(0) }),
    ];
    const p = computePulse(rows, NOW);
    expect(p.components.slack).toBeCloseTo(1.2);
    expect(p.components.slack).toBeGreaterThan(NETWORK_WEIGHTS.slackOutbound);
  });

  it("components breakdown attributes Slack under its own 'slack' key", () => {
    // Two calls establish reciprocity on their own (no outbound message needed),
    // so the Slack inbound-only row's contribution is visible without being the
    // thing that makes the contact reciprocal.
    const rows = [
      row({ channel: "call", direction: "inbound", at: days(1) }),
      row({ channel: "call", direction: "inbound", at: days(3) }),
      row({ channel: "slack", direction: "inbound", at: days(1) }),
    ];
    const p = computePulse(rows, NOW);
    expect(Object.keys(p.components).sort()).toEqual(["call", "slack"]);
    expect(p.components.slack).toBeGreaterThan(0);
  });
});

describe("reciprocity rules", () => {
  it("newsletter pattern: 20 inbound messages + 1 call is NOT reciprocal → band NO_CONNECTION", () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => row({ at: days(i + 1), direction: "inbound" })),
      row({ channel: "call", direction: "inbound", at: days(5) }),
    ];
    const p = computePulse(rows, NOW);
    expect(p.band).toBe("NO_CONNECTION");
    expect(p.score).toBe(0);
  });

  it("a single call alone is NOT reciprocal → band NO_CONNECTION", () => {
    const rows = [row({ channel: "call", direction: "inbound", at: days(3) })];
    const p = computePulse(rows, NOW);
    expect(p.band).toBe("NO_CONNECTION");
    expect(p.score).toBe(0);
  });

  it("two or more calls alone ARE reciprocal → score > 0", () => {
    // The existing "calls count as mutual events" test covers 2 calls; this is explicit
    const rows = [2, 10].map((d) => row({ channel: "call", direction: "inbound", at: days(d) }));
    const p = computePulse(rows, NOW);
    expect(p.score).toBeGreaterThan(0);
  });
});

describe("outbound call recency (Fix 1 — outbound calls count regardless of answered)", () => {
  it("outbound call within DORMANT_SILENCE_DAYS → NOT dormant, lastInteractionAt = call date", () => {
    // Bendik called 10 days ago (outbound). macOS logs answered=0 for all outbound calls.
    // The DB query filter is removed for outbound calls; pulse sees the row as normal.
    // Also has old reciprocal history to qualify for dormant-warm candidate status.
    const rows = [
      row({ channel: "call", direction: "outbound", at: days(10) }),
      row({ channel: "imessage", direction: "inbound", at: days(300) }),
      row({ channel: "imessage", direction: "outbound", at: days(302) }),
    ];
    const p = computePulse(rows, NOW);
    expect(p.dormantWarm).toBe(false);
    expect(p.lastInteractionAt).toBe(days(10));
  });
});

describe("twenty_last_contacted recency (Fix 2 — CRM date as effective last contact)", () => {
  it("stale interactions but recent twenty_last_contacted → NOT dormant, lastInteractionAt = CRM date", () => {
    // The Fredrik case: old messages, but Twenty shows last contact was recent
    const recentCrmDate = days(11);
    const rows = [
      row({ channel: "imessage", direction: "inbound", at: days(300) }),
      row({ channel: "imessage", direction: "outbound", at: days(302) }),
    ];
    const p = computePulse(rows, NOW, recentCrmDate);
    expect(p.dormantWarm).toBe(false);
    expect(p.lastInteractionAt).toBe(recentCrmDate);
  });

  it("genuinely dormant contact — old interactions AND null twenty_last_contacted → still dormant", () => {
    // Regression: a real gone-quiet contact must still appear in the reactivation queue
    const rows = [200, 203, 210].flatMap((d) => [
      row({ channel: "imessage", direction: "inbound", at: days(d) }),
      row({ channel: "imessage", direction: "outbound", at: days(d + 1) }),
    ]);
    const p = computePulse(rows, NOW, null);
    expect(p.dormantWarm).toBe(true);
  });

  it("computePulse without twentyLastContacted behaves as before (backward-compatible)", () => {
    // Old two-arg call signature — no third param — must still work
    const rows = [200, 203, 210].flatMap((d) => [
      row({ channel: "imessage", direction: "inbound", at: days(d) }),
      row({ channel: "imessage", direction: "outbound", at: days(d + 1) }),
    ]);
    const p = computePulse(rows, NOW);
    expect(p.dormantWarm).toBe(true);
  });
});
