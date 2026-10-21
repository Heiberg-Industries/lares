import { describe, it, expect, vi } from "vitest";

import type { Obligation } from "../lib/brief-content.js";
import { resolveElsewhere, RESOLUTION_LOOKUP_TIMEOUT_MS, type ResolutionDeps } from "../lib/obligation-resolution.js";

/**
 * resolveElsewhere: three best-effort metadata lookups (Gmail sent, calendar
 * ended, Slack own messages), any hit clears an obligation. The cases exercise the resolver
 * itself against fake ResolutionDeps.
 */

const NOW = new Date("2026-08-20T12:00:00Z");

function obligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    threadId: "t-1",
    subject: "Re: pilot terms",
    counterpartyName: "Grete Moe",
    counterpartyAddress: "angela@example.com",
    lastMessageAt: new Date("2026-08-10T09:00:00Z"),
    ageHours: 60,
    isRePing: false,
    unansweredCount: 1,
    source: "gmail",
    counterpartyEmails: ["angela@example.com"],
    counterpartySlackUserId: "U123ANGELA",
    ...overrides,
  };
}

function deps(overrides: Partial<ResolutionDeps> = {}): ResolutionDeps {
  return {
    gmailSentAfter: async () => null,
    calendarEndedWith: async () => null,
    slackOwnMessageAfter: () => null,
    ...overrides,
  };
}

describe("resolveElsewhere", () => {
  it("(a) no hits from any source — resolution is null, all 3 consulted, none unreadable", async () => {
    const result = await resolveElsewhere(obligation(), deps(), NOW);
    expect(result.resolution).toBeNull();
    expect(result.consulted).toEqual(["gmail", "calendar", "slack"]);
    expect(result.unreadable).toEqual([]);
  });

  it("(b) a Gmail message sent to them AFTER `since` resolves via gmail, with the date in the evidence", async () => {
    const o = obligation({ lastMessageAt: new Date("2026-08-10T09:00:00Z") });
    const sentAt = new Date("2026-08-15T14:02:00Z"); // 16:02 Berlin (CEST, UTC+2 in August)
    const d = deps({
      gmailSentAfter: async (_addrs, since) => (sentAt > since ? sentAt : null),
    });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution).not.toBeNull();
    expect(result.resolution!.via).toBe("gmail");
    expect(result.resolution!.at).toEqual(sentAt);
    expect(result.resolution!.evidence).toBe("you emailed them 2026-08-15 16:02");
    // Resolution carries the same consulted/unreadable lists as the outer result.
    expect(result.resolution!.consulted).toEqual(result.consulted);
    expect(result.resolution!.unreadable).toEqual(result.unreadable);
  });

  it("(c) a Gmail message sent BEFORE `since` is not a hit", async () => {
    const o = obligation({ lastMessageAt: new Date("2026-08-10T09:00:00Z") });
    const sentAt = new Date("2026-08-05T09:00:00Z"); // before lastMessageAt
    const d = deps({
      gmailSentAfter: async (_addrs, since) => (sentAt > since ? sentAt : null),
    });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution).toBeNull();
    expect(result.unreadable).toEqual([]);
  });

  it("(d) a calendar event with an attendee match that ENDED resolves via calendar", async () => {
    const o = obligation({ lastMessageAt: new Date("2026-08-10T09:00:00Z") });
    const meeting = { at: new Date("2026-08-13T11:00:00Z"), summary: "Test Owner and Grete Moe" }; // 13:00 Berlin
    const d = deps({
      calendarEndedWith: async (_addrs, since, now) => (meeting.at > since && meeting.at <= now ? meeting : null),
    });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution!.via).toBe("calendar");
    expect(result.resolution!.at).toEqual(meeting.at);
    expect(result.resolution!.evidence).toBe("you met 2026-08-13 13:00: Test Owner and Grete Moe");
  });

  it("(d) a calendar event that has NOT ended (its end is after `now`) is not a hit", async () => {
    const o = obligation({ lastMessageAt: new Date("2026-08-10T09:00:00Z") });
    const meeting = { at: new Date("2026-08-25T11:00:00Z"), summary: "future meeting" }; // after NOW
    const d = deps({
      calendarEndedWith: async (_addrs, since, now) => (meeting.at > since && meeting.at <= now ? meeting : null),
    });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution).toBeNull();
  });

  it("(e) a dep that throws lands in `unreadable`; the others still decide the resolution", async () => {
    const o = obligation();
    const sentAt = new Date("2026-08-15T14:02:00Z");
    const d = deps({
      gmailSentAfter: async () => sentAt,
      calendarEndedWith: async () => {
        throw new Error("calendar API 500");
      },
    });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.unreadable).toEqual(["calendar"]);
    expect(result.resolution!.via).toBe("gmail");
  });

  it("(f) a dep that hangs times out — lands in `unreadable`, real wall time stays well under 6s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const start = Date.now();
      const hang = new Promise<Date | null>(() => {
        /* never resolves */
      });
      const o = obligation();
      const d = deps({ gmailSentAfter: () => hang });

      const pending = resolveElsewhere(o, d, NOW);
      await vi.advanceTimersByTimeAsync(RESOLUTION_LOOKUP_TIMEOUT_MS + 50);
      const result = await pending;

      expect(result.unreadable).toEqual(["gmail"]);
      expect(result.resolution).toBeNull();
      expect(Date.now() - start).toBeLessThan(6000); // real wall clock — Date wasn't faked
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the LATEST hit when multiple sources hit", async () => {
    const o = obligation();
    const earlier = new Date("2026-08-14T09:00:00Z");
    const later = new Date("2026-08-16T09:00:00Z");
    const d = deps({
      gmailSentAfter: async () => earlier,
      slackOwnMessageAfter: () => later,
    });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution!.via).toBe("slack");
    expect(result.resolution!.at).toEqual(later);
  });

  it("ties break by fixed source order (gmail, calendar, slack)", async () => {
    const o = obligation();
    const sameTime = new Date("2026-08-16T09:00:00Z");
    const d = deps({
      slackOwnMessageAfter: () => sameTime,
      gmailSentAfter: async () => sameTime,
    });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution!.via).toBe("gmail"); // gmail precedes slack in SOURCES order
  });

  it("Slack own-message hit produces the slack evidence sentence", async () => {
    const o = obligation();
    const at = new Date("2026-08-16T08:30:00Z");
    const d = deps({ slackOwnMessageAfter: () => at });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution!.via).toBe("slack");
    expect(result.resolution!.evidence).toBe("you wrote to them on Slack 2026-08-16 10:30");
  });
});
