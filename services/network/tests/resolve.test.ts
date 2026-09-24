import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../lib/db.js";
import { upsertContact, findContactByIdentity, mergeContacts, detachIdentity, linkToTwenty } from "../lib/resolve.js";

let db: Db;
beforeEach(() => { db = openDb(":memory:"); });

describe("upsertContact", () => {
  it("creates a contact with identities", () => {
    const id = upsertContact(db, {
      displayName: "Serhii Yelbaiev",
      company: "the0nlylink",
      title: "CMO",
      source: "linkedin",
      identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/yelbaiev" }],
    });
    expect(findContactByIdentity(db, "linkedin_url", "https://www.linkedin.com/in/yelbaiev")).toBe(id);
  });

  it("matches on any shared identity and attaches new ones", () => {
    const a = upsertContact(db, {
      displayName: "Peter Karlsson", source: "contacts",
      identities: [{ kind: "phone", value: "+4798212345" }, { kind: "email", value: "peter@example.se" }],
    });
    const b = upsertContact(db, {
      displayName: "Peter Karlsson", source: "linkedin",
      identities: [{ kind: "email", value: "peter@example.se" }, { kind: "linkedin_url", value: "https://www.linkedin.com/in/peter-karlsson-a2320b51" }],
    });
    expect(b).toBe(a);
    expect(findContactByIdentity(db, "linkedin_url", "https://www.linkedin.com/in/peter-karlsson-a2320b51")).toBe(a);
  });

  it("fuzzy-matches normalized name when company corroborates", () => {
    const a = upsertContact(db, {
      displayName: "Pål Sørensen", company: "Curamando", source: "contacts",
      identities: [{ kind: "phone", value: "+4791234567" }],
    });
    const b = upsertContact(db, {
      displayName: "Pal Sorensen", company: "Curamando", source: "linkedin",
      identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/palsorensen" }],
    });
    expect(b).toBe(a);
  });

  it("does NOT merge same name without corroboration", () => {
    const a = upsertContact(db, { displayName: "Ola Nordmann", company: "Telenor", source: "contacts", identities: [{ kind: "phone", value: "+4790000001" }] });
    const b = upsertContact(db, { displayName: "Ola Nordmann", company: "DNB", source: "linkedin", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/olanordmann" }] });
    expect(b).not.toBe(a);
  });
});

describe("mergeContacts", () => {
  it("moves identities and interactions, deletes the source, records the override", () => {
    const a = upsertContact(db, { displayName: "A", source: "contacts", identities: [{ kind: "phone", value: "+4790000002" }] });
    const b = upsertContact(db, { displayName: "B", source: "linkedin", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/b" }] });
    db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, external_id) VALUES (?, 'imessage', 'inbound', '2026-01-01T00:00:00Z', 'x1')").run(a);
    mergeContacts(db, a, b);
    expect(db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE id = ?").get(a)).toEqual({ n: 0 });
    expect(db.prepare("SELECT contact_id FROM interactions WHERE external_id = 'x1'").get()).toEqual({ contact_id: b });
    expect(findContactByIdentity(db, "phone", "+4790000002")).toBe(b);
    expect(db.prepare("SELECT COUNT(*) AS n FROM identity_overrides WHERE kind = 'merge'").get()).toEqual({ n: 1 });
  });

  it("throws when merging a contact into itself and leaves data untouched", () => {
    const a = upsertContact(db, { displayName: "Self", source: "contacts", identities: [{ kind: "phone", value: "+4790000010" }] });
    db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, external_id) VALUES (?, 'imessage', 'inbound', '2026-01-01T00:00:00Z', 'selfx1')").run(a);
    expect(() => mergeContacts(db, a, a)).toThrow(/cannot merge.*itself/i);
    // contact still exists
    expect(db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE id = ?").get(a)).toEqual({ n: 1 });
    // identities untouched
    expect(findContactByIdentity(db, "phone", "+4790000010")).toBe(a);
    // interactions untouched
    expect(db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE contact_id = ?").get(a)).toEqual({ n: 1 });
  });

  it("throws when the target contact does not exist and leaves the source untouched", () => {
    const a = upsertContact(db, { displayName: "Source", source: "contacts", identities: [{ kind: "phone", value: "+4790000011" }] });
    expect(() => mergeContacts(db, a, 99999)).toThrow(/99999/);
    // contact still exists
    expect(db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE id = ?").get(a)).toEqual({ n: 1 });
    // identities untouched
    expect(findContactByIdentity(db, "phone", "+4790000011")).toBe(a);
  });
});

describe("linkToTwenty", () => {
  it("attaches a twenty_id identity and sets the cache column", () => {
    const a = upsertContact(db, { displayName: "Linda Larsen", source: "linkedin", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/lindalarsen" }] });
    linkToTwenty(db, a, "tw-123");
    expect(findContactByIdentity(db, "twenty_id" as never, "tw-123")).toBe(a);
    expect(db.prepare("SELECT twenty_id_cache FROM contacts WHERE id = ?").get(a)).toEqual({ twenty_id_cache: "tw-123" });
    expect(db.prepare("SELECT source FROM identities WHERE kind = 'twenty_id' AND value = 'tw-123'").get()).toEqual({ source: "link" });
  });

  it("is idempotent when linking the same contact to the same twenty id", () => {
    const a = upsertContact(db, { displayName: "Idem Potent", source: "linkedin", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/idem" }] });
    linkToTwenty(db, a, "tw-dup");
    linkToTwenty(db, a, "tw-dup");
    expect(db.prepare("SELECT COUNT(*) AS n FROM identities WHERE kind = 'twenty_id' AND value = 'tw-dup'").get()).toEqual({ n: 1 });
  });

  it("throws when the contact does not exist", () => {
    expect(() => linkToTwenty(db, 99999, "tw-x")).toThrow(/99999/);
  });

  it("throws when the contact is already linked to a different twenty id", () => {
    const a = upsertContact(db, { displayName: "Already Linked", source: "linkedin", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/already" }] });
    linkToTwenty(db, a, "tw-first");
    expect(() => linkToTwenty(db, a, "tw-second")).toThrow(/already linked/i);
    // unchanged
    expect(findContactByIdentity(db, "twenty_id" as never, "tw-first")).toBe(a);
    expect(db.prepare("SELECT COUNT(*) AS n FROM identities WHERE kind = 'twenty_id' AND contact_id = ?").get(a)).toEqual({ n: 1 });
  });

  it("throws when the twenty id is already claimed by another contact", () => {
    const a = upsertContact(db, { displayName: "Owner", source: "linkedin", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/owner" }] });
    const b = upsertContact(db, { displayName: "Claimer", source: "linkedin", identities: [{ kind: "linkedin_url", value: "https://www.linkedin.com/in/claimer" }] });
    linkToTwenty(db, a, "tw-shared");
    expect(() => linkToTwenty(db, b, "tw-shared")).toThrow(/already (claimed|linked)/i);
    // b untouched
    expect(db.prepare("SELECT twenty_id_cache FROM contacts WHERE id = ?").get(b)).toEqual({ twenty_id_cache: null });
  });
});

describe("detachIdentity", () => {
  it("moves the identity to a fresh unresolved contact and records a detach override", () => {
    const a = upsertContact(db, {
      displayName: "Jane Doe",
      source: "contacts",
      identities: [
        { kind: "phone", value: "+4790000010" },
        { kind: "email", value: "jane@example.com" },
      ],
    });

    // Find the identity id for the phone number
    const row = db.prepare("SELECT id FROM identities WHERE kind = 'phone' AND value = '+4790000010'").get() as { id: number };
    const newContactId = detachIdentity(db, row.id);

    // The detached identity now belongs to a new contact
    expect(newContactId).not.toBe(a);
    expect(findContactByIdentity(db, "phone", "+4790000010")).toBe(newContactId);

    // The new contact is unresolved
    const newContact = db.prepare("SELECT resolved FROM contacts WHERE id = ?").get(newContactId) as { resolved: number };
    expect(newContact.resolved).toBe(0);

    // Original contact no longer has that identity
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM identities WHERE contact_id = ?").get(a) as { n: number };
    expect(remaining.n).toBe(1); // only email remains

    // A detach override was recorded
    expect(db.prepare("SELECT COUNT(*) AS n FROM identity_overrides WHERE kind = 'detach'").get()).toEqual({ n: 1 });
  });
});
