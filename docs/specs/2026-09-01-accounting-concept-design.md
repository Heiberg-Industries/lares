# The `accounting` concept — design

**Date:** 2026-09-01
**Status:** **REVIEWED & RESOLVED** (the owner, 2026-09-01) — both staged questions answered; the
v1 plan may be written. Direction is already his (Workstream E approved
2026-08-21; adapter framing and no-OCR ruled 2026-08-31/09-01); this document turns those rulings
into a buildable shape. Nothing new is decided in it.
**Ticket:** ORB-181. **Consumes rulings from:** the engine/overlay inventory (§ `accounting`),
the integration programme (§ Workstream E), `docs/research/2026-06-07-norwegian-smb-claude-stack.md`.

## What this is, in one paragraph

The fleet gains an `accounting` engine concept whose first adapter is **Fiken** — extracted from
what this build actually needs, never designed in the abstract. Saga (the CoS role) gets three
jobs: **route receipts into Fiken's own inbox** (Fiken extracts; we never OCR — the owner,
2026-09-01: *"Fiken has its own tool to extract receipts, the inbox, we don't need to replicate
this"*), **book and reconcile what Fiken extracted**, and **draft outgoing invoices end-to-end
except the send**. The bright line travels with the concept, not the adapter: *the agent records
what happened and never moves money* — so a future Tripletex adapter inherits it without
restating it.

## The bright line (concept policy, binding on every adapter)

| Allowed | Never |
| --- | --- |
| forward/upload a receipt into the vendor's inbox | pay anything |
| book/categorise what the vendor extracted, behind a card where it writes | initiate, approve or schedule a payment |
| draft an outgoing invoice; keep it in draft | send an invoice (the `gmail.draft=autonomous, gmail.send=never` shape) |
| record an incoming invoice as paid AFTER the bank shows it | mark anything paid ahead of the bank |
| flag what the vendor could not read, as a NAMED queue | let an unreadable item vanish (absent ≠ empty) |

Reversibility is the axis, not volume: everything in the left column is undoable in the vendor's
own UI.

## The contract, extracted from the v1 scope

The concept's verbs are exactly what the Fiken build needs — a later adapter fits them or grows
them deliberately (the demand-driven rule). Names are the concept's, not Fiken's:

```
accounting.inbox_submit(document)        → receipt/bilag into the vendor's extraction inbox
accounting.inbox_list()                  → what sits unprocessed / unmatched, incl. items the
                                           vendor could not read (surfaced, never dropped)
accounting.record_purchase(extracted)    → book an extracted purchase   [write-with-confirm]
accounting.draft_invoice(details)        → create draft                 [write-with-confirm]
accounting.list_open()                   → open invoices, both directions, with due dates
accounting.record_payment(ref, bankRef)  → record what the bank already did  [write-with-confirm]
```

Deliberately absent: `send_invoice`, `pay`, anything touching a bank. Their absence is the bright
line expressed as an API surface — an adapter has nowhere to put a send even if its vendor
supports one.

## The Fiken adapter (first, and the contract's source of truth)

- **API:** `api.fiken.no/api/v2`, personal API token (sanctioned), API module 99 NOK/mo, **single
  concurrent request** (a budgeted serial client, same shape as the Entur client's one-deadline
  budget), pagination max 100.
- **The inbox is Fiken's** (`kjøpsinnboks`): submission by its documented upload/mail-in path.
  The receipt-shaped Gmail that Saga's triage already recognises is the feed; forwarding is a
  `gmail` capability action the agent already has, gated as mail always is.
- **The three public Fiken MCP servers are all read-only** (verified in the June research) — they
  cover none of the write half, which is where the entire value is. Nothing to reuse there.
- **Live probe:** `packages/agent-kit/tests/live/fiken.live.mts` from day one, per the house rule
  and the contributed-adapter checklist — the reviewer of any future accounting adapter has never
  called that vendor's API, and neither had we until the probe existed.
- **Region:** `NO` declared (F2). Fiken is Norwegian; the adapter fails closed elsewhere.

## Where the deadline primitive touches this (and only touches)

`accounting.list_open()` exposes due dates. The **deadline primitive (ORB-180)** consumes them as
one of its sources; this concept does NOT own deadlines, escalation, or the brief's rendering of
them. One-way dependency, no cycle: accounting exposes facts, deadlines owns urgency.

## For ORB-145 — how "accountant" stops being invention

The inventory ruled the accountant role template speculative because no working agent backed it.
This build creates the backing: the role template is **extracted from whatever judgement ends up
in Saga's accounting skill** (an instruction skill per the skills-layer draft — the sequences and
etiquette — over these code-backed tools), the same extraction path as CoS-from-Saga. Until this
ships, ORB-145 ships three templates, not four.

## Verification (the plan must carry these)

- Live probe committed and named in the definition of done.
- A real receipt forwarded → appears in Fiken's inbox → booked behind a card → visible in Fiken's
  UI, undone in Fiken's UI (reversibility demonstrated, not asserted).
- A deliberately unreadable item → appears in the named unprocessed queue, never silence.
- The absence tests: no tool named send/pay exists on any surface (`/eve/v1/info` list asserted).

## Open for the owner's review

1. ~~Which mailbox feeds receipts~~ **Resolved (the owner, 2026-09-01): `billing@example.org`** — a
   dedicated billing address, not his personal mailboxes. **New v1 prerequisite discovered by the
   answer:** that mailbox is not in the current Google-connector enrollment set (which holds
   owner@example.org and owner@project.example), so v1's plan must verify whether billing@ is its own
   mailbox needing enrollment or an alias arriving in an already-enrolled inbox — and gate the
   Gmail-forwarding leg on that answer.
2. ~~Invoicing in v1?~~ **Resolved (the owner, 2026-09-01): receipts-only v1** — prove the
   reversible high-volume loop on real receipts first; invoice drafting joins after the first
   weeks of real filings. The concept contract stays as written (it covers both); the v1 plan
   simply stages `draft_invoice` behind the proven filing loop.
