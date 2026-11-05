# services/sync-jobs

One image, two scheduled jobs — `notion-sync` (hourly Notion ↔ Brain vault) and `atlas-sync`
(daily Atlas sync). Both are brand-neutral, tick in-process, and are not agents.

**The rule:** this image never carries an agent, a persona, a door or a route. A job
of a different shape gets its own Dockerfile.

The two commands:
- `/app/node_modules/.bin/tsx services/notion-sync/bin/notion-sync.ts`
- `/app/node_modules/.bin/tsx services/atlas/bin/atlas-sync.ts`

Built by CI only (`.github/workflows/sync-jobs-image.yml`), never on the box.

**Optional, and off until the owner switches it on.** Release files list a `sync-jobs` image and CI
builds and scans it. The installer's rendered stack (`/opt/lares/compose.yaml`) has no `notion-sync`
or `atlas-sync` service. The keeper can run `notion-sync` as its own container, from a separate
`compose.lares-services.yaml` it renders itself, pinned to the release's digest, but only while the
owner has switched it on in the console (Settings, Notion, Notion sync) and accepted a preview of
exactly the current settings, and the shared Notion key is applied. That managed service runs only
the passes that need no vault (meeting attendees and People records); it is a consumer of the
shared Notion key, so applying, replacing or disconnecting the key restarts or stops it. `atlas-sync`
is never started by the keeper. An operator who wants the vault passes, or `atlas-sync`, runs the image
themselves, with the vault, the database and the tokens each job needs, pinned by the digest in the
release file. (The console's "Notion sync" status, under Connections, reads what a running notion-sync
recorded; on an installation without one it says that no sync run is recorded.)
