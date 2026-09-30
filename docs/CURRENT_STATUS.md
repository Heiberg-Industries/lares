# Current status

Last checked: 30 September 2026, against `main` at `ac23bcb`.

This page is the short, current answer to "where are we?". Update it whenever
something below changes. Older dated documents under `design/` and `runbooks/`
are records of what was observed on their date; where they disagree with this
page, this page is newer.

## Done and on `main`

- **The repository is public** (since 24 September 2026).
- **Fresh-install fixes.** Pull requests #5–#18 repaired the installer on a
  blank server: first owner, model choice, proxy, gateway readiness, Google
  sign-in, the keeper connection and the first-agent template.
- **The console revamp** (#32, merged 30 September): shared `@lares/ui`
  controls, real agent and connection data, agent avatars (database change
  `089_agent_avatars.sql`), guarded agent lifecycle actions, and web chat that
  survives a page reload.
- **Script 085 also moves the keeper's saved mailbox connection** (LAR-97,
  #36). The keeper's own settings file and three sign-in settings still change
  by hand in the same window; LAR-74 says which.
- **The dependency updates that run in production are in** (#37: `undici`,
  `brace-expansion`, `postcss`; and #25). GitHub still lists 18 warnings, all
  in test tooling (`vitest`, `@vitest/mocker`, `esbuild`, `uuid`) and none in
  an image that runs on a server. They are tracked in LAR-99.
- **Release candidate images are built and pinned** (30 September), all from
  `ac23bcb`: console, keeper, firewall helper, egress proxy, the three agent
  runtimes and sync-jobs. The sync-jobs package is private, so its fingerprint
  comes from the build's own record and a server needs registry sign-in to
  pull it.
- **The marketing website has left this repository.** It lives in a private
  repository; see [`website-repository.md`](website-repository.md).
- **The fresh-install test (LAR-50) is closed.** A blank Ubuntu install, first
  agent, model-backed chat, bounded Gmail and Calendar reads, an encrypted
  off-box backup and a restore drill were observed. The limits of that proof
  are in the [run ledger](runbooks/golden-path-runs.md): the restore and backup
  evidence spans two runs, and the first brief was accepted as a freshness
  heartbeat, not an observed delivered brief. The test server was removed.

## Not done

- **Nothing is deployed to production.** LAR-74 is the single deploy checklist.
- **No release is published.** A release candidate exists:
  [`releases/2026-09-30-rc.1.json`](../releases/2026-09-30-rc.1.json) pins the
  images built from one commit, `ac23bcb`. It has not been installed or
  rehearsed anywhere. The other files in `releases/` are test manifests.
- **A production rollout still needs** a migration and rollback plan (rolling
  back the schema after `089` has not been rehearsed) and a separate approval.
- **A strict docs-only install is unobserved.** The test install needed a
  model-key entry repair and resumed from saved answers.
- **Deferred in the console:** mobile layouts and the populated Preferences
  styling.
- **The test hostname's DNS record still points at the released test address**
  and must be repointed before reuse.

## Open housekeeping

- No pull requests are open. The automatic update pull requests #2, #23, #33
  and #34 were closed; #37 replaced the ones that mattered.
- The switch on the existing server has not been rehearsed (LAR-98).
- One installer test fails at random on GitHub (LAR-100).
- Several Linear tickets lag behind the merged work and need a status review.

## Where the detail lives

- [`runbooks/golden-path-runs.md`](runbooks/golden-path-runs.md) — what was
  observed on each install run
- [`design/console-release-readiness-2026-09-29.md`](design/console-release-readiness-2026-09-29.md)
  — the review of #32 before it merged
- [`design/console-lar50-handoff-2026-09-29.md`](design/console-lar50-handoff-2026-09-29.md)
  — the last session handoff before the merge
- [`../CHANGELOG.md`](../CHANGELOG.md) — what changed, for someone upgrading
