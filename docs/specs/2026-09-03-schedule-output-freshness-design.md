# A scheduled job that stops running must say so — output freshness for every schedule (ORB-175, DRAFT)

**Status:** DRAFT for the owner, 2026-09-03. The ticket asks for the inventory and the thresholds to
be agreed before anything is built; this is that inventory, with one mechanism proposed.

## The three incidents, and why "is the container up" cannot catch them

Conversation capture stopped for 6 days (container up, nothing written); the dream cycle reflected
on an empty directory for 6 days (container up, log line healthy); the digest ran nowhere for 10
days (container gone, no log at all). Kuma watches processes. What all three share is a durable
OUTPUT that stopped aging forward. `input-freshness.sh` already checks four such outputs on the box
(conversation capture, dream notes, reminders, the digest's heartbeat row since ORB-179) and pages
through its own Kuma monitor. The gap is that **nine of Saga's thirteen schedules leave no durable
trace on a quiet pass** — the briefs' correct silence and a missed slot are indistinguishable.

## One mechanism, not thirteen

Every schedule already ends its slot pass at a known line (`delivered (slot …)`, `nothing to say`,
`filed 0`). The proposal: **a `schedule_heartbeat` stamp at the end of every completed slot pass,
whether or not it produced a message** — the digest's `heartbeat('saga-digest')` row generalised
into a kit helper, `recordSchedulePass(db, "<agent>/<schedule>")`, called from each schedule's
pass-complete point (and from the shared schedule gate for the every-minute jobs, so a pass that
finds nothing still stamps). `input-freshness.sh` then gains one table-driven check per row below,
pushing through the SAME Kuma monitor it already has (Slack via Kuma's own notification — never
signal-spine), with the ORB-179 rule kept: **an absent row is stale, never fresh.**

Why a heartbeat rather than an artefact per job: five jobs have no artefact on a quiet pass by
design (a brief with nothing to say sends nothing; a triage tick with no mail claims nothing), and
inventing artefacts for them would change behaviour to make monitoring easier. The heartbeat
records the FACT that the slot ran; the existing artefact checks keep covering the jobs whose
output must exist (dream notes, capture).

## The inventory

| Schedule (eve-saga) | Cadence (Oslo) | Gate | Durable trace today | Proposed threshold | Covered by |
|---|---|---|---|---|---|
| morning-brief | daily 08:00 | `EVE_SCHEDULES_LIVE` | none on a quiet day | **26 h** | heartbeat |
| evening-brief | daily 20:00 | same | none on a quiet day | **26 h** | heartbeat |
| digest | 09:00 + 17:00 | `EVE_DIGEST_LIVE` | `heartbeat('saga-digest')` (ORB-179) | 20 h (as is) | exists |
| dream | daily 03:00 | `EVE_DREAM_LIVE` | `_meta/dream/<date>.md` | 30 h | artefact (exists) + heartbeat |
| voice-learn | Sundays 04:00 | same gate | newest `voice_exemplar` row | **8 days** | heartbeat |
| weekly-summary | Sundays (hour env) | same | a Slack message | **8 days** | heartbeat |
| crm-routing | 09 / 13 / 17 | `ROUTE_HOURS` | proposals rows when any | **20 h** | heartbeat |
| email-triage | every minute | claim table | claims only when mail arrives | **2 h** | heartbeat |
| meeting-followup | every 5 min | send-log | rows only when a meeting ends | **2 h** | heartbeat |
| outreach-reply-watch | every 15 min | — | none | **2 h** | heartbeat |
| proposals-watch | every minute | — | none | **2 h** | heartbeat |
| reminders | every minute | — | delivered reminders (overdue check exists) | **2 h** | heartbeat (+ existing) |
| reping | every 30 min | — | none on a quiet pass | **2 h** | heartbeat |

Marcel's trip-lifecycle (every minute, per-trip `sent.json`) and Calliope's schedules get the same
helper in a second step; their thresholds follow the same rule: **period + the slack the box's
Kuma rules require (≥ 2×)**, rounded to a number a human can defend at 03:00.

## Per installation, and the names (the owner's questions, 2026-09-04)

**Customisable for a Lares owner? Yes, without hand-tuning.** The inventory is engine-level. On
another installation the list of schedules comes from the role templates the owner picked, and
each threshold is DERIVED from the schedule's own cadence (period plus the 2× slack the Kuma rules
require), so a new or reconfigured schedule gets its check for free. What an owner turns is the
cadence itself — sub-project 8's console knobs — and the freshness check follows.

**The `EVE_` prefix is not necessary.** `EVE_SCHEDULES_LIVE`, `EVE_DIGEST_LIVE`, `EVE_DREAM_LIVE`
and the `eve-<agent>` service names are leftovers from the migration off the old runtime, kept so
the two eras could not be confused on the box. A Lares install names services after the agent and
shows the switches as plain settings in the console. Rename in one commit with the installer work
(ORB-197's step 2), not piecemeal now — every compose file, script and runbook names them.

## Proven by simulation, before it is called a guard

Set one gate to `0` on the box (`EVE_DREAM_LIVE=0` is the safest — the dream cycle's artefact
check already exists, so the heartbeat check is compared against a known-good sibling), wait past
the threshold, confirm the DOWN reaches #lares-alerts naming the schedule, flip the gate back,
confirm the UP. Record it in `docs/runbooks/box-alerting.md` beside ORB-179's paging proof.

## Acceptance (as the ticket lists it, made concrete)

- The table above, agreed (thresholds are the judgement call — say which you want moved).
- `recordSchedulePass` in agent-kit; every schedule in the table stamps on a completed pass; a
  test per schedule that a quiet pass stamps and a thrown pass does not.
- `input-freshness.sh` gains the checks, table-driven, absent-row-is-stale; the Kuma monitor is the
  existing one (no new monitor, no new alert path).
- One simulated outage paged; runbook section written.

## Decisions (the owner, 2026-09-04: "follow the recs")

1. **Briefs: 26 h.** One missed morning pages at 10:00 the next day; the evening brief's own stamp
   and the every-minute rows catch a dead container within 2 h anyway.
2. **Every completed tick stamps**, not only slot passes — one cheap upsert a minute, and "the
   process is alive but the schedule loop died" (the 2026-08-15 shape) is caught too.
3. **crm-routing: 20 h, not 12 h** (final review, 2026-09-04): the pass stamps only in a slot
   minute and the 09→17→09 overnight gap is 16 h; 12 h would page falsely every night. Same
   shape as the digest.

The table above is therefore agreed as written; implementation is its own small plan.

## Non-goals

Watching processes (Kuma does); changing what any schedule sends; a dashboard.
