# 02 — OpenClaw (research for LAR-71, 2026-09-18)

## Header

| Fact | Value |
|---|---|
| Source | OpenClaw — self-hosted personal/team AI assistant (lineage per VISION.md: Warelay -> Clawdbot -> Moltbot -> OpenClaw) |
| Repo | https://github.com/openclaw/openclaw (docs: https://docs.openclaw.ai, registry: https://clawhub.ai) |
| Default branch / commit | `main` @ `3a2dbb6f`, committed 2026-09-18T15:41Z (the repo is pushed to many times per day) |
| Latest release | `v2026.7.33` published 2026-09-18 (this is the trailing "extended-stable" month line); newest stable line is `v2026.9.4`, 2026-09-11. Eight non-beta releases between 2026-08-31 and 2026-09-18 |
| Licence | MIT, "Copyright (c) 2026 OpenClaw Foundation" (`LICENSE`; GitHub reports NOASSERTION only because of the header shape). MIT code may be copied into an AGPL-3.0 project with the notice kept |
| Size | 390,031 stars, 81,996 forks, 4,984 open issues, 2,857 open PRs (gh, 2026-09-18). Repo created 2025-11-24 |
| Stack | TypeScript, Node 24.16+/26.1+, pnpm monorepo; 168 entries under `extensions/` (channels, model providers, memory engines, tools) |

**What I read (all via `gh api`, nothing cloned):** `docs/concepts/{memory,memory-architecture,memory-builtin,memory-search,dreaming,memory-provenance,multi-user,multi-agent,agent-workspace,usage-tracking}.md`, `docs/gateway/security/{index,prompt-injection,access-control,secrets-and-storage,trust-model}.md`, `docs/gateway/{sandboxing,doctor,configuration,telemetry}.md`, `docs/tools/{skills,mcp,exec-approvals}.md`, `docs/plugins/community.md`, `docs/automation/{imap,cron-jobs/gmail}.md`, `docs/start/{getting-started,wizard}.md`, `docs/install/development-channels.md`, `docs/maturity/taxonomy.md`, `CONTRIBUTING.md`, `VISION.md`, `LICENSE`, the file tree of `extensions/memory-core/src`, `extensions/sms`, manifests of `extensions/sms` and `extensions/imap`, `src/cli/clawhub-install-confirmation.ts`, the full list of published GitHub security advisories, and the most-commented memory issues.

**Code-over-README checks done:** the memory claims (SQLite index, dreaming, provenance, forget, standing intents, workspace lock) are backed by matching source files in `extensions/memory-core/src/` (e.g. `dreaming-consolidation.ts`, `short-term-promotion-scoring.test.ts`, `memory-forget.ts`, `memory-entry-origins.ts`, `standing-intents.ts`, `memory-workspace-lock.ts`, `flush-plan.ts`). I did not read the function bodies line by line.

**Unverified:** the ClawHub registry code itself (separate service, not in this repo); the numbers in third-party security write-ups (135,000 exposed instances, 1,184 malicious skills) — these come from security-vendor blogs, not from the project; whether a hard spend cap exists (I found none in the docs tree, only usage reporting); actual minutes for first run (their docs claim "about 5 minutes").

---

## 1. MEMORY

**Truth = plain markdown files in the agent's workspace. Index = one SQLite database per agent.** Design principle 1 in `docs/concepts/memory-architecture.md`: "No hidden state. The model only remembers what is written to files."

Tier model (same doc, "The tier model" table):

| Tier | Files | Who writes | Put in the prompt? |
|---|---|---|---|
| Instructions | `AGENTS.md`, `SOUL.md`, `IDENTITY.md` | Human only | Always |
| Curated core | `MEMORY.md` (facts/decisions), `USER.md` (preferences as "Always/Never/Prefer" directives, 4,000-char budget) | Background consolidation, or direct owner request | At session start, budgeted; truncated copy if too big, file on disk left intact |
| Episodic | `memory/YYYY-MM-DD.md` daily notes, session transcripts | Agent while working; pre-compaction flush; transcript capture | Never automatically — search only |
| Prospective | "standing intents" in SQLite + cron jobs | `intent` tool | Only when a trigger fires |
| Review | `DREAMS.md` | Consolidation phases | Never — for the human |

