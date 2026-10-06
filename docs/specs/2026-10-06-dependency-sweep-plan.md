# The dependency sweep, every library to latest — plan

**Ticket:** LAR-69 (and LAR-99 for the test tooling). **Date:** 2026-10-06, against `main` at `15eac7f`.
**Status:** plan only — nothing has been upgraded. Step 2 of the ticket starts when the owner has agreed to this page.
**Method:** `pnpm outdated -r` and `pnpm audit` on a clean install; upstream release notes read for every major jump; our code searched for the APIs each jump touches; TypeScript 7 run (type-check only) against four workspaces.

## 1. In plain language

**Where we are.** The ticket was written on 18 September and is half out of date. Since then three things from its list are already done: eve moved to 0.60.1, the PDF-reading library `unpdf` is on 1.x, and `csv-parse` is on 7.x. Three agent services already use TypeScript 7. Today 44 libraries are behind: 17 are big version jumps, the other 27 are routine.

**What is actually risky.** Three jumps touch something your data or network traffic depends on, and get a PR each with a real-world check by hand:

1. **`undici` 7 to 8** (the network layer). Our Slack and Telegram traffic is steered through a home-made router that plugs into it, and version 8 changed how that plug-in point works. A mistake here does not show up as an error: Slack calls simply hang. Highest risk.
2. **`googleapis` 173 to 183** (Gmail, Calendar, Drive). Brings a new major version of Google's sign-in library underneath. One piece of our code reaches into its internals to set the proxy.
3. **`better-sqlite3` 11 to 13** (the local network-contacts database). It now ships a different kind of compiled file, so the three server images that contain it must be rebuilt and started once.

**What is a lot of work but low risk.** Moving the test tools (`vitest` 4 to 5, `vite` 6 to 8) touches 14 packages' tests but no code that runs on a server; it also clears the one "high" security warning GitHub shows.

**Two surprises worth knowing.**
- **`pg-boss` is dead code.** Nothing in the engine starts a job queue with it; only its own test does. Upgrading it (10 to 12) means work for nothing. Proposal: delete it instead. That needs your yes (section 6).
- **Some "latest" versions must wait.** `zod` 4.6 cannot go in until eve moves, because the workflow database library eve is paired with demands `zod` 4.5. `eve` itself (0.60 to 0.71) is a monthly job with its own rules (ADR-0021) and its own plan; it goes last.

**Proposed order (14 small PRs, one builder at a time, Sonnet is enough for most):**
1. Delete the unused queue library and an unused CLI dependency (S)
2. Routine bumps to test and build tools, clears the "esbuild" warning (S)
3. TypeScript and `@types/node` lined up on one version (S)
4. Routine bumps to the agent runtime libraries, including `ai` (M, review carefully)
5. Routine bumps to the console (`next`, `react`, `tailwind`) (S)
6. Three small major jumps, one PR each: `https-proxy-agent`, `commander`, `lucide-react` (S each)
7. Move the two images still on Node 22 up to Node 24 (M)
8. `googleapis` plus `googleapis-common` (M, risky)
9. `better-sqlite3` (M, risky)
10. `undici` (M to L, riskiest)
11. `jsdom` (S)
12. `@testcontainers/postgresql` (M)
13. `vitest` plus `vite` (L, mechanical)
14. `eve` 0.71 plus its paired workflow library (L, own design note first)

**Decisions needed from you:** (a) delete `pg-boss` instead of upgrading it; (b) `@types/node` at 24 (what the servers run) rather than 26; (c) move the readability and sync-jobs images to Node 24; (d) eve goes as its own track after this sweep, not inside it; (e) go on `vitest` 5 now, even though 4.1.11 only landed last week. Details in section 6.

## 2. What is out of date today

Source: `pnpm outdated -r --format json` and `pnpm audit --json`, 2026-10-06. "Runtime" means the package ends up inside an image that runs on a server; "dev" means tests, type-checking or build tooling only. "Image workflow" is the CI job that must be run on the branch (`gh workflow run "<name>" --ref <branch>`).

### 2.1 Major jumps

