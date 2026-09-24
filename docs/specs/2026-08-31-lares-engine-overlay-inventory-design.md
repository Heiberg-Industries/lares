# Lares engine/overlay inventory — design

**Date:** 2026-08-31
**Status:** Direction approved in brainstorm (the owner, 2026-08-31). Feeds Lares sub-project 1
(engine extraction) and sub-project 2 (config-driven agents).
**Owner:** the owner
**Parent spec:** `docs/superpowers/specs/2026-08-17-shared-agent-stack-design.md`

## Why this exists

The Lares spec names this as an open question and flags it as unresolved:

> **Skills, hands, integrations, taste profiles — the full catalog.** What ships with the engine
> vs. what is overlay-specific? Which of the owner's hands are generic (calendar, email, CRM) vs.
> personal (taste profiles, Brain access)? Needs a deliberate inventory pass — this is flagged as
> NOT yet thought through.

Three separate pieces of work converged on it on 2026-08-31, which is what forced the pass:

- **Taste** (`ORB-97`) — ruled a Lares feature: *"any users of the stack can build their own
  taste-profile"*.
- **Tasks** (`ORB-29`) — ruled a Lares feature: *"a key component for my work, and should be part
  of Lares from day 1 as well."*
- **Role templates** (`ORB-145`) — which *is* the engine/overlay question applied to personas.

Answering these separately would have produced three different answers to one question. This spec
answers it once.

## The finding, up front

**There are no overlay capabilities.** All 30 capabilities declared across eve-saga, eve-marcel and
eve-calliope are engine — **21 core, 8 adapters**, and one that turned out not to be a capability
at all. **Overlay is data, credentials and configuration; it is not a bucket of capabilities.**

The first pass of this document classified six as overlay. the owner rejected that on 2026-08-31 and
he was right — see *"The six that were not overlay"* below. The correction matters for sequencing:
engine extraction's target is the **whole** capability set, not a subset, and there is no
the owner-only tail to carve out later.

## Part 1 — Capability classification

The unit of classification is the **capability**, not the tool. `agent.json` already declares
`grants: [{capability, scope}]` (shipped by `ORB-144`), so the inventory is data that already
exists rather than a taxonomy invented for this document. Tools resolve from capabilities at build
time.

Two buckets are not enough. "Engine vs overlay" cannot express the difference between *a calendar*
and *Google Calendar* — the first is universal, the second is a vendor binding a client may not
use. Hence three:

### Engine core — the mechanism ships, vendor-neutral (21)

`admin` · `atlas` · `autonomy` · `brain` · `currency` · `digest` · `echo` · `facts` · `identity` ·
`memory` · `network` · `obligation` · `outreach` · `person` · `persona` · `read_url` · `remind` ·
`shopping` · `studio` · `travel` · `voice`

These describe capabilities any installation would want, implemented against no particular vendor.

### Engine adapter — ships, but bound to a vendor or region the installation may not use (8)

| Capability | Bound to | The generic concept underneath |
| --- | --- | --- |
| `calendar` | Google Calendar | a calendar |
| `gmail` | Gmail | a mailbox |
| `notion` | Notion | a document/database store |
| `twenty` | Twenty | a CRM |
| `places` | Google Places | a place directory |
| `transit` | Entur (Norway) + Google | a journey planner |
| `strava` | Strava | an activity/training log |
| `orakel` | Orakel — **requires the user's own paid subscription** | a company-data source |

An adapter ships with the engine and is **selected**, not assumed. An installation with no CRM
grants no `twenty`; the capability simply is not in its `agent.json`.

**Adapters come in two commercial shapes**, and the distinction is new here:

- **Bring-your-own-credential** — the user supplies an API key or OAuth grant they already have or
  can get free (Google, Notion, Strava, Entur).
- **Bring-your-own-subscription** — the adapter ships, but is inert until the user is a **paying
  customer of that service**. `orakel` is the first of these (the owner, 2026-08-31).

The second shape has a consequence worth stating plainly: **Lares becomes a distribution channel
for Orakel.** Every installation is a potential Orakel customer and the adapter is the funnel. That
is a commercial argument for shipping the adapter, not merely a technical one — but it also means
the adapter must degrade gracefully and legibly for the majority who will not subscribe. It must
say *"not subscribed"*, never *"nothing found"*; those are different facts, and the same rule the
person-360 organisation stage already follows.

