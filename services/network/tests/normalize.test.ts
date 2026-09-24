import { describe, it, expect } from "vitest";
import { normalizeEmail, normalizePhone, normalizeName, normalizeLinkedInUrl } from "../lib/normalize.js";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  owner@owner.example ")).toBe("owner@owner.example");
  });
  it("rejects non-emails", () => {
    expect(normalizeEmail("not-an-email")).toBeNull();
  });
});

describe("normalizePhone", () => {
  it("strips formatting and keeps country code", () => {
    expect(normalizePhone("+47 982 12 345")).toBe("+4798212345");
  });
  it("assumes +47 for bare 8-digit Norwegian numbers", () => {
    expect(normalizePhone("982 12 345")).toBe("+4798212345");
  });
  it("converts 00-prefix to +", () => {
    expect(normalizePhone("004798212345")).toBe("+4798212345");
  });
  it("rejects short junk", () => {
    expect(normalizePhone("123")).toBeNull();
  });
});

describe("normalizeName", () => {
  it("lowercases, folds diacritics, collapses whitespace", () => {
    expect(normalizeName("  Bendik   HEIBERG ")).toBe("bendik heiberg");
    expect(normalizeName("Pål Sørensen")).toBe("pal sorensen");
  });
});

describe("normalizeLinkedInUrl", () => {
  it("canonicalizes to https://www.linkedin.com/in/<slug>", () => {
    expect(normalizeLinkedInUrl("https://linkedin.com/in/BendikHeiberg/?utm=x")).toBe("https://www.linkedin.com/in/bendikheiberg");
    expect(normalizeLinkedInUrl("https://www.linkedin.com/in/yelbaiev")).toBe("https://www.linkedin.com/in/yelbaiev");
  });
  it("rejects non-profile urls", () => {
    expect(normalizeLinkedInUrl("https://example.com/in/foo")).toBeNull();
  });
});
