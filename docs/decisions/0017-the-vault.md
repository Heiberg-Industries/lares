# ADR 0017 — The Vault: one name, one writable home per piece of knowledge

**Date:** 2026-09-18
**Status:** Accepted
**Supersedes:** —
**Amends:** ADR-0010 (one owner per fact: Brain, Atlas, Notion, repos, CRM, and a separate taste layer)

## In plain language

Today an installation has three separately-named stores — the personal vault, the business
vault, and a taste store — each with its own folder path and its own on/off switch in an
agent's grant list. This decision gives them one name, "the Vault", with named areas inside
it, and one switch that turns an area on or off for an agent. It also settles what belongs in
a markdown file you can read in Obsidian versus what belongs in a database table: things with
a date, an owner, or a "was this ever true, and when did it stop being true" question go in a
table, everything else stays prose in git. Nothing that is true today about who owns what
(ADR-0010) is reversed — this decision adds a shared shape, a provenance format, and a
conformance check that covers the whole Vault, not only the business half. A database row is
never allowed to be the only place a fact lives without also being visible and exportable.

## Context

ADR-0010 (2026-08-11) set the authority rules that still hold: one canonical store per fact
class, mirrors never edited in place, a taste layer kept separate from the personal vault so
an agent that must not see personal notes can still see taste. Its §7 called the taste store
"planned, not yet built". It has since shipped: `packages/taste/src/index.ts` defines its OKF
vocabulary, `services/travel/lib/taste-store.ts` and `services/console/lib/taste-store.ts`
read and write it, and `services/console/app/taste/page.tsx` is the owner's view of it.

Three gaps have opened since ADR-0010, found by reading the code for this decision:

1. **Three names, three env vars, three capabilities.** The personal store is `VAULT_PATH`
   (capability `brain`), the business store is `ATLAS_PATH` (capability `atlas`)
   (`packages/agent-kit/src/notes-store.ts:18-21`), and taste is `TASTE_ROOT`, default
   `/srv/taste`, with no capability grant at all (`services/travel/lib/taste-store.ts:28`,
   `services/console/lib/taste-store.ts:25`). `services/chief-of-staff/catalogue/remember.ts:13`
   notes the standing-facts capability was itself renamed once already ("renamed from `facts`").
2. **The taste store already has a second, divergent write path.** The travel role's own dream
   cycle appends to `taste/preferences.md` resolved relative to a trip's own directory
   (`services/travel/lib/dream.ts:132`, wired live by
   `services/travel/agent/schedules/taste-promote.ts`), a different path from the canonical
   `TASTE_ROOT`/`/srv/taste` store the console and `nearby_places.ts` read. It writes with a raw
   `fs.appendFileSync`, no capability grant, no OKF frontmatter and no approval — a "one writable
   home" violation in production today, not a hypothetical one.
3. **The OKF conformance check is Atlas-only.** `services/atlas/lib/okf.ts` states the five-value
   vocabulary is "the whole knowledge layer's" (line 8), but `checkConformance` is invoked only
   from `services/atlas/lib/cli.ts:137` and `services/atlas/lib/migrate-okf.ts:52` — nothing runs
   it over Brain, taste, or `_meta`. `okf.ts:14-16` also records a deliberate decision not to
   adopt OKF's optional provenance family (`sources`, `generated`, `verified`, `stale_after`) —
   reversed below for the reasons in rule 3.

