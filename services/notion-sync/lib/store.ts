// Vendor-neutral: takes a structural Queryable, never imports "pg".
import type { Queryable } from "@lares/agent-box";

export type DocState = "synced" | "frozen" | "error" | "unmatched" | "retrying";

const MEETING_DEFAULTS = "'meetings', 'notion_to_md'";

export async function recordMeetingSynced(
  db: Queryable,
  pageId: string,
  notionLastEdited: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO notion_sync_docs
       (notion_page_id, target, direction, notion_last_edited, state, updated_at)
     VALUES ($1, ${MEETING_DEFAULTS}, $2, 'synced', now())
     ON CONFLICT (notion_page_id) DO UPDATE
       SET notion_last_edited = EXCLUDED.notion_last_edited,
           state = 'synced',
           frozen_reason = NULL,
           frozen_at = NULL,
           error_count = 0,
           updated_at = now()`,
    [pageId, notionLastEdited],
  );
}

export async function recordMeetingUnmatched(
  db: Queryable,
  pageId: string,
  reason: string,
): Promise<void> {
  await db.query(
    `INSERT INTO notion_sync_docs
       (notion_page_id, target, direction, state, frozen_reason, frozen_at, updated_at)
     VALUES ($1, ${MEETING_DEFAULTS}, 'unmatched', $2, now(), now())
     ON CONFLICT (notion_page_id) DO UPDATE
       SET state = 'unmatched',
           frozen_reason = EXCLUDED.frozen_reason,
           frozen_at = COALESCE(notion_sync_docs.frozen_at, now()),
           updated_at = now()`,
    [pageId, reason],
  );
}

/**
 * Records a failed write. State only flips to 'error' on the third consecutive
 * failure (spec §2) so one flaky API call does not surface as an incident.
 *
 * A first-ever failure inserts 'retrying', not 'synced': the page has never been
 * written successfully, so claiming it is synced until the third strike is a lie
 * the console would faithfully repeat. On a later failure the existing state is
 * preserved (a previously-synced row keeps its 'synced' until it earns 'error').
 */
export async function recordMeetingError(
  db: Queryable,
  pageId: string,
  message: string,
): Promise<void> {
  await db.query(
    `INSERT INTO notion_sync_docs
       (notion_page_id, target, direction, state, frozen_reason, error_count, updated_at)
     VALUES ($1, ${MEETING_DEFAULTS}, 'retrying', $2, 1, now())
     ON CONFLICT (notion_page_id) DO UPDATE
       SET error_count = notion_sync_docs.error_count + 1,
           frozen_reason = EXCLUDED.frozen_reason,
           state = CASE WHEN notion_sync_docs.error_count + 1 >= 3
                        THEN 'error' ELSE notion_sync_docs.state END,
           updated_at = now()`,
    [pageId, message],
  );
}

export interface DocRow {
  pageId: string;
  mdHash: string | null;
  state: DocState;
}

export interface DocSyncedInput {
  vaultPath: string;
  pageId: string;
  /**
   * Change-detection hash of the RENDERED outputs we pushed (plan decision 1):
   * markdown plus the prop-bearing title and frontmatter — see wikiRenderHash
   * for why the body alone would silently drop prop-only edits forever.
   */
  mdHash: string;
  /** sha256 of what Notion gave back — the hash-after-write defence (spec §3). */
  notionHash: string;
  notionLastEdited: string | null;
  /**
   * Direction to seed on a NEWLY adopted row, default 'md_to_notion' (Phase 3 plan
   * decision 4: every file starts Mirror until an explicit `enable-two-way` flips
   * it). Ignored on conflict — an existing row's direction is changed only by
   * setDocDirection, never silently reset by a routine push write. Existing
   * callers (wiki-sync.ts via cli.ts) omit this and get the same behaviour as
   * before Phase 3.
   */
  direction?: string;
}

/**
 * The PUSH pass's view of local state, keyed the way that pass thinks: by
 * vault_path, and scoped to the documents it owns (`target='docs'`).
 *
 * ⚠️ THE TARGET FILTER IS NOT A PARTITION OF THE PATH SPACE. It was, until Phase 4:
 * meeting rows carried a NULL vault_path, so "docs rows" and "rows with a path"
 * were the same set and this filter kept the two passes disjoint by construction.
 * A transcript's state row is a MEETINGS row WITH a vault_path (T4), so a path this
 * reader cannot see may still be owned — and a caller that reads "no row for this
 * path" as "this path is free to claim" is wrong in the one direction that
 * destroys something. That is exactly the hole the push pass fell into: it adopted
 * a transcript, created a second Notion page for it, and repointed the Meetings row
 * at the page it had just invented.
 *
 * Two guards now make that impossible, and neither is this filter: the push is
 * handed the across-targets hold-back set (`pushHoldBack`, direction.ts), and
 * `upsertDocSynced` REFUSES to update a row of another target. Use `getLinkedRows`
 * when the question is "who owns this path"; this reader answers the narrower "what
 * are the desk documents".
 */
export async function getDocRows(db: Queryable): Promise<Map<string, DocRow>> {
  const res = await db.query<{
    vault_path: string;
    notion_page_id: string;
    md_hash: string | null;
    state: DocState;
  }>(
    `SELECT vault_path, notion_page_id, md_hash, state
       FROM notion_sync_docs
      WHERE target = 'docs' AND vault_path IS NOT NULL`,
  );
  const rows = new Map<string, DocRow>();
  for (const row of res.rows) {
    rows.set(row.vault_path, {
      pageId: row.notion_page_id, mdHash: row.md_hash, state: row.state,
    });
  }
  return rows;
}

export interface DeskRow {
  pageId: string;
  mdHash: string | null;
  notionHash: string | null;
  /**
   * ISO 8601 UTC text, cast in SQL rather than left as the driver's parsed Date
   * (contrast getLastRunAt): the pull pass (T5) compares this directly against
   * Notion's own `lastEditedTime` strings from queryDocs — both ISO 8601, both
   * UTC — on `>=` (plan-context: minute-granular, never a `>`). A raw Date object
   * here would silently break that string comparison in production.
   */
  notionLastEdited: string | null;
  state: DocState;
  direction: string;
}

/**
 * The desk (two-way) passes' view of local state — same 'docs' rows getDocRows
 * reads, but widened with the columns only Phase 3 needs (notion_hash,
 * notion_last_edited, direction). A second reader over the same rows rather than
 * widening DocRow/getDocRows itself: the push engine's adoption/pin logic wants
 * nothing more than {pageId, mdHash, state}, and giving it columns it never uses
 * would blur why each field is there.
 */
export async function getDeskRows(db: Queryable): Promise<Map<string, DeskRow>> {
  const res = await db.query<{
    vault_path: string;
    notion_page_id: string;
    md_hash: string | null;
    notion_hash: string | null;
    notion_last_edited: string | null;
    state: DocState;
    direction: string;
  }>(
    `SELECT vault_path, notion_page_id, md_hash, notion_hash,
            to_char(notion_last_edited AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              AS notion_last_edited,
            state, direction
       FROM notion_sync_docs
      WHERE target = 'docs' AND vault_path IS NOT NULL`,
  );
  const rows = new Map<string, DeskRow>();
  for (const row of res.rows) {
    rows.set(row.vault_path, {
      pageId: row.notion_page_id,
      mdHash: row.md_hash,
      notionHash: row.notion_hash,
      notionLastEdited: row.notion_last_edited,
      state: row.state,
      direction: row.direction,
    });
  }
  return rows;
}

/** Which Notion database a state row came from. The schema's own CHECK, as a type. */
export type DocTarget = "docs" | "meetings";

/**
 * A row that HAS a vault file, whatever database it came from — the apply pass's
 * view (Phase 4, T4).
 *
 * `getDeskRows` answers "which desk documents does this deployment sync", so it is
 * rightly `target='docs'`. runApplySync asks a different question: "what is the
 * state row for the vault file this decision is about?" — and from Phase 4 on, the
 * answer for a transcript is its MEETINGS row, because a transcript's state row IS
 * the Meetings row it came from (T4 decision 1; `notion_page_id` is globally UNIQUE,
 * so a second row for the same page is not an option). With a docs-only lookup the
 * apply pass would report "row missing" for every transcript proposal, forever.
 *
 * `vault_path` is UNIQUE across the WHOLE table, so keying by it stays unambiguous
 * with both targets in the map — which is exactly why this widening needs no
 * target-aware join, and why the create branch's page-uniqueness guard gets
 * meetings rows for free.
 */
export interface LinkedRow extends DeskRow {
  target: DocTarget;
}

/** What `linkPageToVaultFile` needs beyond an ordinary doc write. */
export interface LinkedFileInput extends DocSyncedInput {
  /**
   * sha256 of the BODY just written (`vaultBodyHash`, pull-sync.ts). Stored as
   * `md_hash` when — and only when — the row this binds is a MEETINGS row; a docs
   * row keeps its push render hash. Required rather than optional: the caller always
   * has the bytes it just wrote, and a default would silently give a transcript the
   * hash that permanently retires it.
   */
  writtenBodyHash: string;
}

/**
 * Every row with a vault file, keyed by vault_path, across BOTH targets.
 *
 * Deliberately a SECOND reader rather than a widening of getDeskRows: the desk
 * passes (push, pull, archive-excluded, enable-two-way) must keep seeing docs rows
 * only — that scoping is what keeps a transcript structurally invisible to them
 * (spec §17.2, one-way permanently). One question, one reader; two different
 * questions, two readers.
 */
export async function getLinkedRows(db: Queryable): Promise<Map<string, LinkedRow>> {
  const res = await db.query<{
    vault_path: string;
    notion_page_id: string;
    md_hash: string | null;
    notion_hash: string | null;
    notion_last_edited: string | null;
    state: DocState;
    direction: string;
    target: DocTarget;
  }>(
    // Same ISO-8601 cast as getDeskRows, for the same reason (see DeskRow).
    `SELECT vault_path, notion_page_id, md_hash, notion_hash,
            to_char(notion_last_edited AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              AS notion_last_edited,
            state, direction, target
       FROM notion_sync_docs
      WHERE vault_path IS NOT NULL`,
  );
  const rows = new Map<string, LinkedRow>();
  for (const row of res.rows) {
    rows.set(row.vault_path, {
      pageId: row.notion_page_id,
      mdHash: row.md_hash,
      notionHash: row.notion_hash,
      notionLastEdited: row.notion_last_edited,
      state: row.state,
      direction: row.direction,
      target: row.target,
    });
  }
  return rows;
}

/** A Meetings state row as the transcript pass reads it — keyed by PAGE, not path. */
export interface MeetingStateRow {
  pageId: string;
  /** NULL until the transcript's vault file has been created (T4 decision 1). */
  vaultPath: string | null;
  /**
   * sha256 of the BODY the apply pass last WROTE into this file (`vaultBodyHash`).
   *
   * A different kind of hash from a docs row's `md_hash`, which is that row's push
   * RENDER hash — deliberately, and confined to a target the docs machinery cannot
   * see (`getDeskRows`/`getDocRows` are both `target='docs'`, and the push never
   * renders a transcript). It is the only honest answer to the question the
   * transcript pass actually asks: has a human changed the vault copy since this
   * service wrote it?
   *
   * The two hashes this replaced both got that question wrong in ways that
   * permanently retire a transcript, on a row with no freeze and no `resolve` to
   * heal it. A push render hash moves on its own when a `[[wikilink]]` becomes
   * resolvable, and is `""` whenever the post-write re-render failed. And
   * `notion_hash` — "the content this row has ACCOUNTED FOR" — is advanced by a
   * REJECTED update to the content that was DECLINED, while the file on disk still
   * holds the previous version, so every later Notion edit read as a hand edit.
   * This one needs no re-render and moves only when the file does.
   */
  mdHash: string | null;
  /** The Notion content this row has ACCOUNTED FOR — applied, or looked at and declined. */
  notionHash: string | null;
}

/**
 * The transcript pass's view of local state (Phase 4, T4): the Meetings rows, keyed
 * the way that pass thinks — by `notion_page_id`, because a Meetings page is the
 * document and its vault path is a consequence, not its identity.
 *
 * `state` is deliberately NOT returned. On a meetings row that column is the
 * ATTENDEE pass's verdict about a calendar match ('unmatched' for 6 of the 50 live
 * rows) and says nothing about whether a transcript may be written; returning it
 * would invite a future reader to gate on it and quietly stop those meetings' notes
 * from ever reaching the vault. See runApplySync's row gate for the same argument
 * made where it actually has to be made.
 */
export async function getMeetingRows(db: Queryable): Promise<Map<string, MeetingStateRow>> {
  const res = await db.query<{
    notion_page_id: string;
    vault_path: string | null;
    md_hash: string | null;
    notion_hash: string | null;
  }>(
    `SELECT notion_page_id, vault_path, md_hash, notion_hash
       FROM notion_sync_docs
      WHERE target = 'meetings'`,
  );
  const rows = new Map<string, MeetingStateRow>();
  for (const row of res.rows) {
    rows.set(row.notion_page_id, {
      pageId: row.notion_page_id,
      vaultPath: row.vault_path,
      mdHash: row.md_hash,
      notionHash: row.notion_hash,
    });
  }
  return rows;
}

/**
 * A state row as a CREATE PROPOSER reads it (Phase 4, T6): keyed by page, and
 * carrying only what a proposer can act on.
 *
 * Keyed by `notion_page_id` because a create proposer's document has no path yet —
 * the path is what it is asking to bring into existence — so page identity is the
 * only key it has. `notion_page_id` is globally UNIQUE, which is what makes that
 * key unambiguous across both targets.
 *
 * ACROSS TARGETS on purpose, unlike `getMeetingRows`. The question this answers is
 * "does this Notion page already have a state row anywhere", and a `target='docs'`
 * filter would answer a narrower one. The difference is not hypothetical: pages
 * move between Notion databases, `notion_page_id` is UNIQUE table-wide, and
 * `linkPageToVaultFile` conflicts on it — so a docs-scoped read that missed a
 * meetings row would let a create proposal be raised for a page whose approval
 * then fills in the vault_path of somebody else's row. One question, one reader.
 */
export interface PageStateRow {
  pageId: string;
  target: DocTarget;
  /** NULL until a vault file is linked — which is exactly what a create proposer looks for. */
  vaultPath: string | null;
  /** The Notion content this row has ACCOUNTED FOR — applied, or looked at and declined. */
  notionHash: string | null;
}

/** Every state row keyed by `notion_page_id`, across both targets. See PageStateRow. */
export async function getPageRows(db: Queryable): Promise<Map<string, PageStateRow>> {
  const res = await db.query<{
    notion_page_id: string;
    target: DocTarget;
    vault_path: string | null;
    notion_hash: string | null;
  }>(
    `SELECT notion_page_id, target, vault_path, notion_hash FROM notion_sync_docs`,
  );
  const rows = new Map<string, PageStateRow>();
  for (const row of res.rows) {
    rows.set(row.notion_page_id, {
      pageId: row.notion_page_id,
      target: row.target,
      vaultPath: row.vault_path,
      notionHash: row.notion_hash,
    });
  }
  return rows;
}

/**
 * Makes sure a Notion-born DOCS page has a state row, without asserting anything
 * about it (Phase 4, T6) — the twin of `ensureMeetingRow` below, and it exists for
 * the identical reason: **a decision needs somewhere to be recorded.**
 *
 * `recordNotionAccounted` is what remembers a 👎 on a create, it is keyed by page,
 * and it THROWS when it matches no row. A page a human made in Notion has no state
 * row at all until this runs, so without it every rejected create would come back
 * on the next tick, hourly, forever. T6 calls it immediately before its first
 * create proposal and refuses to propose if it fails.
 *
 * `direction` is `notion_to_md`, matching what the apply pass writes for a created
 * row (`CREATED_DIRECTION`, apply-sync.ts): Notion authored the page, the vault
 * file will be its projection, and no pass may push it back. `vault_path` stays
 * NULL — the column comment's own reserved meaning — so the row is invisible to
 * every path-keyed reader (`getDocRows`, `getDeskRows`, `getLinkedRows`) until an
 * approved create fills it in.
 *
 * ON CONFLICT DO NOTHING, and no `state`/`md_hash`/`notion_hash` in the INSERT: this
 * asserts existence and nothing else, so re-running it can never overwrite a
 * decision, a hash or another pass's verdict.
 */
export async function ensureDocsRow(db: Queryable, pageId: string): Promise<void> {
  await db.query(
    `INSERT INTO notion_sync_docs (notion_page_id, target, direction, updated_at)
     VALUES ($1, 'docs', 'notion_to_md', now())
     ON CONFLICT (notion_page_id) DO NOTHING`,
    [pageId],
  );
}

/**
 * Makes sure a Meetings page HAS a state row, without asserting anything about it
 * (Phase 4, T4). Called immediately before a transcript's first create proposal.
 *
 * It exists because a decision needs somewhere to be recorded. The attendee pass
 * only writes a row for a meeting it FILLED or FLAGGED, so a meeting whose
 * `Attendees` was already set has no row at all — and without one there is nowhere
 * to record that Bendik declined a transcript, so the next tick would propose it
 * again, and the next, forever. **This is the contract T6 inherits: a create
 * proposer must ensure a state row exists for its Notion page before it proposes.**
 *
 * ON CONFLICT DO NOTHING, and no `state` in the INSERT: on a meetings row `state`
 * belongs to the attendee pass, so this takes the column default for a brand-new
 * row and never overwrites an existing verdict. `direction` is 'notion_to_md'
 * because that is what a Meetings row has always been (MEETING_DEFAULTS) and what
 * spec §17.2 makes permanent. No watermark either: a row with a NULL
 * `notion_last_edited` is one the transcript pass reads unconditionally, which is
 * the honest state for a page nothing has accounted for yet.
 */
export async function ensureMeetingRow(db: Queryable, pageId: string): Promise<void> {
  await db.query(
    `INSERT INTO notion_sync_docs (notion_page_id, target, direction, updated_at)
     VALUES ($1, ${MEETING_DEFAULTS}, now())
     ON CONFLICT (notion_page_id) DO NOTHING`,
    [pageId],
  );
}

/**
 * Records the Notion content a row has ACCOUNTED FOR, keyed by PAGE (Phase 4, T4).
 *
 * Two callers, one meaning. The transcript pass uses it when a page's content still
 * hashes to what the row already holds — the "Notion re-saved but nothing changed"
 * path, where only the watermark needs to move. runApplySync uses it when Bendik
 * DECLINES a create: nothing is written on either side, but the content he looked at
 * and said no to is now accounted for, and without recording that the next tick
 * proposes the identical file again — hourly, forever.
 *
 * Keyed by page rather than by vault_path because a rejected create has no vault
 * file, and therefore no path-bearing row, to key on. That is the whole reason this
 * function is not `updateNotionWatermark`.
 *
 * Touches ONLY `notion_hash` — not the watermark, not state, not md_hash, not the
 * error count. `notion_last_edited` on a Meetings row is the ATTENDEE pass's stamp
 * for the ATTENDEE pass's question, and the transcript pass deliberately keeps its
 * hands off it: the content hash is the whole change test (spec §3), so there is
 * nothing here a timestamp would add except a second writer of a column that
 * already has a meaning.
 *
 * A page with no row THROWS (review round 1). It used to be a silent no-op on the
 * reasoning that inventing a row here would mean guessing a `target` for a page this
 * code knows nothing about — which is still true, and is still why it does not
 * insert one. But silence is the wrong half of that argument: the caller that
 * matters is the rejected-create branch, whose whole job is to remember a decision,
 * and an UPDATE matching zero rows let it "succeed", close the proposal, and hand
 * Bendik the identical transcript again on the next tick. The proposer's contract
 * ("ensure a state row exists for your page BEFORE proposing") is now ENFORCED here
 * rather than documented — which is what makes it a contract T6 inherits instead of
 * a rule it can quietly not follow.
 *
 * Loud is safe here: the apply pass runs this inside the same tryRecord as the close,
 * so a throw leaves the rejection unexecuted and the next tick retries it, with the
 * proposer still silent because the proposal is still in `getRejectedUnexecuted`.
 */
export async function recordNotionAccounted(
  db: Queryable,
  pageId: string,
  notionHash: string,
): Promise<void> {
  const res = await db.query<{ id: string }>(
    `UPDATE notion_sync_docs
        SET notion_hash = $2, updated_at = now()
      WHERE notion_page_id = $1
      RETURNING id`,
    [pageId, notionHash],
  );
  if (res.rows.length === 0) {
    throw new Error(
      `notion-sync: cannot record a decision against Notion page ${pageId} — it has no state ` +
      "row. A create proposer must ensure one exists before it proposes, or the decision has " +
      "nowhere to live and the proposal comes back on the next tick.",
    );
  }
}

/**
 * Binds a vault file to the Notion page it came from — the bookkeeping half of an
 * approved CREATE, and the hash refresh after a Notion-owned vault write (Phase 4).
 *
 * Keyed on `notion_page_id`, NOT on vault_path, and that is the whole point. A
 * create's identity is the PAGE: the path is what it is asking to bring into
 * existence. Two shapes reach it, and the conflict target is what makes both
 * correct with one statement:
 *
 *  - **A Notion-born page with no state row** (T6). Nothing conflicts, so this
 *    INSERTs a fresh `docs` row — byte-identical to what upsertDocSynced did for a
 *    create before this function existed, because the create branch's own guards
 *    already prove no row exists for either the path or the page.
 *  - **A transcript** (T4). The Meetings row for that page ALREADY EXISTS, with a
 *    NULL vault_path. An upsert keyed on vault_path would have tried to INSERT and
 *    violated `notion_page_id UNIQUE`, leaving a file on disk that no row points at
 *    — the split-brain the create branch's guards exist to prevent. Keyed on the
 *    page, it takes the UPDATE branch and simply fills in the vault_path the column
 *    comment reserved it for ("NULL until a vault file is linked").
 *
 * `writtenBodyHash` is what a MEETINGS row stores as its `md_hash` — see the CASE in
 * the statement, and MeetingStateRow.mdHash for why a transcript needs a different
 * hash there than a desk document does.
 *
 * `target`, `direction` and `state` are absent from the UPDATE branch on purpose. A
 * meetings row stays `target='meetings'` (so the desk passes never see the
 * transcript) and keeps whatever `state` the attendee pass gave it (that column is
 * that pass's verdict, not this one's); `direction` changes only through
 * setDocDirection, exactly as in upsertDocSynced.
 */
export async function linkPageToVaultFile(db: Queryable, doc: LinkedFileInput): Promise<void> {
  await db.query(
    // The CASE is what lets ONE statement serve both shapes without the engine
    // having to know which it is dealing with — and it cannot know: the create
    // branch's own guards prove there is no PATH-bearing row, and a Meetings row
    // awaiting its first vault file has a NULL vault_path, so it is absent from the
    // path-keyed snapshot either way. The STORE knows the target, so the store
    // picks. INSERT is always a fresh docs row and takes the render hash; the
    // UPDATE branch takes the written-body hash only when the row it landed on is a
    // meetings row (see MeetingStateRow.mdHash for why those are different hashes).
    `INSERT INTO notion_sync_docs
       (vault_path, notion_page_id, target, direction, md_hash, notion_hash,
        notion_last_edited, state, updated_at)
     VALUES ($1, $2, 'docs', $3, $4, $5, $6, 'synced', now())
     ON CONFLICT (notion_page_id) DO UPDATE
       SET vault_path = EXCLUDED.vault_path,
           md_hash = CASE WHEN notion_sync_docs.target = 'meetings'
                          THEN $7 ELSE EXCLUDED.md_hash END,
           notion_hash = EXCLUDED.notion_hash,
           notion_last_edited = COALESCE(EXCLUDED.notion_last_edited,
                                         notion_sync_docs.notion_last_edited),
           updated_at = now()`,
    [
      doc.vaultPath, doc.pageId, doc.direction ?? "md_to_notion",
      doc.mdHash, doc.notionHash, doc.notionLastEdited, doc.writtenBodyHash,
    ],
  );
}

/**
 * Commits a successful create/patch, per document (spec §2). Conflict target is
 * vault_path — the doc pass's identity — and notion_page_id follows EXCLUDED so
 * a row adopted or re-created under a different page keeps pointing at the page
 * Notion actually holds; a stale page id would send every later patch to a page
 * the engine no longer owns. Like recordMeetingSynced, success clears any
 * orphaned/error bookkeeping: the honest state of a row we just wrote is synced —
 * UNLESS the row is frozen (Phase 3, spec §6): a conflict freeze must survive
 * until an explicit `notion-sync resolve`, even though the write that lands right
 * after a freeze (a push that started before the freeze landed) still deserves a
 * fresh md_hash/notion_hash so the console reflects current content on both
 * sides. `direction` is NOT part of the UPDATE branch on purpose — see
 * DocSyncedInput.direction.
 *
 * `notion_last_edited` is COALESCEd, not assigned: a NULL from a caller means "I
 * took no reading", never "erase the reading you had". The push pass passes NULL
 * on every write (it never reads last_edited_time back), so a straight assignment
 * would blank the watermark of every file the vault edits — and the pull pass
 * skips rows with no watermark as unbaselined, so each row would go dark for good
 * after its first push. Keeping the older value costs one extra GET on the next
 * pull tick (the `>=` pre-filter re-reads, the hash matches the push's own
 * hash-after-write, the watermark then advances) — the designed price of letting
 * the content hash arbitrate rather than the clock.
 *
 * ⚠️ THE `DO UPDATE ... WHERE target = 'docs'` IS A SECURITY BOUNDARY, not tidiness
 * (Phase 4, review round 1 Critical). This statement's conflict target is
 * `vault_path`, which is UNIQUE across the WHOLE table — so without that predicate
 * a docs-pass write lands on whatever row holds the path, whatever database it came
 * from. A transcript's state row is a MEETINGS row with a vault_path, and the desk
 * push (which cannot SEE meetings rows, `getDocRows`) reads "no row" as "adopt it":
 * it created a second Notion page for a transcript and this UPDATE then repointed
 * the Meetings row at that new page, losing the real source page id from the only
 * row that tracks it. `target` is not in the SET list either, so the row stayed
 * 'meetings', stayed invisible, and the whole cycle repeated every tick.
 *
 * With the predicate the hijack updates zero rows, and the empty RETURNING is what
 * turns that into a LOUD failure rather than a silent one — the caller's
 * per-document containment records it and the tick reports unclean. It cannot fire
 * for any legitimate flow: every caller here is a docs-pass write against a docs
 * row, and the two writes that legitimately touch a meetings row go through
 * `linkPageToVaultFile` (keyed on the page) instead.
 */
export async function upsertDocSynced(db: Queryable, doc: DocSyncedInput): Promise<void> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO notion_sync_docs
       (vault_path, notion_page_id, target, direction, md_hash, notion_hash,
        notion_last_edited, state, updated_at)
     VALUES ($1, $2, 'docs', $3, $4, $5, $6, 'synced', now())
     ON CONFLICT (vault_path) DO UPDATE
       SET notion_page_id = EXCLUDED.notion_page_id,
           md_hash = EXCLUDED.md_hash,
           notion_hash = EXCLUDED.notion_hash,
           notion_last_edited = COALESCE(EXCLUDED.notion_last_edited,
                                         notion_sync_docs.notion_last_edited),
           state = CASE WHEN notion_sync_docs.state = 'frozen' THEN 'frozen' ELSE 'synced' END,
           frozen_reason = CASE WHEN notion_sync_docs.state = 'frozen'
                                THEN notion_sync_docs.frozen_reason ELSE NULL END,
           frozen_at = CASE WHEN notion_sync_docs.state = 'frozen'
                            THEN notion_sync_docs.frozen_at ELSE NULL END,
           error_count = 0,
           updated_at = now()
     WHERE notion_sync_docs.target = 'docs'
     RETURNING id`,
    [
      doc.vaultPath, doc.pageId, doc.direction ?? "md_to_notion",
      doc.mdHash, doc.notionHash, doc.notionLastEdited,
    ],
  );
  if (res.rows.length === 0) {
    throw new Error(
      `notion-sync: refusing to record ${doc.vaultPath} as a desk document — that vault path ` +
      "already belongs to a row of another target (a Meetings transcript is the only one that " +
      "exists today). Taking it over would repoint that row at the wrong Notion page. If the " +
      "desk push reached this, its scope is wrong: check the desk dir's `exclude` in config.",
    );
  }
}

/**
 * Records a failed write against an EXISTING doc row — same 3-strike escalation
 * as recordMeetingError, keyed by vault_path.
 *
 * Deliberately an UPDATE, not an upsert: notion_page_id is NOT NULL UNIQUE, so a
 * file that errors BEFORE its page is created has nothing valid to insert. The
 * decided resolution (Phase 2 plan, T3) is that pre-create errors are not
 * persisted at all — they count into the run summary, and the file naturally
 * retries next tick because a missing row means "create". A file that keeps
 * failing therefore surfaces every tick in the summary/journal rather than as a
 * state row. Hence: no row matched here is a no-op, not an error.
 *
 * Unlike the meeting variant there is no 'retrying' insert branch — a doc row
 * only exists after a successful write, so below three strikes it keeps the
 * state it already earned.
 */
export async function recordDocError(
  db: Queryable,
  vaultPath: string,
  message: string,
): Promise<void> {
  await db.query(
    `UPDATE notion_sync_docs
        SET error_count = error_count + 1,
            frozen_reason = $2,
            state = CASE WHEN error_count + 1 >= 3 THEN 'error' ELSE state END,
            updated_at = now()
      WHERE target = 'docs' AND vault_path = $1`,
    [vaultPath, message],
  );
}

/**
 * Freeze-and-flag for a vanished vault file (spec §7): the Notion row gets
 * Archived=true elsewhere; here the state row is flagged 'unmatched' with the
 * reason, never deleted. frozen_at keeps its first value across repeat flags so
 * it records when the file first went missing, mirroring recordMeetingUnmatched.
 */
export async function markDocOrphaned(
  db: Queryable,
  vaultPath: string,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE notion_sync_docs
        SET state = 'unmatched',
            frozen_reason = $2,
            frozen_at = COALESCE(frozen_at, now()),
            updated_at = now()
      WHERE target = 'docs' AND vault_path = $1`,
    [vaultPath, reason],
  );
}

/**
 * The two-way switch (Phase 3 plan decision 4): direction changes ONLY here,
 * through the explicit `enable-two-way` command (or a future demotion command) —
 * never as a side effect of a routine push or pull write, which is why
 * upsertDocSynced deliberately leaves direction out of its UPDATE branch.
 */
export async function setDocDirection(
  db: Queryable,
  vaultPath: string,
  direction: string,
): Promise<void> {
  await db.query(
    `UPDATE notion_sync_docs
        SET direction = $2, updated_at = now()
      WHERE target = 'docs' AND vault_path = $1`,
    [vaultPath, direction],
  );
}

/**
 * Freeze-and-flag for a two-way conflict (spec §6): both sides changed since the
 * last successful sync, so nothing is written to either side and the row is
 * flagged for a human `notion-sync resolve`. frozen_at keeps its first value
 * across repeat freezes (mirrors markDocOrphaned/recordMeetingUnmatched) so it
 * records when the conflict was first detected, not when it was last re-noticed —
 * the stale-freeze re-ping (7 days, §6) needs that original timestamp.
 */
export async function freezeDoc(
  db: Queryable,
  vaultPath: string,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE notion_sync_docs
        SET state = 'frozen',
            frozen_reason = $2,
            frozen_at = COALESCE(frozen_at, now()),
            updated_at = now()
      WHERE target = 'docs' AND vault_path = $1`,
    [vaultPath, reason],
  );
}

