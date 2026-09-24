/**
 * lib/conflict-evidence.ts — LAR-59-s2, the pure matcher for "does this mail cancel this
 * booking?". Pure, no I/O: every fixture below is a hand-built, invented mail (never a real
 * address — `example.invalid` throughout), and the table is deliberately weighted toward the
 * cases that decide whether a later approval card can trust this module: a hotel and an
 * airline and a booking platform, English and Norwegian, and every shape of near-miss that
 * must NOT read as a cancellation (a confirmation, a modification, a newsletter, a cancellation
 * of a different booking at the same vendor).
 */
import { describe, it, expect } from "vitest";

import {
  CANCEL_WORDS,
  NOT_EVIDENCE,
  vendorOf,
  mentionsDate,
  matchCancellation,
  evidenceSentence,
  type EvidenceEvent,
  type CancellationMatch,
} from "../lib/conflict-evidence.js";
import type { MailMessage } from "../lib/google.js";

function mail(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "m1",
    threadId: "t1",
    from: "Vendor <vendor@example.invalid>",
    to: ["owner@example.invalid"],
    subject: "Subject",
    bodyText: "Body",
    sentAt: "2026-08-01T09:00:00Z",
    messageId: "<m1@example.invalid>",
    references: "",
    isCalendarNotice: false,
    cc: [],
    ...overrides,
  };
}

const STANDARD: EvidenceEvent = {
  title: "Stay at The Standard",
  start: "2026-08-26",
  end: "2026-08-31",
};

describe("word lists", () => {
  it("CANCEL_WORDS holds exactly the spec's English and Norwegian phrases", () => {
    expect(CANCEL_WORDS).toEqual([
      "cancelled", "canceled", "cancellation confirmed", "kansellert", "avbestilt", "avbestilling bekreftet",
    ]);
  });

  it("NOT_EVIDENCE holds exactly the spec's veto phrases", () => {
    expect(NOT_EVIDENCE).toEqual([
      "free cancellation", "cancellation policy", "cancel anytime", "gratis avbestilling", "avbestillingsregler",
    ]);
  });
});

describe("vendorOf", () => {
  it("strips the leading phrase and keeps the rest", () => {
    expect(vendorOf("Stay at The Standard")).toBe("The Standard");
    expect(vendorOf("Opphold på Thon Hotel Opera")).toBe("Thon Hotel Opera");
    expect(vendorOf("Check-in Scandic Oslo Airport")).toBe("Scandic Oslo Airport");
    expect(vendorOf("Hotell Continental")).toBe("Continental");
    expect(vendorOf("Hotel Continental")).toBe("Continental");
  });

  it("returns null when nothing worth matching survives the strip", () => {
    expect(vendorOf("Hotel")).toBeNull();
    expect(vendorOf("Stay at")).toBeNull();
    expect(vendorOf("")).toBeNull();
  });

  it("returns the title itself when no known prefix is present and it is long enough", () => {
    expect(vendorOf("SK459 OSL-JFK")).toBe("SK459 OSL-JFK");
  });
});

describe("mentionsDate", () => {
  const DAY = "2026-08-26";

  it.each([
    ["the ISO date itself", "confirmed for 2026-08-26, thanks"],
    ["D Mon", "see you on 26 Aug!"],
    ["D. mon", "avbestilt: 26. aug"],
    ["D. month", "kansellert 26. august 2026"],
    ["Month D", "cancelled — August 26 booking"],
    ["Mon D", "cancelled, Aug 26"],
    ["DD.MM", "cancelled 26.08"],
    ["DD/MM", "cancelled 26/08"],
  ])("recognises the %s form", (_label, text) => {
    expect(mentionsDate(text, DAY)).toBe(true);
  });

  it("is false when the day is not mentioned in any known shape", () => {
    expect(mentionsDate("your booking is cancelled", DAY)).toBe(false);
    expect(mentionsDate("cancelled for 12 Sept 2026", DAY)).toBe(false);
  });

  it("never lets a bare '26' inside '2026' count as the day", () => {
    // "2026" contains the substring "26", which must not satisfy a check for the day alone.
    expect(mentionsDate("booking reference 2026 confirmed", DAY)).toBe(false);
  });
});

