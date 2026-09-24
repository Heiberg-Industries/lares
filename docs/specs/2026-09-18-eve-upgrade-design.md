# The eve upgrade, 0.32 → 0.60.x — design

**Ticket:** LAR-69. **Decisions this implements:** ADR-0016 (`docs/decisions/0016-fleet-runs-on-eve.md`, rule 2 — pinned and patched), ADR-0021 (`docs/decisions/0021-releases-and-upgrades.md` — eve bumped monthly, patch upstreamed where small), ADR-0015 (`docs/decisions/0015-agents-are-definitions-resolved-at-runtime.md` — agents are definitions resolved at runtime through `defineDynamic`).
**Primary source:** `docs/research/2026-09-18-prelaunch/05-vercel-eve.md` ("report 05"), read in full; commit `7259b96`, dated 2026-09-18. **Status:** design — no code changes yet.

## Corrections, 2026-09-19 — read these first

The slice planner unpacked `eve@0.32.0` and `eve@0.60.1` and checked this design against the real
packages. Three things below are wrong as written. The text is left in place so the history
reads honestly; where it disagrees with this list, this list is right.

1. **Tracing does not break at boot (section 3).** `recordInputs` / `recordOutputs` were removed
   from the OpenTelemetry *destination* options, not from `defineInstrumentation()`, which is the
   layout all three role services use. Nothing throws. Removing the two keys as this design says
   would have silently emptied every trace. The keys stay.
2. **One patch hunk is already upstream (section 2b).** The Slack channel's `alias(...)` call was
   always upstream's own code; what Lares adds is the small `onChannelIdChanged` hook. The patch is
   eight hunks, not nine, and "no hunk has landed upstream" is false.
3. **eve does not depend on `@workflow/world-postgres`.** It vendors `@workflow/world-local` and
   states no range, so there is no pin to read. The matching version is derived —
   `5.0.0-beta.42` pairs with the `world-local` that eve 0.60.1 vendors — and it requires `zod`
   to move from 4.4.3 to 4.5.4, which this design never mentions. The method is written down in
   `docs/solutions/2026-09-19-eve-060-pairing.md`.

The slice plan that replaces section 1.3's rough order is LAR-72's wave 2.

## 1. In plain language

The framework that runs every agent — the chief-of-staff agent, the travel agent and the creative
agent — is a fast-moving open-source project called eve, and the installed copy is five weeks old
and missing several fixes to the approval-card safety mechanism. This document is the plan for
moving the installed copy from its current version to the newest one, and for doing that every
month from now on instead of letting it fall behind again. The newer version fixes real safety
gaps: today, one click on an approval card can silently also approve a different pending action,
and a second approval in the same turn can make a tool run twice. The trade-off is that upgrading
resets every open conversation: mid-way through the version range, the way eve keeps a conversation
alive was rewritten, so any conversation open at the moment of the upgrade restarts from scratch,
and any approval card waiting for a click at that exact moment is lost. Because of that, this
upgrade drains pending approvals first and runs at night, when nobody is mid-conversation. Nothing
in this document reaches a live server: it only describes what changes and in what order; the
actual server upgrade is a separate, owner-confirmed step described in section 9.

## 2. Where eve touches this repo today — inventory

Read directly from this worktree, one row per touch-point.

### 2a. Pinned versions

| File:line | What it pins |
|---|---|
| `services/chief-of-staff/package.json:34` | `"eve": "0.32.0"` |
| `services/chief-of-staff/package.json:31` | `"@workflow/world-postgres": "5.0.0-beta.32"` |
| `services/travel/package.json:28` | `"eve": "0.32.0"` |
| `services/travel/package.json:26` | `"@workflow/world-postgres": "5.0.0-beta.32"` |
| `services/creative/package.json:27` | `"eve": "0.32.0"` |
| `services/creative/package.json:25` | `"@workflow/world-postgres": "5.0.0-beta.32"` |
| `packages/agent-kit/package.json:101` | `"eve": "0.32.0"` (devDependency); `packages/agent-kit/package.json:106` `"eve": "*"` (peerDependency) |
| `packages/board-evals/package.json:10` | `"eve": "0.32.0"` |
| `packages/board-evals/probe-extension/package.json:16` | `"eve": "*"` (peerDependency of a throwaway extension used only by the evals) |
| `services/keeper/tests/fixtures/conversation-agent/package.json:1` | `"eve":"0.32.0"` in a keeper test fixture's own tiny app |
| `package.json:17-19` | root `pnpm.patchedDependencies: { "eve": "patches/eve.patch" }` |
| `package.json:7-9` | root `engines.node: ">=22"` — looser than the `node:24-bookworm` every Dockerfile actually builds on (see 2f); not a version pin on eve itself, but worth fixing in the same pass since it currently understates the real requirement |

Six files pin the exact string `0.32.0`, all of which must move together; three files pin
`@workflow/world-postgres` at `5.0.0-beta.32`, which ADR-0021 rule 6 requires move in the same
change as eve.

### 2b. `patches/eve.patch` — hunk by hunk

The patch is a unified diff against nine minified `dist/*.js` files (`package.json:17-19` names the
patch, `patches/eve.patch` is the file). Each hunk replaces one whole minified line, so it carries no
context beyond that line.