### One adapter is hiding a second concept: `notion` carries meeting transcripts

the owner uses Notion as the transcript source today, and other installations will use **their** tool
— Zoom, Google Meet, Teams, a note-taker. The `notion` adapter currently carries two distinct
concepts at once: a document/database store, and **the meeting-transcript source** (the Meetings
DB, notion-sync's attendee pass, and `ORB-156`'s follow-up schedule all read it as such).

The transcript source becomes its own engine concept — **`transcripts`** — with vendor adapters,
of which Notion is simply the first. The adapter contract is small and already implied by what the
fleet consumes: *list meetings, resolve attendees, fetch the transcript text*. Everything
downstream — the participants scope, follow-up drafting, summary derivation — works against that
contract and never against a vendor.

An installation whose meeting tool has no shipped adapter uses the private-integration route below:
an MCP server that speaks the same three-call contract.

(This makes the adapter count 9 once built; the table above lists what exists today.)

### `accounting` — the next concept, and the rule for all future ones

the owner uses Fiken; other installations use Tripletex, PowerOffice, Conta (decided 2026-08-31:
*"we need lares to be open for more tools… but we build the solution i (and other users) needs"*).
So **`accounting` is an engine concept whose first adapter is Fiken** — built as the integration
programme's Workstream E, then generalised, never the other way round.

Two things travel with the concept rather than the adapter:

- **The reversibility bright line is concept-level policy.** Receipts/bilag filing yes; outgoing
  invoicing except the send; incoming recorded, never paid — the agent records what happened and
  never moves money. A Tripletex adapter inherits this without restating it.
- **The contract is extracted from the Fiken build**, the way role templates are extracted from
  working agents. Whatever verbs Workstream E actually needs — file receipt, draft invoice, list
  open items, record payment — become the contract; a later adapter fits it or grows it
  deliberately.

**The general rule, stated once: concepts are demand-driven and adapters are extracted.** A
concept enters the engine only when a real installation needs it; the first real adapter defines
the contract; nothing speculative ships. What may ship ahead of demand is the *contract document*,
which costs nothing and lets a contributor start.

### The adapter ladder — private, contributed, shipped

Circle members build their own integrations and, when they are good, contribute them back
(the owner, 2026-08-31: *"thats the open source way, right? Even if this is not os"* — the open-source
**workflow** without the open-source **license**, i.e. inner source; the parent spec's contribution
agreement is the legal half and must exist before the first outside PR merges).

| Tier | Where it lives | Who maintains | Review |
| --- | --- | --- | --- |
| **Private** | outside the process, speaking MCP against the concept contract | the member | none — updates cannot kill it, it never enters the repo |
| **Contributed** | a PR adding an engine adapter | the member, then shared | **the owner + Claude, against the checklist below** |
| **Shipped** | merged into the engine | the project | ongoing |

A private integration graduates by PR; nothing requires it to. The MCP route (Part 4) is tier 1
of this ladder, not a separate mechanism.

**The contributed-adapter checklist** — not invented; each line is a rule this repo already paid
for:

1. **A committed live probe** — `<package>/tests/live/<api>.live.mts`, run by hand, named in the
   PR. A fixture is what we believe an API does; only a live call is what it does (root
   `CLAUDE.md`, § Third-party APIs — the ORB-168 lesson). A contributed adapter is precisely the
   case where the reviewer has never called the real API.
2. **A declared region**, failing closed outside it (F2 — the Entur geocoder scar). Mechanism
   since ORB-184: every `kind: "adapter"` entry in `packages/agent-kit/src/persona/capability-docs.ts`
   carries `region` — ISO 3166-1 alpha-3 `countries` with a `reason`, or `"global"` — enforced by
   `tests/capability-region.test.ts`; a tool checks its endpoint with `coversCountry(capability,
   countryA)`, where an unknown country reads as outside (never as a plausible local guess).
3. **Egress documented** — every host the adapter reaches, as proxy/squid allowlist entries. An
   undeclared host simply will not resolve from a sealed container, so this is enforced by the
   box, not by trust.