describe("matchCancellation — the realistic table", () => {
  it("hotel (en), naming the check-in date: strong — the ticket's own worked example", () => {
    const m = mail({
      from: "The Standard <reservations@thestandardhotels.com>",
      subject: "Your reservation at The Standard has been cancelled",
      bodyText: "We're sorry to see you go. Your stay from 26 Aug 2026 has been cancelled as requested.",
      sentAt: "2026-08-18T09:00:00Z",
    });
    expect(matchCancellation(STANDARD, [m])).toEqual({ strength: "strong", mail: m });
  });

  it("hotel (en), the same mail without a date: weak", () => {
    const m = mail({
      from: "The Standard <reservations@thestandardhotels.com>",
      subject: "Your reservation at The Standard has been cancelled",
      bodyText: "We're sorry to see you go. Your stay has been cancelled as requested.",
      sentAt: "2026-08-18T09:00:00Z",
    });
    expect(matchCancellation(STANDARD, [m])).toEqual({ strength: "weak", mail: m });
  });

  it("hotel (nb), Norwegian wording and date: strong", () => {
    const thon: EvidenceEvent = { title: "Opphold på Thon Hotel Opera", start: "2026-08-26", end: "2026-08-31" };
    const m = mail({
      from: "Thon Hotels <ingen-svar@thonhotels.no>",
      subject: "Avbestilt: Thon Hotel Opera",
      bodyText: "Din reservasjon hos Thon Hotel Opera fra 26. aug til 31. aug 2026 er avbestilt.",
      sentAt: "2026-08-18T09:00:00Z",
    });
    expect(matchCancellation(thon, [m])).toEqual({ strength: "strong", mail: m });
  });

  it("airline (nb), a cancelled flight naming its own date: strong", () => {
    const flight: EvidenceEvent = { title: "SK459 OSL-JFK", start: "2026-08-26T09:00:00Z", end: "2026-08-26T10:30:00Z" };
    const m = mail({
      from: "SAS <no-reply@flysas.com>",
      subject: "Kansellert: SK459 OSL-JFK",
      bodyText: "Din flyreise SK459 fra Oslo til New York den 26. august 2026 er kansellert.",
      sentAt: "2026-08-20T09:00:00Z",
    });
    expect(matchCancellation(flight, [m])).toEqual({ strength: "strong", mail: m });
  });

  it("booking platform (en), the vendor named through a reseller: strong", () => {
    const publicNy: EvidenceEvent = { title: "Stay at PUBLIC Hotel New York", start: "2026-08-26", end: "2026-08-31" };
    const m = mail({
      from: "Booking.com <noreply@booking.com>",
      subject: "Cancellation confirmed — PUBLIC Hotel New York",
      bodyText: "Your booking at PUBLIC Hotel New York for 26 Aug 2026 has been cancelled.",
      sentAt: "2026-08-15T09:00:00Z",
    });
    expect(matchCancellation(publicNy, [m])).toEqual({ strength: "strong", mail: m });
  });

  it("a confirmation that is NOT a cancellation: null", () => {
    const m = mail({
      subject: "Your reservation at The Standard is confirmed",
      bodyText: "We look forward to welcoming you on 26 Aug 2026.",
      sentAt: "2026-08-01T09:00:00Z",
    });
    expect(matchCancellation(STANDARD, [m])).toBeNull();
  });

  it("a cancellation for a DIFFERENT booking at the same hotel: weak, never strong", () => {
    const m = mail({
      subject: "Your reservation at The Standard has been cancelled",
      bodyText: "Your stay from 12 Sept 2026 has been cancelled as requested.",
      sentAt: "2026-08-10T09:00:00Z",
    });
    expect(matchCancellation(STANDARD, [m])).toEqual({ strength: "weak", mail: m });
  });

  it("a modification mail ('your booking has changed'): null — no cancel word appears", () => {
    const m = mail({
      subject: "Your booking at The Standard has changed",
      bodyText: "Your check-in date has been updated to 28 Aug 2026. No cancellation fee applies.",
      sentAt: "2026-08-10T09:00:00Z",
    });
    expect(matchCancellation(STANDARD, [m])).toBeNull();
  });

  it("a marketing mail mentioning 'cancel anytime': null — vetoed even though a cancel word also appears", () => {
    const m = mail({
      subject: "Flexible bookings — cancel anytime",
      bodyText:
        "Some guests have had bookings cancelled, but we always offer free cancellation and you " +
        "can cancel anytime — including at The Standard.",
      sentAt: "2026-08-05T09:00:00Z",
    });
    expect(matchCancellation(STANDARD, [m])).toBeNull();
  });

  it("a forwarded cancellation still matches — the wrapping text does not hide it", () => {
    const m = mail({
      subject: "Fwd: Your reservation at The Standard has been cancelled",
      bodyText:
        "---------- Forwarded message ---------\n" +
        "From: The Standard <reservations@thestandardhotels.com>\n" +
        "Date: 18 Aug 2026\n" +
        "Subject: Your reservation at The Standard has been cancelled\n\n" +
        "Your reservation at The Standard for 26 Aug 2026 has been cancelled as requested.",
      sentAt: "2026-08-19T10:00:00Z",
    });
    expect(matchCancellation(STANDARD, [m])).toEqual({ strength: "strong", mail: m });
  });

  it("a different vendor entirely: null", () => {
    const m = mail({
      subject: "Your reservation at Hotel Continental has been cancelled",
      bodyText: "Your stay from 26 Aug 2026 has been cancelled as requested.",
      sentAt: "2026-08-18T09:00:00Z",
    });
    expect(matchCancellation(STANDARD, [m])).toBeNull();
  });

  it("a mail dated after check-in: null — a cancellation that arrives after arrival proves nothing", () => {
    const m = mail({
      subject: "Your reservation at The Standard has been cancelled",
      bodyText: "Your stay from 26 Aug 2026 has been cancelled as requested.",
      sentAt: "2026-09-01T09:00:00Z", // the 26-31 Aug stay is already over
    });
    expect(matchCancellation(STANDARD, [m])).toBeNull();
  });

  it("a title with no vendor: null, whatever the mail says", () => {
    const bare: EvidenceEvent = { title: "Hotel", start: "2026-08-26", end: "2026-08-31" };
    const m = mail({
      subject: "Your reservation has been cancelled",
      bodyText: "Cancelled for 26 Aug 2026.",
      sentAt: "2026-08-18T09:00:00Z",
    });
    expect(matchCancellation(bare, [m])).toBeNull();
  });

  it("the newest qualifying mail wins", () => {
    const older = mail({
      subject: "Your reservation at The Standard has been cancelled",
      bodyText: "Cancelled, no date given.",
      sentAt: "2026-08-01T09:00:00Z",
    });
    const newer = mail({
      subject: "Your reservation at The Standard has been cancelled",
      bodyText: "Cancelled for 26 Aug 2026.",
      sentAt: "2026-08-18T09:00:00Z",
    });
    expect(matchCancellation(STANDARD, [older, newer])).toEqual({ strength: "strong", mail: newer });
  });

  it("never throws on an empty mail list, or on an unparseable event start", () => {
    expect(matchCancellation(STANDARD, [])).toBeNull();
    expect(matchCancellation({ ...STANDARD, start: "not a date" }, [mail()])).toBeNull();
  });
});