| File (in `patches/eve.patch`) | What the hunk changes |
|---|---|
| `dist/src/harness/attachment-staging.js` (diff at `patches/eve.patch:1-9`) | `shouldInlineSandboxRefAsBytes` narrows from "any `image/*` under 3 MB" to a regex allow-list of jpeg/png/gif/webp only; every other staged file goes through a new function that calls `globalThis.__laresHydrateSandboxRef` if one is installed, falling back to the original bare-path text line |
| `dist/src/harness/input-extraction.js` (diff at `patches/eve.patch:10-17`) | The approval-card prompt text changes from the literal template string `` `Approve tool call: ${toolCall.toolName}` `` to `` globalThis.__eveApprovalSummary?.(s.toolName, s.input) ?? `Approve tool call: ${s.toolName}` `` |
| `dist/src/public/channels/slack/api.js` (diff at `patches/eve.patch:18-26`) | Adds `handleMessageChannel`, called from `post()` after every message send, which calls `e.onChannelIdChanged?.(t)` when the channel id returned by Slack differs from the one last known — new tracking, not present in the unpatched file |
| `dist/src/public/channels/slack/hitl.js` (diff at `patches/eve.patch:27-38`) | Adds `laresSummarised`/`laresDetails` helpers reading `globalThis.__eveApprovalCovers` / `globalThis.__eveApprovalDetails`; when a covered tool has a summary, the "Tool input" block renders that summary instead of raw `JSON.stringify(...)`, and `default_collapsed` for the raw-JSON container changes from `false` to `true` |
| `dist/src/public/channels/slack/interactions.js` | Adds a user-visible warning path when an interaction cannot be delivered (the unpatched file only logs) |
| `dist/src/public/channels/slack/slackChannel.js` | `rebuildSlackContext`'s `onThreadTsChanged` callback calls `t.continuation?.rekey(slackContinuationToken(e.channelId, n))` when the channel id is known — this is the call that must become `.alias(...)` (section 3) |
| `dist/src/public/channels/telegram/attachments.js` | Prefers the declared media type over the file server's `application/octet-stream` default |
| `dist/src/public/channels/telegram/hitl.js` | Approval text detail rendering, mirroring the Slack hitl.js change |
| `dist/src/public/channels/telegram/telegramChannel.js` | Adds a user-visible warning when a tap cannot be delivered, mirroring the Slack interactions.js change |

Nine hunks total, matching report 05's count (§A3).

### 2c. `globalThis.__…` hooks the patch expects, and where agent-kit defines them

| Hook | Defined at | Consumed by (patch file) |
|---|---|---|
| `globalThis.__eveApprovalSummary` | `packages/agent-kit/src/approval-summary.ts:460` | `dist/src/harness/input-extraction.js` |
| `globalThis.__eveApprovalCovers` | `packages/agent-kit/src/approval-summary.ts:461` | `dist/src/public/channels/slack/hitl.js` |
| `globalThis.__eveApprovalDetails` | `packages/agent-kit/src/approval-summary.ts:462` | `dist/src/public/channels/slack/hitl.js` |
| `globalThis.__laresHydrateSandboxRef` | `packages/agent-kit/src/attachment-hydration.ts:220` | `dist/src/harness/attachment-staging.js` |

Type declarations for the first three sit at `packages/agent-kit/src/approval-summary.ts:428-432`; for
the fourth at `packages/agent-kit/src/attachment-hydration.ts:215`.

### 2d. `packages/agent-kit/src/` modules whose comments name eve 0.32 behaviour directly

Found with `git grep -n -i "eve 0\.32\|eve's 0\.32\|0\.32 approval\|0\.32's\|0\.32\.0" -- packages/agent-kit/src`:

| File | What it says about 0.32 |
|---|---|
| `packages/agent-kit/src/approval-summary.ts:6` | "no per-tool label or description hook in the 0.32 approval API" |
| `packages/agent-kit/src/attachment-hydration.ts:4` | "eve 0.32 stages every inbound file in the sandbox, then shows the model only two kinds inline" |
| `packages/agent-kit/src/clock.ts:4` | "eve injects no date into the prompt (verified against 0.32.0's dist)" |
| `packages/agent-kit/src/durable-dynamic-tools.ts:2` | "Eve 0.32 stores dynamic tool names in durable sessions, but its fallback execute and approval functions live only in the process that ran session.started" |
| `packages/agent-kit/src/gateway-budget.ts:51,227,261,288,300,340` | reproduces eve 0.32.0's own `turn.failed`/`session.failed` display text and error-shape fields field-for-field, so a door can format the same failure the same way |
| `packages/agent-kit/src/telegram-reply-fix.ts:4` | quotes the exact 0.32.0 line in `telegramChannel.js`'s `dispatchMessage` that drops a reply unless the replied-to message came from a bot |
| `packages/agent-kit/src/unreadable-content.ts:4` | "Measured 2026-09-14, eve 0.32:" — lists which Telegram/Slack attachment kinds eve drops or empties |

A related module, `packages/agent-kit/src/catalogue.ts:12-16,44-45`, does not use the phrase "eve
0.32" but is load-bearing for the upgrade: its own comment cites a research finding
(`docs/research/2026-09-16-eve-0.32-dynamic-seams.md`, confirmed present in this worktree) that a
dynamic tool's `execute` must stay inline for eve's bundler to reconstruct it after a replay — the
exact rule report 05 says becomes strict and enforced at resolution from 0.44.1 onward (§A4,
workaround 2). This file already follows that rule, so no code change is expected here, but every
future dynamic tool added to the catalogue inherits the same constraint on the new eve.

### 2e. `globalThis.__…` hooks and instrumentation — `recordInputs`/`recordOutputs`

| File:line | Setting |
|---|---|
| `services/chief-of-staff/agent/instrumentation.ts:93-94` | `recordInputs: true, recordOutputs: true` |
| `services/creative/agent/instrumentation.ts:118-119` | `recordInputs: true, recordOutputs: true` |
| `services/travel/agent/instrumentation.ts:135-136` | `recordInputs: true, recordOutputs: true` |

`services/travel/agent/instrumentation.ts:8` notes the other two services' instrumentation files are
"identical" in this respect.

### 2f. `agent/agent.ts` in each role service

| File | `world` | Model resolution | `defineDynamic` |
|---|---|---|---|
| `services/chief-of-staff/agent/agent.ts:57` | `world: "@workflow/world-postgres"` inside `experimental.workflow` (`:50-59`) | `model: defineDynamic({ fallback: …, events: { "session.started": …, "step.started": … } })` at `:27-41` | yes, for `model` |
| `services/travel/agent/agent.ts:59` | same pattern | `defineDynamic` for `model` at `:30` | yes |
| `services/creative/agent/agent.ts:106` | same pattern | `defineDynamic` for `model` at `:74` | yes |

