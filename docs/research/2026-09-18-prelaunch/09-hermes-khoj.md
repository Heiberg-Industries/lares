# 09 — Hermes Agent (Nous Research) and Khoj

Researcher report for LAR-71, 2026-09-18. Read-only. All code read through the GitHub API / raw.githubusercontent.com; no clone, no install, no run.

## Header

### Source A — Hermes Agent
- Repo: https://github.com/NousResearch/hermes-agent (found with `gh search repos hermes-agent`; unambiguous). Docs site: hermes-agent.nousresearch.com (docs source is `website/docs/` in the repo — that is what I read).
- Default branch `main`, commit `14e1c1a`, 2026-09-18. Latest release `v2026.9.14` (2026-09-14). Releases roughly every 3–7 days (v2026.8.19, 8.27, 8.31, 9.7, 9.11, 9.14).
- Licence: MIT. Stars ~246,800, forks ~51,700, **open issues+PRs ~44,200**, ~1,900 PRs merged since 2026-09-01. Python, ~15,000 files in the tree, repo size ~1 GB.
- Read: `website/docs/user-guide/features/{memory,curator,skills,honcho,memory-providers,cron}.md`, `user-guide/security.md`, `user-guide/egress/network-isolation.md`, `getting-started/quickstart.md`, `developer-guide/adding-tools.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docker-compose.yml`, `optional-mcps/linear/manifest.yaml`, code: `agent/background_review.py`, `tools/memory_tool.py`, `tools/skill_provenance.py`, `hermes_cli/config_defaults.py`, `agent/curator.py` (config parts). Issues #105921, #7816, #79686, #78515, #30220, #90446, #55647 and issue-title searches.
- Unverified: the "smart" approval mode internals, `hermes insights` output, the desktop app, the Nous Portal billing path, real first-run minutes (docs claim "under 5 minutes"). Did not read the 212 KB configuration page in full.

### Source B — Khoj
- Repo: https://github.com/khoj-ai/khoj, docs https://docs.khoj.dev (source in `documentation/docs/`).
- Default branch `master`, commit `ae229ca`, **2026-08-02** (nothing since). Latest release `2.0.0-beta.28`, **2026-03-26** — still "beta" after 28 betas. Licence AGPL-3.0. Stars ~37,400, 150 open issues+PRs.
- Read: `README.md`, `docker-compose.yml`, docs `get-started/{setup,privacy-security}`, `advanced/{admin,authentication}`, `features/{search,agents,automations}`, `clients/obsidian`, `miscellaneous/{telemetry,performance}`; code `src/khoj/processor/content/text_to_entries.py`, `search_type/text_search.py`, `database/models/__init__.py`, `database/adapters/__init__.py` (search + memory parts), `routers/{api_content,api_memories,helpers}.py`. Issue #1334 and the open-issue list.
- Unverified: the Obsidian plugin's own sync code (I read the server side and the plugin doc, not the plugin source), the enterprise/cloud product, blog posts, Discord. Whether AGPL *caused* the contributor pattern below is inference, marked as such.

---

# PART A — HERMES AGENT

## A1. Memory