**Index/cache:** `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`. FTS5 keyword (BM25) + vector embeddings, optional `sqlite-vec`, 400-token chunks with 80 overlap, file watcher re-indexes 1.5 s after an edit, `openclaw memory index --force` rebuilds (`docs/concepts/memory-builtin.md`). Embedding providers: OpenAI (default, `text-embedding-3-small`), Gemini, Voyage, Mistral, Bedrock, DeepInfra, Ollama, LM Studio, GitHub Copilot, generic OpenAI-compatible endpoint, or a managed local llama.cpp GGUF model (~0.3 GB). With no embedding provider it silently works keyword-only; if you *named* a provider and it breaks, search reports "unavailable" rather than quietly degrading (`docs/concepts/memory-search.md`).

**Recall — two lanes split by cost** (`memory-architecture.md`, "Recall: two lanes"):
- Lane 1, every turn, zero model calls: (a) the curated files at session start; (b) `memory_search` tool ranking = hybrid relevance x recency decay (30-day half-life for daily notes, curated files never decay) x a 1–10 importance score assigned once at write time, then MMR de-duplication; (c) "trigger injection" — curated entries can carry `<!-- trigger: gateway setup, network safety --> <!-- importance: 9 -->` trailing comments; each inbound message is matched against triggers and at most 3 entries (score >= 0.72) are injected. Only curated-tier entries may auto-inject — "a security property, not a tuning choice".
- Lane 2, escalation: a blocking recall sub-agent ("Active memory") that runs only when the message shows recall intent AND lane 1 found nothing strong.

**Tools:** `memory_search`, `memory_get` (file or line range), `intent`. Provided by whichever memory plugin is active (default `memory-core`; alternatives: Honcho, LanceDB; an extra `memory-wiki` plugin compiles an Obsidian-friendly wiki with claims/evidence/contradiction tracking).

**Automatic memory flush before compaction** (`docs/concepts/memory.md`): before the conversation is summarised, a silent turn on a private copy of the conversation tells the agent to save unwritten facts to the daily note. On by default, can be pinned to a cheap local model (`agents.defaults.compaction.memoryFlush.model`), skipped when the sandbox is read-only.

**Consolidation ("dreaming")** — `docs/concepts/dreaming.md`, code in `extensions/memory-core/src/dreaming-*.ts` and `short-term-promotion-*.ts`. On by default, one managed cron job. Three phases: light (stage/dedupe), REM (themes), deep (promote). Promotion passes two gates in order:
1. A deterministic gate: weighted score of retrieval relevance, recall frequency, query diversity, recency, multi-day recurrence; thresholds `minScore`, `minRecallCount`, `minUniqueQueries` must ALL pass. "Memory graduates because it kept being useful, not because it was written confidently."
2. One tool-free model call that returns *operations* (add / merge / supersede), not prose. Code applies them. The rewrite is rejected if it fails to parse, exceeds the prompt budget, or loses more than a bounded fraction of existing entries (`maxPriorEntryLossFraction`); fallback is append-only. The previous `MEMORY.md` is stored before every accepted rewrite; a diff-style summary goes to `DREAMS.md`. Writes use a content-hash check + atomic rename, so a human editing the file in an editor wins over the background job.
Model cost: one small completion per sweep plus an optional diary completion — the expensive part (ranking) is code.

**Provenance (the most transferable idea).** Every index chunk has an origin class stored in SQLite columns the model cannot write: `owner`, `agent`, `untrusted` (web pages, tool output, non-owner chat participants), `system` (heartbeat/cron scaffolding). Unknown = untrusted, never owner. If a tool result in a turn is declared network-sourced, everything the assistant writes for the rest of that turn is tainted `untrusted`. Untrusted and system content can be stored and searched, but is structurally barred from promotion into the curated files and from auto-injection. Cron, heartbeat and sub-agent sessions produce no durable memory candidates. Recalled text is marked so it is never re-learned ("a fact recalled one hundred times stays one fact"). This grew out of user issue #7707 "Memory Trust Tagging by Source" (Feb 2026, 53 comments).

