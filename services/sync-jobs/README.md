# services/sync-jobs

One image, two scheduled jobs — `notion-sync` (hourly Notion ↔ Brain vault) and `atlas-sync`
(daily Atlas Part B). Both are brand-neutral, tick in-process, and are not agents.

**The rule (ORB-178):** this image never carries an agent, a persona, a door or a route. A job
of a different shape gets its own Dockerfile.

The two commands:
- `/app/node_modules/.bin/tsx services/notion-sync/bin/notion-sync.ts`
- `/app/node_modules/.bin/tsx services/atlas/bin/atlas-sync.ts`

Built by CI only (`.github/workflows/sync-jobs-image.yml`), never on the box. Pinned by digest
in `services/box/compose.yaml` (both the `notion-sync` and `atlas-sync` services).

Runbooks: `docs/runbooks/notion-sync.md`, `docs/runbooks/atlas-sync.md`.
