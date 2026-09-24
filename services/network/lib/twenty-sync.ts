/**
 * Twenty matcher + bidirectional field sync.
 *
 * Push: pulse band, last personal contact, linkedin URL (only when Twenty's is empty).
 * Pull: Twenty strength + lastContactedAt into the contacts cache columns.
 *
 * Matching is deliberately conservative — never auto-merge on weak evidence;
 * anything uncertain is surfaced in `ambiguous` for a manual `pnpm network merge`.
 *
 * Structure (better-sqlite3 transactions are sync, updatePerson is async):
 *   (a) load Twenty people once + compute matches purely,
 *   (b) all db writes in one sync transaction,
 *   (c) sequential awaited updatePerson calls after the transaction
 *       (per-person failures collected into report.failures, successes counted).
 */

import type { Db } from "./db.js";
import type { TwentyClient, TwentyPerson } from "./twenty.js";
import { normalizeEmail, normalizeName } from "./normalize.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyncReport = {
  matchedByEmail: number;
  matchedByName: number; // single name-equal candidate + relationship evidence
  ambiguous: { contactId: number; displayName: string; candidates: string[] }[];
  enriched: number; // people whose pulse/lastPersonalContact/linkedinLink changed
  pulled: number; // contacts with refreshed twenty_strength/twenty_last_contacted
  unmatched: number;
  failures: { contactId: number; error: string }[];
};

type ContactRow = {
  id: number;
  display_name: string;
  twenty_strength: string | null;
  twenty_last_contacted: string | null;
  twenty_synced_at: string | null;
};

type IdentityRow = { contact_id: number; kind: string; value: string };

type PulseRow = { contact_id: number; band: string; last_interaction_at: string | null };

type EnrichFields = Partial<Record<"pulse" | "lastPersonalContact", string | null>> & {
  linkedinLink?: { primaryLinkUrl: string };
};

