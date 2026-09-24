# Lares CLAUDE.md

Lares is a self-hosted fleet of named agents that runs the operating overhead of a small business on a server the owner controls. This repo is the ENGINE. It contains nothing about any installation: no personas, no server names, no secrets references, no owner ids in configuration. An installation is DATA on the owner's server: agent definitions under `/srv/lares/agents/<name>/` (`agent.json`, `duties.md`, `voice.md`), settings and secrets — resolved at runtime on engine images (ADR-0015). A private overlay repo that builds per-agent images is transition machinery for one older installation, not the model.

## Rules that already cost something

- **A fixture is what we believe an API does. Only a live call is what it does.** Any branch on a third-party response ships with a committed live probe `tests/live/<api>.live.mts`, run by hand, named in the ticket.
- **Never build on the box.** Images are built in CI, pulled by digest. The runtime image never runs `pnpm install` or `eve build`.
- **An installation adds definitions and settings. Nothing else.** If an installation needs engine code to change, that is a contribution. Tools an installation wants that the engine does not ship come in through MCP, outside the engine (ADR-0019) — there is no plug-in folder.
- **Every role service ships a NEUTRAL default `agent.json` + `agent/voice.md`** (from `packages/agent-kit/templates/<role>/`). Tests run against it. An overlay's build overwrites it. A test that only passes with one installation's persona belongs in that installation's overlay, not here.
- **Nothing phones home.** No telemetry from installations. The console's update check reads a public releases feed and sends nothing.
- **Root pnpm patches break every image** unless the Dockerfile copies `patches/` before `pnpm install`.
- **The image probe only runs in CI, and it applies every `services/box/sql` file from 039 up to a hand-built database.** A migration that ALTERs or INSERTs into an older table needs that table's file added to `services/keeper/tests/runtime-image.probe.py` in the same change. New migrations, probe changes and workflow changes get a manual run on a pushed branch (`gh workflow run "keeper and neutral runtime images" --ref <branch>`) before they reach main; green local tests say nothing about them.
- Tools are resolved per SESSION from the agent's definition (ADR-0015); the never-widen check on skills runs when a definition is saved and again when a session starts, and an invalid definition fails closed — the agent keeps its last valid one.

## Run commands

- `pnpm test` — every workspace package (Docker running: stores use testcontainers)
- `pnpm -C services/chief-of-staff run assemble:check` — the assembled persona is byte-identical to the committed one
- `docker build -f services/chief-of-staff/Dockerfile .` — the role BUILDER image, from the repo root
- `node scripts/check-namespace.mjs` — reject retired namespace references, preserving negative privacy assertions and geographic names

## AI-assisted contribution attribution

Record substantial AI assistance honestly in the commit message, for example `Assisted-by: OpenAI Codex` or `Assisted-by: Anthropic Claude`, naming only tools that worked on that change. Preserve existing co-author trailers. Use `Co-authored-by` only with an established attribution identity; do not invent an email address or GitHub account to populate the contributor graph. Do not rewrite published history solely to change attribution.

## Decisions to read before changing…

- **Use the Lares decision records as authoritative for the engine.** Historical numbering has gaps; never renumber records or assume a missing number is a lost file. `docs/decisions/README.md` explains the inherited numbering and references that need reconciliation.
- `…memory, notes, facts, dreaming: docs/decisions/0017-the-vault.md, 0018-learning-and-dreaming.md, docs/specs/2026-09-18-origin-model-design.md`
- `…an integration or an outside API: docs/decisions/0019-integrations.md`
- `…conversations, logs, retention, erasure: docs/decisions/0020-conversations.md`
- `…eve, releases, migrations: docs/decisions/0021-releases-and-upgrades.md, docs/specs/2026-09-18-eve-upgrade-design.md`
- `…install, first run, wording about support: docs/decisions/0022-the-tested-install-path.md ("tested path", never "supported")`
- `…search quality: run pnpm -C packages/memory-evals test — it fails if recall drops below the recorded baseline`
