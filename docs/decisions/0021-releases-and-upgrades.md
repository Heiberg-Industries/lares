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
   a half. This decision commits to updating Lares's own copy of eve every
   month on a fixed date, instead of leaving it for a long time and facing one huge jump later.
6. Until the first public release, none of this applies: the project keeps changing everything at once, with no compatibility shims.
7. This replaces only the "how often" half of an earlier decision to pin eve tightly. Pinning
   each version and patching it by hand stays exactly as strict as before.

## Context

**The pin and the patch.** `package.json` declares `patchedDependencies: { "eve":
"patches/eve.patch" }`; `patches/eve.patch` is a unified diff entirely against minified
`dist/*.js` files (e.g. `dist/src/harness/attachment-staging.js`), which is why it must be
hand-re-derived on every eve bump rather than rebased. All role services pin the exact same eve
version.

**Migrations have no run-tracking.** `services/box/migrate.ts` is the whole mechanism: it reads every
`*.sql` file under `services/box/sql/`, sorts them by filename, and runs each one in order. There is
no table recording which files have already run and no refusal of an out-of-order file — the file
names themselves are the only ordering guarantee, and safety depends on every migration being
written to be safe to re-run. This is the seed for a real migration runner; this ADR does not build
that runner, it states the requirement the runner must eventually satisfy.

**Images are built in CI, not on a box.** Each role service and the console, keeper and sync jobs
have their own workflow, triggered on a push to `main` or a tag, building and pushing to the
project's container registry, tagged by git sha. Pinning by digest at deploy time is a downstream
discipline ("Images are built in CI, pulled by digest. The runtime image never runs `pnpm install`
or `eve build`."), not something the build workflow itself does.

**`CHANGELOG.md`** has an `Unreleased` section of individually tagged entries (`**fix**`,
`**feature**`, `**security**`, `**note**`) but no fixed "Backward-incompatible changes" block, and
no migration is named against any entry beyond a prose instruction.

**eve's cadence.** The research behind this decision found eve shipping a stable release roughly every
1.4 days, and the pinned 0.32.0 missing several safety fixes that landed since, all in eve's
approval/HITL path: sibling-approval auto-authorisation (fixed in 0.50.0), repeated
execution of an already-approved tool call across sequential approvals (0.47.4), approved calls
silently not executing (0.50.0), and pending approvals that could be made to simulate tool calls
and fabricate results as assistant text (0.45.2). CLI telemetry was added in **0.52.0**: every
`eve` command posts to `https://telemetry.vercel.com/api/eve-cli/v1/events` unless disabled; the
research records the disabling variable as `EVE_TELEMETRY_DISABLED=1`, **to be verified at upgrade
time** against whatever eve's docs say when the bump actually happens, not assumed from this
record. The restart-recovery problem ADR-0016 accepted as a standing cost (its F1) has a
name and a stalled fix: an upstream eve issue accepted as a p1 bug, with a draft fix that stayed
an unmerged draft for weeks.

## Decision

1. **Dated monthly releases**, on a fixed date, starting from the first public release. Not before: until that flip, the project keeps changing everything at once.
2. **Every release note carries a fixed "Backward-incompatible changes" block** — one entry per
   breaking change: what changed, what to do, the PR that made the change.
3. **Every breaking change ships with a migration that runs itself.** This requires the migration runner (replacing `services/box/migrate.ts`'s
   run-everything-every-time behaviour with one that records what ran and refuses out-of-order
   files) to exist before the first breaking-change release; building that runner is not this
   ADR's job, but this ADR is the reason it must exist by the first public release.
4. **Automatic backup before every update; one-command rollback to the previous image digests.**
5. **eve is bumped on a fixed monthly rhythm** — not waiting for the public flip.
   This is the part of ADR-0016 rule 2 this ADR supersedes: "bumped rarely" is replaced by
   "bumped monthly, on the calendar". The other half of that rule — pinned exactly, patched by
   hand, never tracked loosely — is unchanged and restated here.
6. **eve and `@workflow/world-postgres` move together, in the same change**, to the beta line
   eve's own `package.json` pins — never bumped independently.
7. **The local eve patch is sent upstream** where the change is small and objectively useful
   (candidates: the approval-prompt label hook, the Slack channel-id
   tracking fix, an undelivered-tap warning, the Telegram content-type preference, and the
   attachment mime allow-list). Until upstream accepts a hunk, it stays in `patches/eve.patch`
   and is re-derived, not rebased, at every bump.
8. **Until the public flip, this ADR's promises do not apply.** No migration shims, no
   deprecation window, no fixed monthly date binding on the repo before the first public release —
   the repo keeps changing everything at once. The one use of that freedom is the **migration baseline**: the numbered history of `services/box/sql` is replaced by a single file, `001_baseline.sql`, which creates the schema in one step. A fresh installation applies it;
   a database built by the earlier numbered history is refused with one message and is moved onto
   the baseline by `migrate --adopt-through 001_baseline.sql` once it is at that history's last
   state. Every later change is a new file numbered above 001.

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
- A predictable cadence prevents the gap this ADR was written to close: many weeks' worth of eve minors accumulating into one large, risky jump, with
  approval-safety fixes sitting unapplied the whole time.
- A monthly rhythm keeps each eve read to "about an hour of changelog" (the research's own estimate)
  instead of a full patch re-derivation against dozens of minors at once.

**Negative / accepted trade-offs:**
- The monthly eve bump becomes a standing, recurring cost whatever else is in flight — the research
  is explicit that a bump is not a quiet operation: sessions restart, pending approvals are
  abandoned, and the restart wrapper ADR-0016 relies on must be re-verified after every bump, not assumed to still work, because the 0.57.0 execution-model change altered which job is actually in flight.
- `patches/eve.patch` gets harder to carry, not easier, at this cadence: it targets minified
  `dist/` files that are rewritten by every minor, so each bump is a re-derivation of every hunk, not a rebase.
- The telemetry off-switch is a promise this ADR cannot fully keep in advance: the exact variable
  name is confirmed only at upgrade time, against whatever eve's docs say then, because it has
  already changed shape once in eve's own history (telemetry defaults reversed several times across releases).

## Open questions

- Whether `services/box/migrate.ts` needs to change before the *next* eve bump, or only before the first breaking-change release after the public flip — a sequencing decision, not this ADR.
- Whether the upstream restart fix is ever merged; until it is, every
  monthly bump must re-test the restart wrapper rather than assume the fix landed.
- The exact CalVer or date format for the monthly release name — a naming decision, not made
  here.

## Cross-references

- ADR-0016 (fleet runs on eve — rule 2 partially superseded here)
- Research on eve (cadence, missing safety fixes, telemetry, the stalled restart fix)
- `CHANGELOG.md`, `services/box/migrate.ts`, `patches/eve.patch`, `.github/workflows/`
