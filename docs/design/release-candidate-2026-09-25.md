# Lares design release candidate — 25 September 2026

## Candidate and scope

`codex/design-release-review` is an isolated integration of marketing/docs PR #31
and console PR #32. It includes the agents/chat code already integrated by #32;
PR #29 and PR #20 remain drafts. Protected local main is unchanged.

The combination required a regenerated lockfile. Website Tailwind/PostCSS are
pinned to their already-tested 4.3.3 versions; console keeps 4.1.18. Shared tokens
merge cleanly. Do not resolve this merge by choosing one entire branch's lockfile.

Public application: marketing and curated docs at `lares.is`, served by a separate
unprivileged nginx container on the existing Orbis/Coolify server (port 8080).
The authenticated console stays part of the self-hosted Lares installation. A
hosted console is a separate deployment scope, not implied by the public website.

## Public launch sequence

Use `docs/marketing/analytics-and-launch.md` for settings, privacy event definitions,
probes and rollback. The cross-repository dependency is Orbis draft PR #13.

1. Review the merged candidate and passing exact-commit checks. Merge the desired
   public-site and Orbis changes; record source SHA and immutable image digest.
2. Deploy the Lares tenant entry in the existing consent service and verify the
   Lares initialization/CORS probe. Do not change other tenants.
3. Route `booking.lares.is` to the existing booking application and configure TLS.
   Run the Lares-only provisioning script in read-only mode, then create the draft
   brand/event. Review and activate **Lares walkthrough — 30 minutes**, using the
   existing Heiberg calendar. Do not alter the intro appointment.
4. Verify the booking origin/frame policy and popup. Build the website with the
   PostHog EU project token, booking enabled and indexing enabled for public launch.
5. Deploy the website container in Coolify with apex TLS and www-to-apex redirect.
   Apex/www A records already point at the server; recheck before rollout. Leave
   `lares.heiberg.co` DNS untouched.
6. Verify homepage, docs/search, redirects/404, sitemap/robots, consent refusal,
   consent withdrawal and real opted-in PostHog delivery. A real test booking
   sends an invitation and needs explicit authorization for its attendee/calendar.

Rollback the website and shared services to their recorded previous image digests;
return the Lares booking brand to draft if necessary. No new server is needed for
this public-site plan. The console is not exposed by the website container.

## Console release verification

- Build the console image without publishing first. Manual image workflow defaults
  to `publish=false`; publishing also requires the repository publication gate.
- Apply the normal migration runner, including `089_agent_avatars.sql`, after the
  normal verified backup. Confirm existing installations' migration ledger state.
- Verify authenticated create/edit/retire/delete, avatar upload/reset, and a
  provider-backed chat with the exact candidate on an explicitly scoped test box.
  The local design-review Keeper fixture refuses writes and cannot prove these.
- Follow LAR-50's full-install proof: Calendar/Gmail reads, first brief or freshness
  heartbeat, full backup/restore rehearsal and documented fresh install. Earlier
  partial proof was on the now-deleted throwaway server. Do not mark LAR-50 complete.

## Verification record

Console source passes 680 tests, typecheck and production build. Browser checks
cover the compact create wizard, separate review/submit actions, dirty close,
mobile dialog, navigation, Settings, chat and tool layouts. A synthetic database
round trip verified avatar persistence and cascade cleanup. Integration builds and
CI are recorded by exact candidate SHA in GitHub, not inferred from parent branches.

No deployment, live migration, calendar invitation, provider call or image
publication was performed during preparation. Full visual owner acceptance and
live release proof remain distinct from local/CI success.
