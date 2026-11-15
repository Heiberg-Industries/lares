# ADR 0027 — Changing a started agent

**Date:** 2026-11-12
**Status:** Accepted
**Amends:** ADR-0015 §4 and its Consequences (when a change to the model takes effect)

## In plain language

1. An owner can change a running agent from the console, and the change takes effect. Nothing has
   to be confirmed again on the server.
2. Most changes take effect when they are saved. A few need the agent restarted, which **Apply**
   does in about a minute.
3. Saving a change ends the agent's open web-chat conversations, and any approval waiting in
   them. The page says so before Save.
4. Spending stays bound by what already bound it: the agent's model name, the prices reviewed at
   budget setup, and the monthly limits.

## Context

On an installation where spending is set up, `lares agent start` opens a spending key for the
agent. The key store recorded a fingerprint of the whole definition when the key was made, and the
keeper refused to run the agent unless the current definition matched it exactly. Nothing could
update that fingerprint. So once an agent had been started, every save stopped it, and Apply put
the old definition back. No record asked for this; the whole-definition match was used as the
strictest available evidence that nothing had changed.

The money is protected elsewhere: the key is per model name, prices and caps live in the reviewed
policy, who may use an agent lives in grants, and every model call is admitted against the person's
monthly limit. The maintainers decided that a change to a started agent applies from the console
alone, with those checks as the protection.

## Decision

1. **A spending key follows the agent, its incarnation and its model name.** The definition hash
   stored with a key stays in the key store but is not compared. Nothing is migrated and nothing
   new is stored.
2. **Restart parts.** The role, the doors, the personal-account switches and, where a key pays,
   the model are the parts of a definition that only a restart brings into effect. One shared rule
   in the keeper names them, and every check that used to require "applied equals saved" now
   requires "the restart parts are applied". The other checks stay: the saved definition is valid,
   its record matches its files, and nothing is waiting.
3. **Live at Save:** description, instructions, personality, language, schedules, where messages go,
   and outside tools. These are read again for each conversation (ADR-0015 §4).
4. **Save, then Apply:** doors, role, personal accounts, and the model where a key pays. A save of
   one of these is marked waiting; Apply restarts the agent, which then runs on the changed
   definition with its key. A model change is refused at Save unless the agent already holds a
   working key for the new model name.
5. **Applied at once, and the rollback point.** A save that needs no restart, on an agent with
   nothing waiting, is recorded as the applied definition when it is saved, and becomes the point a
   later failed Apply goes back to. A failed Apply then undoes only the changes that were waiting
   for it. A save while something is waiting changes neither.

   A busy spending-key store, or a spending ledger in the middle of a write, is not a failed Apply.
   A budget check waits a short, bounded time for it. If it is still busy, nothing is undone: the
   agent stays stopped with the change waiting, and the next Apply starts it. A save does not stop
   a running agent because the store was busy. Busy never lets a model call through, because every
   model call is still checked on its own against the key store.
6. **Every save ends the agent's open web-chat conversations.** A conversation holds the agent's
   access revision from when it began, and a new definition moves that revision on, which revokes
   every conversation of the agent. A conversation that read notes is also bound to the definition
   it read them under. Both rules protect who sees what and stay as they are. The pages that save a
   definition say so before Save, for an agent that runs; a message or an answer into an ended
   conversation is told it is no longer available.

## Consequences

**Positive:**

- An owner can switch a door on, and change instructions, schedules, tools or model, on a started
  agent, on the tested install path.
- An engine release that gives a definition field a new default no longer holds every started
  agent after an update.

**Given up:**

- Re-confirming spending on the server after an edit. A change that lets an agent do more by itself
  (a new schedule, a new outside tool) spends within the same monthly limits without a new
  confirmation.
- Open web-chat conversations survive no save. An owner starts a new conversation after editing.

**Amendment to ADR-0015:** ADR-0015 says a model change applies at the next conversation. That
still holds where no budget key pays. Where one does, a model change waits for Apply (§4 above), and
so do doors, role and personal accounts.

**Known limit:** where a key pays, a Slack or Telegram conversation that was already running when a
model change is applied is refused afterwards (ADR-0026, Consequences). Only a new
conversation uses the new model. This is a limit, not the intended end state, and a later release is
planned to change it. Edits that are not a model change do not cause it.

**Known limit:** a save made while the spending-key store is busy does not stop an agent that has
in fact lost its spending permission. The agent goes on running until a later check sees the loss.
No money moves meanwhile, because each model call is refused on its own.

## Cross-references

- ADR-0015: definitions resolved at runtime.
- ADR-0023: member authority, grants and conversation audiences.
- ADR-0022: the tested install path.