/**
 * Reverses freezeDoc once a human has resolved the conflict (`notion-sync resolve
 * <path> --keep md|notion`, spec §6). The row returns to 'synced' — the same
 * ordinary state a fresh sync leaves behind — so the next push/pull tick treats
 * it as any other row rather than as a still-frozen one. The caller is
 * responsible for actually writing the chosen side before calling this; unfreeze
 * itself only clears the flag.
 */
export async function unfreezeDoc(db: Queryable, vaultPath: string): Promise<void> {
  await db.query(
    `UPDATE notion_sync_docs
        SET state = 'synced',
            frozen_reason = NULL,
            frozen_at = NULL,
            updated_at = now()
      WHERE target = 'docs' AND vault_path = $1`,
    [vaultPath],
  );
}

/**
 * The pull pass's "nothing changed, but Notion re-saved" path (T5): the GET
 * /markdown hash already matches stored notion_hash, so there is no content to
 * react to — only the watermark needs to move so the next tick's `lastEditedTime
 * >= notion_last_edited` pre-filter does not re-fetch the same page forever.
 * Touches nothing else: not state, not md_hash, not error_count.
 *
 * Also the tool the apply pass uses to record a REJECTED Notion-owned edit (Phase
 * 4): nothing is written to either side, and only the watermark moves, so pull
 * stops re-proposing content a human already declined.
 *
 * NOT scoped to `target = 'docs'`, unlike its neighbours here, and the difference
 * is load-bearing rather than an oversight. `vault_path` is UNIQUE across the WHOLE
 * table, so the target predicate could never change WHICH row this matched — it
 * could only make the statement match NOTHING when the row happens to be a meetings
 * row. Before Phase 4 no meetings row had a vault_path, so the two forms were
 * indistinguishable; from T4 on, a transcript's state row IS its Meetings row, and
 * the docs-scoped form would silently update zero rows on the reject path — which
 * means the declined edit is re-proposed on the very next tick, and every tick after
 * that. The other UPDATEs here keep their target predicate because they say
 * something only a docs row can carry (a freeze, an orphan flag, an error count);
 * this one says "the content this row has accounted for", which is true of any row.
 */
