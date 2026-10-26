# ADR 0010 — One owner per fact: Brain, Atlas, Notion, repos, Tracks, and a separate taste layer

**Date:** 2026-08-11
**Status:** Accepted
**Supersedes:** —
**Superseded by:** —
**Renamed by:** [ADR-0017](0017-the-vault.md). Brain is now the Vault's private area (`private/<member>/`) and Atlas its shared area (`shared/`). The ownership rules below still hold under the new names.

## Context

The knowledge layer grew to several stores, each added for a good reason: Brain
(personal vault, Obsidian), Atlas (business ground truth for agents), Notion
(collaborative teamspaces, meetings, soon clips), per-repo docs
(status and handoff notes), and the CRM (Twenty). With Notion fully in the mix
(the Notion↔Brain sync is live) and the Atlas sync job about to land,
the same fact can now plausibly live in three places. The authority rules existed only
as convention — this ADR writes them down so sync jobs and agents
inherit them instead of re-deriving them.

A planned taste/life-context profile (Google Maps, Spotify, Apple Music, Photos
shared albums) forced one new decision: one of its consumers is an agent that
deliberately gets no Brain access, while the chief of staff must reach it too. Access boundaries drive store
boundaries, so it cannot live inside Brain.

## Decision

1. **Every fact class has exactly one canonical store.** Other stores may hold
   mirrors, but a mirror is never edited in place — corrections go to the owner and
   flow back through sync.
2. **Brain owns personal knowledge**: relationships, thinking, journals, transcripts.
   Readable by the chief of staff only; never mounted into any other agent.
3. **Atlas owns venture/business ground truth for agents**, per brand. Personal data
   never enters it.
4. **Notion owns collaborative live surfaces**: teamspaces, the central Meetings DB,
   the Clips DB. Notion is a canonical *source* (`notion:` prefix in
   `canonical_sources`) and a sync peer — not an agent ground-truth store.
5. **Repo docs own project/code truth** (status and handoff notes,
   written-up lessons). Atlas derives from them; never the reverse. A source is only
   canonical if it is currently true (Atlas design).
6. **The home owns each track and its workflow state** (amended 2026-10-26; ADR-0024). A person or organisation
   appearing in a track does not make that track the canonical home for their contact profile;
   that profile remains with its fact class and visibility. The Vault may hold a track without
   a CRM, while a connected CRM may be the home for a track the owner places there. Brain
   continues to own personal knowledge and the personal network.
7. **Taste/life-context is its own store** (planned, not yet built): markdown with
   OKF frontmatter, mounted read-only into designated agents — the chief of staff and any
   agent the owner designates. Connectors (Photos shared albums first, then Spotify / Apple Music /
   Google Maps per the backlog ranking) sync *into* it. It exists as a separate store
   precisely because a designated agent must reach taste without reaching Brain.
8. **Sync between stores follows the Atlas sync pattern**: narrative changes are
   proposed (👍-gated), derived/mechanical fields refresh deterministically. New sync
   needs reuse this pattern and the shared approval face; no bespoke fourth design.
9. **One OKF `type:` vocabulary for the whole knowledge layer**, defined for the Atlas sync. Other stores (Brain, taste) extend it; they do not fork it.

## Consequences

**Positive:**

- "Where does this fact live?" has a written answer; sync jobs and agents stop
  needing per-session judgment calls.
- The taste layer can be built for a designated agent without weakening the Brain boundary, and
  the chief of staff gets it for free (same mount, different container).
- OKF conformance makes every store readable by any future framework — the knowledge
  layer stays portable independent of the eve decision.

**Negative / accepted trade-offs:**

- Mirrors mean some duplication is permanent by design; the cost is sync machinery
  (a few small jobs) rather than a single mega-store.
- A separate taste store is one more mount and one more directory to back up —
  accepted, because folding it into Brain would either leak Brain into that agent or
  wall it off from taste.
- Notion pages that *feel* authoritative (meeting notes, playbooks) are still only
  canonical for their class (§4); someone must occasionally say "that Notion page is
  a mirror, fix the repo doc instead."

## Operational rules

- Do: when adding any new connector or data source, decide its owning store *first*
  (this ADR's §2–§7), then wire the sync.
- Do: when an agent needs data it doesn't have, mount the owning store (or a subset)
  read-only — never copy content into the agent's own files.
- Don't: give any agent other than the chief of staff a Brain mount, ever (§2).
- Don't: build a new sync mechanism; reuse the propose/mechanical split and the
  shared approval face (§8).

## Open questions

- Taste store location and mount name — decide when the first
  connector (Photos shared albums) is built; nothing depends on it before then.
- Brain freshness as the second consumer of the Atlas sync pattern — revisit once
  that sync has run stably for a few weeks.
- Whether the Clips DB needs a `canonical_sources` prefix of its own or
  rides under `notion:` — resolve when the clipper work resumes.

## Amendment 2026-10-09 — Notion's Articles database is a capture place and a mirror, not the owner

For articles (the Clips DB named in §4, now the Notion "Articles" database), the Vault note is the canonical store, as §1 requires. This amends §4, which named Notion the owner of that table. For articles, Notion does two jobs. It is a place to capture them, where a new row becomes a new note. It is also a mirror: each article is mirrored only to a Notion Articles database belonging to the same owner and visibility as the article (for a Notion clip, the database it came from), so a private article never reaches an organisation database. Switching the mirror on takes one standing write approval, limited to that Articles database. Three fields on a mirrored row are also an input channel. When a person edits Status, For or the highlights, Lares treats the edit as owner input: it applies the change to the Vault note and mirrors it back, exactly as if the owner had said the same thing in chat. The note's origin stamp is not changed by it (ADR-0017 §9). Edits made by Lares's own integration, by Notion Agents or by any other editor that is not a person are never captured as owner input. Every other Notion edit to a mirrored row is ignored and overwritten by the next mirror. Lares always captures before it writes, so a stale mirror never overwrites a person's edit. Pages Lares creates are recorded in its ledger when they are created, so they are never imported back as new captures.

## Amendment 2026-10-26 — Tracks are workflow records, not contact profiles

ADR-0024 amends §6. The home of a track owns its items and workflow state, whether that home
is a Vault folder or a connected CRM. An item may refer to a person or organisation, but its
presence does not move that person's canonical profile or grant access to it. The Vault may
be the track home without any CRM being connected.
