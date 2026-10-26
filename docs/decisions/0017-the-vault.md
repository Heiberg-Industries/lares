# ADR 0017 — The Vault: one name, one writable home per piece of knowledge

**Date:** 2026-09-18
**Status:** Accepted
**Supersedes:** —
**Amends:** ADR-0010 (one owner per fact: Brain, Atlas, Notion, repos, CRM, and a separate taste layer)

## In plain language

Before this decision an installation had three separately-named stores — the personal vault, the business
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

ADR-0010 set the authority rules that still hold: one canonical store per fact
class, mirrors never edited in place, a taste layer kept separate from the personal vault so
an agent that must not see personal notes can still see taste. Its §7 called the taste store
"planned, not yet built". It has since shipped: `packages/taste/src/index.ts` defines its OKF
vocabulary, `services/console/lib/taste-store.ts` reads and writes it, and
`services/console/app/taste/page.tsx` is the owner's view of it.

Gaps found by reading the code for this decision:

1. **Three names, three env vars, three capabilities.** The personal store is `VAULT_PATH`
   (capability `brain`), the business store is `ATLAS_PATH` (capability `atlas`)
   (`packages/agent-kit/src/notes-store.ts`), and taste is `TASTE_ROOT`, default
   `/srv/taste`, with no capability grant at all (`services/console/lib/taste-store.ts`).
   The standing-facts capability had itself been renamed once already ("renamed from `facts`").
2. **A second, divergent write path into the taste store existed.** A role's own dream
   cycle appended to `taste/preferences.md` resolved relative to a trip's own directory, a different
   path from the canonical `TASTE_ROOT` store the console reads. It wrote with a raw
   `fs.appendFileSync`, no capability grant, no OKF frontmatter and no approval — a "one writable
   home" violation.
3. **The OKF conformance check was Atlas-only.** `services/atlas/lib/okf.ts` states the five-value
   vocabulary is "the whole knowledge layer's", but `checkConformance` was invoked only
   from the Atlas CLI and the Atlas OKF migration — nothing ran
   it over Brain, taste, or `_meta`. `okf.ts` also recorded a deliberate decision not to
   adopt OKF's optional provenance family (`sources`, `generated`, `verified`, `stale_after`) —
   reversed below for the reasons in rule 3.