export async function updateNotionWatermark(
  db: Queryable,
  vaultPath: string,
  notionHash: string,
  notionLastEdited: string | null,
): Promise<void> {
  await db.query(
    `UPDATE notion_sync_docs
        SET notion_hash = $2, notion_last_edited = $3, updated_at = now()
      WHERE vault_path = $1`,
    [vaultPath, notionHash, notionLastEdited],
  );
}

export async function countByState(db: Queryable): Promise<Record<DocState, number>> {
  const res = await db.query<{ state: DocState; n: string }>(
    `SELECT state, COUNT(*)::text AS n FROM notion_sync_docs GROUP BY state`,
  );
  const counts: Record<DocState, number> = {
    synced: 0, frozen: 0, error: 0, unmatched: 0, retrying: 0,
  };
  for (const row of res.rows) counts[row.state] = Number(row.n);
  return counts;
}

export async function setLastRunAt(db: Queryable, at: Date): Promise<void> {
  await db.query(
    `UPDATE notion_sync_run SET last_run_at = $1 WHERE id = TRUE`,
    [at.toISOString()],
  );
}

export async function getLastRunAt(db: Queryable): Promise<Date | null> {
  const res = await db.query<{ last_run_at: Date | null }>(
    `SELECT last_run_at FROM notion_sync_run WHERE id = TRUE`,
  );
  return res.rows[0]?.last_run_at ?? null;
}

