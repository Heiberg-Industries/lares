// services/box/lib/notion-proposals.ts
// The notion-sync proposal queue: the rows behind Bendik's 👍 on a Notion→vault edit.
//
// WHY IT LIVES HERE and not in notion-sync (where it was written, spec §18.4):
// two different surfaces now resolve a proposal — the console's Approve/Reject card
// (services/console/lib/notion-proposals.ts) and Saga's `notion` hand
// (services/agent-runtime/lib/adapters/hands/notion.ts, spec §19.2/§20) — and the
// binding constraint is that they are the SAME code, never two callers that happen
// to agree. A direct import between those packages is unavailable: notion-sync
// already imports agent-runtime (lib/adapters/calendar-source.ts → calendar-oauth),
// so the reverse edge would be a package cycle. @lares/agent-box is the package all
// three already depend on, and it already owns this table's schema
// (sql/015_notion_sync.sql, sql/016_notion_sync_phase3.sql) and the Queryable these
// are written against — so the shared code moves DOWN rather than sideways, and
// notion-sync keeps its vendor-neutrality/shareability intact.
//
// services/notion-sync/lib/store.ts re-exports the symbols notion-sync itself uses, so
// the engine, the CLI, the console and the existing tests keep their current import
// paths. It is a re-export list, not a mirror: `getRecentlyClosedProposals` is read only
// by Saga's morning brief (agent-runtime imports it from @lares/agent-box directly), and
// adding it there would be an export nothing in notion-sync calls.
//
// Vendor-neutral: takes a structural Queryable, never imports "pg".
import type { Queryable } from "./db.js";

export type ProposalState = "pending" | "approved" | "rejected" | "applied" | "superseded";

/**
 * What a proposal is asking for (migration 018, Phase 4 T3b).
 *
 * - `update` — the original and the default: a Notion edit to a page whose vault file
 *   already exists, waiting to be written into it.
 * - `create` — a Notion row or page with NO vault file yet, asking for one to be
 *   created (a Meetings transcript, T4; a Notion-born page, T6).
 *
 * One column rather than a second table because the two must share ONE approval path
 * (spec §18.4/§20: `resolveProposal`, Saga's DM, the console card). What differs is
 * what runApplySync does after the 👍, not how the human is asked.
 */
export type ProposalKind = "update" | "create";

export interface ProposalInput {
  vaultPath: string;
  notionPageId: string;
  /** Reverse-translated Obsidian markdown — body only, no frontmatter (spec §18.4). */
  proposedBody: string;
  /** Vault render-hash at propose time — runApplySync re-checks this to catch a stale approve. */
  baseMdHash: string;
  /** sha256 of the GET /markdown that produced this proposal. */
  notionHash: string;
  /**
   * Compact before/after preview (pull-sync.ts's diffPreview, or cli.ts
   * resolveFrozenDoc's own for a forced proposal), captured at propose time
   * and persisted — not re-derived later (T6 review, F2): the console has no
   * vault mount to diff against, so this column is the ONLY way its
   * Approve/Reject card can satisfy spec §18.4's "diff visible" contract.
   * Optional — "" default (016's column default) — so callers/tests that
   * don't care about the preview text don't have to supply one.
   */
  diffPreview?: string;
  /**
   * Optional, and 'update' when omitted (018's column default) — which is what keeps
   * every caller written before Phase 4 correct without being touched. A create must
   * say so explicitly.
   */
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
  /** NOT NULL in the table, so never undefined here — every SELECT must read it. */
  kind: ProposalKind;
  /**
   * Does NOTION own the document this proposal is about (`notion_sync_docs.direction
   * = 'notion_to_md'`)? Joined in, not stored: the proposals table has no direction
   * of its own and must not grow a copy of one that could go stale the moment
   * `enable-two-way` flips the row.
   *
   * A boolean rather than the raw `direction`, deliberately. Six human-facing
   * surfaces need to know this, and handing each of them a string means six
   * `=== "notion_to_md"` compares — the exact shape whose negation
   * (`!== "two_way"`) caused this phase's first Critical by silently widening to
   * cover a third value. The one place that turns a direction into a boolean is the
   * SELECT below; the one place that turns a boolean into a SENTENCE is
   * `rejectConsequence` / `approveConsequence`.
   *
   * FALSE for a create, because there is no row yet — and nothing depends on that,
   * because `rejectOutcome` settles `kind` first.
   */
  notionOwned: boolean;
  state: ProposalState;
  createdAt: Date;
}

