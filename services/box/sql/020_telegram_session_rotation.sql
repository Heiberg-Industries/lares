-- ORB-74 — Telegram private-chat session rotation.
--
-- eve's own continuation-token formula collapses a Telegram private chat to ONE session,
-- bounded only by the framework's 30-day default session timeout (no summary on release).
-- These two tables let eve-saga (services/chief-of-staff/lib/telegram-rotation.ts) rotate onto a
-- fresh session on every Oslo calendar-day boundary instead, carrying a short continuity
-- summary forward — see docs/runbooks/eve-saga.md "Telegram private-chat session anchoring".

CREATE TABLE telegram_daily_log (
  chat_id    text        NOT NULL,
  role       text        NOT NULL CHECK (role IN ('user','assistant')),
  body       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_daily_log_chat_idx ON telegram_daily_log (chat_id, created_at);

-- One row per chat: the Oslo day the LIVE session is currently anchored to, and a
-- carry-forward summary waiting to be injected into the next fresh session (set by a
-- rotation, consumed by the next inbound message).
CREATE TABLE telegram_session_rotation (
  chat_id         text        PRIMARY KEY,
  oslo_day        text        NOT NULL,
  pending_context text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
