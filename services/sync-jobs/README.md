# services/sync-jobs

One image, two scheduled jobs — `notion-sync` (hourly Notion ↔ Brain vault) and `atlas-sync`
(daily Atlas Part B). Both are brand-neutral, tick in-process, and are not agents.

**The rule:** this image never carries an agent, a persona, a door or a route. A job
of a different shape gets its own Dockerfile.

The two commands:
- `/app/node_modules/.bin/tsx services/notion-sync/bin/notion-sync.ts`
- `/app/node_modules/.bin/tsx services/atlas/bin/atlas-sync.ts`

Built by CI only (`.github/workflows/sync-jobs-image.yml`), never on the box.

**Not started by the tested install path.** Release files list a `sync-jobs` image, and CI builds
and scans it, but the installer's rendered stack (`/opt/lares/compose.yaml`) has no `notion-sync`
or `atlas-sync` service, and neither the keeper nor the installer starts this image. Nothing in the
console or the agents needs it. An operator who wants these jobs runs the image themselves, with
the vault, the database and the tokens each job needs, and pins it by the digest in the release
file. (The console's "Notion sync" status, under Connections, reads what a running notion-sync
recorded; on an installation without one it says that no sync run is recorded.)
