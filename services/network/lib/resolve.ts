import type { Db } from "./db.js";
import { normalizeName } from "./normalize.js";

export type IdentityKind = "email" | "phone" | "linkedin_url" | "instagram" | "meta_name" | "slack_user";
export type IdentityInput = { kind: IdentityKind; value: string };

export type ContactInput = {
  displayName: string;
  company?: string | null;
  title?: string | null;
  source: string;
  /** values must already be normalized by the importer */
  identities: IdentityInput[];
  /** false for bare handles (unknown phone number) */
  resolved?: boolean;
};

export function findContactByIdentity(db: Db, kind: IdentityKind, value: string): number | null {
  const row = db.prepare("SELECT contact_id FROM identities WHERE kind = ? AND value = ?").get(kind, value) as
    | { contact_id: number }
    | undefined;
  return row ? row.contact_id : null;
}

function attachIdentities(db: Db, contactId: number, identities: IdentityInput[], source: string): void {
  const ins = db.prepare("INSERT OR IGNORE INTO identities (contact_id, kind, value, source) VALUES (?, ?, ?, ?)");
  for (const i of identities) ins.run(contactId, i.kind, i.value, source);
}

/**
 * Resolution ladder: exact identity → fuzzy (normalized name + same company)
 * → create. Returns the contact id. Never guesses on name alone.
 */
export function upsertContact(db: Db, input: ContactInput): number {
  // 1. exact identity match
  for (const i of input.identities) {
    const hit = findContactByIdentity(db, i.kind, i.value);
    if (hit !== null) {
      attachIdentities(db, hit, input.identities, input.source);
      // enrich blank fields, never overwrite
      db.prepare(
        "UPDATE contacts SET company = COALESCE(company, ?), title = COALESCE(title, ?), resolved = MAX(resolved, ?) WHERE id = ?",
      ).run(input.company ?? null, input.title ?? null, input.resolved === false ? 0 : 1, hit);
      return hit;
    }
  }
  // 2. fuzzy: same normalized name AND same company (both must exist)
  if (input.company) {
    const candidates = db.prepare("SELECT id, display_name FROM contacts WHERE company = ?").all(input.company) as {
      id: number;
      display_name: string;
    }[];
    const wanted = normalizeName(input.displayName);
    const match = candidates.find((c) => normalizeName(c.display_name) === wanted);
    if (match) {
      attachIdentities(db, match.id, input.identities, input.source);
      return match.id;
    }
  }
  // 3. create
  const res = db
    .prepare("INSERT INTO contacts (display_name, company, title, source, resolved) VALUES (?, ?, ?, ?, ?)")
    .run(input.displayName, input.company ?? null, input.title ?? null, input.source, input.resolved === false ? 0 : 1);
  const id = Number(res.lastInsertRowid);
  attachIdentities(db, id, input.identities, input.source);
  return id;
}

/** Manual correction: move everything from one contact onto another. */
export function mergeContacts(db: Db, fromId: number, intoId: number): void {
  if (fromId === intoId) throw new Error(`Cannot merge a contact into itself (id ${fromId})`);
  const fromExists = db.prepare("SELECT 1 FROM contacts WHERE id = ?").get(fromId);
  if (!fromExists) throw new Error(`Cannot merge: source contact ${fromId} does not exist`);
  const intoExists = db.prepare("SELECT 1 FROM contacts WHERE id = ?").get(intoId);
  if (!intoExists) throw new Error(`Cannot merge: target contact ${intoId} does not exist`);
  const tx = db.transaction(() => {
    db.prepare("UPDATE identities SET contact_id = ? WHERE contact_id = ?").run(intoId, fromId);
    db.prepare("UPDATE OR IGNORE interactions SET contact_id = ? WHERE contact_id = ?").run(intoId, fromId);
    db.prepare("DELETE FROM interactions WHERE contact_id = ?").run(fromId); // duplicates skipped by OR IGNORE
    db.prepare("UPDATE OR IGNORE positions SET contact_id = ? WHERE contact_id = ?").run(intoId, fromId);
    db.prepare("DELETE FROM positions WHERE contact_id = ?").run(fromId);
    db.prepare("DELETE FROM pulse WHERE contact_id = ?").run(fromId);
    db.prepare("DELETE FROM contacts WHERE id = ?").run(fromId);
    db.prepare("INSERT INTO identity_overrides (kind, from_contact, into_contact, created_at) VALUES ('merge', ?, ?, ?)").run(
      fromId,
      intoId,
      new Date().toISOString(),
    );
  });
  tx();
}

/**
 * Manual correction: link a local contact to a specific Twenty person id.
 * Used to clear name-only ambiguous matches the auto-matcher won't commit.
 * Idempotent for the same (contact, twentyId); refuses to relink or to claim a
 * Twenty id already held by another contact.
 */
export function linkToTwenty(db: Db, contactId: number, twentyId: string): void {
  const exists = db.prepare("SELECT 1 FROM contacts WHERE id = ?").get(contactId);
  if (!exists) throw new Error(`Cannot link: contact ${contactId} does not exist`);

  const existing = db
    .prepare("SELECT value FROM identities WHERE contact_id = ? AND kind = 'twenty_id'")
    .get(contactId) as { value: string } | undefined;
  if (existing) {
    if (existing.value === twentyId) return; // idempotent no-op
    throw new Error(
      `Contact ${contactId} is already linked to Twenty id ${existing.value}; detach it before relinking`,
    );
  }

  const claimedBy = db
    .prepare("SELECT contact_id FROM identities WHERE kind = 'twenty_id' AND value = ?")
    .get(twentyId) as { contact_id: number } | undefined;
  if (claimedBy) {
    throw new Error(
      `Twenty id ${twentyId} is already claimed by contact ${claimedBy.contact_id}`,
    );
  }

  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO identities (contact_id, kind, value, source) VALUES (?, 'twenty_id', ?, 'link')",
    ).run(contactId, twentyId);
    db.prepare("UPDATE contacts SET twenty_id_cache = ? WHERE id = ?").run(twentyId, contactId);
  });
  tx();
}

/** Manual correction: detach a mis-attributed identity into a fresh unresolved contact. */
export function detachIdentity(db: Db, identityId: number): number {
  const row = db.prepare("SELECT contact_id, kind, value, source FROM identities WHERE id = ?").get(identityId) as
    | { contact_id: number; kind: IdentityKind; value: string; source: string }
    | undefined;
  if (!row) throw new Error(`No identity with id ${identityId}`);
  const tx = db.transaction(() => {
    const res = db
      .prepare("INSERT INTO contacts (display_name, source, resolved) VALUES (?, ?, 0)")
      .run(row.value, row.source);
    const newId = Number(res.lastInsertRowid);
    db.prepare("UPDATE identities SET contact_id = ? WHERE id = ?").run(newId, identityId);
    db.prepare("INSERT INTO identity_overrides (kind, from_contact, into_contact, detail, created_at) VALUES ('detach', ?, ?, ?, ?)").run(
      row.contact_id,
      newId,
      `${row.kind}:${row.value}`,
      new Date().toISOString(),
    );
    return newId;
  });
  return tx();
}
