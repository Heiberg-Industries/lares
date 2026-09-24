# creative

The creative-director role, extracted from the fleet's production ideation agent (ORB-145
Phase 3, Task 10). `role.md` is the engine text — generic, lint-enforced, naming no person,
company, vendor, place or language. `agent.json` is the declaration this role assumes: every
capability at the scope the role's prose relies on, every autonomy level at the safe baseline,
egress sealed.

An installation uses it by pointing its own service at this `role.md` and supplying its own
`voice.md` overlay — the assembler (`bin/assemble-instructions.ts`) turns the service's own
`agent.json` + this role + that voice into `agent/persona.md`, and the "where I run"
section of the result is GENERATED from the declaration, never hand-written.

This is the first role whose `scope` is `org` rather than `personal`: one shared instance that
knows which member is talking, not one instance per member. That follows from what it grounds
on — the business knowledge store is the same store for everyone in the organisation, where a
personal vault is not.

The overlay carries two things this role deliberately refuses. One is the tone. The other is
every FACT about the owner's own ventures — which one has no note, which was renamed and when —
because the role's whole point is that there is no list of brands in it.

## What it is for

Running a codified creative team for one owner and presenting what it produces:

- **Ideation on a brief.** One expensive run — ground the brief in the business knowledge
  store, put it through several proposer lenses, score the results with critics — returning a
  spread of outliers alongside one deliberate conventional baseline.
- **Curation, never a single answer.** The spread is presented verbatim: nothing summarised,
  reordered, dropped, or picked as a favourite. The role offers the range; the owner chooses.
- **Running first rather than gatekeeping.** A terse brief is answered with a run and a stated
  assumption, not a clarifying question. Only a truly unparseable brief earns a question first.
- **Honest grounding.** The role never sees the store search itself — the studio does — so it
  relays the run's own grounding line as-is, and never claims the store came up empty unless
  that line says so.
- **Keeping an idea.** A result worth keeping can be proposed as a note in the business
  knowledge store, behind an approval card like every other write.

## Writes without a card

`studio` is granted at plain `write`. That scope carries **no approval card and cannot carry
one** — `assertClassMatchesScope` fails the build on an approval under a `write` grant, so the
`"studio": "gated"` in `agent.json` is inert, and the ideation run executes on the owner's word
alone.

That is the intended reading, not a gap: a `studio` run produces text in the same conversation
that asked for it. It reaches nobody else, writes no store, and sends nothing. The one write that
does leave a mark — proposing an idea as a note in the business knowledge store — is `vault`
(the `shared` area) at `write-with-confirm`, and it renders a card like every other store write.
(`role.md` names no tool directly, so no grant here is coupled to the role's prose the way
`travel`'s and `chief-of-staff`'s are.)

## What it deliberately cannot do

- **No private vault area.** `vault` is granted for the `shared` area alone: the owner's own
  notes are not an ideation agent's business. The business knowledge store is the only store it
  has.
- **No web browsing and no web search.** It declares no `framework_tools`, and the agent it was
  extracted from disables eve's `web_search` with a sentinel. Ideas are grounded in the store
  or they are the model's own.
- **No shell, no filesystem, no code editor, no sub-agents.** The sandbox denies all of them,
  and egress is sealed to the services its own tools are built for.
- **No hardcoded list of the owner's ventures.** That is the one thing the role text refuses on
  purpose: a fixed list made the agent confident about three brands and blank about the rest.
  Anything it must know by name goes in the installation's own `voice.md`.
- **No autonomy ratchet out of the box.** Both capabilities ship `gated`. The agent this was
  extracted from runs `studio` at `autonomous` — a deliberate walk-up made on that installation
  after its owner saw the first live card and found the gate carried no decision content. That
  is an installation's own decision about its own agent, never a property of this template.
