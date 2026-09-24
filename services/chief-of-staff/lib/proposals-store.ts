/**
 * Notion + Atlas proposal stores — ported from `services/box/lib/notion-proposals.ts`
 * and `services/box/lib/atlas-proposals.ts`. Table and column names match exactly:
 * eve-saga shares the box's `lares_state` Postgres (same convention as
 * `lib/reminders-store.ts`), so this reads and writes the SAME rows notion-sync and the
 * Atlas job already write via `services/box/sql/015_notion_sync.sql`,
 * `016_notion_sync_phase3.sql`, `017_notion_proposal_announced.sql`,
 * `018_notion_sync_phase4.sql` and `019_atlas_sync.sql` — no new migration here.
 *
 * Scope: only what Task 11's tools + watch schedule need — the OPEN-queue read, the guarded
 * approve/reject transition, and the announce ledger (unannounced read + first-stamp-wins
 * mark) for both lanes. The sync engines' own apply-pass queries
 * (getRejectedUnexecuted/markProposalReverted, getAtlasProposalsAwaitingApply/
 * completeAtlasProposal/supersedeAtlasProposal, atlas_notes bookkeeping, getStaleProposals,
 * getRecentlyClosedProposals) are NOT ported — those still belong to notion-sync/atlas-sync,
 * not to this approval surface.
 *
 * Typed against `Pool` from "pg", not the `Queryable` structural interface
 * services/box/lib/db.ts defines — eve-saga has no such abstraction and every sibling
 * store here (lib/reminders-store.ts) takes a `Pool` directly.
 */
import type { Pool } from "pg";
import type { Origin } from "@lares/agent-kit/origin";

// ── Notion proposals (notion_sync_proposals + notion_sync_docs) ──────────────────────────

export type ProposalState = "pending" | "approved" | "rejected" | "applied" | "superseded";

/** 'update' — an edit to a vault file that already exists (the default). 'create' — a
 *  Notion row/page with no vault file yet, asking for one (migration 018). */
export type ProposalKind = "update" | "create";

export interface ProposalInput {
  vaultPath: string;
  notionPageId: string;
  proposedBody: string;
  baseMdHash: string;
  notionHash: string;
  diffPreview?: string;
  kind?: ProposalKind;
}

export interface ProposalRow {
  id: number;
  vaultPath: string;
  notionPageId: string;
  proposedBody: string;
  baseMdHash: string;
  notionHash: string;
  diffPreview: string;
  kind: ProposalKind;
  /** Does NOTION own this document (notion_sync_docs.direction = 'notion_to_md')? Joined
   *  in, never stored — see PROPOSAL_JOIN below for why. FALSE for a create (no row yet). */
  notionOwned: boolean;
  state: ProposalState;
  createdAt: Date;
}

/**
 * What a decision actually does — THREE outcomes, not two, and which one applies is a
 * property of the document, not the button:
 *   create                  → approve creates the file; reject creates nothing
 *   update, Notion-owned    → approve writes the vault; reject leaves BOTH sides alone
 *   update, mirror/two-way  → approve writes the vault; reject ALSO reverts the Notion page
 * These live beside ProposalRow, as pure functions, because every surface that states a
 * consequence (list tool output, the resolve tool's result, the watch schedule's prompt)
 * must quote the SAME sentence — six independently-written sentences is the defect class
 * the old system hit twice (see the source file's own history).
 */
export type RejectOutcome = "not-created" | "notion-untouched" | "notion-reverted";

export function rejectOutcome(row: Pick<ProposalRow, "kind" | "notionOwned">): RejectOutcome {
  if (row.kind === "create") return "not-created";
  return row.notionOwned ? "notion-untouched" : "notion-reverted";
}

export function rejectConsequence(row: Pick<ProposalRow, "kind" | "notionOwned">): string {
  switch (rejectOutcome(row)) {
    case "not-created":
      return "the file is not created, and nothing in Notion changes";
    case "notion-untouched":
      return "the vault is left as it is, and your Notion page is left as it is — " +
        "Notion owns this document, so nothing is written on either side";
    case "notion-reverted":
      return "the vault keeps its current content AND your Notion page is reverted back to it";
  }
}

