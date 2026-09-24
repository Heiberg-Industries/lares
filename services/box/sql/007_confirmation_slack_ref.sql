-- 007_confirmation_slack_ref.sql — durable confirmation↔Slack message link
-- Lets a reaction listener map a 👍 on a Slack message back to the confirmation
-- it proposed, even after the runner restarts.
ALTER TABLE confirmations ADD COLUMN slack_channel text;
ALTER TABLE confirmations ADD COLUMN slack_ts      text;

CREATE INDEX confirmations_slack_ref_idx
  ON confirmations (slack_channel, slack_ts)
  WHERE slack_ts IS NOT NULL;
