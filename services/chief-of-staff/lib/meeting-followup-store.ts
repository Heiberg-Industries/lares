import { configuredOwnerId } from "./identity-client.js";
/**
 * The meeting follow-up send log (ORB-156) — services/box/sql/027_meeting_followup.sql.
 *
 * Four jobs in one table (spec Q3): exactly-once, the per-tick billed-call ceiling's counter,
 * the polling trigger's memory, and the audit trail. The trigger reads it INSTEAD of diffing
 * Notion property values across ticks, which is what makes the trigger edge-free: "no row for
 * this page" survives a missed tick, a restart, a backfill, and a meeting summarised while
 * the service was down.
 *
 * The claim/retry shape is email-triage-store.ts's, deliberately unchanged — see its header
 * for why a bare ON CONFLICT DO NOTHING silently drops work.
 */
import { createHash } from "node:crypto";
import type { Pool } from "pg";

/**
 * `"queued"` (ORB-156 fix round 2): a schedule turn dispatched successfully, but the card may
 * still be pending a human's 👍/👎 — `to(...).send()` resolves once the model's turn ends, not
 * once mail leaves. Only `meeting_followup_send`'s own `execute()` ever writes `"sent"`,
 * because only it runs at the moment a send is genuinely authorised (approved, or autonomous)
 * and only it knows `gmail.send` actually resolved. Recording `"sent"` from the schedule for a
 * turn that merely rendered a card made a declined or never-clicked card look permanently
 * done — no retry, no error, no signal — which is the exact silent-failure class this ticket
 * exists to end.
 *
 * `"denied"` (LAR-28): a human declined the approval card. Before this, a declined card left the
 * row exactly as `"queued"` — indistinguishable from one still awaiting an answer — and nothing
 * anywhere could tell the two apart, so a corrected Notion page had no way back in except a
 * hand-run UPDATE on the box. `"denied"` is written by `meeting_followup_record_denial`
 * (catalogue/), called from the resumed model turn once the decline is known (see that file's
 * header and `agent/schedules/meeting-followup.ts`'s `buildSendTurnPrompt`). Like `"queued"`, it
 * is never terminal: `claimMeeting` below re-claims it the moment the live summary block's hash
 * no longer matches the one stored at the last attempt.
 */
export type FollowupOutcome = "sent" | "queued" | "skipped" | "error" | "denied";

export const MAX_ATTEMPTS = 3;

/** Comfortably above the 5-minute tick, so an in-flight attempt is never mistaken for stale. */
const RETRY_ELIGIBLE_AFTER = "20 minutes";
const RETENTION = "180 days";

export interface ClaimResult {
  claimed: boolean;
  attempt: number;
  isFinalAttempt: boolean;
  /** LAR-28 — true only when this claim reclaimed a `denied`/`queued` row because the live
   *  summary hash no longer matched the one stored at its last attempt (never true for a
   *  brand-new page or an ordinary `'error'`-outcome retry). Optional so every existing test
   *  double that builds a `ClaimResult` literal without this field keeps compiling; the engine
   *  treats an absent value as `false`. Drives the tick's one-line log. */
  reclaimedAfterChange?: boolean;
}

/**
 * A stable identity for a recipient SET — sorted and lower-cased before hashing, so the
 * pause-and-ask rule fires on a genuine change of who receives the email and never on
 * Google returning the same people in a different order or a differently-capitalised address.
 */
export function fingerprintRecipients(recipients: readonly string[]): string {
  const normalised = [...new Set(recipients.map((r) => r.trim().toLowerCase()))]
    .filter((r) => r !== "")
    .sort();
  return createHash("sha256").update(normalised.join(",")).digest("hex");
}

