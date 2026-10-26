-- Give the purpose-first router home-qualified track identities and its neutral schedule key.
-- The old names survive only as migration inputs; the runtime has one key and no compatibility alias.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_proposals' AND column_name='brand')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='route_proposals' AND column_name='track_id') THEN
    ALTER TABLE route_proposals RENAME COLUMN brand TO track_id;
  END IF;
END $$;

ALTER TABLE route_proposals ADD COLUMN IF NOT EXISTS home text NOT NULL DEFAULT 'twenty';
ALTER TABLE route_proposals ALTER COLUMN home DROP DEFAULT;
ALTER TABLE route_proposals ALTER COLUMN track_id SET NOT NULL;

INSERT INTO schedule_settings(owner,schedule,hours,updated_by,updated_at)
SELECT owner,'track-routing',hours,updated_by,updated_at FROM schedule_settings WHERE schedule='crm-routing'
ON CONFLICT(owner,schedule) DO NOTHING;
DELETE FROM schedule_settings WHERE schedule='crm-routing';

INSERT INTO heartbeat(agent,updated_at)
SELECT 'chief-of-staff/track-routing',updated_at FROM heartbeat WHERE agent='chief-of-staff/crm-routing'
ON CONFLICT(agent) DO NOTHING;
DELETE FROM heartbeat WHERE agent='chief-of-staff/crm-routing';
INSERT INTO heartbeat(agent,updated_at)
SELECT 'chief-of-staff/track-routing/tick',updated_at FROM heartbeat WHERE agent='chief-of-staff/crm-routing/tick'
ON CONFLICT(agent) DO NOTHING;
DELETE FROM heartbeat WHERE agent='chief-of-staff/crm-routing/tick';

COMMIT;
