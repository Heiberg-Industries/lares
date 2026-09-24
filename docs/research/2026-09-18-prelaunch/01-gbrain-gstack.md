# 01 — gbrain + gstack (Garry Tan) vs Lares

Research for LAR-71, 2026-09-18. Read-only. Paths below are repo-relative to `github.com/garrytan/gbrain` @ `d13aa742` unless marked `gstack:`.

## Header

| | gbrain | gstack |
|---|---|---|
| URL | https://github.com/garrytan/gbrain | https://github.com/garrytan/gstack |
| Self-description | "Garry's Opinionated OpenClaw/Hermes Agent Brain" | "Garry Tan's exact Claude Code setup: 23 opinionated tools…" |
| Default branch / commit | `master` @ `d13aa742`, 2026-09-17 (commit msg "v0.51.0.0 feat: make concurrent writes durable and revision-safe") | `main` @ `a6b3a575`, 2026-09-16 ("v1.87.4.0 fix: preserve health failures…") |
| Latest release | v0.51.0.0, published 2026-09-17 (GitHub Releases only since v0.42.71.0, 2026-08-01) | no GitHub releases; `VERSION` file = 1.87.4.0 |
| Licence | MIT (AGPL-compatible for copying in, with attribution) | MIT |
| Stars / forks | 30,095 / 4,501 | 133,543 / 19,897 |
| Created | 2026-04-05 (5.5 months old; **390 changelog releases**) | not checked |
| Size | 5,277 files: 1,356 in `src/`, 2,605 tests, 189 skill files, 174 docs. `CHANGELOG.md` 29,593 lines, `TODOS.md` 9,391 lines. 264 open issues. | ~50 skill directories + a Bun browser daemon |
| Stack | TypeScript on **Bun** (≥1.3.11). Not on npm (the npm `gbrain` is an unrelated package — README warns loudly). | TypeScript on Bun; skills are markdown |

**What I read:** README, `docs/architecture/system-of-record.md`, `RETRIEVAL.md`, `docs/guides/{compiled-truth,brain-vs-memory,ambient-recall,ambient-writeback,push-context,google-connect,open-loops,cron-schedule,scaling-skills,bootstrap,rls-and-you}.md`, `docs/takes-vs-facts.md`, `docs/protocol/MEMORY_VERBS_v1.md`, `docs/operations/spend-controls.md`, `docs/incidents/2026-05-20-lsd-cost-explosion.md`, `docs/tutorials/company-brain.md`, code: `src/core/cycle.ts` (phase list), `src/core/cycle/synthesize.ts` (header), `src/core/cycle/phases/consolidate.ts`, `recipes/email-to-brain.md`, `skills/briefing/SKILL.md`, `skills/RESOLVER.md`, CHANGELOG headlines for all 390 versions + full text of 0.31.0, 0.32.2, 0.45.1, 0.46.2, 0.47.8, 0.51.0. Open issues sorted by reactions. gstack: README, `ARCHITECTURE.md`, `hosts/` listing.

**Unverified:** I did not run anything. Benchmark numbers (LongMemEval 93.4 / 95.5 %, BrainBench P@5 49.1) are the project's own claims from README/`RETRIEVAL.md`; the eval harness exists in-repo but I did not execute it. I read code headers and docs for the dream phases, not every line of the 3,206-line `cycle.ts`. "155,795 pages" production brain is Garry's README claim. Monthly running cost of the dream cycle for a typical user: no figure found — only per-phase caps.

**Shape warning for the lead:** gbrain is *not* an agent fleet. It is a memory server + CLI + skill pack that plugs into someone else's agent host (OpenClaw, Hermes, Claude Code, Codex, Cursor…). It never sends email or creates events. So Q1 is a rich comparison; Q2/4/6 compare only partially.

---

## 1. MEMORY

### 1a. What is truth, what is index

**Stated contract** (`docs/architecture/system-of-record.md` line 3–5): *"Canonical Markdown and frontmatter are the system of record for file-backed knowledge. Their database indexes can be rebuilt from those files. DB-only knowledge and operational state still need a separate backup."*

Three categories, documented as tables in that file:

1. **FS-canonical (markdown is truth, DB row is derived):** takes, facts, links, timeline entries, tags. Each lives in the markdown file in a parseable shape — facts and takes as **fenced markdown tables** between HTML-comment markers (`<!--- gbrain:facts:begin -->` … `:end -->`), links as ordinary `[text](slug)` / `[[wikilinks]]`, timeline as dated bullets, tags in frontmatter. A "reconciler" rebuilds each DB table from the files.
2. **Derived, not user-authored:** `pages`, `content_chunks` (chunk text + embedding), `page_versions`. Rebuilt by re-import; chunks only re-embed when the file's content hash changes.
3. **DB-only by design:** job queue, OAuth tokens, audit log, dream triage cache (`dream_verdicts`, 30-day TTL), and — new in v0.51 — the **withdrawal ledger** (authoritative record of "forget") and write receipts.

