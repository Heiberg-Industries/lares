# ADR 0018 — Agents learn by adding; consolidation proposes, never edits in place; third-party content never becomes memory

**Date:** 2026-09-18
**Status:** Accepted
**Supersedes:** —
**Amends:** ADR-0017 (rule 4's gate depends on this decision's rules 3 and 8)

## In plain language

Before this decision, an agent's overnight "dream cycle" could change what it believed about you, on
its own, without asking — it could even overwrite a preference you stated. This decision changes
that: anything an agent learns without you in the room can only be *added*, never edited
or deleted in place. If it wants to change or remove something, it has to ask you first, the same
way it already asks before sending an email. Nothing read from an email, a web page, or someone
else's calendar invite can ever become a standing memory, however many times it repeats — that is
exactly how an attacker could plant a false memory by sending the same email three times. Every
overnight learning run becomes one reviewable, discardable batch of changes, and the run tells you
plainly when it rejected something and why. Overnight learning is off by default for a new
installation until this safe version is in place.

## Context

The engine's dream cycle is `services/chief-of-staff/lib/dream/` (`cycle.ts`, `promote.ts`,
`store.ts`, `redact.ts`, `log-reader.ts`). Nightly: read conversation logs since the last cursor
(excluding scheduled-lane turns), extract `Observation`s with an LLM (`reflect.ts`), scrub obvious
PII (`redact.ts`), then promote (`promote.ts`). The original promotion gate was
`confidence >= PROMOTE_CONFIDENCE || recurring` where `PROMOTE_CONFIDENCE = 0.8` — exactly the
rule the memory-safety research names as the mechanism a repeated-email attack defeats ("the model
was 99.8% right at first contact and still laundered the text", citing a published "prompt
laundering" exploit against a comparable design). `promote.ts` already does two things right worth
keeping: it never deletes a superseded preference (`supersede` in `store.ts` stamps `valid_to` and
keeps the row), and an identity/persona-level observation is routed to `needsConfirm` rather than
auto-promoted (`isIdentityShift`) — a first cut at rule 7 below, not yet applied to ordinary
preferences. Nothing here writes to memory through an approval-gated tool: the promoter calls the
store directly, so the always-ask machinery (`packages/agent-kit/src/always-ask.ts`) never sees a
dream-cycle write at all.

An earlier, separate dream implementation in another role rewrote a whole learned-notes file every
night with no confidence score, no recurrence rule and no origin tracking, and appended to a taste
file outside any capability grant (the write-path gap ADR-0017 names). It is not part of this
engine; the rules below are the bar any dream implementation must meet.

`services/chief-of-staff/lib/dream/reflect.ts` already filters out one class of bad
observation — `SCAFFOLDING_PATTERNS`, statements about the agent's own mechanics mistaken for
facts about the owner. That is a narrower, different filter from rule 5's "do not learn" list
below; it stays, and the new list is added beside it.

`services/chief-of-staff/agent/instructions/standing-facts.ts` and
`services/chief-of-staff/lib/standing-facts.ts` are the "fast lane" this decision's rule 9
concerns: `MAX_STANDING_FACTS = 40`, a 1,500 ms timeout, rebuilt on every `turn.started` event,
not once per session. It is already owner-origin only by construction — `remember`
(`catalogue/remember.ts`) and `forget` (`catalogue/forget.ts`) both call `humanTurnRefusal`,
refusing any write on a turn with no allowlisted human present, so a scheduled brief can read the
block but cannot add to it.

The neutral role templates ship dreaming **off**: the chief-of-staff role's
`packages/agent-kit/templates/chief-of-staff/definition.json` sets `"dream": { "on": false }` in its
`schedules` block. So the "off until safe" half of rule 3 below needs no code change for a fresh
installation. What changes is turning it on once the safe version ships. An installation's own
schedule setting lives in its installation data, not the engine; this ADR states the rule, not any
installation's value.

## Decision

1. **Origin is the precondition for everything below.** The classes, the stamping rule and the
   in-turn taint mechanic belong to the origin model; this ADR assumes
   them and states what dreaming and the per-session core do with an origin once it exists.
2. **Unattended processes may only ADD.** A background dream run, a scheduled job, or any process
   with no owner present may insert a new row and may *supersede* (insert a new row, close the
   old one — `store.ts`'s existing `supersede` shape) — it may never `UPDATE` or hard-delete an
   existing row. Editing or deleting an existing standing fact or preference becomes a proposal
   behind an approval card, the same shape `forget.ts` already uses for a human-requested retire.
3. **Dreaming is OFF by default for a new installation until this ADR's safe design has shipped**
   (rules 2, 4–8), matching what the neutral templates already set. Once shipped, it defaults ON.
   An installation already running it under its own setting keeps that setting through the
   transition; nothing here silently flips a running installation's schedule.
4. **The promotion gate changes.** Replace `confidence >= 0.8 || recurring` with: promote only an observation whose origin is `owner`, and only on
   recurrence across a minimum number of distinct owner-origin observations (the research's fix for
   prompt laundering: "drop recurrence as a promotion trigger for anything third-party; count
   recurrence only across owner-originated statements"). Model confidence stops being a promotion
   signal — it may still be logged, but nothing decides on it alone (agents grade their own work generously, and letting a model silently rewrite and delete memories destroys information). An
   `agent`-origin observation (the agent's own inference) may be *held* for owner confirmation; it
   may never auto-promote. A `third_party`- or `system`-origin observation is never a promotion
   candidate at all, regardless of recurrence.
5. **A "do not learn" list**, applied in the reflector prompt beside the existing
   `SCAFFOLDING_PATTERNS` filter: environment failures, one-off tasks, unresolved failures, and
   negative claims about tools ("X is broken") — as another agent project puts it, these "harden into refusals the agent cites against itself for months after the actual problem was
   fixed."
6. **One commit per dream run.** `cycle.ts` already writes one dated reflection note
   per run naming what was promoted, superseded, held and needs-confirm; this is extended so the
   underlying preference-table change set and the note commit atomically, and so the note also
   names what was **rejected and why** ("N blocked: third-party origin", "N blocked: below
   recurrence threshold") — the research's fix for a failure in another agent project, where a provenance gate silently rejected every candidate for weeks with nothing surfacing it. A run in
   which everything is rejected raises a signal rather than logging a quiet zero.
7. **Facts about the world versus how the agent should behave stay in different homes.** A
   learned fact about a person or a company goes to that entity's page (the personal or shared area of the Vault, per ADR-0017); a learned instruction about how the agent itself should act goes to the agent's own
   definition notes (`duties.md`/`voice.md`, ADR-0015), never into the same preferences table.
   `promote.ts`'s `isIdentityShift` check is the existing first cut at this split —
   it already routes persona-level text to `needsConfirm` instead of the preferences table; this
   rule generalises it so the routing decision, not just the gate, is made for every observation.
8. **Retirement by usage**, replacing the current binary `retired_at`/`valid_to`: active → stale
   → archived, on a usage clock (unused for N days → stale; unused for M more → archived),
   **never deleted** — the "promote by use, retire by disuse, never delete" pattern.
9. **The per-session core replaces per-turn injection.** `standing-facts.ts` moves from rebuilding
   on every `turn.started` to a size-budgeted, byte-stable block built once per session, from
   owner-origin facts only (already true by construction — see Context). A written precedence
   rule ships with it: the owner's latest instruction wins; notes are advisory; if memory
   conflicts with the current request, the agent asks ("1) latest instruction wins… 3) global memory is advisory… 4) if memory conflicts, ask").
   A `save_note` tool lets the agent add a note mid-conversation, add-only, in a fixed shape — the
   role `remember`/`forget` already play for standing facts, generalised. After the eve version
   bump (ADR-0016), this plugs into eve's own memory seam through a self-hosted provider rather
   than a bespoke resolver.

## Consequences

**Positive:**

- The exact laundering path the research documents — repeated third-party text, promoted by
  recurrence, trusted by every later process — is closed at the promotion gate, not patched
  after the fact.
- A dream run becomes reviewable and discardable ("the input store is never modified… you can
  review the output and discard it"), without needing hosted infrastructure — git already gives
  Lares this for free.
- Any future dream implementation has one safety model to meet, even if its prompts and stores differ.

**Negative / accepted trade-offs:**

- Every unattended write path gains an approval step for edits/deletes;
  a genuinely stale preference now waits for a 👍 instead of quietly disappearing.
- The per-turn-to-per-session move (rule 9) trades immediacy for cache stability: a fact retired mid-conversation used to stop applying on the very next turn (the stated reason `standing-facts.ts` chose `turn.started`); a session-built block
  must decide how it still honours that without rebuilding every turn — left open below.
- Retirement-by-usage (rule 8) is new schema and a new scheduled job; the stores have no usage clock.

## Operational rules

- Do: route every unattended memory write through the add/supersede path; route every edit or
  delete through an approval card, whatever code path proposes it.
- Do: log a rejection with its reason on every dream run, even when the run promotes nothing.
- Don't: let a dream cycle, a schedule, or any process with no owner present call `UPDATE` or
  `DELETE` on a facts or preferences table directly.
- Don't: promote a `third_party`- or `system`-origin observation under any confidence or
  recurrence value.

## Open questions

- **How the per-session core (rule 9) keeps `standing-facts.ts`'s "a retraction applies next
  turn" guarantee** once the block is built once per session rather than on every `turn.started`.
  Candidate: rebuild only when the underlying fact set actually changed, not on a timer — needs a
  design pass, not decided here.

- **Where the per-phase spend cap is enforced** — nothing in `reflect.ts`, `promote.ts` or `cycle.ts` reads a budget; the "fail-closed on
  unpriced models" pattern is the closest precedent and routes through the LiteLLM gateway, not
  through the dream cycle's own code.

## Cross-references

- ADR-0017 — the Vault's field set (`lares_origin`, `valid_from`/`valid_to`/`superseded_by`)
  these tables adopt.
- The origin model — the origin classes and the narrowest-origin rule this ADR's promotion gate depends on.
- Research on prompt laundering, add-only memory, database-first memory and vendor guidance on dreams and memory precedence.