// ── What a decision actually does (Phase 4, fix round 3) ──────────────────────────
// Approve and Reject do THREE different things, not two, and which one is not a
// property of the button — it is a property of the document.
//
//   create                  → approve creates the file; reject creates nothing, and
//                             nothing in Notion changes
//   update, Notion-owned    → approve writes the vault; reject leaves BOTH sides
//                             alone (the page is the source; the vault is its copy)
//   update, mirror/two-way  → approve writes the vault; reject ALSO reverts the
//                             Notion page from the vault — the one genuinely
//                             surprising consequence in the loop
//
// These live here, beside ProposalRow, because every surface that states a
// consequence — Saga's DM, her `notion` hand, the confirm card, the Telegram button
// reply, the console card — imports from this package, and because the alternative
// has now failed twice: each surface writing its own sentence produced six strings
// promising a Notion revert that the engine had stopped doing. A sentence written in
// one place can be wrong once and fixed once; six can be wrong in five places while
// looking fixed.

/** The three real outcomes of tapping Reject. */
export type RejectOutcome = "not-created" | "notion-untouched" | "notion-reverted";

/**
 * Which one applies. `kind` settles it first — a create has no "before" side on
 * either end, so the row's direction cannot matter to it.
 */
export function rejectOutcome(row: Pick<ProposalRow, "kind" | "notionOwned">): RejectOutcome {
  if (row.kind === "create") return "not-created";
  return row.notionOwned ? "notion-untouched" : "notion-reverted";
}

/**
 * The canonical sentence for what Reject will do. Exhaustive over RejectOutcome, so
 * a fourth outcome added later is a COMPILE error here rather than a surface quietly
 * falling through to the wrong string.
 */
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

/** The canonical sentence for what Approve will do. */
export function approveConsequence(row: Pick<ProposalRow, "kind" | "notionOwned">): string {
  return row.kind === "create"
    ? "the file is created in the vault on the next sync tick (within the hour)"
    : "the edit is written into the vault file on the next sync tick (within the hour)";
}

// ── The one column list, and the one row mapper ───────────────────────────────────
// Declared here, above every reader, rather than beside the announce ledger where
// they started: a SELECT that quietly omits a column leaves a field `undefined` at
// runtime while TypeScript believes it is present, and adding `kind` turned three
// hand-written column lists into three chances to make exactly that mistake. One
// list, one mapper, so a future column can only be forgotten in one place.

const PROPOSAL_COLUMNS = `p.id, p.vault_path, p.notion_page_id, p.proposed_body, p.base_md_hash,
            p.notion_hash, p.diff_preview, p.kind, p.state, p.created_at,
            (d.direction = 'notion_to_md') AS notion_owned`;

