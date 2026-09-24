# ADR 0014 — Every proactive message passes one gate, on the owner's clock, and the gate keeps the receipts

**Date:** 2026-09-08
**Status:** Accepted
**Supersedes:** —
**Superseded by:** —

## Context

A *proactive* message is one an agent sends without being asked — a morning brief, a flight-delay
card, a nudge about an email nobody answered. A reply to something the owner said is not proactive, and
nothing in this ADR touches replies.

Three facts have already been paid for, and each was decided per-feature until now:

- **Tyche was paused for spam.** The diagnosis is precise: not proactive messaging, but proactive
  messaging *on model-judged importance*. A model may rank; it may never ring the phone.
- **Marcel posted roughly fourteen times before one trip**, from a seven-day window, until ORB-125
  cut it to two named slots. A window has no ceiling; a named slot list is one.
- **The briefs earn their keep**, because they are named slots that stay silent when there is nothing
  to say. Silence is correct output.

Until ORB-193 the quietness rules lived wherever they were first needed, and each copy was weaker
than it looked. The re-ping nudge kept its own count of "three per day" **in memory**, so it reset on
every container restart, applied to that one lane, and was invisible to anything else that might be
ringing the same phone at the same hour. Marcel had a 22:00 rule of its own. Saga had none at all —
her slots simply happened to fall in daylight. Nothing anywhere could answer "how many times did the
fleet interrupt him today", and nothing could be turned off without editing code.

The second half of the problem is the clock. Quiet hours are worthless on the wrong clock: a window
that opens at 07:00 Oslo opens at 03:00 for someone standing in New York. This has cost real
messages already — ORB-124/128 read the date off one clock and the time off another, and ORB-204
fired a checkout at 09:00 New York while the owner was in the air. So "which timezone is the owner in"
had to become one answer that every agent reads, not a constant copied into each schedule.

The design is `docs/superpowers/specs/2026-09-03-proactivity-contract-design.md`, decided by the owner
on 2026-09-04 (six defaults accepted; one owner clock for the whole fleet). The implementation is
`docs/superpowers/plans/2026-09-08-orb-193-proactivity-gate.md` (ORB-193). This ADR is the standing
contract those two produced. It extends ADR-0009 (the shared agent substrate) with the rule for when
that substrate is allowed to speak, and applies ADR-0012 §4's "one owner per incident" to agents.

## Decision

1. **One gate, and a schedule may speak only through it.** Every proactive send in the fleet passes
   `gateInitiation` / `gatedSend` in `packages/agent-kit/src/proactivity.ts`, reached through the
   service's own one-line seam — `services/eve-saga/lib/initiation.ts` and
   `services/eve-marcel/lib/initiation.ts`, both exporting `initiate()`. A schedule that calls a
   channel directly is a bug, whatever its own logic says. Three things are deliberately **not**
   initiations: a reply to a person (including an on-demand `digest_run`); an **edit** of a
   message already sent — Marcel's live flight card is edited in place precisely so it interrupts
   once (ORB-130); and the **meeting-followup receipt**, the "what I did" line posted after an
   autonomous send. That last one is ungated by design and the reason is narrow: the send it reports
   passed the gate moments earlier in the same lane, so gating the receipt could only ever produce a
   mail the owner was never told about — the worst outcome available. It is a receipt, not an
   interruption (`agent/schedules/meeting-followup.ts` says so at its `callSlackApi` call).

2. **Three classes of initiation, each with a durable item key.** `scheduled` (a named slot: the
   briefs, the digest, reminders, Marcel's lifecycle posts) keyed by its slot; `event` (a thing
   happened: a mail worth a ping, a proposal, a meeting follow-up) keyed by the durable id of the
   thing; `escalation` (a repeat about something still unanswered) keyed with its rung number, so a
   genuinely new bump earns one more message and a re-run of the same bump does not.

3. **The rule order is the contract, not an implementation detail:** DND → already-seen → quiet hours
   → ceilings → send. DND is first because it is the owner's own switch. Already-seen is second
   because a duplicate is the one thing no later rule can undo. Quiet hours come before the ceilings
   so a night-time item is held to the morning rather than to an abstract "next day".

