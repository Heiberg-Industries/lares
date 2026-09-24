-- ORB-92 — bounded retry for transient email-triage failures. Before this, claimMessage's
-- seeded 'error' outcome (INSERT ... ON CONFLICT DO NOTHING) stood forever the moment ANY
-- failure hit after claim — a Gmail 503 on the read, a flaky triage call, anything. "already
-- claimed" and "permanently failed" were indistinguishable, so a transient hiccup silently
-- dropped a human email. attempts lets claimMessage re-claim a still-'error' row up to
-- MAX_ATTEMPTS times; the tick loop emits a spine signal when the final attempt also fails,
-- so a drop is loud, never silent.
ALTER TABLE email_triage_processed ADD COLUMN attempts integer NOT NULL DEFAULT 1;