**The database:** Postgres + **pgvector (HNSW index)** for shared/large brains; **PGLite** (Postgres 17 compiled to WASM, runs in-process, "2 seconds, no server, no Docker") as the default for personal brains "up to ~50K pages" (README, Architecture). One `BrainEngine` interface (`src/core/engine.ts`, "140+ methods") with both engines behind it. Full-text search is Postgres `tsvector` with a **configurable language** (`GBRAIN_FTS_LANGUAGE`, e.g. `portuguese`; Norwegian is a built-in Postgres config — relevant to Lares).

**Enforcement, not just intent:** a CI script (`scripts/check-system-of-record.sh`) fails any PR that writes to a derived table outside a reconciler without an explicit `// gbrain-allow-direct-insert: <reason>` comment. An E2E test deletes the derived tables and proves they rebuild from files.

**Important drift in their own story (see Traps):** v0.32.2 (2026-05-11) headline was *"The database is a derived cache. We do not back up the database — we rebuild it from the repo."* By v0.51 the README says *"A Git clone alone is not a complete backup"* and "forget" is committed to a **DB ledger first**, with markdown mirrored later. Files-as-truth survived for knowledge; it did not survive for corrections, receipts, or anything written when no file owner is online.

### 1b. Page structure

`docs/guides/compiled-truth.md`. Every page has two zones split by a `<!-- timeline -->` sentinel:

- **Compiled truth** (above): current synthesis, *rewritten* as evidence changes (sections like State / Assessment / Relationship / Contact on a person page).
- **Timeline** (below): append-only dated bullets, each with `[Source: who, channel, date time tz]`. Never edited; a wrong entry is corrected by appending a new one.
- Rule: every claim in compiled truth must trace to a timeline entry. Search ranks compiled-truth chunks above timeline chunks.
- Frontmatter: `type`, `title`, `tags`, free-text `aliases:` (projected to a `page_aliases` table for the alias hop), plus `provenance: auto-extracted` / `status: unverified` for a quarantine lane.
- **Schema packs**: the type taxonomy is pluggable. Default `gbrain-base-v2` = 15 types (person, company, media, tweet, analysis, atom, concept, source, deal, email, slack, writing, project, note…). Type is inferred from the path prefix. `gbrain schema detect/suggest/review-candidates` proposes types from the user's own folder layout. 7-tier config resolution chain.
- **Knowledge graph with zero LLM calls:** on every page write, three regexes pull entity references out of the markdown and a heuristic on the surrounding sentence types the edge (`works_at`, `attended`, `invested_in`, `founded`, `advises`, `mentions`). Frontmatter fields like `company:`, `attendees:` also become edges (v0.13). They claim this is the single biggest retrieval lift: P@5 ~18 → 49.1 on their own benchmark (`RETRIEVAL.md`).

Compared with Lares's OKF frontmatter (required `type`): same idea at the top of the file. gbrain adds (i) the compiled-truth/timeline split, (ii) machine-parseable fact tables inside the file, (iii) aliases, (iv) links-as-graph.

### 1c. Three memory layers (their words: "never conflate them")

`docs/takes-vs-facts.md`, `docs/guides/brain-vs-memory.md`:

| Layer | What | Written by | Read by |
|---|---|---|---|
| **Pages** | World knowledge: people, companies, meetings, ideas | Agent skills, ingestion, dream `synthesize` | `search` / `query` / `think` |
| **Facts** ("hot memory", v0.31) | What *the owner* said: kinds `event / preference / commitment / belief / fact` (+ `idea`). Each has `entity`, mandatory `provenance`, optional `ttl`, `visibility: world|private` | `remember` verb; optional per-turn cheap-model extraction (ambient writeback, **off by default**) | `recall`, `entity` cards, `context_pack` |
| **Takes** ("cold storage") | WHO believes WHAT, with weight 0–1 in 0.05 steps; kinds take/fact/bet/hunch; many holders | LLM extraction from pages; dream `consolidate` promotes facts → takes | `think`, `takes search` |
| *(outside gbrain)* Agent memory | Operating preferences: "user prefers concise formatting" | The host agent's own MEMORY.md | host |

Note the split they insist on: **"Alice prefers email" is a fact about Alice → her page. "User likes bullet points" is how the agent should behave → agent memory, not the brain.** Lares's "standing facts" and "preferences" blur these.

### 1d. The recall path (exact)

`docs/architecture/RETRIEVAL.md`, pinned by `src/core/search/hybrid.ts`:

1. Deterministic intent classifier (entity / temporal / event / concept / general) — no LLM.
2. Optional LLM multi-query expansion (only in `tokenmax` mode).
3. Parallel recall arms: **vector** (HNSW, best-chunk-per-page pooling), **keyword** (BM25-style via tsvector), **title-phrase**, **relational** (typed-edge arm for "who works at X").
4. **Reciprocal-rank fusion**, then boosts: source tier (curated folders outrank chat logs; `archive/` ×0.5), backlinks, salience, recency, graph signals.
5. 4-layer dedup → **cross-encoder reranker** (Voyage `rerank-2.5`, hosted US API; local llama.cpp reranker recipe exists) → alias hop → exact-lookup tier.
6. Token-budget enforcement. Every result carries `evidence` (why it matched) and `create_safety` (`exists / probable / unknown`) so the agent can decide whether to create a page or not.

Three named cost bundles: `conservative` (no reranker), `balanced`, `tokenmax`. **Keyless mode is a supported first-class state**: no API key → keyword-only search, response notes `search_degraded`, never an error.

