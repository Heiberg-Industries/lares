/**
 * Tests for the Twenty matcher + bidirectional field sync (lib/twenty-sync.ts).
 * TwentyClient is fully mocked — no HTTP. Db is in-memory — never ~/.lares/network.db.
 */

import { describe, it, expect } from "vitest";
import { openDb, type Db } from "../lib/db.js";
import { upsertContact } from "../lib/resolve.js";
import { syncTwenty } from "../lib/twenty-sync.js";
import type { TwentyClient, TwentyPerson } from "../lib/twenty.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function person(
  id: string,
  firstName: string,
  lastName: string,
  overrides: Partial<TwentyPerson> = {},
): TwentyPerson {
  return {
    id,
    name: { firstName, lastName },
    emails: { primaryEmail: null, additionalEmails: null },
    linkedinLink: null,
    companyId: null,
    strength: null,
    lastContactedAt: null,
    pulse: null,
    lastPersonalContact: null,
    ...overrides,
  };
}

function fakeClient(people: TwentyPerson[]) {
  const updates: { id: string; fields: Record<string, unknown> }[] = [];
  const client: TwentyClient = {
    listPeople: async () => people,
    listPeopleForCleanup: async () => [],
    listNoteTargetPersonIds: async () => [],
    listTaskTargetPersonIds: async () => [],
    deletePerson: async () => {},
    updatePerson: async (id, fields) => {
      updates.push({ id, fields: fields as Record<string, unknown> });
    },
    createPerson: async () => {
      throw new Error("createPerson must not be called by syncTwenty");
    },
    findCompanyByName: async () => null,
    listOpportunities: async () => [],
    getCompanyName: async () => null,
  };
  return { client, updates };
}

function seedContact(
  db: Db,
  displayName: string,
  opts: { email?: string; linkedin?: string; company?: string } = {},
): number {
  const identities: { kind: "email" | "linkedin_url"; value: string }[] = [];
  if (opts.email) identities.push({ kind: "email", value: opts.email });
  if (opts.linkedin) identities.push({ kind: "linkedin_url", value: opts.linkedin });
  return upsertContact(db, {
    displayName,
    company: opts.company ?? null,
    source: "test",
    identities,
  });
}

function addPulse(db: Db, contactId: number, band: string, lastInteractionAt: string | null = null): void {
  db.prepare(
    "INSERT INTO pulse (contact_id, score, band, dormant_warm, last_interaction_at, components) VALUES (?, 1.0, ?, 0, ?, '{}')",
  ).run(contactId, band, lastInteractionAt);
}

let extId = 0;
function addInteraction(db: Db, contactId: number, at = "2026-01-01T00:00:00.000Z"): void {
  db.prepare(
    "INSERT INTO interactions (contact_id, channel, direction, at, external_id) VALUES (?, 'imessage', 'outbound', ?, ?)",
  ).run(contactId, at, `test-${extId++}`);
}

function twentyIdentity(db: Db, contactId: number): string | null {
  const row = db
    .prepare("SELECT value FROM identities WHERE contact_id = ? AND kind = 'twenty_id'")
    .get(contactId) as { value: string } | undefined;
  return row ? row.value : null;
}

function contactRow(db: Db, contactId: number) {
  return db
    .prepare(
      "SELECT twenty_id_cache, twenty_strength, twenty_last_contacted, twenty_synced_at FROM contacts WHERE id = ?",
    )
    .get(contactId) as {
    twenty_id_cache: string | null;
    twenty_strength: string | null;
    twenty_last_contacted: string | null;
    twenty_synced_at: string | null;
  };
}