**Correcting and forgetting.** Owner edits the markdown directly (any editor, or Control UI -> Settings -> Agents -> Files). Preferences are superseded in place, never appended, because "append-only preference history reliably causes models to answer from the stale value". `openclaw memory forget --agent <id> --session <id> --dry-run` removes entries derived from a given session using recorded lineage and blocklists that session from re-ingestion; an "admission policy" keeps whole sources out. The docs are blunt that this is not full erasure (`docs/concepts/memory-provenance.md`, "What deletion does not cover").

**Scale.** Curated files are deliberately small (budgeted); everything else is reached by search. Known pain: issue #114612 (open) — index and embedding-cache tables grow without a retention policy; #91588 (open) — gateway RSS growing to 15 GB; several Active Memory timeout bugs (#73306, #86996).

**Per-user scoping.** Memory is per *agent*, not per person. `USER.md` is one user model per agent. Isolation between people = separate agents or separate gateways. Project-scoped memory exists for git repositories (`<!-- project: github.com/... -->` annotations change ranking, not storage).

**Import.** The Control UI imports memory from Codex, Claude Code and Hermes into `memory/imports/<source>/` — searchable, never merged into the curated file, with a backup first.

## 2. INTEGRATIONS

**Everything is a plugin under `extensions/<id>/`** with a manifest `openclaw.plugin.json` (id, categories, `channels`, JSON-schema `configSchema`, `uiHints` for the settings form, `configContracts.secretInputs` naming which config paths hold secrets, and `configContracts.dangerousFlags` naming which settings the security audit should flag). A channel like SMS is ~30 source files in one folder (`extensions/sms/`: `channel.ts`, `inbound.ts`, `send.ts`, `webhook.ts`, `config-schema.ts`, `secret-contract.ts`, `status.ts`…). Adding one touches one folder plus the manifest; there are SDK docs per concern (`docs/plugins/sdk-channel-inbound.md`, `-outbound.md`, `-ingress.md`, `sdk-testing.md`) and contract tests (`pnpm test:contracts:channels`). Clients are mostly hand-written against vendor SDKs per plugin.

**Quality ladder:** bundled (in repo, high bar — "Most features are not accepted and should be third party plugins", CONTRIBUTING.md) -> ClawHub community plugins/skills (scan state shown, "official publisher" status) -> npm / git / local installs. VISION.md distinguishes "code plugins" (run in-process) from "bundle-style plugins" (skills + MCP servers + config; "smaller, more stable interface and better security boundaries" — preferred).

**Skills:** a folder with `SKILL.md` (YAML frontmatter + markdown), eight precedence levels from workspace to bundled (`docs/tools/skills.md`), per-agent allowlists, filtered at load by OS/binary/config presence. `openclaw skills install @owner/slug | git:owner/repo@ref | ./path`. `openclaw skills verify` fetches a signed "trust envelope"; ClawHub pages show VirusTotal, "ClawScan" and static-analysis state; new releases stay hidden until review finishes; `security.installPolicy` lets the operator run their own policy command before any install, failing closed. Docs still say: "Treat third-party skills as **untrusted code**. Read them before enabling." A "Skill Workshop" lets the agent draft skills that a human approves.

**MCP:** first-class. `openclaw mcp add`, Control UI form, stdio/SSE/streamable-HTTP, per-server tool include/exclude filters, `openclaw mcp doctor <name> --probe` ("Saving a definition proves nothing about reachability — the probe does"), OAuth via `openclaw mcp login`. MCP tools pass through the same tool policy as built-ins. OpenClaw can also act as an MCP server (`openclaw mcp serve`).

**Tokens:** on disk under `~/.openclaw/` — config file, `credentials/**`, and two SQLite databases (model auth profiles per agent; MCP OAuth tokens in `state/openclaw.sqlite`). Permissions 600/700, checked by doctor. A `SecretRef` indirection (`{source: env|file|exec|store, provider, id}`) lets config point at a secret instead of containing it; 1Password and Vault plugins exist. No encryption at rest beyond "use full-disk encryption" (`docs/gateway/security/secrets-and-storage.md`).

**Write approval:** there is no general "outbound write needs approval" layer like Lares has. Approvals exist for shell commands (exec approvals: deny/allowlist/ask/auto/full), plugin permission requests, and device pairing. Sending messages is allowed by default, across channels ("Agents with message-tool access can send across conversations and channel providers by default").