**How recall is triggered** (`docs/guides/ambient-recall.md`) — this is the most transferable thinking:

> "The bottleneck for a long-lived agent is not retrieval quality… It is **placement**: the misses come from moments when no question fires." … "per-message retrieval beyond `entity` cards adds latency faster than insight; session-start packs and post-compaction rehydration are nearly pure win."

| Moment | Call | Cost |
|---|---|---|
| Any message naming an entity | `entity(name)` — one card, zero LLM, p99 < 100 ms (CI-gated at 20K pages) | negligible |
| Session start / after compaction | `context_pack(entities, budget_tokens)` | zero LLM |
| Heartbeat | `delta(session_id)` — "what changed since my last wake", cursor-based | zero LLM |
| Explicit question | `recall(query|entity, budget_tokens)` | 1 embedding |
| Needs cross-page reasoning | `synthesize(question)` — LLM, returns answer + sources + **gaps** + cost block | $$, never on a hot path |

In Claude Code a `UserPromptSubmit` hook injects a per-turn block (entity pointers + max 3 pages + hot facts), gated at confidence ≥ 0.7, "silence beats a wrong pointer", with **cross-turn dedupe** (a page is pushed once per session) and a feedback metric (was the volunteered page subsequently opened?). v0.45.1 changelog admits the first version was "a firehose".

All budgets are **server-side**: caller passes `budget_tokens`; server packs by priority and reports `budget_used` + `dropped_count`.

**The seven verbs are a frozen wire protocol** (`docs/protocol/MEMORY_VERBS_v1.md`): `recall, remember, entity, synthesize, forget, context_pack, delta`. Additive-forever, `protocol_version: 1` on every response, conformance test for third-party servers.

### 1e. Correction and forgetting

- `remember` returns `status: inserted | duplicate | superseded`. Supersession rule: same entity + same kind + embedding similarity above threshold + different text → new fact replaces old. Without an embedding provider dedup degrades and the response says so (`degraded_dedup: true`).
- `forget <id>`: commits to the DB withdrawal ledger first (so a stale re-import can't resurrect it), then mirrors into the markdown fence as `~~claim~~` with `context: "forgotten: <reason>"`. Superseded rows are also struck through with `"superseded by #N"`. History is kept in the file; they are explicit that this is **withdrawal from active memory, not physical erasure** (relevant to GDPR language — they don't promise deletion).
- Facts can carry a `ttl` ("a cold, a trip" expire on their own).
- Deleting a file in git → soft-delete in DB → hard purge after 72 h (dream `purge` phase). `gbrain delete <slug> --purge` for secrets.
- Pages: since v0.51, replacing a page requires the revision you read (optimistic concurrency) or explicit `force`.
- Auto-extracted pages sit in a **quarantine lane** (`status: unverified`) — they rank as ordinary content, results are flagged `unverified: true`, and the owner promotes/rejects via `gbrain extraction-review`.

### 1f. The dream cycle

`src/core/cycle.ts`. One function `runCycle()` called by `gbrain dream` (cron), `gbrain autopilot` (daemon), or the job queue. **23 phases** in fixed order (`ALL_PHASES`, lines 109–198):

`lint → backlinks → sync → synthesize → extract → extract_facts → extract_atoms → resolve_symbol_edges → patterns → synthesize_concepts → recompute_emotional_weight → consolidate → propose_takes → grade_takes → calibration_profile → drift → conversation_facts_backfill → enrich_thin → skillopt → embed → orphans → schema-suggest → purge`

Design principles visible in code:
- **Cheap deterministic phases first** (fix files, then index). Most phases are zero-LLM. The expensive ones are default-OFF or pack-gated (`drift`, `enrich_thin`, `skillopt`, `conversation_facts_backfill`, `extract_atoms`).
- **Locking**: DB row lock with 30-min TTL refreshed between phases; file lock on PGLite.
- **Per-phase USD budgets** (`src/core/cycle/budget-meter.ts`; e.g. `cycle.extract_atoms.budget_usd` default $0.30; skillopt $0.50/skill, $2 brain-wide). Caps are **fail-closed on unpriced models**: a LiteLLM-proxied model has no price row so a capped run aborts until the operator declares `pricing.overrides` (`docs/operations/spend-controls.md`). **Lares routes everything through LiteLLM, so this exact problem applies.**
- **`synthesize` (conversation → pages)** is a two-stage cascade since v0.46.2: a cheap model scores every transcript 0–1 for salience (cached in `dream_verdicts` with model + prompt version; threshold default 0.5 applied *at read time* so retuning costs zero calls), and only passers reach the frontier model, which starts from a "triage map" of noteworthy passages. Subagents never get filesystem write; the orchestrator writes. Quotes on generated pages are verified as actual substrings of the transcript (v0.47.8 — before that "quotes were often paraphrases wearing quotation marks"). Provider failures are never cached as rejections.
- **`consolidate` (facts → takes)** — the direct analogue of Lares's nightly preference promotion (`src/core/cycle/phases/consolidate.ts`): per (source, entity) bucket, skip if < 3 facts or oldest < 24 h; greedy cosine clustering at 0.85; clusters of ≥ 2 become one take; contributing facts are marked `consolidated_into`, **never deleted**. Ships **without an LLM** "to keep the cycle deterministic". So their promotion rule is *recurrence only*, measured by embedding similarity — no confidence threshold.
- Contradiction detection (`gbrain eval suspected-contradictions`) is wired into the daily cycle and surfaces conflicts for the owner.

