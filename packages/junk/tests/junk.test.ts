/**
 * Tests for @lares/junk — the two junk-classification lineages this package
 * unifies (see src/index.ts for the split rationale):
 *
 *   - isJunkEmail(email)   — regex-only, used to gate Twenty-record cleanup
 *                            (an earlier cleanup module, since removed) and as
 *                            the email half of the radar's contact classifier
 *                            (services/agent-runtime/lib/commercial/junk.ts).
 *   - classifySender(from) — STRICT/GENERIC two-class localpart split +
 *                            vendor/personal domain sets, used for inbound
 *                            email triage (services/agent-runtime/lib/adapters/junk-sender.ts).
 *
 * Merged from an earlier cleanup test (isJunkEmail) and
 * services/agent-runtime/tests/junk-sender.test.ts (classifySender) per
 * ADR-0007 — this is now the canonical home for both.
 */

import { describe, it, expect } from "vitest";
import { isJunkEmail, classifySender, VENDOR_DOMAINS, PERSONAL_DOMAINS } from "../src/index.js";

describe("isJunkEmail", () => {
  it("matches no-reply / newsletter / order / customer-service local parts", () => {
    for (const e of [
      "noreply@info.bank.example",
      "no-reply@mg.booking.example",
      "newsletter@brand.com",
      "ordre@shop.example",
      "kundeservice@isp.example",
      "unsubscribe@mail.courses.example",
      "support@fitapp.example",
    ]) {
      expect(isJunkEmail(e), e).toBe(true);
    }
  });

  it("matches the widened localparts added for the radar's booking/office case (reservation, resepsjon, office)", () => {
    for (const e of ["reservation@hotel-booking.example", "resepsjon@firma.example", "office@somecompany.example"]) {
      expect(isJunkEmail(e), e).toBe(true);
    }
  });

  it("matches known newsletter/ESP sending domains", () => {
    expect(isJunkEmail("a16zcrypto@substack.com")).toBe(true);
    expect(isJunkEmail("x@unsubscribe.mailchimpapp.net")).toBe(true);
  });

  it("does NOT match a normal personal/work address", () => {
    for (const e of ["family-1@home.example", "per.hansen@firma.example", "tom@bank.example"]) {
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
    ["Airbnb <express@airbnb.com>", "automated"], // transactional vendor domain
    ["Pat Partner (LinkedIn Partner) <pat.partner@linkedin.com>", "automated"], // vendor domain, InMail/ads
    ["noreply@stripe.com", "automated"], // classic localpart
    ["newsletter@substack.com", "automated"],
    ["booking@hotel.example", "automated"],
    ["resepsjon@firma.example", "automated"],
    ["notifications@github.com", "automated"],
  ])("flags %s as automated", (from, want) => {
    expect(classifySender(from)).toBe(want);
  });

  it.each([
    ["Grete Moe <grete@example.com>", "unknown"], // real human — must pass through
    ["Tom Ortiz <tom@accelerator.example>", "unknown"],
    ["info.lie@gmail.com", "unknown"], // human whose NAME resembles a keyword mid-token
    ["team.lead.hansen@firma.example", "unknown"], // corporate human — generic word as segment, not whole localpart
    ["office.manager.olsen@firma.example", "unknown"],
    ["vera.info@firma.example", "unknown"],
    ["hr.director@firma.example", "unknown"],
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
