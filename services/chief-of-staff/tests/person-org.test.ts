import { describe, it, expect } from "vitest";

import { PERSONAL_DOMAINS } from "@lares/junk";

import {
  FREE_MAIL_DOMAINS,
  deriveOrgQuery,
  isFreeMailDomain,
  orgSearchTerms,
  rankOrgHits,
  workDomainOf,
} from "../lib/person/org.js";
import type { Candidate, PersonQuery } from "../lib/person/types.js";

/**
 * ORB-166 — the pure half of the organisation stage: what company is behind this person, and
 * what terms the note stores should be asked for.
 *
 * No I/O here at all, which is the point: the decision "this address has no organisation behind
 * it" is the one that stops a `gmail.com` lookup from ever touching a store, so it has to be
 * testable without one.
 */

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  source: "twenty",
  sourceId: "p1",
  displayName: "Lars Eriksen",
  emails: ["lars@partner.example"],
  ...over,
});

describe("isFreeMailDomain — ONE list, and the reason it exists", () => {
  it("knows the big consumer mailboxes", () => {
    for (const d of [
      "gmail.com", "googlemail.com",
      "hotmail.com", "outlook.com", "live.com", "msn.com",
      "icloud.com", "me.com", "mac.com",
      "yahoo.com", "proton.me", "protonmail.com",
    ]) {
      expect(isFreeMailDomain(d), d).toBe(true);
    }
  });

  it("knows the Norwegian consumer ISP mailboxes — Bendik's correspondents actually use these", () => {
    for (const d of ["online.no", "start.no", "frisurf.no", "broadpark.no", "getmail.no", "c2i.net", "lyse.net"]) {
      expect(isFreeMailDomain(d), d).toBe(true);
    }
  });

  it("is case- and whitespace-insensitive, and tolerates a leading @", () => {
    expect(isFreeMailDomain(" GMail.CoM ")).toBe(true);
    expect(isFreeMailDomain("@icloud.com")).toBe(true);
  });

  it("does NOT swallow a company domain that merely looks consumer-ish", () => {
    for (const d of ["atcyrus.com", "partner.example", "owner.example", "telenor.no", "yahooinc.com", "protonmail.ch.example"]) {
      expect(isFreeMailDomain(d), d).toBe(false);
    }
  });

  it("contains @lares/junk's PERSONAL_DOMAINS whole — one idea, not two drifting copies", () => {
    // The same predicate reached from the other direction (classifySender, lib/email-triage.ts).
    // If someone adds a domain there, this list gets it too; the union is the enforcement.
    for (const d of PERSONAL_DOMAINS) expect(FREE_MAIL_DOMAINS.has(d), d).toBe(true);
    expect(FREE_MAIL_DOMAINS.size).toBeGreaterThan(PERSONAL_DOMAINS.size);
  });
});

describe("workDomainOf", () => {
  it("takes the domain off a work address", () => {
    expect(workDomainOf("connor@atcyrus.com")).toBe("atcyrus.com");
    expect(workDomainOf("Connor Turland <Connor@AtCyrus.com>")).toBe("atcyrus.com");
  });

  it("returns nothing for a personal mailbox — a gmail.com 'company' is noise", () => {
    expect(workDomainOf("someone@gmail.com")).toBeUndefined();
    expect(workDomainOf("user@online.no")).toBeUndefined();
  });

  it("returns nothing for something that is not an address", () => {
    expect(workDomainOf("Lars Eriksen")).toBeUndefined();
    expect(workDomainOf("")).toBeUndefined();
    expect(workDomainOf(undefined)).toBeUndefined();
  });
});

describe("deriveOrgQuery", () => {
  it("takes the domain from the queried address when nobody is known yet — the Connor shape", () => {
    expect(deriveOrgQuery({ email: "connor@atcyrus.com" })).toEqual({ domain: "atcyrus.com" });
  });

  it("prefers the company a source vouched for, and pairs it with the resolved person's domain", () => {
    const person = candidate({ source: "pulse", company: "Nomono" });
    expect(deriveOrgQuery({ name: "Lars Eriksen" }, person, [person])).toEqual({
      name: "Nomono",
      domain: "partner.example",
    });
  });

  it("takes a company name off ANY candidate when the resolved one carries none", () => {
    const resolved = candidate();
    const other = candidate({ source: "pulse", sourceId: "c9", company: "Nomono" });
    expect(deriveOrgQuery({ name: "Lars Eriksen" }, resolved, [resolved, other])).toEqual({
      name: "Nomono",
      domain: "partner.example",
    });
  });

  it("keeps the NAME even when the only address is a personal one — the domain half is what is skipped", () => {
    const person = candidate({ emails: ["lars@gmail.com"], company: "Nomono" });
    expect(deriveOrgQuery({ email: "lars@gmail.com" }, person, [person])).toEqual({ name: "Nomono" });
  });

  it("is null when there is no company, no work domain and no CRM record to ask", () => {
    expect(deriveOrgQuery({ email: "someone@gmail.com" })).toBeNull();
    expect(deriveOrgQuery({ name: "Someone" })).toBeNull();
    expect(deriveOrgQuery({ emails: ["a@icloud.com", "b@me.com"] })).toBeNull();
  });

  /**
   * ORB-166 fix round 1, Finding 2a. Twenty's person record carries a companyId and no company
   * NAME, so a CRM-only person on a personal mailbox used to derive to null and render as "no
   * company on file" — while the CRM had one on file, one call away.
   */
  it("carries the CRM record id so the adapter can resolve a name derivation cannot see", () => {
    const person = candidate({ source: "twenty", sourceId: "p1", emails: ["lars@gmail.com"] });
    expect(deriveOrgQuery({ email: "lars@gmail.com" }, person, [person])).toEqual({ crmRecordId: "p1" });
  });

  it("carries it alongside a work domain too — the name is still only in the CRM", () => {
    const person = candidate({ source: "twenty", sourceId: "p1" });
    expect(deriveOrgQuery({ name: "Lars Eriksen" }, person, [person])).toEqual({
      domain: "partner.example",
      crmRecordId: "p1",
    });
  });

  it("does NOT ask the CRM again when a source already vouched for a name", () => {
    const person = candidate({ source: "twenty", sourceId: "p1", company: "Nomono" });
    expect(deriveOrgQuery({ name: "Lars Eriksen" }, person, [person])).toEqual({
      name: "Nomono",
      domain: "partner.example",
    });
  });

  it("has no record id to offer for a person the CRM never sourced", () => {
    const person = candidate({ source: "pulse", sourceId: "c9", emails: ["lars@gmail.com"] });
    expect(deriveOrgQuery({ email: "lars@gmail.com" }, person, [person])).toBeNull();
  });

  it("walks a merge query's addresses in order and takes the first that is a WORK domain", () => {
    const q: PersonQuery = { emails: ["lars@gmail.com", "lars@partner.example"] };
    expect(deriveOrgQuery(q)).toEqual({ domain: "partner.example" });
  });
});