| Package | Now to latest | Declared in | Runtime or dev | Rating |
|---|---|---|---|---|
| `undici` | 7.29.1 to 8.11.2 (readability already on 8) | agent-kit, atlas, chief-of-staff, creative, travel | runtime | **risky** |
| `googleapis` | 173.0.0 to 183.0.0 | console, notion-sync, chief-of-staff, travel | runtime | **risky** |
| `googleapis-common` | 8.0.2 to 9.1.0 | agent-kit | runtime | moderate (with `googleapis`) |
| `better-sqlite3` (+ `@types/better-sqlite3` 7.6 to 9.6) | 11.10.0 to 13.0.3 | box, network, chief-of-staff | runtime | **risky** |
| `pg-boss` | 10.4.2 to 12.37.0 | box | runtime (unused) | delete, see 4.1 |
| `https-proxy-agent` | 7.0.6 to 9.1.0 | agent-kit, chief-of-staff, creative, travel | runtime | trivial |
| `commander` | 12.1.0 to 15.0.0 | atlas (unused), network, notion-sync | runtime (CLI) | trivial |
| `jsdom` (+ `@types/jsdom` 21 to 30) | 29.1.1 to 30.1.2; console tests pinned at 26.1.0 | readability; console (dev) | runtime (readability) | trivial |
| `lucide-react` | 0.468.0 to 1.52.0 | ui | runtime (console) | trivial |
| `@testcontainers/postgresql` | 10.28.0 to 12.2.0 | 8 packages | dev | moderate |
| `vitest` | 4.1.11 to 5.0.3 | 14 packages | dev | moderate (wide, not deep) |
| `vite` | 6.4.3 to 8.3.3 | console | dev (only vitest's engine) | moderate, rides with `vitest` |
| `typescript` | console 6.0.3, three services 7.0.2, rest 5.9.3 to 7.0.2 | all | dev | trivial for most, hold console, see 4.12 |
| `@types/node` | 22 / 24 / 26 mixed to 26.6.4 | all | dev | align on 24 |
| `eve` | 0.60.1 to 0.71.2 | agent-kit, board-evals, services | runtime | own track |
| `@workflow/world-postgres` | 5.0.0-beta.42 to 5.0.1 | chief-of-staff, creative, travel | runtime | moves with `eve` |

### 2.2 Routine bumps (same major, none of them blocked)

- **Agent runtime (runtime):** `ai` 7.0.106 to 7.0.128; `@ai-sdk/anthropic` 4.0.37 to 4.0.72; `@ai-sdk/openai-compatible` 3.0.53 to 3.0.63; `@opentelemetry/semantic-conventions` 1.39 to 1.43; `just-bash` 3.3.0 to 3.6.0; `mammoth` 1.12 to 1.13; `jszip` 3.10.1 to 3.10.2.
- **Console (runtime):** `next` 16.3.6 to 16.3.8; `react` and `react-dom` 19.2.7 to 19.3.0; `radix-ui` 1.4.3 to 1.7.0; `tailwind-merge` 3.3.1 to 3.7.0; `sharp` 0.35.4 to 0.35.5.
- **Console build and test (dev):** `tailwindcss` and `@tailwindcss/postcss` 4.1.18 to 4.3.3; `postcss` 8.5.23 to 8.5.29; `@testing-library/react` and `user-event`; `@types/react` and `@types/react-dom` 19.2 to 19.3.
- **Other dev:** `tsx` 4.21.0 to 4.23.15; `pg` and `@types/pg` 8.21/8.20 to 8.23; `yaml` 2.9.0 to 2.9.1; `csv-parse` 7.0.2 to 7.0.3.
- **Held on purpose:** `zod` 4.5.4 (latest 4.6.5), see section 5.

### 2.3 Security alerts (`pnpm audit`: 1 high, 2 moderate, 1 low)

| Alert | Comes in through | Does a routine bump fix it? |
|---|---|---|
| `braces` high | vitest, `@vitest/mocker`, vite 6, sass, chokidar (dev only) | Yes, once vite 8 lands (batch 13). Never ships in an image. |
| `esbuild` low | `tsx` 4.21 (esbuild 0.27) | Yes, `tsx` 4.23 uses esbuild 0.28 (batch 2). Vite 6's esbuild 0.25 (the older alert, #26) goes with batch 13. |
| `sprintf-js` moderate | `mammoth` to `argparse` 1.x | No. The newest `mammoth` still depends on `argparse` 1.x. Stays until upstream moves. Runtime in agent-kit, so worth checking whether we reach the vulnerable function. |

## 3. Facts that shape every batch

- **Node.** Images run Node 24, except `readability` and `sync-jobs` which are `node:22-bookworm` (`services/readability/Dockerfile:12,32`, `services/sync-jobs/Dockerfile:19,54`). CI runs 24. Minimums of the new majors: `undici` 8 needs 22.19, `jsdom` 30 needs 22.22.2, `testcontainers` 12 needs 22.22, `commander` 15 / `pg-boss` 12 / `better-sqlite3` 13 / `googleapis-common` 9 need 22. A floating `22` tag satisfies all of them today, but Node 22 reaches end of life in April 2027, so batch 7 moves both images to 24.
- **Which workflows build what.** `keeper and neutral runtime images` builds the three agent images, keeper, firewall helper and egress proxy. `console-image` builds the console. `sync-jobs-image` builds atlas, notion-sync, network and box (the box code lives in the sync-jobs and console images). Each agent also has its own builder workflow. There is no workflow for the readability image; it is built by hand, so its batches need a by-hand `docker build` and the live probe.
- **No batch here adds SQL.** The keeper image probe (`services/keeper/tests/runtime-image.probe.py`) only matters for `services/box/sql` migrations, so it is unaffected. The image workflows still trigger on any change under `packages/**`, `services/**` or the lockfile, so each runtime batch gets a manual run on the branch before merging.
- **The eve patch is untouched by this sweep.** `patches/eve.patch` still exists, targets `eve@0.60.1` (`package.json:pnpm.patchedDependencies`) and touches nine files (see `docs/specs/2026-09-18-eve-upgrade-design.md`). It pins eve, and eve pins `ai ^7.0.105`, `just-bash ^3.1.0`, `undici 8.9.0` and (through `@workflow/world-postgres`) `zod ~4.5.4`.
- **pnpm overrides to revisit as batches land** (root `package.json`): `undici@>=7.0.0 <7.29.1`, `undici@>=8.0.0 <8.10.2` (after batch 10), `testcontainers@10.28.0>undici` (after batch 12), `vite@<6.4.3` (after batch 13). Remove only what the new lockfile no longer needs.

## 4. Breaking changes per major jump

Ratings: **trivial** = nothing we use changed; **moderate** = something we use changed, fix is known; **risky** = failure would be silent or reach a user.

### 4.1 `pg-boss` 10 to 12 (box). Proposal: delete.

- **What we use.** `services/box/lib/boss.ts:4-9` builds `new PgBoss({ connectionString, schema: "pgboss" })` and calls `start()`. It is re-exported (`services/box/lib/index.ts:3`) and called only by its own test (`services/box/tests/boss.test.ts:25`). No `send`, `work`, `schedule` or `fetch` call exists anywhere in the repo. ADR-0016 (line 49) already says the fleet runs on eve, not pg-boss. The comment at `services/box/sql/001_init.sql:48` is the only other mention.
- **If we upgraded anyway.** v11: no automatic migration from v10, archive tables removed, many time options renamed, `insert()` signature changed. v12: no default export (`import PgBoss from "pg-boss"` at `boss.ts:4` must become `import { PgBoss }`), queue names limited to letters, digits, `-`, `_`, `.`. Schema is created fresh on first start, so an existing empty `pgboss` schema on a server would need dropping first. All of that is effort for a library with no caller.
- **Rating.** Delete: trivial. Upgrade: moderate. **Check before deleting:** whether any installation's database has jobs in the `pgboss` schema (read-only look on the server, owner's call). The repo has no code that could have put any there.

