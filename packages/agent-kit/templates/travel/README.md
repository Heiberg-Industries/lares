# travel

The trip-concierge role, extracted from the fleet's production travel agent (ORB-145 Phase 3,
Task 9). `role.md` is the engine text — generic, lint-enforced, naming no person, company,
vendor, place or language. `agent.json` is the declaration this role assumes: every capability at
the scope the role's prose relies on, every autonomy level at the safe baseline, egress sealed.

An installation uses it by pointing its own service at this `role.md` and supplying its own
`voice.md` overlay — the assembler (`bin/assemble-instructions.ts`) turns the service's own
`agent.json` + this role + that voice into `agent/persona.md`, and the "where I run" section
of the result is GENERATED from the declaration, never hand-written.

This role's voice overlay carries far more weight than most. The agent it was extracted from is a
character — a concierge on the trip *with* the group, in their own language, with a national
accent that is a feature rather than a leak. None of that is in here, and none of it should be:
everything below is what the role *does*.

## What it is for

Running the practical side of one trip, for the people in whatever chat the agent answers in:

- **Places and directions.** Every named place comes back as a real tool hit with a real map
  link, never an invented one, with the freshest shared position as the origin so distances and
  ETAs are true.
- **Routes.** Running and cycling routes taken from where locals actually go, matched to the
  owner's own distance and pace, before anything a general search would offer.
- **The trip's own state.** The itinerary, the bookings, the shopping list and what has been
  learned about the group are supplied to the agent every turn — so the role's standing rule is
  that it reads them rather than asking for what it already has.
- **The shopping list.** Added to and removed from as the conversation mentions things, and
  brought up unprompted when that is useful.
- **The things that already happen.** Flight watching, travel-mail filing and the evening update
  run on their own schedules; the role says so plainly instead of offering to do them by hand.

It declares eve's `web_search` in `framework_tools`, because the agent it was extracted from
keeps that framework tool enabled — the generated environment section says so, and two of the
role's own rules (climbing routes; never a web search while the route service still has
something) depend on it being true.

## Which grants the role text assumes by tool name

`role.md` is generic about people and places, but it is NOT generic about tools: it instructs by
name. Dropping one of these grants in step 1 of [the templates README](../README.md) would leave
the role telling the agent to call a tool it no longer has. **Since ORB-210 that fails the
assemble** — `assertRoleToolsAreDeployed` compares every tool the role text names against what the
agent actually ships, before anything is written. **Drop one of these and edit `role.md` in the
same change:**

| Grant | Tools `role.md` names |
| --- | --- |
| `places` | `place_link`, `nearby_places` |
| `strava` | `strava_routes` |
| `shopping` | `shopping_add`, `shopping_remove` |
| `admin` | `info` |

The other grants (`calendar`, `travel`, `vault`, `persona`, `currency`, `read_url`, `transit`)
are described by behaviour rather than by tool name, so dropping one degrades the role's prose
gracefully — the generated "where I run" section simply stops naming those tools.

## Writes without a card

`shopping`, `vault`, `persona`, `admin` and `travel` are granted at plain `write`. That scope
carries **no approval card and cannot carry one** — `assertClassMatchesScope` fails the build on
an approval under a `write` grant, so the `"gated"` beside each of them in `agent.json` is inert.
Two of those reach beyond the agent's own box:

- **`travel`** posts into whatever group chat the installation configures — the trip update, the
  link drop, the pre-departure pack. Other people read these, unprompted, with no approval card first.
- **`admin`** includes a kill switch (`toggle_kill_switch`) and the trip's own reference card.

`shopping`, `vault` and `persona` write only the agent's own stores — and `vault` only its
`facts` area, the standing facts, which is the one area this role is granted. If an
installation wants a
card in front of the group-chat writes, the change is `travel` → `write-with-confirm` in its own
`agent.json` **and** an approval on the tools; the template does not ship it, because the role it
was extracted from is a conversation in that chat, where a card on every message is noise.

## What it deliberately cannot do

- **No private or shared vault area.** `vault` is granted for the `facts` area alone — standing
  facts told to it, never a notes store to search, read or write. A trip's own folder is the only
  store it has, and the role says so in as many words.
- **No shell, no filesystem, no code editor, no sub-agents, no browser.** The sandbox denies all
  of them. It reads a pasted link's text through a sealed reader and searches the web through the
  framework's own tool; it browses nothing.
- **No map cards, no photo tool.** A recommendation is always text with a link.
- **No invented anything.** Not a place, a rating, a map link, a route, a forecast, a booking, a
  price, a time or an address. If a tool did not return it, it is not real — and the role says
  plainly when it does not know rather than guessing.
- **No autonomy ratchet out of the box.** Every capability ships `gated`. Walking one up is a
  decision an installation makes deliberately, on its own agent, never something inherited from
  this template.
