/**
 * src/memory-read.ts — the server-side read model and export behind a future "Memory" page
 * (W4A-s4, ADR-0017 rule 6 "which memories did you use?" and rule 2's export column).
 *
 * READ-ONLY. Nothing here writes, retires or supersedes a row — `services/chief-of-staff/lib/
 * standing-facts.ts` (`rememberFact`, `forgetFact`, `supersedeFact`) still owns every write to
 * `standing_facts`. This module only reads it back, in the shape a page or an export needs
 * rather than the shape the store's own tools happen to use.
 *
 * WHY THE KIT, NOT THE ROLE SERVICE. `packages/agent-kit/src/conversation-record.ts` is the
 * precedent: a kit module that owns the READ side of a table a role service writes, because the
 * console depends on `@lares/agent-kit` (`services/console/package.json:22`) but cannot depend on
 * `lares-chief-of-staff` — there is no path by which it could. `MemoryFact` is deliberately NOT
 * chief-of-staff's `StandingFact`: this module reads the table directly, with the rendered
 * provenance a page needs, rather than the store's own internal shape.
 *
 * FAILS SOFT ON A BOX WHERE `sql/005-standing-facts-validity.sql` HAS NOT BEEN APPLIED.
 * `listMemory`'s one query never names `recorded_at`, `source` or `superseded_by` in the SQL
 * text — it selects `to_jsonb(f)` and reads each optional field defensively in TypeScript, so a
 * column that does not exist on this box is simply an absent key in the JSON row, never a
 * `42703 undefined_column` the way a named-column SELECT would raise. A pre-004 box (no `origin`
 * column either) reads every row as `origin: "owner"`, which is exactly what sql/004's own
 * backfill would write and the only value its CHECK constraint admits.
 *
 * `shelf` REPEATS the category → shelf mapping from
 * `services/chief-of-staff/lib/standing-facts.ts`'s `SHELF_OF_CATEGORY` rather than importing
 * it — the kit cannot import a role service. `tests/memory-read.test.ts` pins the two lists
 * against drift by reading that file as text, the `services/console/tests/engine-drift.test.ts`
 * technique this repo already uses for a mirror that cannot be an import.
 */
import type { Pool } from "pg";
import { isOrigin, type Origin } from "@lares/agent-kit/origin";

/**
 * One row of the Memory list. Deliberately NOT chief-of-staff's `StandingFact`: this module
 * reads the table from the kit, which cannot import a role service, and a page needs the
 * rendered provenance rather than the store's shape.
 */
export interface MemoryFact {
  id: number;
  owner: string;
  fact: string;
  category: string;
  shelf: "world" | "conduct" | "unknown";
  origin: Origin;
  /** One sentence: where this came from and when. Built here so a page and an export cannot
   *  word it differently. */
  provenance: string;
  statedAt: Date;
  recordedAt: Date | null;
  retiredAt: Date | null;
  supersededBy: number | null;
  sourceTurn: string;
  source: string | null;
}

export interface MemoryQuery {
  owner: string;
  /** Default "standing". "all" includes retired rows, newest first, so the page can show a
   *  fact's whole history rather than only what is in force. */
  include?: "standing" | "all";
  limit?: number;
}

export const MEMORY_PAGE_LIMIT = 500;

/** Mirrors `services/chief-of-staff/lib/standing-facts.ts`'s `SHELF_OF_CATEGORY` (ADR-0018 rule
 *  7) — the kit cannot import that file, so this is a repeated total function over the same five
 *  category names, pinned against drift by `tests/memory-read.test.ts`. An unknown category
 *  (a box running code older or newer than this list) answers `"unknown"` rather than guessing. */
const SHELF_OF_CATEGORY: Readonly<Record<string, "world" | "conduct">> = {
  travel: "conduct",
  schedule: "conduct",
  preference: "conduct",
  people: "world",
  places: "world",
};

function shelfOfCategory(category: string): "world" | "conduct" | "unknown" {
  return SHELF_OF_CATEGORY[category] ?? "unknown";
}

/** Role-neutral, one sentence per origin class — never a persona name, never the owner's. */
const ORIGIN_PHRASE: Readonly<Record<Origin, string>> = {
  owner: "said by the owner",
  agent: "inferred by the agent",
  synced: "synced from an outside source",
  system: "recorded by a scheduled run",
  third_party: "read from a third party",
};