### 4.2 `googleapis` 173 to 183 and `googleapis-common` 8 to 9 (risky)

- **What changed.** `googleapis` 183 depends on `googleapis-common` ^9 which depends on `google-auth-library` ^11 (we have 10.x). That library's only listed breaking change is the Node 22 minimum. The Google API clients are regenerated each release; we use only three APIs (`google.gmail` 15 call sites, `google.calendar` 11, `google.drive` 2), which are stable.
- **Where it can bite.**
  - `packages/agent-kit/src/google-auth.ts:43` imports `OAuth2Client` from `googleapis-common` and the comment at `:256-266` says this works only because both packages resolve to one copy of `google-auth-library`. After the bump both packages must move together in every workspace, and `pnpm why google-auth-library` must show one major (two copies were already a hazard).
  - `google-auth.ts:231-236` sets `auth.transporter.defaults.proxy` by reaching into the auth library's internals. If that field moved, Google traffic would skip the egress proxy and be dropped by the firewall, again as a hang not an error.
  - `services/console/lib/account-oauth.ts` and `services/console/app/api/accounts/google/callback/route.ts` use the same auth objects for sign-in.
- **Test.** Unit tests, then by hand: `services/chief-of-staff/tests/live/google.live.mts`, `contact-history-gmail.live.mts`, `calendar-conflicts.live.mts`, `gmail-cancellation-search.live.mts`, `google-doc.live.mts`. Run them from a machine that goes through the egress proxy (the proxy path is what could break). Images: chief-of-staff and travel via `keeper and neutral runtime images`, console via `console-image`, sync-jobs via `sync-jobs-image`.

