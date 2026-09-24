-- 033_voice_card_per_mailbox.sql — a voice CARD per mailbox (ORB-176).
--
-- The rules were a singleton on the theory that one human has one voice (2026-08-18). The
-- register differs per mailbox: the live card, learned mostly from project.example sales mail
-- ("exclamation marks liberally, occasional emoji, sign-off with phone number and project.example"),
-- was being applied to owner.example mail to a journalist and to a partner CFO. voice_profile is
-- already keyed by `id`; a mailbox address is now a valid id. `default` keeps the shared learn
-- settings (learn_key, lookback, cap, relearn button) and is the FALLBACK card for a mailbox
-- whose own card is still empty. Examples (voice_exemplar) were already per mailbox (026).
--
-- The blended proposal on `default` (learned 2026-09-06 across both mailboxes, never applied)
-- is discarded: it is exactly the mixing this migration ends. Each mailbox re-learns its own
-- card at the next voice-learn run (or on Relearn from the console).
--
-- Apply by hand on the agent box (no auto-migrate):
--   docker compose exec -T db psql -U lares -d lares_state -f - < services/box/sql/033_voice_card_per_mailbox.sql
BEGIN;
INSERT INTO voice_profile (id)
SELECT DISTINCT mailbox FROM voice_exemplar WHERE mailbox NOT LIKE 'legacy:%'
ON CONFLICT (id) DO NOTHING;
UPDATE voice_profile SET proposed = NULL WHERE id = 'default';
COMMIT;
