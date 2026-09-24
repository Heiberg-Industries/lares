# 05 — Vercel's agent stack (eve, plus AI SDK / Chat SDK / Workflow)

Researcher report for LAR-71, 2026-09-18. Read-only. Citations are repo paths in `vercel/eve` at the commit below unless stated; "CHANGELOG" means `packages/eve/CHANGELOG.md`.

## Header

| | |
|---|---|
| Primary source | **eve** — https://github.com/vercel/eve ("The Open Framework for Building Agents"), docs https://eve.dev/docs |
| Default branch commit | `7259b96`, 2026-09-18 (main) |
| Latest release | `eve@0.60.1`, published 2026-09-18 14:26 UTC (0.60.0 the same morning) |
| Licence | Apache-2.0 (LICENSE + NOTICE + DCO sign-off required for contributions) |
| Stars / issues | 5,253 stars, 858 open issues. Repo created 2026-06-16 — the project is three months old |
| Status | **Public beta.** README "Beta terms": "the framework, APIs, documentation, and behavior may change before general availability" (README.md:129-132; packages/eve/README.md:9-11) |
| Lares pin | eve 0.32.0, published **2026-08-11**. `@workflow/world-postgres` 5.0.0-beta.32 |
| Distance | 28 minor versions, **66 stable releases in 38 days** (npm publish times). One minor every ~1.4 days; ~1.7 releases per day |
| Secondary | `vercel/ai` — ai@7.0.106 (2026-09-18), Apache-2.0 per npm (GitHub API says NOASSERTION), 26.8k stars. `vercel/chat` — chat@4.41.0, MIT, 2.4k stars; eve vendors chat 4.34.0. `vercel/workflow` — workflow@5.0.0-beta.53 (stable line is 4.8.9), Apache-2.0, 2.4k stars; eve 0.60 bundles `@workflow/core` 5.0.0-beta.51, `@workflow/world` beta.35; `@workflow/world-postgres` latest beta tag is 5.0.0-beta.44 |

**What I read:** the full CHANGELOG from 0.60.1 down to 0.31.3 (every entry); docs for memory (3 pages), connections overview, install-integrations, self-hosting, HITL, Slack/Telegram/Teams/Chat-SDK channels, dynamic capabilities, built-in tools, default harness, security model, sandbox, schedules, subagents, agent-config (limits), execution model, CLI telemetry, getting-started; source for the memory backend, approval extraction, Slack HITL/API/interactions, Telegram attachments/channel, attachment staging, CLI shutdown/start, telemetry endpoint; the official registry (`apps/docs/registry.json`); issues #1981, #535, #1869, #2425, #2876 and PR #1983; Lares's `patches/eve.patch` and ADR-0016; the local 0.32.0 copy for comparison.

**Not verified:** anything requiring a running system (no builds, no runs). The exact cause of Lares's "dynamic tool names / broken fallback executor" workaround — I matched it to changelog entries, not to Lares code paths. Whether Chat SDK's Slack socket mode works inside eve's `chatSdkChannel`. AI SDK v7 / Chat SDK / Workflow were checked only at header level plus the specific points noted. eve.dev/integrations pages were not fetched; the registry JSON in the repo was read instead.

---

## PART A — 0.32 → 0.60: what changed and what it means for Lares

### A1. Breaking changes on the path (everything Lares would hit)

In this project "Minor Changes" in the changelog means "may break you". In order:

| Release | Change | Lares impact |
|---|---|---|
| 0.33.0 | Channel sends default to `turnPolicy: "steer"` — a new message **replaces** the running turn instead of queueing. `defineDynamic` accepts only `events`; dynamic model handlers must return a concrete selection | Behaviour change for every Slack/Telegram conversation. Set `turnPolicy: "queue"` to keep today's behaviour. 0.57.0 later softens steering (applies at next step boundary, does not cancel in-flight tool work). Lares has 34 files using `defineDynamic` — check shape |
| 0.33.1 | Follow-up messages no longer wait behind a pending approval; they run as normal turns | Good for Lares (an open approval card no longer freezes the chat), but duties/voice text that assumes "blocked until answered" is now wrong |
| 0.34.0 | Approval becomes `{ request, response }`; response policy can authorise **who** clicked Approve | New capability, function shorthand kept |
| 0.35.0 | Instrumentation records **no inputs/outputs by default**; instructions take `content` + `role` (`markdown` deprecated) | See 0.60.0 |
| 0.39.0 | `glob` and `grep` removed from default tools | Fewer `disableTool()` files needed |
| 0.42.0 | `respond()` accepts only exact literals or `parseInputResponses()` output | Only if Lares calls `respond()` directly |
| 0.44.0 / 0.46.0 | Trace **content** is exported only for "public" audiences unless a `tracePolicy` says otherwise | Lares's Langfuse traces would go metadata-only after upgrade until a trace policy is written |
| 0.45.0 | Built-in tools move from `eve/tools/defaults` to `eve/tools/<name>`; `defineBashTool` etc. removed; persistent subagent sessions become the default | Lares has 0 imports of the removed paths (grep) — no work |
| 0.47.0 | Sandbox `onSession` receives metadata via `ctx`, uses `use()` | Only if Lares authors `onSession` |
| 0.50.0 | Stream events become deltas; **all extensions must be rebuilt** against the new contracts | Lares's `agent-kit` extension must be rebuilt with the new compiler |
| 0.52.0 | `defineWorkflowTool` replaces workflow-backed `defineTool`; `eve/workflow` entry deleted; `task.delegated()` removed; **CLI telemetry added** (see A4) | 0 Lares usages of the removed APIs. Telemetry matters |
| 0.54.0 | Trace schema v4; `agent.session` and `agent.channel.delivery` spans removed | Any Langfuse dashboards keyed on those span names break |
| 0.55.0 | `audience(input)` on `defineChannel`; anonymous = public, authenticated = private | Decides what gets traced |
| 0.56.0 | Aggregate registry packages removed | n/a |
| **0.57.0** | **Execution model rewritten**: every turn runs inside the session's own workflow (no child run per message). `continuation.rekey()` → `continuation.alias()`. Sessions started before 0.45 "are reported inactive and their channel starts a fresh session"; pending tool calls, approvals and subagents of imported sessions are abandoned; **no transparent rollback** (docs/concepts/execution-model-and-durability.mdx:32-57) | Lares's Slack patch hunk calls `continuation?.rekey(...)` — must be rewritten to `alias`. Upgrade = all live sessions restart fresh; pending approval cards die. Lares sessions are one chat-day, so upgrade at night after draining approvals. Rollback needs sessions retired first |
| 0.58.0 | Named workspace agents move to `/eve/<name>/v1/*` | Only if Lares adopts the multi-agent workspace |
| 0.59.0 | Eval API: `t.session()`, `t.send()` returns a turn; dynamic tool **schemas** must be durable (inline or `defineDurableSchema`) | Eval suites need edits; dynamic tools with resolver-local Zod schemas are rejected at resolution |
| **0.60.0** | `recordInputs` / `recordOutputs` on OTel destinations **throw at declaration**; replaced by `exportPolicy`. `autoModel` → `auto` from `eve/models`; `evaluate` → `eve/ai` | Lares sets `recordInputs: true, recordOutputs: true` in `services/{chief-of-staff,creative,travel}/agent/instrumentation.ts` — all three agents would fail to boot until rewritten |
| Workflow | eve 0.60 bundles `@workflow/core` beta.51 / `world` beta.35; self-hosting doc: "Install a world built against the same `@workflow/*` line… the runtime rejects incompatible protocol versions" (docs/guides/deployment/self-hosting.md:45). 0.38.2 moved to spec version 6 | `@workflow/world-postgres` must move from beta.32 to the matching beta (latest tag beta.44) **in the same change** as eve |

