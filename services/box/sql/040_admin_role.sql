-- 040_admin_role.sql: a person's role may also be 'admin'.
--
-- WHAT THIS IS. users.org_role already allows 'owner', 'member' and 'restricted'. This adds one
-- value, 'admin': a person the owner lets use the console's shared pages, short of the pages that
-- stay with the owner (members and roles, backups, the installation's general settings). What an
-- admin may open is decided in the console (services/console/lib/auth.ts), not here; this file only
-- lets the value be stored.
--
-- WHAT IT DOES NOT CHANGE. No row is touched: every existing person keeps the role they have. The
-- last-owner rule (guard_member_owner, 007) still holds, because it only ever asks whether a row is
-- an 'owner': an admin is not an owner, so making someone admin can never stand in for the last
-- active owner, and demoting the last active owner to admin is refused like any other demotion. The
-- triggers that end a person's open access when their role changes (009, 014) fire on any change of
-- org_role, so they cover a change to or from 'admin' as well.
--
-- SAFE TO RUN AGAIN. The check is dropped if it is there and added back with the four values.
BEGIN;
LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_org_role_check;
ALTER TABLE users ADD CONSTRAINT users_org_role_check
  CHECK (org_role IN ('owner', 'admin', 'member', 'restricted'));
COMMIT;