function buildProvenance(origin: Origin, statedAt: Date, source: string | null): string {
  const day = statedAt.toISOString().slice(0, 10);
  const base = `${ORIGIN_PHRASE[origin]} on ${day}`;
  return source ? `${base}, written by ${source}` : base;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function date(v: unknown): Date | null {
  const s = str(v);
  return s ? new Date(s) : null;
}

/** `to_jsonb(f)`'s row, narrowed field by field — never cast. A key this box's `standing_facts`
 *  does not yet have (sql/004 or sql/005 unapplied) is simply absent, not `undefined` cast to
 *  something else. */
function toMemoryFact(row: Record<string, unknown>): MemoryFact {
  const category = str(row["category"]) ?? "";
  const origin: Origin = isOrigin(row["origin"]) ? row["origin"] : "owner";
  const statedAt = date(row["stated_at"]) ?? new Date(0);
  const source = str(row["source"]);
  return {
    id: num(row["id"]) ?? 0,
    owner: str(row["user_id"]) ?? "",
    fact: str(row["fact"]) ?? "",
    category,
    shelf: shelfOfCategory(category),
    origin,
    provenance: buildProvenance(origin, statedAt, source),
    statedAt,
    recordedAt: date(row["recorded_at"]),
    retiredAt: date(row["retired_at"]),
    supersededBy: num(row["superseded_by"]),
    sourceTurn: str(row["source_turn"]) ?? "",
    source,
  };
}

/**
 * The Memory list for ONE owner, newest first — scoped by `user_id` exactly as
 * `lib/standing-facts.ts`'s `listActiveFacts` is, so one member's facts can never surface for
 * another's request.
 *
 * ONE QUERY, and it names no column that has not existed since `sql/002-standing-facts.sql`:
 * `to_jsonb(f)` is what makes an unmigrated box safe — a column sql/004 or sql/005 has not added
 * yet is simply absent from the JSON row, never a name Postgres has to resolve and fail on.
 */
export async function listMemory(db: Pool, q: MemoryQuery): Promise<MemoryFact[]> {
  const includeAll = q.include === "all";
  const limit = q.limit ?? MEMORY_PAGE_LIMIT;
  const { rows } = await db.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(f) AS row
       FROM standing_facts f
      WHERE f.user_id = $1
        AND ($2 OR f.retired_at IS NULL)
      ORDER BY f.stated_at DESC, f.id DESC
      LIMIT $3`,
    [q.owner, includeAll, limit],
  );
  return rows.map((r) => toMemoryFact(r.row));
}

const CSV_HEADER = "id,owner,fact,category,shelf,origin,source,stated_at,recorded_at,retired_at,superseded_by";

/** RFC-4180: a field containing a comma, a double quote or a newline is wrapped in double
 *  quotes, with every inner double quote doubled. */
function csvField(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(f: MemoryFact): string {
  return [
    f.id,
    f.owner,
    f.fact,
    f.category,
    f.shelf,
    f.origin,
    f.source,
    f.statedAt.toISOString(),
    f.recordedAt ? f.recordedAt.toISOString() : null,
    f.retiredAt ? f.retiredAt.toISOString() : null,
    f.supersededBy,
  ]
    .map(csvField)
    .join(",");
}

/**
 * The whole of one owner's memory as CSV, header row first, RFC-4180 quoting. The nightly
 * one-way export ADR-0017 rule 2 asks for, as a string — this module writes no files, opens no
 * schedule and makes no network call (Owner decision A3: a function now, a schedule only if an
 * owner asks for one).
 */
export function memoryCsv(rows: readonly MemoryFact[]): string {
  return [CSV_HEADER, ...rows.map(csvRow)].join("\n");
}

/** A pipe escaped so a fact containing one cannot break the table's column structure. */
function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/** The same rows as a markdown table, for an owner who wants to read rather than import. */
export function memoryMarkdown(rows: readonly MemoryFact[]): string {
  const header = "| id | owner | fact | category | shelf | origin | source | stated_at | recorded_at | retired_at | superseded_by |";
  const rule = "|---|---|---|---|---|---|---|---|---|---|---|";
  const lines = rows.map((f) =>
    [
      f.id,
      f.owner,
      escapePipe(f.fact),
      f.category,
      f.shelf,
      f.origin,
      f.source ?? "",
      f.statedAt.toISOString(),
      f.recordedAt ? f.recordedAt.toISOString() : "",
      f.retiredAt ? f.retiredAt.toISOString() : "",
      f.supersededBy ?? "",
    ].join(" | "),
  );
  return [header, rule, ...lines.map((l) => `| ${l} |`)].join("\n");
}

/**
 * "Which memories did you use?" (W5A-s4, ADR-0017 rule 6). Reads `memory_reads`
 * (`services/box/sql/075_memory_reads.sql`), written by `services/chief-of-staff/lib/
 * memory-reads.ts`'s `recordRead` — internal to that service, so the kit re-declares the same
 * four kinds here rather than importing it (the kit cannot import a role service).
 *
 * FAILS SOFT ON A BOX WHERE 075 HAS NOT BEEN APPLIED, the same posture as `recordRead` itself:
 * a missing table means nothing was ever recorded, not a crash. `listMemoryUsed` and
 * `previousTurnIn` both catch `42P01` (undefined_table) and answer as if the query found
 * nothing — an empty list, or `null` — rather than throwing.
 */

/** One remembered thing an answer opened. `via` is how it reached the model: the session's
 *  standing-facts block, or a tool the model called in that turn. */
export interface MemoryUsed {
  kind: "standing_fact" | "preference" | "vault_note" | "agent_note";
  ref: string;
  via: "session-block" | "this-turn";
  at: Date;
}

export const MEMORY_USED_LIMIT = 200;

/** `true` for Postgres's "relation does not exist" — the shape a missing `memory_reads` table
 *  raises as (`42P01`), the same code `recordRead`'s own catch-all is built to swallow. */
function isMissingTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01";
}

/**
 * What ONE answer used: the turn's own rows, plus the session block's (`turn_id = ''`). Every
 * row is scoped to `q.sessionId`, so this can never mix in another session's reads — there is no
 * owner column in the query because a session already belongs to exactly one owner and nothing
 * here is ever queried across sessions.
 */
export async function listMemoryUsed(db: Pool, q: { sessionId: string; turnId: string }): Promise<MemoryUsed[]> {
  try {
    const { rows } = await db.query<{ kind: string; ref: string; turn_id: string; at: Date }>(
      `SELECT kind, ref, turn_id, at
         FROM memory_reads
        WHERE session_id = $1 AND (turn_id = $2 OR turn_id = '')
        ORDER BY turn_id DESC, at DESC, ctid DESC
        LIMIT $3`,
      [q.sessionId, q.turnId, MEMORY_USED_LIMIT],
    );
    return rows.map((r) => ({
      kind: r.kind as MemoryUsed["kind"],
      ref: r.ref,
      via: r.turn_id === "" ? "session-block" : "this-turn",
      at: r.at,
    }));
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/**
 * The turn before `beforeTurnId` in this session — what the owner means by "that answer" when
 * they ask the question on the next turn. `null` when this is the session's first turn (or the
 * table does not exist yet).
 *
 * TIE-BREAKS ON `ctid`, NOT `at` ALONE. `recordRead` can insert several rows in one statement
 * (one per ref), and Postgres's `now()` is the transaction's start time — every row a single
 * statement writes shares the exact same `at`. `ctid` (this append-only table is never updated,
 * so its physical tuple order tracks insertion order) breaks that tie the way a row's own
 * insertion order would if the table carried a sequence column.
 */
export async function previousTurnIn(db: Pool, q: { sessionId: string; beforeTurnId: string }): Promise<string | null> {
  try {
    const { rows } = await db.query<{ turn_id: string }>(
      `WITH marker AS (
         SELECT at, ctid FROM memory_reads
          WHERE session_id = $1 AND turn_id = $2
          ORDER BY at ASC, ctid ASC
          LIMIT 1
       )
       SELECT r.turn_id
         FROM memory_reads r, marker
        WHERE r.session_id = $1
          AND r.turn_id <> ''
          AND r.turn_id <> $2
          AND (r.at, r.ctid) < (marker.at, marker.ctid)
        ORDER BY r.at DESC, r.ctid DESC
        LIMIT 1`,
      [q.sessionId, q.beforeTurnId],
    );
    return rows[0]?.turn_id ?? null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

const MEMORY_USED_LIMIT_SENTENCE =
  "Only things opened by id or by path are listed. A note found by searching and only " +
  "skimmed is not recorded, so this list can be shorter than what was in front of me — " +
  "never longer.";

/** What each recorded kind is called when the OWNER reads the list — never the column value. */
const MEMORY_USED_LABEL: Record<MemoryUsed["kind"], string> = {
  standing_fact: "Something you told me to remember",
  preference: "A standing preference",
  vault_note: "A note I opened",
  agent_note: "A note I left myself in this conversation",
};

const MEMORY_USED_VIA: Record<MemoryUsed["via"], string> = {
  "session-block": "in front of me for the whole conversation",
  "this-turn": "opened for that answer",
};

/** Role-neutral prose an owner can read on a phone: one line per item in plain words, the id or
 *  path kept so the item can be looked up, and ALWAYS the sentence that states the limit — an
 *  empty list most of all, where "nothing recorded" would otherwise read as "nothing used". */
export function memoryUsedMarkdown(rows: readonly MemoryUsed[]): string {
  if (rows.length === 0) {
    return ["Nothing recorded for that answer.", "", MEMORY_USED_LIMIT_SENTENCE].join("\n");
  }
  const lines = rows.map(
    (r) => `- ${MEMORY_USED_LABEL[r.kind]} (${r.ref}) — ${MEMORY_USED_VIA[r.via]}`,
  );
  return [...lines, "", MEMORY_USED_LIMIT_SENTENCE].join("\n");
}
