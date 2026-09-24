-- 076_forget_ledger.sql — a record that the owner told the agent to forget something, so nothing
-- can bring it back (ADR-0017 rule 7: "a record of what was told to forget, checked on every
-- re-sync or re-import so a Notion pull or a Brain restore cannot silently resurrect a retired
-- fact").
--
-- MATCHABLE, NEVER READABLE. No column here holds the forgotten words, a normalised copy of
-- them, a vault path in the clear, or a subject line. Every row carries only `match_hash`: a
-- lowercase hex SHA-256 digest of `owner + " " + kind + " " + normalised`, where `normalised` is
-- computed in application code (packages/vault-format/src/forget-ledger.ts's `forgetKey`, fed by
-- `normaliseForgotten` for wording or a path-normaliser for a vault path) and never written to
-- disk. The honest limit,
-- stated plainly: someone who holds this database can test a SPECIFIC GUESS against a hash and
-- learn whether it matches; nobody can read what was forgotten FROM this table. And matching is
-- exact after normalisation — a paraphrase is a different key and will not be recognised.
--
-- APPEND-ONLY. Un-forgetting is not a row edit: the owner says the thing again, and `remember`
-- records a NEW fact whose id is not in this ledger. The ledger keeps its entry, because "you
-- asked me to forget this on the 4th" stays true.
--
-- ONE ENTRY PER (owner, kind, match_hash). Telling the agent twice to forget the same sentence is
-- one ledger fact, not two — a repeat insert is a no-op, not an error.
--
-- `reason` names what wrote the row: `forget`, the single-fact tool, or `erase-person`, the bulk
-- erase routine. It is a short CHECKed enum, never free text, and never a person's name.
--
-- NOT A GDPR ERASURE RECORD. This is a memory-hygiene ledger; erase-a-person
-- (services/box/bin/erase-person.ts) is a different thing and deletes this table's rows for the
-- person it erases, along with everything else.
--
-- `owner` IS NOT REWRITTEN BY 083, AND THAT IS DELIBERATE — DO NOT "FIX" IT LATER. Box 083
-- (083_owner_key_is_the_register_id.sql) moves every other free-text owner column onto the
-- identity register's canonical id (users.id, 014_identity.sql); this table is the one it skips.
-- `match_hash` is a one-way hash DERIVED FROM the owner string (packages/vault-format/src/
-- forget-ledger.ts's `forgetKey`), and the words that were forgotten are never stored anywhere
-- else — so there is no way to recompute an existing row's hash under a different owner spelling.
-- Rewriting this column would silently turn every row written under the old spelling into one
-- that matches nothing, ever again, with no error and no trace. W5I-s7 keys every NEW row on the
-- register's id (packages/vault-format/src/forget-ledger.ts's `assertCanonicalOwner`, called by
-- every writer and reader); an installation whose configured owner key later drifts from the
-- register is reported by chief-of-staff's `checkOwnerKeyAgreement` (W5I-s5b) before more rows
-- accumulate under the wrong one, but rows already written stay keyed on whatever spelling wrote
-- them.
--
-- Self-contained; hand-applied; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS forget_ledger (
  id           bigserial   PRIMARY KEY,
  owner        text        NOT NULL,
  kind         text        NOT NULL,
  match_hash   text        NOT NULL,
  forgotten_at timestamptz NOT NULL DEFAULT now(),
  reason       text        NOT NULL,
  CONSTRAINT forget_ledger_kind_check CHECK (kind IN ('fact', 'note', 'preference')),
  CONSTRAINT forget_ledger_reason_check CHECK (reason IN ('forget', 'erase-person')),
  CONSTRAINT forget_ledger_match_hash_check CHECK (match_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS forget_ledger_one_per_thing_idx
  ON forget_ledger (owner, kind, match_hash);

COMMIT;