/**
 * The join every proposal read carries (fix round 3). `notion_sync_docs.vault_path`
 * is UNIQUE across the whole table, so joining on it can only ever match the one row
 * for this path — no ambiguity, no fan-out.
 *
 * NOT scoped to `target = 'docs'`, and that scoping was a real defect (Phase 4, T4).
 * Because vault_path is globally UNIQUE, the predicate could never change WHICH row
 * matched; all it could do is make the join MISS a meetings row. Before Phase 4 no
 * meetings row had a vault_path, so it never missed anything — but a transcript's
 * state row IS its Meetings row, so from T4 on the scoped join answered
 * `notionOwned: false` for a document Notion demonstrably owns, and
 * `rejectConsequence` then promised Bendik that rejecting a transcript edit would
 * "revert your Notion page back to it". The engine would have done no such thing
 * (apply branches on the ROW's direction, which is `notion_to_md`), so this was the
 * same defect as the six strings of round 3 and the seventh of round 4: a button
 * whose label lies about what the button does.
 *
 * LEFT, not inner: a CREATE proposal has no path-bearing row yet (that is its whole
 * premise), and an inner join would silently drop every create from every queue —
 * including the one Saga polls to announce them.
 *
 * A join rather than a `direction` column on the proposals table: direction is
 * mutable (`enable-two-way`), and a copy would be stale from the moment it was
 * flipped, which is precisely how a surface ends up confidently stating last week's
 * consequence. Also why no migration is needed — 018 is unchanged.
 */
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
  /** NULL when no docs row exists (a create) — read as "not Notion-owned". */
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

/**
 * Plain INSERT, not an upsert: `notion_sync_proposals_open` (016) is a partial
 * unique index on vault_path, so a second open proposal for the same file must be
 * superseded (setProposalState → 'superseded') BEFORE this runs, never replaced
 * by an ON CONFLICT here — the "never stack" rule (§18.4) belongs to the caller,
 * which needs to notify about the superseded one too. Returns the new row's id so
 * the caller can act on it (e.g. tests, or a future same-tick follow-up) without
 * an extra round-trip; BIGINT comes back as text from the driver, same as
 * countByState's COUNT(*).
 */
export async function insertProposal(db: Queryable, input: ProposalInput): Promise<number> {
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
  return Number(res.rows[0].id);
}

/** Everything still awaiting a human decision or an engine apply — the console/CLI listing. */
export async function getOpenProposals(db: Queryable): Promise<ProposalRow[]> {
  const res = await db.query<ProposalDbRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM ${PROPOSAL_JOIN}
      WHERE p.state IN ('pending', 'approved')
      ORDER BY p.created_at`,
  );
  return res.rows.map(toRow);
}

/**
 * Flips a proposal's state (CLI approve/reject, the engine's applied/superseded).
 *
 * resolved_at stamps on 'applied' and 'superseded' — states nothing further will
 * ever act on. It deliberately does NOT stamp 'approved' (still an open,
 * actionable state) and, from T5 on, no longer stamps 'rejected' either:
 * rejecting a proposal is a human decision that still owes the world a WRITE —
 * the Notion page has to be reverted from the vault (§18.4) — and that write is
 * runApplySync's job on the next tick, not the CLI's. So for a rejected row
 * resolved_at means "the revert has executed", and a NULL one is the engine's
 * work queue (getRejectedUnexecuted → markProposalReverted). Stamping it here
 * would make a rejection that never reverted indistinguishable from one that
 * did; leaving it NULL forever (no marker at all) would re-revert the same page
 * on every tick. Any other writer of state='rejected' — the console's POST
 * route (T6) included — must leave resolved_at NULL for the same reason.
 */
export async function setProposalState(
  db: Queryable,
  id: number,
  state: ProposalState,
): Promise<void> {
  await db.query(
    `UPDATE notion_sync_proposals
        SET state = $2,
            resolved_at = CASE WHEN $2 IN ('applied', 'superseded')
                               THEN now() ELSE resolved_at END
      WHERE id = $1`,
    [id, state],
  );
}

/**
 * The reject queue runApplySync drains: proposals a human rejected whose Notion
 * page has not been reverted from the vault yet (see setProposalState for why
 * resolved_at carries that meaning). Same column list and ordering as
 * getOpenProposals — the engine treats both lists identically apart from the
 * action it takes.
 */
export async function getRejectedUnexecuted(db: Queryable): Promise<ProposalRow[]> {
  const res = await db.query<ProposalDbRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM ${PROPOSAL_JOIN}
      WHERE p.state = 'rejected' AND p.resolved_at IS NULL
      ORDER BY p.created_at`,
  );
  return res.rows.map(toRow);
}

