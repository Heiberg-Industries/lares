-- 048_meeting_followup_denied.sql — LAR-28. A denied meeting-follow-up card was a dead end: no
-- `denied` outcome existed to tell a declined card apart from one still awaiting an answer, and
-- nothing recorded what summary text a draft was composed from, so a corrected Notion page could
-- never be told apart from an unchanged one. Hand-applied on the box; idempotent; one
-- transaction. Number 047 is reserved for other work — never reused.
BEGIN;

-- sha256 of the page's <meeting-notes><summary> block (lib/meeting-followup.ts's
-- `hashSummaryBlock`) AT THE TIME OF THIS ATTEMPT — never the `Summary` PROPERTY, and never a
-- diff of the `Status` property (the schedule's own module header explains why this feature does
-- not property-diff). `claimMeeting` (lib/meeting-followup-store.ts) compares this stored value
-- against the LIVE block's hash on a later tick to decide whether a `denied`/`queued` row may be
-- re-claimed.
--
-- NULL for every row that exists before this migration — deliberately treated by `claimMeeting`
-- as "fingerprint unknown", NEVER as "changed". A naive `IS DISTINCT FROM` comparison would read
-- NULL as different from any real hash (Postgres: `NULL IS DISTINCT FROM <hash>` is TRUE), which
-- would re-claim and re-card every still-`queued` row on the very first tick after this migration
-- lands — a burst of duplicate approval cards for meetings the owner already has a card for.
-- Instead, a NULL/empty stored hash is ADOPTED (set to the live hash, without claiming) the first
-- time `claimMeeting` sees it, so every pre-existing row becomes a normal, comparable baseline
-- exactly once — only a genuinely LATER edit reclaims it, on some tick after that.
ALTER TABLE meeting_followup_sent ADD COLUMN IF NOT EXISTS summary_hash text;

-- 'denied' joins the outcome vocabulary — a human declined the approval card, which the schedule
-- could previously not tell apart from a still-pending 'queued' card (both left the row exactly
-- as claimMeeting created it, forever). No CHECK constraint exists on `outcome` today — 027 never
-- added one; the column is plain `text NOT NULL`, documented only by its own comment — so there
-- is no constraint to drop and re-add here, only the comment to bring up to date.
COMMENT ON COLUMN meeting_followup_sent.outcome IS
  'sent | queued | skipped | error | denied — see lib/meeting-followup-store.ts FollowupOutcome. '
  'sent is the only terminal truth; denied/queued/error are all statements about an ATTEMPT.';

COMMIT;