**Email specifically:** Gmail is wired through Google Pub/Sub + the `gog` CLI + a public HTTPS endpoint (heavy). The newer bundled IMAP plugin (`docs/automation/imap.md`) is the interesting one: read-only, no public URL, each message starts an isolated session on a *restricted reader agent* (sandbox on, no workspace, no file/shell/web tools), sender allowlist checked before any model sees the mail, and DMARC verification with a strength ladder `verified > asserted > unverified > mutable` (default minimum: verified). Display names and Reply-To grant nothing; multiple From addresses are rejected.

## 3. FIRST RUN

`npx openclaw@latest` (or `curl … install.sh | bash`) -> wizard -> "Quick start" detects an existing Claude Code / Codex login or API key, **verifies it with a real completion**, saves config, opens the local web dashboard. First door = the local web chat (Control UI on port 18789) or a terminal UI; Telegram is suggested as the fastest phone channel ("just a bot token"). Claimed time: about 5 minutes. Needs: Node 24/26 and one model credential. No public URL, no database, no Docker.

Then `openclaw gateway install` makes it a background service (LaunchAgent / systemd user unit / Windows Scheduled Task). `openclaw configure` and conversational setup ("configure skills", "open channel wizard for telegram") come later; secrets are always entered in a masked terminal prompt, never in chat.

**Validation:** strict. Unknown keys or wrong types make the gateway **refuse to start** (`docs/gateway/configuration.md`, "Strict validation"). The rule in VISION.md: no long-lived aliases for old config keys; every breaking config change must ship with a `doctor --fix` migration that explains, backs up and rewrites. `openclaw doctor` has ~20 numbered checks (config, providers, state, sessions, sandbox, plugins, service, security, workspace) with `--lint` (read-only), `--fix`, `--non-interactive`. The settings form in the web UI is generated from the live JSON schema. `openclaw status --all` produces a pasteable, secrets-redacted report for support.

## 4. DEFINING AN AGENT

Configuration plus markdown; no code. One entry under `agents.entries.<id>` in `openclaw.json` (workspace, model, sandbox, tools allow/deny/profile, skills allowlist) plus workspace files: `AGENTS.md` (operating rules), `SOUL.md` (persona), `IDENTITY.md` (name/emoji), `USER.md`, `MEMORY.md`, optional `BOOT.md` (startup checklist) and `BOOTSTRAP.md` (one-time first-run ritual, deleted afterwards). `openclaw agents add <name>`. "Bindings" map a channel account to an agent. Sub-agents, agent-to-agent messaging (on by default, all pairs allowed unless `tools.agentToAgent.allow` is set), and a "swarm" tool exist. A non-developer can edit the markdown in the web UI; permissions still mean editing JSON or the generated form.

## 5. MORE THAN ONE PERSON

"One trust boundary per gateway." Multi-user mode (`docs/concepts/multi-user.md`) adds creator / owner / participants on sessions, presence, per-person model accounts and personal skill libraries — and says plainly: "Everyone who can operate an agent can make it do anything that agent can do. Session ownership… are usability features, not security boundaries." For people who must not see each other's data: separate agents or separate gateways. Chat-side: `session.dmScope` (`main` default = all DMs share one session; `per-channel-peer` for shared inboxes), `identityLinks` to merge one person across channels, operator scopes (`operator.read/write/admin/pairing`).

## 6. SAFETY

**What went wrong in public (secondary sources — security vendor blogs, figures unverified):** Jan–Feb 2026 mass exposure of gateways on port 18789 found via Shodan (SecurityScorecard reportedly counted 135,000); CVE-2026-25253, a one-click takeover where the web UI accepted a `gatewayUrl` query parameter and sent its token to an attacker; the "ClawHavoc" campaign — Koi Security audited 2,857 ClawHub skills and found 341 malicious (mostly one operation delivering the Atomic macOS Stealer), Antiy later counted 1,184 packages from 12 publisher accounts. Sources: cybersecuritynews.com/clawhavoc-poisoned-openclaws-clawhub, unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk, adversa.ai/blog/openclaw-security-101-vulnerabilities-hardening-2026, conscia.com/blog/the-openclaw-security-crisis.

