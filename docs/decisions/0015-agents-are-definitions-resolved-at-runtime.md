# ADR 0015 — Agents are definitions resolved at runtime; no image, Dockerfile or build per agent

**Date:** 2026-09-15
**Status:** Accepted
**Supersedes:** — (amends earlier designs that assumed a built image per agent)
**Superseded by:** —

## Context

The vision for Lares: *anyone who installs Lares sets up their own agents in the console (or through
Claude Code / Codex) — name, role, description, personality, language, what they may touch — not only
the agents the repo ships.* "Install lares, set up your agents, done."

What had been designed instead:
- **A repo split** made every custom agent a folder in a private overlay repo, built into its own
  image by CI from a per-agent Dockerfile and pinned by hand.
- **An installer design** gave strangers "ready-made" agents: a fixed image per role, with name and voice as
  settings.
- **A releases design** added an overlay mode to carry that per-agent build through updates.

That is a developer's workflow. It came from over-applying the rule "pulled, never built", which was
about building the engine on a small-memory box (the OOM), not about resolving one agent's persona and toolset.

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
4. Instructions and the model are already resolvable at runtime (`defineDynamic`; the chief of staff's clock instruction
   does it today).

Two shapes were weighed. **A:** definitions resolved at runtime. **B:** agents as folders, built on the box
by the keeper in a memory-capped container (the parallel review proposal). The owner chose A. B kept
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
   address per agent. **First step:** the role images (chief of staff, creative) are the pools,
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
   or stays outside as an MCP connection. A per-installation overlay repo of agent images is retired.
10. **An engine update is new images plus a restart;** definitions carry over. The post-update check compares
    each agent's live tool list with what its definition grants from the new release's catalog.
11. **QA continuity:** before a role service moves from a build-time image to definitions, the byte-identical gate carries over. For each, the runtime-assembled instructions and tool list must equal the build-time ones exactly.

## Consequences

**Positive:**

- The vision holds: an owner creates, edits and retires agents in the console or with Claude Code. A
  change applies at the next conversation (tools, model), the next turn (instructions, language), or the next
  action (autonomy). Nothing is built and nothing waits for CI.
- The console's existing autonomy switches (the Integrations page's never / gated / autonomous dial) finally
  reach the agents. Before this decision they wrote a table only meeting follow-ups read.
- No build toolchain on a box, no OOM risk, no per-agent registry images. An update is pull + restart.
- The installer's wizard step "first agent" becomes "create an agent", the same screen as the agent builder.

**Negative / accepted trade-offs:**

- **A real refactor:** the tools in the role services and the agent-kit extension tools move from
  `agent/tools/*.ts` (always present) into catalogs behind one resolver per role service. Mechanical, but not
  small, and it touches every tool.
- The build-time guarantees become save-time and session-time guarantees. They must be at least as strict,
  and each needs a test proving an invalid definition is refused.
- eve's own built-in tools (bash, file tools, web_fetch, …) stay governed at build by the engine's `disableTool`
  choices — engine policy, not per-agent. A definition cannot enable one the engine disabled.
- Work planned for a per-agent overlay build (an overlay mode in the releases design: a follow-engine job, an agents list, a drift guard reading an overlay tag) is transition machinery for an older installation only, and retires once its agents become definitions.

## Operational rules

- Do: treat `/srv/lares/agents/` as installation data. It is backed up, and the keeper versions it.
- Do: validate a definition on every write path (console, keeper, hand edit), and fail closed.
- Don't: build on a box, add a Dockerfile per agent, or make the engine reference any installation's agents.
- Don't: let a definition carry instructions that override the engine's safety parts. Duties and personality
  are appended after them and cannot remove them.

## Open questions

- **How big the tool-catalog refactor is, and when one general image replaces the role pools.**
- **The exact definition format and how the console writes it** (a keeper action with validation; how a hand edit is detected).
- **How an older installation moves over:** first the byte-identical gate (rule 11), then its agents' definitions
  generated from its overlay's agent folders, then its overlay images retired.
- **Overlay mode in the releases design:** dropped. The releases design is built only for the definitions shape.
