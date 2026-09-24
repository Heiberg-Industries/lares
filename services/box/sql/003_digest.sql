-- 003_digest.sql — capture/digest pipeline (v1).
-- digest_requests: on-demand "process my inbox" triggers (consumed by the digest service).
CREATE TABLE digest_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent        text        NOT NULL,
  requested_by text        NOT NULL,                 -- principal id who asked
  door         text        NOT NULL,                 -- where to post the result ('slack')
  thread_ref   text        NOT NULL,                 -- thread/channel to reply in
  status       text        NOT NULL DEFAULT 'pending', -- pending|claimed
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT digest_requests_status_ck CHECK (status IN ('pending','claimed'))
);
CREATE INDEX digest_requests_pending_idx ON digest_requests (agent, status);

-- digest_skips: inbox items the digest left for Bendik to decide (so it never re-asks).
-- One row per (agent, path). Cleared when the item leaves _inbox (re-run notices it's gone).
CREATE TABLE digest_skips (
  agent      text        NOT NULL,
  path        text        NOT NULL,                  -- vault-relative path, e.g. _inbox/Foo.md
  reason      text        NOT NULL,                  -- why it was ambiguous (for the Slack ask)
  asked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent, path)
);