4. **Secrets by declaration only** — named secret files, no inline credentials, no new secret
   mechanisms.
5. **No telemetry** — the struck phone-home decision binds contributors too.
6. **Contract-compliance tests** against the concept's contract, so the engine can swap adapters
   in CI without vendor accounts.

### Not a capability — a skill (1)

`commercial` (`commercial_who_to_contact`) sits at a different altitude from everything above. It
**composes** other capabilities rather than providing one: it imports `listPeopleCapped` (Twenty),
`orakelSearch` (Orakel), `twentyCompanyForPerson`, `icpFor` and `gatewayComplete`, then applies a
policy on top. Its own header says so — it is *"THE gated surface `listPeople` is meant to be
reached through … the model never sees the raw Twenty dump, only `surfaceCommercial`'s scored,
filtered, top-8-per-brand output."*

That is a playbook over hands, which is the **skills layer** already parked as the fleet's planned
third layer. This inventory is the evidence that the layer exists in practice and is currently
being declared as if it were a capability.

**Consequence:** the engine needs the skills layer to be a real, separate concept before role
templates ship, or every composed playbook will keep arriving disguised as a capability and the
capability list will slowly stop meaning anything. The skills layer needs its own spec; this
document only establishes that it is not optional.

### The six that were not overlay

The first pass of this document classified six capabilities as overlay. the owner rejected that on
2026-08-31, and the code agrees with him in every case:

| Capability | First pass | Correct | Why |
| --- | --- | --- | --- |
| `strava` | overlay | **adapter** | any user connects their own account; the data is theirs, the adapter is generic |
| `orakel` | overlay | **adapter (paid)** | ships, gated on the user's own subscription |
| `shopping` | overlay | **engine core** | it imports `TripStore` and `resolveCurrentTrip` — a **trip** shopping list, not a family grocery list. Part of the travel family |
| `outreach` | overlay | **engine core** | misleadingly named. It imports only `getPool` and `outreach-store`: pure bookkeeping that records a sent thread for reply-watching. Nothing sales-specific in the mechanism |
| `network` | overlay | **engine core + per-source adapters** | the graph and warmth scoring are as generic as Brain; only the importers are bound (see below) |
| `commercial` | overlay | **a skill** | composes the above; see the section immediately preceding |

**The lesson for future classification:** "this is mine" is a statement about *data*, not about
*capability*. Every one of these six felt personal because the owner's instance of it is personal. The
test that actually discriminates is whether the **mechanism** names a person, a company or a place
— which is the same test the role-template lint applies to personas.

### `network` carries the legal weight

`network` ships as engine, but with two qualifications that no other capability has:

- **Its source adapters are individually optional and platform-bound.** The iMessage importer runs
  on macOS only; LinkedIn is an export, not an API. An installation may enable none of them and
  still have a working `network` capability fed by CRM alone.
- **It is the capability behind the agent-box GDPR exposure** — roughly 31k Meta DMs, flagged as
  needing a DPIA and a lawyer before scaling. For the owner's own installation that is an
  accepted, recorded risk. **For a managed client deployment on the owner's servers, the exposure
  transfers to him**, which the parent spec already flags under *"GDPR/DPIA for client
  deployments"*. Ship the capability; gate the importers on that question being answered.

### The mechanism/data pattern

`brain`, `atlas`, `network`, `shopping` and `outreach` are **engine core in mechanism, overlay in
data** — and after the correction above this is the majority pattern, not an exception. The store, its
search path and its write path are generic; the contents are the owner's. This is the pattern the two
newly-promoted features follow:

- **Taste** (`ORB-97`) — engine core mechanism, overlay data. `packages/taste/` is already a clean
  package (entry format, offline S2 cell decoding, Google Takeout import) with a console surface at
  `services/console/app/taste/`. **The one gap is that it has no owner dimension at all** — one
  store, one human, and every design comment in the package says "the owner".
- **Tasks** (`ORB-29`) — engine core mechanism, overlay data. "One central Notion Tasks DB" is
  the owner's *overlay* choice; the engine needs a task store with a Notion **adapter**, not a Notion
  dependency. Dev work staying in Linear is likewise overlay — the engine needs the dedupe seam,
  not Linear.

**Ruling for both: engine core, overlay data.** Neither ships with contents.

