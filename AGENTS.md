<!-- The shared process above the marker is generated (agent kit v0.5.3) and
     kept in step by the maintainer. Edit only below the marker. -->

# AGENTS.md

Read by every coding agent in this repo: Codex directly, Claude Code through CLAUDE.md.

## Shared process

This section is the same in every project that uses this kit and applies to every coding
agent (Claude Code, Codex or any other). The project's own section further down overrides it
where they conflict.

### Session start

Before any work, read whichever of these the project has:

1. `.claude/PROJECT.md`: the project profile. Its tracker, its path to main, its owners
   and its overriding rules.
2. `docs/SESSION_CONTEXT.md`, if it exists: resume interrupted work.
3. `docs/HANDOFF.md`: current focus, recent changes, next priorities.
4. `docs/CURRENT_STATUS.md`: what works, what is blocked.
5. `docs/solutions/`: search here first when debugging a known-hard problem.

### Working style

The owner (the person directing the work) defines what should happen; the agent
implements. Assume the owner is not a software developer.

- **Before implementing:** explain the approach in plain language and get approval.
- **After implementing:** give verification steps the owner can run.
- **On failures:** explain what went wrong in non-technical terms.
- **If unsure:** ask. Say "I'm not sure how X works. Should I investigate?"
- **Don't assume** knowledge of dev workflow, git terminology or programming concepts.
- Work reaches main by the one path the project names, for the owner and agents alike.

### Task fidelity routing

Classify every task before starting:

| Level | When | Workflow |
| --- | --- | --- |
| **F1, trivial** | Single file, clear change | Read, change, verify |
| **F2, standard** | Multi-file, follows patterns | State plan, consult rules, implement, verify |
| **F3, discovery** | Unclear scope, new patterns | Research, written plan (`docs/plans/`), get approval, implement incrementally |

If during F1 or F2 you discover larger scope, stop and re-classify. For a vague F3 request:
read the codebase first, ask clarifying questions one at a time, then propose two or three
approaches.

### Before any code edit

1. **Read** the files you are about to modify.
2. **Search** for usages of the functions and components you will change.
3. **Consult** the relevant checklist, if the project has them (F2 and F3; see the index
   below).
4. **State** your plan before editing.
5. **Verify** after editing with the project's typecheck or test command (named in the
   project section or in `.claude/kit.config.json`).

Never hardcode values that exist in config or the database. Never assume a function
signature. Never add a new file when editing an existing one works. Never guess at types.

### Proactive questions (F2 and F3)

Before implementing, raise the two or three most relevant:

- **Data:** what happens to existing data? Will old records still work?
- **Failure:** what if this fails? Is there a fallback?
- **Dependencies:** what depends on this, and what does it depend on?
- **Validation:** what prevents invalid input?
- **Edge cases:** loops, nulls, empty states, limits?

After completing, ask yourself: what was the hardest decision, what alternatives were
rejected and why, what are you least confident about?

### Session end

After significant F2 or F3 work, always, without asking:

1. Update the project's status docs (`docs/HANDOFF.md`, `docs/CURRENT_STATUS.md`) where
   they exist. Not when you work unattended from a ticket (see below).
2. Write `docs/solutions/<date>-<slug>.md` for any non-trivial problem solved.
3. Record gotchas or patterns discovered where the project keeps them.
4. Propose a new checklist if the work revealed a pattern worth enforcing.

### Two writers, one repo

Several people and agents may work in the same repo at once. Never `git add -A`; add
explicit paths. Before trusting a locally modified doc, compare it with the main branch on
the remote; a local copy can be older than main.

An agent working unattended from a ticket (started by the tracker, not by a person) never edits
`docs/HANDOFF.md`, `docs/CURRENT_STATUS.md` or `docs/SESSION_CONTEXT.md`. Every session writes
at their top, so such an edit conflicts with main, and a conflicted PR gets no CI. Put the
handoff note in the PR description; put a lesson future sessions need in a new
`docs/solutions/<date>-<slug>.md` file. The owner's sessions fold the results into the
status docs.

<!-- Project section: hand-owned. Everything below this line is kept as written. -->

## This project: Lares