**What is verifiable first-hand:** the repo has published **~722 security advisories** (gh api, paginated): 14 critical, ~250 high, the bulk in Feb–Mar 2026 (approx. 220 and 204 in those two months), still 75 in September 2026. The critical ones are almost all *authorisation-scope* bugs, not model bugs: pairing tokens that could mint admin (`GHSA-4jpw-hj22-2xmc`), reconnect widening read to admin (`GHSA-fqw4-mph7-2vr8`), a `.env` file in the working directory taking over config (`GHSA-8rh7-6779-cjqq`), sandbox escape via a file-bridge race (`GHSA-9p3r-hh9g-5cmg`), heartbeat runs inheriting owner authority (`GHSA-g5cg-8x5w-7jpm`), path traversal in plugin install (`GHSA-qrq5-wjgg-rvqw`).

**The approval-card class of bug — directly relevant to Lares.** Advisory titles: "Signal reactions could bind to the wrong approval", "Exec approval display truncation could hide the command being approved", "Shell wrapper argv could change between approval and execution", "Reusable exec approvals could authorize changed arguments", "Exec approvals could outlive their reviewed working directory", "QQBot native approval buttons did not enforce configured approver identity", "Slack plugin approvals used the exec approver gate for plugin actions", "Skill Workshop apply flow could override pending approval", "File-transfer approvals could widen durable authority". Four failure shapes: (1) what is shown is not what runs, (2) the approval is not bound to the exact payload, (3) the approver's identity is not checked, (4) an approval lives longer or wider than what was reviewed.

**What they changed / now recommend:**
- Loopback bind by default on host installs; unknown DM senders get a pairing code (1-hour expiry, max 3 pending) instead of being processed; groups allowlisted and mention-gated (`docs/gateway/security/access-control.md`). Caveat they state themselves: container images default to an exposed bind.
- `openclaw security audit` with a catalogue of check IDs and auto-fixes; plugin manifests declare their own `dangerousFlags` so the audit knows about them.
- Untrusted content wrapped in `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` markers with a security notice; chat-template control tokens (`<|im_start|>` etc.) stripped from external content because self-hosted model servers may treat them as real role boundaries; leaked tool-call scaffolding stripped from outgoing replies (`docs/gateway/security/prompt-injection.md`).
- The "reader agent" pattern: a tool-less, sandboxed agent reads untrusted content and hands a summary to the main agent. Built into the IMAP and Gmail paths.
- Model choice treated as a real mitigation: "Do not use older/weaker/smaller tiers for tool-enabled agents or untrusted inboxes."
- "Context visibility vs trigger authorization" — who may trigger the agent and whose quoted/forwarded text reaches the model are separate settings (`contextVisibility: all | allowlist | allowlist_quote`).
- Workspace `.env` files may not set provider keys, anything starting `OPENCLAW_`, or any `*_ENDPOINT` — so a cloned workspace cannot redirect traffic or swap accounts.
- Log/transcript redaction always on, cannot be disabled.
- Sandboxing (Docker, Podman, SSH, remote) exists but is **off by default** and "not a perfect security boundary". The workspace is "the default cwd, not a hard sandbox". No default outbound network allow-list for the agent.
- A published trust model with a "Not vulnerabilities by design" list — first item: "Prompt-injection-only chains without a policy, auth, or sandbox bypass." It saves triage time and tells users honestly where the line is.
- A MITRE-ATLAS-mapped threat model (`docs/security/THREAT-MODEL-ATLAS.md`), an operator incident-response page (contain / rotate / audit / collect), a gateway exposure runbook.

## 7. COST AND VISIBILITY

Reporting, not limiting. `/status`, `/usage tokens|full|cost` in chat; `openclaw status --usage`; a Usage page in the web UI showing provider-reported quota windows ("X% left") and, with Anthropic/OpenAI admin keys, real spend history; estimated per-session cost for API-key models (`docs/concepts/usage-tracking.md`). I found **no hard spend cap** in the docs tree (unverified beyond a file-name search for budget/spend/cost). Tracing: OpenTelemetry and Prometheus plugins, `/trace`, a "trajectory" tool. Failure visibility: doctor, `status --all`, `sandbox explain` and `openclaw policy` answer "why was this blocked?".