**Cost evidence:** full takes extraction over a ~100K-page brain cost **$361.49** (GPT-5.5 at $0.033/page; Opus would have been $0.26/page) — `docs/takes-vs-facts.md`. Company-brain tutorial claims "under $100 a month sustained for a 25-person company". README calls the always-on path "the highest-cost path: a deployed server (8GB+ RAM) plus raw API token usage". One user-visible incident: a brainstorm command estimated $0.96 and spent **$50.71** with zero output (`docs/incidents/2026-05-20-lsd-cost-explosion.md`) — root cause: no circuit breaker; fix: `--max-cost`, mid-run abort at 5× estimate, chunked judge.

### 1g. What the owner can see and edit

Everything knowledge-shaped is markdown in the owner's git repo; Obsidian-style `[[wikilinks]]` supported (cross-folder basename resolution is opt-in). Editing a fact = editing a row in the fenced table; next sync reconciles. `gbrain search --explain` shows per-stage score attribution; `gbrain search diagnose "<q>" --target <slug>` traces why a page was missed. `gbrain doctor` has dozens of named checks each printing a paste-ready fix. An admin web dashboard ships with `gbrain serve --http`.

### 1h. Scale and per-user scoping

Claimed production: 155,795 pages, 24,589 people, 66 cron jobs. PGLite ≤ ~50K pages; above that Postgres. Entity lookup p99 < 100 ms gated in CI at 20K pages. Open issues show the rough edge: #4578 "autopilot-global-maintenance always dies at its hardcoded 30-min timeout on a large brain, so late phases never run"; #5061 admin dashboard full-scans exhaust Supabase IO; #4983 no near-duplicate page detection.

Two axes: a **brain** is a database; a **source** is a repo inside it. Per-user OAuth clients are scoped to sources (read/write/admin/agent scopes; `admin` does not imply `agent`). Facts have `visibility: world|private`; `private` is stripped at three layers (chunker never embeds it; `get_page` strips it for remote callers; `db_only` paths are git-ignored). Remote callers can never widen to private even if they ask (fail-closed). README claims fuzz-tested zero leaks across read paths. Known gap: #4705 "`facts` records the mechanism but not the writer — multi-seat brains cannot attribute".

### 1i. Side-by-side with Lares

| | Lares today | gbrain |
|---|---|---|
| Truth | Markdown (OKF) in git + Postgres for standing facts/preferences/voice | Markdown in git for knowledge, *including facts as tables inside the page*; Postgres for index + operational state + withdrawal ledger |
| Index | None. Keyword scan over files. pgvector installed, unused | Postgres tsvector + pgvector HNSW + typed-edge graph, all rebuildable from files |
| Recall | Standing facts injected every turn (cap 40); keyword search by tool | Entity card per mention; context pack at session start/after compaction; delta on heartbeat; hybrid search on question; LLM synthesis only on demand. All token-budgeted server-side |
| Learning | Nightly dream reads conversation logs, promotes at confidence ≥ 0.8 or recurrence, into Postgres | Optional real-time fact extraction (off by default, consent-gated) + nightly deterministic recurrence clustering; promoted facts land in the markdown file first |
| Forget | (not described in brief) | Ledger-first withdrawal + strikethrough in file + TTL on transient facts |
| Owner view | Obsidian on the files; preferences live in Postgres (not visible in Obsidian) | Everything knowledge-shaped is in the files, incl. facts and their corrections |
| Notion | 15,800-line two-way sync | None. One-way import only. Markdown repo is the only editable surface |
| Cost guard | (gateway-level) | Per-phase USD caps, fail-closed on unpriced models, ledger of spend, `spend.posture` master switch |

---

## 2. INTEGRATIONS

gbrain only *ingests*; nothing writes outward, so there is no write-approval story to compare (Google scopes are `gmail.readonly`, `calendar.readonly`, `contacts.readonly` — `docs/guides/google-connect.md`).

- **Native connectors** are hand-written TypeScript (`src/core/connectors/` with `registry.ts`, `oauth-pkce.ts`, `providers/`; `src/core/creds/vault.ts`). No official Google SDK seen (unverified at line level). Tokens live in `~/.gbrain/credentials.json` mode 0600 — "tokens never held by the agent". **Bring-your-own OAuth client**: the owner creates their own Google Cloud project (~7 min checklist with direct links), so there is no shared app to verify and no third party in the path. The guide names the #1 field failure: personal Gmail accounts in "Testing" mode get tokens silently revoked every 7 days unless the app is published. The connector records the scopes Google *actually granted* and reports `scope_missing` with the fix. Headless/SSH paste-back flow is auto-detected.
- **Recipes** (`recipes/*.md`): an integration is a markdown file with YAML frontmatter — `id, version, category, requires: [other-recipe], secrets: [{name, description, where: <URL to get it>}], health_checks: [{type: command|http|env_exists|any_of}], setup_time, cost_estimate`. `gbrain integrations list` discovers them; the agent reads the body and walks the owner through setup.
- **Third-party ingestion**: a versioned `IngestionSource` contract at `gbrain/ingestion` for skillpacks (Granola, Linear, voice, OCR) — `docs/skillpack-anatomy.md`.
- Other lanes: `POST /ingest` webhook (bearer token), an inbox folder (`~/.gbrain/inbox/`), agent-transcript import with pattern-based secret redaction, ChatGPT/Claude history pull via the owner's browser cookie.
- **Outbound**: gbrain *is* the MCP server (stdio or HTTP with OAuth 2.1 + PKCE, optional dynamic client registration defaulting to off, owner approval for authorization-code connections since v0.50).
- Quality ladder: bundled skills vs third-party skillpacks; no formal core/community/private tiers found. No scaffold command for a new connector found (there is `gbrain skillpack scaffold` for skills).