## Part 2 — The persona format

### The problem

A persona document today conflates what an agent *does* with how it *sounds*. Saga's
`services/agent-runtime/agents/saga/persona.md` is 260 lines and carries **58** the owner-specific
references — 23 instances of "the owner", plus Heiberg, Orakel, Zero7, Notion, Twenty, Slack,
Telegram and Norwegian. Shipping it as "the chief-of-staff template" would give every circle member
a Saga clone.

the owner, 2026-08-31: *"we should maybe create the roles a little more generic? my agents voices
should perhaps not be the template."*

### Where the content actually sits

| Section of `persona.md` | Lines | Belongs to |
| --- | --- | --- |
| `## Where I run (read this first)` | **97** | **generated** |
| `## Before I propose an outbound write` | 46 | role |
| `## Closing reminders that are done` | 23 | role |
| `## Store answers come from store calls` | 20 | role |
| `## What I do with what you send me` | 12 | role |
| `## How writes work`, `## Always`, `## Never` | 27 | role (gate + refusals) |
| `## House voice`, `## How I behave` | 27 | voice |
| `## Who I am` | 6 | identity |

(Measured 2026-08-31. Sections sum to 260 including the title line.)

**Thirty-seven percent of the persona describes its own environment** — which tools exist, which
stores, which channels, what the sandbox enforces.

### The format

```
role.md        ENGINE, shipped per role template.
               Duties, judgement, discipline, refusals.
               No person, company, vendor, place, or language. Lint-enforced.

voice.md       OVERLAY, per installation.
               Tone, register, language, idiom, formality.

(environment)  GENERATED at build from agent.json grants + the resolved tool list.
               Never hand-written.

identity       name, gender, pronouns — already agent.json's job.
```

These assemble at build into today's `instructions.md`, so nothing downstream changes shape.

### Why the environment section must be generated

Hand-maintaining it has already caused a production bug. The Wave-1 preamble exists precisely
because, per `services/eve-saga/tests/instructions.test.ts`, *"the old preamble made her DENY
capabilities she actually had, e.g. gmail search"*. A persona that describes its own tools will
drift from the tools it has. `ORB-144` already resolves the tool list at build time, so the
information is available — generating the section makes that class of bug structurally impossible
rather than merely fixed.

### Genericness is testable, not aspirational

A role template must name no person, no company, no vendor, no place and no natural language. That
is enforceable as a lint rule, in the same spirit as the compose drift guard and the persona-hash
test — so a template cannot silently reacquire the owner's world over time.

`voice.md` is exempt: naming a language is exactly its job.

### Role templates are extracted, not invented

Three working agents already exist. The chief-of-staff template is what remains of Saga's persona
once the the owner-specific parts are named and removed — a mechanical, checkable process. The same
holds for travel (Marcel) and creative/ideation (Calliope). The fourth named role in `ORB-145`
(accountant) has no working agent behind it and is therefore **invention, not extraction** — it
should be dropped from the first cut or explicitly marked as speculative.

### Voice at onboarding — deferred, not designed here

Considered and deferred: generating `voice.md` from a wizard interview, then refining it with the
existing voice-learn machinery (`voice_profile` has `core`/`english`/`norsk`, 464 exemplars, and a
nightly learn schedule in `services/eve-saga/agent/schedules/voice-learn.ts`). That is an
onboarding feature and belongs with Lares sub-project 4 (the admin UI).

**One caveat for whoever picks it up:** the existing profile learns how *the owner writes emails*, for
drafting **as** him. An agent's voice is how it speaks **to** him. The mechanism and the format
generalise; the data does not.

Also rejected: shipping role templates with a bland neutral default voice. A generic default is
what makes software feel templated, and it is the opposite of how the rest of this portfolio is
built.

## Part 3 — Findings that must be fixed before templates ship

### F1 — `facts` and `memory` are the same capability under two names

eve-saga grants `facts` (scope `write`) for `remember`/`forget` over `standing_facts`. eve-marcel
grants `memory` (scope `write`) for his own `remember`. One concept, two names, two agents, one
fleet.

Harmless today. In an engine it is an inconsistency **every installation inherits**, and it makes
the capability list its own documentation problem. Collapse to one name before role templates ship;
whichever name survives, the other becomes an alias or is removed outright.