## 8. COMMUNITY

- Cadence: CalVer (`vYYYY.M.patch`), roughly two stable releases a week, four channels: stable, extended-stable (trailing month, never auto-applies), beta (every stable ships to beta first, promoted without a version bump), dev (`docs/install/development-channels.md`).
- Contribution at scale (CONTRIBUTING.md, VISION.md): bugs -> PR; features -> issue or Discord first and "most features are not accepted and should be third party plugins"; no refactor-only PRs; no test-only PRs chasing red CI; hard cap of 20 open PRs per author, auto-closed above it; PRs over ~5,000 lines not reviewed; PR body must state "What Problem This Solves" and "Evidence"; bots (ClawSweeper, Barnacle) triage; CODEOWNERS routes; support goes to Discord, not issues. Changelog generated at release time, contributors must not touch it. "Recurring demand defines interfaces": when several PRs wire the same kind of thing, land a contract and let the rest ship as plugins.
- Docs: Mintlify-style, every page has `summary` + `read_when` frontmatter (written for agents as much as humans); long pages were split into one page per reader job with the old anchors preserved on an index page.
- "What works": a generated **maturity scorecard** (`docs/maturity/`, from `taxonomy.yaml` + `qa/maturity-scores.yaml`, CI fails if stale): 50 surfaces, levels M0 Planned -> M1 Experimental -> M2 Alpha -> M3 Beta -> M4 Stable -> M5, each with a written promotion rule (M4 requires "release gate, doctor/troubleshooting path, broad docs, and repeated real-world proof"). Today only CLI and Gateway runtime are M4; security, plugins, channels, agent runtime are M3 Beta. Plus `docs/concepts/experimental-features.md`.
- Phones home: a daily update check sends version, OS, Node version, CPU architecture by default (can be disabled); anonymous feature statistics are opt-in (`docs/gateway/telemetry.md`).

---

## Patterns worth stealing

1. **Provenance on every memory, stored where the model cannot write it, with a hard rule that untrusted-origin text can never be promoted or auto-injected** — `docs/concepts/memory-architecture.md` ("Provenance", "The security model"); `extensions/memory-core/src/memory-entry-origins.ts`. Includes in-turn taint: after a web/email tool result, the rest of the turn is untrusted.
2. **Promote by demonstrated usefulness, not model confidence** — recall count + distinct queries + multi-day recurrence as deterministic gates, then the model only picks add/merge/supersede and code applies it; reject rewrites that lose too many entries; keep the pre-image; write a human diff to `DREAMS.md` — `docs/concepts/dreaming.md` ("Consolidation safety").
3. **Small always-loaded curated file + searchable episodic layer**, with a visible budget and a truncation warning in doctor — `docs/concepts/memory.md`.
4. **Preferences as dated imperative directives, superseded in place** — `docs/concepts/memory-architecture.md` ("The user model").
5. **Pre-compaction memory flush on a private copy of the conversation, optionally on a cheap model** — `docs/concepts/memory.md` ("Automatic memory flush").
6. **Hybrid search in plain SQLite (FTS5 + vectors), keyword-only fallback, loud failure when a named provider breaks** — `docs/concepts/memory-builtin.md`, `memory-search.md`.
7. **Trigger phrases + importance as trailing HTML comments on the markdown line** — metadata survives in the human-editable file, invisible in Obsidian preview.
8. **`memory forget --session … --dry-run` with lineage, and honest "what deletion does not cover"** — `docs/concepts/memory-provenance.md`.
9. **Restricted reader agent for email with DMARC-verified sender allowlist before any model call** — `docs/automation/imap.md`, `extensions/imap/openclaw.plugin.json`.
10. **Plugin manifest declares its secrets paths and its dangerous flags**, so one audit command and one settings form cover every integration — `extensions/imap/openclaw.plugin.json`.
11. **Onboarding verifies the model credential with a real completion before saving** — `docs/start/wizard.md`.
12. **Strict config + "every breaking change ships a doctor migration"; no silent aliases** — `VISION.md` ("Configuration compatibility"), `docs/gateway/configuration.md`.
13. **`mcp doctor --probe`, `sandbox explain`, `status --all` (redacted, pasteable)** — diagnostics that answer "why".
14. **Generated maturity scorecard with promotion rules** — `docs/maturity/taxonomy.md`.
15. **Published trust model incl. "not vulnerabilities by design"** — `docs/gateway/security/trust-model.md`.
16. **Contribution throttles**: PR cap per author, no refactor-only PRs, features-as-plugins, evidence section — `CONTRIBUTING.md`.
17. **Docs frontmatter `summary` + `read_when`** on every page.