**Reversal worth noting:** `recipes/email-to-brain.md` says earlier versions "had you build a deterministic Node.js collector… All of that is now IMPLEMENTED in gbrain's google source kind… Do NOT re-implement it." They started with "the agent writes the integration from a markdown recipe" and retreated to tested native code for the core mailbox/calendar path.

## 3. FIRST RUN

- Lightest path: `bun install -g github:garrytan/gbrain` → `gbrain init --pglite` (2 s) → `claude mcp add gbrain -- gbrain serve --surface verbs`. **Zero API keys**, zero server, zero accounts. Claimed minutes: ~2.
- "Paste this into your agent" install: the README gives a prompt pointing at `INSTALL_FOR_AGENTS.md` (9 numbered steps incl. "Step 3.5: Confirm search mode with the user (DO NOT SKIP)" and "Step 9: Verify"). The agent is the installer. Claimed ~15 min for the personal-agent bootstrap (6-question interview → `SOUL.md`, `USER.md`, `MEMORY.md` "rendered from your own answers, never invented"), ~30 min for full OpenClaw/Hermes; the from-zero tutorial says ~2 hours.
- Definition of done is machine-checkable: "You are not done until `gbrain bootstrap verify` exits 0." The acceptance test for the product is one sentence: *tell it one thing, restart the session, ask for it back.*
- First door: the owner's existing agent (Claude Code/Codex/Telegram via OpenClaw). No web chat of its own.
- Validation: `gbrain doctor` — every failure prints the exact repair command; health score; `--json`. Init auto-detects which embedding provider keys exist, shows a picker, or proceeds keyless "with a loud notice".
- First-value skill is named: `cold-start` ("fill my brain") imports Gmail/calendar/contacts "one consented step at a time".

## 4. DEFINING AN AGENT

Mostly n/a — gbrain defines memory, not agents. What exists: the bootstrap writes identity files (`SOUL.md`, `USER.md`, `MEMORY.md`, `HEARTBEAT.md`) into a private git repo that becomes "the agent's durable body". Skills are markdown with frontmatter (`name, version, description, triggers: [phrases], tools: [ops], mutating: bool, upstream: name@sha`) — `skills/briefing/SKILL.md`. `skills/RESOLVER.md` is a human-readable phrasebook of the same triggers ("frontmatter wins if they disagree"). `gbrain agent register <name> --harness claude-code` mints a scoped OAuth client + 30-day token with presets ("daily-driver", "write-isolated coding agent"). Sub-agents: durable LLM loops on a Postgres-native job queue ("Minions") with two-phase persistence; MCP callers cannot submit `subagent` jobs.

## 5. MORE THAN ONE PERSON

Real and shipped: per-user OAuth clients scoped to sources; per-person write isolation inside a shared source (v0.42.72); `visibility: world|private` on facts; `brain.audience: personal|shared` — and **ambient capture is never even offered on a shared brain** ("capturing what people say to agents on a shared brain is a privacy decision the whole team owns"). RLS is mandatory on Supabase: `gbrain doctor` *fails* (exit 1) if any public table lacks it. No approval roles, because there are no outward writes.

## 6. SAFETY

