# Lares agent definitions, the builder and the permissions board — design (ORB-278)

**Status:** APPROVED in brainstorm (the owner, 2026-09-15), including his eight additions. Plan: to be written
(step 1 in full, steps 2–3 outlined).
**Decision this implements:** `docs/decisions/0015-agents-are-definitions-resolved-at-runtime.md` (ADR-0015).
**Ticket:** ORB-278 (reshaped). **Related:** ORB-269 (keeper core; its plan is on hold and will be revised
against this spec), ORB-266 (installer — its wizard's "first agent" step is this builder), ORB-279 (members),
ORB-226 (private integrations over MCP), ORB-268 (configurable proactive behaviour).
**Paths** are in the `lares` layout.

## The finding, up front

the owner's vision: *anyone who installs Lares sets up their own agents in the console or through Claude Code or
Codex — name, role, description, personality, language, what they may touch.* ADR-0015 settled how: an agent
is a definition, resolved at runtime on an engine image. A throwaway eve 0.32 spike proved the three
mechanisms that make this work:
- a granted tool subset handed over per session;
- a tool's code surviving an approval pause across a server restart;
- "ask first?" decided per call from a table.

Two measured facts shape the order of work:
- **The permissions dial already exists** — the console's Integrations page writes never / gated / autonomous
  into the `ratchet` table — **but the agents do not read it.** Autonomy is fixed when each image is built.
  Only meeting follow-ups read the table live.
- **The console lists agents from the retired runtime's folder** (`AGENTS_DIR=/app/services/agent-runtime/agents`).
  Today's `lares-console` image still carries old Saga and Calliope there, and no Marcel. `lares-console`
  carries nothing.

Both are fixable on the agents as they run today, which is why the board ships first.

## Decisions (2026-09-15)

| Question | Decision |
| --- | --- |
| Where agents end up | **One general image with every engine tool is the committed target**, reached in three deployable steps. Each step is proven byte-identical on Saga, Marcel and Calliope. Step 3 (unify doors and schedules, then collapse the catalogues into one image) is a named plan task with its own acceptance test. |
| Order | **The board first** (on the current agents), then definitions and the builder, then the one image. |
| Doors | **Several per agent, each with its own setup flow** — Saga has Slack, Telegram and email today, and a migration must not lose one. |
| Always-ask by engine policy | **Moving money, deleting data, first contact with someone the owner has never been in touch with, publishing.** No definition or board setting loosens them. |
| When things are resolved | **At session start:** instructions, model, tools, skills. **Per turn:** only the language switch (and the clock, as today). **Per call:** approval. **Per tick:** schedules. Instructions are the system prompt; rebuilding them every turn would throw away the prompt cache on every message and multiply cost. The $250 retry-loop incident (2026-08-14/15) is why this is a rule, not a tuning choice. |
| Skills | **A definition carries skills**, checked by the same never-widen rule as today: a skill may only use capabilities the agent is granted. |
| Model | **Gateway purpose aliases only** (`lares-brain`, `lares-gate`, `lares-writer`, or an installation's own). The builder never offers a raw model id (standing model policy). |
| Approval check | **Cached for 30 seconds per agent and capability; fails closed to "ask"** when the table cannot be read. |
| The keeper's power | It holds the box's Docker socket, which makes it the most privileged thing on the machine. **It has no door, no model, and audits every action.** |
| Egress per agent | **The keeper generates each agent's allow-list from its definition's integrations.** Today it is a hand-written file. Without generation, a new agent would have either no internet or an unsealed one. |
| How many agents a box holds | **The keeper refuses a new agent beyond a stated ceiling,** measured from the box's memory. It never lets one agent too many take the box down. |

## Part 1 — Three steps, each proven on the three live agents

| Step | Ships | Deployable as | Proven by |
| --- | --- | --- | --- |
| **1. The permissions board** | The approval policy reads the `ratchet` table per call (definition's level as the start; always-ask enforced; 30 s cache; fails closed); each agent registers itself at start; the console lists the real agents from that registry; the board | An engine release through today's manual route; no keeper needed | The three agents' effective levels unchanged; one board flip changes the next gated action; tool lists and personas byte-identical |
| **2. Definitions and the builder** | Each role service's tools become a **catalogue**; a resolver builds each session from a definition (instructions, model, tools, skills, schedules, language); the keeper stores, validates and backs up definitions and renders agent containers with generated egress; the builder; Saga, Marcel and Calliope move to definitions | An engine release + the keeper core | Each agent's instructions assembled from its definition equal today's `instructions.md` byte-for-byte; tool lists equal; suites equal |
| **3. One general image** | Doors unified (Saga's and Marcel's different Telegram behaviour become definition options), schedules unified (every schedule in one image, each switched by the definition), then the three catalogues merge into one image | An engine release | The three agents run on the one image with identical instructions, tools and a day of real use (brief, follow-up, trip turn) |

## Part 2 — The definition

A folder per agent on the box: `/srv/lares/agents/<name>/`.

```
agent.json   name, gender, description, starting point (step 2: chief-of-staff | travel | creative;
             step 3: general), model (a purpose alias), language (default for its conversations),
             grants [{capability, scope}], autonomy {capability: never|gated|autonomous},
             skills [name], schedules {name: on|off (+ times, per ORB-268)}, doors [{kind, …}]
duties.md    what this agent is for, in the owner's words (may be empty — Saga's is)
voice.md     how it sounds
```

- **Who edits it:** the console, through the keeper (the console has no write access of its own), and people
  with Claude Code or Codex editing the same files.
- **Checked on every save, and again at every session start** — the same checks the build runs today:
  - skills within grants (never-widen);
  - a write tool's approval class matches its grant's scope;
  - the tools a role's text names are present;
  - the write-shape lint;
  - the model is a known purpose alias;
  - a door can be saved while its setup is pending, but it cannot be switched on until its secrets exist.

  **An invalid save is refused** with the reason. **An invalid hand edit leaves the agent on its last valid
  definition** and raises a signal. It fails closed, never half-configured.
- **Backup:** the keeper commits the folder to a git repository the owner chooses. It is a backup, not where
  agents are authored.
- **Retiring** stops the agent, archives its folder, and keeps its memory. Deleting is a separate,
  always-ask action.

## Part 3 — How an agent runs from its definition

| When | What is resolved | Why then |
| --- | --- | --- |
| **Session start** | instructions, model, tools (the granted subset of the catalogue), skills | the system prompt and the tool list are what the prompt cache keys on; changing them mid-session re-bills the whole conversation |
| **Each turn** | the language switch; the clock (as today) | small instruction additions that do not rewrite the system prompt |
| **Each call** | approval ("ask first?") | a board change must bite on the next action |
| **Each schedule tick** | whether the schedule is on, its times | a definition change reaches a schedule at its next tick |

**When a change takes effect, stated in the builder:**
- **Autonomy:** at the next action.
- **Schedules:** at their next tick.
- **Instructions, tools, skills, model:** at the next conversation. An eve session is one chat-day on Slack and
  Telegram (a recorded finding), so for a direct-message door that means tomorrow. The builder offers
  "start a fresh conversation now" for when the owner wants it sooner.

**The instruction stack** keeps today's order, so the byte-identical gate holds:
1. who I am;
2. where I run — generated from the tools actually granted;
3. **the role — the engine's rules, first and not editable:** how writes and approvals work, the never-list,
   the refusals;
4. the owner's duties;
5. the voice;
6. the language.

With empty duties this is exactly today's assembled persona.

**Always-ask.** Every engine tool is tagged if it moves money, deletes, contacts someone, or publishes. The
approval policy returns "ask" for a money, delete or publish tool whatever the definition or the board says.
For a contact tool it returns "ask" when the recipient has no history with the owner — no earlier mail, no CRM
person, no network entry. Which history counts is recorded beside the policy, as the third-party-API rule
requires for any inferred contract.

**The approval check.**
- It reads `ratchet` for (agent, capability), falling back to the definition's level.
- It caches the answer for 30 seconds per agent and capability.
- If the table cannot be read, it answers "ask". An outage costs a click, never an unapproved write.

**The language switch.** An always-present tool lets the agent record "this conversation in English" in the
session's own state. The per-turn instruction reads the state first, then the definition. The definition
itself never changes.

## Part 4 — The permissions board and the agent registry (step 1)

- **Registry.** At start, each agent writes one row: name, display name, role, grants, starting autonomy,
  skills, doors, and its resolved tool list. The console reads the registry instead of `AGENTS_DIR`, so the
  Fleet page and each agent's page show the real agents. A row older than the agent's last start is marked
  stale, never shown as live.
- **The board** is the existing Integrations dial made real. Per agent and capability:
  - the effective level, with its source ("set on the board 12 Sep" or "from the definition");
  - the evidence beside it: approvals given, denials and last use, from the audit and confirmation tables;
  - one control to change it.

  Every change writes an audit row naming who made it. Always-ask actions show a lock and cannot be moved.

## Part 5 — The builder, doors and containers (step 2)

- **Fields:**
  - name, gender, description;
  - starting point;
  - duties, personality, language;
  - model — a purpose-alias list;
  - integrations (from the starting point's catalogue until step 3), skills, permission levels, schedules;
  - doors.
- **Doors, several per agent, each with its own setup flow:**
  - **Slack:** a pre-filled "create this app from a manifest" link, then paste two values.
  - **Telegram:** the BotFather steps, then paste the token.
  - **Email:** connect a mailbox through the existing Google flow.

  The owner claims each chat door with a one-time code (installer design, Part 4).
- **Containers.** Each agent is its own container of its image, with its definition mounted read-only, its
  own address and its own sealed egress. The keeper writes agent containers into **a compose file it owns**
  (`compose.lares-agents.yaml`). The file sits beside an overlay box's own files, so the keeper adds agents
  without editing the fleet's files. The drift guard includes it.
- **The ceiling.** The keeper holds a stated maximum number of agents for the box, computed from measured
  memory: (the box's memory − the rest of the stack − headroom) ÷ one agent's measured peak. It refuses a new
  agent beyond that with a plain sentence ("this box holds 6 agents; retire one or move to a larger server").
  The number shows in the console.

## Part 6 — The keeper's power, and the egress seal

- **The keeper holds the Docker socket, which is root on the box in practice.**
  - It has **no door** (nothing reaches it from outside) and **no model** (no AI decides what it does).
  - It answers only its fixed action list, through the console's socket and the host socket.
  - It **writes an audit row for every action.**
  - Definition saves, container starts and egress changes are actions like any other.
- **Egress is generated, never hand-written.** Every engine adapter declares the hosts it reaches, next to its
  region in `capability-docs` — the contributed-adapter checklist already demands this. From each agent's
  granted integrations, the keeper generates:
  - that agent's allow-list in the egress proxy, one access list per source address;
  - its membership of the host's sealed set.

  A newly granted integration adds its hosts; a revoked one removes them; the proxy reloads. An agent with no
  integrations reaches the box network and nothing else.
- **Today's hand-written seal** (`egress-saga.nft` + `squid.conf`) is the first thing the generator must
  reproduce: the three live agents' generated allow-lists are compared with today's files before step 2
  deploys.

## Part 7 — Moving Saga, Marcel and Calliope

Order at every step: **Calliope, then Marcel, then Saga** — smallest first, as the split did.
- **Step 1:** their images gain the runtime approval policy and the registry. Gate: effective levels unchanged,
  tool lists and personas byte-identical.
- **Step 2:** each gets a definition generated from `lares-heiberg/agents/<name>/`; its duties are empty, and
  its voice is today's `voice.md`. Gate: the instructions assembled at runtime equal today's `instructions.md`
  exactly, and the tool lists are equal. Then the image switches from the overlay-built one to the catalogue
  image with the definition mounted.
- **Step 3:** the same gate on the one general image, then a day of real use.

## Part 8 — What proves it

1. **Committed mock-model evals in `lares`** (the spike's pattern, made permanent):
   - the granted subset;
   - the approval pause surviving a restart;
   - a board flip biting on the next call;
   - always-ask holding against an "autonomous" setting;
   - the cache and the fail-closed read;
   - the language switch staying in its conversation;
   - an invalid definition failing closed;
   - schedules obeying the definition at their next tick.
2. The per-step byte-identical gates of Part 7, run before each deploy and again inside the running containers.
3. The egress comparison of Part 6.
4. Live probes for the door setup (Slack manifest link, Telegram `setWebhook`), committed as `tests/live/*.live.mts`.
5. The ceiling: measured per-agent peak memory recorded, and the refusal tested.

## Part 9 — Order and dependencies

- **Step 1** depends on nothing new; it ships in the next manual engine release.
- **Step 2** needs the keeper core, described by the installer's Plan 1 and the ORB-269 plan. It is built once,
  by whichever runs first. The ORB-269 plan is revised against this spec.
- **Step 3** follows step 2.

## Non-goals

A shared "house" door; members and roles (ORB-279); web chat (ORB-270); the onboarding agent (ORB-283); private
integrations over MCP (ORB-226); agents handing work to each other.

## Open questions

None by design. Four facts are measured in the plan rather than assumed:
- one agent's peak memory, which sets the ceiling;
- each adapter's real egress hosts, derived from the code and today's `squid.conf`, then proven by the
  comparison;
- which history counts as "been in touch" for first contact, per data source, stated beside the policy;
- that a door adapter with no token stays inert (read from the code: Slack's credentials are resolved lazily;
  proven by an eval).
