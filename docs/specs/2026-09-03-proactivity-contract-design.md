# The proactivity contract — design

> **Accepted in principle 2026-09-04** — the six defaults stand and question 5 became the owner clock (final section). Still a design document, not a plan.

**Date:** 2026-09-03
**Status:** **DRAFT — for the owner's review.** Nothing here is settled until he says so.
**Ticket:** ORB-193. **Blocks:** ORB-180 (deadline escalation).
**Related:** Lares audit §5.5, sub-project 8, obligation-radar design §4, ADR-0012.

## Why this exists

Three facts already paid for. **Tyche was paused for spam** — and the obligation radar names the
diagnosis precisely: not proactive messaging, but proactive messaging *on model-judged importance*.
**Marcel posted roughly fourteen times before a trip** from a seven-day window until ORB-125 cut it
to two slots ("lets not do evening and morning posts before the trip, to chatty"). And **the briefs
earn their keep** — because they are named slots that stay silent when there is nothing to say.

Each was decided per-feature. ORB-180 would decide it again, then content radar, signals-home, every
Lares installation that is not the owner's. Written once: an installation configures the numbers, not
the rules.

## 1. Initiation classes

An agent may initiate in three ways; everything else is a reply.

- **Scheduled** — a named slot fires on a clock, news or not.
- **Event** — something happened: a message, a booking, a threshold.
- **Escalation** — an earlier initiation went unanswered; the item comes back louder.

The whole fleet maps onto them, which is the evidence they are right:

| Surface | Agent | Class | Cadence today | Door |
| --- | --- | --- | --- | --- |
| morning + evening brief | Saga | scheduled | 08:00 / 20:00 daily | Telegram |
| digest | Saga | scheduled | 09:00 + 17:00 | Slack |
| weekly-summary | Saga | scheduled | Sun 09:00 | Telegram |
| reminders | Saga | scheduled (owner-set) | its own time | pinned door |
| email-triage ping | Saga | event | 1 min, ≤10 billed/tick | Slack |
| meeting-followup | Saga | event | 5 min, ≤5/tick | Slack + email |
| crm-routing | Saga | event | `ROUTE_HOURS` 09/13/17 | Slack |
| proposals-watch | Saga | event | 1 min, 1 turn per lane | Telegram |
| outreach-reply-watch | Saga | event | 15 min | Slack |
| **reping** | Saga | **escalation** | 30 min, ≤3/day, **gated OFF** | Telegram |
| trip lifecycle (7 kinds) | Marcel | scheduled, trip-relative | 08:30–20:00, trip clock | TG group |
| booking reminders | Marcel | scheduled, booking-relative | T-3h flights, T-1h other | TG group |
| flight-watch | Marcel | event | ≤1/5 min, travel day only | TG group |

Absent because they never initiate: Calliope (reactive Slack DM), market-edge (proactive OFF), Saga's
silent `dream`/`voice-learn` jobs. Two things fall out. **The fleet has one escalation surface and it
is switched off** pending the owner's bar — ORB-180 builds the first rung rather than adding one. And
**the event column is all polling plus a ceiling**, each ceiling local.

## 2. Per-class cadence bounds

Hard bounds, enforced whatever a persona, skill or prompt says.

1. **Scheduled slots are named, never free-form** — a finite list per agent. *Reason: Marcel's
   fourteen posts came from a seven-day window, not a slot list. A window has no ceiling; a list is
   one.*
2. **Silence is correct output.** A slot with nothing to say sends nothing — no empty message, no
   "nothing to prepare for tonight". The brief contract says this; it now holds fleet-wide.
3. **The freshness check watches the JOB, not the message** — a silent slot and a dead slot look
   identical from outside. *Reason: ORB-179 — filed-0 digest passes left no durable trace, so ten
   dead days looked healthy.* A surface ships with its heartbeat or not at all; an absent row is
   stale, never fresh.
4. **Event initiations carry two ceilings, and neither substitutes for the other.** A **per-tick**
   ceiling bounds *cost* (the Aug-14/15 leak: an uncapped retry loop, ~$250); a
   **per-door-per-day** ceiling bounds *attention* (Tyche). Default 10 per door per day; anything
   over rolls into the next slot rather than being dropped.
5. **Only a fact may buy an interrupt.** A model may rank; it may never ring the phone. *Reason: the
   Tyche lesson exactly — ranking wrongly costs nothing, interrupting wrongly costs his attention.*
   A re-ping qualifies: "they messaged again on top of their unanswered message" is mechanical.
6. **One item, one surface, by rule** — assigned up front, never de-duplicated after, so nothing
   arrives twice in two voices.

## 3. Suppression

- **Quiet hours, per door.** Marcel's rule (22:00–07:00, trip clock) includes the part that matters:
  *a missed slot inside quiet hours is dropped for good, never caught up* — a very late catch-up is
  worse than no post. Saga has none stated; her slots happen to sit in daylight. Engine floor: every
  door has quiet hours, ≥8 hours, movable but not removable.
