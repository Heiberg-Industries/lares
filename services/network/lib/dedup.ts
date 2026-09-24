/**
 * Local same-name dedup planner.
 *
 * The conservative importer never joins contacts on name alone, so one person
 * often exists as several fragments (an iMessage/Contacts row with their phone,
 * a LinkedIn row, a Meta row) that share no common identifier. This planner
 * finds those fragments and proposes merges — but ONLY when the evidence is
 * safe: exactly two fragments whose strong identifiers (phone, linkedin_url,
 * twenty_id) don't conflict. Everything riskier (3+ fragments, two different
 * phone numbers, two different LinkedIn profiles, two different Twenty links)
 * is HELD for manual review rather than guessed.
 */

import type { Db } from "./db.js";
import { normalizeName } from "./normalize.js";
import { mergeContacts } from "./resolve.js";

export type DedupMerge = { survivorId: number; fromId: number; name: string };
export type DedupHold = { name: string; ids: number[]; reason: string };
export type DedupPlan = { merges: DedupMerge[]; held: DedupHold[] };

type Frag = {
  id: number;
  displayName: string;
  phones: Set<string>;
  linkedins: Set<string>;
  twentyIds: Set<string>;
  hasPhone: boolean;
};

function disjoint(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const v of a) if (b.has(v)) return false;
  return true;
}

export function planDedup(db: Db): DedupPlan {
  const contacts = db.prepare("SELECT id, display_name FROM contacts").all() as {
    id: number;
    display_name: string;
  }[];
  const identRows = db.prepare("SELECT contact_id, kind, value FROM identities").all() as {
    contact_id: number;
    kind: string;
    value: string;
  }[];

  const fragById = new Map<number, Frag>();
  for (const c of contacts) {
    fragById.set(c.id, {
      id: c.id,
      displayName: c.display_name,
      phones: new Set(),
      linkedins: new Set(),
      twentyIds: new Set(),
      hasPhone: false,
    });
  }
  for (const r of identRows) {
    const f = fragById.get(r.contact_id);
    if (!f) continue;
    if (r.kind === "phone") {
      f.phones.add(r.value);
      f.hasPhone = true;
    } else if (r.kind === "linkedin_url") {
      f.linkedins.add(r.value);
    } else if (r.kind === "twenty_id") {
      f.twentyIds.add(r.value);
    }
  }

  // group by normalized name
  const groups = new Map<string, Frag[]>();
  for (const c of contacts) {
    const n = normalizeName(c.display_name);
    if (!n) continue;
    const bucket = groups.get(n);
    const frag = fragById.get(c.id)!;
    if (bucket) bucket.push(frag);
    else groups.set(n, [frag]);
  }

  const merges: DedupMerge[] = [];
  const held: DedupHold[] = [];

  for (const frags of groups.values()) {
    if (frags.length < 2) continue;
    const name = frags[0]!.displayName;
    if (frags.length > 2) {
      held.push({ name, ids: frags.map((f) => f.id), reason: "3+ fragments" });
      continue;
    }
    const [a, b] = frags as [Frag, Frag];
    if (disjoint(a.phones, b.phones)) {
      held.push({ name, ids: [a.id, b.id], reason: "different phone numbers" });
      continue;
    }
    if (disjoint(a.linkedins, b.linkedins)) {
      held.push({ name, ids: [a.id, b.id], reason: "different LinkedIn URLs" });
      continue;
    }
    if (disjoint(a.twentyIds, b.twentyIds)) {
      held.push({ name, ids: [a.id, b.id], reason: "different Twenty links" });
      continue;
    }
    // Survivor: keep the Twenty-linked fragment (preserves the link + cache),
    // else the one with a phone (richest), else the lower id.
    const survivor = pickSurvivor(a, b);
    const from = survivor.id === a.id ? b : a;
    merges.push({ survivorId: survivor.id, fromId: from.id, name });
  }

  return { merges, held };
}

function pickSurvivor(a: Frag, b: Frag): Frag {
  if (a.twentyIds.size && !b.twentyIds.size) return a;
  if (b.twentyIds.size && !a.twentyIds.size) return b;
  if (a.hasPhone && !b.hasPhone) return a;
  if (b.hasPhone && !a.hasPhone) return b;
  return a.id < b.id ? a : b;
}

export function applyDedup(db: Db, plan: DedupPlan): number {
  for (const m of plan.merges) {
    mergeContacts(db, m.fromId, m.survivorId);
  }
  return plan.merges.length;
}