4. **Quiet hours: 21:00–07:00 by default, on the owner's clock, movable but never removable.**
   - A **scheduled** slot inside quiet hours is **suppressed — dropped for good**, never caught up.
     Marcel's rule generalised: last night's "here is tomorrow's plan" at breakfast is worse than no
     post.
   - An **event** or **escalation** inside quiet hours is **deferred to the next quiet end** and
     lands then.
   - A configured window shorter than **8 hours** is refused and the **engine window 21:00–07:00 is
     used wholesale** — not the owner's start with the end pushed out, which would turn 05:00–06:00
     into 05:00–13:00 and silence the whole morning.
   - A malformed time falls back to the engine value **with a warning**, at three independent layers:
     a `CHECK` constraint in `services/agent-box/sql/035_proactivity.sql`, `loadSettings` on read,
     and `isWithinQuietHours` at decision time. Three, because the unsafe reading of a typo is "no
     quiet hours at any hour of the day".

5. **`ownerSetTime` means quiet-hours exempt, and it has exactly two justifications:** an owner-set
   time (a reminder — the owner's own booking chose the hour) or a safety-critical alert (a flight
   cancellation). **DND still suppresses both.** For Marcel's cancellation that suppression is
   **terminal**, and the ADR says so plainly: by the time the alert is offered, `diffFlightState` has
   already written `cancelled: true` into `flight-state.json`, so the alert is never generated again.
   A hold would not be a delay; it would be silence about a cancelled flight.

6. **Two daily ceilings, separate budgets, lower-only.** Per (owner, door) per owner-day: **20**
   events and **3** escalations, counted separately so a chatty day of events cannot spend the
   escalation budget — which exists precisely for the item nothing has answered. Plus **30** per
   owner per day across every door and agent, so adding a door does not quietly add noise. Over a
   ceiling the item is **deferred to the next owner-day**, never dropped. **Scheduled slots never
   count against a ceiling** — they are bounded by the slot list. Settings may only **lower** a
   ceiling; a stored value above the engine number is clamped on every read.

7. **Already-seen means HANDLED, not held.** A `sent` row for this item key proves the owner was
   told, on this tick or an earlier one. The lane therefore does its post-send bookkeeping — mark the
   reminder delivered, stamp `announced_at`, write `markReplied` — exactly as after a real send, and
   **never re-sends**. Reading it as "held" is what made three lanes re-detect, and twice re-*bill*,
   the same item on every tick forever; `InitiationOutcome.handled` is the single flag every lane
   branches on. **The gate is not a lock:** two turns gating the same item in the same moment may both
   be told to send. A rare duplicate beats an item lost for good, and already-seen holds for every
   later tick, which is where duplicates would otherwise compound.

8. **The `sent` row is written only after a confirmed send** — hence a `confirm()` handed back rather
   than a row written up front. Recording before a send that then fails drops the item permanently.
   Suppressions and deferrals **are** recorded at decision time: they are the audit trail the console
   shows.

9. **The ledger grows per held item, not per tick.** Most gating surfaces are pollers (Marcel ticks
   every minute), so a row per call would be ~1,440 rows a day for one item. An **open deferral** is
   reused — one row per hold — and a **same-day `dnd` or `quiet-hours` suppression** is reused — one
   row per item per owner-day. Both **re-decide first and only then reuse**, so the reuse is never a
   cached verdict and DND switched off releases the item on the very next tick. An `already-seen`
   suppression still writes per call: it is terminal, reached at most once per item per surface, and
   its row is the plainest audit line the console has. On Marcel's side the mirror rule is: a
   **suppressed** scheduled post **keeps** its `sent.json` mark (it is dropped for good, and keeping
   the mark is what stops the schedule re-offering it every minute), and only a **deferral** unmarks.

10. **The gate fails open, and can only ever hold back more than before.** An unreachable or broken
    ledger logs a warning that names the consequence and returns **send**: a missed suppression is an
    annoyance, a silent stop is the ORB-179 shape (the digest ran nowhere for ten days and everything
    looked healthy). `confirm()` never throws. The one thing the gate will not do is **invent** a DND —
    DND is off only because a read succeeded and found no row.

    The gate is a filter, but it is **not only** a filter, and one lane proves it: **re-ping now sends
    one message per thread instead of one batched message** (rule 6 is what bounds it — 3 escalations
    per door per owner-day, where the old in-memory cap sliced the batch to three THREADS in a single
    message). So on a day with three dropped balls the fleet sends three messages where it used to
    send one. That is the intended trade — the engine can only count what it sees one message at a
    time — but "the gate can never cause a message that would not otherwise have been sent" is false,
    and was worth correcting rather than repeating.