describe("orgSearchTerms", () => {
  it("asks by name, by domain, and by the domain's bare label", () => {
    expect(orgSearchTerms({ name: "Cyrus", domain: "atcyrus.com" })).toEqual([
      "Cyrus",
      "atcyrus.com",
      "atcyrus",
    ]);
  });

  it("does not ask the same thing twice when the label IS the name", () => {
    expect(orgSearchTerms({ name: "Partner", domain: "partner.example" })).toEqual(["Partner", "partner.example"]);
  });

  it("works from a domain alone, and from a name alone", () => {
    expect(orgSearchTerms({ domain: "atcyrus.com" })).toEqual(["atcyrus.com", "atcyrus"]);
    expect(orgSearchTerms({ name: "Nomono" })).toEqual(["Nomono"]);
  });

  it("drops a label too short for the store's tokeniser to keep", () => {
    // notes-store drops tokens under two characters, so a one-letter label would search for
    // nothing at all and return the whole partial-match fallback.
    expect(orgSearchTerms({ domain: "x.no" })).toEqual(["x.no"]);
  });
});

/**
 * ORB-166 fix round 1, Finding 1 — a cap needs a known ordering.
 *
 * `searchNotes`' primary pass returns WALK ORDER, not relevance. Slicing that list unranked is how
 * twelve notes mentioning "Nomono" become three clippings and a daily note, with
 * `companies/nomono.md` never printed at all — and Saga then describes the relationship from a
 * clipped article, confidently.
 */
describe("rankOrgHits", () => {
  it("keeps the canonical note even when it walks LAST", () => {
    const walkOrder = [
      "_inbox/clips/2026-01-02-a-long-article-mentioning-nomono.md",
      "daily/2026-01-03.md",
      "daily/2026-01-04.md",
      "meetings/2026-02-11-nomono-sync.md",
      "companies/nomono.md",
    ];
    expect(rankOrgHits(walkOrder, "Nomono")[0]).toBe("companies/nomono.md");
    // And it survives the cap the source applies.
    expect(rankOrgHits(walkOrder, "Nomono").slice(0, 3)).toContain("companies/nomono.md");
  });

  it("prefers a filename match over a body-only mention", () => {
    const ranked = rankOrgHits(["daily/2026-01-03.md", "notes/nomono-pilot.md"], "Nomono");
    expect(ranked[0]).toBe("notes/nomono-pilot.md");
  });

  it("ranks on the term's TOKENS, so a domain finds the note named for the company", () => {
    const ranked = rankOrgHits(
      ["_inbox/clips/some-com-article.md", "tools/atcyrus.md"],
      "atcyrus.com",
    );
    expect(ranked[0]).toBe("tools/atcyrus.md");
  });

  it("is deterministic for interchangeable paths — shallower, then shorter, then alphabetical", () => {
    const ranked = rankOrgHits(["b/nomono.md", "a/nomono.md", "nomono.md"], "Nomono");
    expect(ranked).toEqual(["nomono.md", "a/nomono.md", "b/nomono.md"]);
  });

  it("never drops or duplicates a hit, and does not mutate its input", () => {
    const input = ["z.md", "companies/nomono.md", "a.md"];
    const copy = [...input];
    const ranked = rankOrgHits(input, "Nomono");
    expect(ranked).toHaveLength(3);
    expect(new Set(ranked)).toEqual(new Set(input));
    expect(input).toEqual(copy);
  });

  it("returns the list unharmed when the term has no usable tokens", () => {
    expect(rankOrgHits(["b.md", "a.md"], "x")).toEqual(["a.md", "b.md"]);
  });
});
