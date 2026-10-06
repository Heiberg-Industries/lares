# Current status

Last checked: 6 October 2026, against `main` after #59 (vitest 4).

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
- **Dependency sweep batches 1–2 done** (LAR-69): batch 1 removed `pg-boss` and
  atlas's unused `commander` (#62); batch 2 (this PR) moved `tsx`, `yaml`, `pg`,
  `@types/pg`, `sharp`, `csv-parse` and the console's testing-library to their
  latest same-major versions, which clears the `esbuild` warning.
- **Security warnings are down to two** (6 October): `next` 16.3.6 (#49),
  `grpc-js`, `smol-toml`, `source-map-js` and `uuid` (#57, #58), and vitest
  4.1.11 in every package (#59, LAR-99). Left: `sprintf-js` (medium, no fixed
  release; judged not reachable, see #58) and `braces` (high, development
  only; clears with `vitest` 5 and `vite` 8 in batch 13). The `esbuild`
  warning cleared with batch 2. The console image in rc.3 predates
  the `next` fix, so the next candidate must rebuild the console too.
- **The tests no longer fail at random on GitHub** (6 October): LAR-91 (#53),
  LAR-100 (#54), LAR-83 (#55, every database test file guarded, with a check
  that new files cannot forget) and LAR-81 (#56). The travel tests run on
  GitHub again; the cause was a `/proc` test path, see
  [`solutions/2026-10-06-a-test-path-under-proc-hung-linux-ci.md`](solutions/2026-10-06-a-test-path-under-proc-hung-linux-ci.md).
- **The dependency sweep has an agreed plan** (LAR-69, #60):
  [`specs/2026-10-06-dependency-sweep-plan.md`](specs/2026-10-06-dependency-sweep-plan.md).
  Bendik took all five recommendations on 6 October. A read-only check found
  no `pg-boss` tables on the production server, so batch 1 may delete it.
- **Release candidate images are built and pinned.** The third candidate,
  [`releases/2026-10-01-rc.3.json`](../releases/2026-10-01-rc.3.json), replaces
  the keeper and the three agent runtimes: they were rebuilt on 1 October from
  `d95f358`, so they carry LAR-104, LAR-105 and LAR-106 (build run
  36894781507; each fingerprint was looked up in the registry and matches the
  build log, the keeper's files match `main`, and each agent image's compiled
  server contains both fixes). Everything else is unchanged from rc.1 and was
  built on 30 September from `ac23bcb`: console, firewall helper, egress proxy
  and sync-jobs. No code those images run changed since (the console carries
  the shared agent kit but does not use the two changed files). The sync-jobs
  package is private, so its fingerprint comes from the build's own record and
  a server needs registry sign-in to pull it.
- **The switch on the existing server has a written order** (LAR-98, #43):
  [`runbooks/keeper-managed-switch.md`](runbooks/keeper-managed-switch.md),
  from a local dry rehearsal with made-up data. Every step says whether it was
  seen or only read from the code, and what still needs the real rehearsal.
- **Converting the agents one at a time no longer stops them** (LAR-104, #44).
  The rehearsal found that while any agent still had an old-style definition,
  the keeper refused every other agent's save and stopped the agent it was
  saving. Now another agent's old capability opens no network hosts and blocks
  nothing, and an agent's own old capability is refused before anything is
  stored or stopped.
- **An agent with no usable definition no longer looks healthy** (LAR-105,
  #47). It stops before its health address opens, so the keeper reports it as
  not healthy, and the console says why in plain words. In rc.3.
- **An agent no longer runs on an outdated "last valid" definition** (LAR-106,
  #50). When its folder is unusable, the copy remembered in the database is
  re-checked by today's rules first. An old-style copy (`brain`, `atlas`,
  `memory`) is refused, and the agent stops as in LAR-105 instead of running
  without its note and fact tools. In rc.3.
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
- **No release is published.** The newest release candidate is
  [`releases/2026-10-01-rc.3.json`](../releases/2026-10-01-rc.3.json). It has
  not been installed or rehearsed anywhere. `2026-09-30-rc.1` and
  `2026-10-01-rc.2` are kept as records and should not be used: rc.1's keeper
  predates LAR-104, and rc.2's keeper and agent images predate LAR-105 and
  LAR-106. The other
  files in `releases/` are test manifests.
  Publishing the first release and the console's "update available" notice
  are tracked in LAR-101.
- **A production rollout still needs** a migration and rollback plan (rolling
  back the schema after `089` has not been rehearsed) and a separate approval.
- **A strict docs-only install is unobserved.** The test install needed a
  model-key entry repair and resumed from saved answers. Tracked in LAR-102.
- **Deferred in the console:** mobile layouts and the populated Preferences
  styling. Tracked in LAR-103, with the owner's sign-off on an installed
  console.
- **The test hostname's DNS record still points at the released test address**
  and must be repointed before reuse.

## Next

1. **The dependency sweep, batches 3–13** of the plan, in its order, one
   builder at a time, one pull request each. Batches 8–10 (`googleapis`,
   `better-sqlite3`, `undici`) are the risky ones and need the image runs and
   hand-run live probes the plan names. `eve` 0.71 is its own track afterwards.
2. **Failures that look like success:** LAR-86, LAR-89, LAR-75, LAR-90.
   LAR-86 and LAR-90 change what runs on the server, so they need a branch run
   of the image workflows first.
3. **The AI bill:** LAR-85 (ask for prompt caching), LAR-79, LAR-80. LAR-85
   needs a live probe against the provider.
4. Still waiting on the owner: the real rehearsal of the switch (LAR-98).

## Open housekeeping

- No pull requests are open.
- The real rehearsal of the switch, on a throwaway server with a copy of the
  real data, has not been done (LAR-98; needs the owner's go-ahead).
- The two engine faults from the dry rehearsal, LAR-105 and LAR-106, are
  fixed on `main` and in the rc.3 images. Only servers running rc.3 or later
  have them; on an older image, send one message to each agent after the
  switch, because health alone proves nothing there.
- The Linear board was reviewed against `main` on 30 September. "In Review"
  now means one thing: the code is on `main` and only a live check in LAR-74
  section 7 remains. Ten tickets are in that state (LAR-5, 16, 17, 22, 28, 54,
  59, 67, 73, 93). LAR-6, LAR-7 and LAR-10 were closed and their remainders
  moved to LAR-101, LAR-102 and LAR-103. Still in progress with work left:
  LAR-11 (the website, in its private repository), LAR-13, LAR-21, LAR-60 and
  LAR-72. The review read the code; it ran no tests and touched no server.

## Where the detail lives

- [`runbooks/golden-path-runs.md`](runbooks/golden-path-runs.md) — what was
  observed on each install run
- [`design/console-release-readiness-2026-09-29.md`](design/console-release-readiness-2026-09-29.md)
  — the review of #32 before it merged
- [`design/console-lar50-handoff-2026-09-29.md`](design/console-lar50-handoff-2026-09-29.md)
  — the last session handoff before the merge
- [`../CHANGELOG.md`](../CHANGELOG.md) — what changed, for someone upgrading
