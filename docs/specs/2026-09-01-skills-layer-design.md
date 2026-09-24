# The skills layer — design

**Date:** 2026-09-01
**Status:** **REVIEWED & RESOLVED** (the owner, 2026-09-01). ORB-145's plan may consume it.
**Ticket:** ORB-192. **Blocks:** ORB-145 (role templates).
**Related:** the engine/overlay inventory (which found `commercial` declared at the wrong
altitude), the Lares parent spec, memory `project_fleet_skills_third_layer`.

## Why this exists

Three facts point at one missing definition:

1. **Nora and Tyche were "folded in as skills"** of a layer that formally does not exist —
   yet the fold worked: `services/eve-saga/agent/skills/sales-outreach.md` is live and carries
   Nora's whole loop.
2. **The inventory found `commercial` is a skill declared as a capability** — code that composes
   `twenty` + `orakel` + the gateway and adds a policy.
3. **ORB-145's role templates must say what a role may compose**, which is impossible while
   "compose" has no defined unit.

## The finding that shapes everything: the layer already exists, at three altitudes

The fleet is not missing a skills mechanism. It is running **three**, one of them undeclared:

| Altitude | What it is | Live example | Declared? |
| --- | --- | --- | --- |
| **Capability** | a grant that resolves to tools at build time | `gmail`, `travel` (ORB-144) | yes — `agent.json` |
| **Code skill** | a TOOL whose implementation composes other capabilities' libraries under a policy | `commercial_who_to_contact` — composes Twenty + Orakel + LLM, enforces the full-contact-dump guard ("the model never sees the raw Twenty dump") | **no — masquerades as a capability** |
| **Instruction skill** | a markdown playbook (eve-native) that composes TOOLS at runtime, with a trigger description | `agent/skills/sales-outreach.md` — research → do-not-contact check → draft in voice → approval card → send → `outreach_track` | yes — eve's own skills dir |

So the spec's job is not invention. It is: name the three altitudes, state the rule for choosing
between them, and fix the one mislabel.

## The definitions

**A capability** answers *"what may this agent touch?"* It is a grant, it resolves to tools, and
it is the unit of least privilege. Vendor-bound capabilities are adapters (inventory spec).

**A skill** answers *"how does this agent do a job?"* It composes capabilities the agent already
holds. **A skill can never widen access** — it can only sequence, constrain, and add policy on
top of what the grants allow. This is the load-bearing property: reading a skill tells you HOW,
reading the grants tells you WHAT AT MOST.

**A role** (ORB-145) answers *"what is this agent for?"* — duties, judgement, refusals. A role
template names the skills it comes with and the capabilities those skills need; the agent's
actual grants stay the installation's decision.

## The rule for choosing an altitude

- **Instruction skill by default.** If the job is a sequence of existing tool calls with
  judgement between them — sales outreach is exactly this — it is markdown. Cheap to write,
  legible to the owner, editable without a rebuild, and eve already loads it by trigger
  description.
- **Code skill only when the policy must be ENFORCED, not requested.** `commercial` is code
  because its policy is a guard — the model must never see the raw contact dump, and a prompt
  cannot guarantee a negative. The test: *if the model ignored the instructions, would something
  unacceptable happen?* Yes → code. No → markdown.
- **Never a new capability for a composition.** A new capability is only for a new thing to
  touch. `commercial` touching only Twenty+Orakel+LLM should never have been a grant.

## What changes concretely

1. **`commercial` is re-declared as a code skill.** The tool stays exactly as it is (its guard is
   the reason it is code); what changes is the declaration: it stops being a `capability` in
   `agent.json` grants and becomes a skill entry that *requires* `twenty:read` + `orakel:read`.
   The declaration change is the whole migration — no behaviour change, provable by the
   byte-identical tool list.
2. **`agent.json` gains a `skills` key** (or adopts eve's convention if it has one): the code
   skills an agent carries, each naming its required capabilities, checked at build time — a
   skill whose requirements exceed the agent's grants fails the build. This is the never-widen
   property made structural.
3. **Instruction skills stay eve-native files** — no new machinery — but gain the same lint the
   role templates get: an ENGINE instruction skill names no person, company, or vendor beyond
   the tools it calls (sales-outreach.md today names the owner's two mailboxes — that is overlay
   content in an engine-shaped file, and the split lands with the persona-format work, not
   before).
4. **Tyche's disposition (ORB-189) gets its vocabulary:** the signal engine, if folded, is a
   code skill (its edge logic is enforced math, not etiquette) with an instruction skill on top
   for the conversational surface. If parked, nothing is created.

## Worked examples (the two folds, restated in the layer's own terms)

- **sales-outreach** — instruction skill. Requires: `twenty:read` (do-not-contact check),
  `orakel:read` (research), `gmail:write-with-confirm` (draft+send behind the card),
  `outreach:write` (tracking), `voice:read`. Every requirement is already in Saga's grants;
  the skill widened nothing. ✓ the model case.
- **commercial** — code skill. Requires `twenty:read` + `orakel:read`. Policy enforced in code:
  capped, scored, top-8-per-brand output; `listPeople` reachable only through it. ✓ the
  enforcement case.

## For Lares

Skills are **engine** (the inventory's test: the mechanism names no one). Role templates ship
with their skills; an installation's agent gets a role's skills automatically but only the
capabilities its owner grants — a skill whose requirements are ungranted is visibly inert
("this agent has the sales-outreach skill but no CRM access"), never silently broken. The
contribution ladder applies to skills exactly as to adapters, with one addition to the
checklist: **a contributed skill must declare its required capabilities, and the build must
verify it calls nothing beyond them.**

## Open questions — ALL RESOLVED (the owner, 2026-09-01)

1. **`skills` lives in `agent.json`, beside `grants`.** One declaration file per agent stays the
   rule; the build-time requirement check slots into the same tooling as ORB-144's grants. If eve
   later ships a native convention, migration is mechanical.
2. **The sales-outreach mailbox references wait for the persona split** (ORB-145) — the
   structural fix is next anyway; a point-fix would be redone. Harmless until the file leaves
   this installation, which cannot happen before the split lands.
3. **Tyche folds as a Saga skill** (ORB-189): the signal engine as a code skill, a conversational
   instruction skill on top, proactive OFF until the proactivity contract (ORB-193) exists.

**Status change: this spec is no longer DRAFT — reviewed and resolved; ORB-145's plan may
consume it.**