### A2. Safety fixes Lares is missing by sitting on 0.32

These matter more than features because Lares's whole safety model is the approval card:

- **0.50.0 (884cba8)** — "Prevent approving one tool call from auto-authorizing other already-pending calls with the same approval key." On 0.32, one click can approve sibling pending calls.
- **0.47.4 (4264f03)** — "Preserve completed tool results across sequential approval and authorization pauses so resumed model calls do not repeat successful tool executions." On 0.32 a second approval in a turn can re-run an already-executed tool (a double send).
- **0.50.0 (5b90f3d)** — approved tool calls silently not executing when task state was injected on the resume step.
- **0.45.2 (a5917cd)** + closed issue #2466 "Pending approval follow-ups can simulate tool calls and fabricate results as assistant text" — pending approvals are now marked as trusted runtime state.
- **0.35.0 (1cd563b)** — an approval requested in the same model step as a subagent call was dropped.
- **0.52.5 (3bbf8e5)** — queued deliveries are only batched when their auth contexts match, "preventing one sender's input from running under another sender's auth". Relevant the day Lares is multi-user.
- **0.37.1 (d8cef1a)** — create-once operations scoped to the forwarded principal (session adoption across users).
- **0.44.4 (94a0952)** — `web_fetch` re-checks every redirect hop for SSRF.
- 0.33.2 — `@workflow/core` beta.41 "event log corruption fixes"; 0.40.0 — replay-determinism fix.

### A3. Lares's patch, hunk by hunk — none of it has landed upstream

Checked against source at `7259b96`.

| Patch hunk | Upstream today | Verdict |
|---|---|---|
| Attachment staging: only jpeg/png/gif/webp go inline; other files go to a hook | `packages/eve/src/harness/attachment-staging.ts:265-266` still inlines anything `image/*`; non-image, non-PDF still becomes a bare "Attached file <path>" text part; no hook. 0.48.0 only added "continue the turn when an attachment cannot be retrieved" | **Still needed.** Good upstream PR candidate (mime allow-list is an objective bug: HEIC/SVG/TIFF are sent to models that reject them) |
| Approval prompt text via `__eveApprovalSummary` | `harness/input-extraction.ts:169` is still the literal `` `Approve tool call: ${toolCall.toolName}` `` | **Still needed.** See workaround 3 below — the pieces for a clean upstream fix now exist |
| Slack approval card: human details instead of raw JSON, collapsed | `public/channels/slack/hitl.ts:499-521` still renders `JSON.stringify(request.action.input)` under "Tool input", `default_collapsed: false` | **Still needed — or replaceable without a patch.** Slack `events["input.requested"]` can be authored; since 0.55.0 it receives `defaultDeliver()` (docs/channels/slack.mdx:466-492). Lares could post its own summary block then call `defaultDeliver`, but the raw-JSON block would still follow. Full replacement means re-emitting eve's internal `eve_input:<id>:button:N` action ids — coupling to internals. Patch remains the smaller evil until upstream takes a hook |
| Slack channel-id change tracking (`onChannelIdChanged` + rekey) | `slack/api.ts:405-416` tracks only `threadTs`; `slackChannel.ts:841` now calls `continuation?.alias(...)` | **Still needed, and must be rewritten** (`rekey` no longer exists after 0.57.0) |
| Slack: warn the user when a click could not be delivered | `slack/interactions.ts:509` still only `log.error("HITL interaction delivery failed")` and returns. Related open p1 issue #1869 "Slack HITL: button answer silently dropped (world-postgres)" | **Still needed** |
| Telegram: prefer the declared media type over the file server's `application/octet-stream` | `telegram/attachments.ts:98-99` still prefers the response `content-type` header | **Still needed** |
| Telegram approval text details + undelivered-tap warning | `telegramChannel.ts:653` still only logs | **Still needed.** (0.54.5 fixed typed replies to Telegram approval prompts; 0.45.0 added Telegram authorization challenges) |

Net: **the patch cannot shrink yet.** It gets harder to carry: it targets minified `dist/` files, every one of which has been rewritten by 28 minors. Plan on re-deriving all 9 hunks, not rebasing them.

### A4. Lares's workarounds — fixed / changed / still needed

