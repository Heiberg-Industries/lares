import { describe, it, expect } from "vitest";
import { parseOrgDomains, resolveOrgForEmail } from "../lib/accounts";

const orgs = ["heiberg", "zero7"];
const domains = parseOrgDomains("zero7=project.example;heiberg=owner.example,orakel.cloud");

describe("parseOrgDomains", () => {
  it("parses orgs to domain lists", () => {
    expect(domains).toEqual({ zero7: ["project.example"], heiberg: ["owner.example", "orakel.cloud"] });
  });
  it("returns an empty map for an unset or malformed value", () => {
    expect(parseOrgDomains(undefined)).toEqual({});
    expect(parseOrgDomains("garbage")).toEqual({});
  });
});

describe("resolveOrgForEmail", () => {
  it("picks the org owning the address's domain, case-insensitively", () => {
    expect(resolveOrgForEmail("owner@project.example", orgs, domains, undefined)).toEqual({ org: "zero7" });
    expect(resolveOrgForEmail("bendik@orakel.cloud", orgs, domains, undefined)).toEqual({ org: "heiberg" });
  });

  it("falls back to the named default when no domain matches", () => {
    expect(resolveOrgForEmail("x@example.com", orgs, domains, "heiberg")).toEqual({ org: "heiberg" });
  });

  // Minor E (final review): org ids are always lowercase (googleOrgs() lowercases everything it
  // discovers), but GOOGLE_DEFAULT_ORG is a human-set env var under no such obligation —
  // GOOGLE_DEFAULT_ORG=Heiberg used to compare unequal to "heiberg" and silently disable the
  // fallback, surfacing as a confusing "no client mapped" error instead.
  it("matches the named default case-insensitively", () => {
    expect(resolveOrgForEmail("x@example.com", orgs, domains, "Heiberg")).toEqual({ org: "heiberg" });
  });

  it("falls back to the only configured client when there is exactly one", () => {
    expect(resolveOrgForEmail("x@example.com", ["heiberg"], {}, undefined)).toEqual({ org: "heiberg" });
  });

  it("asks rather than guessing when several clients could serve an unknown domain", () => {
    const r = resolveOrgForEmail("x@example.com", orgs, domains, undefined);
    expect(r).toEqual({ error: expect.stringContaining("example.com") });
  });

  it("rejects an address with no domain", () => {
    expect(resolveOrgForEmail("nonsense", orgs, domains, undefined)).toEqual({
      error: expect.stringContaining("not an email address"),
    });
  });
});
