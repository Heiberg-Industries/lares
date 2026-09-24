-- 079_repairs.sql — one row per thing that is broken and can be fixed (ADR-0019 decision 9).
--
-- ONE ROW PER (kind, ref), NOT A LOG. A token that fails every five minutes must not make 288
-- rows a day: the first failure opens the row, every later one touches last_seen_at, and the
-- recovery sets resolved_at. Home Assistant's issue registry is the shape (research report 07
-- §2.3) and "log once when it goes down, once when it comes back" is its Silver rule.
--
-- WHY NOT the signals path. packages/agent-kit/src/signal-format.ts renders a message; it keeps
-- nothing, and nothing in this repository calls it. A message scrolls away. A repair is a thing
-- an owner comes back to, so it needs a row with an identity.
--
-- `what` AND `how_to_fix` ARE OWNER TEXT. Never a stack trace, never a vendor's error body,
-- never a token, never a path inside a container. The writer is responsible for that; this file
-- states it so a later reader does not "enrich" the column.
--
-- `breaks_in` IS THE HONEST PART: the release from which this stops working, or NULL. It is what
-- turns "something is wrong" into "you have until 0.5.0". Home Assistant uses the same field to
-- announce deprecations, which is its most common use.
--
-- `ref` is text and is not a foreign key: it holds a connection id, a capability name, a secret
-- file name or a schedule key, depending on `kind`. A constraint here would fail on a box that
-- has not started the service that would have written the row.
--
-- Self-contained; hand-applied; idempotent; one transaction.
BEGIN;

CREATE TABLE IF NOT EXISTS repairs (
  kind         text        NOT NULL,
  ref          text        NOT NULL,
  severity     text        NOT NULL,
  what         text        NOT NULL,
  how_to_fix   text,
  breaks_in    text,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  PRIMARY KEY (kind, ref),
  CONSTRAINT repairs_severity_check CHECK (severity IN ('info', 'warn', 'error')),
  CONSTRAINT repairs_what_not_empty CHECK (length(btrim(what)) > 0),
  -- A repair is a sentence about the INSTALLATION, never a place for a stack trace, a message
  -- body or a token. The schema cannot tell a secret from a sentence, but it can refuse anything
  -- long enough to be a dump; the store clamps to these limits before it writes.
  CONSTRAINT repairs_short_text CHECK (
    length(kind) <= 64 AND length(ref) <= 128 AND length(what) <= 400
    AND (how_to_fix IS NULL OR length(how_to_fix) <= 400)
    AND (breaks_in IS NULL OR length(breaks_in) <= 64)
  )
);

-- The page query: what is open, worst and freshest first.
CREATE INDEX IF NOT EXISTS repairs_open_idx
  ON repairs (severity, last_seen_at DESC) WHERE resolved_at IS NULL;

COMMIT;
