-- 029_cross_member.sql — cross-member standing grants + audit + per-member policy
-- (multi-user substrate, Phase 4; spec Parts 4 and 7). APPLIED BY HAND; idempotent.
--
-- Grants go TO THE ORG'S AGENTS, never to another person — hence no grantee column: its
-- absence is the rule, structurally. Revocation stamps revoked_at (never DELETE: "who could
-- read my calendar in March" must stay answerable). The known failure mode of standing
-- grants is that people forget them — the member's own brief surfaces active grants
-- periodically (wired when brief targeting goes per-member; see the second-user runbook).

BEGIN;

CREATE TABLE IF NOT EXISTS cross_member_grants (
  id              bigserial   PRIMARY KEY,
  grantor_user_id text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability      text        NOT NULL,          -- 'calendar' first; the fleet's capability names
  granted_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz                    -- NULL = standing
);
CREATE INDEX IF NOT EXISTS cross_member_grants_active_idx
  ON cross_member_grants (grantor_user_id, capability) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS cross_member_reads (
  id                   bigserial   PRIMARY KEY,
  grantor_user_id      text        NOT NULL,     -- whose data was read
  capability           text        NOT NULL,
  requested_by_user_id text        NOT NULL,     -- whose request triggered it
  agent                text        NOT NULL,     -- which agent performed it
  read_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cross_member_reads_grantor_idx
  ON cross_member_reads (grantor_user_id, read_at DESC);

CREATE TABLE IF NOT EXISTS org_member_policy (
  user_id              text    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  allowed_capabilities text[],                   -- NULL = unconstrained (the owner)
  may_create_agents    boolean NOT NULL DEFAULT true,
  spend_cap_usd_month  numeric                   -- NULL = no cap; enforced at the gateway
);


COMMIT;