## Traps they hit

- **Open registry before review existed.** Hundreds of malicious skills within weeks of ClawHub opening; scanning, hidden-until-reviewed releases, trust envelopes and operator install policy were all added afterwards. A skill is instructions plus scripts that run with the agent's authority — a markdown file is a supply-chain vector.
- **Exposed control port.** A local web UI + a port + Docker's publish-to-all-interfaces habit produced a Shodan event. Their container images still default to an exposed bind.
- **~722 advisories, mostly authorisation plumbing**: scopes widening on reconnect, pairing tokens minting admin, background runs (heartbeat, cron, voice calls) inheriting owner authority, per-channel approval handlers each with their own bug. Every new channel re-implemented approval buttons and several got it wrong.
- **Approval integrity bugs** (list in section 6): display truncation, payload changing after approval, approver identity unchecked, approvals outliving their context.
- **Memory auto-capture produced junk**: their own words — "production audits have found the overwhelming majority of auto-captured memories to be scaffolding restatements, heartbeat noise, and recall feedback loops". Fixed by session-kind gating and recall-loop marking.
- **Removed the QMD memory backend** (external sidecar search engine) in favour of built-in SQLite (`memory-builtin.md` read_when: "migrating from the removed QMD memory backend"); moved dreaming state, sessions, and auth profiles from JSON files into SQLite (issue #78595 "Refactor runtime state into SQLite") — with doctor migrations each time.
- **Index growth without retention** (#114612, open), gateway memory leaks (#91588, open; #45064), Active Memory timeouts blocking replies (#73306, #86996) — hence principle 5, "failures never block replies".
- **Sandbox off by default** and workspace-is-not-a-sandbox remain the standing criticism.
- **Scale cost**: ~5,000 open issues and ~2,900 open PRs despite bots and caps.
- **Default-on agent-to-agent messaging and cross-channel sending** have to be explained as "by design" in the trust model.

## Verdicts for Lares

| Idea | Verdict | Why |
|---|---|---|
| Origin class on every memory/observation (owner / agent / untrusted / system), stored in Postgres columns, never parsed from text; untrusted can never be promoted to standing facts or preferences | **Adopt** | Lares' dream cycle reads conversation logs that will include email bodies. Today promotion is by confidence >= 0.8 — that is exactly what a poisoned email can fake. Runs locally, no vendor. |
| In-turn taint: after an email/web tool result, anything the agent writes to memory that turn is untrusted | **Adopt** | Cheap to implement in the tool layer; closes the laundering path. |
| Promote on recurrence/usefulness gates in code; model only chooses add/merge/supersede; reject lossy rewrites; keep pre-image; human-readable diff log | **Adapt** | Lares already has "recurrence" as one path; make it the main one and demote "confidence" to a tie-breaker. Write the diff into the Brain store so it shows in Obsidian and git. |
| Small curated always-loaded set + searchable rest | **Adopt (already close)** | Standing facts cap 40 = their curated tier. Keep the cap; add a visible "truncated/over budget" signal in the console. |
| Preferences as dated directives, superseded in place | **Adopt** | Fits the Postgres preferences table; add `superseded_by` and never inject superseded rows. |
| Hybrid keyword + vector index beside the markdown, markdown stays truth, keyword-only fallback | **Adopt, on pgvector** | pgvector is already installed and unused. Embeddings via the LiteLLM gateway alias or a local GGUF model keeps EU-only. Do not copy their OpenAI default. |
| Trigger/importance metadata on the note itself | **Adapt** | Put it in OKF frontmatter rather than HTML comments. |
| Pre-compaction memory flush | **Adapt** | Only if eve compaction loses context in practice; Lares' nightly dream cycle over stored logs already covers the "many short sessions" case. Check eve 0.60 first. |
| `forget` by source conversation with dry-run and honest limits | **Adopt** | Needed for GDPR-minded EU users and for multi-user. Requires lineage from observation -> conversation, which the provenance work gives for free. |
| Restricted reader agent for email + sender allowlist + DMARC strength ladder before any model call | **Adopt** | The single most relevant safety pattern for "agents that read email". MIT, so `extensions/imap` sender-auth logic can be studied or ported with notice. |
| Strip chat-template control tokens from external content | **Adopt** | Matters precisely because Lares routes through LiteLLM to possibly self-hosted models. |
| Approval-card hardening checklist: bind approval to a hash of the exact payload; show the full payload (no truncation, or a "view full" that is part of the hash); verify approver identity per channel; expire; one shared implementation, not one per channel | **Adopt** | Their advisory list is a free test plan for Lares' core safety feature. |
| Integration manifest that declares secret paths + dangerous settings, feeding one audit and one generated settings form | **Adapt** | Fits the planned "typed adapters + MCP" split and would cut the "6+ places" cost. |
| MCP for user-added tools with per-server tool filters and a `--probe` doctor | **Adopt** | Matches Lares' plan. MCP tools must go through the same approval ratchet. |
| Public skills/plugin registry | **Ignore for now** | The registry was their worst incident. For Lares: skills come from the engine repo or the owner's overlay, nothing installable from a public index at launch. Revisit with signing + review. |
| Onboarding that verifies the model key with a real call; strict config that refuses to start; doctor with `--fix` migrations | **Adopt** | Directly addresses "69 settings, no installer". |
| First door = local web chat before any chat app | **Adapt** | Their 5-minute path works because no Slack/Telegram app is needed. Supports moving Lares' planned web chat earlier. It must bind to loopback / sit behind the existing proxy — see exposed-gateway trap. |
| Secrets in plain files/SQLite with 600 permissions | **Ignore** | Lares' compose-level secrets are already stricter. Do adopt the SecretRef indirection idea (config points to a secret, never contains it). |
| Sandbox optional, no outbound limits | **Ignore** | Lares' sealed network + containers is already ahead; keep it as a launch differentiator and say so. |
| "One trust boundary per installation" stated plainly; multi-user as convenience, not isolation | **Adapt** | Honest starting position for Lares' multi-user product; Lares' note scopes (private/org/participants) go further and should be tested as real boundaries before being advertised. |
| Usage reporting without caps | **Adapt** | Copy the `/status` and per-session cost views; add the hard cap they lack (LiteLLM budgets make this cheap). |
| Maturity scorecard with promotion rules | **Adopt (small)** | A one-page table per capability (experimental / beta / stable + what "stable" requires) at launch. |
| Published trust model + "not a vulnerability by design" list + SECURITY.md | **Adopt** | Needed on day one of going public. |
| Contribution throttles (features as plugins, no refactor-only PRs, PR cap, evidence section) | **Adapt** | Lares' overlay rule already says "engine changes are contributions"; add the evidence requirement and the refactor rule. |
| Daily update check that sends version/OS | **Ignore** | Conflicts with "nothing phones home". Lares' read-only releases feed is the better design. |
| Docs frontmatter `summary` + `read_when` | **Adopt** | Trivial, helps both humans and coding agents. |

## Where OpenClaw contradicts what Lares does or plans

1. **Promotion by confidence** (Lares: >= 0.8) is the thing OpenClaw explicitly moved away from: "memory graduates because it kept being useful, not because it was written confidently", and untrusted sources are excluded before scoring.
2. **Keyword-only search with no index** — OpenClaw treats a rebuildable index beside the files as table stakes, while agreeing with Lares that files are the truth.
3. **Three conversation stores + a 15,800-line Notion sync** — OpenClaw went the other way: consolidated runtime state into one SQLite database per agent and removed an external memory backend. Nothing in OpenClaw syncs memory two-way with a third-party app; Obsidian compatibility comes from plain files alone.
4. **Mandatory gateway and chat-app-first doors** — OpenClaw's first conversation needs neither; the key is verified and a local web chat opens.
5. **Where Lares is ahead:** approval on every outbound write with a ratchet, sealed outbound network, no telemetry at all, per-note scopes. OpenClaw has none of these by default — and its advisory history shows how hard the approval layer is to get right across many channels.