type Match = {
  contact: ContactRow;
  person: TwentyPerson;
  /** true when the twenty_id identity + cache column still need writing */
  isNew: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function candidateLabel(p: TwentyPerson): string {
  const name = `${p.name.firstName} ${p.name.lastName}`.trim();
  return `${name} (${p.id})`;
}

/** Timestamp equality tolerant of format differences ("...00Z" vs "...00.000Z"). */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return ta === tb;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export async function syncTwenty(
  db: Db,
  client: TwentyClient,
  opts: { dryRun: boolean; now?: Date; selfContactId?: number | null },
): Promise<SyncReport> {
  const now = opts.now ?? new Date();
  const selfContactId = opts.selfContactId ?? null;

  const report: SyncReport = {
    matchedByEmail: 0,
    matchedByName: 0,
    ambiguous: [],
    enriched: 0,
    pulled: 0,
    unmatched: 0,
    failures: [],
  };

  // -------------------------------------------------------------------------
  // (a) Load Twenty people ONCE, build lookup maps, compute matches (pure)
  // -------------------------------------------------------------------------

  const people = await client.listPeople();

  const byId = new Map<string, TwentyPerson>();
  const byEmail = new Map<string, TwentyPerson>();
  const byName = new Map<string, TwentyPerson[]>();
  for (const p of people) {
    byId.set(p.id, p);
    for (const raw of [p.emails.primaryEmail, ...(p.emails.additionalEmails ?? [])]) {
      if (!raw) continue;
      const e = normalizeEmail(raw);
      if (e && !byEmail.has(e)) byEmail.set(e, p);
    }
    const n = normalizeName(`${p.name.firstName} ${p.name.lastName}`);
    if (n) {
      const bucket = byName.get(n);
      if (bucket) bucket.push(p);
      else byName.set(n, [p]);
    }
  }

  const allContacts = db
    .prepare(
      "SELECT id, display_name, twenty_strength, twenty_last_contacted, twenty_synced_at FROM contacts ORDER BY id",
    )
    .all() as ContactRow[];
  // Bendik's own contact never syncs to a Twenty person (he isn't a CRM record).
  const contacts = allContacts.filter((c) => c.id !== selfContactId);

  const identRows = db
    .prepare("SELECT contact_id, kind, value FROM identities ORDER BY id")
    .all() as IdentityRow[];
  const identsByContact = new Map<number, IdentityRow[]>();
  for (const r of identRows) {
    const bucket = identsByContact.get(r.contact_id);
    if (bucket) bucket.push(r);
    else identsByContact.set(r.contact_id, [r]);
  }

  const pulseRows = db
    .prepare("SELECT contact_id, band, last_interaction_at FROM pulse")
    .all() as PulseRow[];
  const pulseByContact = new Map<number, PulseRow>(pulseRows.map((p) => [p.contact_id, p]));

  const interactionCounts = db
    .prepare("SELECT contact_id, COUNT(*) AS n FROM interactions GROUP BY contact_id")
    .all() as { contact_id: number; n: number }[];
  const interactionsByContact = new Map<number, number>(
    interactionCounts.map((r) => [r.contact_id, r.n]),
  );

  const taken = new Set<string>(); // Twenty ids already claimed by a contact
  const matches: Match[] = [];

  // Rung 1: existing twenty_id identities claim their Twenty person first.
  const stillUnmatched: ContactRow[] = [];
  for (const c of contacts) {
    const twentyIdent = (identsByContact.get(c.id) ?? []).find((i) => i.kind === "twenty_id");
    if (twentyIdent) {
      taken.add(twentyIdent.value);
      const p = byId.get(twentyIdent.value);
      // Person missing from Twenty (deleted there) → nothing to enrich/pull; skip silently.
      if (p) matches.push({ contact: c, person: p, isNew: false });
      continue;
    }
    stillUnmatched.push(c);
  }

  // Rung 2 (all contacts before rung 3 — email evidence always beats name evidence,
  // regardless of contact id order): email equality, normalized both sides.
  // Collect ALL distinct Twenty-person hits across every email identity; only
  // match when exactly one distinct person is found (≥2 = conflict → ambiguous).
  const nameRung: ContactRow[] = [];
  for (const c of stillUnmatched) {
    const hitMap = new Map<string, TwentyPerson>(); // twenty_id → person
    for (const i of identsByContact.get(c.id) ?? []) {
      if (i.kind !== "email") continue;
      const e = normalizeEmail(i.value);
      if (!e) continue;
      const p = byEmail.get(e);
      if (p && !hitMap.has(p.id)) hitMap.set(p.id, p);
    }
    if (hitMap.size === 0) {
      nameRung.push(c);
      continue;
    }
    if (hitMap.size >= 2) {
      // Multiple distinct Twenty people matched — surface ALL as ambiguous.
      report.ambiguous.push({
        contactId: c.id,
        displayName: c.display_name,
        candidates: [...hitMap.values()].map(candidateLabel),
      });
      continue;
    }
    // Exactly one distinct hit.
    const hit = [...hitMap.values()][0]!;
    if (taken.has(hit.id)) {
      // Two local halves of one Twenty person — surface for manual merge.
      report.ambiguous.push({
        contactId: c.id,
        displayName: c.display_name,
        candidates: [candidateLabel(hit)],
      });
      continue;
    }
    taken.add(hit.id);
    matches.push({ contact: c, person: hit, isNew: true });
    report.matchedByEmail += 1;
  }

  // Rung 3: exact normalized name. Auto-match ONLY a single candidate when the
  // contact has ≥1 interaction (a real relationship, not a bare LinkedIn import).
  for (const c of nameRung) {
    const candidates = byName.get(normalizeName(c.display_name)) ?? [];
    if (candidates.length === 0) {
      report.unmatched += 1;
      continue;
    }
    const single = candidates.length === 1 ? candidates[0]! : null;
    const hasInteractions = (interactionsByContact.get(c.id) ?? 0) >= 1;
    if (single && !taken.has(single.id) && hasInteractions) {
      taken.add(single.id);
      matches.push({ contact: c, person: single, isNew: true });
      report.matchedByName += 1;
      continue;
    }
    report.ambiguous.push({
      contactId: c.id,
      displayName: c.display_name,
      candidates: candidates.map(candidateLabel),
    });
  }

  // -------------------------------------------------------------------------
  // (a, cont.) Compute enrich + pull plans (pure — counts work in dryRun too)
  // -------------------------------------------------------------------------

  const enrichPlans: { contactId: number; twentyId: string; fields: EnrichFields }[] = [];
  const pullPlans: { contactId: number; strength: string | null; lastContacted: string | null }[] = [];

  for (const m of matches) {
    const fields: EnrichFields = {};
    const pulse = pulseByContact.get(m.contact.id);
    if (pulse) {
      if (m.person.pulse !== pulse.band) fields.pulse = pulse.band;
      if (
        pulse.last_interaction_at !== null &&
        !sameInstant(pulse.last_interaction_at, m.person.lastPersonalContact)
      ) {
        fields.lastPersonalContact = pulse.last_interaction_at;
      }
    }
    if (!m.person.linkedinLink?.primaryLinkUrl) {
      const li = (identsByContact.get(m.contact.id) ?? []).find((i) => i.kind === "linkedin_url");
      if (li) fields.linkedinLink = { primaryLinkUrl: li.value };
    }
    if (Object.keys(fields).length > 0) {
      enrichPlans.push({ contactId: m.contact.id, twentyId: m.person.id, fields });
    }

    const pullChanged =
      m.contact.twenty_strength !== m.person.strength ||
      m.contact.twenty_last_contacted !== m.person.lastContactedAt ||
      m.contact.twenty_synced_at === null;
    if (pullChanged) {
      pullPlans.push({
        contactId: m.contact.id,
        strength: m.person.strength,
        lastContacted: m.person.lastContactedAt,
      });
    }
  }

  report.pulled = pullPlans.length;

  if (opts.dryRun) {
    report.enriched = enrichPlans.length;
    return report;
  }

  // -------------------------------------------------------------------------
  // (b) All db writes in one sync transaction
  // -------------------------------------------------------------------------

  const insertIdentity = db.prepare(
    "INSERT OR IGNORE INTO identities (contact_id, kind, value, source) VALUES (?, 'twenty_id', ?, 'twenty')",
  );
  const setCache = db.prepare("UPDATE contacts SET twenty_id_cache = ? WHERE id = ?");
  const writePull = db.prepare(
    "UPDATE contacts SET twenty_strength = ?, twenty_last_contacted = ?, twenty_synced_at = ? WHERE id = ?",
  );

  const tx = db.transaction(() => {
    for (const m of matches) {
      if (!m.isNew) continue;
      insertIdentity.run(m.contact.id, m.person.id);
      setCache.run(m.person.id, m.contact.id);
    }
    for (const p of pullPlans) {
      writePull.run(p.strength, p.lastContacted, now.toISOString(), p.contactId);
    }
  });
  tx();

  // -------------------------------------------------------------------------
  // (c) Sequential awaited updatePerson calls AFTER the transaction
  // -------------------------------------------------------------------------

  for (const plan of enrichPlans) {
    try {
      await client.updatePerson(plan.twentyId, plan.fields);
      report.enriched += 1;
    } catch (err) {
      report.failures.push({
        contactId: plan.contactId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}