All three route the model through a self-built LiteLLM gateway provider
(`services/chief-of-staff/agent/agent.ts:3`, `../lib/gateway-provider.js`), never a bare Vercel AI
Gateway model-id string — the exact avoidance report 05 recommends for the AI-Gateway dependency
(§A6). `services/creative/agent/agent.ts:10` separately notes `@workflow/world-postgres@5.0.0-beta.32`
by its exact pinned string, confirming the version cited in 2a is the one actually referenced in
code, not just in the manifest.

### 2g. `agent/tools/*.ts` files that call `disableTool()`

Each role service ships one file per suppressed built-in tool, all reading `import { disableTool }
from "eve/tools"; export default disableTool();`:

| Service | Files (all under `agent/tools/`) |
|---|---|
| chief-of-staff | `agent.ts`, `bash.ts`, `glob.ts`, `grep.ts`, `read_file.ts`, `web_fetch.ts`, `web_search.ts`, `write_file.ts` (8 files) |
| creative | `agent.ts`, `bash.ts`, `glob.ts`, `grep.ts`, `read_file.ts`, `web_fetch.ts`, `web_search.ts`, `write_file.ts` (8 files) |
| travel | `agent.ts`, `ask_question.ts`, `bash.ts`, `glob.ts`, `grep.ts`, `read_file.ts`, `todo.ts`, `web_fetch.ts`, `write_file.ts` (9 files; `web_search.ts` here re-enables the tool instead, per its own comment at `services/travel/agent/tools/web_search.ts:9`) |

Report 05 §A1 (0.39.0) and §A4 workaround 6 both note `glob`/`grep` left the default tool set
entirely at 0.39.0, so the `glob.ts`/`grep.ts` sentinels in every service (6 files) are disabling a
tool eve no longer ships by default — harmless today, candidates to delete once `defaultTools:
false` (0.52.2) is adopted (work item 3).

### 2h. The agent-kit extension and how it is built

`packages/agent-kit/package.json:7-12` declares the eve extension shape (`"eve": { "extension": {
"source": "./extension", "dist": "./dist/extension" } }`); `:80-81` scripts `"build"` and
`"prepare"` both run `eve extension build`. Every role Dockerfile copies `packages/agent-kit` with
full source ahead of `pnpm install`, because pnpm runs a workspace package's `prepare` script
during install (`services/chief-of-staff/Dockerfile:37-49`). Each role's own
`agent/extensions/agent-kit/extension.ts` mounts the built package
(`services/chief-of-staff/agent/extensions/agent-kit/extension.ts:11`, `import agentKit from
"@lares/agent-kit"`) and calls `assertDeclarationIntegrity(manifest)` at build time (`:24-27`) so a
bad grant fails `eve build` rather than surfacing at runtime.

### 2i. `packages/board-evals` — what it pins and proves

`packages/board-evals/package.json:10` pins `"eve": "0.32.0"`; `packages/board-evals/README.md:9`
states the required command runs "installed, patched eve 0.32.0 with `mockModel`". The suite proves
eight behaviours (`:11-19`): granted-subset tool visibility, approval survival across a real
process restart, the permissions board taking effect after its cache expires, always-ask holding
under autonomous mode, cache/fail-closed reads, per-conversation language switching, fail-closed
handling of an invalid definition, and a disabled door making zero credential attempts.
`packages/board-evals/evals/seams.eval.ts:1-3` calls itself "a MEASUREMENT of eve 0.32's dynamic
seams, committed so it can be re-run against a later eve" — its job is to be re-run, not rewritten.

### 2j. Dockerfiles and CI workflows that install or build with eve

| File | Role |
|---|---|
| `services/chief-of-staff/Dockerfile:22` | `FROM node:24-bookworm AS builder`; `:60` `pnpm install --frozen-lockfile --filter lares-chief-of-staff...`; `:94` `RUN pnpm run assemble:check && pnpm exec eve build`; comment at `:18-19` states "eve 0.32.0 requires Node >=24" |
| `services/travel/Dockerfile:19,22,98` | same pattern (confirmed by grep: `FROM node:24-bookworm AS builder` at `:22`, `pnpm run assemble:check && pnpm exec eve build` at `:98`) |
| `services/creative/Dockerfile:19,22,93` | same pattern |
| `.github/workflows/chief-of-staff-builder.yml:24-30` | builds `services/chief-of-staff/Dockerfile` on push to `main` or a tag, no build args touching the eve version |
| `.github/workflows/keeper-runtime-images.yml:9-32` | matrix over `[chief-of-staff, travel, creative]`; builds the `runtime` target, then runs `services/keeper/tests/runtime-image.probe.py` for chief-of-staff only (`:30-32`) |
| `.github/workflows/keeper-runtime-images.yml:65-67` | for travel/creative, runs `tests/agent-declaration.test.ts` against the compiled manifest extracted from the image |
| `.github/workflows/runtime-base.yml` | builds `images/runtime-base` on its own trigger, no eve-specific step |

### 2k. `images/runtime-base/Dockerfile`

`images/runtime-base/Dockerfile:13` is `FROM node:24-bookworm-slim`; a comment at `:28` gives an
illustrative pnpm symlink path containing the example string `eve@0.32.0_...` — an example in a
comment, not a live pin (the real pins are in 2a). The file installs no dependencies itself; it is
the shared slim base every role's runtime stage copies its built `/app` into (`:1-3`).

### 2l. The keeper's image probe — what it asserts about eve

`services/keeper/tests/runtime-image.probe.py` runs the compiled runtime image in Docker and drives
it with eve's own client, imported directly from the built package (`:70`, `import {Client} from
'/app/services/chief-of-staff/node_modules/eve/dist/src/client/index.js'`). It polls `GET
/eve/v1/health` (`:17`). Each `docker exec` in the probe has a hard 120-second timeout (`:7`,
`timeout=120` — the ceiling LAR-73's intermittent restart-probe failure hits). The restart
assertion is `:81`: `second=turn(first);assert len(requests)>request_count,'No new model call
after restart' …` — a real `docker restart`, then a new turn on the same session, checking the
model alias and mounted duties survived. `:74-76` and `:82` assert the same dynamic tool set
(`echo_note`, `agent-kit__market_edge`) before and after restart; `:86` asserts a brand-new session
started after the on-box definition changed does not carry a now-removed tool. The probe asserts
nothing about eve's version string or telemetry — only durability and grant-set correctness across
a restart, the property the 0.57.0 execution-model rewrite (section 3) most directly threatens.

