import type { Db } from "./db.js";
import { normalizeName } from "./normalize.js";

export type WhoAtRow = { id: number; displayName: string; title: string | null; company: string | null; band: string; score: number; lastInteractionAt: string | null; twentyStrength: string | null; twentyLastContacted: string | null };

export function whoAt(db: Db, company: string): WhoAtRow[] {
  return (db
    .prepare(
      `SELECT c.id, c.display_name AS displayName, c.title, c.company,
              COALESCE(p.band, 'NO_CONNECTION') AS band, COALESCE(p.score, 0) AS score,
              p.last_interaction_at AS lastInteractionAt,
              c.twenty_strength AS twentyStrength, c.twenty_last_contacted AS twentyLastContacted
       FROM contacts c LEFT JOIN pulse p ON p.contact_id = c.id
       WHERE c.company LIKE '%' || ? || '%' COLLATE NOCASE
       ORDER BY COALESCE(p.score, 0) DESC, c.display_name`,
    )
    .all(company) as WhoAtRow[]);
}

export type DormantRow = WhoAtRow & { dormantWarm: boolean };

export function dormantQueue(db: Db, limit = 25): DormantRow[] {
  return (db
    .prepare(
      `SELECT c.id, c.display_name AS displayName, c.title, c.company, p.band, p.score,
              p.last_interaction_at AS lastInteractionAt,
              c.twenty_strength AS twentyStrength, c.twenty_last_contacted AS twentyLastContacted,
              1 AS dormantWarm
       FROM pulse p JOIN contacts c ON c.id = p.contact_id
       WHERE p.dormant_warm = 1
       ORDER BY p.score DESC LIMIT ?`,
    )
    .all(limit) as any[]).map((r) => ({ ...r, dormantWarm: true }));
}

export type PersonProfile = {
  contact: { id: number; displayName: string; company: string | null; title: string | null; band: string; score: number; components: Record<string, number>; twentyStrength: string | null; twentyLastContacted: string | null };
  identities: { kind: string; value: string }[];
  interactions: { channel: string; direction: string | null; at: string; content: string | null }[];
};

export function personProfile(db: Db, name: string, recentLimit = 30): PersonProfile | null {
  const wanted = normalizeName(name);
  const all = db.prepare("SELECT id, display_name FROM contacts").all() as { id: number; display_name: string }[];
  const hit = all.find((c) => normalizeName(c.display_name) === wanted) ??
    all.find((c) => normalizeName(c.display_name).includes(wanted));
  if (!hit) return null;
  const c = db
    .prepare(
      `SELECT c.id, c.display_name AS displayName, c.company, c.title,
              COALESCE(p.band, 'NO_CONNECTION') AS band, COALESCE(p.score, 0) AS score,
              COALESCE(p.components, '{}') AS components,
              c.twenty_strength AS twentyStrength, c.twenty_last_contacted AS twentyLastContacted
       FROM contacts c LEFT JOIN pulse p ON p.contact_id = c.id WHERE c.id = ?`,
    )
    .get(hit.id) as any;
  return {
    contact: { ...c, components: JSON.parse(c.components) },
    identities: db.prepare("SELECT kind, value FROM identities WHERE contact_id = ?").all(hit.id) as any[],
    interactions: db
      .prepare("SELECT channel, direction, at, content FROM interactions WHERE contact_id = ? ORDER BY at DESC LIMIT ?")
      .all(hit.id, recentLimit) as any[],
  };
}

/** Arbitrary questions from the /network skill — SELECT/WITH only. */
export function readOnlySql(db: Db, sql: string): unknown[] {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error("read-only: only SELECT/WITH statements are allowed");
  const stmt = db.prepare(sql);
  // The regex alone is bypassable (e.g. `WITH x AS (SELECT 1) DELETE ... RETURNING *`);
  // sqlite itself knows whether a prepared statement writes.
  if (!stmt.readonly) throw new Error("read-only: statement would modify the database");
  return stmt.all();
}
