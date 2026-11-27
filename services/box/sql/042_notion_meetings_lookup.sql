-- 042_notion_meetings_lookup.sql: the console may ask the chief of staff to look up a meetings database.
--
-- WHAT THIS IS. clipping_requests is the queue the console uses to ask the chief of staff for work
-- only it can do, because only it holds the Notion key (the console cannot reach Notion). It already
-- takes four kinds: 'schema', 'test', 'import' and 'add-properties'. This adds one more,
-- 'meetings-database': the Meetings page sends a pasted Notion database link, the chief of staff reads
-- that database from Notion and answers with its data sources (ids and names), and the owner then
-- saves one of them as the meetings source, the same installation setting as before.
--
-- WHAT IT DOES NOT CHANGE. No row is touched and no column is added: a request's link, its answer
-- (names and ids only) and its outcome use the columns the table already has. The other checks
-- (status, outcome, detail length, requested_by) stay as they are. The grants are unchanged: the
-- table is already in the ordinary class (services/box/lib/database-privileges.ts).
--
-- SAFE TO RUN AGAIN. The check is dropped if it is there and added back with the five kinds.
BEGIN;
LOCK TABLE clipping_requests IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE clipping_requests DROP CONSTRAINT IF EXISTS clipping_requests_kind_check;
ALTER TABLE clipping_requests ADD CONSTRAINT clipping_requests_kind_check
  CHECK (kind IN ('schema', 'test', 'import', 'add-properties', 'meetings-database'));
COMMIT;