/**
 * The proposal queue moved to @lares/agent-box (spec §20.1) so that the console's
 * Approve/Reject card and Saga's `notion` hand resolve proposals through ONE
 * implementation rather than two agreeing copies — agent-box is the package both
 * callers already depend on, and it already owns this table's schema (sql/016).
 * Re-exported here verbatim so every existing import path (the engine, cli.ts, the
 * console, the tests) is unchanged. `resolveProposal` is the guarded transition
 * every human-facing surface must use.
 */
export {
  insertProposal, getOpenProposals, setProposalState, getRejectedUnexecuted,
  markProposalReverted, resolveProposal,
  getUnannouncedProposals, markProposalAnnounced, getStaleProposals,
  // The ONE place a decision becomes a sentence (fix round 3/4) — re-exported so the
  // CLI states consequences in the same words as Saga, her hand and the console,
  // rather than becoming a seventh author of them.
  rejectOutcome, rejectConsequence, approveConsequence,
} from "@lares/agent-box/lib/notion-proposals.js";
export type {
  ProposalState, ProposalKind, ProposalInput, ProposalRow, ProposalAction, StaleProposalRow,
  RejectOutcome,
} from "@lares/agent-box/lib/notion-proposals.js";

export interface FrozenDocRow {
  vaultPath: string;
  reason: string | null;
  /** When the freeze was FIRST detected (freezeDoc keeps the first value). */
  frozenAt: Date;
}

