# ADR 0015 — Agents are definitions resolved at runtime; no image, Dockerfile or build per agent

**Date:** 2026-09-15
**Status:** Accepted
**Supersedes:** — (amends `specs/2026-09-11-lares-repo-split-design.md` Part 3, `specs/2026-09-14-lares-installer-and-wizard-design.md` Part 5, `specs/2026-09-14-lares-releases-and-update-design.md` Parts 3a–4)
**Superseded by:** —

## Context

the owner's vision for Lares, restated 2026-09-15 when the design had drifted from it: *anyone who installs
Lares sets up their own agents in the console (or through Claude Code / Codex) — name, role, description,
personality, language, what they may touch — not only the agents the repo ships.* "Install lares, set up your
agents, done."

What had been designed instead:
- **The repo split** (ORB-262) made every custom agent a folder in a private overlay repo, built into its own
  image by CI from a per-agent Dockerfile and pinned by hand.
- **The installer spec** gave strangers "ready-made" agents: a fixed image per role, with name and voice as
  settings.
- **The releases spec** added an overlay mode to carry that per-agent build through updates.

That is a developer's workflow. It came from over-applying the box rule "pulled, never built", which was
about building the engine on an 8 GB box (the OOM), not about resolving one agent's persona and toolset.
The coordinating architecture review reached the same diagnosis independently the same morning.

**What was measured, not assumed** (a throwaway spike in eve 0.32 with a mock model, on the dev server AND
a production `eve build` + `eve start`):
1. A `defineDynamic` tools resolver reading a definition at session start hands the model exactly the
   granted subset of a tool catalog. An ungranted tool never appears, and a new session with a changed
   definition gets the changed set.
2. Tools written the way Lares's are (plain `defineTool` values in a module), wrapped with an inline
   `execute` that calls the catalog entry, survive eve's durable replay. The case tested: a gated call paused
   at its approval card, the server was **restarted**, the approval was given, and the write ran correctly.
3. An async `approval` policy reading a table decides "ask first?" per call. Flipping the level
   mid-session made the next write run without a card.
4. Instructions and the model are already resolvable at runtime (`defineDynamic`; Saga's clock instruction
   does it today).

Two shapes were weighed. **A:** definitions resolved at runtime. **B:** agents as folders, built on the box
by the keeper in a memory-capped container (the parallel review proposal). the owner chose A on 2026-09-15. B kept
today's tool wiring but built on the box: minutes per change, OOM risk, still needing runtime pieces for
per-conversation language and the permissions board.

## Decision

1. **An agent is a definition, not an image.** A definition holds name, gender, description, duties, personality
   (voice), language, model alias, grants (capability + scope), autonomy levels, channels and skills. It lives
   as files on the box at `/srv/lares/agents/<name>/` (`agent.json`, `duties.md`, `voice.md`).
2. **The console and Claude Code / Codex edit the same definition.** The console writes through the keeper.
   A hand edit is picked up the same way. Every change is validated before any agent sees it (rule 7).
3. **Engine images carry the tools; a running agent is a tool pool plus a definition.** Each agent is its own
   container of an engine image with its definition mounted read-only. That keeps a sealed egress and a fixed
   address per agent. **First step:** the three role images (chief of staff, travel, creative) are the pools,
   and a definition picks one as its base — a custom "bookkeeper" is the chief-of-staff pool with the grants
   the owner ticks and its own duties, personality and language. **Later:** one general image with every
   engine tool.
4. **eve resolves everything at runtime, and no box ever builds.** Tools are resolved per session (the granted
   subset). Instructions per turn: the engine's safety parts, the duties, the personality, the language, and
   the generated environment section. The model per session. Approval per call. No `eve build` on a box, no
   per-agent image, Dockerfile or CI.
5. **The safety parts are engine-owned** and are part of every agent whatever its definition: how writes and
   approvals work, the never-list, the refusals. Owners write duties and personality, never the guardrails.
   Some actions are **always-ask by engine policy** (moving money, deleting, first contact with a person the
   owner has no history with), and no definition or board loosens them.
