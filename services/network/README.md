# network

Local relationship intelligence for the portfolio. Ingests the LinkedIn data
export, live Apple Contacts, iMessage, and call history into a single SQLite
file at `~/.lares/network.db`, scores every relationship ("Pulse", shared
`@lares/strength` model), and answers "who do I know at X / who went quiet?".

**Mac-only. Never deployed. The database and message content never leave the
machine** — see the spec's privacy section.

Spec: `docs/superpowers/specs/2026-06-10-network-layer-design.md`

## Setup (one-time)

1. Grant your terminal **Full Disk Access** (System Settings → Privacy &
   Security → Full Disk Access) — required to read Messages/Contacts/calls.
2. `pnpm pnpm network import --linkedin <path-to-export-folder>`

Raw exports (LinkedIn, Meta) land in `~/.lares/exports/<source>/` — outside
the repo, deleted after verified ingest. How to request each export:
[`docs/operations/data-export-runbook.md`](../../docs/operations/data-export-runbook.md).

## Commands

All via `pnpm pnpm network <cmd>` from the repo root:

- `import [--linkedin <dir>]` — ingest all local sources (+ LinkedIn export)
- `who-at <company>` — contacts at a company, warmest first
- `dormant` — the reactivation queue (dormant-warm contacts)
- `person <name>` — one contact's profile + recent interactions
- `sql "<select…>"` — read-only SQL for arbitrary questions
- `merge <fromId> <intoId>` / `detach <identityId>` — fix identity mistakes
- `browse` — open Datasette on the database (needs `uv`: `brew install uv`)
- `backup` — copy the database to the NAS path in `~/.lares/config.json`
- `sync-twenty [--apply]` — match local contacts to Twenty people (dry-run by default)
- `push <contactId> --brand <brand>` — create a local contact as a Twenty person
- `brain-notes [--dry-run]` — regenerate derived person/company notes into the Heiberg Brain vault

## Twenty sync (Phase 2)

Bidirectional field sync with the self-hosted Twenty CRM: push pulse band /
last personal contact / LinkedIn URL to matched Twenty people, pull Twenty's
relationship strength + lastContactedAt into the local cache (shown by
`who-at` and `person`).

One-time setup:

1. Set the CRM base URL in `~/.lares/config.json`, e.g.
   `{ "twentyBaseUrl": "https://crm.owner.example" }`.
2. Store the API key (Twenty → Settings → API & Webhooks) in the Keychain:
   ```bash
   security add-generic-password -s lares-network-twenty -a bendik -w <key>
   ```
3. Provision the custom person fields once:
   ```bash
   pnpm --filter @lares/network provision:fields
   ```

Workflow — always dry-run first:

```bash
pnpm pnpm network sync-twenty          # dry run: shows what would match/change
# review the counts and the ambiguous table, fix any mismatches
pnpm pnpm network sync-twenty --apply  # actually write
```

Ambiguous matches are never auto-merged. Resolve them with
`pnpm pnpm network merge <fromId> <intoId>` (local duplicates) or by adding
the right email to the person in Twenty, then re-run.

Push a contact that doesn't exist in Twenty yet (it links the new person back
locally; it never creates companies — only links an existing company by name):

```bash
pnpm pnpm network push <contactId> --brand orakel
```

## Weekly digest (Phase 3)

Once a week the network layer posts a Slack digest to a configured channel.
The message has three sections:

1. **Reactivation queue** — dormant-warm contacts who haven't heard from you recently.
2. **Fresh signals** — things that changed for a contact since the last digest: job changes and promotions (picked up when the monthly LinkedIn export is re-imported) and unreturned calls.
3. **Warm paths into the pipeline** — for each company with an open deal in Twenty, your warm contacts at that company (matched by company name in the local db).

**When it runs:** the digest fires on the first daily job of each ISO week (normally Monday at 09:30, since ISO weeks start on Monday). The per-week guard (`digest_runs` table, schema v3) makes it idempotent — rerunning the same week prints "already posted" and skips the Slack call.

**One-time setup:**

1. Store the Slack bot token in the Keychain (the same bot token `crm-notifier` uses — invite it to the channel if not already):
   ```bash
   security add-generic-password -s lares-network-slack -a bendik -w <xoxb-token>
   ```
   **Important:** use the `security` CLI command above, not the Keychain Access app. Items created via the GUI can trigger an interactive permission prompt that the launchd job can never answer, causing the daily job to hang silently.