- **Travel — the owner clock.** A trip changes the clock and the plate, for EVERY agent (the owner,
  2026-09-04: "if I travel for work across timezones all agents should follow"). One resolver in the
  shared kit answers "where is the owner right now": the trip itinerary first (Marcel's trip store —
  the strongest signal), the calendar's flight and lodging events second, the owner's Slack profile
  timezone third (Slack updates it from the device automatically), the configured home last.
  Telegram exposes nothing. Every agent reads that one clock; Marcel's rule generalises: **date and
  time come from the same clock**. *Reason: ORB-124/128 — date off one clock, time off another, and
  a job fires twice or never; ORB-204's checkout fired at 09:00 New York, mid-air.*
- **Already-seen.** An item surfaced once never surfaces again unless it escalates. Its dedupe key is
  durable, read fresh each tick, and **written only after a confirmed send**: recording before a
  failed send drops the item permanently, worse than a rare duplicate.
- **Owner-initiated.** An owner reply resets that item's escalation clock and closes what it answers.
  Before a billed call, look for the human reply the scan window cannot see (ORB-92: `-from:me`
  cannot tell "unanswered" from "already answered").
- **Do-not-disturb.** An owner switch, per agent and global. It suppresses everything except a
  ladder's final "I stopped", which queues to the first slot after.
- **One owner per fact.** ADR-0012 §4 applied to agents: one incident, one message, one path. Where
  two agents see one fact, one owns telling him. *Reason: at ~500 messages/day the alerts channel
  had trained its only reader to ignore it.*

## 4. The escalation ladder (ORB-180's first consumer)

A deadline is a dated obligation to an institution. Its ladder:

1. **The first mention rides a scheduled slot**, never its own message — a deadline has a date and
   the brief is daily.
2. **Backoff is geometric, with a cap**: slot mentions at roughly T-16, T-8, T-4, T-2, T-1 days.
   Closer earns *more* attention, not a drip.
3. **Then a reminder**, at its own time on the pinned door — the existing path, with its dedupe.
4. **Then, at most once, an interrupt** — inside a fixed final window, for a still unacknowledged
   deadline; legitimate only because "inside the window and nothing acknowledged it" is a fact, not
   a judgement (rule 2.5).
5. **Then it stops and says so, once:** *"I have raised X three times and I am going to stop. Ask me
   if you want it back."* A silent stop is ten-dead-days at the scale of one item.

**Resets:** an owner reply naming the item, a dismissal, or the fact changing (the filing appears).
A reset returns it to slot mentions; never to its old rung.

## 5. Per-installation overrides (Lares sub-project 8)

**May be configured:** slot times and timezone; the door per class; ceilings *lowered*; quiet hours;
escalation on/off per primitive; a class disabled; DND. All hard-coded today (`WEEKLY_SUMMARY_HOUR`,
`ROUTE_HOURS`, the 09/17 digest slots, the 08:00 brief, Marcel's 22:00) — sub-project 8's job.

**May not:** raise a ceiling above the engine default, or touch the fact-only interrupt rule,
silence-is-correct-output and its heartbeat, already-seen, one-owner-per-fact, or market-edge's
proactive-OFF default and never-a-stake rule. Each knob gets a console surface as it is built (the
Lares working agreement), so nothing stays env-var-only.

**Where enforcement lives.** In `@lares/agent-kit`, widening `scheduleGate()` — today one fail-closed
kill switch (`EVE_SCHEDULES_LIVE === "1"`) each schedule checks first — into a per-initiation gate
every proactive send passes through, backed by a **per-door ledger** in the shared Postgres, one row
per (installation, agent, door, class, item key, sent_at). That table is at once the dedupe key, the
daily counter, the escalation rung and the heartbeat. Schedules keep their logic; they lose the right
to send unasked.

## 6. What this unblocks, in order

**ORB-180** (deadline escalation — must not ship before this is accepted); then **ORB-45's nudge**
(`OBLIGATION_REPING_ENABLED`, OFF — flip once the ceiling is enforced centrally, not inside
`reping.ts`); then **ORB-214 item 1** (market-edge watchlist refresh and re-ranking: a refresh is a
*job*, not an initiation, so proactive stays OFF); then **content radar** and **signals-home
(ORB-177)** as scheduled slots under rule 2.2; then **sub-project 8**'s config.

## Non-goals

Approval gating is a **different contract** — a gate answers "may I *do* this", this one "may I
*speak*". Tone and voice. Model selection. Spend caps (the gateway budget, ORB-212).

## Decisions (the owner, 2026-09-04) — the six defaults, accepted; question 5 replaced

1. **Saga's quiet hours: 21:00–07:00 Oslo.** The briefs already sit inside it, so nothing changes today.
2. **The event ceiling: 10 per door per day**, rolling over into the next slot, never dropped.
3. **A deadline earns an interrupt once, inside 48 hours, statutory deadlines only** — the only
   misses that end in penalties.
4. **DND does not suppress the "I stopped" line** — it queues to the next slot.
5. **One owner clock for the whole fleet**, not "Marcel on the trip clock, Saga on Oslo": resolved
   trip itinerary → calendar travel events → Slack profile timezone → home (§3, Travel). Work travel
   moves every agent; the briefs follow the owner.
6. **Ceiling per (owner, door), plus a global per-owner 15** — otherwise adding a door quietly adds
   noise.

Every knob above gets a console surface as it is built (Lares is for non-technical owners; the
command line is plumbing). Implementation is its own plan; the first consumers are ORB-180's
ladder and ORB-214 item 1.