| # | Workaround | Status | Evidence |
|---|---|---|---|
| 1 | No date injected into the prompt | **Still needed; cleaner home exists.** No date/time injection anywhere in `harness/`, `runtime/`, `framework/`, `context/` (grep). Upstream mechanism: a dynamic instructions file resolving on `turn.started`, with `role: "user"` if it should enter history (0.35.0 df0804e; docs/guides/dynamic-capabilities.md "Dynamic instructions"). Docs warn turn-scoped system text hurts prompt caching — put the date in a user-role turn instruction | |
| 2 | Dynamic tool names stored in durable sessions, broken fallback executor | **Fixed upstream, with new rules.** 0.33.0 removes compiled fallbacks/placeholders; 0.39.2/0.41.0 rebuild session-scoped dynamic executors and approval policies on continuation; 0.43.0 (be9be27) makes execute/approval/output callbacks durable across cold starts; **0.44.1 (02403b9)** identifies callbacks by tool name + phase, runs the latest deployed code after redeploy, and "a tool that no longer exists fails closed with an explicit error"; 0.47.7 resumes sessions persisted by older versions; 0.52.3 isolates by session/scope; 0.52.2 preserves input-scoped approval keys; 0.59.0 durable schemas. **Price:** callbacks must be inline in `defineTool()` with JSON-serialisable closures; `execute: makeExecutor()` is rejected; packaged tools (Lares's agent-kit) need `eve extension build` or `defineDurableCallback` / `defineDurableSchema` (docs/guides/dynamic-capabilities.md "Author replayable callbacks", "Create dynamic tools in a package") | |
| 3 | No per-tool label hook in the approval API | **Half-changed.** 0.52.3 (1a4f0b3) adds `label.start(input)` / `label.delta` / `label.complete` on `defineTool` — "presentation only", recorded on the action event, used by activity renderers (docs/tools/overview.mdx:37-101). 0.55.0 uses it for background tasks. **But the label is not used for approval prompts** — `harness/input-requests.ts` and `slack/hitl.ts` never read it. So: still needed for approvals. The obvious upstream PR is "use `label.start(input)` as the approval prompt when present" — that would delete two patch hunks | |
| 4 | **F1** — restart mid-turn costs ~15 min | **Still needed.** This is issue **#1981, filed by the owner on 2026-08-12**, labelled `bug, p1, core`, still open. A bot accepted it and opened draft PR #1983 "close workflow world during server shutdown" the same day; the PR is **still an unmerged draft, untouched since 2026-08-12**. Source confirms: `eve start` calls only `server.close()` (`cli/run.ts:281`); the only `world.close()` call is in the *development* world server (`internal/workflow/development-world-server.ts:123`). Sibling issues still open: #535 (world-postgres never resumes an interrupted turn, since 0.19), #1450, #2425 (world-local 30 s hook timeout re-bills a long model call), #2876 (sessions past ~6k events exceed the 240 s replay ceiling and wedge). 0.45.2 fixed the *local* world's delivery timeout only. **Re-test after upgrade**: 0.57.0 changed which job is in flight (session workflow, not a child turn run), so the 26-second wrapper must be re-verified, not assumed | |
| 5 | **F2** — Slack is webhook-only, needs public inbound | **Still needed in eve's first-class Slack channel** (no socket-mode code or docs anywhere in the repo). Upstream's answer is Vercel Connect forwarding events — a Vercel-hosted service, so no. **New avenue (unverified):** Chat SDK's Slack adapter gained `mode: "socket"` (vercel/chat#123 closed completed 2026-04-20; `packages/adapter-slack/README.md` "Socket mode"), and eve has a generic `chatSdkChannel` (docs/channels/chat-sdk.mdx) that supports HITL in DMs (0.44.4). A spike could remove the relay, at the cost of eve's Slack-specific features (approval cards, `approvalChannel`, slash commands, activity renderers). Needs a durable Chat SDK state adapter (Redis/Postgres) | |
| 6 | **F3** — default harness is open | **Changed: one switch now exists.** 0.52.2 (4446e0d): `defaultTools: false` in `defineAgent` turns off all optional defaults; add back per tool from `eve/tools/<name>` (docs/concepts/built-in-tools.md). 0.39.0 removed glob/grep from defaults. The default is still open (bash, read_file, write_file, web tools, and a root-only self-delegation `agent` tool — disable with `tool: false`). Sandbox egress still defaults to `allow-all` (docs/sandbox.mdx "Network policy"). Lares has ~104 files mentioning `disableTool`/`defaultTools`; most `disableTool()` stubs can go. Keep the fence check — a rollback still un-fences | |

### A5. New capabilities, by area

**Memory (new since 0.45.1 — did not exist in 0.32).** Full detail in Q1. `eve/memory`: `defineMemory`, `defineMemoryProvider`; `eve/memory/scope`: `byPrincipal`; `eve/memory/file`: `fileMemory`, `inMemory`, `MemoryDocumentBackend`. Registry providers: `memory/file`, `memory/supermemory` (0.47.5), `memory/upstash-agentkit` (0.52.0), `memory/arcana`. OTel spans for recall/capture (0.54.1); recalled records treated as model input for trace policy (0.54.2); separate namespaces per mounted agent (0.51.1).

**Connections.** Dynamic connections via `defineDynamic` in `connections/` — per-caller MCP/OpenAPI sets, fail closed, `instanceKey` pins auth (0.47.4). `providedArguments` with replay-stable `callId` for idempotency keys (0.46.1). `protocolVersionDiscovery: false` for older MCP servers (0.55.0). OpenAPI default/example sanitising (0.52.2). `credentialOwner: "app" | "user"` for plain `getToken` auth (0.56.0). Self-hosted interactive OAuth (`defineInteractiveAuthorization`) already existed in 0.32. Workflow tools can use `ctx.getToken` / `ctx.requireAuth` (0.52.4).

**Channels.** Web Chat (`eve add channel/web`, a generated Next.js app): session URLs `/s/{id}`, resume on reload (0.44.1), steer while streaming, `ask_question` forms, prewarm (0.59–0.60). Optional "Sign in with Vercel" variant — skip it. Teams: approval cards settle with responder (0.41.0), guided setup is Connect-only (0.58.0) but "portable credentials" path exists (docs/channels/teams.mdx:42). Slack: `onInputResponse` authorises HITL answers (0.38.3), `approvalChannel` routes approvals to the thread or a **private DM** (0.54.5), `defaultDeliver()` (0.55.0), `onSlashCommand` / `onShortcut` (0.47.4), block-kit text extraction for bot alerts (0.44.4), long replies uploaded as snippets (0.53.1), `isDMOrPrivateChannel()` (0.39.1), cards stay settled out of order (0.47.3). New channels: MCP channel — other agents/clients can start and approve eve invocations over MCP (0.37.1), Linq iMessage/SMS (0.41.0), Buzz ACP. Session create is now separate from first turn (0.59.0).

**Dynamic definitions.** `ctx.model?.id` in resolvers (0.54.4); `ctx.messages` correct at `turn.started` (0.58.0 fix); dynamic capability growth now triggers compaction (0.59.0); withdrawn dynamic skills announced (0.57.0); role-aware dynamic instructions (0.35.0); `auto()` model routing per task (0.58–0.60, defaults to AI Gateway).

**Approvals/HITL.** `auto()` — an evaluation model decides clear/caution, fails closed to user approval (0.59.1; defaults to `typesafe-ai/jev` via **AI Gateway** unless a global AI SDK provider is set). Response policies (0.34.0). `input.resolved` durable stream events (0.39.1). Session cost limit prompts (0.51.1).

**Sandbox.** `getSandbox().delete()` (0.47.0); child can share `parent.sandbox` (0.39.0); images published to GHCR per version, `EVE_SANDBOX_IMAGE_TAG` (0.49.1); `justbash({ customCommands })` (0.44.4); brokered credentials redacted from logs (0.40.0).

**Schedules.** Extensions can contribute schedules (0.38.0); scheduled runs with background work stay silent until done, deliver once (0.55.0); schedule provenance kept (0.47.0). Open issue #707 asks for an external-cron mode for self-hosters.

**Subagents / agent-to-agent.** Persistent subagent sessions default (0.45.0); background tasks; steering a running child (0.52.3); `defineWorkflowTool` with `ctx.agent()` (0.52–0.53); `tool: false` hidden subagents and `agentRouter()` (0.59.1–0.60.1); `defineWorkspaceAgent()` peers — default transport **requires Vercel**, explicit transport needed self-hosted (self-hosting.md:94); multi-agent workspaces from `agents/` (0.51.0).

**Evals.** `transcript` for judges (0.47.0), Datadog reporter (0.52.4), `--json` fix, explicit session ownership (0.59.0), standalone `evaluate()` (0.59–0.60).

**Instrumentation.** Provider layout `agent/instrumentation/` with durable lifecycle handlers and idempotency keys (0.34.0); OTel GenAI conventions, `invoke_agent`/`execute_tool` spans, schema v4; `tracePolicy` + `exportPolicy` with redaction (0.44–0.60); metric readers (0.47.4). Vercel **Agent Runs** is auto-enabled only on Vercel deployments — irrelevant self-hosted; OTLP export to Langfuse keeps working.

**Cost.** `maxTokenCostUsdPerSession` (0.51.1) — but "uses the cost reported with each model step; AI Gateway supplies this value, while model steps without reported cost do not add to the limit" (docs/agent-config.md "Runtime limits"). Behind LiteLLM the dollar cap is inert unless cost is surfaced in provider metadata; token caps work. Default root input budget: 40M tokens per session.

**Data retention.** `experimental.workflow.retention: 0` deletes a run's payloads/streams/event log when it finishes (0.53.1). `experimental.workflow.modelCallsPerStep` batches checkpoints (0.53.0).

### A6. Things that need a Vercel-hosted service (flag list)

| Feature | Vercel service | Self-hosted alternative |
|---|---|---|
| `fileMemory()` default backend when deployed | **Vercel Blob** | Must pass `fileMemory({ backend })`; outside Vercel and `eve dev` it **throws** ("requires an explicit backend", `public/memory/file/backends/default.ts:47`) |
| 53 of 105 official registry items (all 45 connections incl. Notion, Linear, Stripe; Slack/Teams/GitHub/Linear guided channel setup) | **Vercel Connect** (`@vercel/connect`, OIDC, hosted token vault, webhook forwarding) | Replace `auth: connect("notion")` with `auth: { getToken }` or `defineInteractiveAuthorization`; channels via "portable credentials" env vars. The registry file is ~5 lines, so the catalogue is still useful as a list of MCP URLs |
| String model ids (`"anthropic/…"`), `web_search` default (Exa), `auto()` approval, `evaluate`, `auto` model routing, model catalogue lookup at compile time, dollar cost limits | **AI Gateway** | Pass AI SDK model objects (Lares already does via LiteLLM); configure a global AI SDK default provider for `auto()`/`evaluate`; avoid built-in `web_search` |
| `vercel()` sandbox, Drives, credential brokering at firewall, domain allow-lists | **Vercel Sandbox** | `docker()` honours only allow-all / deny-all; `microsandbox()` does domain allow-lists and brokering locally (needs KVM) |
| Agent Runs observability | Vercel dashboard | OTLP to Langfuse; `eve traces` locally |
| Schedules as Vercel Cron; deployment handoff of idle sessions; `defineWorkspaceAgent` default transport; `vercelOidc()` route auth; self-modification draft PRs via Connect GitHub connector | Vercel platform | Nitro schedule runner under `eve start`; explicit peer transports; `oidc()`/JWT/basic auth; GitHub PAT (`{ pat: true }`) |
| **CLI telemetry** (since 0.52.0) — every `eve` CLI command posts to `https://telemetry.vercel.com/api/eve-cli/v1/events` (`cli/telemetry/flush.ts:1`, wired in `cli/run.ts`) unless disabled | Vercel | `EVE_TELEMETRY_DISABLED=1` in every image, CI job and dev shell, or `eve telemetry disable`. **This directly contradicts Lares's "nothing phones home" rule** if an upgrade ships without it — `eve start` runs in every agent container. Sealed egress would block it, CI would not |
| Sandbox base image pulled from `ghcr.io/vercel/eve:<version>` | GitHub (US) registry | Mirror by digest into Lares's own registry; set `image` explicitly |

---

## PART B — The eight questions, for eve as a framework

### 1. MEMORY

**Truth vs index.** eve stores nothing itself. It defines a *slot* and a *lifecycle*; the provider owns storage, retrieval, ranking, retention and deletion (docs/memory/overview.mdx table "eve owns / The provider owns"). For the built-in `fileMemory()` the truth is one markdown document per scope at `<prefix>/<scope key>/MEMORY.md`; for Supermemory/Upstash/Arcana the truth is the vendor's hosted store. What lives in the eve session (recalled messages, locked scopes) is a cache: `clear()` wipes it and "a later turn recalls the same data again".

**The slot's exact interface** (docs/memory/custom-provider.md; `packages/eve/src/public/memory/index.ts`):

```ts
// agent/memory/<slot>.ts  (or agent/memory.ts for a single slot)
defineMemory({ provider, scope, description?, namespace?, visibility? })

defineMemoryProvider({
  recall:  { "turn.started"(ctx): {messages:[{id?, content}]} | null,   // required
             "compaction.completed"?(ctx) },
  capture: { "turn.completed"?(ctx), "compaction.requested"?(ctx) },
  tools?(ctx): Record<string, defineTool(...)> | null,
})
```

Every handler gets `memory.scope.key` (opaque digest of namespace + scope — "use it as the partition key for every read and write"), `memory.scope.namespace`, `memory.scope.value`, `memory.slot`, `messages` (projected history), `operationId` (stable idempotency key; eve may replay), `abortSignal`, `session` (id, auth). `turn.*` phases add `turn.id / input / sequence`.

**What the framework does automatically:**
- Before every turn: resolves and locks the scope for all slots, calls `recall["turn.started"]` on each with the same pre-recall history, commits all results atomically. **Recall is every turn, not by tool call.**
- Injects recalled content "as user-role messages attributed to the slot, never as system instructions".
- Supersession: a message with a stable `id` replaces the earlier one with that id; messages without ids accumulate; "recall cannot retract, only supersede".
- After every successful turn: calls `capture["turn.completed"]` with settled history (a throw is logged, turn not rewritten).
- Exposes provider tools as `<slot>__<tool>`, closed over the locked scope so "it cannot be redirected to another tenant or caller by the model"; they honour approvals and survive restarts.
- Compaction: calls `capture["compaction.requested"]` first, **excludes recalled records from the summariser**, keeps latest keyed values, then re-recalls. Force-canonicalises past 512 entries / 256 KiB.
- Failure: a throwing recall **fails the turn before the model call**; a throwing `tools()` just drops the tools for that turn.
- eve does **not** truncate or expire provider content; limits are only on ids/namespace/scope sizes.

**Can a self-hosted Postgres or file provider be written against it? Yes, directly.** The docs say so ("a Postgres table, a vector index, a key-value store, or an HTTP API") and the example provider is ~40 lines. Two levels:
- *Just change where `fileMemory` stores its document*: implement `MemoryDocumentBackend` — two methods, `read({key})` and `write({key, content, expectedVersion})` with optimistic versioning via `MemoryDocumentConflictError` (`public/memory/file/backend.ts:30-33`). A Postgres row or a git-tracked file fits.
- *Own the retrieval*: write a `defineMemoryProvider` whose `recall` runs a Postgres / pgvector / keyword query over Lares's OKF markdown and returns the top-k notes with their note ids as message ids; `tools` exposes save/forget behind Lares's approval gate.

**Correcting and forgetting.** Provider-defined. `fileMemory` gives the model `save_memory` / `remove_memory` with permanent numeric indexes; rejects writes beyond limits "instead of truncating or evicting" (4,000 chars recalled, 2,048 bytes per entry, 65,536 bytes per document). Docs recommend instructing the model: "Tell the user when you save or delete a memory."

**Consolidation / dreaming.** None in eve. No scheduled reflection, no summarising of memory. Only conversation compaction (threshold 0.9 of context, summarised by the turn model). Hosted providers do their own extraction ("captures completed turns automatically"). Lares's nightly dream cycle has no upstream equivalent — it would live in a schedule plus the provider's write API.

**Owner visibility.** Not addressed by eve. `fileMemory` on Blob is a markdown file the owner could open; nothing in the dev TUI or docs shows or edits memory.

**Scale.** `fileMemory` is deliberately tiny (one 64 KB doc per scope, whole doc recalled every turn). Thousands of notes means a custom or hosted provider; docs require semantic providers to "include the key in the query itself, not as a filter after a global search".

**Per-user scoping.** First-class and the best part of the design. `scope` is a string, tuple (≤16 parts), `null`, or a resolver over trusted session auth — "never from model input". `null` disables the slot "and never falls back to a shared scope". `byPrincipal` = per authenticated user, off for anonymous/runtime principals. `namespace` separates app domains; `visibility: "scope" | "session"` decides whether earlier recalled messages stay visible if the scope changes mid-session (docs/patterns/multi-tenant-memory.md). Private vs shared = two slots (`profile` by principal, `workspace` by org).

**Design doc:** `research/first-class-memory.md` (1,303 lines) records rejected alternatives — worth reading before Lares designs its own memory contract.

### 2. INTEGRATIONS

- **Places touched:** one file. `agent/connections/<name>.ts` (MCP or OpenAPI), `agent/channels/<name>.ts`, `agent/memory/<name>.ts`, `agent/tools/<name>.ts`. The filename is the runtime name; the compiler discovers it. Plus env vars.
- **Kind:** MCP (`defineMcpClientConnection`) and OpenAPI 3.x (`defineOpenAPIConnection` — one tool per operation, with operation filters) are the two first-class routes; anything else is a hand-written `defineTool`. The model does not see all connection tools up front: it uses a built-in `connection_search` and calls `<connection>__<tool>`.
- **Tokens:** `auth.getToken()` runs on each connection attempt in the trusted app runtime; "cached per step and never serialized to durable state", never in history, never shown to the model. `expiresAt` triggers early refresh. `headers` for API-key schemes. Per-caller `auth`/`headers` functions. `credentialOwner: "app" | "user"`; user-scoped without a user principal fails with `principal_required` rather than falling back.
- **OAuth:** two paths. Vercel Connect (`connect("notion")` — hosted consent, encrypted storage, refresh) or **self-hosted** `defineInteractiveAuthorization` — three methods; eve mints a callback URL, parks the turn durably on a framework-owned webhook, resumes when the token arrives (docs/connections/overview.mdx "Self-hosted interactive OAuth"). Needs a reachable callback URL.
- **Write approval:** `approval: once() | always() | never() | auto() | policy` on a tool **or on a whole connection**; policy gets `{toolName, toolInput, approvedTools, callId, session}` and can return `approved`/`denied`/`user-approval`. Per-tenant pattern in docs/patterns/multi-tenant-approvals.md. No built-in read/write classification of MCP tools — `approval: always()` on a connection gates reads too unless you write a policy keyed on tool name.
- **Registry / scaffold:** `eve add <category>/<name>`; `eve registry list|search|view|add`. Format is the **shadcn registry** (static JSON: `registry.json` + one JSON per item with `files[].target`, `dependencies`, `envVars`, and `meta.eve.setup` + `meta.eve.requires: ">=0.29.0"`). Third-party sources via `eve registry add @acme=https://…/r/{name}.json`, stored in `package.json#registries`. `--non-interactive` prints NDJSON with exit code 2 = "needs an answer" and a `next.command` — designed for coding agents.
- **Quality ladder:** official catalogue (105 items: 45 connections, 26 channels, 13 tools, 8 instrumentation, 7 extensions, 4 memory) → third-party namespaced registries → `@skills` (skills.sh, "community-authored… review their source"). No certification tiers; the docs' answer is "inspect with `eve registry view` and review the diff". Official contributions need an issue + maintainer agreement first.
- **Extensions** (`docs/extensions.md`) are the package-level plugin: a namespaced bundle contributing tools, skills, instructions, subagents (0.38.1), channels and schedules (0.38.0) — but **not** memory slots or instrumentation. Built with `eve extension build`; must be rebuilt when capability contracts change (0.50.0).

### 3. FIRST RUN

eve's recommended path (docs/getting-started.mdx): Node 24 + `npx eve@latest init my-agent` → scaffolds, installs, `git init`, **opens a terminal chat (TUI) immediately** → `/login` connects a model (ChatGPT subscription, Vercel account, AI Gateway / OpenAI / Anthropic key; "You do not need a Vercel project to start chatting") → first message. Roughly 2–5 minutes; the only prerequisite is a model credential. Everything else is deferred: `/add` inside the chat installs channels and integrations later, `/model` switches model, `/info` shows config. First door = **CLI chat**, then Web Chat, then Slack.

Notable details: the composer accepts your first message *while the agent is still building* and sends it when ready (0.56.0, 0.57.0); failed `eve init` cleans up after itself (0.37.1); setup failures are classified into bounded categories; `placeholderAuth()` keeps a half-configured app closed in production; `eve info` / `/info` prints diagnostics; `eve dev https://your-agent` attaches the TUI to a deployed agent as the verification step. Validation is compile-time: unknown files, missing subagent descriptions, unresolved workflow imports fail `eve build`.

Self-hosted first run (docs/guides/deployment/self-hosting.md) is a short page: `eve build && eve start`, persist `.eve/.workflow-data` or pick a world package, pick a sandbox backend, proxy **both** `/eve/` and `/.well-known/workflow/` ("a proxy restricted to `/eve/` lets a session start, but the run stalls"), `curl /eve/v1/health`. No installer, no compose file, no Postgres guidance — self-hosting is supported but clearly second-class.

### 4. DEFINING AN AGENT

Filesystem-first, mostly code. `agent/agent.ts` (`defineAgent({ model, limits, compaction, defaultTools, tool, experimental })`), `agent/instructions.md` (or `.ts`), and folders `tools/ skills/ connections/ channels/ memory/ schedules/ subagents/ sandbox/ hooks/ extensions/ instrumentation/`. Skills and markdown schedules are markdown + YAML frontmatter (JS frontmatter engines disabled — "authored markdown is data"). An instructions-only agent is valid, so a non-developer can edit `instructions.md`, but anything beyond that is TypeScript. No JSON agent definition, no console.

Permissions are expressed as *which files exist* plus approval policies — there is no grants/capability/autonomy model. Lares's `agent.json` + runtime resolution has to be built on `defineDynamic` (tools, skills, instructions, model, subagents, connections — resolvable at `session.started` / `turn.started` / step), which is exactly how ADR-0015 uses it.

Subagents / agent-to-agent: (a) built-in root-only `agent` tool = a background copy of itself sharing sandbox; (b) declared subagents under `agent/subagents/<id>/` — inherit **nothing**, own tools/connections/skills/sandbox, `description` mandatory, shown to the parent as a tool `{message, agentId?, outputSchema?}`; the child never sees parent history; (c) remote agents over HTTP with auth forwarding; (d) workspace peers (`agents/<name>/`, `defineWorkspaceAgent`) — default transport is Vercel-only; (e) `defineWorkflowTool` + `ctx.agent()` for deterministic orchestration; `agentRouter()` (0.60.1). Child budgets are a share of the parent's remaining quota. Child approvals surface on the parent's channel.

### 5. MORE THAN ONE PERSON

eve has principals, not users. Route auth (`vercelOidc`, `httpBasic`, `oidc`, JWT, custom `AuthFn`) and channel auth produce `session.auth.current` and `session.auth.initiator` with `principalType` (`user` / `runtime` / app), `principalId`, `attributes` (e.g. `tenantId`). Everything keys off that: memory scope, connection credential owner, approval request policy, and the approval **response** policy (`responder.principalId` — "who may click Approve", docs/tools/human-in-the-loop.md "Authorizing approval responses"). Slack `onInputResponse` and `approvalChannel: "direct-message"` keep sensitive approvals private. No users table, roles, orgs or admin UI — that is the application's job. Patterns: docs/patterns/multi-tenant-{auth,approvals,memory}.md.

### 6. SAFETY

- **Prompt injection:** acknowledged, not solved. Recalled memory is user-role and documented as "untrusted, user-controlled data"; pending approvals are marked trusted runtime state (0.45.2); framework-authored messages carry provenance (`context.instruction`, `execution.background_task`, 0.54.0); `web_fetch` has SSRF checks per redirect. No content firewall, no tainting.
- **Sandbox / trust boundary** (docs/concepts/security-model.md): app runtime holds `process.env`, tools and connections run there; the sandbox runs only shell commands, no secrets. Backends: Vercel Sandbox (microVM), Docker, microsandbox (local VM), just-bash (simulated; "no network isolation"). Commands run as non-root `vercel-sandbox`.
- **Egress:** sandbox default `allow-all`. `deny-all` or allow-list per backend; Docker only does all/none. The **app runtime's network is "Unrestricted"** — eve has no answer for tool-level egress; Lares's allow-list proxy is outside anything eve offers and should stay.
- **Secrets:** tokens cached per step, never in durable state; BYOK credentials redacted from `/eve/v1/info` (0.52.5); credential brokering injects headers at the sandbox firewall (Vercel/microsandbox only).
- **HITL:** durable park for "seconds or days"; approval default is **`never()`** — "omitted `approval` behaves like `never()`". `once()`, `always()`, `auto()`, custom policy, response authorisation. Docs' own advice: gating a side effect on approval "is also how you make non-idempotent work safe across replays". A step interrupted mid-execution **re-runs** — emails/charges need idempotency keys (`callId`) or approval.
- Auth fails closed; constant-time signature checks on Slack/GitHub/Telegram/Twilio.

### 7. COST AND VISIBILITY

Per-session caps: input tokens (default 40M), output tokens, USD (AI-Gateway-reported cost only), session timeout (30 days default). Crossing a cap pauses with an Approve/Stop prompt; unattended runs fail with `SESSION_TOKEN_LIMIT_REACHED`. No per-agent or per-day budget, no spend dashboard outside Vercel. Tracing: OpenTelemetry GenAI conventions, local spool + `eve traces` viewer, destinations (Braintrust, Datadog, Honeycomb, Langfuse-via-OTLP), content redaction by audience. Failures: semantic error summaries (recognises gateway credit/budget refusals, content filters), callback failures logged with redacted destinations, `errorId` correlation on MCP. For a self-hosted owner, "what went wrong" is logs plus whatever OTLP backend they run.

### 8. COMMUNITY

- **Licence:** Apache-2.0 + NOTICE; DCO sign-off; CODE_OF_CONDUCT, SECURITY.md (private disclosure). Apache-2.0 code can be copied into an AGPL-3.0 project (keep notices); the reverse is not true, which matters for upstreaming Lares code — contribute patches under Apache-2.0/DCO.
- **Cadence:** changesets; ~1.7 releases/day; a "minor" every 1.4 days, and minors carry breaking changes. 19 prereleases/canaries besides. Many PRs are agent-authored (a bot triaged #1981 and opened a draft PR within hours — which then stalled for 5 weeks).
- **Stability promises:** none beyond "public beta… may change before general availability". Experimental surface is flagged three ways: an `experimental:` key in `defineAgent` (`experimental.workflow.world`, `.retention`, `.modelCallsPerStep`, `.tasks`), `experimental_` name prefixes, and `eve/experimental/*` import paths — all of which get promoted or deleted without deprecation windows (0.56.0 removed `experimental_workflow`; 0.60.0 deleted `eve/experimental/evaluate` two days after adding it). **Note: the Postgres world Lares depends on is configured under `experimental.workflow.world`** — self-hosted durable storage is itself an experimental feature, on a `5.0.0-beta` dependency line.
- **Durable-format discipline is the exception:** session inbox payloads are a "validated, versioned wire format" with forward migration and rejection of unknown versions (0.39.3); stream protocol is versioned (v24 at 0.46.1); old-session import paths are written and documented. They break APIs freely but work hard not to corrupt stored sessions.
- **Docs:** tutorial → concepts → guides → patterns → reference; every page ends with "What to read next"; docs ship inside the npm package (that is why Lares has a local `docs/` copy) so coding agents read version-matched docs. `research/` holds a design doc per feature. `AGENTS.md`/`CLAUDE.md` in scaffolds tell coding agents which doc to read.
- **"What works and what doesn't":** honest at the README level (beta, review your tools before production) and in `docs/responsible-use.md`; weak for self-hosters — the open p1 list (#535, #1450, #1981, #2425, #2876, #1869) is where the real state of `eve start` + Postgres/local world is recorded, and it is not reflected in the docs.

---

## Upgrade policy Lares should adopt

1. **Stop treating an eve bump as rare.** At this cadence, five weeks = 28 minors and a re-derivation of the whole patch. Adopt a **fixed monthly bump** (plus an out-of-band bump for any approval/auth fix in the changelog). Monthly keeps each jump to ~20–25 minors of changelog — about an hour of reading — and stays inside upstream's session-import windows (0.57 only imports sessions from ≥0.45, i.e. ~3 weeks back).
2. **Read only the "Minor Changes" blocks first**; they are the breaking list. Grep the changelog for `approval`, `auth`, `replay`, `world-postgres`.
3. **Bump eve and `@workflow/world-postgres` together**, to the beta line eve's `package.json` pins.
4. **Upgrade at night, approvals drained**; treat every bump as "all sessions restart". Never plan on rollback across an execution-model boundary.
5. **Shrink the patch by upstreaming it.** Five small, objectively useful PRs: (a) approval prompt uses `label.start(input)` when present, with a hook for details; (b) Slack binding tracks channel id changes; (c) user-visible notice when a HITL click/tap cannot be delivered (ties to open p1 #1869); (d) Telegram prefers the declared media type over `octet-stream`; (e) image inline allow-list + a hook for non-image attachments. Apache-2.0 + DCO. Until then, keep the patch but generate it from a script against source maps / a fork branch rather than hand-editing minified `dist/`.
6. **Chase #1981 / PR #1983.** It is accepted p1 with a written fix that nobody merged. A human nudge (or taking over the PR) removes F1's 15 minutes for every self-hoster.
7. **Add to the release checklist:** `EVE_TELEMETRY_DISABLED=1` present in every image and CI job; sandbox image mirrored by digest; `defaultTools: false` + fence test; trace policy written (content is off by default now); `recordInputs`/`recordOutputs` gone.
8. **Hedge the dependency.** Self-hosted durability sits behind `experimental.workflow.world` on a beta line with open p1 bugs, in a three-month-old beta framework whose commercial gravity is Vercel hosting. Keep Lares's own contracts (agent.json, grants, memory, approval summaries) framework-neutral so eve stays swappable, as ADR-0016 already intends for models.

---

## Patterns worth stealing

| Pattern | Where |
|---|---|
| **Memory as a slot with a fixed lifecycle** — framework owns scope/namespace/when; provider owns storage. Recall before every turn, capture after, tools closed over the locked scope, `null` scope disables and "never falls back to a shared scope" | docs/memory/overview.mdx; `research/first-class-memory.md` |
| **Stable ids on recalled facts → supersession instead of accumulation**; recalled records excluded from the compaction summariser so memory never dissolves into chat history | docs/memory/custom-provider.md "Recall results", "Lifecycle" |
| **Recalled memory enters as user-role, attributed, never system** — and the docs tell you to say so in the instructions | docs/memory/overview.mdx "Tell the model how to use memory" |
| **`operationId` idempotency key on every memory/tool/instrumentation callback**, `callId` for connection calls | custom-provider.md; CHANGELOG 0.46.1, 0.34.0 |
| **One file = one integration, name from path**; model discovers connection tools through `connection_search` instead of loading hundreds of schemas | docs/connections/overview.mdx |
| **shadcn-format static registry** with `meta.eve.requires` minimum version, `envVars`, and a declared setup flow; third-party namespaces in `package.json#registries` | docs/install-integrations.mdx; `apps/docs/registry.json` |
| **`--non-interactive` setup protocol**: NDJSON events, exit code 2 = needs an answer, `next.command` to resume, secrets never via flags | docs/install-integrations.mdx "Automate setup" |
| **First run = chat first, configure later** (`/login`, `/add`, `/model`, `/info` inside the chat; composer usable while building) | docs/getting-started.mdx; CHANGELOG 0.56–0.57 |
| **Approval response policy** — authorise the clicker, leave the request pending for another approver on rejection; approvals routable to a private DM with a preview of the triggering message | docs/tools/human-in-the-loop.md; docs/channels/slack.mdx "HITL" |
| **`auto()` approvals** — a small evaluation model classifies clear/caution and **fails closed to the human**; a possible rung on Lares's ratchet between ask-first and autonomous (needs a self-hosted judge model via the gateway) | human-in-the-loop.md; `research/automatic-tool-approval.md` |
| **Input-aware tool labels** (`label.start(input)`) as presentation-only metadata | docs/tools/overview.mdx:37-101 |
| **Budget prompts as HITL** — crossing a cap pauses with Approve/Stop rather than erroring; children get a share of the parent's remaining quota | docs/agent-config.md "Runtime limits" |
| **Versioned durable wire formats with forward migration, fail closed on unknown versions** | CHANGELOG 0.39.3; `research/session-inbox-wire-schema.md` |
| **Docs shipped in the npm package + a `research/` design doc per feature** | repo root |
| **Audience classification (public/private/unknown) deciding what telemetry may contain** | CHANGELOG 0.44–0.56; `research/channel-audience-content-policy.md` |
| **`placeholderAuth()`** — scaffold ships closed in production until replaced | docs/concepts/security-model.md |

## Traps they hit

- **API churn as a lifestyle.** `eve/experimental/evaluate` added 0.59.0, deleted 0.60.0. `task_peek`, `task_sleep`, `task_send`, `task_update`, `task.delegated()` each added and removed within ~3 weeks (0.37–0.54). Uppercase `Workflow` tool → lowercase `workflow` factory. `rekey` → `alias`.
- **Execution model rewritten twice in five weeks** (0.48.0 same-deployment turns; 0.57.0 single workflow per session) with a one-way session migration and "transparent rollback… is unsupported".
- **Dynamic tools took ~10 releases to make durable** (0.39.2 → 0.59.0): byte-offset callback identity replayed the wrong tool after an edit (fixed 0.44.1), cross-session callback bleed (0.52.3), lost approval keys (0.52.2), crash on old sessions (0.47.7). Lares's "broken fallback executor" was this.
- **Approval correctness bugs shipped and were fixed later**: sibling auto-approval (0.50.0), repeated tool execution after sequential approvals (0.47.4), approved calls not executing (0.50.0), dropped approvals alongside subagent calls (0.35.0), fabricated tool results after follow-ups (#2466).
- **Telemetry defaults reversed**: content on → off (0.35.0) → public-only (0.44.0) → emit-all-metadata (0.46.0) → policy objects (0.60.0), removing `recordInputs` with a throw.
- **Self-hosting is the neglected path**: #535 (open since 2026-07-04), #1450, #1981 (draft fix unmerged 5 weeks), #2425 (double billing on world-local timeouts), #2876 (long sessions wedge at the 240 s replay ceiling — relevant to Lares's day-long sessions), #707 (no external-cron mode), #2055 (proposal to replace Nitro).
- **Default model changed three times** (Claude Sonnet 5 → `zai/glm-5.2` at 0.36.0 → `openai/gpt-5.6-luna-fast` at 0.47.2) — config-less agents silently change brain on upgrade. Lares is immune (gateway alias) but it shows the posture.
- **CLI telemetry added in a minor** (0.52.0), opt-out.
- **`fileMemory` Blob backend** needed three fixes (0.51.0 weak ETags, 0.51.0 CLI 57, 0.52.2 OIDC) — the built-in memory was designed around Vercel Blob first.

## Verdicts for Lares

| Idea | Verdict | Why |
|---|---|---|
| Upgrade 0.32 → 0.60.x soon, then monthly | **Adopt** | Missing approval-safety fixes (A2) outweigh the migration cost; gap only grows |
| `EVE_TELEMETRY_DISABLED=1` everywhere | **Adopt (mandatory)** | Otherwise breaks "nothing phones home" |
| `defaultTools: false` + `tool: false`, delete most `disableTool()` stubs | **Adopt** | Shrinks F3's surface; keep the fence test |
| eve memory slot as the *injection seam* for Lares memory (custom `defineMemoryProvider` over OKF markdown + Postgres/pgvector; `profile` slot by principal, `atlas` slot by org) | **Adapt** | Runs on the owner's server, no vendor; replaces the hand-rolled "standing facts, cap 40" injection with a lifecycle that survives compaction and scopes per user. Keep markdown in git as the truth; the provider is the index/recall layer. Put a neutral Lares memory contract underneath so it isn't eve-shaped |
| `fileMemory()` with a Postgres/file `MemoryDocumentBackend` for a small per-person "profile" note | **Adapt** | 2-method backend; good for standing facts; too small for Brain/Atlas |
| Supermemory / Upstash / Arcana providers; Vercel Blob backend | **Ignore** | Hosted, US cloud in the data path |
| Dream cycle from eve | **Ignore (nothing there)** | eve has no consolidation; keep Lares's, write through the provider |
| MCP/OpenAPI connections + `defineDynamic` connections for user-added tools, with per-connection approval policy | **Adopt** | Matches Lares's plan ("MCP for user-added tools"); tokens stay in the runtime; one file per integration |
| `defineInteractiveAuthorization` for OAuth | **Adapt** | Self-hosted, but needs an inbound callback URL — same constraint as F2; route via the relay |
| Vercel Connect, `connect()` registry items, guided Slack/Teams setup | **Ignore** | Vercel-hosted token vault and webhook forwarder |
| Official registry as a catalogue of MCP endpoints; shadcn registry format + `requires` + NDJSON setup protocol for Lares's own integration/agent registry | **Adapt** | Format is static JSON any EU host can serve; Apache-2.0 |
| Approval response policy + `approvalChannel` DM routing | **Adopt** | Foundation for multi-user "who may approve what" |
| `auto()` approvals as a ratchet rung | **Adapt, later** | Must point at a gateway-hosted judge, not AI Gateway; fails closed, which fits |
| `label.start(input)` on every Lares tool; upstream PR to use it in approval prompts | **Adopt + contribute** | Removes two patch hunks if accepted |
| Keep `patches/eve.patch` | **Adopt (for now)** | No hunk has landed upstream; rewrite `rekey`→`alias` |
| Chat SDK Slack adapter in socket mode through `chatSdkChannel` to kill the relay (F2) | **Spike** | Unverified inside eve; loses first-class Slack HITL features; needs durable state adapter |
| Web Chat channel (`channel/web`) as Lares's planned web door | **Adapt** | Generated Next.js app, self-hostable, resumable sessions, approvals as forms; skip "Sign in with Vercel" |
| MCP channel (eve agent callable as an MCP server) | **Adapt, later** | Lets the owner's other tools (Claude, IDE) drive Lares agents with the same approvals |
| Date via `turn.started` user-role dynamic instruction | **Adopt** | Replaces the workaround with the supported seam |
| `maxTokenCostUsdPerSession` | **Ignore for now** | Inert without AI-Gateway-reported cost; use token caps + LiteLLM budgets |
| Budget-exceeded → Approve/Stop prompt pattern | **Adapt** | Good UX for a spend cap the owner can see |
| Vercel Sandbox / Drives / credential brokering | **Ignore** | Vercel-hosted; microsandbox is the local equivalent if KVM is available |
| Agent Runs | **Ignore** | Vercel-hosted; stay on OTLP → Langfuse, write the new `exportPolicy` |
| Workspace peers (`defineWorkspaceAgent`) for agent-to-agent | **Ignore for now** | Default transport is Vercel-only; declared/remote subagents suffice |
| "Chat first, configure later" first run; `/add` from inside the conversation | **Adapt** | Lares's 10-step wizard + 69 settings is the opposite; aim for one model key → first conversation, everything else deferred |
| Versioned durable wire formats; docs shipped in the package; `research/` design docs | **Adopt** | Cheap disciplines, directly applicable to agent.json and the memory contract |

## Contradictions with what Lares does or plans

1. **"Pinned and patched, never tracked loosely" (ADR-0016) is losing.** Five weeks cost 28 minors, several approval-safety fixes, and a full patch re-derivation. Pin exactly, yes — but bump on a calendar.
2. **"Nothing phones home"** is violated by default on any eve ≥ 0.52.0 unless telemetry is disabled.
3. **Lares injects standing facts itself every turn (cap 40);** eve now has a first-class seam for exactly this, with per-user scope and compaction safety. Keeping the hand-rolled path means fighting the framework at compaction time.
4. **Lares instrumentation uses `recordInputs`/`recordOutputs`** — removed; throws at boot on 0.60.
5. **F1 is described as "defective upstream, accepted".** It is an accepted p1 with a ready draft fix — it is a stalled PR, not a design limitation. Worth one push.
6. **ADR-0015 relies on `defineDynamic`;** upstream's durability rules for dynamic tools (inline callbacks, JSON closures, durable schemas, rebuilt extensions) are now strict and enforced at resolution — the agent-kit extension must be built the upstream way or tools get rejected.
7. **Self-hosted Postgres durability is an `experimental.*` option on a beta line** — the foundation Lares is about to open-source on is officially experimental. The README for Lares should say so.