### 4.3 `better-sqlite3` 11 to 13 (risky)

- **What changed.** v12: newer bundled SQLite, Electron-only changes. v13: first version built on N-API (prebuilt binaries ship inside the package; the separate `prebuild-install` step is gone), new `db.explain()` and `statement.toString()`, cross-realm error fixes, Node 22 minimum. No removed API listed.
- **What we use.** Plain use: `new Database(path, { readonly, fileMustExist })`, `.prepare`, `.pragma`, `VACUUM INTO` (`services/network/lib/replica.ts:50-57`, `services/network/lib/db.ts:131-331`, `services/network/lib/snapshot.ts:26`, `services/box/lib/replica-verify.ts:20`). Nothing exotic.
- **Why it is still risky.** The compiled binary changes in three images (console, sync-jobs, chief-of-staff). The console Dockerfile comment (`:17-18`) records that `node:24-bookworm-slim` has no prebuilt binary and the build needs the full Debian image; v13's prebuilds may change that either way, and an image that builds but cannot load the file fails at first use. `services/chief-of-staff/lib/network-client.ts:53-54` documents a past incident with this library's destructor, which is why chief-of-staff uses `node:sqlite` at runtime; its dependency should be re-checked for removal rather than upgraded.
- **Test.** Unit tests (network, box); `services/network/tests/live/imessage-attributed-body.live.mts`; build the three images on the branch and start each once, opening a database (`docker run ... node -e "new (require('better-sqlite3'))(':memory:')"`).

### 4.4 `undici` 7 to 8 (riskiest)