The database-first research (a devil's-advocate review of files-as-truth) is the source for where the table/file line sits: markdown survives as the truth for narrative knowledge, but dated facts, entities and
relationships, operational records, and raw archives are database truth, "not because a database
is fashionable, but because a sentence in a note has no true-from/true-until and a summarised
fact is an assertion nobody can check" ("Where the line should sit"). Other memory projects studied independently converge on the same shelf split and on "an index is rebuildable, never truth".

## Decision

1. **Name: "the Vault".** One vault per installation, with named areas: `private/<member>/`
   (personal notes, one folder per member once a second member exists), `shared/` (business
   knowledge every member benefits from), `taste/` (life-context: places, tracks, dishes,
   playlists), `_meta/` (what the agents write about their own running — conversation logs, dream
   reflections; excluded from search in `packages/agent-kit/src/notes-store.ts`, and that exclusion stays). An installation may keep other folder
   *names* (for example "Brain" and "Atlas") by an installation setting; the engine never hard-codes them (ADR-0015).
   One capability `vault`, granted per area, replaces the separate `brain`, `atlas`, `memory` (née
   `facts`) and taste-write capabilities. "Memory" stops naming a store; it names the act — an
   agent remembers by writing to the Vault, to a table, or by calling `remember`.
2. **One writable home per class of knowledge**, applied consistently across every area:
   - Prose and narrative knowledge (notes, decisions, taste writing, meeting thinking) →
     markdown in the Vault, git-backed, is the truth.
   - Dated facts, people, relationships, deadlines, bookings → database tables are the truth,
     each row carrying `valid_from`, `valid_to`, `recorded_at`, `source`, `superseded_by`,
     `origin` (the origin model defines the
     field). `standing_facts` and `dream_preferences` (`services/chief-of-staff/lib/dream/store.ts`) already carry
     most of this shape (`stated_at`/`retired_at`, `valid_from`/`valid_to`/`superseded_by`) and
     are extended to the full column set rather than replaced.
   - **Track items are an exception.** A Vault track's dated workflow items are Markdown truth
     in that track's home, with Git history recording changes (ADR-0024). They do not replace
     the canonical profile of a person or organisation referenced by an item.
   - Large imported archives (a mailbox, an imported message history) → an append-only,
     searchable record, never memory and never bulk-extracted into notes.
   - Indexes, embeddings, summaries → rebuildable from the store they were built from, never
     hand-edited, never the truth for anything.
   - Never a two-way sync between a table and a note. Where a fact must be visible in both
     places (a standing fact mentioned in a person's personal note), the note links to the fact by
     id; it does not restate it.
3. **Format: "OKF v0.2-compatible markdown"**, spec pinned at commit `ad30107c` of
   `GoogleCloudPlatform/open-knowledge-format` (never described to an owner as "your memory is
   OKF" — it is the file format, not a product name). The vocabulary stays the one
   `services/atlas/lib/okf.ts` already states is shared, not Atlas-local. OKF's optional
   provenance fields (`generated`, `verified`, `sources`, `status`, `stale_after`) are adopted —
   reversing the earlier decision recorded in `okf.ts`, now that they have a real second
   consumer (the origin model's frontmatter). Add the `lares_*` extension fields: `lares_origin`,
   `lares_valid_from`, `lares_valid_to`, `lares_supersedes`, `lares_scope` (formalising the
   `scope:` key `notes-store.ts` already parses ad hoc). The conformance check
   (`checkConformance`) runs over every area of the Vault — private, shared, taste, `_meta` — not
   only the shared one; `services/atlas/lib/cli.ts`'s `--check-okf` mode becomes a Vault-wide
   command rather than an Atlas one.
4. **All memory work ships together**: origin marking (the origin model),
   add-only dreaming (ADR-0018), the small per-session core (ADR-0018), the `lares_*`
   dated-facts fields (this decision), "which memories did you use?" plus one-step forget (rule 7 below), and the memory test set (a private eval built from Lares's own question shapes, not a public benchmark). None of these ships piecemeal ahead of
   the others; a half-built origin system is worse than none, because it reads as a guarantee
   that is not actually kept.
5. *(No rule. Numbering is kept so references elsewhere to rules 6–10 stay valid.)*
6. **Seeing memory:** "which memories did you use?" is answerable on every door (a reply that
   drew on standing facts or Vault notes names them) and in the console, per turn. Before this, the standing-facts block and dream-promoted preferences were silent about which row answered which question.
7. **Correcting memory:** one-step forget, already the shape of
   `services/chief-of-staff/catalogue/forget.ts` for standing facts (soft-retire, gated as a
   `delete` category in `packages/agent-kit/src/always-ask.ts`), extended to every writable
   home with a **forget ledger** — a record of what was told to forget, checked on every re-sync
   or re-import so a Notion pull or a Brain restore cannot silently resurrect a retired fact.
   `forget` retires a row; without the ledger nothing stops a future import reintroducing the same fact.
8. **Erasure:** a single "erase this person" routine walks every area of the Vault, the facts
   tables, the conversation record (ADR-0018's replacement for markdown conversation logs), the
   archive, and every sync job's own state, and states plainly what git history still holds
   ("git remembers deleted text forever; so do backups" — files-as-truth's weakest
   legal point, and the database camp is not better by default). A purge command exists for the
   case that needs git history rewritten or backups aged out.
9. **Notion stays a two-way sync** (the owner overruled the research's one-way recommendation). Consequence: synced content carries origin
   in both directions; content pulled from Notion is stamped `synced` (never `owner` or `agent`,
   whatever it reads like); the fidelity gate (`services/notion-sync`'s pull path,
   `pull-sync.ts`/`notion-born-sync.ts`/`transcript-sync.ts`) refuses a pull that would drop a
   `lares_*` stamp rather than silently widening it. Those three files used to write an ad hoc `source: notion-docs` / `source: notion-meetings` frontmatter key — this decision replaces that key with
   `lares_origin: synced` plus the sync job's own provenance (`notion_page`, kept as-is).
10. **Search stays keyword-first.** The existing tokenised search over the Vault
    (`packages/agent-kit/src/notes-store.ts`) is the default. A rebuildable Postgres
    full-text index is built only once the memory test set (rule 4) shows keyword search failing
    on Lares's own question shapes — not before. `pgvector` stays installed and unused
    (the research's "the right state today") until full-text search is itself shown insufficient;
    its first job, if that day comes, is the imported-message archive (rule 2's third shelf), not
    the notes. Any index that is built gets a visible health check — "files on disk vs. files
    indexed", following the research finding that a silently stale or unbounded index is a live
    failure mode in projects that already shipped one.

## Consequences

**Positive:**

- One name, one capability, one mental model for an owner setting up an agent: "does this agent
  see `private/`, `shared/`, `taste/`?" replaces four separate grants that drift independently.
- The taste store's second write path (gap 2 above) is forced into the open and closed, rather than staying an invisible divergence.
- The conformance check finally does what its own code comment already claimed it did.
- Extending `standing_facts`/`dream_preferences` rather than replacing them keeps the migration
  small — most of the bi-temporal shape (a pattern borrowed from the research) is already there.

**Negative / accepted trade-offs:**

- A real migration: every write path that currently uses `brain`/`atlas`/`memory`/taste grants
  moves to `vault` grants scoped by area, and every note's frontmatter gains `lares_*` fields it
  does not have before the migration.
- OKF's optional provenance fields are adopted for a use they were not adopted for before; the
  frontmatter parser (`services/atlas/lib/frontmatter.ts` and its personal-vault counterparts) grows
  more fields to validate.
- A Vault-wide conformance check will, on first run, surface every non-conformant file already in the personal vault and taste — this is a one-time noisy migration, not a design flaw.

## Operational rules

- Do: grant `vault` by area, never by store name, in any new agent definition.
- Do: treat a database row as visible knowledge — every table this ADR names gets a console page
  and a nightly one-way export, following the research's export pattern.
- Do: run the OKF conformance check over the whole Vault in CI, not only over Atlas.
- Don't: write a fact to a note and its table twin "to be safe" — pick the one writable home
  per rule 2 and link, never duplicate.
- Don't: let a schedule or background job write to any Vault area, or to taste, without going
  through the same capability grant and origin stamp a model-called tool would use — the raw dream-cycle append (gap 2) is the example this rule closes.

## Open questions

The database-first research's reversal conditions apply unchanged; they are the standing test for whether
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

Left for ADR-0015's agent-definitions work to settle: whether `taste/` gets its own per-agent mount distinct from `shared/`, or whether
area-scoped grants make a separate mount unnecessary.

## What lives where

| Kind of knowledge | Writable home | How the owner sees it | How it is exported |
|---|---|---|---|
| Prose, notes, decisions, thinking | Markdown in `private/`/`shared/`, git | Obsidian, console note view | git clone; nightly one-way markdown export |
| Vault track workflow state | Markdown track and item files under `shared/tracks/`, git (ADR-0024) | Obsidian or an owner-facing view | Git history |
| Taste (places, tracks, dishes, playlists) | Markdown in `taste/`, OKF-typed (`packages/taste/src/index.ts`) | Console Taste page, Obsidian | Same as above |
| Dated facts, standing preferences | Postgres tables (`standing_facts`, `dream_preferences`) with `valid_from`/`valid_to`/`recorded_at`/`source`/`superseded_by`/`origin` | Console Facts page, "why did you say that?" lookup | Nightly one-way export to markdown/CSV |
| People, relationships | Postgres tables (existing identity/network stores) | Console People page | Same |
| Deadlines, bookings, approvals | Postgres tables (existing deadline/reminder/obligation stores) | Console pages | Same |
| Large imported archives (mail, message history) | Append-only Postgres table + full-text index | Search results only, never presented as memory | Export command (rule 8) |
| Indexes, embeddings, summaries | Rebuildable, derived, never truth | Indirectly, through search results | Not exported — regenerated on demand |
| The agent's own working record | Markdown under `_meta/`, excluded from search (`notes-store.ts`) | Not surfaced as knowledge; included in vault backup | Included in the full vault backup, not in the "what the agent knows" export |

## Cross-references

- ADR-0010 — amended by this decision; its §2–§7 authority rules stand.
- ADR-0024 — defines Tracks and the Vault track-item exception to rule 2 above.
- ADR-0018 — the dreaming and per-session-core rules this ADR's rule 4 depends on.
- The origin model — the `lares_origin` field this ADR's rule 3 introduces into frontmatter.
- Research on database-first memory — the shelf model and reversal conditions this ADR
  relies on; other research corroborates index-beside-files, retirement by usage and visible
  index health.

## Amendment — articles and the shared agent

An organisation has one shared agent, typically in Slack, with read and write access to the shared area. Which agent that is stays the installation's choice and is expressed only through the agents' `vault` grants; the default is the chief of staff. Each member has one or more personal agents with their own private area. Personal agents read the shared area and write there only where a grant says so. This changes no existing rule above; it states how the grants in rule 1 above are used for an organisation.

Articles are OKF notes of type `article`. They sit in `shared/articles/` when they come from an organisation source (filed by the shared agent) and in the member's `private/<member>/articles/` when they come from that member's own source; a link pasted in chat goes where that agent files: the shared area for the shared agent, the member's private area for a personal agent. The engine's default article area is shared, and an installation whose shared area is not writable for the filing agent sets it to private. The reading state lives in a `reading:` key (`to-read | read | used | dropped | suggested`), because OKF v0.2 §5.4 reserves `status` for the document's lifecycle, which rule 3 above adopts. The full extracted text sits in a `<slug>.txt` companion beside the note. It is never searched and is outside the OKF type check, so it cannot crowd out recall or fail conformance. On a shared article the reading state is one value for the organisation; per-member reading state is an open question to settle before a second member uses articles. Setting the article area to shared is a standing approval for the digest to file articles into the shared area's `articles/` folder without a confirmation per write; the agent must still hold a vault grant that names the shared area.

## Amendment 2026-10-26 — Vault tracks are dated workflow records

ADR-0024 amends rule 2. A Vault track's items are dated working records whose Markdown files
are the truth and whose changes are recorded in Git. This is an exception to the general
table rule for dated records. The exception covers only track membership, step, date, note and
source signal; it does not make the item's person or organisation profile a Vault track
record.
