# ADR 0021 — Dated monthly releases, a migration for every breaking change from the first public release, and eve bumped monthly

**Date:** 2026-09-18
**Status:** Accepted
**Supersedes:** ADR-0016, rule 2 — cadence only ("pinned, bumped rarely"). The rest of rule 2
("pinned and patched, never tracked loosely") is unchanged.
**Amends:** —

## In plain language

1. Once Lares is something a stranger can install, updates need to be predictable and safe, not
   "whatever changed this week".
2. This decision sets releases on a fixed monthly date, each one listing exactly what would break
   an existing installation and how to fix it.
3. Every breaking change ships with an automatic fix (a migration) that runs itself — an owner is
   never asked to hand-edit a database.
4. Before any update runs, the system backs itself up automatically; if the update goes wrong,
   one command puts the previous version back.
5. eve, the framework Lares is built on, changes very fast — a new version roughly every day and
   a half for the last five weeks. This decision commits to updating Lares's own copy of eve every
   month on a fixed date, instead of leaving it for a long time and facing one huge jump later.
6. Until the first public release, none of this applies: the project keeps changing everything at
   once, the way it does today, with no compatibility shims.
7. This replaces only the "how often" half of an earlier decision to pin eve tightly. Pinning
   each version and patching it by hand stays exactly as strict as before.

## Context

**The pin and the patch, today.** `package.json:17-19` declares `patchedDependencies: { "eve":
"patches/eve.patch" }`; `patches/eve.patch` is 100 lines of unified diff, entirely against
minified `dist/*.js` files (e.g. `dist/src/harness/attachment-staging.js`), which is why it must
be hand-re-derived on every eve bump rather than rebased. All three role services pin the exact
same version: `services/chief-of-staff/package.json:35`, and the same line in
`services/travel/package.json` and `services/creative/package.json`, all reading `"eve": "0.32.0"`.

**Migrations are hand-applied, with no run-tracking.** `services/box/migrate.ts` is the whole
mechanism: it reads every `*.sql` file under `services/box/sql/`, sorts them by filename, and
runs each one in order (lines 14-22). There is no table recording which files have already run
and no refusal of an out-of-order file — the file names themselves (currently up to
`049_backup_status.sql`, 49 files) are the only ordering guarantee, and safety depends on every
migration being written to be safe to re-run. This is exactly the "hand-applied SQL today" the
ruling names as the seed for a real migration runner; this ADR does not build that runner, it
states the requirement the runner must eventually satisfy.