## 3. What changes upstream that breaks us

Every row cites report 05 (§A1 unless noted) mapped to the section-2 rows it hits.

| Eve release | Upstream change | Hits (section 2 row) |
|---|---|---|
| 0.33.0 | Channel sends default to `turnPolicy: "steer"`; a new message replaces the running turn instead of queueing | 2f (all three `agent.ts` accept channel defaults implicitly; no explicit `turnPolicy` is set anywhere in the three `agent.ts` files read for 2f, so all three inherit the new default) |
| 0.35.0 | Instrumentation stops recording inputs/outputs by default; `content`+`role` replace `markdown` on instructions | 2e (the setting itself becomes unnecessary once 0.60.0 removes it, see below) |
| 0.39.0 | `glob`/`grep` removed from default tools | 2g (the six `glob.ts`/`grep.ts` sentinel files become no-ops, not broken — see section 4) |
| 0.44.0/0.46.0 | Trace content exported only for "public" audiences unless a `tracePolicy` says otherwise | 2e (Langfuse traces via the OTLP exporter these instrumentation files configure go metadata-only until a `tracePolicy` is written — none of the three `instrumentation.ts` files define one) |
| 0.50.0 | All extensions must be rebuilt against new stream-event contracts | 2h (the agent-kit extension's `eve extension build` output must be regenerated; a stale `dist/extension` from before this release would not load) |
| 0.52.0 | CLI telemetry added: every `eve` command posts to `https://telemetry.vercel.com/api/eve-cli/v1/events` unless disabled | 2j (every Dockerfile's build stage and every CI workflow step that runs `eve build`/`eve extension build`/`pnpm exec eve build` — none of the files read in 2j sets an eve telemetry environment variable today) |
| 0.52.2 | `defaultTools: false` added to `defineAgent` | 2f/2g (none of the three `agent.ts` files sets it; every `disableTool()` sentinel in 2g is a candidate to retire once it is) |
| **0.57.0** | Execution model rewritten: every turn runs inside the session's own durable workflow; `continuation.rekey()` → `continuation.alias()`; sessions started before 0.45 are reported inactive and given a fresh session on next contact; no transparent rollback of session state | 2b (`dist/src/public/channels/slack/slackChannel.js`'s patched `rebuildSlackContext` calls `continuation?.rekey(...)` — this call site must become `.alias(...)` or the patch fails to apply, or applies but calls a removed method at runtime); 2i (`restart-proof.mjs` and the keeper probe's restart assertion at `services/keeper/tests/runtime-image.probe.py:81` both measure exactly the property this release changes — which job is in flight during a restart — and must be re-run, not assumed, after the bump) |
| 0.59.0 | Eval API: `t.session()`/`t.send()` shape changes; dynamic tool schemas must be durable (inline or `defineDurableSchema`) | 2i (`packages/board-evals/evals/*.eval.ts` use `t.newSession()`/`.send()` throughout — every eval file needs re-checking against the new API, not only `seams.eval.ts`) |
| **0.60.0** | `recordInputs`/`recordOutputs` on OTel destinations **throw at declaration** | 2e — all three role services fail to boot until these two keys are removed and replaced with an `exportPolicy` |

**Trace policy gap.** None of the three `instrumentation.ts` files (2e) declare a `tracePolicy`, so
after the 0.44/0.46 audience default and the 0.60.0 `exportPolicy` replacement, Langfuse traces lose
content unless a policy is written as part of this upgrade — this is new work, not only a rename.

**`@workflow/world-postgres` lockstep.** Report 05's header table records eve 0.60 bundling
`@workflow/core` beta.51 and `@workflow/world` beta.35, with the self-hosting guide stating the
runtime "rejects incompatible protocol versions" against a mismatched world package (report 05
§A1, "Workflow" row); the latest `@workflow/world-postgres` tag report 05 recorded is
`5.0.0-beta.44`. The exact paired version must be re-read from eve 0.60.x's own `package.json` at
upgrade time, not assumed from report 05's snapshot — betas move fast enough to differ by ship time.

**CLI telemetry off-switch.** Report 05 names the variable `EVE_TELEMETRY_DISABLED=1`
(`cli/telemetry/flush.ts:1`, §A6), but ADR-0021's own release checklist already says the name must
be re-verified against eve's docs at upgrade time, not carried forward from memory — this document
does the same: **treat `EVE_TELEMETRY_DISABLED=1` as unverified until confirmed against the
installed 0.60.x package**, and confirm it before any image ships, since `CLAUDE.md`'s "nothing
phones home" rule is unconditional and every Dockerfile in 2j runs `eve build` inside CI.

## 4. What we can drop, keep or must re-make

One row per patch hunk (2b) and per workaround (2d), against report 05 §A3/§A4's findings.

| Item | Report 05 verdict | This repo's evidence |
|---|---|---|
| Attachment mime allow-list (`attachment-staging.js`) | Still needed; no hook exists upstream at commit `7259b96` | `packages/agent-kit/src/attachment-hydration.ts:4-16` — the hook the patch calls (`__laresHydrateSandboxRef`) is agent-kit's own code, unaffected by upstream; only the patch's line-for-line diff must be re-derived against the new minified file |
| Approval prompt text via `__eveApprovalSummary` | Still needed; the pieces for a clean upstream fix now exist (`label.start(input)` since 0.52.3, not wired to approvals) | `packages/agent-kit/src/approval-summary.ts:460` defines the hook; work item 10 below drafts the upstream PR that would let this hunk be dropped |
| Slack approval card human details + collapse | Still needed or replaceable without a patch | `dist/src/public/channels/slack/hitl.js` hunk (2b); replacing it means authoring `events["input.requested"]` and re-emitting eve's internal `eve_input:<id>:button:N` action ids — report 05 calls this "coupling to internals" and recommends staying on the patch |
| Slack channel-id change tracking | Still needed, **and must be rewritten** — `rekey` no longer exists after 0.57.0 | `dist/src/public/channels/slack/slackChannel.js` hunk calls `continuation?.rekey(...)`; must become `continuation?.alias(...)` |
| Slack undelivered-tap warning | Still needed | `dist/src/public/channels/slack/interactions.js` hunk |
| Telegram content-type preference | Still needed | `dist/src/public/channels/telegram/attachments.js` hunk |
| Telegram approval details + undelivered warning | Still needed | `dist/src/public/channels/telegram/hitl.js` and `telegramChannel.js` hunks |
| **No patch hunk has landed upstream.** Report 05 §A3 checked all nine against source at `7259b96` and found every one still needed — this repo has no evidence to the contrary | — | the patch does not shrink on this upgrade; every hunk must be re-derived against the new minified `dist/` output, not rebased |
| Date/clock injection workaround | Still needed; cleaner home exists (`turn.started` dynamic instruction, `role: "user"`, since 0.35.0) | `packages/agent-kit/src/clock.ts:4` — not moved in this upgrade (work item 12, out of scope; named here only so nobody assumes the eve bump fixes it) |
| Dynamic tool durable-callback workaround | **Fixed upstream, with new rules** — callbacks must be inline, packaged tools need `eve extension build` or `defineDurableSchema` | `packages/agent-kit/src/durable-dynamic-tools.ts` is a `globalThis`-keyed registry that reimplements durability eve now provides natively; `packages/agent-kit/src/catalogue.ts:8-9` already enforces "keep `execute` INLINE" as a design rule, so no dynamic tool in this repo currently violates the new constraint — but `durable-dynamic-tools.ts` itself becomes redundant machinery once the eve-native mechanism is confirmed to cover the same cases (work item 8) |
| Per-tool label hook for approvals | **Half-changed** — `label.start(input)` exists since 0.52.3 but is not read by the approval prompt | matches `packages/agent-kit/src/approval-summary.ts`'s existing role; no code change required by the version bump alone, only an optional future upstream contribution (section 10) |
| Restart-recovery cost (F1, ADR-0016) | Still needed; accepted p1 upstream issue #1981, unmerged draft PR #1983, stalled since filing | See section 9 for the sharper, repo-specific diagnosis (LAR-73) that supersedes ADR-0016's "~15 minutes" estimate for this failure mode |
| Slack webhook-only inbound (F2, ADR-0016) | Still needed in eve's first-class Slack channel; no socket-mode code anywhere in the repo (unverified beyond report 05's own read of the eve source, which this worktree cannot independently confirm without `node_modules`) | out of scope for this upgrade; named so it is not mistaken for something the bump changes |
| Open default harness (F3, ADR-0016) | Changed: `defaultTools: false` exists since 0.52.2 | `services/{chief-of-staff,travel,creative}/agent/agent.ts` do not set it today (2f); work item 3 adopts it |

## 5. What we gain and will use later (out of scope for this upgrade)

Named so the upgrade's own work items (section 7) do not try to adopt any of these — each is a
later wave's seam, not this ticket's work.

- **The memory seam** (`eve/memory`: `defineMemory`, `defineMemoryProvider`; recall on
  `turn.started`, capture on `turn.completed`; per-principal scope via `eve/memory/scope`'s
  `byPrincipal`). Report 05 Part B §1 is explicit that the built-in `fileMemory()` backend defaults
  to a hosted blob store and "throws" outside that hosting environment or `eve dev` without an
  explicit backend — a self-hosted `MemoryDocumentBackend` or a custom `defineMemoryProvider` is
  required before this seam can be used at all. This is wave 4 (the vault memory work named in
  ADR-0017/0018), not this upgrade.
- **The approval-safety fixes already on the version this upgrade lands on** (report 05 §A2): the
  0.50.0 fix for one click auto-authorising sibling pending calls sharing an approval key; the
  0.47.4 fix preventing an already-executed tool from re-running across sequential approvals; a
  second 0.50.0 fix for approved calls silently not executing on resume; the 0.45.2 fix marking
  pending approvals as trusted runtime state so a follow-up cannot fabricate tool results as
  assistant text; the 0.35.0 fix for an approval dropped alongside a same-step subagent call; the
  0.52.5 fix batching queued deliveries only when auth contexts match. These land automatically
  with the version bump — no separate work item "turns them on".
- **MCP/OpenAPI connections with per-connection approval** (`defineMcpClientConnection`,
  `defineOpenAPIConnection`, `approval: once()|always()|never()|auto()|policy` on a whole
  connection) — wave 6, matching this repo's stated plan of MCP for user-added tools.
  Un-reviewed third-party tools stay outside the engine per the wave-1 integrations ruling; this
  upgrade does not add any connection.
- **The web chat channel** (`eve add channel/web` — a generated, self-hostable Next.js app with
  resumable session URLs) — wave 8, named in the tested-install-path ruling as the first door for a
  fresh installation. This upgrade does not scaffold it.

## 6. What must NOT come along

Report 05 §A6 lists which eve features need a Vercel-hosted service. None of these should be
adopted as a side effect of taking the version bump; each row names the self-hosted equivalent
this repo already uses or plans to use instead.

| Vercel-hosted feature | Self-hosted equivalent already in this repo (or planned) |
|---|---|
| `fileMemory()`'s default backend (Vercel Blob) | not used yet (section 5); when adopted, a `MemoryDocumentBackend` writing to the box's own Postgres or the vault's git tree |
| Vercel Connect (`connect("notion")`, hosted OAuth/token vault, guided channel setup) | owner-supplied OAuth client credentials, `defineInteractiveAuthorization` for self-hosted interactive OAuth, or `auth: { getToken }` |
| AI Gateway string model ids, `auto()` approvals, `evaluate`, built-in `web_search` (Exa) | the LiteLLM gateway provider every role's `agent/agent.ts` already constructs and passes as a live AI SDK model object (2f) — never a bare `"anthropic/…"` string |
| Vercel Sandbox (microVM), Drives, firewall-level credential brokering | Docker's `allow-all`/`deny-all` egress policy, or `microsandbox()` where a local VM is available; this repo's own sealed-egress squid proxy (`images/egress-proxy/Dockerfile`) stays the actual control, since report 05 §6 (SAFETY) is explicit that eve has no tool-level egress answer of its own |
| Agent Runs observability dashboard | the OTLP-to-Langfuse path each `instrumentation.ts` already configures (2e); this upgrade must write the `exportPolicy` these files are missing, not switch to Agent Runs |
| CLI telemetry (`https://telemetry.vercel.com/...`) | `EVE_TELEMETRY_DISABLED=1` (name to be reconfirmed per section 3) set in every image and CI job (work item 5) |
| Sandbox base image pulled from `ghcr.io/vercel/eve:<version>` | mirrored by digest into this repo's own registry if the sandbox backend in use ever pulls it — `images/runtime-base/Dockerfile` and the role Dockerfiles read in 2j do not reference this image today, so this is a watch item, not a fix |
| Named workspace agents / `defineWorkspaceAgent` peers (default transport is Vercel-only per report 05 §A5) | declared subagents under `agent/subagents/<id>/` or remote agents over HTTP — not adopted by this upgrade either way |

## 7. Ordered work items

Ten to sixteen items. Items 1–2 can land and be tested independently of the version bump. Items
3–9 must land together with the bump because the breakers in section 3 force them together — the
document says this plainly rather than pretending they could be sequenced apart. Items 10–14 follow
the bump and can be tested independently again.

1. **Write the release's `Backward-incompatible changes` block; confirm the paired
   `@workflow/world-postgres` version.** Touches: `CHANGELOG.md`. Done: the block lists every row
   from section 3 with the release that introduced it; the world-postgres version is read from the
   installed 0.60.x package's own `package.json`, not carried from this document. Tier: sonnet.
   Must not touch: any `package.json` version string yet.

2. **Drain pending approvals and schedule the maintenance window.** Touches: nothing (owner
   action). Done: the owner confirms no approval card is outstanding and a night window is set.
   Tier: n/a. Gates item 9's rollout, not the code work in 3–8; listed so it is not skipped.

3. **Bump the six version pins together** (2a); remove `recordInputs`/`recordOutputs` from all
   three `instrumentation.ts` files (2e), replacing them with an explicit `exportPolicy`. Touches:
   the six `package.json`s, the lockfile, `services/{chief-of-staff,travel,creative}/agent/instrumentation.ts`.
   Done: `pnpm install --frozen-lockfile` completes locally and a typecheck of each role service
   passes (`pnpm --filter lares-chief-of-staff exec tsc`, and the travel/creative equivalents).
   Tier: sonnet — the breakers land here and a real `exportPolicy` needs judgement, not a
   copy-paste. Must not touch: any tool file, any Dockerfile.

4. **Rewrite `patches/eve.patch`'s `rekey` call to `alias`; re-derive all nine hunks** against the
   new minified `dist/` output. Touches: `patches/eve.patch` only. Done: `pnpm install
   --frozen-lockfile` applies the patch cleanly, and `pnpm --filter @lares/agent-kit test` passes,
   including `packages/agent-kit/tests/eve-attachment-staging-patch.test.ts`. Tier: **opus** — the
   patch re-make named in the brief as the highest-judgement item: a wrong hunk either fails to
   apply (safe, loud) or applies and silently changes behaviour (unsafe, quiet), and `rekey`→`alias`
   touches durable-session identity directly. Must not touch: `services/*/agent/agent.ts`.

5. **Add `EVE_TELEMETRY_DISABLED=1` (name reconfirmed per section 3) to every Dockerfile build
   stage and CI step that runs an `eve` CLI command.** Touches: the three role Dockerfiles (2j),
   `.github/workflows/{chief-of-staff,travel,creative}-builder.yml`,
   `.github/workflows/keeper-runtime-images.yml`. Done: `docker build -f
   services/chief-of-staff/Dockerfile .` (and the travel/creative equivalents) succeeds, and a
   `docker run --rm --network none ...` smoke step (mirroring
   `.github/workflows/keeper-runtime-images.yml:27-29`) confirms no outbound attempt during `eve
   build`. Tier: haiku — same env var in nine known places. Must not touch: any agent source file.

6. **Adopt `defaultTools: false` in each role's `defineAgent`; delete the now-redundant
   `glob.ts`/`grep.ts` sentinels** (2g) once confirmed unnecessary. Touches:
   `services/{chief-of-staff,travel,creative}/agent/agent.ts`, the six `glob.ts`/`grep.ts` files.
   Done: `pnpm --filter lares-chief-of-staff exec vitest run tests/agent-declaration.test.ts` (and
   the travel/creative equivalents) pass with the same asserted tool set as before. Tier: sonnet —
   a wrong placement can silently widen or narrow the harness, the "fence" ADR-0016 says must be
   checked, not assumed. Must not touch: `patches/eve.patch`.

7. **Rebuild the agent-kit extension against the new stream-event contracts (0.50.0)**, confirm
   the built output loads. Touches: `packages/agent-kit/dist/extension` (verify committed or
   generated before editing), via `eve extension build`. Done: `pnpm --filter @lares/agent-kit run
   build` succeeds and each role's `eve build` resolves the extension with no ENOENT or
   stream-contract mismatch, proven by item 5's `docker build` passing. Tier: sonnet. Must not
   touch: `packages/agent-kit/package.json`'s `exports` map — a changed export name breaks every
   role service, out of scope here.

8. **Re-run `packages/board-evals/evals/seams.eval.ts` against the new eve; update recorded
   verdicts if any changed.** Touches: `seams.eval.ts` only if a verdict genuinely changes. Done:
   `pnpm -C packages/board-evals run eval` reports the same "EIGHT BEHAVIORS PASS" line
   (`packages/board-evals/README.md:20-22`), with `seams.eval.ts`'s five questions re-measured, not
   assumed unchanged. Tier: sonnet. Must not touch: approval/scope logic in
   `packages/agent-kit/src/manifest.ts` — this item measures, it does not change behaviour.

9. **Run the full board-evals suite and the keeper's runtime-image probe against the bumped,
   patched, rebuilt system, including the restart proof.** Touches: nothing, unless a genuine
   regression is found, which becomes its own follow-up item. Done: `pnpm -C packages/board-evals
   run eval` passes in full, `bash packages/board-evals/scripts/restart-probe.sh` passes
   standalone, and `.github/workflows/keeper-runtime-images.yml` is green on a branch (exact
   command in section 9). Tier: sonnet to run and triage; opus only if the restart proof itself
   needs code changes (it should not — section 9). Must not touch: the restart assertion's shape
   in `services/keeper/tests/runtime-image.probe.py`, except to widen the diagnosis, never relax it.

10. **Draft the upstream PR: approval prompt uses `label.start(input)` when present.** Touches:
    nothing in this repo (drafted for the eve project, section 10); a later item would delete
    `packages/agent-kit/src/approval-summary.ts`'s summary-hook plumbing once merged. Done: the
    draft exists and is handed to the owner to post — never posted automatically. Tier: sonnet.

11. **Draft the four remaining small upstream PRs** (Slack channel-id tracking, undelivered-tap
    warning, Telegram content-type preference, attachment mime allow-list; section 10). Touches:
    nothing in this repo. Done: all four drafts exist. Tier: haiku for the mechanical one
    (Telegram content-type), sonnet for the ones needing design rationale.

12. **Write the Langfuse `tracePolicy`/`exportPolicy` that restores full trace content.** Touches:
    `services/{chief-of-staff,travel,creative}/agent/instrumentation.ts` (extends item 3's edit;
    sequence right after item 3, before item 9's full run). Done: a live probe against the box's
    own Langfuse instance (CLAUDE.md's live-probe rule — a branch on a third-party response) shows
    full-content traces for a private-audience channel. Tier: sonnet.

13. **Re-verify the restart wrapper's 26-second discipline (ADR-0016's F1) against the 0.57.0
    execution model**, without attempting to fix the deeper lock/lease exposure in section 9 (LAR-73,
    owned elsewhere). Touches: nothing, or the wrapper script if its "which job is in flight"
    assumption (report 05 §A1, 0.57.0 row) no longer holds. Done: the wrapper is confirmed to still
    park work correctly, or a follow-up ticket names exactly what changed. Tier: sonnet.

14. **Confirm the byte-identical gate (section 8) passes on the new eve** before the branch is
    ready for the image workflow. Touches: nothing (a proof run). Done:
    `pnpm -C services/chief-of-staff run assemble:check` passes and
    `packages/board-evals/scripts/model-visible-tools-probe.sh` reports the same tool set as
    before the bump. Tier: sonnet.

## 8. The byte-identical gate

ADR-0015 rule 11 requires that, before any agent moves from a build-time image to a
runtime-resolved definition, "the runtime-assembled instructions and tool list must equal today's
build-time ones exactly" (`docs/decisions/0015-agents-are-definitions-resolved-at-runtime.md:84-85`).
An eve version bump is exactly the kind of change that could silently move either the assembled
instructions or the model-visible tool list, so the same gate applies here, proven with what
already exists in this repo:

- **Assembled instructions, byte-identical.** `services/chief-of-staff/package.json:11`'s
  `assemble:check` script re-assembles `agent.json` + the role template + `voice.md` in memory,
  compares the result byte-for-byte against the committed `agent/persona.md`, writes nothing, and
  fails naming the file on a mismatch. Wired into `services/chief-of-staff/Dockerfile:94` as a
  build gate (`pnpm run assemble:check && pnpm exec eve build`), so a version bump that changed how
  instructions compile would fail the Docker build itself. Run directly with `pnpm -C
  services/chief-of-staff run assemble:check`, and the travel/creative equivalents.
- **Model-visible tool list, proven against the real runtime, not just the resolver.**
  `packages/board-evals/scripts/model-visible-tools-probe.sh:1-11` calls itself "THE INDEPENDENT
  BYTE-IDENTICAL PROBE" — it deliberately avoids the `grantedToolNames` function the production
  resolver and registry both use, since a bug there would be invisible to a gate built out of it.
  It drives a real session through eve's own runtime with `EVE_MOCK_AUTHORED_MODELS=1` (`:29`) and
  reads back which tools the real harness dispatched to or blocked on. Run after section 7 item 8.
- **Filesystem-level cross-check.** `packages/agent-kit/src/persona/deployed-tools.ts:1-30` calls
  itself "the NAIVE view" (filesystem names only, no imports), paired with each service's own
  `tests/agent-declaration.test.ts`, which checks every backticked tool name in the committed
  instructions against the tool list `eve build` actually compiled — the second, authoritative
  check.

All three should be run after the version bump lands (section 7, item 14) and again as part of
section 9's proof-before-main gate.

## 9. Proving it before main, rolling it out, rolling it back

**Branch discipline.** The whole upgrade lives on a branch named `parked/lar-69-eve` until the
image workflow is green on that branch. The command to run it: `gh workflow run "keeper and neutral
runtime images" --ref parked/lar-69-eve` (the workflow's own `name:` field,
`.github/workflows/keeper-runtime-images.yml:1`, is "keeper and neutral runtime images" — matched
exactly so `gh workflow run` resolves the right workflow). The branch is not merged to `main` until
this run is green.

**The restart-probe timeout is re-run, never patched around.** `services/keeper/tests/runtime-image.probe.py:7`
gives every `docker exec` inside the probe a 120-second `subprocess` timeout; the probe's own
restart assertion at line 81 (`second=turn(first)`) is the specific call known to time out
intermittently — tracked as **LAR-73**. This upgrade must re-run that probe on the new eve version
and treat a timeout there as a signal to investigate, not as noise to raise the timeout past. This
document does not attempt to fix LAR-73 — another line of work already owns the fix — but the
diagnosis behind it changes what this upgrade must check:

- **Production exposure, not only a CI flake**: a restart landing inside a turn's finishing work
  can leave a graphile-worker job locked by the now-dead process (a four-hour lock expiry) and an
  inline step owned by a dead queue message (an ~860-second lease), so the next message on that
  conversation can wait roughly fourteen minutes — sharper than ADR-0016's original "~15 minutes"
  bare-restart estimate. `services/chief-of-staff/sql/001-eve-workflow.sql:40-46` confirms
  `@workflow/world-postgres` is backed by graphile-worker's own job-queue schema, consistent with
  this diagnosis, but this worktree has no `node_modules` to confirm the lock/lease figures
  directly — **unverified in this worktree**, carried over from a session that did check it.
- Re-check on the new eve / `@workflow/world-postgres` pair, and cite if found: whether eve's
  `sandbox-shutdown-plugin.js` still calls `process.exit(143)` ahead of graphile-worker's graceful
  shutdown, and whether `WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS` still exists and its default.
  Both **unverified in this worktree** — no `node_modules/eve` or `node_modules/@workflow` tree
  exists here; check against the installed 0.60.x packages at upgrade time.
- Whether PR #1983 ("close workflow world during server shutdown", still an unmerged draft per
  report 05 §A4 workaround 4) would cover this failure mode is **not decided here** — this
  document does not design or evaluate that fix. The fix under discussion elsewhere releases stale
  worker locks at agent start plus a deterministic restart-mid-turn probe case; this upgrade's job
  is only to say, after landing, whether the new eve/world-postgres pair changed the lock or lease
  behaviour — a yes/no this document cannot answer in advance.
- The proof to re-run, unchanged in shape: `packages/board-evals/scripts/restart-proof.mjs` (via
  `bash packages/board-evals/scripts/restart-probe.sh`) and the keeper probe's restart assertion
  (`services/keeper/tests/runtime-image.probe.py:79-86`). Both must pass on the bumped version and
  be run again, not assumed still fine, because 0.57.0 changed which job is in flight during a
  restart (section 3).

**Rollout is a separate, owner-confirmed step, done at night.** Nothing in this document performs a
server upgrade. Once the branch's image workflow is green, rolling the new images to an actual
installation's server is: approvals drained (section 7, item 2), a maintenance window at a quiet
time, then the same deploy discipline this repo already uses (bump the pinned image tag/digest,
restart). No new mechanism is introduced by this document for that step.

**Rollback = the previous image digests.** ADR-0021 rule 4 already requires "automatic backup
before every update; one-command rollback to the previous image digests" — this upgrade produces no
exception to that mechanism. The honest caveat, direct from report 05 (§A1, 0.57.0 row): "no
transparent rollback of session state" across the 0.57.0 execution-model boundary. Rolling back the
image digests undoes the code; it does not undo the fact that every session already restarted fresh
at the moment of the forward upgrade. A rollback after this upgrade is a rollback of the software,
not a time machine for conversations that were already reset going forward.

## 10. Upstream work, drafted not posted

Five small PRs plus one issue comment, each described so the owner can review and post them.
**Nobody posts to the upstream eve project without the owner's explicit go-ahead** — these are
drafts sitting in this repo's own history, not open PRs.

1. **Issue #1981 / PR #1983 comment.** Note that a self-hosted installation independently found
   the restart-recovery cost worse than reported — stale queue-job locks and leases can add
   minutes, not just the original ~15-minute estimate. Ask whether the draft PR is still intended
   to land or would welcome a rebase from someone else.

2. **PR: approval prompt uses `label.start(input)` when present.** In
   `harness/input-extraction.js`, fall back to the literal `` `Approve tool call: ${toolName}` ``
   only when a tool defines no `label.start`; otherwise call it for the prompt text. `label.start`
   has existed as presentation-only metadata since 0.52.3 but the approval path never reads it.

3. **PR: Slack binding tracks channel-id changes.** `buildSlackBinding` in
   `public/channels/slack/api.js` tracks `threadTs` changes via `onThreadTsChanged` but has no
   equivalent for the channel id, even though Slack can return a different one than a message was
   posted to. Add a matching `onChannelIdChanged` callback.

4. **PR: user-visible notice when a HITL click or tap cannot be delivered.**
   `slack/interactions.js` and `telegram/telegramChannel.js` only `log.error(...)` today when an
   interaction fails to deliver, leaving the person who clicked with no feedback. Add a
   best-effort reply saying delivery failed; ties to open issue #1869.

5. **PR: Telegram prefers the declared media type over the file server's default.**
   `public/channels/telegram/attachments.js` trusts the response `content-type` header, which
   defaults to `application/octet-stream` for files Telegram itself typed correctly. Prefer
   Telegram's declared type, falling back to the header only when none was given.

6. **PR: attachment mime allow-list for inline images.** `shouldInlineSandboxRefAsBytes` in
   `harness/attachment-staging.js` inlines any `image/*` under 3 MB, including types (HEIC, SVG,
   TIFF) several model providers reject outright. Narrow it to jpeg/png/gif/webp and add a hook
   for everything else. Report 05 §A3 calls this an objective bug independent of any local need.

## 11. Open questions

- **Is `dist/extension` committed or gitignored for `packages/agent-kit`?** Item 7 needs the answer
  to know whether the rebuild's output must be committed or is regenerated by every downstream
  build. Not resolved here — check before starting item 7.
- **Does the installed 0.60.x package still expose `eve/dist/src/client/index.js` at the same
  path** `services/keeper/tests/runtime-image.probe.py:70` imports directly, rather than through
  the package's public `exports` map? Report 05 does not confirm this path is stable across the
  range, and this worktree has no installed package to check. Confirm during item 9.
- **What is the real paired `@workflow/world-postgres` version**, read from the installed eve
  0.60.x's own `package.json`, and does it exist as a published, installable package at all (report
  05 notes the whole `@workflow/*` line sits on an experimental, beta-tagged chain)? Item 1 must
  answer this before item 3 can set exact version strings.
- **Does 0.57.0's "sessions started before 0.45 are reported inactive" rule affect any session
  state kept around longer than the roughly three-week import window** report 05 describes?
  Sessions here are documented elsewhere as one chat-day each (ADR-0016), which should make this
  moot, but it is not verified against this document's own inventory — confirm before item 2.
- **Is the LAR-73 fix (owned elsewhere) expected to land before or after this upgrade?** This
  document takes no position — section 9 states only that the restart proofs must be re-run and
  the lock/lease behaviour re-described after the bump, whichever order the two pieces
  of work end up in.
