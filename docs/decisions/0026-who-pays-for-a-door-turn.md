# ADR 0026 — Who pays for a Slack or Telegram turn

**Date:** 2026-11-12
**Status:** Accepted
**Builds on:** ADR-0023 (member authority) and ADR-0025 (one door-neutral layer)

## In plain language

1. On a server set up with the installer, every model call needs permission from Keeper, the
   service that holds the money and the permissions. There is no gateway key file on such a
   server, on purpose.
2. Until now only web chat asked Keeper. A message in Slack or Telegram asked nobody, so it could
   never reach a model there. The same was true of a brief or reminder a schedule wrote into a
   Slack or Telegram conversation.
3. From now on a Slack or Telegram message is paid for by the member behind the door's claim:
   the person who connected the door with the one-time code. Today that is always the owner.
4. A conversation a schedule started (a brief, a re-ping, a deadline note) is an **owner job**:
   the owner pays. Keeper already refuses an owner job once the agent is shared with another
   member, because the owner must never pay for a call another person could have caused.
5. This is built once, in the shared kit. No door file takes part.

## Context

A **door** is a way a person reaches an agent (ADR-0025). A **claim** is the record that a door
belongs to one person: the platform's own user id, stored when the owner sent the one-time code
in a private chat, and handed to the agent's runtime as `LARES_<KIND>_PRINCIPAL` with its
revision. A **managed runtime** is one Keeper serves: it has Keeper's socket and no key file.

eve itself verifies a Slack or Telegram request (signature or secret) before it builds the
session's identity: the authenticator (`slack-webhook`, `telegram-webhook`), the person's
platform user id, whether the author is a person or a bot, and the kind of chat. A conversation a
schedule starts carries eve's own app identity instead, which eve's `isScheduleAuth` recognises.
eve has no notion of who pays (read in eve `1.0.0-rc.10`).

## Decision

1. **The agent vouches for the platform event; Keeper vouches for the person and the money.** The
   kit reads eve's verified identity and checks that the person speaking is the claimed person
   on that door, in a private chat, not a bot, and that the conversation was started by that same
   person or by a schedule. Anything that looks like a door turn but fails a check is refused,
   never passed on.
2. **The agent asks Keeper `door.open` once per turn**, naming only the door, the claimed user id,
   the claim's revision and the turn's place (session, turn, position). It sends no member id, no
   email, no model and no copy of eve's identity. Keeper checks the claim and the door, finds the
   payer itself (the installation owner it has on record, who must hold a use grant on the agent)
   and answers with a turn capability. From there the turn uses the same per-step path as web
   chat; the payer's spending limit is checked when each call is spent.
3. **A schedule-started conversation runs as an owner job.** Its model calls ask Keeper for an
   owner-job ticket per call, and each call still uses its step's single dispatch, so it can never
   send twice.
4. **A managed runtime never reads a key file.** A model call there carries Keeper's permission or
   is refused before any file is opened. There is no fallback, ever.
5. **One sentence for a person.** When a door turn is refused, the person sees the kit's fixed
   sentence, from the same table as the other refusals of the model seam: "I could not get
   permission to answer this message here. Please try again later, or write to me in web chat."
6. **Door-neutral.** The only door-aware part is one table in
   `packages/agent-kit/src/door-model-authority.ts`, keyed by eve's authenticator. A new door adds
   one row there and nothing in its door file (ADR-0025).

## Consequences

- Slack and Telegram work on an installer-made server, and briefs written into those doors are
  sent.
- An overlay install without Keeper's socket keeps its current path unchanged.
- An agent shared with a second member cannot run schedule-started conversations until member
  jobs exist (Keeper refuses them).
- Left for later: several claimed people per door (a members stage, which needs a database
  change), and Keeper checking the platform event itself instead of trusting the agent's check.
