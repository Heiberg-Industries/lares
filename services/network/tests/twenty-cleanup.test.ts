/**
 * Tests for the Twenty junk-people classifier (lib/twenty-cleanup.ts).
 * Pure functions only — no HTTP. The "very safe" gate: an address that looks
 * like a newsletter/order/no-reply sender, auto-created by Twenty's mailbox or
 * calendar sync, with NO relationship (deal/note/task) and NO curation signal
 * (LinkedIn, phone, lares Pulse match, or an lares-pushed link).
 */

import { describe, it, expect } from "vitest";
import { isJunkEmail, classifyJunkPeople, type CleanupPerson } from "../lib/twenty-cleanup.js";

function p(over: Partial<CleanupPerson> = {}): CleanupPerson {
  return {
    id: over.id ?? "id-1",
    firstName: over.firstName ?? "Some",
    lastName: over.lastName ?? "Body",
    primaryEmail: over.primaryEmail ?? "some.body@example.com",
    source: over.source ?? "EMAIL",
    hasLinkedin: over.hasLinkedin ?? false,
    hasPhone: over.hasPhone ?? false,
    hasPulse: over.hasPulse ?? false,
  };
}

const emptyCtx = {
  oppPersonIds: new Set<string>(),
  notePersonIds: new Set<string>(),
  taskPersonIds: new Set<string>(),
  laresLinkedIds: new Set<string>(),
};

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

describe("classifyJunkPeople", () => {
  it("flags an auto-synced junk address with no relationship or curation", () => {
    const r = classifyJunkPeople([p({ id: "j1", primaryEmail: "noreply@dnb.no", source: "EMAIL" })], emptyCtx);
    expect(r.junk.map((x) => x.id)).toEqual(["j1"]);
    expect(r.protectedByRelationship).toBe(0);
  });

  it("does NOT flag a junk address that was deliberately added (source API/manual)", () => {
    const r = classifyJunkPeople([p({ id: "a1", primaryEmail: "noreply@dnb.no", source: "API" })], emptyCtx);
    expect(r.junk).toEqual([]);
  });

  it("does NOT flag a real personal address even when auto-synced", () => {
    const r = classifyJunkPeople([p({ id: "real", primaryEmail: "kamilla@thecabinet.no", source: "EMAIL" })], emptyCtx);
    expect(r.junk).toEqual([]);
  });

  it("protects a junk-looking person who is on a deal (opportunity point of contact)", () => {
    const ctx = { ...emptyCtx, oppPersonIds: new Set(["d1"]) };
    const r = classifyJunkPeople([p({ id: "d1", primaryEmail: "info@startup.no", source: "EMAIL" })], ctx);
    expect(r.junk).toEqual([]);
    expect(r.protectedByRelationship).toBe(1);
  });

  it("protects a junk-looking person who has a note or task", () => {
    const ctx = { ...emptyCtx, notePersonIds: new Set(["n1"]), taskPersonIds: new Set(["t1"]) };
    const r = classifyJunkPeople(
      [p({ id: "n1", primaryEmail: "info@a.no", source: "EMAIL" }), p({ id: "t1", primaryEmail: "support@b.no", source: "EMAIL" })],
      ctx,
    );
    expect(r.junk).toEqual([]);
    expect(r.protectedByRelationship).toBe(2);
  });

  it("protects a junk-looking person with a curation signal (LinkedIn / phone / Pulse / lares link)", () => {
    const people = [
      p({ id: "li", primaryEmail: "hello@x.no", source: "EMAIL", hasLinkedin: true }),
      p({ id: "ph", primaryEmail: "hello@y.no", source: "EMAIL", hasPhone: true }),
      p({ id: "pu", primaryEmail: "hello@z.no", source: "EMAIL", hasPulse: true }),
    ];
    const ctx = { ...emptyCtx, laresLinkedIds: new Set(["link1"]) };
    const withLink = [...people, p({ id: "link1", primaryEmail: "hello@w.no", source: "EMAIL" })];
    const r = classifyJunkPeople(withLink, ctx);
    expect(r.junk).toEqual([]);
    expect(r.protectedByRelationship).toBe(4);
  });

  it("returns name + email on each junk record for the review list", () => {
    const r = classifyJunkPeople([p({ id: "j", primaryEmail: "ordre@shop.no", firstName: "Ordre", lastName: "", source: "EMAIL" })], emptyCtx);
    expect(r.junk[0]).toMatchObject({ id: "j", email: "ordre@shop.no", name: "Ordre" });
  });
});