**Truth.** Two small markdown files per profile, `~/.hermes/memories/MEMORY.md` (agent's notes) and `USER.md` (user profile). Entries separated by `§`. Conversations live in one SQLite file, `~/.hermes/state.db`, with FTS5 full-text search (`website/docs/user-guide/features/memory.md`). **Confirms** the consensus (files = truth, one conversation record, keyword index beside it). No vectors in the built-in path at all.

**Always-loaded size, and how it is bounded — this EXTENDS the consensus with hard numbers.**
- `memory_char_limit: 2200` (~800 tokens), `user_char_limit: 1375` (~500 tokens) — `hermes_cli/config_defaults.py` lines ~1233–1243. Total always-loaded ≈ 1,300 tokens.
- The cap is in **characters, not entries**, and the header the model sees shows the fill level: `MEMORY (your personal notes) [67% — 1,474/2,200 chars]`.
- **No auto-compaction.** A write that would overflow returns a tool *error* with the current entries, and the agent must merge/remove in the same turn, then retry. Exact duplicates are rejected.
- **Frozen snapshot:** memory is injected once at session start and never changes mid-session, deliberately, to keep the model's prompt cache warm. Writes go to disk at once but are only seen next session. Lares injects standing facts "every turn (cap 40)" — Hermes's equivalent is per *session*, and sized by characters.
- Consequence they document honestly: on Telegram/Slack a chat is one endless session, so the learning loop "almost never gets to fire"; users are told to type `/new` at natural boundaries. This is a real product wart for a chat-door product like Lares.

**Recall.** (a) the frozen block, always; (b) `session_search` tool over FTS5 — "no LLM summarization, no truncation", ~20 ms, agent-triggered; (c) optional external provider which prefetches before each turn. Confirms "small core + fetch on demand".

**Nudges (the learning loop).** `memory.nudge_interval: 10` (turns) and `skills.creation_nudge_interval` (15 tool-turns in issue #105921). When the counter trips, after the turn ends Hermes **forks the agent in a background thread**, replays the same conversation (same system prompt, same tools, byte-identical so it hits the warm prompt cache = cheap) and appends one review prompt: "Review the conversation above and consider saving to memory…" (`agent/background_review.py` lines 298–310). The fork runs under a **dispatch-side tool whitelist**: memory + skill tools + read-only file tools, nothing else (`_review_tool_whitelist`, ~line 1025). Optional cheaper model via `auxiliary.background_review` (then it replays a digest instead; "~3–5× cheaper"). Can be disabled. A chat line "💾 Memory updated" tells the user it happened (`display.memory_notifications: off|on|verbose`).
- So Hermes's "dreaming" is **per-conversation and immediate**, not nightly. Cost is bounded by reuse of the prompt cache, not by batching.

**Correction and forgetting.** `memory` tool has `add / replace / remove` (substring match). Owner surfaces: edit the files by hand; `hermes journey list|edit|delete` (a timeline of everything learned — memory chunks and skills — with edit/delete); `/memory pending|approve|reject`.

**Gate.** `memory.write_approval` — **default false** (writes freely). When true: CLI prompts inline; chat platforms and the background fork **stage** writes for `/memory pending`. This CONFIRMS "propose, don't edit in place" as the *safe* mode, but Hermes ships with it off.

**The incident that proves the consensus (#105921, 2026-09-08, closed).** A background fork started for a *skill* review hit the near-full memory error ("Consolidate now: use replace… or remove…"), obeyed it, and **deleted five memory entries in 15 ms — four were standing permission rules the user had built up over months. Nothing told the user.** Fix now in code: `tools/memory_tool.py::_background_delete_gate` — an unattended fork may only `add`; any `replace`/`remove` is staged as a proposal; if staging fails it denies. This is exactly "add/supersede rather than delete; consolidation proposes" — arrived at by losing data.
- Second lesson from the same incident: **the user was keeping permission rules in model-editable memory.** Lares keeps autonomy in grants/ratchet tables, not in memory — keep it that way and say so in docs.

**Provenance / injection.** Memory entries are scanned for injection/exfiltration patterns and invisible Unicode before being accepted "since they're injected into the system prompt". It is a regex heuristic; open issue #27284 says it misses multi-word variants. There is **no per-entry provenance field** (no "where did this come from") — the consensus item "every memory records its source; third-party content never promoted" is **NOT implemented in Hermes**; the only provenance is a process-level flag (foreground vs background_review). Lares should not copy this gap.

**User modelling / Honcho.** Optional plugin, one of 8 in-tree "memory providers" (honcho, mem0, supermemory, byterover, hindsight, holographic, openviking, retaindb) — additive, built-in files keep working. Honcho (plastic-labs/honcho, **AGPL-3.0**, ~7.2k stars) can be **Honcho Cloud (app.honcho.dev — US company, US hosting; unverified region)** or **self-hosted** with a base URL + JWT. It sends every message to the Honcho server, which runs its own LLM "dialectic" passes (1–3) to build a "representation" of the user, and injects up to `dialecticMaxChars: 600` per turn; cadence knobs `contextCadence`, `dialecticCadence`, `dialecticDepth`. For Lares: cloud Honcho fails the sovereignty filter; self-hosted Honcho is a second LLM-calling service with its own database — heavy. The idea worth keeping is the *shape*: a tiny, capped, separately-budgeted "who is this person right now" block.
- CONTRIBUTING.md: "We are no longer accepting new memory providers into this repo" — closed set, new ones ship as standalone plugins. A reversal worth noting (see Traps).

**Scale.** Built-in memory does not scale by design (it is a 1,300-token note). Thousands of notes are not a Hermes concept — knowledge goes into *skills* with `references/` files (see A4) or an external provider. **Per-user scoping:** memory is per *profile* (a separate home directory), not per person. Docs warn: never point two agent processes at one home.

## A2. Integrations
- **Built-in tool = 2 files**: `tools/<name>.py` (handler + schema + availability check + `registry.register()`; auto-discovered) and one line in `toolsets.py` (`developer-guide/adding-tools.md`). CONFIRMS registry pattern.
- **Policy reversal that matters:** CONTRIBUTING.md now says third-party product integrations "do not land in this repo… maintenance load, not quality" — ship as a standalone plugin (`~/.hermes/plugins/`, pip entry point). Same for memory providers. CONFIRMS "un-reviewed third-party only outside the engine" and EXTENDS it: even *good* third-party integrations stay out of core.
- **Vetted MCP catalogue:** `optional-mcps/<name>/manifest.yaml` (~70 entries: linear, notion, stripe, supabase…). "Presence in this directory = approval. Merged via PR review." Manifest carries transport URL, auth type (native MCP OAuth 2.1 + dynamic client registration handled by one `mcp_oauth_manager`), optional `tools.default_enabled` subset, and post-install text. Install shows a **tool checklist** so the owner prunes what the agent may call. This is the cleanest form of "quality tier for MCP" I have seen: a reviewed manifest, zero code.
- **Skills hub trust levels** (`features/skills.md`): `builtin` / `official` (optional-skills/ in repo) / `trusted` (named registries: anthropics/skills, openai/skills…) / `community`. Every hub install is scanned; `--force` overrides warnings but **never** a `dangerous` verdict. CONFIRMS quality ladder + SKILL.md as the format (agentskills.io, skills.sh, well-known endpoints).
- Tokens: `~/.hermes/.env`, plus secret-source plugins (1Password, Bitwarden, command). MCP subprocesses get a filtered environment. Skills declare `required_environment_variables`; the value is asked for **only in the local CLI, never in chat**.
- Writes to the outside world: **no general approval for outbound writes.** Approval exists only for dangerous *shell commands* (A6). An MCP "send email" tool just runs. Lares's approval-card model is stricter and should stay.

## A3. First run
- `curl -fsSL …/install.sh | bash` (or desktop installer) → `hermes setup` with three modes: **Quick (Nous Portal OAuth, no keys)**, **Full**, **Blank Slate** (everything off except model + file + terminal; "nothing you didn't choose ever loads — not even after update"). Docs claim under 5 minutes; unverified.
- First door: **CLI**. Bots come second: "if Hermes cannot complete a normal chat, do not add more features yet." CONFIRMS "prove one real completion first"; CONTRADICTS "web chat first" (their web dashboard is an admin surface; chat-first is the terminal). Not a model for a non-developer.
- `hermes doctor`, `hermes cron doctor`, `hermes config migrate`. CONFIRMS doctor.
- Needs: a model key or Portal login. No public URL (Telegram long-polling etc.).
- Configuration reference is **212 KB**, environment variables page 102 KB. That is the cost of their breadth; it is the 69-settings problem at 10×.

## A4. Defining an agent — and the self-written skills system (the main addition)
- Agent = a **profile**: a home directory with `config.yaml`, `SOUL.md` (persona, markdown), memory, skills, its own credentials and bot tokens. Non-developers can edit SOUL.md; everything else is YAML. Permissions are *toolsets* enabled per platform (`platform_toolsets.cli`, `agent.disabled_toolsets`), not per-capability grants. Sub-agents: `delegate_task` with a cheaper model option; cron sessions; a kanban board for multi-agent lanes. "Profile distributions" install a third party's whole profile from a git URL (their SOUL.md is scanned and can be blocked).

**How the agent writes its own skills**
1. *Foreground:* the system prompt asks it to save non-trivial workflows with `skill_manage` (`create`, `patch` (preferred), full rewrite, `delete`, `write_file`, `remove_file`). `/learn <anything>` turns a folder, URL, pasted procedure or "what I just walked you through" into a skill; big sources become a lean SKILL.md + `references/` per chapter.
2. *Background:* the same post-turn fork as memory, with `_SKILL_REVIEW_PROMPT` (background_review.py ~369–455).
3. Storage: `~/.hermes/skills/<category>/<name>/SKILL.md` + `references/`, `templates/`, `scripts/`. Progressive disclosure: list (~3k tokens) → `skill_view(name)` → `skill_view(name, path)`.

**What review or gate exists before a self-written skill runs? By default: none.**
- `skills.write_approval: false` (default) — writes land freely. When true, every write is **staged** under `~/.hermes/pending/skills/<id>.json`; chat shows a one-line gist, `/skills diff <id>` shows the full diff, `/skills approve|reject`. They note a SKILL.md is "far too large to read in a chat bubble" — so approval in chat is on a *gist + metadata*, full diff on a bigger surface. Useful UX pattern for Lares's Slack/Telegram cards.
- `skills.guard_agent_created: false` (default) — a content scanner that was **turned off by default** because "real agent workflows that legitimately touch ~/.ssh/ or mention $OPENAI_API_KEY were tripping the heuristic too often." Open issue #78515 complains: agent-authored skills bypass the scan and then load into every session.
- A skill cannot widen permissions in Hermes because there are no per-skill permissions: skills are text the agent follows with whatever tools the profile has. Lares's "a skill's requirements can never widen grants, enforced at build" is **stronger**; nothing to borrow here, and do not weaken it.

**Guards they added after things broke (each is a lesson):**
- **Read-before-write, enforced in the tool** — the fork must `skill_view` a skill in this review before patching it. Origin: #55647 — a review pass rewrote a Python script from 807 to 186 lines from memory of the transcript; an hourly cron failed five times before anyone noticed. The guard itself then broke the feature twice (#75618, #95976 "fails to update skills 100% of the time") and caused a retry loop that burned **1.4 M input tokens for nothing** (#90446; cap is 16 iterations, no token budget).
- **Ownership by declared policy, never inferred.** Only skills the *background fork* created are "curator-managed". Bundled, hub-installed, external, pinned and **anything the user asked for** are off-limits to autonomous edits; the fork must say "this looks outdated, run `hermes curator adopt <name>`" instead. Origin: #20273 (fork overwrote bundled/hub skills). Their wording: "`created_by` is a policy flag, not a provenance claim… an automatic 'looks agent-made, adopt it' heuristic would eventually archive something you hand-wrote."
- **Content contract in the prompt** (`_LESSON_LAYER_BLOCK`, `_DO_NOT_CAPTURE_BLOCK`): procedure first; a pitfall = a general rule + one clause of why; no PR numbers, dates, quotes; one lesson = one rule; fix in place, never append "UPDATE:"; class-level names only. And what **not** to learn: environment failures, one-off tasks, unresolved failures dressed up as best practice, and — the sharpest line — *"Negative claims about tools ('X tool is broken')… harden into refusals the agent cites against itself for months after the actual problem was fixed."* This applies directly to Lares's dream cycle for preferences.
- An advisory linter on skill writes (`incident-log-shape`, `references-sprawl` >60 files) — warns, never blocks.
- Open complaint #30220: the review prompt says "Be ACTIVE — a pass that does nothing is a missed learning opportunity", which biases the model to save *something*, and to save the same fact in both memory and a skill.

**Revising and retiring — the Curator** (`features/curator.md`, `agent/curator.py`, config defaults ~1408–1430):
- Usage sidecar `~/.hermes/skills/.usage.json`: `use_count`, `view_count`, `patch_count`, timestamps, `state`, `pinned`. Kept **beside** the skill, not in its frontmatter (so use does not rewrite files).
- Phase 1, deterministic, no model cost, always on: unused 14 days → `stale`; 30 days → moved to `.archive/` (code defaults; the doc page also says 30/90 in one place — docs inconsistent). Never-used skills get a grace floor. **Never deletes.** Pinned skills and any skill named by a cron job (even a paused one) are skipped.
- Phase 2, LLM consolidation into "umbrella" skills: **off by default** ("costs tokens every run and makes broad structural changes"); 50–100 API calls per sweep.
- Trigger: not a clock — runs when last run > 7 days ago **and** the agent has been idle 2 h. First run after install is deferred a full interval so the owner can pin things first. `--dry-run` produces the same report without changes.
- Safety net: tar.gz snapshot of the skills tree before every real pass (keep 5); `hermes curator rollback`; an **append-only JSONL ledger** of every skill mutation by any actor (curator / agent / user) with before/after file hashes and content-addressed blobs; `rollback <entry-id>` undoes one mutation and "fails closed". Per-run `REPORT.md`. Purge of the archive is manual only.
- PROMOTE BY USE, RETIRE BY DISUSE — CONFIRMS the consensus from the retirement side and adds the mechanism.

## A5. More than one person
Single-tenant by declaration (`SECURITY.md` §2: "a single-tenant personal agent"). "Multi-user" = who may talk to the bot: per-platform allow-lists, a global allow-list, and **DM pairing** — an unknown sender gets an 8-character code, the owner approves with `hermes pairing approve`; alternatives `ignore` or a one-time polite `decline`. No roles, no private-vs-shared memory; separate people = separate profiles. Honcho can map chat ids to separate "peers". Nothing here for Lares's org/user model except the pairing flow.

## A6. Safety
- Stated plainly: **"The only security boundary against an adversarial LLM is the operating system. Nothing inside the agent process constitutes containment — not the approval gate, not output redaction, not any pattern scanner, not any tool allowlist."** Everything in-process is called a heuristic. Worth quoting in Lares's own security page.
- Sandbox back-ends for the terminal tool: `local` (**default** — config_defaults.py line 260), `ssh`, `docker`, `singularity`, `modal`, `daytona`, `vercel_sandbox` (the last three are US cloud). Docker runs cap-drop ALL, no-new-privileges, pids-limit 256, size-limited tmpfs, empty env allow-list. In container back-ends the dangerous-command check is **skipped** ("the container is the boundary"). MCP servers, plugins, hooks and skill scripts still run in the agent process unless the whole process is wrapped (their Docker image). Default compose uses `network_mode: host`; an optional guide adds an internal network + squid/envoy allow-list proxy — i.e. Lares's sealed egress is their *advanced* option.
- Dangerous-command approvals: regex list → `approvals.mode: smart` (default; an auxiliary model auto-approves low risk, auto-denies high, escalates the rest) | `manual` | `off`. Choices once / session / always / deny. **Timeout 300 s = deny, and a timeout is not counted as a denial.** Headless contexts each have their own default **deny**: `cron_mode`, `single_query_mode`, `unattended_mode`. A **hardline blocklist** below everything that not even `--yolo` or "always allow" can override. `hermes approvals suggest` mines 90 days of approvals into allow-list *proposals*, never auto-applies, and **never proposes destructive classes however often approved** ("`rm -rf build/` approved 100 times still never yields an rm entry"); masks credentials in examples.
  - This is a read-only cousin of Lares's ratchet: promotion by recurrence, proposed to the human, with classes that can never graduate. CONFIRMS Lares's "always-ask" tier.
- Prompt-injection: context files (AGENTS.md, SOUL.md from a third party) are regex-scanned and blocked; the owner's own SOUL.md only warns. SSRF protection, website allow/deny policy, credential redaction in output.

## A7. Cost and visibility
- No spend caps found (unverified beyond the pages read). Open request #90446 asks for a token budget + circuit breaker on background reviews. Usage per task is stored (`session_model_usage`, `task='background_review'`). `hermes insights --days N`.
- Cron is the most mature part: **pre-dispatch validation** (key resolves, skills ready, delivery target known, MCP servers up) → status `blocked_config`, **one** alert, **no model call**; model **snapshotted at job creation** so changing the chat model never silently moves unattended jobs to a paid model; the agent's cron tool **cannot** set a job's model or thinking level ("inference pins are user-owned"); delivery tracked separately from execution, with an `UNVERIFIED` state when the chat adapter acks without a message id; `[SILENT]` to suppress "all fine" reports (failures always deliver); `[CRON_FAILURE]` first line lets the agent declare its own run failed; cron sessions cannot create cron jobs unless opted in; acknowledgeable failure incidents; `hermes cron doctor`.
- Natural-language scheduling: the user just says "every morning at 9 send me X on Telegram"; the agent calls one `cronjob` tool; schedule strings like `"every 2h"`, `"in 30m"` or cron syntax; `deliver:` = origin / local file / named platform / fan-out. **The agent never sends the message itself — the scheduler delivers the final answer.**

## A8. Community
MIT. Hyper-active (≈1,900 merged PRs in 18 days) with ~44k open issues/PRs — far beyond what humans triage; issue quality suggests many are agent-written. Closed sets and "publish it as your own repo" rules are how they cope. Docs: Docusaurus, user-guide / developer-guide / reference / guides, four languages. `AGENTS.md` and an `evals/` folder of named regression probes. "What works" is stated per feature with default values and "off by default because…" explanations rather than a status table.

---

# PART B — KHOJ

## B1. Memory / knowledge
**Truth = the user's own files, wherever they live; the server holds a copy.** Clients (Obsidian plugin, desktop app, Emacs, web drag-and-drop) **push** files to the server: `PUT/PATCH /api/content` (`routers/api_content.py` 75, 97). Server stores full text in `FileObject.raw_text` and chunks in `Entry` (Postgres + pgvector). One-way, client → server. **Confirms "no two-way sync"**; Khoj never writes back into the vault. Notion and GitHub are pulled with a token, read-only.

**Indexing** (`processor/content/text_to_entries.py`):
- Per-format parsers (markdown by heading, org, pdf, docx, plaintext, image, notion, github) → entries → split to **max 256 tokens** per chunk (`split_entries_by_max_tokens`, line ~61), heading kept with the chunk ("compiled" text).
- **Incremental by content hash:** md5 of each chunk; only hashes not already in the database are embedded; hashes that vanished from a file are deleted; deleted files removed (lines ~154–263). Batches of 200. No file-watcher on the server — the client decides when to sync (Obsidian: "synced periodically" + Force Sync).
- Embeddings default **`thenlper/gte-small`** run **locally on the server** with sentence-transformers (models cached in a volume); optional OpenAI-compatible / HuggingFace endpoint. Changing the model = full re-index.
- `Entry.embeddings = VectorField(dimensions=None)`; `EntryDates` table for date filters.

**Search = vector + rerank, NOT hybrid.** `EntryAdapters.search_with_embeddings` (adapters ~2150): cosine distance in pgvector, filtered by owner, cut at `bi_encoder_confidence_threshold` (default 0.18), top 10; then cross-encoder rerank with **`mixedbread-ai/mxbai-rerank-xsmall-v1`**, also local. Keyword matching exists only as explicit query filters (`+"word"`, `-"word"`, `file:`, `dt:`), applied before the vector step. Performance page: "<100 ms" search, "<2 s" rerank of 15, 100K-line corpus indexes in ~10 min — and it says "last evaluated in 2022".
- For Lares (keyword-only today, pgvector idle): this is the **index-beside-the-files** pattern in its simplest working form, on the exact stack Lares already runs. It EXTENDS the consensus with specifics: hash-per-chunk incremental sync, 256-token chunks with heading carried, tiny local embedding + tiny local reranker, distance threshold as the one tuning knob. It CONTRADICTS nothing, but note Khoj skipped keyword search entirely and users still ask for it; Lares should keep keyword and *add* vectors.

**Conversation memory** (`UserMemory` table + `routers/helpers.py` ~988–1066): after a turn an LLM call `extract_facts_from_query` returns `{create: [...], delete: [...]}` and both are **applied immediately** — the model deletes facts in place, no proposal step, no source field, no recurrence test. Recall each turn = last 7 days (limit 10) + vector search. Owner can list / edit / delete in settings (`/api/memories`), and turn memory off. **CONTRADICTS the consensus** (proposes-not-edits, add-not-delete, provenance) — it is the pattern the other researchers warned about. A `manage_memories` admin command exists.

**Owner visibility.** Web settings: list of indexed files, delete per file / per type / per source, index size; memory list. Admin: Django admin over every table. No view of chunks or "why did this match".

**Per-user scoping.** Every `Entry`, `FileObject`, `Conversation`, `UserMemory` has a `user` foreign key; 74 adapter methods carry `@require_valid_user`. Application-level filtering, not database row-level security.

## B2. Integrations
Few and hand-written: Notion, GitHub (read-only data sources), web search providers (SearxNG self-hosted default; Serper, Firecrawl, Exa, Olostep paid), code sandbox (Terrarium self-hosted default; E2B cloud), Resend for email, Twilio/WhatsApp, image/voice providers. An `McpServer` table (name, path, api_key) — MCP servers added **by the admin in the admin panel**, shared by all users. No registry, no scaffold, no tiers, no write approvals (Khoj barely writes to the outside world — it emails *you*). Tokens live in Postgres rows. Nothing to steal; confirms that a notes product can stay small here.

## B3. First run
`mkdir ~/.khoj && wget docker-compose.yml` → edit 3 values (admin password, Django secret, one model key or an Ollama URL) → `docker-compose up` → open `http://localhost:42110`. Five containers: pgvector Postgres, server, Terrarium sandbox, SearxNG, optional "computer". **First door = web chat**, with `--anonymous-mode` on by default (no login, single implicit user). CONFIRMS web-chat-first and few questions. Rough edges they document: "restart your server after the first run", CSRF error if you use 127.0.0.1 instead of localhost, DISALLOWED_HOST on a custom domain, container "Killed" for low memory (local embedding models). Model configuration afterwards happens in **Django admin** — raw database forms. No doctor command, no key test.
- Fully offline is real: local embeddings + reranker by default, Ollama/LM Studio for chat, SearxNG for search, Terrarium for code. Outside services are only needed for email login links and automation emails (Resend), and paid web readers.
- **Telemetry is ON by default** to PostHog (opt-out `KHOJ_TELEMETRY_DISABLE=True`). One of the last two commits (2026-08-02) is "Stop sending client IP in telemetry so it matches the privacy docs" — i.e. the docs said "we do not log your IP" while the code sent it. For an AGPL privacy product this is the trap to avoid; Lares's "nothing phones home" is the right call.

## B4. Defining an agent
A database row (`Agent` model, models ~248–350): name, `personality` (prompt), chat model, `input_tools` (general / online / notes / webpage / code), `output_modes` (image / diagram), icon + colour, `privacy_level` **public / protected / private**, `managed_by_admin`, creator. Created by any user in a web form — the most non-developer-friendly agent builder of the projects reviewed.
- **Scoped knowledge base:** `Entry` and `FileObject` have `user` **xor** `agent` (save() raises if both). Files given to an agent are indexed *again as the agent's own entries*; search uses `Q(user=user) | Q(agent=agent)`. So an agent's knowledge is a separate copy that travels with the agent when it is shared — simple, but duplicates storage and goes stale when the source note changes. `UserMemory` also has an optional `agent` key (memories per agent).
- No sub-agents, no hand-off, no permissions beyond the five tool switches.

## B5. More than one person
- Accounts: `KhojUser` (Django user) + uuid; login by **email magic link** (needs Resend, or the admin copies the link from the admin panel by hand) or **Google sign-in — only in the separate `khoj-cloud` "prod" image**. API keys per user for clients (`KhojApiUser`). Default self-host is anonymous single-user; multi-user is "remove `--anonymous-mode`".
- Isolation: per-user foreign keys (B1). Sharing: public agents server-wide; "protected" = by link; shared conversations become `PublicConversation` copies. No organisations, no teams, no roles beyond Django superuser, no shared notes between users. `Subscription` and `PriceTier` rows and rate limits are in the open repo — the cloud's billing logic is shipped to self-hosters.
- Admin panel = stock Django admin: see and edit all users' entries and conversations. Fine for a family server, not a trust model for a business.
- Take-away: Khoj's multi-user is **"many private silos + public agents"**. Lares's foundation (orgs, grants, private/org/participants note scopes) is already richer than Khoj's product. What Khoj shows is the *minimum product* that made it usable: magic-link login, per-user API keys for clients, an agent privacy switch with three values, and a share-a-copy model.

## B6. Safety
Code runs in Terrarium (Pyodide sandbox container) or E2B; "operator" computer-use in its own container (needs the Docker socket — off by default). No approvals, no egress limits, no injection handling found (unverified beyond files read); retrieved notes and web pages go straight into the prompt. Secrets in env + database rows.

## B7. Cost and visibility
`model_to_cost` table in `utils/constants.py` and `get_chat_usage_metrics` give per-request cost in logs/traces; per-user rate limits (`RateLimitRecord`, `UserRequests`); subscription tiers choose model class. No spend cap or owner dashboard for self-hosters.

## B8. Community, licence, health — the finding
- **Slowed sharply.** Commits per month: Dec-2025 21, Feb 9, Mar 25, Apr 0, May 0, Jun 10 (one day, 2026-06-24, mostly dependency bumps), Jul 0, Aug 2, Sep 0. Last release 2026-03-26. README top banner now promotes **Pipali** ("our open-source AI coworker that runs on your computer", created 2025-12-22, last push 2026-09-14, ~300 stars) — and Pipali is **Apache-2.0, not AGPL**. Issue #1334 "Is active development of the self-hosted Khoj server continuing?" — founder, 2026-06-12: "development has slowed down but it is not in maintenance mode. We'll hopefully add some stuff soon." Outside PRs from Aug–Sep 2026 sit with zero comments.
- **Contribution shape:** debanjum 3,497 commits, sabaimran 1,560, third place **16**. After five years and 37k stars, the project is two people. No CLA found in the repo. Whether AGPL caused that is unprovable from here (inference); what *is* visible: (1) AGPL did not stop a hosted offering — the company ran app.khoj.dev on AWS from the same code, with a `khoj-cloud` image carrying Google login, and "Khoj Enterprise: cloud, on-prem, hybrid"; (2) AGPL did not create a contributor community; (3) when the company's attention moved, there was nobody else to carry the project; (4) their next product chose a permissive licence.
- "What works" is not stated anywhere: perpetual "2.0.0-beta.N", a performance page dated 2022, an admin doc that says of one field "not currently configurable" and of another "not currently used in any client app". No status table. This is the counter-example for Lares's honest-status page.

---

# Patterns worth stealing

| # | Pattern | Where |
|---|---|---|
| 1 | Always-loaded memory capped in **characters**, fill level shown to the model in the header, overflow = tool error that forces a merge, never silent drop | Hermes `features/memory.md`; `config_defaults.py` ~1240 |
| 2 | **Unattended processes may only add; replace/remove are staged as proposals; staging failure = deny** | Hermes `tools/memory_tool.py::_background_delete_gate` (#105921) |
| 3 | Review fork under a **dispatch-side tool whitelist** with opt-in `extra_tools` ("prefer tools that stage a proposal") | Hermes `agent/background_review.py` ~1025–1065 |
| 4 | **"Do not capture" list** for any learning loop: environment failures, negative claims about tools, one-off tasks, unresolved failures | Hermes `background_review.py` `_DO_NOT_CAPTURE_BLOCK` |
| 5 | Skill content contract: rule + one clause of why, no dates/ticket numbers/quotes, fix in place, class-level names | same file, `_LESSON_LAYER_BLOCK` |
| 6 | **Usage sidecar** (use/view/patch counts, state, pinned) beside skills; deterministic active → stale → archived; never delete; anything a scheduled job references is protected | Hermes `features/curator.md`, `agent/curator.py` |
| 7 | **Ownership is declared, never inferred**: only machine-created items may be machine-edited; `adopt` hands one over; pin blocks | same |
| 8 | Snapshot before every maintenance pass + append-only **mutation ledger** with actor, before/after hashes, single-entry rollback, `--dry-run`, first run deferred one interval | same |
| 9 | Approval in chat on a **one-line gist**, full diff on a bigger surface; pending items survive restarts | Hermes `features/skills.md` "Gating agent skill writes" |
| 10 | `approvals suggest`: mine approval history into allow-list *proposals*; destructive classes can never graduate | Hermes `user-guide/security.md` |
| 11 | Timeout = deny, and a timeout is not a refusal; separate fail-closed defaults for cron / one-shot / webhook contexts | same |
| 12 | Scheduled-job hygiene: pre-dispatch validation with zero model spend, one alert not one per tick, model pinned at creation and not settable by the agent, delivery status separate from run status, `[SILENT]`, agent-declared failure, scheduler delivers (agent does not send) | Hermes `features/cron.md` |
| 13 | Vetted MCP catalogue as reviewed **manifest files** + install-time tool checklist | Hermes `optional-mcps/*/manifest.yaml` |
| 14 | Skills hub trust levels; `--force` never overrides a `dangerous` verdict; secrets asked for only in the local CLI, never in chat | Hermes `features/skills.md` |
| 15 | "Blank Slate" setup mode: explicit allow-list that updates can never widen | Hermes `getting-started/quickstart.md` |
| 16 | The sentence: "the only security boundary against an adversarial LLM is the operating system" — and labelling every in-process check a heuristic | Hermes `SECURITY.md` §2.2 |
| 17 | **Chunk-hash incremental index** into pgvector: md5 per 256-token chunk, embed only new hashes, delete vanished ones | Khoj `text_to_entries.py` ~142–263 |
| 18 | Small **local** embedding model + small **local** cross-encoder reranker; one distance threshold as the tuning knob | Khoj `models/__init__.py` 558–582, `text_search.py` |
| 19 | One-way push of notes from the owner's tools to the server (Obsidian plugin → `/api/content`); server never writes back | Khoj `routers/api_content.py` |
| 20 | Agent privacy switch with three values (private / protected-by-link / public) and a web form to create an agent | Khoj `Agent` model |
| 21 | Magic-link login with an admin fallback ("copy the login link from the admin panel") so no mail service is strictly needed | Khoj `advanced/authentication.mdx` |
| 22 | DM pairing code for unknown senders | Hermes `user-guide/security.md` |

# Traps they hit

**Hermes**
- Unattended fork deleted months of user rules from memory, silently (#105921). Cause: whitelist was per tool, not per operation, and the "memory full" error *told* the model to delete.
- Review fork rewrote a user's script from transcript memory, 807 → 186 lines; cron broke (#55647). Fix (read-before-write guard) then broke the feature twice (#75618, #95976) and caused a 1.4 M-token loop (#90446). No token budget on background work yet.
- Fork and curator overwrote bundled/hub skills (#20273). Curator archived things users could not restore (#83580); archiving bundled skills by default is contested (#103098); provenance mislabelling (#95415).
- Content scanner for agent-written skills switched **off by default** for false positives; users object (#78515). Regex injection scanners miss variants (#27284).
- "Be ACTIVE" wording makes the reviewer save something every time, and into both stores (#30220).
- Endless chat sessions mean memory never refreshes; users must type `/new`.
- Closed the door on in-tree memory providers and third-party integrations after absorbing eight: maintenance load.
- Default terminal back-end is the host; default compose is `network_mode: host`. 212 KB of configuration docs. 44k open issues.
- Users kept **permission rules in memory**; the product let them.

**Khoj**
- Telemetry on by default, and it sent client IP while the privacy page said it did not (fixed 2026-08-02 by an outside contributor).
- Memory facts created and **deleted in place by the model every turn**, no source, no review.
- Agent knowledge base is a copy → storage doubles and goes stale.
- Vector-only search; keyword only as manual filters.
- Configuration through raw Django admin; first-run needs a restart; CSRF/host errors on anything but localhost; Google login only in a different image.
- Two-person bus factor; development slowed without announcement; perpetual beta; successor product under a different licence.
- Cloud billing/subscription code lives in the self-host code path.

# Verdicts for Lares

| Idea | Verdict | Why |
|---|---|---|
| Character-capped always-loaded block with fill level visible to the model; overflow forces a merge | **Adapt** | Replace "cap 40 facts" with a size budget + visible fill. But the merge must be a *proposal* when unattended (see next). Runs locally, no licence issue (idea only). |
| Unattended = add-only; edits/deletes staged for the owner | **Adopt** | Matches the consensus and Lares's approval culture; Hermes paid for this lesson. Apply to the dream cycle and to any skill/Atlas writer. |
| Dream-cycle "do not learn" list (negative tool claims, environment failures, one-offs, unresolved failures) | **Adopt** | Pure prompt/policy text; write Lares's own wording. Directly protects standing facts and preferences. |
| Learning right after a conversation using the warm prompt cache, instead of nightly | **Adapt** | Cheaper per insight and fresher, but Lares routes through LiteLLM aliases and prizes reviewability; keep nightly as the *promoter*, consider a post-conversation pass only to *collect candidates*. Needs a token budget from day one (#90446). |
| Skill usage sidecar + stale → archive, never delete, referenced-by-schedule = protected | **Adopt** | Lares skills are flat markdown in git; a small table (or sidecar) of use counts gives retirement by disuse. Archive = move, git keeps history. |
| Declared ownership: machine may only edit what the machine created; "adopt" to hand over; pin | **Adopt** | Fits agent.json/overlay model: engine and overlay skills are never machine-edited. |
| Agent-written skills at all | **Adapt, later, gated on** | Only as proposals behind an approval card (gist in chat, diff in console), and never able to add requirements — the never-widen build check stays. Default must be the opposite of Hermes's (approval ON). |
| Mutation ledger + snapshot + single-entry rollback | **Ignore (git already does it)** | Lares stores are git repos: a commit per machine edit with actor in the message gives the same result. Adopt only the `--dry-run` report and "first run deferred". |
| LLM consolidation of skills into umbrellas | **Ignore** | Off by default even at Hermes; 50–100 calls, broad edits, the source of most of their bugs. |
| `approvals suggest`-style proposals from history, with never-graduate classes | **Adopt** | It is the ratchet made visible: "you approved this 14 times — make it autonomous?" Always-ask classes never offered. |
| Timeout = deny, not counted as refusal; separate fail-closed defaults for scheduled / webhook runs | **Adopt** | Cheap, prevents ratchet pollution and hung jobs. |
| Scheduled-job rules (pre-flight with zero spend, one alert, model pinned and owner-only, delivery status separate, `[SILENT]`, scheduler delivers) | **Adopt** | Directly usable for duties/proactivity; "agent cannot change its own model" matches purpose aliases. |
| Vetted MCP catalogue as manifests + tool checklist at install | **Adopt** | Matches the plan (MCP for user-added tools). Manifest-only entries need no engine code. Remote MCP servers are mostly US-hosted — the manifest should carry a data-location field and the console should show it. |
| Honcho for user modelling | **Ignore (cloud) / Ignore for now (self-hosted)** | Cloud fails the no-US-cloud filter. Self-hosted is AGPL-compatible but is a second LLM-calling service and database. Keep the idea of a small capped "who is this person now" block built by Lares's own dream cycle. |
| External memory-provider plugin interface | **Ignore** | Hermes closed the set; contradicts "markdown is the truth". |
| Modal / Daytona / Vercel sandbox back-ends | **Ignore** | US cloud. Lares's sealed containers are already stricter than Hermes's default. |
| "OS is the only boundary" statement; call in-process checks heuristics | **Adopt (docs)** | Honest framing for the security page; Lares can then say its boundary is container + allow-list proxy. |
| Blank-slate install mode that updates cannot widen | **Adapt** | Equivalent: a new agent starts with zero grants; releases never add grants to existing agents. |
| DM pairing code | **Adapt** | Useful when Lares gets a second person on Telegram/Slack; pair to a user row, not just an allow-list. |
| Khoj chunk-hash incremental pgvector index beside the markdown | **Adopt (as the optional second step)** | Same stack Lares already runs (Postgres + pgvector, unused). Rebuildable, files stay the truth. Re-implement — do not copy AGPL code unless Lares is AGPL too (it will be; still simpler to write in TypeScript). |
| Local small embedding + local reranker | **Adapt** | Sovereignty-perfect. In Lares it should sit behind a LiteLLM alias ("embed", "rerank") served by a local model container; watch memory on small boxes (Khoj's "Killed" error). |
| Vector-only search | **Ignore** | Keep keyword; add vectors; merge. Khoj's manual `+"word"` filters show users still need exact match. |
| Khoj per-turn LLM memory create/delete in place | **Ignore** | Contradicts the consensus; no provenance, no review. |
| One-way push from Obsidian to server | **Adopt (principle)** | Confirms dropping the 15,800-line two-way Notion sync. With git-backed stores Lares does not even need a plugin. |
| Agent knowledge base as a copy owned by the agent | **Ignore** | Use scopes/grants on the one store (Lares already has note scopes); a copy goes stale. |
| Agent privacy switch private / by-link / public + web form | **Adapt** | Map to private / org / participants in the console. |
| Magic link with admin-copy fallback | **Adopt** | Lets multi-user work with no mail vendor; Brevo when configured. |
| Django-admin-style raw configuration | **Ignore** | The console must stay task-shaped. |
| Opt-out telemetry | **Ignore** | Khoj's IP leak shows the reputational cost. Keep "nothing phones home". |
| Billing/tier code in the open engine | **Ignore** | Keeps the engine clean; matches "engine contains nothing about any installation". |

# Contradictions with what Lares does or plans
1. **Standing facts "every turn, cap 40"** vs Hermes's per-session frozen block sized in characters for prompt-cache reasons. Worth checking what per-turn injection costs Lares through LiteLLM.
2. **Promotion at "confidence ≥ 0.8"** — neither project uses model confidence; Hermes's complaints (#30220) show the reviewer is biased to save. Supports the consensus: recurrence/use, not confidence.
3. **Nightly-only dream cycle** — Hermes learns right after the conversation at cache-read prices. Not a reason to switch, but nightly is not the only cheap option.
4. **AGPL expectations.** Khoj is the closest licence/product analogue and it shows AGPL neither built a contributor base nor kept the project alive once the company's focus moved; their new product is Apache-2.0. Hermes (MIT) has the opposite problem — too many contributions. Lares should not plan on community maintenance of integrations under AGPL; plan for a small core the owner can carry alone, with third-party pieces outside the engine (which is already the plan).
5. **Web chat first** holds for Khoj, not for Hermes (CLI first). For Lares's audience Khoj is the relevant precedent.
6. Hermes has **no approval on outbound writes** and defaults to running on the host. Lares is stricter on both; nothing to relax.
