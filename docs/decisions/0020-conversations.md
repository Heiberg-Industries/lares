# ADR 0020 — One conversation record, kept twelve months by default, erasable per person

**Date:** 2026-09-18
**Status:** Accepted
**Supersedes:** —
**Amends:** — (ADR-0010 governs knowledge stores — Brain, Atlas, Notion, the CRM — and says
nothing about conversation logs; this ADR names a further kind of record that ADR-0010 does
not cover)

## In plain language

1. Every conversation an agent has was recorded in three different, incomplete places at once — and none of them is really "the" record.
2. This decision names one of them the record: a database table, never edited after the fact,
   one row per turn, marked with who or what produced it.
3. Conversations are kept for twelve months by default; the owner can shorten that, lengthen it,
   or choose "keep forever".
4. The daily markdown transcript files an agent used to write stop being written; the database
   table takes over that job.
5. eve's own internal bookkeeping tables — which the framework needs to keep a conversation
   running at all — are kept only for as long as the framework needs them, not as a historical
   record and not subject to the twelve-month setting.
6. The nightly "dreaming" review reads this same database record instead of the markdown files.
7. Deleting a person's data and exporting a person's data both work against this one record, as
   well as everything else that touches that person.
8. Git history is honest here: once something is committed to the vault's git history, deleting
   the working file does not erase it from history — that limit is stated plainly, not hidden.

## Context

**Copy one — eve's own workflow/session tables.** The chief-of-staff agent sets
`world: "@workflow/world-postgres"` inside `experimental.workflow`, so eve's session, turn,
step, queue and stream state is persisted in the box's own Postgres rather than eve's default
local-disk world. The schema it expects already applied is
`services/chief-of-staff/sql/001-eve-workflow.sql`, which creates the `workflow.workflow_*` tables
(events, hooks, runs, steps, stream chunks, waits). This is eve's own durability spine, not a
conversation log Lares designed — the box has no auto-migrate, so this schema is applied once and
never touched by the running agent.

**Copy two — the markdown logs under `_meta/conversations/`.** `services/chief-of-staff/lib/conversation-log.ts`
writes one markdown file per exchange to `_meta/conversations/<date>/<stamp>-<door>.md`, with a
YAML frontmatter block (`at`, `door`, `principal`, optional `lane`, `proposals`) and a body of
`**<speaker>:**` lines. The speaker labels must be role-neutral, not tied to any installation's
names. The actual capture happens in `services/chief-of-staff/agent/hooks/turn-capture.ts`, an
agent-level hook (not a channel `events` handler, for reasons its own header explains at length:
a channel handler would silently replace eve's default reply-posting behaviour) that buffers one
exchange per session across `turn.started`, `message.received`, `actions.requested`,
`message.completed`, `turn.completed`, `turn.failed` and `turn.cancelled`, and flushes a
`TurnLogEntry` to `conversation-log.ts` on the terminal reply, on eviction after 24 hours, or on a
failed/cancelled turn. It is careful, hard-won code — its module header documents a production
outage it exists to prevent — and none of that care is lost by this ADR; the same buffering and
exchange-boundary logic simply needs to write to a database table instead of a markdown file.

**Copy three — the `agent_conversations` projection.** `services/box/sql/001_baseline.sql`
creates one table: `agent, incarnation, session_id, door, observed_at, terminal`, primary-keyed on
`(agent, incarnation, session_id)`. Its own comment says what it is: "No transcripts,
current incarnation-scoped UI projection." It stores no message text and no speaker — only that a
session exists, which door it is on, when it was last observed, and whether it finished.
`packages/agent-kit/src/conversation-control.ts` writes it (an upsert that sets `observed_at=now()`,
and deletes rows beyond the newest 500 per agent/incarnation); `services/keeper/lib/conversations.ts`
reads it for two keeper actions, `conversation.list` and `conversation.reset`.

**What reads each.** The dream cycle's `services/chief-of-staff/lib/dream/log-reader.ts`
reads only the markdown logs: `readConversationLogs` lists everything under
`_meta/conversations/**/*.md`, parses each file's frontmatter and body back into a
`TurnLogEntry` (`parseConversationLog`), deliberately excludes any entry carrying a
`lane` (a scheduled, machine-authored turn: "nothing to learn from it"), and
returns entries strictly after a `since` cursor. The console reads only the `agent_conversations`
projection, through the keeper (`conversation.list` and `conversation.reset`). Nothing reads
eve's own workflow tables for conversation content; they exist purely so eve itself can resume a
session.

## Decision

1. **The conversation record is a new, append-only database table**, distinct from all three
   things above. Once it exists, the markdown logs stop being written and the dream cycle reads
   the new table instead of `_meta/conversations/`.
2. **Shape, in words:** one row per turn (or per exchange, preserving `turn-capture.ts`'s
   existing exchange-boundary logic rather than eve's smaller per-turn unit — the reasons that
   file gives for keying on an exchange still hold); an **origin** on every entry (owner-said,
   agent-said, or system, matching the origin classes the origin model defines); a
   **per-person key**, so an erase-a-person routine can find and remove every entry a given
   person produced or received without touching anyone else's; and it is **searchable** — the
   console's Memory page and "which memories did you use?" (ADR-0017 rule 5) query it directly rather
   than grepping files.
3. **Retention defaults to twelve months.** The owner can change the retention period, including
   to "keep forever", as an installation setting. Entries past the retention window are pruned;
   the prune runs on the same schedule as other nightly housekeeping.
4. **The markdown logs stop.** `conversation-log.ts` and the writing half of
   `agent/hooks/turn-capture.ts` are rewired to write the new table instead of a vault file; the
   hook's exchange-buffering logic (session-keyed, 24-hour eviction, terminal-reply flush) is
   kept, because it is what makes a parked approval or a tool-using turn end up as one correct
   entry instead of two.
5. **eve's own session/workflow rows are kept only as long as eve needs them to run** — not
   subject to the twelve-month setting, and not treated as a historical record. They are pruned
   once a session is closed and past its operational need, independently of the conversation
   record's own retention.
6. **The `agent_conversations` projection is not replaced.** It answers a different question —
   "which sessions exist right now, can the operator reset one" — and stores no transcript
   content to begin with, so there is nothing in it for the new record to subsume. It continues
   to serve the console's live-session view and the keeper's `conversation.reset` action
   alongside the new conversation record.
7. **Export and erase read and write against the new conversation record** as their
   primary source for "what did this person say and hear", together with every other store that
   carries a person's data (standing facts, notes, the archive, sync state — outside this ADR's
   scope, but the per-person key this record carries is what a cross-store erase routine keys on).
