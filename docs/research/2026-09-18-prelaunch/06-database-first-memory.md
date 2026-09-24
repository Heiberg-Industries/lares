# 06 — The database-first memory camp (Letta, Mem0, Zep/Graphiti): the case against files-as-truth

Role: devil's advocate. Research date 2026-09-18. Read-only; nothing installed or cloned (GitHub API + official docs/blogs only).

## Header

| Source | Repo | HEAD (date) | Latest release (date) | Licence | Stars |
|---|---|---|---|---|---|
| Letta (legacy server) | github.com/letta-ai/letta | `5bcdd17` (2026-09-10) — `main` is now only a README pointing elsewhere; V1 server lives on branch `archive`, last commit `56ba9c2` (2026-08-14) | 0.16.8 (2026-05-14) | Apache-2.0 | 24.8k |
| Letta (current) | github.com/letta-ai/letta-code | `7e36892` (2026-09-18) | v0.32.13 (2026-09-17) | Apache-2.0 | 3.4k |
| Mem0 | github.com/mem0ai/mem0 | `19f7134` (2026-09-18) | `openclaw-v1.2.0` (2026-09-18; monorepo tags, core SDK is "v3") | Apache-2.0 | 65.6k |
| Graphiti (Zep's OSS engine) | github.com/getzep/graphiti | `de8eb5b` (2026-09-17) | v0.30.2 (2026-09-08) | Apache-2.0 | 31.0k |

What I read: Letta blog posts (benchmark 2025-08-12, Context Repositories 2026-02-12, "Our next phase" 2026-03-16), docs.letta.com MemFS + memory pages, letta-code `src/agent/prompts/letta_local_memfs.md`, `src/agent/memory-constraints.ts`, file tree. Mem0 `mem0/memory/main.py` (3,868 lines), `mem0/configs/prompts.py`, `mem0/memory/telemetry.py`, docs migration guides (platform + OSS v2→v3), the April 2026 algorithm blog, issues #4956 #5867 #5352. Graphiti `graphiti_core/edges.py`, `utils/maintenance/edge_operations.py`, `graphiti.py`, `telemetry/telemetry.py`, README, issues #963 #1262 #1872, Zep paper abstract (arXiv 2501.13956), Zep's open-source strategy post.

Unverified / not done: I did not run anything, so every latency and accuracy number is the vendor's or an issue reporter's. I did not count Graphiti's exact LLM calls per episode. Cognee and LangMem were skipped (nothing in them that the three above do not cover better). Mem0's hosted-platform internals are closed and unverifiable. Whether Mem0's TypeScript SDK has feature parity: unverified.

**The headline before the detail: two of the three flagship "database-first" projects have walked toward the files position in the last twelve months, by their own published account.** The honest case against files-as-truth is narrower than the camp's marketing, and it is almost entirely Graphiti's.

---

## 1. MEMORY

### 1a. Letta (formerly MemGPT) — the camp's founder changed sides

**What it was.** MemGPT's model: "core memory" = small labelled text blocks pinned in the prompt, edited by the agent with tools like `core_memory_replace`; "archival memory" = passages in a vector table (Postgres + pgvector) searched by tool call; "recall memory" = full message history in the database. Truth = Postgres. The owner saw memory through a web tool (the ADE), not as files.

**What it is now.** The V1 server is retired: the `main` README says "The `archive` branch contains the retired Letta V1 API server… active projects should use the current source" (letta-code). The March 2026 post "Letta's Next Phase" says: "Memory moves from specialized memory tools that edit memory in a database to generalized computer use tools like bash that operate over memory projected into git-backed files" and "Legacy server memory tools like `core_memory_replace` will be removed in favor of straightforward filesystem operations" (letta.com/blog/our-next-phase).

**Truth today:** a git repository of markdown files per agent ("MemFS" / "context repositories"). docs.letta.com/concepts/memfs: "it lives in a git repository owned by the agent"; "Local-only agents commit to a repository on the current machine, so you are responsible for backing it up"; cloud agents push to a Letta-hosted remote. Files need YAML frontmatter with a non-empty `description:`; a pre-commit hook rejects unknown keys and oversized files (`src/agent/memory-constraints.ts`: `maxFileCharacters`, `maxCoreMemoryCharacters`, `maxDepth`, configurable in `.memfs.config.json`).

**Recall:** files under `system/` are loaded into the prompt every turn; the file *tree* (names + descriptions) is always in the prompt as signposts; everything else is read on demand with ordinary file tools. Edits only take effect on the next prompt compile, not mid-turn (`letta_local_memfs.md`).

**What is still a database:** message history. "All of your experience (message history) is stored in *recall memory* automatically by the Letta Code harness (cannot be mutated)… Use the recall subagent to search through past experience" (`letta_local_memfs.md`). So Letta's split is: *raw record of what happened* = immutable store, searched by a sub-agent; *what was learned* = markdown in git.

**Consolidation:** three built-in skills — init, reflection ("dreaming": background sub-agents review recent conversations and update memory; configured with `/sleeptime`; an optional "agent reviews before applying" step "uses more model tokens"), and defragmentation (reorganise files, merge duplicates, with a backup first). `/doctor` audits "placement, duplication, and system-prompt token usage".

**Concurrent writes:** each memory sub-agent gets its own git worktree, then merges back "through git-based conflict resolution" (context-repositories post; `src/agent/memory-worktree.ts` exists).

**Correction / forgetting:** edit or delete the file and commit; history is kept ("you can always inspect or revert past changes"). No documented erasure-from-history procedure — a real gap for GDPR (git keeps deleted text forever unless history is rewritten).

**The benchmark post (2025-08-12, "Is a Filesystem All You Need?").** What it actually showed: a Letta agent on GPT-4o-mini given the LoCoMo conversations as an attached file scored **74.0%**, against Mem0's self-reported 68.5% for its best graph variant. The agent's tools were `grep`, `search_files`, `open`, `close`. Two caveats that the summary headlines drop: (1) **`search_files` was semantic search** — "Files in Letta are automatically parsed and embedded to enable semantic (vector) search over their contents" — so this is evidence for *files + an index*, not for grep alone; (2) the authors themselves say "comparing agent frameworks and agent memory tools is like comparing apples to oranges" and conclude LoCoMo may not be meaningful. Their stated lesson: "Memory is more about how agents manage context than the exact retrieval mechanism used"; agents are good at filesystem tools because those are in their training data. They also report they could not reproduce Mem0's MemGPT baseline and that Mem0 did not answer requests for the method.

- Owner can see/edit: yes, plain markdown in a folder, plus a desktop memory viewer and diff renderer.
- Portability: excellent (a git repo of markdown).
- Self-hosting: `letta server` runs locally; Apache-2.0; Letta Cloud is optional sync. US company, hosted remote is US — avoidable.
- Scale: designed for hundreds of files with a tree in the prompt; nothing here addresses tens of thousands of items — those stay in the message store.

### 1b. Mem0 — the extraction pipeline that stopped trusting itself

**Truth:** rows in a vector store (24 drivers in `mem0/vector_stores/`; Qdrant on local disk by default for the library, Postgres + pgvector for the self-hosted server) plus a SQLite history table (`SQLiteManager(self.config.history_db_path)`, main.py:500). Each memory is one short extracted sentence with metadata. There are no files. The owner sees memories through API calls (`get_all`, `history`) or the hosted dashboard; nothing is browsable or hand-editable without code.

**Recall:** the host application calls `search()` — typically every turn, injected into the prompt. v3 retrieval fuses semantic, keyword and entity-match signals; vendor claims ~7k tokens per query.

**Write path (v3, April 2026; main.py "Phase 0–8", lines 918–1196):** gather context → fetch existing related memories → **one LLM call** with `ADDITIVE_EXTRACTION_PROMPT` → embed → hash-dedup → persist → link entities into a parallel `{collection}_entities` collection (entity match at cosine ≥ 0.95, main.py:621).

**The reversal that matters.** Until v3, a second LLM call decided ADD / UPDATE / DELETE against existing memories (the prompt is still in `prompts.py`:176–290: "If the retrieved facts contain information that contradicts the information present in the memory, then you have to delete it"). v3 removed that: "ADD only: nothing is overwritten or deleted" (docs.mem0.ai/migration/platform-v2-to-v3). Their stated reason (mem0.ai/blog/mem0-the-token-efficient-memory-algorithm, 2026-04-16): "Overwrites sometimes erased key information from the original fact. Deletes sometimes removed information that would be relevant later." In plain words: **letting a model silently rewrite and delete memories destroyed information, so they stopped.**

**Facts that change / contradictions:** now "both facts are preserved… retrieval ranks the most relevant, current information higher". Users dispute that it works: issue #4956 (19 comments, open) "ADD-only extraction in v3 may surface stale/contradictory facts for time-sensitive attributes… the scoring signals don't incorporate recency"; #5867 "ADD-only memory extraction can create conflicting memories"; #5352 (47 comments) is a community workaround — prefix dates on every memory and run a weekly LLM "hygiene script" to merge duplicates, because related requests were "closed as not planned".

**Graph memory:** removed from open source in v3. "Graph memory is removed from the open-source SDK. It is not being replaced by an OSS equivalent: graph memory is a Mem0 Platform feature" (docs.mem0.ai/migration/oss-v2-to-v3). All Neo4j/Memgraph/Kuzu/AGE/Neptune drivers deleted. Memory decay is also platform-only (main.py:467–484 raises on `decay`).

**Forgetting:** `delete(id)`, `delete_all(user_id=…)`, `expiration_date` on add. Open bugs in exactly this path: #5696 "sync delete_all aborts on partial failure and orphans entity records", #7031, #7025. With add-only there are *more* copies of each fact to find.

**Scoping:** `user_id` / `agent_id` / `run_id` strings used as filters (main.py:135, 316–415). This is a filter, not access control — whoever calls the library chooses the id.

**Self-hosting reality:** Apache-2.0; defaults to OpenAI for both model and embeddings (overridable, so it could go through LiteLLM). **Telemetry is on by default and posts to `https://us.i.posthog.com`** (`mem0/memory/telemetry.py`, `MEM0_TELEMETRY` default "True") — a direct breach of Lares's "nothing phones home" and "no US cloud" rules unless disabled. Python-first.

**Benchmarks:** vendor claims LoCoMo 92.5 / LongMemEval 94.4 for v3. Treat with suspicion: Zep and Mem0 have publicly accused each other of misconfigured comparisons on LoCoMo (Zep 84% → Mem0 says 58.44% → Zep says 75.14%; getzep/zep-papers issue #5 and Zep's "Is Mem0 really SOTA" post), Letta could not reproduce Mem0's MemGPT numbers, and independent write-ups note LoCoMo drops the 446 questions whose right answer is "I don't know". None of these numbers should drive a Lares decision.

- Portability: you can dump rows as JSON; what you get is thousands of disconnected one-line sentences. Usable, not pleasant.
- Scale: fine technically (it is a vector DB); quality at scale is the open question (#5352's "memory pollution").

### 1c. Zep / Graphiti — the one idea files genuinely lack

**Truth:** a property graph in Neo4j 5.26 or FalkorDB (Kuzu, the only embedded option, is "deprecated and will be removed… the upstream Kuzu project is no longer maintained"; Neptune is AWS). Three layers: *episodes* (raw input, kept verbatim), *entity nodes* (with LLM-written summaries), *entity edges* = facts.

**The temporal model (the part to take seriously).** `graphiti_core/edges.py:263–285` — every fact edge carries:
- `fact` (a sentence) and `name` (relation),
- `valid_at` — when it became true in the world,
- `invalid_at` — when it stopped being true,
- `expired_at` — when the system learned it was no longer true,
- `reference_time` — timestamp of the source episode,
- `episodes` — list of source episode ids (provenance).

That is "bi-temporal": world time and knowledge time are separate. "Moved to Bergen in March" becomes a new edge `lives_in → Bergen, valid_at=March`, and `edge_operations.py:538–570` (`resolve_edge_contradictions`) sets the old Oslo edge's `invalid_at = new.valid_at` and `expired_at = now`. **Nothing is deleted**; you can ask what is true now or what was true last winter. Contradiction detection is an LLM call returning `contradicted_facts` indexes (lines 754–770); timestamps come from another lightweight LLM call (`_extract_edge_timestamps`, 576–620).

**Recall:** `search()` is hybrid — embeddings + BM25 full-text + graph traversal, fused by RRF or a cross-encoder reranker; no LLM at query time. Triggered by the host app.

**Entity resolution:** extracted nodes are deduplicated against existing ones by heuristics, falling back to an LLM. It still fails in the wild: #963 "Duplicate Entities in Neo4j" (open since 2025-10), #1872 "add_episode_bulk saves duplicate edges" (2026-09-10), #1505 (NaN embeddings silently break dedup).

**Cost — the number that decides it for Lares.** Each episode runs several LLM calls (node extraction, node dedup, edge extraction, per-edge resolution/contradiction, timestamps, summaries). README: default `SEMAPHORE_LIMIT=10` because ingestion triggers provider rate limits. Issue #1262: "standard add_episode latency is expected to be around 12 seconds per message"; the reporter saw 36 s/record, 100 records in an hour. **Lares's 31k imported messages at 12 s each is about 100 hours of continuous model calls, and tens of thousands of calls, before anyone asks a question** — and messages must be ingested in time order for the temporal logic to hold.

**Forgetting:** `remove_episode()` (graphiti.py:1824–1850) deletes only edges for which that episode was the *first* source and nodes mentioned by no other episode. A fact re-stated elsewhere survives; node summaries are LLM-blended text from many episodes (my inference: personal data can persist in a summary after its source is removed — not tested). Erasure by person therefore needs custom graph surgery.

**Scoping:** `group_id` = "partition of the graph" (edges.py:51). A filter string, again not access control.

**Owner visibility:** none out of the box ("Build your own tools" — README comparison table); you look at it with Neo4j Browser and Cypher queries. Not hand-editable in any sense a non-developer would accept.

**Self-hosting reality:** Apache-2.0, Python ≥3.10, needs a graph database server and a model with structured output; defaults to OpenAI. **Telemetry on by default to `https://us.i.posthog.com`** (`graphiti_core/telemetry/telemetry.py`:19, 35–37; off via `GRAPHITI_TELEMETRY_ENABLED=false`). Zep Community Edition (the self-hostable full product) was discontinued April 2025; Zep's own cloud no longer uses Neo4j but "a proprietary graph database — the Context Graph Engine" (README). So the vendor itself does not run the stack it open-sources.

**Benchmarks:** paper (arXiv 2501.13956, Jan 2025) claims DMR 94.8% vs MemGPT 93.4% and LongMemEval "accuracy improvements of up to 18.5%… reducing response latency by 90%" against a full-context baseline. Vendor's own numbers.

### 1d. Side by side

| | Letta (now) | Mem0 OSS v3 | Graphiti |
|---|---|---|---|
| Truth | Markdown in git (+ immutable message DB) | Rows in vector DB + SQLite history | Graph DB (Neo4j/FalkorDB) |
| Owner can read/edit by hand | Yes | No (API only) | No (Cypher) |
| Leave with usable data | Yes — a folder | JSON dump of one-liners | Graph export; meaning is in the schema |
| Fact changes over time | Edit file; git history | Both facts kept, no validity dates; known stale-fact bug | **valid_at / invalid_at / expired_at; old fact invalidated, kept** |
| Contradictions | Agent rewrites; defrag skill | Not resolved (was LLM delete; removed) | LLM flags; old edge closed |
| Erasure | Delete file; git history remains | delete APIs; many copies; open bugs | Partial (`remove_episode`); summaries linger |
| Multi-user | One repo per agent | id filters | `group_id` filter |
| Infra | None beyond git | Vector DB + LLM + embedder | Graph DB + LLM + embedder, Python |
| Phones home by default | Not checked in code (cloud optional) | **Yes, US PostHog** | **Yes, US PostHog** |
| Cost per write | Agent turn / dreaming run | 1 LLM call + embeddings | Several LLM calls, ~12 s |

## 2. INTEGRATIONS — n/a — out of scope for this source
## 3. FIRST RUN — n/a — out of scope for this source
## 4. DEFINING AN AGENT — n/a — out of scope for this source

## 5. MORE THAN ONE PERSON (brief)

None of the three offers real access control in open source. Mem0: `user_id`/`agent_id`/`run_id` filters chosen by the caller. Graphiti: `group_id` partition. Letta: one memory repo per agent; sharing = several agents attached to the same files, no per-person privacy inside a repo. Roles, approvals, "who may see this note" are left to the host application in all three. **The database camp gives Lares no head start on private/org/participants scopes** — that has to be enforced in Lares's own read tools whichever store is used. One real point for a database: a scope column in an index is a cheap, testable filter, while a folder convention is easy to violate; so the *index* should carry scope even if the file is the truth.

## 6. SAFETY — n/a — out of scope for this source
(One relevant note: Letta's memory prompt says "Never store secrets… Memory is git-tracked and may be synced off this machine", and its pre-commit hook validates memory files. Worth copying.)

## 7. COST AND VISIBILITY (brief)

- Mem0 v3: one model call + embedding calls per `add()` (was two model calls); ~7k tokens injected per query (vendor figure). No spend cap.
- Graphiti: several model calls per episode, ~12 s typical, rate-limit-bound; has a `token_tracker` property (graphiti.py:272) and OpenTelemetry example. Bulk import of a mailbox is the cost trap.
- Letta: dreaming is background sub-agent runs; the review-before-apply option "uses more model tokens"; `letta memory-tokens` subcommand and `/doctor` show how much of the prompt memory is eating — a useful owner-facing number.
- Files + keyword search costs nothing to write and nothing to index; the cost moves to the agent's search turns at read time.

## 8. COMMUNITY — n/a — out of scope for this source
(All three Apache-2.0, which may be included in an AGPL-3.0 project.)

---

## Where files-as-truth breaks, and what Lares should do about each

The strongest honest case against the decision, case by case. One principle runs through every answer, and it comes from Lares's own 15,800-line Notion sync as much as from these projects: **every piece of knowledge gets exactly one writable home; any other form of it is a read-only, rebuildable projection.** Two-way sync between a file and a table is the thing to never build again.

| # | Failure case | Why markdown struggles | Verdict | What to do |
|---|---|---|---|---|
| 1 | **Facts that change over time** ("moved to Bergen in March", job changes, prices, who is the contact at X) | A sentence in a note has no "true from / true until"; an edit overwrites the past; keyword search returns old and new with equal weight. Mem0's open issue #4956 is exactly this failure in a database *without* validity dates — so the fix is the dates, not the database. | **Database table from the start** (extend the existing Postgres "standing facts") | Copy Graphiti's four fields: `valid_from`, `valid_to`, `recorded_at`, `superseded_by`, plus `source` (message/note id) and `scope`. Never update in place: close the old row, add the new. Narrative about the move stays in the person's markdown note. |
| 2 | **Dream cycle rewriting memory** | Same risk in any store. Mem0 removed LLM-driven UPDATE/DELETE because "overwrites sometimes erased key information… deletes sometimes removed information that would be relevant later". | Keep in markdown, change the rule | The nightly cycle may *add* and *supersede* (with provenance), never silently overwrite or delete. Deletions and merges go to the owner as an approval card. Git history is the safety net Mem0 did not have. |
| 3 | **Entity resolution** (same person in email, CRM, Slack, notes) | Files have no unique keys; "Kari N.", "Kari Nordmann" and kari@… become three notes. | **Database** (the relationship graph Lares already has) | Person table with stable id; identifier table (emails, phone, Slack id, CRM id); alias table; merge log. Match on hard identifiers first; model-suggested merges go to an approval card — Graphiti's LLM dedup still produces duplicates (#963, #1872). The person's markdown note carries `person_id:` in frontmatter; that is the only link. |
| 4 | **Relationship queries** ("who do I know at X", "who introduced me to Y") | Needs joins across people, companies, roles with dates. grep cannot do it. | **Database** | Keep the graph in a relational store; role/employment rows get `valid_from/valid_to` too. At tens of thousands of nodes plain SQL (recursive queries) is enough — no Neo4j, no new server. Worth asking later whether SQLite and Postgres should be one engine (one backup, one erasure path). |
| 5 | **Large imported corpora** (31k messages) | 31k files would drown the notes; keyword scan over them is slow and noisy. | **Database archive + index, never markdown, never bulk-extracted** | This is a *record of what happened*, not memory. Append-only table, Postgres full-text index, pgvector (already installed) as second index. Letta does the same: immutable "recall memory" searched by a sub-agent. Do **not** run it through a Graphiti/Mem0-style extraction pipeline (≈100 hours, tens of thousands of model calls). Extract lazily: when a person or topic becomes relevant, or for the top contacts only. |
| 6 | **Recall quality as notes grow** | Keyword search misses paraphrases ("flat" vs "apartment", Norwegian vs English). Letta's famous "filesystem wins" result had semantic search switched on. | **Markdown + rebuildable index** | Files stay truth. Add an index built *from* the files (full-text first, embeddings second), deletable and rebuildable at any time, carrying path, scope, `type`, dates. Trigger: when Lares's own recall test set starts failing, not before. |
| 7 | **Concurrent writes from several agents** | Two agents editing one file = lost update or merge conflict. | Keep in markdown, with write discipline | Cheapest: one memory-writer path that serialises commits per store; append-only daily/inbox files; small files (one topic each). Letta's heavier answer — a git worktree per sub-agent, then merge — is available if that is not enough. Anything needing a transaction (approvals, ratchet state, bookings) is already in Postgres and stays there. |
| 8 | **Structured operational data** (deadlines, bookings, approvals, invoices) | Code branches on it; it has states, due dates, uniqueness. A typo in a markdown date silently loses a deadline. | **Database from the start** (as today) | Agents reach it through tools, not through memory search. Never mirror it into editable notes. |
| 9 | **Forgetting on request (GDPR erasure)** | Git remembers deleted text forever; so do backups. This is files-as-truth's weakest legal point. | Both — needs a procedure, not a store | But the database camp is worse, not better: add-only Mem0 multiplies copies, Graphiti's `remove_episode` leaves re-stated facts and blended summaries. Lares needs one "erase person" routine keyed on `person_id` + aliases that walks: notes, git history (rewrite, or keep memory repos squashed on a schedule), facts table, message archive, every index/embedding (rebuild), conversation logs, and lets backups age out on a stated retention. Provenance on every derived item is what makes this possible. |
| 10 | **Private / org / participants scopes** | Folders express "private" and "org" well, "visible to these three people" badly. | Markdown + index carrying scope | `scope:` in frontmatter is the truth; the index copies it; *every* read tool filters on it. Test it like a security boundary. No project in this camp does better than a filter string. |

### Where the line should sit — four shelves

1. **Narrative knowledge → markdown in git (truth).** Notes, people profiles as prose, decisions, preferences with reasons, taste, how-we-do-things. Test: *would the owner want to read and edit it as prose?*
2. **Facts with dates, entities, relationships → Postgres tables (truth).** Test: *is it queried by time, by relation, or must it be unique?*
3. **Operational records and raw archives → Postgres tables (truth), append-only where possible.** Deadlines, approvals, bookings, imported messages, conversation logs. Test: *does code branch on it, or is it a record of what happened?*
4. **Indexes, embeddings, summaries → rebuildable, never truth.** Each row carries the id of what it was built from.

Today's "standing facts" (Postgres, injected every turn, cap 40) sit on shelf 2 — which is fine and matches Letta's always-loaded `system/` files — but they lack validity dates and the owner cannot see them in Obsidian.

### Keeping database-held knowledge visible and exportable

- **Console pages** for People, Facts, Deadlines: view, edit, and history of every row (who/what wrote it, when, from which source).
- **"Why do you think that?"** — a tool and a console link that returns the source message or note for any fact.
- **One-way nightly export** of shelves 2–3 to a read-only `exports/` folder as markdown + CSV/JSON, so Obsidian shows it and leaving Lares means copying a folder. Keep that folder *out of git history* (regenerated, not versioned) or erasure gets harder.
- **One "export everything" command**, and include the export in the existing restore drill (LAR-54) so it is proven, not promised.
- No hand edits to the export; edits happen in the console or by telling an agent. One writable home.

---

## Patterns worth stealing

1. **Bi-temporal fact fields** — `valid_at`, `invalid_at`, `expired_at`, `reference_time`, `episodes[]` (graphiti `graphiti_core/edges.py:263–285`); invalidate-don't-delete (`edge_operations.py:538–570`). Implement as Postgres columns, not as a graph database.
2. **Add/supersede, never silently rewrite** — Mem0's v3 lesson (blog 2026-04-16), but *with* dates so the stale-fact bug (#4956) does not follow.
3. **Always-loaded folder + file tree with descriptions in the prompt** — Letta `system/` directory and required `description:` frontmatter (docs.letta.com/concepts/memfs). Replaces per-turn retrieval injection with signposts.
4. **Pre-commit hook on the memory repo** — validates frontmatter, enforces per-file size caps, blocks protected files (letta-code `src/agent/memory-constraints.ts`, `memory-git-hooks.ts`). Lares's OKF `type` requirement could be enforced the same way.
5. **Memory edits apply next session, not mid-turn** (`letta_local_memfs.md`) — keeps the prompt cacheable and behaviour predictable.
6. **Worktree per memory sub-agent, merge back** (`memory-worktree.ts`) — if serialised writes prove insufficient.
7. **Defragmentation as a named, backed-up routine** and a `/doctor` that reports how many prompt tokens memory costs.
8. **Raw history immutable + searchable by a sub-agent; learned knowledge separate** (Letta recall memory vs MemFS).
9. **Hybrid retrieval without a model call at query time** — full-text + embeddings fused by rank (Graphiti `search`), for the rebuildable index when it is needed.

## Traps they hit

- **Letta**: built a database-backed memory server for three years, then archived it (archive branch, 2026-08-14) and moved memory to git-backed markdown. Reason given: agents handle ordinary file tools better than bespoke memory tools.
- **Mem0**: model-driven UPDATE/DELETE corrupted and lost memories → removed (v3). The replacement accumulates contradictions (#4956, #5867), requests to fix were closed "not planned", community runs cron "hygiene scripts" (#5352). Graph memory pulled from open source into the paid platform. Delete paths still buggy (#5696, #7031, #7025). `add()` can report success for memories never persisted (#6911, #7201).
- **Graphiti**: ingestion is slow and model-hungry (#1262); duplicates persist (#963, #1872); the only embedded database option (Kuzu) died upstream and is being removed; official Docker image lagged many versions (#1030); the full self-hostable Zep was discontinued (April 2025) and the vendor's cloud runs on a proprietary engine instead.
- **Both Mem0 and Graphiti** ship telemetry on by default to PostHog's US endpoint.
- **Benchmarks**: three vendors, three incompatible LoCoMo tables, public accusations of misconfiguration in both directions, and a benchmark that discards "I don't know" questions. No number from this camp is decision-grade.

## Verdicts for Lares

| Idea | Adopt / adapt / ignore | Why |
|---|---|---|
| Markdown in git as truth for narrative memory | **Adopt (confirmed)** | The database camp's founder (Letta) converged on it; owner-readable; portable; no infra. |
| Validity dates on facts (`valid_from/valid_to/recorded_at/superseded_by/source`) | **Adopt**, in Postgres | The one real gap in files. Cheap as columns; no graph server. |
| Add/supersede only in the dream cycle; destructive changes via approval card | **Adopt** | Mem0's hard-won lesson; fits Lares's approval model. |
| Entities + relationships in a relational store with stable ids and owner-approved merges | **Adopt** (already half there) | Needed for cross-source identity and "who do I know at X". |
| Imported messages as append-only archive + full-text/pgvector index | **Adopt** | It is a record, not memory; pgvector already installed. |
| Rebuildable index over the markdown stores | **Adapt** — build when a recall test fails | Letta's "filesystem" win included semantic search. |
| Always-loaded folder + described file tree in prompt | **Adapt** | Cleaner than per-turn retrieval; keep the 40-fact cap idea as a token budget. |
| Pre-commit validation + size caps on memory repos | **Adopt** | Small, enforces OKF, prevents prompt bloat. |
| Git worktrees per writing agent | **Ignore for now** | Serialised writer is simpler; revisit under real contention. |
| One-way export of database knowledge + console pages + provenance lookup | **Adopt** | Keeps the sovereignty promise for the parts that are not files. |
| Embedding Graphiti | **Ignore** | Python + graph DB server + several model calls per message + US telemetry default + no owner view; ~100 h to ingest the mailbox. Take the data model, not the software. |
| Embedding Mem0 | **Ignore** | Opaque one-line memories, no temporal model, US telemetry default, graph now paid-only. |
| LLM extraction pipeline on every message | **Ignore** | Cost and error rate; extract lazily and at session end. |
| Any vendor benchmark number | **Ignore** | Mutually contradictory and self-reported. |

## Verdict: does files-as-truth survive?

**Yes — but it should be written down more narrowly than "markdown is the truth, a database is at most an index".** That sentence is wrong for Lares as it already exists: deadlines, approvals, the relationship graph and standing facts are database truth today, rightly. The decision that survives is:

> *Narrative knowledge is markdown in git and is the truth. Dated facts, entities/relationships, operational records and raw archives are database tables and are the truth for those things. Every index, embedding and summary is rebuildable. Every piece of knowledge has one writable home. Everything the database holds is visible in the console and exported one-way to files.*

The devil's-advocate case failed mainly on its own witnesses: Letta left the database position, Mem0 retreated from automatic rewriting and from open-source graph memory, and Graphiti's genuinely better idea (time-bounded facts) is a handful of columns, not a reason to adopt a graph server.

**I would reverse or reopen the decision if:**
1. **Nobody opens the files.** If after launch owners manage memory only through the console and chat, the main benefit (hand-editable, Obsidian-visible) is theoretical, and a table with a good editor is simpler.
2. **Multi-user becomes the product** with many simultaneous writers and per-note sharing ("participants"). Permissions then need a database of record, and files become the projection.
3. **Recall fails on Lares's own test set** even with the rebuildable index — i.e. the agent cannot find things in a few thousand notes. (Build that test set first; without it this can never be judged.)
4. **Erasure cannot be made reliable in git** (history rewrites breaking overlays/backups, or a regulator asks for proof). Then personal data about third parties moves to tables and only the owner's own narrative stays in git.
5. **Questions turn multi-hop and temporal as a routine** ("who at companies I dealt with in 2024 has since moved to a customer") and SQL over the facts/relationship tables becomes painful — then adopt Graphiti's *model* more fully, still inside Postgres.

## Contradictions with what Lares does or plans

- "A database is at most a rebuildable index" contradicts Lares's own (correct) use of Postgres for standing facts and SQLite for the relationship graph. Reword the ADR.
- Standing facts have no validity dates and are invisible as files — the exact weakness Graphiti solves and Mem0 suffers from.
- A nightly dream cycle that *promotes* at confidence ≥ 0.8 is fine; one that *edits or removes* existing memory without approval repeats Mem0's removed design.
- The two-way Notion↔markdown sync is the anti-pattern every answer above avoids; do not add a second one between tables and notes.
- pgvector "installed and unused" is the right state today; its first job should be the message archive, second the notes index.
- Two database engines (Postgres + SQLite) means two backup and two erasure paths — worth a deliberate decision.
- If any of this camp's code is ever embedded: telemetry must be forced off at build time, and model calls pointed at the LiteLLM gateway; defaults are OpenAI + US PostHog.