/**
 * Closes a rejected proposal once its Notion page has actually been reverted.
 * Guarded on `resolved_at IS NULL` so a re-run cannot move the timestamp — the
 * same "first value wins" posture as freezeDoc's frozen_at COALESCE — and on
 * state='rejected' so it can never quietly close a proposal in another state.
 */
export async function markProposalReverted(db: Queryable, id: number): Promise<void> {
  await db.query(
    `UPDATE notion_sync_proposals
        SET resolved_at = now()
      WHERE id = $1 AND state = 'rejected' AND resolved_at IS NULL`,
    [id],
  );
}

/**
 * Proposals that CLOSED in the last `hours` — Saga's morning brief reports what was
 * decided, and no longer re-lists what is waiting (the live DM is that surface).
 *
 * WHY THIS READER EXISTS: on 2026-08-06 the 08:00 brief told Bendik two proposals were
 * "still waiting on your decision"; both had been rejected the previous day, and the
 * pending list handed to the brief was empty. An empty block is dropped before the
 * prompt is built, so the section was ABSENT — and absent read as "no new information"
 * rather than "nothing", so the model refilled it from the conversation. Reporting the
 * closed side gives that part of the brief a fact to stand on instead of a silence.
 *
 * WHICH TIMESTAMP, AND WHAT IT COSTS. There is no `decided_at` column and deliberately
 * no migration to add one for a brief line, so this filters on `resolved_at`, whose
 * meaning is state-dependent (see setProposalState):
 *
 *   - `applied`   — the engine wrote the vault. Stamped, always. This is the only way
 *                   an APPROVE becomes visible here: 'approved' is still an open state
 *                   (the write is owed), so it carries no resolved_at at all. An
 *                   approval decided at 07:55 therefore misses the 08:00 brief and
 *                   lands in tomorrow's — the apply tick is hourly.
 *   - `rejected`  — "the revert has EXECUTED", not "Bendik decided". A rejection whose
 *                   Notion revert has not run yet has resolved_at NULL and is excluded
 *                   on purpose: it is still owed a write, and calling it closed would
 *                   report a revert that has not happened.
 *
 * So the honest label for what this returns is CLOSED, never "decided" — the caller
 * must not word it as the moment he tapped the button.
 *
 * 'superseded' IS EXCLUDED, AND THAT IS A REAL HOLE — not, as an earlier version of this
 * comment claimed, merely the exclusion of machine events. Two different things wear that
 * state, and only one of them is a machine event:
 *
 *   - Nobody decided: a newer proposal replaced an older open one.
 *   - HE DECIDED AND THE ENGINE COULD NOT EXECUTE IT. Three routes in
 *     services/notion-sync/lib/apply-sync.ts: a rejection whose Notion page changed before
 *     the revert ran (~:1062), `refuseCreate` (~:386), and a stale approval whose vault
 *     hash moved (~:826). All three stamp 'superseded'.
 *
 * The second group is a decision this block will NEVER report, on any day — not a delay, a
 * permanent silence. They are excluded anyway because the row cannot tell the two groups
 * apart: distinguishing them needs transition history the table does not keep, and there
 * is no column that says "a human moved this before the engine gave up". Reporting all
 * superseded rows would credit him with decisions he never made; reporting none loses a
 * few he did.
 *
 * WHAT COVERS IT: each of those three routes pings him at the time ("was NOT reverted —
 * the page changed after you rejected it", "refused: … was NOT created", the stale-approval
 * freeze), so the decision is not invisible — it is just invisible HERE. If that ping lane
 * is ever retired, this hole opens for real and this block needs transition history first.
 *
 * THE WINDOW IS A ROLLING `hours`, NOT A CALENDAR DAY, and that is the caller's whole
 * reason for asking: for a once-a-day brief a calendar-day window either double-reports
 * (if it runs to "now") or silently drops anything decided after midnight. The rolling
 * window's own cost: if two briefs are more than `hours` apart — a missed run, a box
 * down overnight — the decisions in the gap are never reported by any brief. Nothing
 * else reads this table for that purpose, so a gap is a permanent silence, not a delay.
 *
 * Same column list and join as every other reader (PROPOSAL_COLUMNS/PROPOSAL_JOIN), so
 * `kind` and the joined `notionOwned` come through here exactly as they do everywhere
 * else. Ordered by resolved_at rather than created_at: this list is read as a sequence
 * of decisions, and when they were PROPOSED is not the story it tells.
 */