describe("evidenceSentence", () => {
  it("is built only from from, sentAt and a truncated subject — never body text", () => {
    const match: CancellationMatch = {
      strength: "strong",
      mail: mail({
        from: "The Standard <reservations@thestandardhotels.com>",
        subject: "Your reservation at The Standard has been cancelled",
        bodyText: "SECRET body text that must never appear in the sentence.",
        sentAt: "2026-08-18T09:00:00Z",
      }),
    };
    const sentence = evidenceSentence(match);
    expect(sentence).toBe(
      'Cancellation mail from The Standard, 18 Aug 2026: "Your reservation at The Standard has been cancelled".',
    );
    expect(sentence).not.toContain("SECRET");
  });

  it("falls back to the bare address when there is no display name", () => {
    const match: CancellationMatch = {
      strength: "weak",
      mail: mail({ from: "reservations@thestandardhotels.com", subject: "Cancelled", sentAt: "2026-01-05T00:00:00Z" }),
    };
    expect(evidenceSentence(match)).toBe(
      'Cancellation mail from reservations@thestandardhotels.com, 5 Jan 2026: "Cancelled".',
    );
  });

  it("truncates a long subject to 80 characters", () => {
    const longSubject = "X".repeat(100);
    const match: CancellationMatch = {
      strength: "weak",
      mail: mail({ subject: longSubject, sentAt: "2026-08-18T09:00:00Z" }),
    };
    const sentence = evidenceSentence(match);
    expect(sentence).toContain(`${"X".repeat(80)}…`);
    expect(sentence).not.toContain("X".repeat(81));
  });
});