11. **One owner clock for the whole fleet**, resolved in a fixed order by
    `packages/agent-kit/src/owner-clock.ts`: **trip** (Marcel's `config.json` date window, in the
    trip's own timezone — the strongest signal, because a human declared it in advance) → **Slack
    profile** (believed only while **≤ 24 h old**; refreshed every 30 minutes by Saga's
    `agent/schedules/owner-clock.ts` via one `users.info` call) → **home** (`OWNER_HOME_TZ`, default
    `Europe/Oslo`). Calendar travel events are **deferred** to a follow-up. Every Saga slot schedule
    computes its slot on this clock, and date and time always come off the *same* clock. On an Oslo
    day nothing changes.

12. **What an installation may configure, on the console at `/proactivity`:** do-not-disturb globally
    and per agent; quiet hours per **real door id** (`telegram:<chatId>`, `slack:<channelId>` — a row
    saved as the bare word `telegram` would match nothing and be a knob that does nothing); and the
    three ceilings, **lower only**. **What it may not:** raise a ceiling above the engine number,
    remove quiet hours, or bypass the gate. The console **mirrors** the engine numbers rather than
    importing the kit — a deliberate two-place truth, named here as a known cost; the mirror is
    arranged so a drift shows up as a console refusing a number the fleet would accept, never as a
    console accepting one the fleet silently clamps, and a test reads the kit's source as text and
    fails on any disagreement (`services/console/tests/engine-drift.test.ts`). The console also
    **re-validates what is stored** on every read, through the same rules the kit applies, and shows
    the effective value annotated with the stored one — so a row edited in SQL cannot make the page
    confidently print a number the fleet is overriding.

13. **Quiet is allowed; silent about being quiet is not.** The morning brief carries one line naming
    what the gate held back since the previous brief (`heldBackLine`, counted once per item per door),
    and the console's `/proactivity` page shows today's decisions per door and the last fifty ledger
    rows.

14. **One owner per fact.** Where two agents can see the same fact, one owns telling him — ADR-0012
    §4 applied to agents. This is a documentation rule today, enforced by nothing, because no two
    agents currently see one fact.

## Consequences

**Positive:**

- Every quietness knob is in one place, durable, shared across lanes and doors, and visible: the
  `initiations` table answers "how many times did the fleet interrupt him today, and what did it hold
  back", which nothing could answer before.
- Turning the fleet quiet is now a switch on a web page, not a code edit and a deploy.
- The re-ping cap survives a restart, and applies across every lane rather than the one that owned it.
- ORB-180's deadline ladder and ORB-45's nudge are unblocked: both needed a ceiling and a rung
  counter that were not theirs to invent.
- Quiet hours now mean something on a trip, because the clock follows the owner.

**Negative / accepted trade-offs:**

- **A rare duplicate is possible**, by design (rule 7). The gate is not a lock, and the alternative
  trade — never sending twice, at the price of occasionally losing an item — is the worse one.
- **A dead database sends everything** (rule 10). Under a Postgres outage the fleet behaves as it did
  before this ticket: no quiet hours, no DND, no ceilings, no dedupe. Chosen deliberately over the
  silent-stop failure.
- **Two engine-number truths**, kit and console (rule 12), until the console can depend on the kit.
- **A one-day edge on a departure day.** The owner clock switches to the destination when Marcel's
  trip window says so, which can be a day before Marcel's own booking-derived arrival logic — the
  day the owner is in the air. The spec chose the trip as the strongest signal; this is the cost.
- **Up to ~35 minutes of lag on an unfiled timezone change**, from the 30-minute Slack refresh plus
  the resolver's 5-minute cache. Worst case, one slot fires on the previous clock, once.
- **Between 21:00 and 22:00 Marcel's own rule and the gate's window disagree**, so a lifecycle post
  already an hour late in that hour is suppressed for good. The slot itself is unaffected.

## Operational rules

- **Do** send every proactive message through `initiate()`. A new schedule that calls a channel
  directly is a review failure, not a style preference.
- **Do** branch bookkeeping on `handled` (`sent || alreadySeen`), never on "did it send". A lane that
  treats already-seen as a hold will re-detect — and possibly re-bill — the same item forever.
- **Do** give every new knob a console surface as it is built (the Lares working agreement). The only
  env-only knob this contract introduces is `OWNER_HOME_TZ`, and the console shows it read-only.
- **Do** ship a new schedule with its ORB-175 heartbeat row in the same migration —
  `saga/owner-clock` is seeded by `sql/035_proactivity.sql` and listed in
  `docs/runbooks/box-alerting.md`'s schedule table.
- **Don't** add a per-lane cap, counter, or quiet rule beside the gate's. A local copy can only ever
  disagree with the shared one, and that is the exact defect ORB-193 retired.
- **Don't** let a model decide whether to interrupt. A model may rank and may write; the decision to
  ring the phone is a mechanical fact check (inside the window, nothing acknowledged it).
- **Don't** raise a ceiling by editing settings — it is clamped on read and refused on write. Raising
  the engine numbers is an ADR change, not a configuration change.

## Open questions

Each of these is a known gap, filed here rather than left to be discovered:

- **`until_at` is advisory: nothing wakes a held item.** A deferral is reconsidered on the surface's
  next tick, which is fine for a poller and useless for a slot-only surface. A slot-only lane that
  ever needs a hold released will need a sweeper.
- **A settings change does not shorten an existing hold.** Widening quiet hours or raising a ceiling
  releases the item only when the recorded `until_at` passes. Resolved when the sweeper above exists,
  or by invalidating open holds on a settings write.
- **`email-triage` v1 has no "ping withheld" marker, so a held ping is LOST, not re-attempted.** By
  the time the gate is asked, `recordOutcome` has already written `drafted` for that message, and the
  next tick's `claim` will not claim a message with an outcome — so nothing ever asks the gate about
  that ping again. The work is not lost (the draft is sitting in Gmail and the outcome row records it
  truthfully) and the fact is not hidden (the morning brief's held-back line names it), but the ping
  itself is gone: he is told once, in the brief, rather than pinged when the window opens. Resolved by
  a "notified" column the poll can re-read.
- **`heldBackLine` reports deferrals only.** A full DND day suppresses everything, including the brief
  that would have reported it — so a DND day is quiet about being quiet by construction. Resolved by
  reporting suppressions on the first brief after DND lifts.
- **The console mirrors the engine ceilings** rather than importing them (rule 12). Guarded by
  `services/console/tests/engine-drift.test.ts` for now; resolved when the console can depend on
  `@lares/agent-kit`.
- **Marcel's `makeCachedOwnerClock` duplicates Saga's.** An obvious kit candidate; left duplicated
  because the two services were wired in the same pass and a shared version was not yet proven.
- **"One owner per fact" is a documentation rule** (rule 14), enforced by nothing. Resolved the first
  time two agents can see one fact — that is when it needs code.
- **Calendar travel as an owner-clock source** was deferred (plan Ruling 2). A work trip that is not a
  Marcel trip, and where Slack has not yet updated the profile, falls back to home until Slack
  catches up.

## Amendment 2026-09-08 (evening) — event ceiling 10 → 20, owner ceiling 15 → 30

Measured on the box before the first deploy: drafted-reply pings on the Slack door reached 8 per day
on Sep 7 and Sep 8, and the same door carries meeting follow-ups and CRM proposals, so the spec's
10 events per door per day was within one busy day's reach — and for email-triage a held-back ping
is lost, not retried. the owner raised the engine defaults the same evening: **20 events per door per
day** and **30 per owner per day** (the owner ceiling moves with it so it does not become the
binding limit at 20 per door). Escalations stay at 3. Settings can still only lower these; the
console shows the engine maxima. The spec (`2026-09-03-proactivity-contract-design.md` §6) and the
plan header keep their original numbers as the record of what was first decided.

## Amendment 2026-09-18 — the two-lanes-bill-a-model gap is closed (LAR-35)

The Open questions entry "Two lanes bill a model on every retry of a held item" is resolved, by
moving the gate ahead of the billed call in both lanes rather than caching what the call produced:

- **`outreach-reply-watch`** (LAR-35-s1) rewrote `onReply` around one `gate(...)` call whose
  callback is the classify, the draft (positive/meeting-request only) and the send — so a held or
  suppressed verdict now means neither billed call ever runs, not merely that their result is
  discarded.
- **`meeting-followup`** (LAR-35-s3) added an optional `FollowupDeps.precheck`, asked right after
  the claim/recipients check and before `compose`. The live wiring (`makeLivePrecheck`) answers it
  with the kit's `wouldSend` (via Saga's `wouldInitiate` — packages/agent-kit/src/proactivity.ts,
  services/chief-of-staff/lib/initiation.ts), which records a hold exactly like the real gate but
  never a `sent` row. A held precheck releases the claim immediately, so it costs no attempt and no
  compose call; the real send-turn gate still lives inside `makeLiveSend`, asked under the identical
  `meeting-followup/<pageId>#<attempt>` key (`meetingFollowupItemKey`, shared rather than restated)
  so the two are provably asking about the same row.