### F2 — `transit` is region-bound, and regional assumptions have already shipped a bug

`transit` routes Norwegian journeys through Entur. A German installation needs DB, a UK one
National Rail. Adapters therefore need a **region** dimension, not only a vendor one.

This is not theoretical. `ORB-168` shipped a defect where **Entur's geocoder answered foreign
queries with a fuzzy Norwegian place carrying `country_a: "NOR"`** — live, it turned *"Grand Central
Terminal"* into *"Comfort Hotel Grand Central"* during a New York trip, and eve-marcel had to be
rolled back mid-trip. Four fix rounds followed, and every leak was found by calling the live API,
never by the suite (858, then 860, then 288 green tests each passed over the same defect class).
Full write-up: `docs/solutions/2026-08-25-entur-geocoder-is-norway-biased.md`.

**The rule this produces for the engine:** an adapter must declare the region it is valid for, and
must fail closed outside it rather than answering with a plausible local guess.

### F3 — the taste store has no owner dimension — **RESOLVED 2026-08-31**

`packages/taste/` is a file-based store with one directory for one human. The open question was:
**one profile per installation, or one per user within an installation?**

**Answered: per user, inside a shared org.** the owner's Lares notes ask for multi-user with org-level
admin, which settles it — see
`docs/superpowers/specs/2026-08-31-lares-org-and-multi-user-design.md`, Part 2, where taste sits
with Brain and standing facts on the **per-user private** side of the shared/private line.

The file-based design makes this cheap — a directory per canonical user id — and the canonical id
already exists: `users`/`user_aliases` on the box map 10 aliases across 5 systems to one user
today. What remains is that nothing in `packages/taste/` currently carries a principal.

**`ORB-102` (the Spotify connector) stays blocked until the owner dimension lands**, because it is
the first *automatic* feed and therefore the first that must work for someone who is not the owner.

This is the same personal-data-boundary question the parent spec flags. For a managed client
deployment on the owner's servers, a taste profile is location history and listening history — the
same exposure class as the agent-box GDPR question, which the parent spec already says to revisit
before the first managed client.

## Part 4 — Rulings from the owner's Lares notes (2026-08-26, decided 2026-08-31)

the owner's Notion page (`Lares`, edited 2026-08-26) predates this inventory. Several of its open
questions are answered by it; four others were **decided against** on 2026-08-31 and are recorded
here so they are not reopened by accident.

### Answered by this inventory

| His question | Answer |
| --- | --- |
| *"What integrations should we exclude that are ONLY for me?"* | **None.** All 30 capabilities are engine. The six that felt personal were data, not capability. |
| *"Separate repo — how to approach, and what does that mean for my setup?"* | The parent spec's overlay model: engine repo + private overlays. the owner's box runs the engine exactly as a circle member would, with the Heiberg overlay as its config. His setup stops being special. |
| *"BYOK with different models per agent and perhaps jobs"* | Largely built. `agent.json` carries `model` per agent; `voice_profile.model_en`/`model_no` is a per-**job** model override. Both are currently `NULL` — see `ORB-176`. |
| *"UI needs login-functionality"* | The console already has Google OAuth plus an email allowlist. |
| *"How do we help self-hosters set up Slack agents, Telegram bots?"* | Parent spec: third-party consoles cannot be automated, so the wizard walks each step and the GCP-setup docs are the wizard's script written once. |
| *"How to handle iMessage, calls and other Apple integrations that must run ON the mac?"* | Part 1: `network`'s importers are platform-bound and individually optional; an installation may enable none and still have a working `network` fed by CRM alone. |
| *"How can we bring in audio as an interface?"* | Exists as `ORB-103` (NB-Whisper in, spoken replies out), detached from the cutover parent 2026-08-31. |
| *"Multiuser with admin features…"* | Its own design: `docs/superpowers/specs/2026-08-31-lares-org-and-multi-user-design.md`. It also resolves **F3** — taste is per user, inside a shared org. |

### Decided AGAINST — struck 2026-08-31 (the owner: *"just strike all those, no problem"*)