export function approveConsequence(row: Pick<ProposalRow, "kind" | "notionOwned">): string {
  return row.kind === "create"
    ? "the file is created in the vault on the next sync tick (within the hour)"
    : "the edit is written into the vault file on the next sync tick (within the hour)";
}

const PROPOSAL_COLUMNS = `p.id, p.vault_path, p.notion_page_id, p.proposed_body, p.base_md_hash,
            p.notion_hash, p.diff_preview, p.kind, p.state, p.created_at,
            (d.direction = 'notion_to_md') AS notion_owned`;

/** LEFT JOIN on the globally-UNIQUE vault_path: a create proposal has no path-bearing docs
 *  row yet, and an inner join would silently drop every create from every queue. */
const PROPOSAL_JOIN = `notion_sync_proposals p
       LEFT JOIN notion_sync_docs d
              ON d.vault_path = p.vault_path`;

interface ProposalDbRow {
  id: string;
  vault_path: string;
  notion_page_id: string;
  proposed_body: string;
  base_md_hash: string;
  notion_hash: string;
  diff_preview: string;
  kind: ProposalKind;
  notion_owned: boolean | null;
  state: ProposalState;
  created_at: Date;
}

function toRow(row: ProposalDbRow): ProposalRow {
  return {
    id: Number(row.id),
    vaultPath: row.vault_path,
    notionPageId: row.notion_page_id,
    proposedBody: row.proposed_body,
    baseMdHash: row.base_md_hash,
    notionHash: row.notion_hash,
    diffPreview: row.diff_preview,
    kind: row.kind,
    notionOwned: row.notion_owned === true,
    state: row.state,
    createdAt: row.created_at,
  };
}

/** Plain INSERT — test/seed helper. notion-sync itself owns the real inserts. */
export async function insertProposal(db: Pool, input: ProposalInput): Promise<number> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO notion_sync_proposals
       (vault_path, notion_page_id, proposed_body, base_md_hash, notion_hash, diff_preview, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.vaultPath, input.notionPageId, input.proposedBody, input.baseMdHash, input.notionHash,
      input.diffPreview ?? "", input.kind ?? "update",
    ],
  );
  return Number(res.rows[0]!.id);
}

/** Everything still awaiting a human decision or an engine apply. */
export async function getOpenProposals(db: Pool): Promise<ProposalRow[]> {
  const res = await db.query<ProposalDbRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM ${PROPOSAL_JOIN}
      WHERE p.state IN ('pending', 'approved')
      ORDER BY p.created_at`,
  );
  return res.rows.map(toRow);
}

export type ProposalAction = "approve" | "reject";

/**
 * THE guarded state transition — ONE statement, not read-then-write, so a resolve racing
 * the sync engine's own apply pass cannot silently land a decision on an already-moved row
 * (see the ported source file's TOCTOU walkthrough). Throws if `id` is not currently open.
 */
export async function resolveProposal(db: Pool, id: number, action: ProposalAction): Promise<ProposalRow> {
  const state: ProposalState = action === "approve" ? "approved" : "rejected";
  const res = await db.query<ProposalDbRow>(
    `WITH p AS (
       UPDATE notion_sync_proposals
          SET state = $2
        WHERE id = $1 AND state IN ('pending', 'approved')
        RETURNING *
     )
     SELECT ${PROPOSAL_COLUMNS}
       FROM p
       LEFT JOIN notion_sync_docs d
              ON d.vault_path = p.vault_path`,
    [id, state],
  );
  const row = res.rows[0];
  if (row === undefined) {
    throw new Error(`no open proposal with id ${id} (already resolved, or never existed)`);
  }
  return toRow(row);
}

/** Proposals nobody has been told about yet — 'pending' only (an 'approved' one is already
 *  decided and merely awaiting the sync engine's next tick). */
export async function getUnannouncedProposals(db: Pool): Promise<ProposalRow[]> {
  const res = await db.query<ProposalDbRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM ${PROPOSAL_JOIN}
      WHERE p.state = 'pending' AND p.announced_at IS NULL
      ORDER BY p.created_at`,
  );
  return res.rows.map(toRow);
}