/**
 * `summaryHash` (LAR-28) — the page's LIVE `<meeting-notes><summary>` block hash
 * (`lib/meeting-followup.ts`'s `hashSummaryBlock`), recorded on every attempt so a LATER tick can
 * tell "Bendik corrected the page" apart from "nothing has changed". REQUIRED, and refused if
 * `""` (LAR-28 review fix round 1): a caller that could not compute a real hash must not silently
 * store a placeholder — `""` stored today is indistinguishable from a real (if unlikely) empty
 * hash tomorrow, and would make a genuinely-unchanged page look "changed" the moment a caller
 * DID pass a real one. `hashSummaryBlock` itself never returns `""` (sha256 of even an empty
 * string is a full 64-character digest), so a real caller never trips this — only a caller
 * skipping the computation entirely would, and that must fail loudly, not store a landmine.
 *
 * Two reclaim paths now live in the one `WHERE`, both guarded the same way every write in this
 * file is — `'sent'` is never in either list, so a sent row is never re-claimed, ever, and
 * `attempts < $2` still caps both paths at the existing `MAX_ATTEMPTS`:
 *
 *   1. `outcome = 'error'` past the retry window — unchanged from before this ticket.
 *   2. `outcome IN ('denied', 'queued')` AND the STORED hash is neither NULL nor `''` AND it
 *      differs from the live one — the new rule this ticket adds. No time gate here on purpose:
 *      once Bendik has corrected the page, the very next five-minute tick should pick it up, not
 *      wait out `RETRY_ELIGIBLE_AFTER` the way a genuine failure does.
 *
 * THE NULL/EMPTY GUARD (LAR-28 review fix round 1, deploy hazard): every row that exists before
 * 048's migration lands has `summary_hash IS NULL` — the column is brand new. `NULL IS DISTINCT
 * FROM <anything>` is TRUE in Postgres, so without this guard the very first tick after deploy
 * would read that as "the page changed" for EVERY `queued` row inside the recency window and
 * re-compose/re-card every one of them — a burst of duplicate approval cards for meetings Bendik
 * already has a card for. A NULL/empty stored hash means "unknown", never "changed": such a row
 * is NOT reclaimed by this path. Instead (see the `adopt` step below) its `summary_hash` is set
 * to the current live hash WITHOUT claiming it, so it becomes a normal, comparable baseline —
 * only a REAL later edit reclaims it, on some later tick, exactly as ORB-156's original design
 * intended for a fresh page.
 *
 * Either reclaim path resets `outcome` to `'error'` on success — the same sentinel a brand-new
 * INSERT uses for "claimed, not yet decided" — so `releaseClaim`'s and `recordOutcome`'s existing
 * `outcome = 'error'` / `outcome <> 'sent'` guards need no changes at all to keep working
 * correctly for a reclaimed row.
 *
 * The `previous` CTE reads the row's outcome BEFORE this statement's own INSERT/UPDATE touches
 * it (a plain read against the pre-statement snapshot, safe even though it names the same table
 * the write below targets) — the only way to tell the caller "this was a hash-diff reclaim of a
 * denied/queued row" without a second round trip.
 */
export async function claimMeeting(
  db: Pool, notionPageId: string, summaryHash: string,
): Promise<ClaimResult> {
  if (summaryHash === "") {
    throw new Error(
      "claimMeeting: summaryHash must not be empty — pass hashSummaryBlock's real result, never " +
      "a placeholder (an empty stored hash would later look like a real, comparable value)",
    );
  }
  const { rows } = await db.query<{ attempts: number; previous_outcome: string | null }>(
    `WITH previous AS (SELECT outcome FROM meeting_followup_sent WHERE notion_page_id = $1)
     INSERT INTO meeting_followup_sent (notion_page_id, outcome, attempts, summary_hash, principal)
     VALUES ($1, 'error', 1, $3, $4)
     ON CONFLICT (notion_page_id) DO UPDATE
       SET outcome = 'error', attempts = meeting_followup_sent.attempts + 1,
           processed_at = now(), summary_hash = $3
       WHERE meeting_followup_sent.attempts < $2
         AND (
           (meeting_followup_sent.outcome = 'error'
             AND meeting_followup_sent.processed_at < now() - interval '${RETRY_ELIGIBLE_AFTER}')
           OR (meeting_followup_sent.outcome IN ('denied', 'queued')
             AND meeting_followup_sent.summary_hash IS NOT NULL
             AND meeting_followup_sent.summary_hash <> ''
             AND meeting_followup_sent.summary_hash IS DISTINCT FROM $3)
         )
     RETURNING attempts, (SELECT outcome FROM previous) AS previous_outcome`,
    [notionPageId, MAX_ATTEMPTS, summaryHash, configuredOwnerId()],
  );
  if (rows.length > 0) {
    const { attempts: attempt, previous_outcome } = rows[0]!;
    return {
      claimed: true,
      attempt,
      isFinalAttempt: attempt >= MAX_ATTEMPTS,
      reclaimedAfterChange: previous_outcome === "denied" || previous_outcome === "queued",
    };
  }

  // Not claimed — but LAR-28's own fix: a `denied`/`queued` row with an unknown (NULL/'')
  // fingerprint ADOPTS the live hash here, without claiming, so it stops being "unknown" from
  // the very next comparison on. Idempotent (guarded on the same NULL/'' condition, so a second
  // tick racing this one just writes the same value again) and scoped to exactly the two
  // non-terminal outcomes the hash-diff rule cares about — a 'sent'/'skipped' row, or a
  // still-in-window 'error' row, is never touched by this statement.
  await db.query(
    `UPDATE meeting_followup_sent
        SET summary_hash = $2
      WHERE notion_page_id = $1
        AND outcome IN ('denied', 'queued')
        AND (summary_hash IS NULL OR summary_hash = '')`,
    [notionPageId, summaryHash],
  );
  return { claimed: false, attempt: 0, isFinalAttempt: false };
}