8. **The dream cycle's own exclusion rule carries over.** Scheduled, machine-authored entries
   are still excluded from what the dream cycle learns from; the new table's origin field is what
   makes that exclusion a query instead of a frontmatter string match.

## Consequences

**Positive:**
- One searchable place for "what was said", instead of a grep over dated markdown files that the dream cycle already treats as fragile (its own parser tolerates and silently drops unparseable files).
- Erasure and export become a query against one table with a person key, rather than a file walk
  with no reliable per-person index.
- The vault's git history stops accumulating conversation transcripts, which is exactly the
  content most likely to need erasing later.

**Negative / accepted trade-offs:**
- eve's own workflow tables (`workflow.workflow_events` and siblings) still hold turn content —
  message bodies, tool call arguments — for as long as a session stays open, and are not
  erasable per person by anything this ADR builds. An erase-a-person routine that runs while a
  person's session is still open will not remove what eve itself is holding; the honest position
  is that erasure reaches the conversation record and every Lares-owned store immediately, and
  reaches eve's own session state only when that session closes and its rows are pruned (rule 5).
  This must be stated to the owner, not glossed over.
- **Git history of the vault**, honestly: even after conversation transcripts stop being written
  to the vault going forward, every markdown log already committed before the change remains in
  the vault's git history unless a history rewrite (a purge) is run. A working-tree delete alone
  does not remove it. An erase-a-person routine that only deletes files leaves those entries
  recoverable from `git log -p` indefinitely.
- Migrating the existing `_meta/conversations/` corpus into the new table (so the dream cycle
  does not lose its history on the day the change ships) is real, separate work, not covered here.

## Operational rules

- Do: stamp origin on every entry at write time, never inferred later.
- Do: keep the record append-only; a correction is a new entry, not an edit of an old one.
- Do: run the retention prune and the eve session-row prune on independent schedules.
- Don't: let the dream cycle, or anything else, write back into the conversation record.
- Don't: treat `agent_conversations` as if it were the conversation record — it never held
  transcript content and this ADR does not ask it to.
- Don't: claim an erase is complete while a person's eve session is still open; say what is
  outstanding.

## Open questions

- The exact table shape and its migration number are a build decision, not this ADR.
- How eve's own session semantics change under the ADR-0021 upgrade (0.32 to 0.60.x) — the
  execution-model rewrite there changes what "a session" durably holds, and this ADR's rule 5
  should be re-checked once that upgrade lands.
- Whether the new record also becomes the source for "which memories did you use?" on the door
  channels themselves (ADR-0017 rule 5), or only in the console.

## Cross-references

- ADR-0015 (agents are definitions), ADR-0016 (eve), ADR-0010 (knowledge-store authority, amended)
- The origin model
- The export and erase feature (ADR-0017 rule 7)