**1. Consumer Claude / ChatGPT subscriptions as a model backend. API keys only.**
Consumer subscriptions do not permit automated or programmatic use. Offering "bring your Claude Pro
subscription" would put every circle member in breach of their own provider's terms. This must be
stated in the onboarding docs, because it is precisely what a non-developer will expect to work.

**2. Telemetry from self-hosted installations. Not collected.**
In a source-available product the user can read the code that phones home, so anything short of
obviously opt-in reads as surveillance and damages the trust the circle model depends on. It also
sits badly beside the EU-sovereignty posture. Bug reports come from people choosing to send them —
never from silent collection.

**3. Several client instances on one server. One installation, one server.**
Each box carries its own LUKS root, its own nft egress seal and its own squid allowlist. Those are
per-installation controls and they stop meaning anything when several clients' secrets and egress
seals share a kernel. Co-tenancy is multi-tenancy wearing an ops hat; the parent spec's non-goal
already rules it out and this makes the reasoning explicit.

**4. Splitting the engine into its own repo — not yet.**
The engine/overlay boundary was only defined by this document, and the persona format does not
exist yet. Splitting now means splitting on a guess and then moving the line inside two repos
instead of one. **The trigger to revisit:** the persona format shipped (`ORB-145`) and the 21
engine-core capabilities extracted (`ORB-141`). The parent spec's sequencing — *"during or after
the eve waves"* — is satisfied either way, since Wave 1 closes with `ORB-72`.

### The gap this inventory creates: private integrations need a plugin boundary

the owner asks whether self-hosters can *"add their own, private integrations that are not pushed to
the repo or killed by updates"*, suggesting n8n, Make or Zapier.

The requirement is real and the current overlay model cannot express it. **An overlay carries
configuration; a private integration is code.** There is no extension point where a user's own code
can live and survive an engine update.

Two routes, and the second is cleaner:

1. **Overlays contribute code**, which means the engine needs a stable, versioned extension API and
   inherits every compatibility problem that implies.
2. **Private integrations live outside the process and speak MCP.** Eve already has first-class MCP
   support, and the parent spec already treats MCP as the reach mechanism: *"installations plug in
   their own tools by pointing at existing MCP servers — no custom code per client."* A user's n8n
   or Zapier flow becomes an MCP server; the engine needs no extension API at all, and the
   sealed-egress model still applies because every MCP endpoint is a deliberate allowlist entry.

**Recommendation: route 2.** It requires no new plugin architecture, keeps the update story intact,
and preserves containment. What it needs is a documented pattern and a console surface for
registering an MCP endpoint — not an engine change.

## What this spec does not decide

- ~~Which adapters ship in the first release~~ **Resolved 2026-09-01, and the question was framed
  wrong: the owner is the first installation, so every adapter he uses must exist in the engine from
  day one — dogfooding forces it.** What "circle v1" selects is which adapters get wizard
  documentation and circle support: **calendar, gmail, notion (docs + transcripts), twenty,
  orakel** (paid). The rest exist, undocumented for the circle until asked for. CRM remains a
  concept: `twenty` is its first adapter and HubSpot/Pipedrive arrive under the demand-driven
  rule, contract unchanged (the owner: *"still open to other crms, correct?"* — yes).
- **How installations get engine updates.** Parent spec open question; unchanged.
- **Secrets across platforms.** Parent spec open question; unchanged.
- **The taste ownership model.** F3 states the question and the constraint, not the answer — it
  needs its own decision before `ORB-102` (the Spotify connector, the first *automatic* feed and
  therefore the first that must work for someone who is not the owner).

## Consequences for open tickets

| Ticket | Consequence |
| --- | --- |
| `ORB-145` | Grows and improves: define the format, generate the environment section, extract three roles (not four — drop or flag "accountant"). This is Lares sub-project 2, not a backlog chore. |
| `ORB-97` / `ORB-102` | Taste is engine core + overlay data. `ORB-102` stays blocked until F3 is answered. |
| `ORB-29` | Tasks is engine core + overlay data, with a Notion **adapter**. The brainstorm inherits this ruling rather than re-deriving it. |
| `ORB-141` | Engine extraction's target list is now concrete: the 18 engine-core capabilities. |
| new | F1 (`facts`/`memory` collapse) and F2 (adapter region dimension) need tickets. |
