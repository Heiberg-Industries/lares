-- 004_web_inbox.sql: the web chat door.
--
-- WHAT THIS IS. An agent can send its unprompted messages (briefs, reminders, proposals) to Slack,
-- Telegram or web chat. Slack and Telegram carry the message themselves. Web chat cannot be pushed
-- into, so the agent writes the message to this table and the console shows it: unread messages at
-- the top of web chat, a dot in the navigation, and a "Reply" button that opens a chat with the
-- message as its starting point.
--
--   web_inbox            one row per message. `read_at` NULL = unread. `context` is what a reply
--                        starts from when that should differ from the text the owner reads.
--   initiations.fallback_note
--                        set on the ledger row of a message that went to a different door than the
--                        owner asked for ("Morning brief went to web chat: Telegram is not
--                        connected"), so the console can say so.
--
-- SAFE TO RUN AGAIN. Only creates what is missing; no row is changed. The table holds message text
-- the agent wrote for its owner, the same kind of text a chat app would have held.

BEGIN;

CREATE TABLE IF NOT EXISTS web_inbox (
    id          BIGSERIAL PRIMARY KEY,
    owner       TEXT        NOT NULL CHECK (owner <> ''),
    agent       TEXT        NOT NULL CHECK (agent <> ''),
    kind        TEXT        NOT NULL,
    title       TEXT        NOT NULL,
    body        TEXT        NOT NULL,
    context     TEXT,
    item_key    TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at     TIMESTAMPTZ,
    UNIQUE (owner, agent, item_key)
);

CREATE INDEX IF NOT EXISTS web_inbox_unread_idx
    ON web_inbox (owner, agent, created_at DESC)
    WHERE read_at IS NULL;

ALTER TABLE initiations ADD COLUMN IF NOT EXISTS fallback_note TEXT;

COMMIT;
