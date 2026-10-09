# Current status

Last checked: 9 October 2026, end of day, against `main` after #105 (`e380090`).

This page is the short, current answer to "where are we?". Update it whenever
something below changes. Older dated documents under `design/` and `runbooks/`
are records of what was observed on their date; where they disagree with this
page, this page is newer.

## Done and on `main`

- **The 9 October merges are on `main`** (#97 to #105). The code changes (#97, #100,
  #101, #104, #105) are in no image yet (see Not done).
  - **Articles child 1a** (#105): article notes with a text companion file beside them,
    filed by the digest. Nothing is switched on: no article is filed until a later change
    turns it on.
  - **The console's Clipping card** (#104, LAR-113 child b): the console can now set up the
    Notion saved-link source, map its columns, test the mapping without importing, and
    run an import. Database changes `092_clipping_requests.sql`
    and `093_clipping_requests_heartbeat.sql`. The additions to the Notion live probe are
    written but not yet run. The two browser checks and the clipping key grant and revoke wait
    for the next deployed image.
  - **ADR-0010 amendment** (#103): Notion's Articles database is a place to capture articles
    and a mirror, not the owner of them; the Vault note stays the canonical copy.
  - **Pull request #106 is open, not merged:** review fixes for articles child 1a (safe
    rollback, scoped commits, a filed-link check).
  - **Release candidate rc.4 is published but not deployed** (#99, LAR-114). The manifest is
    [`releases/2026-10-09-rc.4.json`](../releases/2026-10-09-rc.4.json): the eight
    first-party images were built and published from `0e53c9d` (main after #95);
    the manifest pins the gateway at LiteLLM v1.101.6 and Caddy at 2.11.7, and the database
    image is unchanged. The scan and compatibility record is
    [`runbooks/release-scans/2026-10-09-rc.4.md`](runbooks/release-scans/2026-10-09-rc.4.md).
    Deployment waits on the real rehearsal of the switch (LAR-98) and the owner's go-ahead;
    LAR-74 is the checklist. Not verified: a real console sign-in through the new Caddy,
    the gateway's budget refusal and restore-key rotation, door webhooks, arm64, and any
    install, update, rollback or restore rehearsal.
  - **Notion saved-link import into the inbox** (#100, LAR-113 child a). Links saved into
    one Notion database come into the existing inbox at each digest pass and are read and
    filed like Karakeep links; saving a link twice never makes a second copy. Every failure
    is named in the digest and opens a repair entry; it never reads as a quiet "0 new".
    Database change `091_clipping.sql` (two new tables). The console controls came with #104
    (above).
  - **Notion's live API sends no completeness flag** (#101). The live probe, run by hand
    once on 9 October against Notion API version 2026-03-11, showed no `request_status` on
    queries. The reader already treats its absence as complete; the probe and the test
    fixture now match.
  - **The console shows the gateway and the models it serves, read-only** (#97, LAR-111
    slice 1). A Models section on Settings, filled by a keeper action: the gateway address,
    whether it is reachable, and for each purpose whether the gateway serves it and which
    agents use it. Each failure has its own plain wording. It never spends money and
    changes nothing. No database change.
  - **Roadmap and integration inventory, and the release-image remediation plan** (#98).
    Two planning documents, scrubbed for the public repository, linked from the end of
    this page.
- **The 8 October security and Notion-credential merges are on `main`** (#90 to #95); all
  are in the rc.4 images, which are not deployed.
  - **Browser mutation protection** (#90). The console rejects state-changing browser
    requests that do not carry the configured public Origin, before route handling.
    Signed webhook POSTs and OAuth GET callbacks keep their own paths, and normal
    same-origin approvals work. This closes a reproduced same-site cross-origin proposal
    approval. The browser reproduction ran in local development; deployed HTTPS and
    reverse-proxy acceptance, and private-member authorisation, remain separate. See
    [configuration and verification](solutions/2026-10-08-console-mutation-origin.md).
  - **Connections no longer shows a failed read as empty** (#91). When the account or
    audit reads fail, the page says the evidence is unavailable instead of showing no
    accounts or "no usage". Known configuration, enrolled mailboxes and agent grants stay
    visible, and raw storage errors are never shown.
  - **Managed Notion credential custody** (#92). A keeper-managed Notion credential slot,
    an installation administrator and durable operation state, so an interrupted write
    leaves the active key untouched. Database change `090_keeper_credentials.sql`
    (standalone). The slot stays unprepared until host storage and the full list of
    consumers are reviewed.
  - **Managed Notion credential lifecycle** (#93). Owners test and save a pending Notion
    internal-connection key in Connections, then separately Apply (restarts the affected
    agents, with rollback) or Disconnect locally (does not revoke the token at Notion).
    The live probe `services/keeper/tests/live/notion-credential.live.mts` was run by hand
    once: one success and one refusal of an invalid value. Rate-limit, timeout and
    malformed-response cases are tested against fixtures only.
  - **Smaller runtime images, with scan reports kept** (#94). Runtime images drop unused
    installers and build caches, the keeper pins its Docker client tools to 29.8.2, and the
    image workflows retain vulnerability scan reports for the built images, including
    build-only runs. No application code or lockfile changed. Unpatched base-package
    findings remain a release risk.
  - **Egress proxy refreshed and its policy checked in CI** (#95). The proxy moves to
    Alpine 3.24.2 with Squid 7.6-r0, which fixes an HTTP framing flaw in Squid 5.7. A
    CI-only probe exercises allowed and refused requests and an atomic configuration
    reload.
- **The repository is public** (since 24 September 2026).
- **The 8 October build queue is on `main`** (#84, #85, #86, #87): the nightly backup
  check, the freshness alarm and the restart helper report a database they cannot reach
  as a failed check naming the database, the role and the error (LAR-86); the keeper says
  which field in `keeper.json` is wrong, or that the file is missing or not JSON, without
  echoing values (LAR-89); the calendar-clash check buckets events by the owner's clock
  when travelling east (LAR-82). LAR-90 was found already fixed since #13 (the installer
  seeds a deny-all proxy config). Both the LAR-86 scripts and the keeper message are
  unseen on a server: the next deploy's by-hand check is on LAR-74.
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
- **Dependency sweep batches 1–13 done; only eve is left** (LAR-69): batch 1 removed `pg-boss` and
  atlas's unused `commander` (#62); batch 2 (#63) moved `tsx`, `yaml`, `pg`,
  `@types/pg`, `sharp`, `csv-parse` and the console's testing-library to their
  latest same-major versions, which clears the `esbuild` warning. Batch 3 (#64) put TypeScript 7.0.2 in every
  workspace but the console and `@types/node` 24 everywhere. Batch 4 (#65) moved
  `ai`, the `@ai-sdk` packages, `just-bash`, `mammoth`, `jszip` and the
  OpenTelemetry names library; the five hand-run live probes passed on 6 October
  (gateway lanes, gateway completion, key info, Langfuse), and the Anthropic one
  showed prompt caching working through the gateway (useful for LAR-85). Batch 5
  moved `next`, `react`, `radix-ui`, the Tailwind packages and `tailwind-merge`.
  Batch 6 (#67, #68, #69) moved `https-proxy-agent` 9, `commander` 15 and
  `lucide-react` 1. Batch 7 (#70) moved the readability and sync-jobs images to
  Node 24. Batch 8 (#72) moved `googleapis` to 183 and `googleapis-common` to 9;
  the workspace now holds one `google-auth-library` (11.1.0) instead of two.
  Batch 9 (#74) moved `better-sqlite3` to 13 in box and network and dropped
  chief-of-staff's unused direct dependency (it reads with `node:sqlite`).
  Batch 10 (#77) moved `undici` to 8 in five packages; Node's built-in fetch
  still picks up the Slack router (new probe
  `packages/agent-kit/tests/live/slack-dispatcher.live.mts`, passed from a
  laptop), and `telegram-fetch.ts` now asks for `proxyTunnel` because undici 8
  stopped tunnelling `http://` targets. Both `undici` overrides stay (eve pins
  8.9.0). Batch 11 (#78) moved `jsdom` to 30 and lifted the console's 26.1.0
  pin. Batch 12 (#79) moved `@testcontainers/postgresql` to 12. Batch 13 (#80)
  moved `vitest` to 5 and the console's `vite` to 8, and added a `sass` override
  (see the security line). Batch 14, `eve` 0.71, is its own track under
  ADR-0021.
  **On rc.4, on the server** (none of these can be proven
  before a server runs the build; branch image builds are not published):
  Langfuse traces through the egress proxy (6a); the five Google live probes in
  `services/chief-of-staff/tests/live/` (8); start the console, sync-jobs and
  chief-of-staff images once and open a database (9); `slack-dispatcher.live.mts`
  inside an agent container with `SLACK_PROXY_URL` set, `slack-user-tz.live.mts`
  and `telegram-approval-tap.live.mts` (10).
- **Security warnings are down to one** (7 October): `next` 16.3.6 (#49),
  `grpc-js`, `smol-toml`, `source-map-js` and `uuid` (#57, #58), and vitest
  4.1.11 in every package (#59, LAR-99). `braces` (high) cleared with batch 13:
  vite 8 alone did not remove it, because it came through `sass` 1.77.4, which
  pnpm installs for optional peers of `next` and `vite`; a `sass@<1.79.0`
  override lifts it to 1.105.1. Left: `sprintf-js` (medium, no fixed release;
  judged not reachable, see #58). The `esbuild` warning cleared with batch 2. rc.3's console predated
  the `next` fix; rc.4 rebuilt it.
- **The tests no longer fail at random on GitHub** (6 October): LAR-91 (#53),
  LAR-100 (#54), LAR-83 (#55, every database test file guarded, with a check
  that new files cannot forget) and LAR-81 (#56). The travel tests run on
  GitHub again; the cause was a `/proc` test path, see
  [`solutions/2026-10-06-a-test-path-under-proc-hung-linux-ci.md`](solutions/2026-10-06-a-test-path-under-proc-hung-linux-ci.md).
- **The dependency sweep has an agreed plan** (LAR-69, #60):
  [`specs/2026-10-06-dependency-sweep-plan.md`](specs/2026-10-06-dependency-sweep-plan.md).
  Bendik took all five recommendations on 6 October. A read-only check found
  no `pg-boss` tables on the production server, so batch 1 may delete it.
- **Superseded by rc.4:** release candidate images are built and pinned. The third candidate,
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

- **Nothing merged after #95 is in an image.** rc.4 was built from main after #95; of #96 to
  #105, only #97, #100, #101, #104 and #105 change code. The image workflows on `main` run with
  publication off.
- **The chief of staff's digest prompt named one installation.** It is being fixed in
  #108 (open); the engine must not carry any installation's name.
- **Remaining critical and high base-image findings in the first-party images (LAR-114).**
  rc.4 gives the scan evidence (the gateway and Caddy findings cleared; the keeper image, for
  example, still shows 2 critical and 62 high), and the remediation is still open.
- **The sync-jobs image's GitHub package is still private, so making it public is a
  prerequisite for installs.** Anonymous pulls of the rc.4 sync-jobs digest fail (403) until
  then; the other seven first-party images and the three third-party images pull anonymously.
- **The gateway status page (#97) has not met a real gateway.** Its live probe,
  `services/keeper/tests/live/litellm-gateway-status.live.mts`, is written but is not recorded
  as run, so the response shapes it reads are unverified. Run it by hand before trusting the
  Models section on an installation.
- **Nothing is deployed to production.** LAR-74 is the single deploy checklist.
- **No final release exists yet**, only release candidates. The newest release candidate is
  [`releases/2026-10-09-rc.4.json`](../releases/2026-10-09-rc.4.json), published but not
  installed or rehearsed anywhere. `2026-10-01-rc.3` is superseded and kept as a record.
  `2026-09-30-rc.1` and `2026-10-01-rc.2` are kept as records and should not be used: rc.1's
  keeper predates LAR-104, and rc.2's keeper and agent images predate LAR-105 and
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

1. **Make the sync-jobs package public**, then rehearse the switch (LAR-98) against rc.4.
   After that, articles 1b, after #106 merges: the digest wiring and the setting for which area articles go in.
2. **The injection test suite** (LAR-49): the plan on branch `lar-49-injection-suite`
   (`docs/plans/2026-10-08-lar-49-injection-suite.md`) splits it into three slices and
   needs the owner's yes on slice 1, which adds one standing sentence under every prompt
   block that carries outside text.
3. **Failures that look like success, the rest:** LAR-75 (three decisions in the ticket
   first).
4. **The AI bill:** LAR-85 (ask for prompt caching; the 6 October probe showed caching
   works through the gateway, so one of its three unknowns is answered), LAR-79, LAR-80.
5. **Owner decisions waiting:** LAR-65 (approvals that go silent), LAR-76 (one truth for
   secrets), whether the audit register's duplicate-code items (LAR-70 B and C) count as
   planned work. A note comparing Lares with a published "agent from scratch" recipe was
   written outside the repo for a planning session on a leaner shape and drop-in
   integrations (ADR-0019, LAR-46).

## Open housekeeping

- Open pull requests: #106 (review fixes for articles 1a) and #108 (digest prompt without
  installation names). The branch `lar-49-injection-suite` holds only the
  LAR-49 plan and waits for the owner's decision on slice 1.
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

Planning documents, not an approved delivery schedule: the [roadmap and integration inventory](specs/2026-10-08-roadmap-and-integration-inventory.md) and the [release-image remediation plan](specs/2026-10-08-release-image-remediation-plan.md).