6. **Autonomy:** the definition's level is the starting point. The permissions board (the `ratchet` table)
   overrides per agent and capability, takes effect on the next action, and writes an audit row for every
   change.
7. **Language:** every definition has a language. A conversation may switch it for that conversation only; the
   switch is remembered per session and never changes the definition.
8. **The checks that run at build today run when a definition is saved, and again when a session starts**
   (never-widen skills vs grants, class-matches-scope, role-tools-present, the write-shape lint). An invalid
   definition is refused at save. If one appears by hand edit, the agent keeps running on its last valid
   definition and a signal is raised — it fails closed, never half-configured.
9. **Git is a backup, not the place agents are authored.** The keeper commits `/srv/lares/agents/` to a repo
   the owner chooses. Code that an installation needs goes to the engine by pull request (the adapter ladder)
   or stays outside as an MCP connection (ORB-226). A per-installation overlay repo of agent images is retired.
10. **An engine update is new images plus a restart;** definitions carry over. The post-update check compares
    each agent's live tool list with what its definition grants from the new release's catalog.
11. **QA continuity:** before Saga, Marcel and Calliope move from overlay-built images to definitions, the
    byte-identical gate carries over. For each, the runtime-assembled instructions and tool list must equal
    today's build-time ones exactly.

## Consequences

**Positive:**

- the owner's vision holds: an owner creates, edits and retires agents in the console or with Claude Code. A
  change applies at the next conversation (tools, model), the next turn (instructions, language), or the next
  action (autonomy). Nothing is built and nothing waits for CI.
- The console's existing autonomy switches (the Integrations page's never / gated / autonomous dial) finally
  reach the agents. Today they write a table only meeting follow-ups read.
- No build toolchain on a box, no OOM risk, no per-agent registry images. An update is pull + restart.
- The installer's wizard step "first agent" becomes "create an agent", the same screen as ORB-278's builder.

**Negative / accepted trade-offs:**

- **A real refactor:** about 80 tools in the three role services and 12 agent-kit extension tools move from
  `agent/tools/*.ts` (always present) into catalogs behind one resolver per role service. Mechanical, but not
  small, and it touches every tool.
- The build-time guarantees become save-time and session-time guarantees. They must be at least as strict,
  and each needs a test proving an invalid definition is refused.
- eve's own built-in tools (bash, file tools, web_fetch, …) stay governed at build by the engine's `disableTool`
  choices — engine policy, not per-agent. A definition cannot enable one the engine disabled.
- Work already planned for the per-agent overlay build — ORB-269's overlay mode (the overlay's follow-engine
  job, `agents.json`, the drift guard reading an overlay tag) — becomes transition machinery for the owner's box
  and retires after his agents become definitions.

## Operational rules

- Do: treat `/srv/lares/agents/` as installation data. It is backed up, and the keeper versions it.
- Do: validate a definition on every write path (console, keeper, hand edit), and fail closed.
- Don't: build on a box, add a Dockerfile per agent, or make the engine reference any installation's agents.
- Don't: let a definition carry instructions that override the engine's safety parts. Duties and personality
  are appended after them and cannot remove them.

## Open questions

- **How big the tool-catalog refactor is, and when one general image replaces the role pools.** Resolved by the
  agent-definitions spec and plan (ORB-278, reshaped by this ADR).
- **The exact definition format and how the console writes it** (a keeper action with validation; how a hand
  edit is detected). Resolved in the same spec.
- **How the owner's box moves over:** first the byte-identical gate (rule 11), then his three agents' definitions
  generated from `lares-heiberg/agents/*`, then his overlay images retired. Sequenced in the same plan.
- ~~Whether v0.2.0 (ORB-286 batch 6) still ships through ORB-269's overlay mode~~ **Resolved 2026-09-15 (the owner,
  final): no — the manual route.** v0.2.0 is deployed the way deploys work today (bump `ENGINE_TAG`, the overlay CI
  builds, pin the digests in `lares-heiberg/box/`, accept the drift guard). ORB-269 is built only for the
  definitions shape: its overlay mode is dropped, and its plan is revised after the agent-definitions spec.