**Images are built in CI, not on a box.** Each role service has its own workflow —
`.github/workflows/chief-of-staff-builder.yml` (and the sibling `travel-builder.yml`,
`creative-builder.yml`, `console-image.yml`, `keeper-runtime-images.yml`, `sync-jobs-image.yml`,
`runtime-base.yml`) — triggered on a push to `main` or a tag, building and pushing to the
project's GHCR registry, tagged by git sha (`chief-of-staff-builder.yml:1-27`). Pinning by digest
at deploy time is a downstream discipline
(root `CLAUDE.md`: "Images are built in CI, pulled by digest. The runtime image never runs `pnpm
install` or `eve build`."), not something the build workflow itself does.

**`CHANGELOG.md` today** has an `Unreleased` section of individually tagged entries
(`**fix**`, `**feature**`, `**security**`, `**note**`, each linking a Linear ticket) and one
dated line, `## v0.3.0-rc.1 — 2026-09-16` (`CHANGELOG.md:1-36`). There is no fixed
"Backward-incompatible changes" block anywhere in the file today, and no migration is named
against any entry beyond a prose instruction ("Apply `sql/048` before deploying...").

**Report 05's facts about eve's cadence** (read in full for this ADR; commit `7259b96`, dated
2026-09-18): eve shipped **66 stable releases in 38 days** — one minor roughly every 1.4 days —
and Lares's pinned 0.32.0 (published 2026-08-11) is missing several safety fixes that landed
since, all in eve's approval/HITL path: sibling-approval auto-authorisation (0.50.0), repeated
execution of an already-approved tool call across sequential approvals (0.47.4), approved calls
silently not executing (0.50.0), and pending approvals that could be made to simulate tool calls
and fabricate results as assistant text (0.45.2). CLI telemetry was added in **0.52.0**: every
`eve` command posts to `https://telemetry.vercel.com/api/eve-cli/v1/events` unless disabled; the
report records the disabling variable as `EVE_TELEMETRY_DISABLED=1`, **to be verified at upgrade
time** against whatever eve's docs say when the bump actually happens, not assumed from this
report. The restart-recovery problem ADR-0016 already accepted as a standing cost (its F1) has a
name and a stalled fix: eve issue #1981, filed 2026-08-12, accepted as a p1 bug with a draft fix
opened the same day (PR #1983) that was, as of report 05's reading, still an unmerged draft five
weeks later, untouched since it was opened.

## Decision

1. **Dated monthly releases**, on a fixed date, starting from the first public release. Not
   before: until that flip, the project keeps changing everything at once, exactly as today.
2. **Every release note carries a fixed "Backward-incompatible changes" block** — one entry per
   breaking change: what changed, what to do, the PR that made the change.
3. **Every breaking change ships with a migration that runs itself.** This requires the
   migration runner named in the pre-launch programme (replacing `services/box/migrate.ts`'s
   run-everything-every-time behaviour with one that records what ran and refuses out-of-order
   files) to exist before the first breaking-change release; building that runner is not this
   ADR's job, but this ADR is the reason it must exist by the first public release.
4. **Automatic backup before every update; one-command rollback to the previous image digests.**
5. **eve is bumped on a fixed monthly rhythm, starting now** — not waiting for the public flip.
   This is the part of ADR-0016 rule 2 this ADR supersedes: "bumped rarely" is replaced by
   "bumped monthly, on the calendar". The other half of that rule — pinned exactly, patched by
   hand, never tracked loosely — is unchanged and restated here.
6. **eve and `@workflow/world-postgres` move together, in the same change**, to the beta line
   eve's own `package.json` pins — never bumped independently.
7. **The local eve patch is sent upstream** where the change is small and objectively useful
   (report 05 names five candidates: the approval-prompt label hook, the Slack channel-id
   tracking fix, an undelivered-tap warning, the Telegram content-type preference, and the
   attachment mime allow-list). Until upstream accepts a hunk, it stays in `patches/eve.patch`
   and is re-derived, not rebased, at every bump.
8. **Until the public flip, this ADR's promises do not apply.** No migration shims, no
   deprecation window, no fixed monthly date binding on the repo before the first public release —
   the repo keeps changing everything at once, as it does today.

## Release checklist (operational rules)

- Do: back up before every update, automatically, with no separate owner action required.
- Do: write the fixed "Backward-incompatible changes" block before a release goes out, even when
  it is empty.
- Do: confirm a migration exists for every breaking change before the release is cut.
- Do: rehearse the rollback to the previous image digests before every release, not only when
  something goes wrong.
- Do: bump eve monthly with pending approvals drained beforehand — eve's 0.57.0 execution-model
  rewrite means every session restarts fresh on an eve bump, so this must happen at a quiet time,
  never mid-turn.
- Do: re-verify the exact telemetry-disable variable name and value against eve's own docs at the
  time of each bump — do not carry the name forward from memory or from this ADR.
- Don't: bump eve as a side effect of an unrelated change.
- Don't: promise the release cadence, or any migration guarantee, before the first public
  release.

## Consequences

**Positive:**
- A predictable cadence prevents the exact gap this ADR was written to close: five weeks' worth
  of eve minors (28 of them, per report 05) accumulating into one large, risky jump, with
  approval-safety fixes sitting unapplied the whole time.
- A monthly rhythm keeps each eve read to "about an hour of changelog" (report 05's own estimate)
  instead of a full patch re-derivation against 28 minors at once.

**Negative / accepted trade-offs:**
- The monthly eve bump becomes a standing, recurring cost whatever else is in flight — report 05
  is explicit that a bump is not a quiet operation: sessions restart, pending approvals are
  abandoned, and the 26-second restart wrapper ADR-0016 relies on must be re-verified after every
  bump, not assumed to still work, because 0.57.0 changed which job is actually in flight.
- `patches/eve.patch` gets harder to carry, not easier, at this cadence: it targets minified
  `dist/` files that are rewritten by every minor, so each bump is a re-derivation of all nine
  hunks, not a rebase.
- The telemetry off-switch is a promise this ADR cannot fully keep in advance: the exact variable
  name is confirmed only at upgrade time, against whatever eve's docs say then, because it has
  already changed shape once in eve's own history (report 05: telemetry defaults reversed several
  times across releases).

## Open questions

- Whether `services/box/migrate.ts` needs to change before the *next* eve bump, or only before
  the first breaking-change release after the public flip — a sequencing decision for the
  pre-launch programme's wave 3D and wave 2, not this ADR.
- Whether eve issue #1981 / PR #1983 (the restart fix) is ever merged upstream; until it is, every
  monthly bump must re-test the restart wrapper rather than assume the fix landed.
- The exact CalVer or date format for the monthly release name — a naming decision, not made
  here.

## Cross-references

- ADR-0016 (fleet runs on eve — rule 2 partially superseded here)
- Research report `05` (eve cadence, missing safety fixes, telemetry, the stalled restart fix)
- `CHANGELOG.md`, `services/box/migrate.ts`, `patches/eve.patch`, `.github/workflows/`