- **What changed.** Removes legacy handler wrappers; isolates the global dispatcher ("global dispatcher v2" with a bridge for the old one); HTTP/2 on by default; removes support for fake Blob objects; Node 22.19 minimum. eve 0.60.1 already depends on undici 8.9.0, and the lockfile already holds 8.10.2, so one copy of 8 exists.
- **Where it can bite.**
  - `packages/agent-kit/src/slack-dispatcher.ts:19,47-60,78-87` defines a `Dispatcher` subclass whose `dispatch(options, handler)` forwards to a proxy or direct dispatcher, then installs it with `setGlobalDispatcher` so Node's built-in `fetch` uses it. The "legacy handler" and "global dispatcher" changes are exactly this plug-in point. If it stops being picked up, Slack calls bypass squid and hang against the firewall; no exception is thrown.
  - `packages/agent-kit/src/telegram-fetch.ts:22,49` (`ProxyAgent` plus undici's own `fetch`).
  - `services/travel/lib/telegram-photo.ts:19` (undici `FormData`; the Blob change could matter for photo upload).
  - `services/readability/lib/extract.ts:5,130-131,218-227,336-357` already runs undici 8 (pinned `Agent` for the SSRF guard), so that part is proven.
  - HTTP/2 by default changes connection behaviour towards any server that advertises it.
- **Test.** `packages/agent-kit/tests/slack-dispatcher.test.ts`, then by hand: `services/chief-of-staff/tests/live/slack-user-tz.live.mts` and `telegram-approval-tap.live.mts` through the real squid path. **Gap: no live probe exercises the Slack dispatcher through the proxy.** CLAUDE.md's rule applies, so this batch must first add `packages/agent-kit/tests/live/slack-dispatcher.live.mts` (install the dispatcher, fetch a Slack URL and a non-Slack URL, assert which dispatcher handled each) and name it in the PR. Images: all three agent images plus sync-jobs (atlas).

### 4.5 `https-proxy-agent` 7 to 9 (trivial)

v8: ESM only. v9: Node 20 minimum. v9.1 adds a proxy-auth callback. Our single use is `new HttpsProxyAgent(proxy)` (`packages/agent-kit/src/langfuse-otel.ts:3,96`, test `packages/agent-kit/tests/langfuse-otel.test.ts:6`); agent-kit is an ESM package. **Test:** the unit test, then `services/chief-of-staff/tests/live/langfuse-trace-content.live.mts` through the proxy (Langfuse ingestion is the only traffic using it).

### 4.6 `commander` 12 to 15 (trivial)

v13: extra command arguments become an error; unsupported option flags throw. v14: Node 20. v15: ESM only, Node 22.12, a lone `--no-x` option now defaults to true. We use only `new Command`, `.command`, `.option`, `.action` (`services/network/bin/program.ts:9`, `services/network/lib/cli.ts:83-259`, `services/notion-sync/lib/cli.ts`); all three packages are `"type": "module"`. The `--no-dry-run` in notion-sync is read from `process.argv` by hand (`services/notion-sync/bin/notion-sync.ts:144`), not declared in commander, so the v15 change does not reach it. The `commander` dependency in `services/atlas/package.json:20` is never imported; remove it in batch 1. **Test:** `services/notion-sync/tests/cli.test.ts`, plus run `network --help` and one command with an extra argument.

### 4.7 `jsdom` 29 to 30 (trivial)

Only breaking change: Node minimum `^22.22.2 || ^24.15.0`. Our single use is `new JSDOM(html, { url })` then Readability (`services/readability/lib/extract.ts:1,95`). Console tests also use jsdom 26.1.0 as a vitest environment (`services/console/package.json:35`); try unpinning that to 30 in the same PR (if a console test breaks on it, record why and keep the pin). **Test:** readability unit tests plus `services/readability/tests/live/readability.live.mts` (it names a jsdom bump as a reason to re-run). By-hand `docker build` of the readability image.

### 4.8 `lucide-react` 0.468 to 1.52 (trivial)

1.0 removes brand icons (see lucide's brand-logo statement). We import 22 icons (`packages/ui/src/icons.ts:1-24`) and `XIcon` (`packages/ui/src/primitives/dialog.tsx:5`), none a brand. Renamed or aliased icons are possible across 1,000 releases of icon changes; the type-check catches any missing name. **Test:** `pnpm -C packages/ui typecheck`, console tests, and one look at the console in a browser (the design preview).

### 4.9 `@testcontainers/postgresql` 10 to 12 (moderate, dev only)

v11 changes were not read separately; v12 breaking: Node 22.22 minimum, and the default wait strategy now uses the image's Docker health check when it has one (falling back to listening ports). 81 test files start `PostgreSqlContainer` (e.g. `services/box/tests/first-owner.test.ts:20`, images `postgres:16-alpine` and `pgvector/pgvector:pg16`). The official Postgres images define no health check, so behaviour should be unchanged, but 81 files is why it is moderate. **Test:** CI's full test job on the branch (CLAUDE.md: stores use testcontainers), not locally. Also drops the `testcontainers@10.28.0>undici` override.

### 4.10 `vitest` 4 to 5 and `vite` 6 to 8 (moderate, dev only, one PR)

- **vitest 5 breaking changes that plausibly touch us:** mocks are cleared before each test by default (33 test files use mock reset/clear helpers); hoisted `vi.mock` / `vi.hoisted` outside top level now throw (67 files use them); an un-awaited async assertion now fails the test; `sequential` options removed; config no longer looked up in parent directories (console has its own `services/console/vitest.config.ts`; others use defaults); default report folders move to `.vitest/` (check `.gitignore`); Node 22 and vite 6.4 minimum.
- **vite 8:** swaps esbuild and Rollup for Rolldown and Oxc. Our only vite use is as vitest's engine (`services/console/package.json:39`, `vitest.config.ts` has no vite-specific options), so the migration guide's build items do not apply. vitest 5 accepts vite 6.4, 7 or 8, so the two could be split; doing both together removes the `braces` and `esbuild 0.25` alerts.
- **Test:** the whole suite in CI, nothing by hand. One person-hour of fixing mock-clearing expectations is likely.

### 4.11 `eve` 0.60.1 to 0.71.2 with `@workflow/world-postgres` 5.0.1 (own track)

Governed by ADR-0021 (monthly bump, patch upstreamed where small) and the method in `docs/solutions/2026-09-19-eve-060-pairing.md`: re-derive the world-postgres pairing from the vendored `world-local` version, rebase the nine-file `patches/eve.patch`, drain approvals and run at night (open conversations restart). Not part of this sweep's PRs; write a short design note per ADR-0021, then run it last because it also frees `zod` 4.6 if the new pairing allows it. Probes: every agent live probe, plus the Slack and Telegram approval-card probes.

### 4.12 `typescript` and `@types/node` alignment (trivial, verified)

TypeScript 7.0.2 was run (type-check only, no emit, existing `tsconfig.json` files) against `services/box`, `network`, `readability`, `console`, `atlas`, `notion-sync` and `keeper`: **zero errors in all seven.** Chief-of-staff, creative and travel already pin 7.0.2. Plan: move every workspace, root included, to `7.0.2` exact (like the three that already have it) and `@types/node` to `24.x`. **Hold console at TypeScript 6.0.3 for now:** `next build` reads the TypeScript compiler through its JavaScript interface, which the native 7 package no longer exposes (not verified; confirm by running `console-image` on the branch with 7 before settling). `@types/node` 26 would describe APIs the Node 24 servers do not have, so 24 matches what runs (decision b).

## 5. Do not upgrade now

| Package | Why |
|---|---|
| `zod` 4.5.4 to 4.6.5 | `@workflow/world-postgres` 5.0.0-beta.42 and 5.0.1 both require `zod ~4.5.4`; eve runs through it. Moves with batch 14. |
| `eve` 0.71, `@workflow/world-postgres` 5.0.1 | Own track (4.11). Not a routine bump: it restarts open conversations and rebases our patch. |
| `@types/node` 26 | Servers run Node 24; the types would promise APIs that are not there. |
| `typescript` 7 in console | Likely blocked by `next build`; see 4.12. |
| `sprintf-js` alert via `mammoth` | No fixed version of `mammoth` exists. Re-check monthly. |
| `pg-boss` | Delete rather than upgrade (4.1), pending decision (a). |
| `@workflow/world-postgres` pin `beta.42` | It is a pin on purpose (the pairing note); `5.0.1` is not "newer" for us until eve moves. |

## 6. Order, effort and who builds it

Effort: S under an hour of builder time, M a session, L several. "Cheap" = a Sonnet builder with a checklist is enough. "Careful" = needs a review pass and your look at the result before merge. One PR each, one builder at a time (the machine rule), tests run in CI, not locally.

| # | PR | Effort | Who | Image workflow on the branch | By-hand probes |
|---|---|---|---|---|---|
| 1 | Delete `pg-boss` (`boss.ts`, its test, README lines) and the unused `commander` in atlas | S | cheap | `sync-jobs-image`, `console-image` | none |
| 2 | `tsx`, `yaml`, `pg`, `@types/pg`, `sharp`, `csv-parse`, testing-library | S | cheap | none (dev only) | none |
| 3 | TypeScript 7.0.2 (all but console) and `@types/node` 24 | S | cheap, check typecheck in CI | `chief-of-staff-builder`, `creative-builder`, `travel-builder` (already on 7) | none |
| 4 | `ai`, `@ai-sdk/*`, otel conventions, `just-bash`, `mammoth`, `jszip` | M | **careful** (`ai` is the model path) | `keeper and neutral runtime images`, `sync-jobs-image` | `agent-kit/tests/live/gateway-lane-*.live.mts`, `litellm-*.live.mts`, `box/tests/live/gateway-completion.live.mts`, `langfuse-trace-content.live.mts`. Fixtures exist for mammoth and jszip, no live call. |
| 5 | `next`, `react`, `react-dom`, `radix-ui`, `tailwind*`, `postcss`, `tailwind-merge`, `@types/react*` | S | cheap | `console-image` | open the console once (design preview) |
| 6a/b/c | `https-proxy-agent` 9; `commander` 15; `lucide-react` 1 (three PRs) | S each | cheap | 6a: `keeper and neutral runtime images`; 6b: `sync-jobs-image`; 6c: `console-image` | 6a: `langfuse-trace-content.live.mts`; 6c: look at the console |
| 7 | `node:22` to `node:24` for readability and sync-jobs images | M | cheap with review | `sync-jobs-image`; readability built by hand | `readability.live.mts` |
| 8 | `googleapis` 183 plus `googleapis-common` 9, all workspaces together | M | **careful** | `keeper and neutral runtime images`, `console-image`, `sync-jobs-image` | the five Google live probes (4.2), via the proxy |
| 9 | `better-sqlite3` 13 plus `@types/better-sqlite3` 9 | M | **careful** | `console-image`, `sync-jobs-image`, `chief-of-staff-builder` | `imessage-attributed-body.live.mts`; start each image once |
| 10 | `undici` 8 (all five declaring packages), drop its pnpm overrides | M to L | **careful, you look at it** | all three agent builders, `keeper and neutral runtime images`, `sync-jobs-image` | new `slack-dispatcher.live.mts` (written in this PR), `slack-user-tz.live.mts`, `telegram-approval-tap.live.mts` |
| 11 | `jsdom` 30 plus `@types/jsdom` 30; unpin console's 26.1.0 if it works | S | cheap | readability by hand | `readability.live.mts` |
| 12 | `@testcontainers/postgresql` 12; drop its undici override | M | cheap, watch CI | none (dev only) | none, full CI run |
| 13 | `vitest` 5 plus `vite` 8; drop `vite@<6.4.3` override | L | cheap builder, fix-ups reviewed | none (dev only) | none, full CI run |
| 14 | `eve` 0.71.2 plus `@workflow/world-postgres` 5.0.1 plus `zod` 4.6 if allowed | L | **careful**, design note first | all agent builders, `keeper and neutral runtime images` | every agent live probe, night-time upgrade per ADR-0021 |

Order reasoning: 1 to 3 shrink the surface for free and clear the `esbuild` alert. 4 to 6 are same-major bumps on code that runs on servers. 7 is a prerequisite for 10 to 12 on the Node 22 images. 8, 9 and 10 are the three risky runtime jumps, one at a time with the image run and the probes between them, so a regression has exactly one suspect. 11 to 13 are dev or low-risk and could be done at any point after 7; 13 is last of the test tools because it is the widest. 14 goes last because it moves the most and is on its own schedule.

### Decisions I need from you

- **(a) `pg-boss`: delete or upgrade?** Nothing calls it. Recommend delete (S, no risk). I also want your OK to take a read-only look at whether any server has jobs in its `pgboss` schema before the delete merges.
- **(b) `@types/node`: 24 or 26?** Recommend 24, matching the Node the servers run. "Latest" (26) means types for a Node we do not run.
- **(c) Move the readability and sync-jobs images from Node 22 to 24?** Recommend yes: several new majors already want 22.19 to 22.22, and Node 22 ends in April 2027. Costs one image rebuild and one live run each.
- **(d) Is `eve` inside this sweep or its own track?** Recommend its own track, last, under ADR-0021, so a conversation reset does not get tangled with 13 library bumps.
- **(e) `vitest` 5 right now?** You finished 4.1.11 last week (LAR-99). Recommend yes, because it is the only route to clear the `braces` "high" alert and the old `esbuild` alert for good, and it is dev only.