export async function getRecentlyClosedProposals(
  db: Queryable,
  hours: number,
): Promise<ProposalRow[]> {
  const res = await db.query<ProposalDbRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM ${PROPOSAL_JOIN}
      WHERE p.state IN ('applied', 'rejected')
        AND p.resolved_at IS NOT NULL
        AND p.resolved_at >= now() - ($1 || ' hours')::interval
      ORDER BY p.resolved_at`,
    [String(hours)],
  );
  return res.rows.map(toRow);
}

export type ProposalAction = "approve" | "reject";

/**
 * THE guarded state transition — the single execution path behind every human
 * approve/reject, whatever surface it arrives on (console button, Saga's 👍 card,
 * `notion-sync approve|reject`). Promoted here from the console's
 * applyProposalAction so the second surface could not fork a copy of the guard.
 *
 * Re-checks that `id` is still open before flipping, rather than trusting the id
 * the caller sent: setProposalState itself has no state guard, and blindly
 * re-opening an already-applied/rejected/superseded proposal could collide with
 * the partial unique index (notion_sync_proposals_open) if a newer proposal for
 * the same path has since opened. Failing clearly here beats surfacing that as a
 * raw constraint violation. The guard matters MORE on the chat surface than it did
 * on the console: a model can hand back an id it read earlier in the conversation,
 * long after the engine resolved it.
 *
 * Approve and reject both only move the row. The engine (runApplySync) does the
 * actual work on its next tick — applying the edit under the note-lock after
 * re-checking base_md_hash, or reverting the Notion page from the vault. A
 * rejection deliberately leaves resolved_at NULL (see setProposalState): the
 * revert has not happened yet, and that NULL is the engine's work queue.
 */
export async function resolveProposal(
  db: Queryable,
  id: number,
  action: ProposalAction,
): Promise<ProposalRow> {
  // ONE guarded statement, not read-then-write. An earlier version read the open list,
  // checked the id, then called setProposalState — which is a TOCTOU race against the
  // engine's own apply pass, and the two are on a collision course by design (an hourly
  // tick and a human 👍). The losing interleaving is silent and bad:
  //
  //   1. #7 is 'approved'; the apply tick starts.
  //   2. Bendik 👍s a REJECT card; the read sees #7 still open.
  //   3. The engine writes the vault and sets #7 → 'applied' (+ resolved_at).
  //   4. The unguarded UPDATE lands: state → 'rejected', and setProposalState's CASE
  //      leaves the already-stamped resolved_at alone.
  //
  // The result is a 'rejected' row WITH resolved_at set, which getRejectedUnexecuted
  // (state='rejected' AND resolved_at IS NULL) will never pick up — so the Notion revert
  // he asked for never happens and nothing reports a failure.
  //
  // The state predicate in the WHERE closes it: once the engine has moved the row out of
  // ('pending','approved'), this updates zero rows and throws instead.
  //
  // resolved_at is deliberately not touched (see setProposalState): approving and
  // rejecting both still owe the world a write, and for a rejection that NULL is the
  // engine's work queue.
  //
  // The UPDATE sits in a CTE because RETURNING cannot join, and the caller needs the
  // joined `notion_owned` to say what it just did (fix round 3: every surface states
  // a consequence, and for a Notion-owned row that consequence is different). Still
  // ONE statement, so the guard above is untouched — a data-modifying CTE and the
  // SELECT that reads it execute in the same snapshot.
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

// ── The announce ledger (ORB-38 / spec §20.3, migration 017) ──────────────────────
// Saga polls for proposals she has not yet DM'd about, sends ONE turn covering them,
// then stamps each. Durable rather than in-process so a restart cannot re-announce.

/**
 * Proposals awaiting a human that nobody has told the human about yet — Saga's poll
 * queue. Deliberately 'pending' only, not 'approved': an approved proposal is already
 * decided and merely waiting for the engine's next tick, so announcing it would be
 * asking for a decision that has been made.
 */
export async function getUnannouncedProposals(db: Queryable): Promise<ProposalRow[]> {
  const res = await db.query<ProposalDbRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM ${PROPOSAL_JOIN}
      WHERE p.state = 'pending' AND p.announced_at IS NULL
      ORDER BY p.created_at`,
  );
  return res.rows.map(toRow);
}

