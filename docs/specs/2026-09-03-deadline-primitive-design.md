# The deadline primitive — what the business owes institutions by a date (ORB-180, DRAFT)

**Status:** BUILT 2026-09-08 (plan `docs/superpowers/plans/2026-09-08-orb-180-deadlines-and-orb-214-market-refresh.md`;
ladder per the plan's Ruling 1, shipped OFF behind the console switch)

DRAFT NOTES, trimmed 2026-09-04 after the owner's read: **the accounting adapter is not a
dependency of v1** — "it might be over-engineering", and it is. Version one is the statutory rules
per company plus entries the owner adds by chat, with completion confirmed by the owner. The
escalation half follows `2026-09-03-proactivity-contract-design.md` §4 (accepted in principle
2026-09-04). Engine-core by the inventory's own test: nothing below names a person or a place.

## Why a third concept

The fleet models what the owner owes PEOPLE (obligations — a reply someone is waiting for) and
what the owner asked to be nudged about (reminders). Neither fits what the business owes an
INSTITUTION by a date: VAT terms, the annual accounts, the shareholder register filing, the annual
general meeting for each company, DPA/DPIA review dates, domain, certificate and insurance
renewals. Workstream B caught the misfiling live — a Fiken VAT reminder carried in the brief as an
*owed reply* — and this is the only miss category that ends in statutory penalties. Reusing
obligations would keep the misfiling; reusing reminders would lose the source, the consequence and
the verified completion that make a deadline different.

## The shape

A `deadline` is a row, not a note:

| Field | What it holds | Why it is a field |
|---|---|---|
| `entity` | which legal entity (an installation may hold several) | two companies, two filing calendars |
| `title` | what is due | rendered verbatim in the brief |
| `source` | `statutory` \| `accounting` (Fiken, ORB-181) \| `contract` \| `subscription` \| `manual` | the source decides how completion is VERIFIED |
| `due_at` | the date (and, if the source gives one, the hour) | the ladder counts from it |
| `recurrence` | none \| the rule that mints the next one (bi-monthly VAT, yearly filings, a renewal term) | a statutory deadline never happens once |
| `consequence` | one sentence: the fee, the penalty, the loss | the brief shows it beside the date; it is what makes the owner act |
| `evidence_rule` | what proves it done: a Fiken filing state, a receipt mail matching a pattern, a renewal confirmation, or "owner says so" | completion is verified, never assumed |
| `status` | `open` \| `done (evidence: …)` \| `dismissed (by owner, why)` | a dismissal is a fact with a reason, never silence |
| `rung` | where it is on the ladder, and when it last moved | the proactivity contract's ledger, per item |

## Sources, and how completion is verified

- **Statutory calendar per entity** — a seed list per jurisdiction (for a Norwegian AS: the VAT
  terms, the annual accounts, the shareholder register filing, the general meeting, the tax return;
  the exact dates are read from the authorities each year, never hard-coded — the seed carries the
  RULE, the year's dates are confirmed by the owner or the accounting adapter at minting time).
  Completion: the accounting adapter reports the filing, or the owner confirms.
- **Accounting adapter — LATER, not v1** (Fiken, ORB-181 stays parked): it would list what the
  ledger itself says is due and whether it is filed — a strong evidence rule — but it only earns its
  place if it proves a better source of "this was filed" than the owner saying so. The row shape
  above already has the `source` value for it; nothing in v1 waits for it. The receipts-only
  billing feed decided earlier is a separate thing and stays separate.
- **Contracts and subscriptions** — renewals with a term; completion is the renewal confirmation
  landing (a mail matching the vendor + date), else the owner.
- **Manual** — the owner adds one in chat; evidence rule "owner says so" unless they name a better one.

Nothing here reads a person's inbox for obligations; the sources are institutional, and the
misfiling fix is on the OTHER side: the obligation radar's selection rule excludes automated,
institutional senders whose subject carries a due date — those are deadline candidates, surfaced
to the owner as "is this a deadline?" once, never as an owed reply.

## Where it surfaces

- **The briefs** render deadlines as their own block ("Frister" / "Deadlines"), never inside the
  obligations delta: the next 30 days, closest first, with the consequence; a deadline inside its
  final window is listed first and marked. Silence when nothing is due — silence is correct output.
- **On request** — `deadline_list` (read), `deadline_add` and `deadline_dismiss` (writes, behind
  the approval card like reminders: adding a wrong date is harmless, dismissing a real one is not).
- **The ladder** — exactly the proactivity contract's §4: mentions ride the scheduled slots with
  geometric backoff (roughly T-16, T-8, T-4, T-2, T-1), then a reminder on the pinned door, then at
  most one interrupt inside the final window for a still-unacknowledged item, then it stops and
  says so once. A reply naming the item, a dismissal, or the evidence appearing resets it.

## What it deliberately is not

Not a task system (ORB-29); not a calendar event (a deadline is not a meeting, and putting it on
the calendar is a rendering choice the owner may make, not the primitive); not a CRM object.

## Acceptance

- The `deadlines` table and the three tools exist; the obligation radar excludes institutional
  due-date mail and files it as a deadline candidate instead (the Workstream B misfiling has a test).
- Statutory seeds for one jurisdiction, dates confirmed at minting, recurrence mints the next one.
- The brief block renders; the ladder is wired to the proactivity contract's gate — OFF until that
  contract is accepted, so the first release surfaces deadlines in briefs only.
- Completion in v1 is the owner's confirmation (or a matching receipt/renewal mail where the
  evidence rule names one); no accounting adapter is required for acceptance.

## Decisions (the owner, 2026-09-04)

Both entities seeded from day one (rules, dates confirmed per year); `deadline_add` ungated,
`deadline_dismiss` gated; renewals as manual entries now, an adapter later. Every surface here
gets a console view when the console work lands.

## The questions as they were asked

1. Which entities and which statutory rules seed the first list — both companies from day one?
   (Recommendation: yes, both; the seed is rules, the dates are confirmed per year.)
2. Should `deadline_add` be gated at all — it is the owner's own list? (Recommendation: ungated
   add, gated dismiss; a wrong add costs a line in the brief, a wrong dismiss costs a penalty.)