/**
 * Marks a proposal as announced. Guarded on `announced_at IS NULL` — first stamp wins, so a
 * retried tick (or a retry racing itself) cannot re-stamp and reset anything downstream that
 * reads this timestamp. The CALLER must only invoke this after the message actually went
 * out — stamping optimistically turns one failed send into a proposal nobody is ever told
 * about.
 */
export async function markProposalAnnounced(db: Pool, id: number): Promise<void> {
  await db.query(
    `UPDATE notion_sync_proposals
        SET announced_at = now()
      WHERE id = $1 AND announced_at IS NULL`,
    [id],
  );
}

// ── Atlas proposals (atlas_proposals + atlas_notes) ───────────────────────────────────────

export type AtlasProposalState = "pending" | "approved" | "rejected" | "applied" | "superseded";

export interface AtlasProposalInput {
  notePath: string;
  proposedNote: string;
  baseBodyHash: string;
  sourcesHash: string;
  diffPreview?: string;
}

export interface AtlasProposalRow {
  id: number;
  notePath: string;
  proposedNote: string;
  baseBodyHash: string;
  sourcesHash: string;
  diffPreview: string;
  state: AtlasProposalState;
  createdAt: Date;
}

/** An Atlas proposal is always the same shape of decision — "rewrite this note's narrative
 *  from its sources" — so, unlike Notion, there is exactly one pair of consequence
 *  sentences, not a function of the row. Still functions, not inlined strings, for the same
 *  one-sentence-one-place reason as the Notion side. */
export function atlasApproveConsequence(): string {
  return "the re-derived note is written into the Atlas on the next sync tick, and pushed";
}

export function atlasRejectConsequence(): string {
  return "the note is left exactly as it is, and this draft is not offered again until one " +
    "of its canonical sources actually changes";
}

const ATLAS_COLUMNS = `id, note_path, proposed_note, base_body_hash, sources_hash, diff_preview,
                 state, created_at`;

interface AtlasDbRow {
  id: string;
  note_path: string;
  proposed_note: string;
  base_body_hash: string;
  sources_hash: string;
  diff_preview: string;
  state: AtlasProposalState;
  created_at: Date;
}

function toAtlasRow(r: AtlasDbRow): AtlasProposalRow {
  return {
    id: Number(r.id),
    notePath: r.note_path,
    proposedNote: r.proposed_note,
    baseBodyHash: r.base_body_hash,
    sourcesHash: r.sources_hash,
    diffPreview: r.diff_preview,
    state: r.state,
    createdAt: r.created_at,
  };
}

/** Plain INSERT — test/seed helper. The Atlas sync job itself owns the real inserts. */
export async function insertAtlasProposal(db: Pool, input: AtlasProposalInput): Promise<number> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO atlas_proposals
       (note_path, proposed_note, base_body_hash, sources_hash, diff_preview)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.notePath, input.proposedNote, input.baseBodyHash, input.sourcesHash, input.diffPreview ?? ""],
  );
  return Number(res.rows[0]!.id);
}

export async function getOpenAtlasProposals(db: Pool): Promise<AtlasProposalRow[]> {
  const res = await db.query<AtlasDbRow>(
    `SELECT ${ATLAS_COLUMNS} FROM atlas_proposals
      WHERE state IN ('pending','approved') ORDER BY created_at`,
  );
  return res.rows.map(toAtlasRow);
}

export type AtlasProposalAction = "approve" | "reject";

/** THE guarded state transition for Atlas, same shape and same TOCTOU reasoning as
 *  `resolveProposal` above — ONE statement, throws if `id` is not currently open. */
export async function resolveAtlasProposal(
  db: Pool, id: number, action: AtlasProposalAction,
): Promise<AtlasProposalRow> {
  const state: AtlasProposalState = action === "approve" ? "approved" : "rejected";
  const res = await db.query<AtlasDbRow>(
    `UPDATE atlas_proposals SET state = $2
      WHERE id = $1 AND state IN ('pending','approved')
      RETURNING ${ATLAS_COLUMNS}`,
    [id, state],
  );
  const row = res.rows[0];
  if (row === undefined) {
    throw new Error(`no open atlas proposal with id ${id} (already resolved, or never existed)`);
  }
  return toAtlasRow(row);
}