/**
 * Marks a proposal as announced. Guarded on `announced_at IS NULL` — first stamp wins,
 * the same posture as freezeDoc's frozen_at and markProposalReverted — so a retry that
 * races itself cannot move the clock and quietly reset the staleness countdown (§20.4).
 *
 * The CALLER must only invoke this after the message actually went out. Stamping
 * optimistically would turn one failed send into a proposal that is never announced.
 */
export async function markProposalAnnounced(db: Queryable, id: number): Promise<void> {
  await db.query(
    `UPDATE notion_sync_proposals
        SET announced_at = now()
      WHERE id = $1 AND announced_at IS NULL`,
    [id],
  );
}

/** A stale proposal, plus whether anyone ever told the human about it. */
export interface StaleProposalRow extends ProposalRow {
  announcedAt: Date | null;
}

/**
 * Proposals still pending long after they should have been decided — what the spine now
 * escalates to #lares-alerts in place of the retired per-proposal ping (spec §20.4).
 *
 * TWO cases, and missing the second one is a silent-data-loss bug:
 *
 *  - **Announced, still pending** past `hours`: Saga asked and got no answer. He has not
 *    looked, or the DM did not really land.
 *  - **NEVER announced** past `unannouncedHours` (default 2×): nothing told him at all.
 *    An earlier version excluded these on the reasoning that un-announced is the poll's
 *    job — which is only true if the poll RUNS. It does not run when 017 has not been
 *    applied yet (guaranteed on the box until it is applied by hand), when the saga image
 *    predates the hand, when the proposals channel resolves empty, or when the door is
 *    down. Before ORB-38 every proposal pinged, so all of those were visible; excluding
 *    NULLs would have made the exact failure this escalation exists to catch invisible.
 *
 * The generous second threshold is what keeps this from firing on every proposal in the
 * ordinary window between propose and the next poll.
 *
 * A decided proposal (approved/rejected/applied/superseded) drops out via `state`.
 */
export async function getStaleProposals(
  db: Queryable,
  hours: number,
  unannouncedHours: number = hours * 2,
): Promise<StaleProposalRow[]> {
  const res = await db.query<ProposalDbRow & { announced_at: Date | null }>(
    `SELECT ${PROPOSAL_COLUMNS}, p.announced_at
       FROM ${PROPOSAL_JOIN}
      WHERE p.state = 'pending'
        AND ( (p.announced_at IS NOT NULL AND p.announced_at < now() - ($1 || ' hours')::interval)
           OR (p.announced_at IS NULL     AND p.created_at   < now() - ($2 || ' hours')::interval) )
      ORDER BY p.created_at`,
    [String(hours), String(unannouncedHours)],
  );
  return res.rows.map((row) => ({ ...toRow(row), announcedAt: row.announced_at }));
}