/**
 * Records a human's decline (LAR-28 review fix round 1) — narrower than `recordOutcome`'s own
 * `outcome <> 'sent'` guard, and deliberately so: `meeting_followup_record_denial` (catalogue/)
 * is UNGATED and model-callable, so a confused or prompt-injected turn calling it against a
 * `'skipped'` (internal-only) or already-`'denied'` page must be a harmless no-op, not a way to
 * make that meeting re-readable and re-draftable after a later page edit. Only a row genuinely
 * `'queued'` (a card actually pending an answer) or the in-flight `'error'` sentinel
 * (`claimMeeting`'s own "claimed, not yet decided" state — the shape an instant, policy-level
 * denial resolves inside the SAME turn a `level: 'never'` verdict produces, before the schedule's
 * own post-send bookkeeping has had a chance to run) may become `'denied'`. Never creates a row —
 * a page with no claim at all was never sent a card to decline in the first place. Returns
 * whether a row actually changed, so the tool can report truthfully rather than always claiming
 * success.
 */
export async function recordDenial(db: Pool, notionPageId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE meeting_followup_sent SET outcome = 'denied'
      WHERE notion_page_id = $1 AND outcome IN ('queued', 'error')`,
    [notionPageId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The manual "check again" escape hatch (`meeting_followup_redraft`, LAR-28) — makes a page
 * reclaimable on the very next tick REGARDLESS of whether its summary hash has changed, which is
 * exactly what `claimMeeting`'s hash-diff path above deliberately does not do (that path exists
 * so an UNCHANGED page is never silently re-sent; this one exists because Bendik asking Saga to
 * "check again" is itself the human decision that a re-check is wanted, whether or not the page
 * has changed yet). Guarded on `outcome <> 'sent'`, the same terminal truth every write in this
 * file respects — a follow-up that has already gone out can never be undone by asking to check
 * again.
 *
 * `attempts` resets to 0 (a fresh budget for a fresh, deliberate request, not one more retry
 * against the old budget) and `processed_at` moves outside `RETRY_ELIGIBLE_AFTER` so the very
 * next tick's ordinary `'error'`-outcome path in `claimMeeting` picks the row up — no third
 * reclaim path is needed in `claimMeeting` for this.
 */
export async function resetClaimForRedraft(
  db: Pool, notionPageId: string,
): Promise<{ reset: boolean; alreadySent: boolean }> {
  const { rows } = await db.query<{ outcome: string }>(
    `UPDATE meeting_followup_sent
        SET outcome = 'error', attempts = 0,
            processed_at = now() - interval '${RETRY_ELIGIBLE_AFTER}' - interval '1 second'
      WHERE notion_page_id = $1 AND outcome <> 'sent'
      RETURNING outcome`,
    [notionPageId],
  );
  if (rows.length > 0) return { reset: true, alreadySent: false };
  // Either no row exists yet (nothing to reset — the page's ordinary trigger will claim it once
  // it is ready, same as any other page) or the row IS 'sent'. Only the caller needs to tell
  // those two apart (to say so), so one more cheap read settles which it was.
  const { rows: existing } = await db.query<{ outcome: string }>(
    `SELECT outcome FROM meeting_followup_sent WHERE notion_page_id = $1`,
    [notionPageId],
  );
  return { reset: false, alreadySent: existing[0]?.outcome === "sent" };
}

/** The series key recorded for a page (possibly `''` for a one-off), or `null` when no claim row
 *  exists yet. Read by `meeting_followup_redraft`'s approval gate, which reuses
 *  `meeting_followup_send.ts`'s own `followupApproval` keyed on this SAME series — the tool
 *  takes only `notionPageId`, so the series it must gate on has to come from here rather than
 *  from its own input. */
export async function seriesKeyFor(db: Pool, notionPageId: string): Promise<string | null> {
  const { rows } = await db.query<{ series_key: string }>(
    `SELECT series_key FROM meeting_followup_sent WHERE notion_page_id = $1`,
    [notionPageId],
  );
  return rows[0]?.series_key ?? null;
}

/** Records a derived key as soon as its first occurrence is claimed. This is intentionally
 * separate from `recordSent`: a declined approval card still establishes the standing series
 * for the next separately-booked meeting, without claiming that the first email was sent. */
export async function recordSeriesKey(db: Pool, notionPageId: string, seriesKey: string): Promise<void> {
  if (seriesKey === "") return;
  await db.query(
    "UPDATE meeting_followup_sent SET series_key = $2 WHERE notion_page_id = $1",
    [notionPageId, seriesKey],
  );
}

/**
 * Give back the attempt a claim just took, because nothing was attempted (ORB-193 fix round 1).
 *
 * The claim budget (`MAX_ATTEMPTS`) exists to stop a page that keeps FAILING from being retried
 * forever. A page the proactivity gate held back has not failed: the send turn never started and
 * nothing was said. (The COMPOSE call before the gate did bill — this lane composes first and gates
 * the send, which ADR-0014's open questions name as a known cost of ~30 billed calls per held item
 * per night. What a release gives back is the attempt, not the money.) Counting a hold as an attempt
 * is how a follow-up composed at 21:30 under the DEFAULT quiet hours (21:00–07:00) reached
 * `MAX_ATTEMPTS` before 22:30 and was dropped for good, hours before the gate would have let it
 * through.
 *
 * So: put `attempts` back and move `processed_at` outside the retry window, which together leave the
 * row exactly as `claimMeeting` found it — claimable on the very next tick, budget unspent. Guarded
 * on `outcome = 'error'` so it can never resurrect a row `meeting_followup_send` has recorded as
 * `'sent'`; `GREATEST(…, 0)` so a double release cannot drive the counter negative.
 *
 * The interval is the SAME constant `claimMeeting` compares against — a release that undershot it
 * would leave the row un-claimable until the window passed anyway, which is the bug in miniature.
 */
export async function releaseClaim(db: Pool, notionPageId: string): Promise<void> {
  await db.query(
    `UPDATE meeting_followup_sent
        SET attempts = GREATEST(attempts - 1, 0),
            processed_at = now() - interval '${RETRY_ELIGIBLE_AFTER}' - interval '1 second'
      WHERE notion_page_id = $1 AND outcome = 'error'`,
    [notionPageId],
  );
}

/**
 * `INSERT … ON CONFLICT DO UPDATE`, not a bare `UPDATE` (finding 2). `meeting_followup_send`
 * is reachable CONVERSATIONALLY, not only from the schedule: ask Saga directly to send a
 * follow-up and this runs with a `notionPageId` that has no claim row yet, because only the
 * schedule's `claimMeeting` ever INSERTs one. A bare `UPDATE` against a page with no row
 * touches zero rows and logs nothing — the poller then has no memory that this page was
 * already handled and claims it again on its next tick, sending the SAME follow-up to the
 * same externals a second time, and `lastRecipientsFingerprint` for that series stays null
 * forever, permanently disarming the "recipients changed → ask once" valve (spec Q3). Correct
 * whether or not a claim row already exists, for both the schedule path and the conversational
 * one.
 */
export async function recordSent(
  db: Pool, notionPageId: string, seriesKey: string, recipients: readonly string[],
): Promise<void> {
  await db.query(
    `INSERT INTO meeting_followup_sent
        (notion_page_id, outcome, series_key, recipients_fingerprint, recipients, processed_at, principal)
     VALUES ($1, 'sent', $2, $3, $4, now(), $5)
     ON CONFLICT (notion_page_id) DO UPDATE
       SET outcome = 'sent', series_key = $2,
           recipients_fingerprint = $3, recipients = $4, processed_at = now()`,
    [notionPageId, seriesKey, fingerprintRecipients(recipients), [...recipients].join(", "), configuredOwnerId()],
  );
}

/**
 * `AND outcome <> 'sent'` (ORB-156 fix round 3, CRITICAL): guarded in the STORE, not left to
 * every caller, because a caller getting this wrong is exactly what happened. On an
 * auto-approved send, `meeting_followup_send`'s `execute()` runs `recordSent` (writing `'sent'`
 * plus the recipients fingerprint) INSIDE the same turn the schedule's `to(...).send()` is
 * awaiting — so by the time that call resolves, the row is already `'sent'`. The schedule then
 * unconditionally called `recordOutcome(pageId, "queued")`, downgrading a genuinely sent row
 * back to non-terminal — which both erased the audit fact ("sent" and "a card nobody clicked"
 * became indistinguishable) and broke `lastRecipientsFingerprint` (which filters
 * `outcome = 'sent'`): a series switched to autonomous before its first logged send would
 * return null FOREVER, so the pause-and-ask guard — the one thing standing between an
 * autonomous series and mailing a stranger set Bendik never approved — would never fire.
 *
 * Once mail has actually left, no later bookkeeping may claim otherwise: `'sent'` is terminal
 * truth, and every other outcome here is a statement about an ATTEMPT, which a terminal truth
 * always outranks. Guarding here means a future caller cannot reintroduce this by getting its
 * own ordering wrong.
 */
export async function recordOutcome(
  db: Pool, notionPageId: string, outcome: FollowupOutcome,
): Promise<void> {
  await db.query(
    `UPDATE meeting_followup_sent SET outcome = $2 WHERE notion_page_id = $1 AND outcome <> 'sent'`,
    [notionPageId, outcome],
  );
}

/**
 * The recipient set of the most recent SUCCESSFUL send for this series, or null when there
 * has never been one.
 *
 * An empty `seriesKey` returns null rather than querying: `series_key = ''` is how a one-off
 * meeting is stored, and treating that as a series would pool every unrelated one-off into
 * one enormous shared history — every follow-up would then look like a recipient change.
 */
export async function lastRecipientsFingerprint(db: Pool, seriesKey: string): Promise<string | null> {
  if (seriesKey === "") return null;
  const { rows } = await db.query<{ recipients_fingerprint: string }>(
    `SELECT recipients_fingerprint FROM meeting_followup_sent
      WHERE series_key = $1 AND outcome = 'sent'
      ORDER BY processed_at DESC LIMIT 1`,
    [seriesKey],
  );
  return rows[0]?.recipients_fingerprint ?? null;
}

/**
 * Reads a row's current `outcome` back (finding 1) — the schedule's own read, not raw SQL in
 * the schedule file. `to(...).send()` resolving proves the model's TURN ended, never that mail
 * left: eve hands a thrown tool error (Gmail 5xx, an expired token, a blocked egress call)
 * back to the MODEL rather than rejecting that promise, so a failed autonomous send still
 * looks like a normal resolve to the caller. Only `outcome = 'sent'` — written solely by
 * `meeting_followup_send`'s own `execute()`, the one place that runs at the moment a send is
 * genuinely authorised and confirmed to have gone out — proves it. Returns null if no row
 * exists (should not happen once claimed, but defensive).
 */
export async function getOutcome(db: Pool, notionPageId: string): Promise<string | null> {
  const { rows } = await db.query<{ outcome: string }>(
    `SELECT outcome FROM meeting_followup_sent WHERE notion_page_id = $1`,
    [notionPageId],
  );
  return rows[0]?.outcome ?? null;
}

/** This table must not become the unbounded-growth problem it exists to prevent. */
export async function pruneOldFollowups(db: Pool): Promise<void> {
  await db.query(
    `DELETE FROM meeting_followup_sent WHERE processed_at < now() - interval '${RETENTION}'`,
  );
}