- Retrieved brain content is injected "under an explicit 'data, not instructions' envelope"; interview answers are rendered as fenced, escaped, length-capped data (`docs/guides/bootstrap.md` §Injection boundaries). Email→commitment extraction: newest 12k chars only, all-or-nothing parse barrier, only last 30 days, kill switch.
- Secrets: every commit and transcript write is secret-scanned; deny-glob refuses tracked `.env*`/`*.pglite`; push refuses public remotes. `SECURITY.md` has an "If a secret reached the brain" runbook.
- HTTP server: loopback bind by default, rate limiting, body cap, CORS allow-list, audit log, scope ceilings, `admin` ≠ `agent`.
- No container sandbox or egress allow-list of its own (it relies on the host). The optional "Memorable" integration ships a **closed-source third-party CLI that sends session data to a US API** — they document it with unusual candour (what gbrain verifies vs what is the vendor's claim) and gate it behind an interactive consent the CLI cannot forge. For Lares: ignore the integration, steal the disclosure format.
- v0.50.5 (2026-09-16) closed "critical- and high-severity items from privately reported advisories" on the remote OAuth surface.

## 7. COST AND VISIBILITY

Covered in 1f. Additionally: every `synthesize` response carries a `cost{model, tokens, usd_estimate}` block; non-interactive runs **auto-defer** expensive work instead of blocking a cron ("never wedges the pipeline"); `0` is not "off" — off is the literal word `off|unlimited|none`, and a typo'd cap falls back to the default cap rather than uncapped. Admin dashboard shows daily agent spend. Weekly-rotated JSONL audit files under `~/.gbrain/audit/`.

## 8. COMMUNITY

MIT. 390 versions in 166 days (~2.3/day); four-part version numbers. Community PRs are **not merged one by one** — they are batched into "fix waves" (e.g. v0.48.5: "57 contributor pull requests adopted or reworked", credit via `Co-Authored-By`). An automated PR gate was added in v0.42.73.0 and **removed one day later** in v0.42.73.1 ("caused a real incident"). Docs: `llms.txt` + `llms-full.txt`, `AGENTS.md`/`CLAUDE.md` as agent entry points, `docs/{architecture,guides,tutorials,operations,incidents,protocol,ethos}`. Every feature paragraph in the README ends with **"Say to your agent: …"** — the natural-language phrase that triggers it. Each release has an agent-readable migration note under `skills/migrations/vX.md`. Honesty devices: public incident reports, "Known limitation:" paragraphs inline, benchmark caveats that name where they lose (LLM query expansion *hurts* recall: 255/470 vs 439/470).

---

## gstack (short)

**What it is:** ~50 slash-command skills for coding agents that role-play a software team (`/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/review`, `/qa`, `/ship`, `/cso`, `/retro`, `/investigate`…) plus a persistent headless-browser daemon (`/browse`) written in Bun.

**Packaging/install:** `git clone --depth 1 … ~/.claude/skills/gstack && ./setup`. `./setup --host codex|cursor|opencode|kiro|factory|slate` renders the same skills for other agent hosts from per-host adapters (`gstack: hosts/*.ts`). `./setup --team` + `gstack-team-init required` commits a project-level requirement. Self-update via `/gstack-upgrade`. **Opt-in telemetry** asked on first run (README §Privacy & Telemetry) — conflicts with Lares's "nothing phones home".

**Transferable to Lares's skills layer:**
1. **Generated skill docs** (`gstack: ARCHITECTURE.md` §"SKILL.md template system"): `SKILL.md.tmpl` (human prose + `{{PLACEHOLDERS}}`) → generator fills command tables *from source code* → committed `SKILL.md`; CI runs `gen --dry-run && git diff --exit-code`. "If a command exists in code, it appears in docs. If it doesn't exist, it can't appear." Direct fit for Lares skills that reference capabilities/grants.
2. **Three test tiers for skills**: static validation (free, every test run) → real-session E2E (~$4, gated) → LLM-as-judge on doc quality (~$0.15).
3. **Shared preamble** as one binary call instead of ~18 KB of inline text per skill (v1.71).
4. **One question format** everywhere: context, question, `RECOMMENDATION: Choose X because …`, lettered options — maps onto Lares approval cards.
5. From gbrain `docs/guides/scaling-skills.md`: past ~100 skills the catalogue itself eats the prompt (25K tokens at 300). Fix = three tiers (always-loaded ~35 / resolver-routed ~85 / dormant) + a doctor check that no skill is unreachable.

Not transferable: the role-play reviews themselves (coding-team specific), the browser daemon.

---

## Patterns worth stealing

1. **CI gate: "derived tables are written only by reconcilers"** — `scripts/check-system-of-record.sh` + the delete-and-rebuild E2E test. This is how you make "files are truth" real rather than aspirational.
2. **Facts as a fenced markdown table on the entity's page** (`<!--- gbrain:facts:begin -->`), with strikethrough + reason for superseded/forgotten rows. Puts learned preferences where Obsidian can show and edit them. (`src/core/fence-shared.ts`, `facts-fence.ts`)
3. **Compiled truth / timeline split** with the `<!-- timeline -->` sentinel — `docs/guides/compiled-truth.md`.
4. **Placement over per-turn injection** — entity card per mention, pack at session start and after compaction, delta on heartbeat; server-side `budget_tokens` with `dropped_count` — `docs/guides/ambient-recall.md`, `docs/protocol/MEMORY_VERBS_v1.md`.
5. **Keyless-first degrade ladder**: keyword-only works with no provider; every richer tier is additive and the response *says* when it degraded (`search_degraded`, `degraded_dedup`, `reranker_skipped (no_key)`).
6. **Zero-LLM link graph from wikilinks + frontmatter** (`extractEntityRefs`, v0.12/v0.13) — nearly free given Lares already has OKF frontmatter and Obsidian-compatible files.
7. **`evidence` + `create_safety` on every search hit** so the agent stops creating duplicate pages.
8. **Dream triage cascade with cached, versioned verdicts and read-time threshold** — `src/core/cycle/synthesize.ts` header. Retune without re-spending.
9. **Deterministic promotion rule** (≥3 facts, oldest ≥24 h, cosine ≥0.85, never delete the source facts) — `src/core/cycle/phases/consolidate.ts`.
10. **Quote verification**: anything in quotation marks on a generated page must be a substring of the source transcript — `src/core/cycle/synthesize-verify.ts`.
11. **Quarantine lane for auto-extracted knowledge** (`status: unverified`, flagged in results, owner promotes) — `src/core/extraction-review.ts`.
12. **Per-phase USD caps, fail-closed on unpriced models, `pricing.overrides` for proxy routes** — `docs/operations/spend-controls.md`. Lares's LiteLLM aliases are exactly the "unpriced proxy model" case.
13. **Recipe frontmatter** with `secrets[].where` (URL where you get the key), `health_checks`, `setup_time`, `cost_estimate` — `recipes/email-to-brain.md`.
14. **BYO Google OAuth client with the 7-day-revocation warning and granted-scope recording** — `docs/guides/google-connect.md`.
15. **`doctor` where every failing check prints the paste-ready fix**, and the install's done-condition is `verify exits 0`.
16. **"Say to your agent: …" after every feature in the docs.** Perfect for a non-developer owner.
17. **Public incident reports** in `docs/incidents/` and agent-readable migration notes per release.
18. **Configurable Postgres FTS language** — Norwegian stemming for free if Lares moves keyword search into Postgres.
19. gstack: **skill docs generated from code + CI freshness check**.

## Traps they hit

1. **"DB is a disposable cache" did not hold.** v0.31 shipped facts DB-only → v0.32.2 (3 days later) moved them into files and declared "we do not back up the database" → by v0.51 withdrawals, receipts, revision history, DB-only pages and unresolved facts are DB-authoritative and the README says a git clone "is not a complete backup". Lesson: decide per data class up front; "forget" and anything written while no file-owner is online need a DB home. Lares already has a restore drill (LAR-54) — keep both halves in it.
2. **Per-turn injection started as a firehose** (v0.45.0 → v0.45.1 added cross-turn dedupe, confidence gate, precision metric). Lares's 40 standing facts every turn is the same shape without the dedupe or the metric.
3. **Dream synthesis burned money on small talk** until the v0.46.2 triage gate; then the gate *averaged* whole sessions and dropped the one good idea in an hour of logistics (fixed v0.47.8: score the peak, not the mean; content retained 70.2 % → 88.1 % on their write-path benchmark).
4. **Fabricated quotes** on dream-written pages until v0.47.8.
5. **$50.71 for zero output** — no cost circuit breaker on a fan-out command (incident 2026-05-20).
6. **LLM query expansion hurts**: strict recall 255/470 with it vs 439/470 without. Shipped on in the premium mode anyway; they document it as a known loss. Autocut after rerank also hurt (379/470) and was turned off. **Pure vector scored 93.8 % vs hybrid 93.4 %** on LongMemEval — their own words: "the hybrid layer is roughly neutral on this benchmark and earns its keep elsewhere" (named-thing lookups, graph questions).
7. **Hosted dependency died under them**: ZeroEntropy (default reranker/embedder) shut its API 2026-09-04; several releases (v0.46.3, .10, .12, v0.48.2) were spent migrating users. Embedding-model switches force a full re-embed and column resize.
8. **Semantic result cache is "temporarily disabled"** since v0.48.3 because they could not prove every access rule was honoured on a cache hit. Caches and per-user scoping fight.
9. **"Agent writes the integration from a recipe" was retracted** for Gmail/Calendar in favour of tested native code.
10. **Silent failure is the dominant bug class** in issues and changelog headlines ("maintenance stops reporting unfinished work as complete", "work your brain was quietly not doing", #4998 failed migration recorded as complete, #5098 subagent with dropped tools recorded `completed`, #4578 late dream phases never run on large brains).
11. **PGLite fragility**: single-connection lock contention between `serve`, `sync`, `watch`; torn WAL after OS reboot needed an auto-repair tool (v0.42.75).
12. **Velocity as a cost**: 390 releases, a 9,391-line TODOS.md, 264 open issues, PR gate added and reverted within a day. Almost certainly agent-authored at scale; the surface area (23 dream phases, 140+ engine methods, ~27–100+ MCP ops) is far beyond what a small-business owner needs. They themselves had to add `--surface verbs` (7 tools) because the full tool wall overwhelmed agents (v0.45.13 "Truthful Surface").
13. **Tag removal doesn't propagate** (add-only reconciliation, no provenance column) and **edited timeline bullets leave stale rows** (#4649) — reconcilers that only add are easy; ones that delete correctly are hard.

## Verdicts for Lares

Filters: runs on owner's server; no US cloud in data path; writes behind approval; MIT → AGPL copy is fine with attribution.

| Idea | Verdict | Why |
|---|---|---|
| Markdown stays truth; Postgres becomes a *rebuildable index* (tsvector + the already-installed pgvector) | **Adopt** | Keeps Obsidian + git story; replaces no-index keyword scan; all on the owner's Postgres. Embeddings must go through the LiteLLM alias to an EU or local model (gbrain supports Ollama/llama.cpp/LiteLLM, so the design is proven provider-neutral). |
| Keyless/embedding-less mode as first-class, with explicit "degraded" notes | **Adopt** | Matches sovereignty and first-run goals; search works on day one with Norwegian FTS, vectors are an upgrade. |
| CI gate + rebuild test for "derived tables only via reconcilers" | **Adopt** | Cheap, and it is what makes the truth/index split trustworthy. |
| Move learned preferences/standing facts into a fenced table in the markdown files (DB row derived) | **Adapt** | Makes dream output visible/editable in Obsidian and survives a DB loss. Keep a DB-side ledger for "forget" so a re-import can't resurrect it (their v0.51 lesson). |
| Compiled-truth / timeline page split | **Adapt** | Good for people/company/supplier pages in Atlas; needs to be expressed within OKF rather than replacing it. |
| Replace "inject 40 standing facts every turn" with entity cards + session-start pack + token budget + cross-turn dedupe | **Adapt** | Strongest contradiction with current Lares. eve sessions differ from Claude Code hooks, so the mechanism differs, but the placement rule and server-side budgeting carry over. Keep a *small* always-on set (identity, hard rules). |
| Separate "facts about the world" (→ the entity's page) from "how the agent should behave" (→ agent definition/voice) | **Adopt** | Lares already has voice.md/duties.md; the dream should route each observation to one or the other instead of one preferences table. |
| Deterministic recurrence rule for promotion; never delete source observations | **Adapt** | Compare with Lares's confidence ≥ 0.8 rule. Recurrence-by-similarity is cheaper and auditable; a one-off explicit statement ("never book Ryanair") still needs the direct `remember` path. |
| Dream triage cascade (cheap score, cached + versioned, threshold at read time; score the peak not the mean) | **Adopt** | Directly cuts nightly model cost; "gate" alias already exists in Lares. |
| Quote-must-be-substring verification; quarantine lane for auto-extracted notes | **Adopt** | Cheap trust mechanisms; quarantine maps naturally onto Lares's approval culture. |
| Per-phase USD caps, fail-closed when a model has no price, price overrides for proxy aliases | **Adopt** | Lares's aliases are unpriced by construction; without an override table any cap is fiction. |
| Zero-LLM link graph from wikilinks/frontmatter | **Adapt** | Low cost, real lift on "who/what is connected" questions; do after the index exists. |
| `evidence` + `create_safety` on search results | **Adopt** | Stops duplicate notes; trivial once search is in SQL. |
| Cross-encoder reranker | **Ignore for now** | Default is a US hosted API (Voyage); local llama.cpp reranker is possible later. Their own data shows modest gain (+10/470). |
| LLM query expansion | **Ignore** | Their own benchmark shows it hurts. |
| Takes / bets / calibration scorecards / emotional weight / atoms / lens packs / code intelligence | **Ignore** | VC-investor features; pure surface area for a small business. |
| PGLite | **Ignore** | Lares already runs Postgres; PGLite's locking and WAL problems are a cost with no benefit here. |
| Frozen 7-verb memory protocol over MCP | **Adapt** | Don't adopt their wire format, but a small stable memory contract (recall/remember/entity/forget/pack) between agents and store is the "neutral contract" Lares wants elsewhere. Also lets an owner point Claude Desktop at their Lares memory later. |
| Running gbrain itself as Lares's memory | **Ignore** | Bun runtime, ~2 releases/day, huge surface, US-provider defaults, designed for one power user. Borrow designs and (MIT) snippets, not the dependency. |
| Two-way Notion sync | **Contradiction — reconsider** | gbrain has no two-way sync with anything; markdown repo is the only editable surface, imports are one-way. Lares's biggest service has no counterpart in the project that inspired its memory. |
| Recipe frontmatter (`secrets[].where`, `health_checks`, `setup_time`, `cost_estimate`) | **Adopt** | Fits the planned integration registry and the wizard; pure metadata. |
| BYO Google OAuth client + granted-scope recording + 7-day-revocation warning | **Adapt** | Right sovereignty posture (no shared app, no verification). Lares additionally needs write scopes behind approval cards — gbrain has nothing to teach there. |
| "Agent builds the integration from a markdown recipe" | **Ignore** | They retracted it for mail/calendar. Supports Lares's plan: typed adapters for core concepts, MCP for user-added tools. |
| `doctor` with paste-ready fixes; install done = `verify` exits 0; one-sentence acceptance test | **Adopt** | Directly addresses "69 settings, 7-line README". |
| "Say to your agent: …" line after every documented feature | **Adopt** | Ideal for non-developer owners. |
| `docs/incidents/`, per-release agent-readable migration notes, inline "Known limitation" | **Adopt** | Cheap credibility for an open-source launch. |
| Batch community PRs into credited "waves" | **Adapt** | Sensible for a solo maintainer; their automated PR gate failed within a day — don't copy that. |
| gstack: skill docs generated from code + CI freshness check; static → E2E → judge test tiers | **Adopt** | Keeps skills honest about which capabilities/grants exist. |
| gstack: skill tiering (always-on / routed / dormant) + reachability check | **Adapt** | Only matters past ~50–100 skills; design the manifest so it is possible. |
| gstack opt-in telemetry; gbrain Memorable integration | **Ignore** | Violates "nothing phones home" / no US cloud. Keep only the disclosure format ("what we verify vs what is the vendor's claim"). |
| `brain.audience: personal|shared` — never offer ambient capture on a shared brain | **Adopt** | A ready-made rule for Lares's coming multi-user product. |