/** Carries the note's brand alongside the proposal (LEFT JOIN atlas_notes; brand stays
 *  nullable — a note row predates the brand being set, and a missing one must read as
 *  absent rather than a guessed filename-derived brand). */
export type AtlasUnannouncedRow = AtlasProposalRow & { brand: string | null };

export async function getUnannouncedAtlasProposals(db: Pool): Promise<AtlasUnannouncedRow[]> {
  const res = await db.query<AtlasDbRow & { brand: string | null }>(
    `SELECT ${ATLAS_COLUMNS.split(",").map((c) => `p.${c.trim()}`).join(", ")}, n.brand
       FROM atlas_proposals p
       LEFT JOIN atlas_notes n ON n.note_path = p.note_path
      WHERE p.state = 'pending' AND p.announced_at IS NULL ORDER BY p.created_at`,
  );
  return res.rows.map((r) => ({ ...toAtlasRow(r), brand: r.brand }));
}

/** First stamp wins — same posture as `markProposalAnnounced`. The CALLER must only invoke
 *  this after the message actually went out. */
export async function markAtlasProposalAnnounced(db: Pool, id: number): Promise<void> {
  await db.query(
    `UPDATE atlas_proposals SET announced_at = now() WHERE id = $1 AND announced_at IS NULL`, [id],
  );
}

// ── Memory proposals (memory_proposals, services/box/sql/072_memory_proposals.sql) ───────
//
// The third lane, on the shape the two above already have. ADR-0018 rule 2: an unattended
// process (the dream cycle) may only ADD — it may never UPDATE or delete an existing standing
// row. This table is where it records the change it WANTS to make, so an approval card can
// show the owner the literal before/after, and only `memory_resolve_proposal`'s apply pass
// (a later slice) ever closes the row it names, and only on a 👍.

export type MemoryProposalState = "pending" | "approved" | "rejected" | "applied" | "superseded";

/** What the unattended run wants to do. `supersede` — close a standing preference and put a new
 *  one in its place. `retire` — close one with no replacement. `add` — an inference with no
 *  existing row to close, held for the owner's confirmation before it becomes a standing
 *  preference (ADR-0018 rule 4, sql/074). There is no `edit`: nothing in this system rewrites a
 *  row in place, which is ADR-0018 rule 2 in one sentence. */
export type MemoryProposalAction = "supersede" | "retire" | "add";

export interface MemoryProposalInput {
  action: MemoryProposalAction;
  /** The standing row this would close. "" for an add. */
  existingId: string;
  /** "" for an add. */
  existingText: string;
  /** The text that would replace it — empty for `retire`. */
  proposedText: string;
  subject: string;
  /** Where the proposing observation came from. `owner` for supersede/retire, `agent` for an
   *  add — the table's CHECK enforces the pairing, this is stored so a later reader never has
   *  to assume it. */
  origin: Origin;
  /** The run that proposed it, e.g. `dream-cycle-2026-09-18`. */
  source: string;
  /** The deterministic dedup key for an add (surface.ts's `identity-<hash>`); "" otherwise. */
  ref: string;
  /** The observation's kind, for the dream_preferences row an approved add inserts; ""
   *  otherwise. */
  kind: string;
}

export interface MemoryProposalRow extends MemoryProposalInput {
  id: number;
  state: MemoryProposalState;
  createdAt: Date;
}

/** A memory proposal is one of exactly three decisions, and the consequence sentence depends on
 *  which — a retire, a supersede and an add genuinely do different things, unlike the Atlas
 *  lane's single shape. */
export function memoryApproveConsequence(row: Pick<MemoryProposalRow, "action">): string {
  switch (row.action) {
    case "supersede":
      return "the existing preference is replaced with the proposed one";
    case "retire":
      return "the existing preference stops applying, with nothing put in its place";
    case "add":
      return "this is kept as a standing preference from now on, recorded as something you " +
        "confirmed";
  }
}

export function memoryRejectConsequence(row: Pick<MemoryProposalRow, "action">): string {
  switch (row.action) {
    case "supersede":
      return "the existing preference is left exactly as it is, and this change is not " +
        "proposed again until something new is observed";
    case "retire":
      return "the existing preference is left exactly as it is";
    case "add":
      return "nothing is kept, and this observation is not raised again unless something new " +
        "is observed";
  }
}