2. Add `"digestSlackChannel": "#heiberg-ops"` (or your chosen channel) to `~/.lares/config.json`.
3. Reload the launchd plist since its command string changed:
   ```bash
   launchctl unload ~/Library/LaunchAgents/co.heiberg.lares.network-backup.plist
   cp ~/Developer/lares-heiberg/local/co.heiberg.lares.network-backup.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/co.heiberg.lares.network-backup.plist
   ```

**Preview before the first post:**
```bash
pnpm pnpm network digest --dry-run
```
Rerunning after a successful post prints `Digest already posted for 2026-W24 — nothing to do.` (with the current week number).

## Brain notes (Phase 4)

`pnpm network brain-notes [--dry-run]` regenerates derived relationship notes
into the Heiberg Brain Obsidian vault. It writes three kinds of files:

- `wiki/people/<slug>.md` — one note per resolved person in the active set.
- `wiki/companies/<slug>.md` — one note per company that has at least one
  active-set contact.
- `wiki/network.md` — a map page with the warm list, reactivation queue, and
  company roster.

**Active set:** people whose Pulse band is GOOD, STRONG, or VERY_STRONG, plus
dormant-warm contacts (the reactivation queue) — i.e. everyone worth keeping
tabs on. Unresolved contacts (LinkedIn handle only, no name match) are excluded.

**What goes in a note:** derived metadata only — band, last interaction date,
per-channel counts and dates, preferred channel, signals, Twenty CRM link. **No
message content is ever written.** The module never queries `interactions.content`
(design-spec privacy rule; conversation summaries wait for the local inference
platform, Borealis).

**`--dry-run`:** prints what would be written/retired without touching the vault.
Always run this first when testing a config change.

**Config:** requires `brainVaultPath` in `~/.lares/config.json`, pointing to
the Heiberg Brain vault root, e.g.:
```json
{ "brainVaultPath": "/Users/bendik/Library/Mobile Documents/com~apple~CloudDocs/Heiberg Industries" }
```

**Owner marker and safe retirement:** every note written by this command
carries `owner: network` in its YAML frontmatter. On regeneration the command
checks that marker before doing anything with an existing file:

- **Files with `owner: network`** — overwritten if content changed; moved to
  the vault's `.trash/` folder if the contact left the active set. Hard
  deletion never happens.
- **Files without the marker** (hand-written notes) — never overwritten and never retired; at most reported as skipped.
- **Unreadable files** — skipped and reported, never fatal.

**`created:` frontmatter** is preserved across rewrites. Runs are idempotent — if nothing changed,
nothing is written.

**launchd:** the daily 09:30 job chains `brain-notes` as the last step,
separated from the digest with `;` (not `&&`) so a failed digest never blocks
note generation. Reload the plist after updating it:

```bash
launchctl unload ~/Library/LaunchAgents/co.heiberg.lares.network-backup.plist
cp ~/Developer/lares-heiberg/local/co.heiberg.lares.network-backup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/co.heiberg.lares.network-backup.plist
```

**Verify first run:** check `/tmp/lares-network-backup.log` after 09:30. A
successful run ends with a line like `brain-notes 2026-06-12: Wrote 0 note(s), 414 unchanged.`

## NAS backup (launchd)

The daily job now refreshes local sources first: it runs
`pnpm network import` and then `pnpm network backup`. If you installed an
earlier version of the plist, re-install it:

```bash
launchctl unload ~/Library/LaunchAgents/co.heiberg.lares.network-backup.plist
cp ~/Developer/lares-heiberg/local/co.heiberg.lares.network-backup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/co.heiberg.lares.network-backup.plist
```

1. Mount the Synology share and set `nasBackupPath` in `~/.lares/config.json`,
   e.g. `{ "nasBackupPath": "/Volumes/backup/lares" }`.
2. Install the daily 09:30 job:
   ```bash
   cp ~/Developer/lares-heiberg/local/co.heiberg.lares.network-backup.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/co.heiberg.lares.network-backup.plist
   ```
3. Verify: `launchctl list | grep network-backup` and check
   `/tmp/lares-network-backup.log` after 09:30. (launchd runs the job at the
   next wake if the Mac was asleep at 09:30.)