Lares is a self-hosted fleet of named agents that runs the operating overhead of a small business on a server the owner controls. This repo is the ENGINE. It contains nothing about any installation: no personas, no server names, no secrets references, no owner ids in configuration. An installation is DATA on the owner's server: agent definitions under `/srv/lares/agents/<name>/` (`agent.json`, `duties.md`, `voice.md`), settings and secrets — resolved at runtime on engine images (ADR-0015). A private overlay repo that builds per-agent images is transition machinery for one older installation, not the model.

### Rules that must always hold

- **This repo is public.** Nothing committed here, this file included, names or describes any installation: no server names, hosts or addresses, no owner or agent ids, no personas, no secrets or references to where secrets live, no private trackers or internal tooling. Examples use neutral placeholders.
- **Work reaches main through a pull request and the merge queue**, for maintainers and agents alike.

### Rules that already cost something

- **A fixture is what we believe an API does. Only a live call is what it does.** Any branch on a third-party response ships with a committed live probe `tests/live/<api>.live.mts`, run by hand, named in the ticket.
- **Never build on the box.** Images are built in CI, pulled by digest. The runtime image never runs `pnpm install` or `eve build`.
- **An installation adds definitions and settings. Nothing else.** If an installation needs engine code to change, that is a contribution. Tools an installation wants that the engine does not ship come in through MCP, outside the engine (ADR-0019) — there is no plug-in folder.
- **Every role service ships a NEUTRAL default `agent.json` + `agent/voice.md`** (from `packages/agent-kit/templates/<role>/`). Tests run against it. An overlay's build overwrites it. A test that only passes with one installation's persona belongs in that installation's overlay, not here.
- **Nothing phones home.** No telemetry from installations. The console's update check reads a public releases feed and sends nothing.
- **Root pnpm patches break every image** unless the Dockerfile copies `patches/` before `pnpm install`.
- **The image probe only runs in CI, and it applies every `services/box/sql` file from 039 up to a hand-built database.** A migration that ALTERs or INSERTs into an older table needs that table's file added to `services/keeper/tests/runtime-image.probe.py` in the same change. New migrations, probe changes and workflow changes get a manual run on a pushed branch (`gh workflow run "keeper and neutral runtime images" --ref <branch>`) before they reach main; green local tests say nothing about them.
- Tools are resolved per SESSION from the agent's definition (ADR-0015); the never-widen check on skills runs when a definition is saved and again when a session starts, and an invalid definition fails closed — the agent keeps its last valid one.

### Run commands

- `pnpm test` — every workspace package (Docker running: stores use testcontainers)
- `pnpm -C services/chief-of-staff run assemble:check` — the assembled persona is byte-identical to the committed one
- `docker build -f services/chief-of-staff/Dockerfile .` — the role BUILDER image, from the repo root
- `node scripts/check-namespace.mjs` — reject retired namespace references, preserving negative privacy assertions and geographic names

### AI-assisted contribution attribution

Record substantial AI assistance honestly in the commit message, for example `Assisted-by: OpenAI Codex` or `Assisted-by: Anthropic Claude`, naming only tools that worked on that change. Preserve existing co-author trailers. Use `Co-authored-by` only with an established attribution identity; do not invent an email address or GitHub account to populate the contributor graph. Do not rewrite published history solely to change attribution.

### Decisions to read before changing…

- **Use the Lares decision records as authoritative for the engine.** Historical numbering has gaps; never renumber records or assume a missing number is a lost file. `docs/decisions/README.md` explains the inherited numbering and references that need reconciliation.
- `…memory, notes, facts, dreaming: docs/decisions/0017-the-vault.md, 0018-learning-and-dreaming.md, docs/specs/2026-09-18-origin-model-design.md`
- `…an integration or an outside API: docs/decisions/0019-integrations.md`
- `…conversations, logs, retention, erasure: docs/decisions/0020-conversations.md`
- `…eve, releases, migrations: docs/decisions/0021-releases-and-upgrades.md, docs/specs/2026-09-18-eve-upgrade-design.md`
- `…install, first run, wording about support: docs/decisions/0022-the-tested-install-path.md ("tested path", never "supported")`
- `…search quality: run pnpm -C packages/memory-evals test — it fails if recall drops below the recorded baseline`