const MEMORY_COLUMNS = `id, action, existing_id, existing_text, proposed_text, subject, origin,
                 source, state, ref, kind, created_at`;

interface MemoryDbRow {
  id: string;
  action: MemoryProposalAction;
  existing_id: string;
  existing_text: string;
  proposed_text: string;
  subject: string;
  origin: Origin;
  source: string;
  state: MemoryProposalState;
  ref: string;
  kind: string;
  created_at: Date;
}

function toMemoryRow(r: MemoryDbRow): MemoryProposalRow {
  return {
    id: Number(r.id),
    action: r.action,
    existingId: r.existing_id,
    existingText: r.existing_text,
    proposedText: r.proposed_text,
    subject: r.subject,
    origin: r.origin,
    source: r.source,
    state: r.state,
    ref: r.ref,
    kind: r.kind,
    createdAt: r.created_at,
  };
}

/** Plain INSERT. The dream cycle's proposeSupersede adapter (a later slice) owns the real
 *  inserts; this is also the test/seed helper. Refuses (at the table, not here) a second open
 *  proposal for the same `existingId`, and a `proposedText`/`action` pair that does not match
 *  — see `memory_proposals_open_idx` and `memory_proposals_text_check` in
 *  `services/box/sql/072_memory_proposals.sql`. */
export async function insertMemoryProposal(db: Pool, input: MemoryProposalInput): Promise<number> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO memory_proposals
       (action, existing_id, existing_text, proposed_text, subject, origin, source, ref, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.action, input.existingId, input.existingText, input.proposedText, input.subject,
      input.origin, input.source, input.ref, input.kind,
    ],
  );
  return Number(res.rows[0]!.id);
}

export async function getOpenMemoryProposals(db: Pool): Promise<MemoryProposalRow[]> {
  const res = await db.query<MemoryDbRow>(
    `SELECT ${MEMORY_COLUMNS} FROM memory_proposals
      WHERE state IN ('pending','approved') ORDER BY created_at`,
  );
  return res.rows.map(toMemoryRow);
}

export type MemoryProposalDecision = "approve" | "reject";

/** THE guarded state transition for memory proposals — ONE statement, same TOCTOU reasoning as
 *  `resolveProposal`/`resolveAtlasProposal` above, but a NARROWER guard than either: only a
 *  `'pending'` row is open here. Unlike the Notion/Atlas lanes, where an 'approved' row stays
 *  "open" awaiting a background sync engine's own apply tick and so may still be flipped, a
 *  memory proposal's approval hands off to `applyMemoryProposal` (a later slice) almost
 *  immediately — the owner decides exactly once, and a second decision on an already-decided
 *  id (approved OR rejected) throws rather than silently overwriting the first one. */
export async function resolveMemoryProposal(
  db: Pool, id: number, action: MemoryProposalDecision,
): Promise<MemoryProposalRow> {
  const state: MemoryProposalState = action === "approve" ? "approved" : "rejected";
  const res = await db.query<MemoryDbRow>(
    `UPDATE memory_proposals SET state = $2
      WHERE id = $1 AND state = 'pending'
      RETURNING ${MEMORY_COLUMNS}`,
    [id, state],
  );
  const row = res.rows[0];
  if (row === undefined) {
    throw new Error(`no open memory proposal with id ${id} (already resolved, or never existed)`);
  }
  return toMemoryRow(row);
}

export async function getUnannouncedMemoryProposals(db: Pool): Promise<MemoryProposalRow[]> {
  const res = await db.query<MemoryDbRow>(
    `SELECT ${MEMORY_COLUMNS} FROM memory_proposals
      WHERE state = 'pending' AND announced_at IS NULL ORDER BY created_at`,
  );
  return res.rows.map(toMemoryRow);
}

/** First stamp wins — same posture as `markProposalAnnounced`/`markAtlasProposalAnnounced`. The
 *  CALLER must only invoke this after the message actually went out. */
export async function markMemoryProposalAnnounced(db: Pool, id: number): Promise<void> {
  await db.query(
    `UPDATE memory_proposals SET announced_at = now() WHERE id = $1 AND announced_at IS NULL`, [id],
  );
}
