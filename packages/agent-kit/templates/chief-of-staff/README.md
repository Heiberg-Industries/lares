# chief-of-staff

The operating-side role, extracted from the fleet's daily driver (ORB-145 Phase 3, Task 8).
`role.md` is the engine text — generic, lint-enforced, naming no person, company, vendor, place
or language. `agent.json` is the declaration this role assumes: every capability at the scope
the role's prose relies on, every autonomy level at the safe baseline, egress sealed.

An installation uses it by pointing its own service at this `role.md` and supplying its own
`voice.md` overlay — the assembler (`bin/assemble-instructions.ts`) turns the service's own
`agent.json` + this role + that voice into `agent/persona.md`, and the "where I run"
section of the result is GENERATED from the declaration, never hand-written. That generation is
the point: the hand-written environment text this role replaced is what once made the agent deny
capabilities it actually held.

## What it is for

Running the operating side for one owner, across whatever doors the installation configures:

- **The inbox and the calendar.** Drafting and sending mail, creating and moving events, and
  treating an attendee list as outbound mail rather than metadata.
- **The people.** One lookup that answers everything held about a person — CRM record,
  relationship warmth, mail, meetings — reported per source rather than merged silently.
- **The stores.** A personal vault, a business knowledge store and a company registry, with the
  standing rule that a store answer only ever comes from a store call made in this turn.
- **The queue.** Reminders, the obligation radar, and the approval proposals waiting to be
  resolved — including closing what is already done, so a finished item stops resurfacing.
- **The briefings.** Scheduled passes the owner reads rather than asks for, and the discipline
  that a missing one is a fault to be reported, never an absence to be explained away.

It carries the `commercial` skill, which composes the CRM and the company registry at read
scope. A skill can never widen access, so that declaration adds nothing the grants do not
already give.

## Which grants the role text assumes by tool name

`role.md` is generic about people and places, but it is NOT generic about tools: one rule
instructs by name. Dropping that grant in step 1 of [the templates README](../README.md) would
leave the role telling the agent to call a tool it no longer has. **Since ORB-210 that fails the
assemble** — `assertRoleToolsAreDeployed` compares every tool the role text names against what the
agent actually ships, before anything is written. **Drop this grant and edit `role.md` in the same
change:**

| Grant | Tools `role.md` names |
| --- | --- |
| `read_url` | `read_url` |

Every other grant is described by behaviour rather than by tool name, so dropping one degrades the
role's prose gracefully — the generated "where I run" section simply stops naming those tools.

## Writes without a card

`digest`, `obligation` and `outreach` are granted at plain `write`. That scope carries **no
approval card and cannot carry one** — `assertClassMatchesScope` fails the build on an approval
under a `write` grant, so the `"gated"` beside each of them in `agent.json` is inert.

All three reach only the owner's own stores and the owner's own briefings: running a digest,
dismissing an item on the obligation radar, marking an outreach attempt. Nothing under them
sends mail, changes a calendar, writes the CRM or touches another person — those are the
`write-with-confirm` grants, and each of those does render a card. That split is the template's
one real safety property, so it is worth re-checking after any edit to the grant list.

`vault` is `write-with-confirm`, not plain `write`, even though its `facts` area also reaches only
the owner: `remember` still writes directly (ORB-278 step 1 — remembering a fact the owner just
said carries no decision worth interrupting him for), but `forget` always asks first — retiring a
fact is a delete by the permissions board's own policy, and no level set for `vault` loosens that.

## What it deliberately cannot do

- **No web browsing.** It reads a single pasted link's text through a sealed reader. It cannot
  search the web, follow links, or fetch anything it was not given.
- **No shell, no filesystem, no code editor, no sub-agents.** The sandbox denies all four; the
  role does not pretend otherwise, and does not narrate a denied built-in as an impossible task.
- **No unattended writes.** Every mail send, calendar change, CRM write and vault note renders
  an approval card and executes only on the owner's approval. Reminders and the internal bookkeeping
  writes are the deliberate exceptions — they reach nobody outside.
- **No speaking to customers.** It is not a product, never speaks as one, and never touches a
  customer-facing product repo.
- **No autonomy ratchet out of the box.** Every capability ships `gated`. Raising one is a
  decision an installation makes deliberately, on its own agent, never something inherited from
  this template.
