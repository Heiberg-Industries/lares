-- 078_telegram_day_handover.sql — the Telegram conversation that served a day is retired by id.
--
-- WHY THIS COLUMN EXISTS NOW. The rotation that gives this door one conversation per Oslo
-- calendar day (`services/chief-of-staff/lib/telegram-rotation.ts`; its two tables are created
-- in 020_telegram_session_rotation.sql) used to detach the live session from the chat's address
-- at the day boundary. The framework's replacement for that call is ADDITIVE — every address a
-- session has ever claimed keeps resolving to it — so renaming would leave yesterday's
-- conversation answering today's messages while this table claimed it had rotated. The only way
-- left to retire a conversation is to name its exact durable session id and reset it, which
-- means the id has to be written down while the conversation is still alive.
--
-- TWO COLUMNS, BOTH NULLABLE. `session_id` is the durable session that last answered in this
-- chat; `session_day` is the Oslo calendar day it answered on. Nullable because every row that
-- exists today predates them, and because clearing `session_id` is how one retirement is
-- claimed exactly once — two updates arriving together at the day boundary must retire one
-- conversation, not two, and must not lose a message racing for it.
--
-- NO INDEX. This table is read and written by its primary key (`chat_id`) only.
--
-- Self-contained; hand-applied; idempotent; one transaction.
BEGIN;

ALTER TABLE telegram_session_rotation
  ADD COLUMN IF NOT EXISTS session_id  text,
  ADD COLUMN IF NOT EXISTS session_day text;

COMMIT;