3. Do renewals (domains, certificates, insurance) start here or wait for a subscription source?
   (Recommendation: manual entries now, an adapter later — the primitive is the same.)

## Non-goals

Paying or filing anything (send/pay stayed out of the accounting contract on purpose); reading
statutory dates off the internet; escalation before ORB-193 is accepted.

## As built (2026-09-08)

**Six tools** (`services/eve-saga/agent/tools/deadline_*.ts`): `deadline_list` (read, ungated),
`deadline_add` (ungated — a wrong add costs one brief line), `deadline_mint_statutory` (gated —
mints a fiscal year's statutory rows onto one entity, the card lists every date), `deadline_done`
(gated — closes a row, mints the next occurrence for a recurring one), `deadline_dismiss` (gated —
closes a deadline or a mail-scanner candidate), `deadline_reset` (ungated — rung back to 0).

**Four tables**, all in `services/agent-box/sql/036_deadlines.sql`: `deadlines` (the standing
calendar), `deadline_candidates` (the mail scanner's sightings), `deadline_settings`
(`ladder_enabled`, one row per owner) and `markets_settings` (`refresh_enabled`,
`watchlist_max`) — the last two are the ONE switch each for the deadline ladder and the ORB-214
market refresh, both OFF by default so neither schedule changes behaviour on the day it landed.

**The candidate rule:** an institutional due-notice mail (`isInstitutionalDueNotice` in
`lib/brief-content.ts`) drops out of the obligation radar and becomes a candidate instead; at most
`CANDIDATE_LINES_MAX` (**5**) unsurfaced candidates ride one brief, oldest sighting first, and only
the ones actually rendered are stamped `surfaced_at` — on the initiation's `sent`, never merely
`handled`, so a failed stamp write re-offers rather than silently drops one.

**The ladder's day/hour table** (`ladderStep` in `packages/agent-kit/src/deadlines.ts`):

| Rung | When | Source | finalStop |
|---|---|---|---|
| 1 | 15:00 the day before | any | false |
| 2 | 09:00 on the day | statutory only | false |
| 3 | 09:00 the day after (first tick once overdue) | any | true |

A rung is never caught up (a deadline asleep through T-1 goes straight to the stop on T+1), which
is what makes the ladder idempotent under a schedule ticking every 30 minutes.

**What differs from the draft:**

- **Three fixed rungs, not "geometric backoff … then a reminder … then at most one interrupt."**
  The draft's `2026-09-03-proactivity-contract-design.md` §4 sketch (roughly T-16/T-8/T-4/T-2/T-1
  mentions, a reminder, then an interrupt) was replaced by the plan's Ruling 1: one day-before
  nudge, one due-day nudge for statutory rows only, one final stop — the brief's `MENTION_DAYS`
  (`[30, 16, 8, 4, 2, 1, 0]`) carries the "many mentions" job instead, so the ladder itself only
  needs to ring the three moments a reply is actually being asked for.
- **No owner-reply reset.** The draft implied a reply naming the item would reset the ladder; what
  shipped is `deadline_reset`, an explicit tool/console action ("Bring back") — nothing in the
  ladder itself watches for a reply.
- **No accounting adapter.** Confirmed non-goal, unchanged from the draft's own trim: `source`
  supports `"accounting"` in the type, but nothing produces or verifies one; completion in v1 is
  always the owner's confirmation.