const NOW = new Date("2026-06-10T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Matching ladder
// ---------------------------------------------------------------------------

describe("syncTwenty — skip self", () => {
  it("excludes the configured self contact from matching entirely", async () => {
    const db = openDb(":memory:");
    const self = seedContact(db, "Bendik Heiberg", { email: "owner@owner.example" });
    const other = seedContact(db, "Peter Hansen", { email: "peter@example.se" });
    const { client } = fakeClient([
      // two Twenty records for Bendik would normally make him ambiguous
      person("self-a", "Bendik", "Heiberg", { emails: { primaryEmail: "owner@owner.example", additionalEmails: null } }),
      person("self-b", "Bendik", "Heiberg", { emails: { primaryEmail: "bendik@other.com", additionalEmails: null } }),
      person("t-2", "Peter", "Hansen", { emails: { primaryEmail: "peter@example.se", additionalEmails: null } }),
    ]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW, selfContactId: self });

    // self never appears anywhere
    expect(report.ambiguous.find((a) => a.contactId === self)).toBeUndefined();
    expect(twentyIdentity(db, self)).toBeNull();
    expect(contactRow(db, self).twenty_id_cache).toBeNull();
    // the other contact still matches normally
    expect(report.matchedByEmail).toBe(1);
    expect(twentyIdentity(db, other)).toBe("t-2");
  });

  it("without selfContactId, the self-named contact is matched as usual", async () => {
    const db = openDb(":memory:");
    const self = seedContact(db, "Bendik Heiberg", { email: "owner@owner.example" });
    const { client } = fakeClient([
      person("self-a", "Bendik", "Heiberg", { emails: { primaryEmail: "owner@owner.example", additionalEmails: null } }),
    ]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(report.matchedByEmail).toBe(1);
    expect(twentyIdentity(db, self)).toBe("self-a");
  });
});

describe("syncTwenty — matching", () => {
  it("email match writes twenty_id identity + twenty_id_cache and counts matchedByEmail", async () => {
    const db = openDb(":memory:");
    const cid = seedContact(db, "Peter Hansen", { email: "peter@example.se" });
    const { client } = fakeClient([
      person("t-1", "Peter", "Hansen", { emails: { primaryEmail: "peter@example.se", additionalEmails: null } }),
    ]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(report.matchedByEmail).toBe(1);
    expect(report.matchedByName).toBe(0);
    expect(report.unmatched).toBe(0);
    expect(report.ambiguous).toEqual([]);
    expect(twentyIdentity(db, cid)).toBe("t-1");
    expect(contactRow(db, cid).twenty_id_cache).toBe("t-1");
  });

  it("email matching is case-insensitive on both sides, including additionalEmails", async () => {
    const db = openDb(":memory:");
    const c1 = seedContact(db, "Peter Hansen", { email: "peter@example.se" });
    const c2 = seedContact(db, "Mette Olsen", { email: "mette@firma.no" });
    const { client } = fakeClient([
      person("t-1", "Peter", "Hansen", { emails: { primaryEmail: "Peter@Example.SE", additionalEmails: null } }),
      person("t-2", "Mette", "Olsen", {
        emails: { primaryEmail: "other@firma.no", additionalEmails: ["METTE@Firma.NO"] },
      }),
    ]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(report.matchedByEmail).toBe(2);
    expect(twentyIdentity(db, c1)).toBe("t-1");
    expect(twentyIdentity(db, c2)).toBe("t-2");
  });

  it("single-candidate name match with interactions auto-matches, folding diacritics", async () => {
    const db = openDb(":memory:");
    const cid = seedContact(db, "Pål Sørensen");
    addInteraction(db, cid);
    const { client } = fakeClient([person("t-1", "Pal", "Sorensen")]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(report.matchedByName).toBe(1);
    expect(report.matchedByEmail).toBe(0);
    expect(report.ambiguous).toEqual([]);
    expect(twentyIdentity(db, cid)).toBe("t-1");
    expect(contactRow(db, cid).twenty_id_cache).toBe("t-1");
  });

  it("name match with two Twenty candidates goes to ambiguous, nothing written", async () => {
    const db = openDb(":memory:");
    const cid = seedContact(db, "Ola Nordmann");
    addInteraction(db, cid);
    const { client } = fakeClient([person("t-1", "Ola", "Nordmann"), person("t-2", "Ola", "Nordmann")]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(report.matchedByName).toBe(0);
    expect(report.ambiguous).toHaveLength(1);
    expect(report.ambiguous[0]!.contactId).toBe(cid);
    expect(report.ambiguous[0]!.displayName).toBe("Ola Nordmann");
    expect(report.ambiguous[0]!.candidates).toHaveLength(2);
    expect(report.ambiguous[0]!.candidates.join(" ")).toContain("t-1");
    expect(report.ambiguous[0]!.candidates.join(" ")).toContain("t-2");
    expect(twentyIdentity(db, cid)).toBeNull();
    expect(contactRow(db, cid).twenty_id_cache).toBeNull();
  });

  it("name-equal contact with zero interactions goes to ambiguous, not auto-matched", async () => {
    const db = openDb(":memory:");
    const cid = seedContact(db, "Kari Berg"); // no interactions
    const { client } = fakeClient([person("t-1", "Kari", "Berg")]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(report.matchedByName).toBe(0);
    expect(report.ambiguous).toHaveLength(1);
    expect(report.ambiguous[0]!.contactId).toBe(cid);
    expect(twentyIdentity(db, cid)).toBeNull();
  });

  it("two local contacts hitting the same Twenty person: first wins, second is ambiguous", async () => {
    const db = openDb(":memory:");
    const c1 = seedContact(db, "Anna Lund", { email: "anna@firma.no" });
    const c2 = seedContact(db, "Anna L", { email: "anna.lund@gmail.com" });
    const { client } = fakeClient([
      person("t-1", "Anna", "Lund", {
        emails: { primaryEmail: "anna@firma.no", additionalEmails: ["anna.lund@gmail.com"] },
      }),
    ]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(report.matchedByEmail).toBe(1);
    expect(twentyIdentity(db, c1)).toBe("t-1");
    expect(twentyIdentity(db, c2)).toBeNull();
    expect(report.ambiguous).toHaveLength(1);
    expect(report.ambiguous[0]!.contactId).toBe(c2);
    expect(report.ambiguous[0]!.candidates.join(" ")).toContain("t-1");
  });

  it("contacts matching nothing count as unmatched", async () => {
    const db = openDb(":memory:");
    seedContact(db, "Totally Unknown", { email: "nobody@nowhere.se" });
    const { client } = fakeClient([person("t-1", "Some", "Person")]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(report.unmatched).toBe(1);
    expect(report.matchedByEmail).toBe(0);
    expect(report.matchedByName).toBe(0);
    expect(report.ambiguous).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Enrich (push)
// ---------------------------------------------------------------------------

describe("syncTwenty — enrich", () => {
  it("sends only changed fields: pulse differs, lastPersonalContact equal (format-insensitive)", async () => {
    const db = openDb(":memory:");
    const cid = seedContact(db, "Peter Hansen", { email: "peter@example.se" });
    addPulse(db, cid, "GOOD", "2026-05-01T00:00:00Z");
    const { client, updates } = fakeClient([
      person("t-1", "Peter", "Hansen", {
        emails: { primaryEmail: "peter@example.se", additionalEmails: null },
        pulse: "WEAK",
        lastPersonalContact: "2026-05-01T00:00:00.000Z", // same instant, different format
      }),
    ]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe("t-1");
    expect(updates[0]!.fields).toEqual({ pulse: "GOOD" });
    expect(report.enriched).toBe(1);
  });

  it("does not call updatePerson and counts nothing when all fields are equal", async () => {
    const db = openDb(":memory:");
    const cid = seedContact(db, "Peter Hansen", { email: "peter@example.se" });
    addPulse(db, cid, "GOOD", "2026-05-01T00:00:00.000Z");
    const { client, updates } = fakeClient([
      person("t-1", "Peter", "Hansen", {
        emails: { primaryEmail: "peter@example.se", additionalEmails: null },
        pulse: "GOOD",
        lastPersonalContact: "2026-05-01T00:00:00.000Z",
      }),
    ]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(updates).toHaveLength(0);
    expect(report.enriched).toBe(0);
  });

  it("sends lastPersonalContact when local is non-null and Twenty's differs", async () => {
    const db = openDb(":memory:");
    const cid = seedContact(db, "Peter Hansen", { email: "peter@example.se" });
    addPulse(db, cid, "GOOD", "2026-05-20T00:00:00.000Z");
    const { client, updates } = fakeClient([
      person("t-1", "Peter", "Hansen", {
        emails: { primaryEmail: "peter@example.se", additionalEmails: null },
        pulse: "GOOD",
        lastPersonalContact: null,
      }),
    ]);

    await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(updates).toHaveLength(1);
    expect(updates[0]!.fields).toEqual({ lastPersonalContact: "2026-05-20T00:00:00.000Z" });
  });

  it("skips the pulse field entirely when the contact has no pulse row", async () => {
    const db = openDb(":memory:");
    seedContact(db, "Peter Hansen", { email: "peter@example.se" });
    const { client, updates } = fakeClient([
      person("t-1", "Peter", "Hansen", {
        emails: { primaryEmail: "peter@example.se", additionalEmails: null },
        pulse: "WEAK",
      }),
    ]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(updates).toHaveLength(0);
    expect(report.enriched).toBe(0);
  });

  it("sends linkedinLink only when Twenty's is empty and local has one", async () => {
    const db = openDb(":memory:");
    seedContact(db, "Peter Hansen", {
      email: "peter@example.se",
      linkedin: "https://www.linkedin.com/in/peterhansen",
    });
    seedContact(db, "Mette Olsen", {
      email: "mette@firma.no",
      linkedin: "https://www.linkedin.com/in/metteolsen",
    });
    const { client, updates } = fakeClient([
      person("t-1", "Peter", "Hansen", {
        emails: { primaryEmail: "peter@example.se", additionalEmails: null },
        linkedinLink: null, // empty → send
      }),
      person("t-2", "Mette", "Olsen", {
        emails: { primaryEmail: "mette@firma.no", additionalEmails: null },
        linkedinLink: { primaryLinkUrl: "https://www.linkedin.com/in/existing" }, // present → don't touch
      }),
    ]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe("t-1");
    expect(updates[0]!.fields).toEqual({
      linkedinLink: { primaryLinkUrl: "https://www.linkedin.com/in/peterhansen" },
    });
    expect(report.enriched).toBe(1);
  });

  it("collects per-person enrich failures and counts only successes", async () => {
    const db = openDb(":memory:");
    const c1 = seedContact(db, "Peter Hansen", { email: "peter@example.se" });
    const c2 = seedContact(db, "Mette Olsen", { email: "mette@firma.no" });
    addPulse(db, c1, "GOOD");
    addPulse(db, c2, "GOOD");
    const { client } = fakeClient([
      person("t-1", "Peter", "Hansen", {
        emails: { primaryEmail: "peter@example.se", additionalEmails: null },
        pulse: "WEAK",
      }),
      person("t-2", "Mette", "Olsen", {
        emails: { primaryEmail: "mette@firma.no", additionalEmails: null },
        pulse: "WEAK",
      }),
    ]);
    client.updatePerson = async (id) => {
      if (id === "t-2") throw new Error("boom 500");
    };

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(report.enriched).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.contactId).toBe(c2);
    expect(report.failures[0]!.error).toContain("boom 500");
  });
});

// ---------------------------------------------------------------------------
// Pull (cache)
// ---------------------------------------------------------------------------

describe("syncTwenty — pull", () => {
  it("writes twenty_strength/twenty_last_contacted + twenty_synced_at; pulled counts only on change", async () => {
    const db = openDb(":memory:");
    const cid = seedContact(db, "Peter Hansen", { email: "peter@example.se" });
    const people = [
      person("t-1", "Peter", "Hansen", {
        emails: { primaryEmail: "peter@example.se", additionalEmails: null },
        strength: "STRONG",
        lastContactedAt: "2026-04-01T00:00:00.000Z",
      }),
    ];
    const { client } = fakeClient(people);

    const first = await syncTwenty(db, client, { dryRun: false, now: NOW });
    expect(first.pulled).toBe(1);
    const row = contactRow(db, cid);
    expect(row.twenty_strength).toBe("STRONG");
    expect(row.twenty_last_contacted).toBe("2026-04-01T00:00:00.000Z");
    expect(row.twenty_synced_at).toBe(NOW.toISOString());

    // Second run: values unchanged → not counted again.
    const second = await syncTwenty(db, client, { dryRun: false, now: new Date("2026-06-11T12:00:00.000Z") });
    expect(second.pulled).toBe(0);
    expect(contactRow(db, cid).twenty_synced_at).toBe(NOW.toISOString()); // untouched
  });
});

// ---------------------------------------------------------------------------
// dryRun contract
// ---------------------------------------------------------------------------

describe("syncTwenty — dryRun", () => {
  it("makes zero db writes and zero updatePerson calls, but reports counts", async () => {
    const db = openDb(":memory:");
    const cid = seedContact(db, "Peter Hansen", { email: "peter@example.se" });
    addPulse(db, cid, "GOOD");
    const { client, updates } = fakeClient([
      person("t-1", "Peter", "Hansen", {
        emails: { primaryEmail: "peter@example.se", additionalEmails: null },
        pulse: "WEAK",
        strength: "STRONG",
        lastContactedAt: "2026-04-01T00:00:00.000Z",
      }),
    ]);

    const report = await syncTwenty(db, client, { dryRun: true, now: NOW });

    // Counts reflect what WOULD happen.
    expect(report.matchedByEmail).toBe(1);
    expect(report.enriched).toBe(1);
    expect(report.pulled).toBe(1);

    // Zero db writes.
    expect(twentyIdentity(db, cid)).toBeNull();
    const row = contactRow(db, cid);
    expect(row.twenty_id_cache).toBeNull();
    expect(row.twenty_strength).toBeNull();
    expect(row.twenty_last_contacted).toBeNull();
    expect(row.twenty_synced_at).toBeNull();

    // Zero client writes.
    expect(updates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pre-matched contacts (existing twenty_id identity)
// ---------------------------------------------------------------------------

describe("syncTwenty — already matched", () => {
  it("skips matching (no matchedBy counts) but still enriches and pulls", async () => {
    const db = openDb(":memory:");
    const cid = seedContact(db, "Peter Hansen", { email: "peter@example.se" });
    db.prepare("INSERT INTO identities (contact_id, kind, value, source) VALUES (?, 'twenty_id', 't-1', 'twenty')").run(cid);
    addPulse(db, cid, "GOOD");
    const { client, updates } = fakeClient([
      person("t-1", "Peter", "Hansen", {
        emails: { primaryEmail: "peter@example.se", additionalEmails: null },
        pulse: "WEAK",
        strength: "STRONG",
        lastContactedAt: "2026-04-01T00:00:00.000Z",
      }),
    ]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(report.matchedByEmail).toBe(0);
    expect(report.matchedByName).toBe(0);
    expect(report.unmatched).toBe(0);
    expect(report.ambiguous).toEqual([]);
    expect(report.enriched).toBe(1);
    expect(updates).toHaveLength(1);
    expect(report.pulled).toBe(1);
    expect(contactRow(db, cid).twenty_strength).toBe("STRONG");
  });

  it("multi-email conflict: two emails resolve to two DIFFERENT Twenty people → ambiguous, nothing written", async () => {
    const db = openDb(":memory:");
    // Contact C has two emails. Each maps to a DIFFERENT Twenty person.
    const cid = seedContact(db, "Dual Email Person", { email: "dual-a@example.com" });
    db.prepare("INSERT INTO identities (contact_id, kind, value, source) VALUES (?, 'email', 'dual-b@example.com', 'test')").run(cid);

    // Another contact that has two emails both on the SAME Twenty person → should still match normally.
    const cid2 = seedContact(db, "Same Person Both Emails", { email: "shared-a@example.com" });
    db.prepare("INSERT INTO identities (contact_id, kind, value, source) VALUES (?, 'email', 'shared-b@example.com', 'test')").run(cid2);

    const { client } = fakeClient([
      person("p1", "Alpha", "One", { emails: { primaryEmail: "dual-a@example.com", additionalEmails: null } }),
      person("p2", "Alpha", "Two", { emails: { primaryEmail: "dual-b@example.com", additionalEmails: null } }),
      person("p3", "Beta", "Three", {
        emails: { primaryEmail: "shared-a@example.com", additionalEmails: ["shared-b@example.com"] },
      }),
    ]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    // cid has a conflict → ambiguous; no twenty_id written
    expect(report.ambiguous).toHaveLength(1);
    expect(report.ambiguous[0]!.contactId).toBe(cid);
    const candidateStr = report.ambiguous[0]!.candidates.join(" ");
    expect(candidateStr).toContain("p1");
    expect(candidateStr).toContain("p2");
    expect(twentyIdentity(db, cid)).toBeNull();

    // cid2 has both emails on the same person → normal match
    expect(report.matchedByEmail).toBe(1);
    expect(twentyIdentity(db, cid2)).toBe("p3");
  });

  it("a Twenty person taken by a pre-matched contact is ambiguous for a later email match", async () => {
    const db = openDb(":memory:");
    const c1 = seedContact(db, "Peter Hansen", { email: "peter@example.se" });
    db.prepare("INSERT INTO identities (contact_id, kind, value, source) VALUES (?, 'twenty_id', 't-1', 'twenty')").run(c1);
    const c2 = seedContact(db, "Peter H", { email: "peter.h@gmail.com" });
    const { client } = fakeClient([
      person("t-1", "Peter", "Hansen", {
        emails: { primaryEmail: "peter@example.se", additionalEmails: ["peter.h@gmail.com"] },
      }),
    ]);

    const report = await syncTwenty(db, client, { dryRun: false, now: NOW });

    expect(report.ambiguous).toHaveLength(1);
    expect(report.ambiguous[0]!.contactId).toBe(c2);
    expect(twentyIdentity(db, c2)).toBeNull();
  });
});
