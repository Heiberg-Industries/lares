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

## Website repository split — 26 September

Marketing, curated public docs, booking UI, consent and PostHog now live in the
private `Heiberg-Industries/lares-website` repository. Its README and launch runbook
own public-site deployment. Lares PR #31 is superseded. PR #32 now contains console
work plus removal of the website from this repository; it is not a website release.
The public engine, console, installation and contributor documentation stay here.
The shared UI tokens/fonts remain here; the website vendors a versioned snapshot
with source hashes and original licences. Protected main and public Git history
are unchanged by preparation; removal takes effect only after this PR is merged.

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