/**
 * Every frozen doc row, for the stale-freeze re-ping (spec §6: a row frozen more
 * than 7 days gets pinged again, so a conflict cannot rot silently). Left as the
 * driver's `Date` — unlike getDeskRows's notion_last_edited there is no external
 * ISO string to compare against, only the engine's own clock (see the T3 report's
 * interface-shape note). Rows with a NULL frozen_at cannot be aged and are
 * excluded rather than treated as infinitely old.
 */
export async function getFrozenDocs(db: Queryable): Promise<FrozenDocRow[]> {
  const res = await db.query<{
    vault_path: string;
    frozen_reason: string | null;
    frozen_at: Date;
  }>(
    `SELECT vault_path, frozen_reason, frozen_at
       FROM notion_sync_docs
      WHERE target = 'docs' AND vault_path IS NOT NULL
        AND state = 'frozen' AND frozen_at IS NOT NULL
      ORDER BY vault_path`,
  );
  return res.rows.map((row) => ({
    vaultPath: row.vault_path,
    reason: row.frozen_reason,
    frozenAt: row.frozen_at,
  }));
}

export interface FidelityInput {
  vaultPath: string;
  passed: boolean;
  reason?: string;
}

/**
 * Records a fidelity-gate check batch (spec §4.5/§18.3: the precondition for
 * `enable-two-way`). "Replace" means by vault_path, one row per file — an
 * ON CONFLICT upsert in a single multi-row INSERT, not a table-wide wipe: this
 * function has no transaction to wrap a DELETE+INSERT in (Queryable is a bare
 * `.query()`, and a `pg.Pool` does not hold one connection across two separate
 * `.query()` calls, so BEGIN/COMMIT here would not actually be atomic). A re-check
 * simply overwrites each file's prior verdict, which is exactly what "replace"
 * means for a re-run of the same batch.
 */
export async function replaceFidelity(db: Queryable, rows: FidelityInput[]): Promise<void> {
  if (rows.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  rows.forEach((row, i) => {
    const base = i * 3;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, now())`);
    params.push(row.vaultPath, row.passed, row.reason ?? null);
  });
  await db.query(
    `INSERT INTO notion_sync_fidelity (vault_path, passed, reason, checked_at)
     VALUES ${values.join(", ")}
     ON CONFLICT (vault_path) DO UPDATE
       SET passed = EXCLUDED.passed,
           reason = EXCLUDED.reason,
           checked_at = EXCLUDED.checked_at`,
    params,
  );
}

/** The set of vault_paths currently eligible for `enable-two-way` (passed = TRUE). */
export async function getFidelityPassed(db: Queryable): Promise<Set<string>> {
  const res = await db.query<{ vault_path: string }>(
    `SELECT vault_path FROM notion_sync_fidelity WHERE passed = TRUE`,
  );
  return new Set(res.rows.map((row) => row.vault_path));
}