Report 06 (the database-first devil's-advocate research) is the source for where the table/file
line sits: markdown survives as the truth for narrative knowledge, but dated facts, entities and
relationships, operational records, and raw archives are database truth, "not because a database
is fashionable, but because a sentence in a note has no true-from/true-until and a summarised
fact is an assertion nobody can check" (report 06, "Where the line should sit"). Reports 01
(gbrain) and 09 (Hermes/Khoj) independently converge on the same shelf split and on "an index is
rebuildable, never truth".

## Decision

1. **Name: "the Vault".** One vault per installation, with named areas: `private/<member>/`
   (personal notes, one folder per member once a second member exists), `shared/` (business
   knowledge every member benefits from), `taste/` (life-context: places, tracks, dishes,
   playlists), `_meta/` (what the agents write about their own running — conversation logs, dream
   reflections; excluded from search today at `packages/agent-kit/src/notes-store.ts:30`, and
   that exclusion stays). The Heiberg installation keeps "Brain" and "Atlas" as its own folder
   *names* by an installation setting; the engine never hard-codes them (ADR-0015's overlay rule).
   One capability `vault`, granted per area, replaces the separate `brain`, `atlas`, `memory` (née
   `facts`) and taste-write capabilities. "Memory" stops naming a store; it names the act — an
   agent remembers by writing to the Vault, to a table, or by calling `remember`.
2. **One writable home per class of knowledge**, applied consistently across every area:
   - Prose and narrative knowledge (notes, decisions, taste writing, meeting thinking) →
     markdown in the Vault, git-backed, is the truth.
   - Dated facts, people, relationships, deadlines, bookings → database tables are the truth,
     each row carrying `valid_from`, `valid_to`, `recorded_at`, `source`, `superseded_by`,
     `origin` (the origin spec, `docs/specs/2026-09-18-origin-model-design.md`, defines the
     field). `standing_facts` (`services/chief-of-staff/sql/002-standing-facts.sql`) and
     `dream_preferences` (`services/chief-of-staff/lib/dream/store.ts:104-116`) already carry
     most of this shape (`stated_at`/`retired_at`, `valid_from`/`valid_to`/`superseded_by`) and
     are extended to the full column set rather than replaced.
   - Large imported archives (a mailbox, an imported message history) → an append-only,
     searchable record, never memory and never bulk-extracted into notes (report 06, failure
     case 5).
   - Indexes, embeddings, summaries → rebuildable from the store they were built from, never
     hand-edited, never the truth for anything.
   - Never a two-way sync between a table and a note. Where a fact must be visible in both
     places (a standing fact mentioned in a person's Brain note), the note links to the fact by
     id; it does not restate it.
3. **Format: "OKF v0.2-compatible markdown"**, spec pinned at commit `ad30107c` of
   `GoogleCloudPlatform/open-knowledge-format` (never described to an owner as "your memory is
   OKF" — it is the file format, not a product name). The vocabulary stays the one
   `services/atlas/lib/okf.ts:19` already states is shared, not Atlas-local. OKF's optional
   provenance fields (`generated`, `verified`, `sources`, `status`, `stale_after`) are adopted —
   reversing the 2026-08-11 decision recorded at `okf.ts:14-16`, now that they have a real second
   consumer (the origin spec's frontmatter). Add the `lares_*` extension fields: `lares_origin`,
   `lares_valid_from`, `lares_valid_to`, `lares_supersedes`, `lares_scope` (formalising the
   `scope:` key `notes-store.ts:293-334` already parses ad hoc). The conformance check
   (`checkConformance`) runs over every area of the Vault — private, shared, taste, `_meta` — not
   only the shared one; `services/atlas/lib/cli.ts`'s `--check-okf` mode becomes a Vault-wide
   command rather than an Atlas one.
4. **All memory work happens before the public launch**: origin marking (the origin spec),
   add-only dreaming (ADR-0018), the small per-session core (ADR-0018), the `lares_*`
   dated-facts fields (this decision), "which memories did you use?" plus one-step forget (rule
   8 below), and the memory test set (report 10's recommendation — a private eval built from
   Lares's own question shapes, not a public benchmark). None of these ships piecemeal ahead of
   the others; a half-built origin system is worse than none, because it reads as a guarantee
   that is not actually kept.
5. *(Ruling 4 continues into the reversal conditions below rather than a numbered rule of its
   own — see "Open questions".)*
6. **Seeing memory:** "which memories did you use?" is answerable on every door (a reply that
   drew on standing facts or Vault notes names them) and in the console, per turn. This is new —
   today's standing-facts block and dream-promoted preferences are silent about which row
   answered which question.
7. **Correcting memory:** one-step forget, already the shape of
   `services/chief-of-staff/catalogue/forget.ts` for standing facts (soft-retire, gated as a
   `delete` category in `packages/agent-kit/src/always-ask.ts:88`), extended to every writable
   home with a **forget ledger** — a record of what was told to forget, checked on every re-sync
   or re-import so a Notion pull or a Brain restore cannot silently resurrect a retired fact.
   Today's `forget` retires a row; nothing stops a future import reintroducing the same fact.
8. **Erasure:** a single "erase this person" routine walks every area of the Vault, the facts
   tables, the conversation record (ADR-0018's replacement for markdown conversation logs), the
   archive, and every sync job's own state, and states plainly what git history still holds
   (report 06: "git remembers deleted text forever; so do backups" — files-as-truth's weakest
   legal point, and the database camp is not better by default). A purge command exists for the
   case that needs git history rewritten or backups aged out.
9. **Notion stays a two-way sync** (the owner overruled report 10's one-way recommendation on
   2026-09-18; recorded here without re-arguing it). Consequence: synced content carries origin
   in both directions; content pulled from Notion is stamped `synced` (never `owner` or `agent`,
   whatever it reads like); the fidelity gate (`services/notion-sync`'s pull path,
   `pull-sync.ts`/`notion-born-sync.ts`/`transcript-sync.ts`) refuses a pull that would drop a
   `lares_*` stamp rather than silently widening it. Today those three files write an ad hoc
   `source: notion-docs` / `source: notion-meetings` frontmatter key
   (`notion-born-sync.ts:295`, `transcript-sync.ts:387`) — this decision replaces that key with
   `lares_origin: synced` plus the sync job's own provenance (`notion_page`, kept as-is).
10. **Search stays keyword-first.** The existing tokenised search over the Vault
    (`packages/agent-kit/src/notes-store.ts:168-214`) is the default. A rebuildable Postgres
    full-text index is built only once the memory test set (rule 4) shows keyword search failing
    on Lares's own question shapes — not before. `pgvector` stays installed and unused
    (report 06's "the right state today") until full-text search is itself shown insufficient;
    its first job, if that day comes, is the imported-message archive (rule 2's third shelf), not
    the notes. Any index that is built gets a visible health check — "files on disk vs. files
    indexed", following report 10's finding that a silently stale or unbounded index is a live
    failure mode in projects that already shipped one.

## Consequences

**Positive:**

- One name, one capability, one mental model for an owner setting up an agent: "does this agent
  see `private/`, `shared/`, `taste/`?" replaces four separate grants that drift independently.
- The taste store's second write path (rule 1's finding 2) is forced into the open and fixed as
  part of adopting this ADR, rather than staying an invisible divergence.
- The conformance check finally does what its own code comment already claimed it did.
- Extending `standing_facts`/`dream_preferences` rather than replacing them keeps the migration
  small — most of the bi-temporal shape (report 06's borrowed pattern) is already there.

**Negative / accepted trade-offs:**

- A real migration: every write path that currently uses `brain`/`atlas`/`memory`/taste grants
  moves to `vault` grants scoped by area, and every note's frontmatter gains `lares_*` fields it
  does not have today (`grep -rln "lares_origin"` returns nothing in this worktree — confirmed
  before writing this ADR).
- OKF's optional provenance fields are adopted for a use they were not adopted for before; the
  frontmatter parser (`services/atlas/lib/frontmatter.ts` and its Brain-side counterparts) grows
  more fields to validate.
- A Vault-wide conformance check will, on first run, surface every non-conformant file already in
  Brain and taste — this is a one-time noisy migration, not a design flaw.

## Operational rules

- Do: grant `vault` by area, never by store name, in any new agent definition.
- Do: treat a database row as visible knowledge — every table this ADR names gets a console page
  and a nightly one-way export, following report 06's export pattern.
- Do: run the OKF conformance check over the whole Vault in CI, not only over Atlas.
- Don't: write a fact to a note and its table twin "to be safe" — pick the one writable home
  per rule 2 and link, never duplicate.
- Don't: let a schedule or background job write to any Vault area, or to taste, without going
  through the same capability grant and origin stamp a model-called tool would use — the
  `services/travel/lib/dream.ts:132` path is the example this rule closes.

## Open questions

Report 06's reversal conditions apply unchanged; they are the standing test for whether
files-as-truth-for-narrative-knowledge should be reopened:

1. **Nobody opens the files.** If owners manage memory only through the console and chat after
   launch, hand-editable markdown's main benefit is theoretical, and a table with a good editor
   would be simpler.
2. **Multi-user becomes the product**, with many simultaneous writers and per-note sharing.
   Permissions then need a database of record, and files become the projection.
3. **Recall fails on Lares's own test set** (rule 4) even with a rebuildable index (rule 10).
4. **Erasure cannot be made reliable in git** (rule 8) — a history rewrite breaks overlays or
   backups, or a regulator asks for proof deletion is real, not "gone from HEAD".
5. **Questions turn multi-hop and temporal as routine** and SQL over the facts/relationship
   tables becomes genuinely painful — the answer is Graphiti's *model* (bi-temporal edges),
   still inside Postgres, never a graph database.

Left for the taste-store fix (rule 1, finding 2) and ADR-0015's agent-definitions work to settle
together: whether `taste/` gets its own per-agent mount distinct from `shared/`, or whether
area-scoped grants make a separate mount unnecessary.

## What lives where

| Kind of knowledge | Writable home | How the owner sees it | How it is exported |
|---|---|---|---|
| Prose, notes, decisions, thinking | Markdown in `private/`/`shared/`, git | Obsidian, console note view | git clone; nightly one-way markdown export |
| Taste (places, tracks, dishes, playlists) | Markdown in `taste/`, OKF-typed (`packages/taste/src/index.ts`) | Console Taste page, Obsidian | Same as above |
| Dated facts, standing preferences | Postgres tables (`standing_facts`, `dream_preferences`) with `valid_from`/`valid_to`/`recorded_at`/`source`/`superseded_by`/`origin` | Console Facts page, "why did you say that?" lookup | Nightly one-way export to markdown/CSV |
| People, relationships | Postgres tables (existing identity/network stores) | Console People page | Same |
| Deadlines, bookings, approvals | Postgres tables (existing deadline/reminder/obligation stores) | Console pages | Same |
| Large imported archives (mail, message history) | Append-only Postgres table + full-text index | Search results only, never presented as memory | Export command (rule 8) |
| Indexes, embeddings, summaries | Rebuildable, derived, never truth | Indirectly, through search results | Not exported — regenerated on demand |
| The agent's own working record | Markdown under `_meta/`, excluded from search (`notes-store.ts:30`) | Not surfaced as knowledge; included in vault backup | Included in the full vault backup, not in the "what the agent knows" export |

## Cross-references

- ADR-0010 — amended by this decision; its §2–§7 authority rules stand.
- ADR-0018 — the dreaming and per-session-core rules this ADR's rule 4 depends on.
- `docs/specs/2026-09-18-origin-model-design.md` — the `lares_origin` field this ADR's rule 3
  introduces into frontmatter.
- Research report 06 (`docs/research/2026-09-18-prelaunch/06-database-first-memory.md`)
  — the shelf model and reversal conditions this ADR relies on.
- Research reports 01, 09, 10 — corroborating patterns (index-beside-files, retirement by usage,
  the visible-index-health finding).
