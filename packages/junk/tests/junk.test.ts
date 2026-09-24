/**
 * Tests for @lares/junk — the two junk-classification lineages this package
 * unifies (see src/index.ts for the split rationale):
 *
 *   - isJunkEmail(email)   — regex-only, used to gate Twenty-record cleanup
 *                            (services/network/lib/twenty-cleanup.ts) and as
 *                            the email half of the radar's contact classifier
 *                            (services/agent-runtime/lib/commercial/junk.ts).
 *   - classifySender(from) — STRICT/GENERIC two-class localpart split +
 *                            vendor/personal domain sets, used for inbound
 *                            email triage (services/agent-runtime/lib/adapters/junk-sender.ts).
 *
 * Merged from services/network/tests/twenty-cleanup.test.ts (isJunkEmail) and
 * services/agent-runtime/tests/junk-sender.test.ts (classifySender) per
 * ADR-0007 Task 5 — this is now the canonical home for both.
 */

import { describe, it, expect } from "vitest";
import { isJunkEmail, classifySender, VENDOR_DOMAINS, PERSONAL_DOMAINS } from "../src/index.js";

describe("isJunkEmail", () => {
  it("matches no-reply / newsletter / order / customer-service local parts", () => {
    for (const e of [
      "noreply@info.dnb.no",
      "no-reply@mg.easytablebooking.com",
      "newsletter@brand.com",
      "ordre@oslofoto.as",
      "kundeservice@altibox.no",
      "unsubscribe@mail.coursera.org",
      "support@zwift.com",
    ]) {
      expect(isJunkEmail(e), e).toBe(true);
    }
  });

  it("matches the widened localparts added for the radar's booking/office case (reservation, resepsjon, office)", () => {
    for (const e of ["reservation@hotel-booking.no", "resepsjon@firma.no", "office@somecompany.no"]) {
      expect(isJunkEmail(e), e).toBe(true);
    }
  });

  it("matches known newsletter/ESP sending domains", () => {
    expect(isJunkEmail("a16zcrypto@substack.com")).toBe(true);
    expect(isJunkEmail("x@unsubscribe.mailchimpapp.net")).toBe(true);
  });

  it("does NOT match a normal personal/work address", () => {
    for (const e of ["kamilla@thecabinet.no", "jorund.johansen@firma.no", "anders@dnb.no"]) {
      expect(isJunkEmail(e), e).toBe(false);
    }
  });

  it("is null-safe", () => {
    expect(isJunkEmail(null)).toBe(false);
    expect(isJunkEmail("")).toBe(false);
  });
});

describe("classifySender", () => {
  it.each([
    ["Airbnb <express@airbnb.com>", "automated"], // transactional vendor domain (live incident)
    ["Aman V (LinkedIn Partner) <amvishwakarma@linkedin.com>", "automated"], // vendor domain, InMail/ads
    ["noreply@stripe.com", "automated"], // classic localpart
    ["newsletter@substack.com", "automated"],
    ["booking@hotel.no", "automated"],
    ["resepsjon@firma.no", "automated"],
    ["notifications@github.com", "automated"],
  ])("flags %s as automated", (from, want) => {
    expect(classifySender(from)).toBe(want);
  });

  it.each([
    ["Angela Berg <angela@example.com>", "unknown"], // real human — must pass through
    ["Jonas Tesfu <jonas@pangeaaccelerator.com>", "unknown"],
    ["info.andersen@gmail.com", "unknown"], // human whose NAME resembles a keyword mid-token
    ["team.lead.hansen@firma.no", "unknown"], // corporate human — generic word as segment, not whole localpart
    ["office.manager.olsen@firma.no", "unknown"],
    ["kari.info@firma.no", "unknown"],
    ["hr.director@firma.no", "unknown"],
  ])("lets %s through as unknown", (from, want) => {
    expect(classifySender(from)).toBe(want);
  });
});

describe("VENDOR_DOMAINS / PERSONAL_DOMAINS", () => {
  it("exposes the vendor and personal domain sets for consumers that need them directly", () => {
    expect(VENDOR_DOMAINS.has("airbnb.com")).toBe(true);
    expect(PERSONAL_DOMAINS.has("gmail.com")).toBe(true);
  });
});
