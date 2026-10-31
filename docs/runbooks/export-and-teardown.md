# Leaving cleanly — export the installation, prove it, restore it elsewhere, then tear this one down

> **Partly rehearsed on a disposable server.** The installer's `/opt/lares` layout
> exported and restored five databases, agent files and separately escrowed
> configuration on 28 September 2026.
> The restore needed a manual orphaned-key repair. The guarded helper below has
> not yet completed a fresh-target run, and recurring backup protection and
> final teardown remain unproved. This runbook covers only an installation made
> by `services/box/ops/install.sh`.

---

## 1. What this is for

Lares runs on a server you control, so leaving it is your decision and nobody else's. This
procedure takes the whole installation — every database, every vault, every data directory —
into one file you can carry to another server, or simply keep. When you are satisfied that the
copy is readable, it then erases the installation you are leaving behind: the containers, the
data, the credentials, and the permissions you gave to outside services.

## 2. Before you start

Run everything as `root`, on the server, over a session that will not drop halfway (`tmux`,
`screen`, or `ssh` with a keepalive). Nothing here reaches the network except your own
`scp` in section 4 and the revocations in section 6.

### 2a. Set the two path lists — the defaults are narrower than your backup

The export defaults to the portable
`/srv/lares/agents`, `/srv/lares/retired`, and `/srv/taste` directories and has no default
vault bundles. It dumps every non-template database through
`/opt/lares/compose.yaml`. **Do not add `/srv/lares` as a whole:** that tree
contains `/srv/lares/secrets`, which holds agent keys. The script refuses a
nested `secrets` directory and common secret filenames. This export does not
include the token encryption key in `/etc/lares/secrets`; recovery needs that
key carried separately through a secure owner-controlled channel.

`export.sh` takes what you tell it to take. Its built-in defaults are deliberately small, and
they are **not** the same list your nightly backup uses. Anything you do not name is left
behind, silently as far as the archive is concerned (the script says so in its last lines, but
it cannot know what you meant to include).

Read what the nightly backup actually covers, which is two things — the path list written into
`backup.sh`, and the Docker volumes named in the backup settings file:

```bash
# The directories the nightly snapshot walks:
sed -n '/^PATHS=(/,/^done$/p' /opt/lares/backup.sh

# The Eve workflow file/blob volumes it also archives, by volume name (no output: none retained):
grep '^LARES_WORKFLOW_VOLUMES=' /etc/lares/backup.env

# …and where each of those volumes actually lives on disk:
docker volume inspect --format '{{.Mountpoint}}' '<volume-name>'
```

Now set both export lists to cover that, space-separated:

```bash
export EXPORT_VAULT_PATHS='/srv/<vault-one>.git /srv/<vault-two>.git'
export EXPORT_DATA_PATHS='/srv/<data-one> /srv/<data-two> <volume-mountpoint> …'
```

Three things to know while you build those lists:

- **`EXPORT_VAULT_PATHS` is for bare git repositories only.** Each one becomes a git bundle.
  The working clone beside it (`/srv/<vault>` next to `/srv/<vault>.git`) is an ordinary
  directory — if you want its uncommitted files too, name it in `EXPORT_DATA_PATHS` as well.
- **A Docker volume is not a path.** The export walks directories; give it the volume's
  mountpoint from the `docker volume inspect` line above.
- **Do not put `/etc/lares` in `EXPORT_DATA_PATHS`.** It holds the installation's credentials, and
  the export refuses outright rather than quietly leaving a secret out (section 7). Copy the
  compose files you want by hand, and carry the secrets separately (section 5d).

### 2b. The other settings the export reads

| Setting | What it does | Default |
| --- | --- | --- |
| `EXPORT_VAULT_PATHS` | the bare git repositories to bundle | empty on a new installation |
| `EXPORT_DATA_PATHS` | the directory trees to tar | `/srv/lares/agents /srv/lares/retired /srv/taste` |
| `EXPORT_COMPOSE_FILE` | Compose file for the database container | `/opt/lares/compose.yaml` |
| `EXPORT_DIR` | where the finished archive is written | `/var/backups/export` |
| `EXPORT_WORKDIR_ROOT` | scratch space while it works; never `/tmp`, which can be a small RAM disk | `/var/tmp` |
| `LARES_ENGINE_VERSION` | recorded in the manifest, so the archive says which engine wrote it | `unknown` |
| `AGENT_BOX_EXPORT_ENV` | a settings file to read first, if you keep the export's settings apart from the backup's | — |
| `AGENT_BOX_BACKUP_ENV` | the settings file used when the one above is unset | `/etc/lares/backup.env` |
| `LARES_PREFIX` | trusted physical root used for an offline rehearsal; leave unset on the installed host | empty |
| `PGDATABASE` | the main database whose retained Vault ownership is reconciled | `lares_state` |
| `PGUSER` | the Postgres role the export connects as. An existing installation may use a different role and must set this to its actual role, or the export refuses with "postgres unreachable" | `lares` |

The settings file is optional. If it exists it is *read*, never copied — it is a secret and
stays on this server.

Provisioned managed Vault stores are mandatory even when `EXPORT_DATA_PATHS` is customized:
the export adds `/srv/vault`, `/var/lib/lares-vault-git`, and the installation inventory directory.
It holds each repository's normal exclusive lock while copying full working trees and bare
repositories, including untracked content. Lock files are excluded. An incomplete inventory,
missing repository, or mismatch with retained database ownership refuses the export. A working
repository may contain a saved commit awaiting a local push; both histories are retained, and
diverged histories refuse verification.

These managed stores are carried in data tar files, not only Git bundles. The manual full-import
and erasure procedure below has not been extended to reconcile their identities and ownership.
Keep the source server and all exported copies until that separate reconciliation is available.
The person-erasure command continues to refuse owned Vault data.

### 2c. Free disk

The export writes everything twice: once into the working directory, then again as the finished
archive. Plan for **roughly twice** the combined size of the database dumps, the vaults and the
data directories, on top of what the server already uses.

```bash
du -sh /srv/<each-path-you-listed>            # what you are about to copy
df -Pk /var/tmp                               # room for the working directory
df -Pk /var/backups                           # room for the finished archive
```

`df -Pk` (not `-h`) because its columns are the same on the server and on your laptop.

## 3. Run the export

Run `services/box/ops/export.sh` from the exact tested source checkout as root and record that
checkout commit. Verify the archive manifest and database dump list, then encrypt it for off-box
transfer.

```bash
sudo bash services/box/ops/export.sh
```

It reads Postgres through the database container, so the stack must be running. It will refuse
the whole export rather than produce a partial one — every refusal is in section 7.

On success it prints the archive's path and the two lists it used. Read those last four lines
before going any further: they are the script telling you what it did **not** take.

```
export: wrote /var/backups/export/lares-export-<YYYY-MM-DD>.tar
```

A second export on the same UTC day gets `-2`, then `-3`, before `.tar`.
The script publishes a complete archive under a new name and keeps earlier
exports intact. Use the exact path printed by that run in every command below.

Inside that one `.tar` are:

| File | What it is |
| --- | --- |
| `globals.sql` | the Postgres roles, from `pg_dumpall --globals-only` |
| `<database>.dump` | one dump per database, Postgres custom format |
| `<vault>.bundle` | one git bundle per vault, holding every branch and tag |
| `<directory>.tar` | one tar per data directory |
| `manifest.json` | the engine version, date, each file's name, size and `sha256`, and the fresh source-store inventory |

No plaintext credential file is inside. Database dumps and agent definitions are
still sensitive; protect and encrypt the archive before off-box transfer. Saved
sign-ins in the dumps are encrypted with a key carried separately — see section 5d.

## 4. Prove the archive is readable — before anything destructive

Do all of this now, while the original installation is still standing. An archive you have not
opened is not an archive.

### 4a. Unpack it into scratch space

```bash
ARCHIVE=/var/backups/export/lares-export-<YYYY-MM-DD>.tar
CHECK=$(mktemp -d /var/tmp/lares-export-check.XXXXXX)
tar -tf "$ARCHIVE"                    # read the list first — nothing is written yet
tar -C "$CHECK" -xf "$ARCHIVE"
ls -la "$CHECK"
```

### 4b. Check every checksum in the manifest

The manifest records a `sha256` per file. Turn it into a checklist and verify the lot — no
`jq` needed, and none is installed on the server:

```bash
cd "$CHECK"
sed -n 's/.*"name": "\([^"]*\)", "size": [0-9]*, "sha256": "\([^"]*\)".*/\2  \1/p' \
  manifest.json > SHA256SUMS
cat SHA256SUMS                        # one line per file — it must not be empty
sha256sum -c SHA256SUMS               # on macOS: shasum -a 256 -c SHA256SUMS
```

Every line must say `OK`. A single `FAILED` is section 7.

### 4c. Check every database dump opens

`--list` reads the dump's table of contents and writes nothing at all. Run it through the
database container, so the `pg_restore` version always matches the server that wrote the dump:

```bash
DC="docker compose -f /opt/lares/compose.yaml"
for f in "$CHECK"/*.dump; do
  echo "== $f"
  $DC exec -T db pg_restore --list < "$f" | head -5
done
```

### 4d. Check every vault bundle

```bash
for b in "$CHECK"/*.bundle; do
  echo "== $b"
  git bundle verify "$b"
done
```

`git bundle verify` prints the refs the bundle carries and whether it needs anything the bundle
does not contain. It exits non-zero if the file is damaged, which is the part that matters here.

### 4e. Check every data tar

```bash
for t in "$CHECK"/*.tar; do
  echo "== $t"
  tar -tf "$t" | head -5
  tar -tf "$t" | wc -l
done
```

The first path in each listing is the directory name the tar will recreate — note it; section 5
needs the directory it sat in.

### 4f. Run the inspection-only import preview

On a machine with the installed `lares` command, you can independently check the archive's
manifest, checksums, paths, nested data archives and source migration ledger:

```bash
sudo lares import-preview "$ARCHIVE"
```

The command accepts an optional explicit source-to-destination mapping file:

```bash
sudo lares import-preview "$ARCHIVE" --member-map ./member-map.json
```

The JSON file has `version: 1`, a `members` list, and an `organizations` list. Each list entry has
only `sourceId` and `destinationId`. The preview validates IDs and uniqueness, but it does not
check that a destination member or organisation exists or grant anyone authority. If the map is
omitted or incomplete, the members category remains partial with the unresolved source IDs listed.
The preview reports row counts and checksums for the pinned `users`, `orgs`, `org_member_policy`,
and `user_aliases` tables, plus candidate tables for facts, settings, and suppression. It reports
explicit owner mappings and per-column unresolved dependency counts while keeping names, emails,
policy values, aliases, setting values, and raw rows out of its output. Alias records remain historical evidence,
not verified provider identities.

The preview accepts only the verified rc.12 source schema and identifies rc.13 as the destination.
It uses a locally cached, digest-pinned database helper with network disabled; if that image is not
already present, the command stops instead of downloading it. It does not connect to a live
database, write to the installation, or print archived row values. Its result is deliberately **blocked for import**:
the members category is source-inventoried only when all four pinned tables decode and both maps are
complete; otherwise it is partial. Facts, settings, and suppression are counted and hashed but
remain partial while owner, record, and destination mappings are unresolved. The other 18
categories remain `not-inventoried` until their record and file mappings are complete. Keep the
source and archive; this check is not approval to
restore or erase.

### 4g. Import mapping coverage contract (rc.12 to rc.13)

This is the source and mapping boundary for a future read-only import plan. `lares import-preview`
remains inspection-only and import remains blocked. It inventories the four listed members-source
tables and applies only explicit member and organisation ID mappings. It also counts and hashes
16 candidate tables across `facts`, `settings`, and `suppression`, reports direct owner mappings,
and lists rows whose owner or record dependencies are unresolved. `conversation_retention` also
appears in the conversations contract; `initiations` and `email_triage_processed` also appear in
the jobs and sync contracts. This slice reports those source rows in the settings/suppression
evidence only; a future manifest must settle cross-category row ownership before counting them
elsewhere. These three categories remain
partial; the other 18 categories remain `not-inventoried`. The table below is a coverage contract for the verified source schema,
not evidence that an archive has been completely inventoried or can be restored.

The accepted Box source is exactly `2026-10-21-rc.12`, whose `lares_state` migration ledger has
these six files and checksums. The hashes match the SQL files committed here:

| Source migration | SHA-256 |
| --- | --- |
| `001_baseline.sql` | `a2a50ac42a53b25ba28faf41e8b8970354292f131e0e673cb7cc2a0001fa725a` |
| `002_standing_facts.sql` | `8d1abbab5d997af30f185454aac3a46407bc6d96fde2f555065522fd0df7b58a` |
| `003_outside_tool_seen.sql` | `a7a43c6ae74466e398935afac6ec379f39ee2ccdf7d4ca8e78b2cdc482949cfa` |
| `004_web_inbox.sql` | `56c5e04433aa350c9ed7bbed4d7aa0eb533d910f921cba2fe526183ac262dd0b` |
| `005_model_steps.sql` | `e1ecab54f9c18c63b057f7970c70fa835ebeb0e09381b6295c4f64a20a91be66` |
| `006_approval_session.sql` | `2de295f5c742a004addeb28579d579865bb7832a5d5287be742d0e2e7944827b` |

The 74 table names below are the exhaustive `public` table inventory declared by those six Box
migrations, including `schema_migrations`. They say nothing about table rows. The export includes
every non-template database. The helper reads `schema_migrations`, the four pinned members tables,
and the 16 candidate facts, settings, and suppression tables from `lares_state.dump`; extra database dumps are not known to be empty or
compatible. The source
baseline also says that role workflow schemas and dream tables are created outside the Box
migrations. The rc.12 release record identifies the chief-of-staff workflow upgrade, but the
current preview does not validate those schema ledgers or inventory those rows. Treat other
database names, runtime-created schemas, and any unrecognized source table as unverified and
blocking until separately covered by a pinned source map.

```text
agent_avatars             agent_conversations       agent_definitions
agent_door_claim_audit    agent_door_connections    agent_doors
agent_notes               agent_registry            agent_resources
approval_asks             approval_events           atlas_notes
atlas_proposals           audit                     backup_status
brief_settings            clipping_choice           clipping_items
clipping_requests         clipping_sources          confirmations
conversation_entries      conversation_retention    cross_member_grants
cross_member_reads        deadline_candidates       deadline_settings
deadlines                 digest_requests           digest_skips
email_triage_processed    email_watch_cursors       forget_ledger
heartbeat                 initiations               keeper_audit
keeper_credentials        meeting_followup_sent      memory_proposals
memory_reads              memory_use                model_steps
notion_sync_docs          notion_sync_fidelity      notion_sync_proposals
notion_sync_run           oauth_tokens              obligation_threads
org_member_policy         orgs                      outreach_threads
outside_tool_pins         owner_clock_signals       proactivity_settings
ratchet                   ratchet_audit             reminders
repairs                   schedule_settings        schema_migrations
sessions                  settings                  settings_audit
standing_facts            telegram_daily_log        telegram_session_rotation
trigger_schedules         update_history            user_aliases
users                     voice_exemplar            voice_profile
web_inbox                 workflow_jobs
```

The v1 category inventory must account for every category, including zero-count categories, and
must not turn a candidate table name into a claim about its rows. These source candidates and
gaps define the mapping work:

| v1 category | rc.12 source evidence | Mapping boundary |
| --- | --- | --- |
| `members` | `users`, `orgs`, `org_member_policy`, `user_aliases` | `users.id` is a source member key and `user_aliases.user_id` refers to it. Map each source member to an explicit destination member; names, emails, old owner roles, and organization membership do not select or create current authority. |
| `identities` | `user_aliases`; `oauth_tokens` carries provider and email labels | An alias or email is not a verified provider identity. Require a separately verified issuer/subject/tenant mapping or mark reconnection required. |
| `grants` | `cross_member_grants`, `cross_member_reads`, `org_member_policy` | These rows are historical source evidence, not current rc.13 grants. Each retained grant needs an explicit resource and member mapping plus fresh authority review; never widen sharing by inference. |
| `agents` | `agent_registry`, `agent_definitions`, `agent_avatars`, `agent_notes`, `agent_resources`, `agent_doors`, `agent_door_connections`, `agent_door_claim_audit` | Preserve source agent keys only through an explicit unique mapping. Adoption, stewardship, and member ownership require current destination identities and must not be inferred from a label or old administrator role. |
| `accounts` | `oauth_tokens`, `keeper_credentials` | The source dump contains encrypted sign-in material. Ordinary import must exclude its values, flag its presence without exposing them, and require a separately protected transfer or reconnection decision. Account IDs, generations, consent, and automation mode need explicit destination mappings. |
| `resource-bindings` | `agent_resources`, `agent_doors`, `outside_tool_pins` | These source associations do not establish the rc.13 account/resource binding contract. Map only with explicit stable account, resource, and owner identities; labels alone confer no authority. |
| `conversations` | `conversation_entries`, `agent_conversations`, `sessions`, `conversation_retention` | Preserve recoverable history. Archive-only is the sole approved usability fallback; it does not make history available in a destination session or establish current readers. |
| `vault` | Optional `.bundle` and data `.tar` members; no rc.12 Box vault-area table is in the pinned schema | File presence, ownership, area identity, and contents are not proven by counting bundle/tar members. Require explicit source-to-destination area and file mappings; keep private areas private. |
| `facts` | `standing_facts`, `memory_proposals`, `memory_reads`, `memory_use`, `agent_notes` | Preserve the source owner/provenance fields only after mapping their owner to a destination member. Rows without a resolvable owner remain blocked. |
| `taste` | The optional `/srv/taste` data directory; `voice_exemplar`, `voice_profile` | File and voice-profile ownership are not established by the archive manifest. Require explicit resource/member mapping and preserve the existing audience. |
| `archives` | Exported `.tar` and `.bundle` members | This is an archive-level disposition, not a substitute for inventorying the files and records inside. List each archive and its verified digest; unresolved contents remain blocked. |
| `jobs` | `workflow_jobs`, `trigger_schedules`, `initiations`, `reminders`; role `workflow` schemas are separately created | The Box rows do not carry all rc.13 job authority references, and role workflow ledgers are not checked by the current preview. Inventory those sources separately. Every imported job stays disabled and pending adoption. |
| `approvals` | `approval_asks`, `approval_events`, `confirmations` | These are historical records, not fresh exact-action approvals. Keep imported approvals disabled; never treat a prior approval as current authority. |
| `actions` | No dedicated action table appears in the pinned Box schema | No zero is established for other databases or runtime schemas. Any discovered action records need explicit owner/provenance mapping and remain disabled. |
| `budgets` | No budget table appears in the pinned Box schema | No zero is established for other databases or runtime schemas. Preserve financial/suppression evidence only through an explicit mapping; do not reset liability by omission. |
| `settings` | `settings`, `settings_audit`, `brief_settings`, `deadline_settings`, `proactivity_settings`, `schedule_settings`, `conversation_retention` | Inventory each setting and its provenance. Do not apply source values to a different owner or broaden a setting's audience. |
| `safety` | `forget_ledger`, `ratchet`, `ratchet_audit`, `repairs`, `audit`, `keeper_audit` | Preserve suppression and safety state without weakening it. A forget record is hash-only; no forgotten content or reversible identity may be reconstructed from it. |
| `sync` | `notion_sync_docs`, `notion_sync_fidelity`, `notion_sync_proposals`, `notion_sync_run`, `email_watch_cursors`, `email_triage_processed` | Sync state is not proof that a connection still exists. Map the source link and destination resource explicitly; unresolved or stale connections require reconnection. |
| `suppression` | `forget_ledger`, `digest_skips`, `initiations`, `email_triage_processed` | Preserve each suppression key and scope without turning it into content or dropping it as operational data. Unreadable/unmapped suppression blocks import. |
| `contacts` | No dedicated contact table appears in the pinned Box schema; `atlas_*` and `notion_sync_*` may refer to people | These candidates need row-level classification. Do not infer a contact identity from a display name or email, and do not report zero until other schemas and files are inventoried. |
| `source-links` | `notion_sync_docs`, `notion_sync_fidelity`, `notion_sync_proposals`, `clipping_sources`, `clipping_items` | Source IDs and paths are not destination permissions. Preserve links only with explicit source, owner, and destination-resource mappings. |
| `domain-records` | `atlas_notes`, `atlas_proposals`, `clipping_*`, `deadline_*`, `deadlines`, `obligation_threads`, `outreach_threads`, `web_inbox`, `digest_requests`, `digest_skips` | Retained records need their own owner, source, dependency, and provenance mapping. The current schema names alone do not prove complete CRM, Tracks, calendar, or mail-cache coverage. |

These source tables are also in the verified 74-table set, but this design has not assigned them
to an import category or chosen a safe disposition: `backup_status`, `clipping_choice`,
`clipping_requests`, `deadline_candidates`, `heartbeat`, `meeting_followup_sent`, `model_steps`,
`owner_clock_signals`, `schema_migrations`, `telegram_daily_log`, `telegram_session_rotation`,
and `update_history`. That is an explicit unresolved part of the mapping. `schema_migrations` is
used as source-schema evidence only; whether the other operational records are preserved, reset,
or blocked needs an evidenced rule before an inventory can be complete.

For a record-level plan, `users.id` is the only source member key identified here. Every foreign
member reference must pass through an explicit source-member-to-destination-member map. Do not
match by email, display name, provider label, or presumed single-owner status. `oauth_tokens.id`
is a source token-row identifier, not a destination connected-account identity; its encrypted
fields stay out of the ordinary plan. Existing approvals, jobs, actions, and account metadata do
not carry renewed authority. Pending jobs, actions, and approvals remain disabled after any
future import.

The current `ImportManifest` schema can record category counts/checksums, source-to-destination
IDs, a provenance label, and protected-account transfer dispositions. It does not record
per-record dependency edges or a reason for each unresolved omission. A future preview must make
those dependencies and omissions reviewable alongside the manifest, or keep the plan blocked;
schema validation or a `reconciled` label alone is not evidence of complete mapping. The current
members evidence reports dependency counts and explicit unresolved member/organisation IDs while
keeping policy values and alias labels out of output. It does not grant capabilities or verify a
destination account.

Fresh exports write `inventoryVersion: 1` and `sourceInventory` into `manifest.json`. The exporter
binds every database dump, data archive, Vault bundle and globals file to its member checksum.
For each database dump it records dump-observed schema names from explicit schema entries
and recognized object namespace fields in `pg_restore --list`; a valid list may be empty and does
not prove that the source catalog has no schemas. The preview independently reads that metadata
from the archived dump and refuses a mismatch. It does not run archived SQL or read row values
for this check. The inventory records configured data-root kinds,
whether that configured list was empty, known absent optional roots, whether the Vault list was
empty, and that encrypted credentials may be present in database dumps while credential files
are excluded. Raw source paths and credential values are not included.

This declaration covers only the database and file stores that the exporter observed from its
database list and configured path lists. A store outside those lists remains unverified. Schema
names do not establish table or row coverage, compatibility with an older source release, or
identity mappings. Protected credentials remain blocked from ordinary import. The preview decodes
the four pinned members tables and 16 candidate facts, settings, and suppression tables after
verifying the fresh export metadata. It emits only aggregate counts, checksums, explicit owner
mappings, unresolved source-member IDs, and counts for owner values that do not match a source
member. It never emits record values or unmatched owner text, including arbitrary JSON settings
values. `memory_proposals` has no member-owner column; settings and audit rows have values and actors
without a verified destination owner; `digest_skips` and `email_triage_processed` have no
member-owner column; resource and record references are not mapped to destination records.
`conversation_retention` overlaps conversations; `initiations` overlaps jobs; and
`email_triage_processed` overlaps sync. This slice reports each such table only in its selected
group and leaves any cross-category row disposition unresolved. Therefore these three categories
remain partial even when the member map is complete. The other 18
application categories remain `not-inventoried`, incomplete member/org mappings keep the members
category partial, and import remains blocked.

An older archive has no verifiable inventory declaration. `lares import-preview` refuses it;
there is no sidecar declaration path. Make a fresh export with an exporter that writes this
inventory. Freshness alone does not prove compatibility with its source schema.

Until every category has actual counts and checksums, every source table/archive has a reviewed
disposition, all identities and dependencies map uniquely, protected credentials have a separate
resolved path, and no omission remains, the inventory is incomplete and import remains blocked.
No destination write or apply behavior is specified by this coverage contract.

### 4h. Copy the archive off this server, and check it again there

A copy that exists only on the server you are about to erase is not a copy.

```bash
# from your own machine, NOT from the server:
scp root@<server>:/var/backups/export/lares-export-<YYYY-MM-DD>.tar .
shasum -a 256 lares-export-<YYYY-MM-DD>.tar          # macOS
sha256sum   lares-export-<YYYY-MM-DD>.tar            # Linux
```

Compare that against the same command run on the server:

```bash
sha256sum /var/backups/export/lares-export-<YYYY-MM-DD>.tar
```

The two strings must be identical, character for character. Keep a second copy somewhere else
again — a different disk, a different building. Then clean up the scratch directory:

```bash
rm -rf "$CHECK"
```

## 5. Restoring on a fresh server

> **Restoring from the nightly restic snapshot?** Use `services/box/ops/restore.sh` instead of
> the steps below; it is the guided form of the current `/opt/lares` sequence. See
> [Restoring onto a new server](../install.md#restoring-onto-a-new-server). The procedure in this
> section stays the reference for an export archive and for what `restore.sh` does underneath.

> The sequence below was rehearsed on a separately rebuilt, disposable Ubuntu server on
> 28 September 2026. It is an operator procedure, not an automatic `install.sh --restore` path.

### Restore sequence, rehearsed on a disposable target

1. Verify the new server's SSH host key through the provider's console and pin
   it before transferring the escrow. Install the same digest-pinned release
   and Postgres image used for the export. If reusing the original credentials,
   stream only `installation.env`, `console-oauth.env` and `secrets/` from the
   separate `/etc/lares` escrow before installing. This leaves installer marker
   files out until the fresh installer has created its databases. Preserve the
   age identity and ciphertext off the box until the live checks finish.
2. Stop application services, leaving the new Postgres container up. Decrypt
   the export over the pinned SSH connection into a root-only directory on the
   new server. Verify each file's size and SHA-256 against `manifest.json`
   **before** replacing databases. The rehearsal used `/var/tmp/lares-restore`.

   ```bash
   docker compose --env-file /etc/lares/keeper.env -f /opt/lares/compose.lares-keeper.yaml stop
   docker compose -f /opt/lares/compose.yaml stop console caddy lares-gateway
   ```

3. On that *fresh, disposable target only*, replace the four databases created
   by the installer, using the database container's matching `pg_restore`.
   `postgres` already exists and its dump is restored into it. The fresh
   `lares` role already uses the escrowed database password; `globals.sql` is
   verified in the manifest but was not replayed in this rehearsal.

   ```bash
   RESTORE=/var/tmp/lares-restore
   DC='docker compose -f /opt/lares/compose.yaml'
   for db in empty_workflow litellm lares_0000000000000000000000000000000 lares_state; do
     $DC exec -T db dropdb -U lares --if-exists --force "$db" </dev/null
     $DC exec -T db createdb -U lares "$db" </dev/null
     $DC exec -T db pg_restore --exit-on-error --no-owner --no-privileges -U lares -d "$db" < "$RESTORE/$db.dump"
   done
   $DC exec -T db pg_restore --exit-on-error --no-owner --no-privileges -U lares -d postgres < "$RESTORE/postgres.dump"
   ```

   The agent database name above belongs to this particular export. On another
   export, derive the list from verified `.dump` names and validate each name
   before using it in a shell command. Redirect non-restore `docker compose
   exec` calls from `/dev/null` when the loop itself is read from standard
   input; otherwise a child process can consume the rest of the script.
4. Extract `agents.tar` and `retired.tar` under `/srv/lares`, then restore the
   complete `/etc/lares` escrow (including Keeper's configured Google client).
   Start the base compose file, then the Keeper compose file with
   `--env-file /etc/lares/keeper.env`. Verify table and key row counts, HTTPS
   sign-in, the owner session, agent definition, and OAuth connection.
5. This export intentionally excludes `/srv/lares/secrets`. A restored LiteLLM
   database can therefore retain an agent key alias whose plaintext is gone.
   Before reconciling each affected agent, run the guarded helper from the
   **same checked-out release source** on the freshly restored target:

   ```bash
   sudo python3 services/box/ops/rotate-restored-gateway-key.py --agent <exact-agent-name>
   sudo python3 services/box/ops/rotate-restored-gateway-key.py --agent <exact-agent-name> --execute
   ```

   The first command only checks. The second removes exactly one hash through
   the authenticated gateway API. Both refuse if the agent's plaintext key or
   any Compose agent container still exists, if the restored resource is not
   owned and ready, or if the gateway key's alias, policy and metadata do not
   match. The helper never prints the hash or master key. After it reports a
   verified deletion, retry the audited `definition.reconcile` with the saved
   definition hash, and confirm a new key file, healthy runtime and
   `pending: false`. If the helper refuses, inspect the cause; never delete a
   key by alias alone or run this repair against an active agent. The 29
   September `restore-proof` rehearsal exercised the corrected helper on a
   rebuilt target, then verified an audited reconcile, replacement key and
   provider-backed chat.
6. Confirm the restored conversation after reload and perform a bounded live
   provider read using the restored OAuth token. The rehearsal completed Gmail
   and Calendar reads without a write. Only after this proof should the
   temporary extracted files and off-box age escrow for this rehearsal be
   removed. This procedure does not configure nightly backup protection.

This is the path `services/box/ops/restore-drill.sh` rehearses every month against the nightly
snapshot: create a database, `pg_restore` the dump into it through the container, count the
tables. The drill restores into throwaway databases; here you are restoring into the real ones
on a new server, so the steps around the dumps differ.

Before any of this, `services/box/ops/install.sh --restore <archive>` — or choosing "restore
from a backup" on the installer's first screen — re-runs section 4's checks for you and reports
what the archive holds. It never performs a restore itself; the steps above are yours to run, by
hand, on the new server.

Notes on step 3: restore each dump with `pg_restore --no-owner`, so object ownership goes to the
connecting role instead of demanding that every role from the old server exist here. If a restore
stops with `role "<name>" does not exist`, that flag was left off. Count what arrived and compare it
with what you remember of the old server; anything below 90% of the original is a failed restore,
not schema drift.

### 5a. The vaults

Each `.bundle` is a complete git repository in one file. Clone it back into a bare repository at
the path the installation expects:

```bash
for b in "$RESTORE"/*.bundle; do
  name=$(basename "$b" .bundle)
  git clone --bare "$b" "/srv/${name}.git"
  git -C "/srv/${name}.git" remote remove origin      # the bundle file is not a remote
  git -C "/srv/${name}.git" symbolic-ref HEAD refs/heads/main
  git clone "/srv/${name}.git" "/srv/${name}"         # the working clone the agents read
done
```

*Not rehearsed anywhere in this repository.* An installation has no vault bundles unless you
listed some in `EXPORT_VAULT_PATHS`. No script here restores from a bundle — the check
we do have is `git bundle verify` in section 4d. Two details the bundle does not carry: the
bare repository's `post-receive` hook, which fast-forwards the working clone after every push,
and the working clone's git identity. Recreate both by hand on the
new server before restoring into the bare repository.

### 5b. The data directories

Each `.tar` recreates one directory, and the listing from section 4e told you its name. Extract
it into the directory that held it — `/srv/<name>.tar` came from `/srv`:

```bash
# DESTRUCTIVE — this overwrites files of the same name at the destination.
# Only run it on the fresh server, after section 4 passed.
tar -C /srv -xf "$RESTORE/<name>.tar"
```

Agent definitions ride along here: they live under `<data-path>/agents/<name>/` as plain
`agent.json`, `duties.md` and `voice.md` files, so a restored data directory brings the fleet's
definitions with it.

### 5c. What the archive does not contain, and must be re-created by hand

Nothing secret is in the archive, by design. Every item below has to be put on the new server
yourself, from wherever you escrowed it:

- **Everything under `/etc/lares`** — the installation's answers, secrets and backup settings.
  (The nightly backup carries them in an encrypted bundle; an export does not.)
- **The compose files** under `/opt/lares`. The installer renders them again from the release file.
- **The token key** (`/etc/lares/secrets/token-enc-key`).
- **The OAuth client** — the client id and client secret the installation authenticates with.
- **The model gateway key** and its URL.
- **Every channel token** — the chat bots' tokens, the workspace app's tokens.
- **The backup repository password**, if the new server is to back itself up. Lose it and every
  existing snapshot is unreadable noise.

### 5d. The saved sign-ins, and why losing the token key costs you almost nothing

The database dumps do carry your connections to outside services, but only as ciphertext:
`services/box/lib/crypto.ts` encrypts each stored token with AES-256-GCM under the installation's
token key, with the nonce stored inside the blob and no key derivation in between. The key is a
secret and is never in the archive.

- **If you carry the token key over by hand**, the restored rows decrypt and every connected
  account keeps working with no further action.
- **If you do not have the key**, the rows are unopenable — and that is all. They are not lost
  data; they are saved permissions. **Connect each outside account again** on the new
  installation and it re-authorises in the normal way. The key is worth carrying because it
  saves you an afternoon of clicking, not because anything is unrecoverable without it.

Afterwards, check the new installation the way any connection is checked: the console lists the
connected accounts, and one read against each service succeeds from the agent.

## 6. Tearing the old installation down

**Do not begin this section until section 4 passed, the archive is off this server, and — if you
are moving rather than stopping — section 5 has the new installation answering.** Every command
below is irreversible.

### 6a. Stop the stack

```bash
# DESTRUCTIVE — the fleet stops serving here. Nothing further is reversible.
docker compose --env-file /etc/lares/keeper.env -f /opt/lares/compose.lares-keeper.yaml down
docker compose -f /opt/lares/compose.yaml down
```

### 6b. Remove the containers' volumes

```bash
# DESTRUCTIVE — this deletes the live database and every Eve workflow volume.
docker compose -f /opt/lares/compose.yaml down -v

docker volume ls                       # anything named for this installation and still listed
docker volume rm '<volume-name>'       # one at a time, reading each name before you press enter
```

### 6c. Remove the data directories

```bash
# DESTRUCTIVE — the vaults, the stores and the agent definitions go here.
rm -rf /srv/<data-one> /srv/<data-two> /srv/<vault-one>.git /srv/<vault-two>.git /srv/<vault-one>
```

### 6d. Shred the credentials

```bash
# DESTRUCTIVE — after this the archive's encrypted sign-ins can never be opened again.
[ -d /etc/lares ] && find /etc/lares -type f -exec shred -u {} + 2>/dev/null; rm -rf /etc/lares
[ -d /srv/lares/secrets ] && find /srv/lares/secrets -type f -exec shred -u {} + 2>/dev/null
```

`shred` overwrites the bytes in place, which is exactly right on a plain disk and only
approximately right on a copy-on-write or journalling filesystem, on an SSD that relocates
writes, or on a virtual machine whose disk image lives somewhere else. Treat it as a good
first move, not a guarantee: the reliable erase is destroying or wiping the whole disk — for a
rented server, deleting the machine and its snapshots at the provider.

### 6e. Remove the timers

```bash
# DESTRUCTIVE — the backup, verify, drill and guard jobs stop for good.
systemctl disable --now \
  lares-backup.timer lares-backup-verify.timer lares-restore-drill.timer
systemctl disable --now disk-guard.timer 2>/dev/null || true   # optional unit; only if you installed it
rm -f /etc/systemd/system/lares-*.service /etc/systemd/system/lares-*.timer
rm -f /etc/systemd/system/disk-guard.*
systemctl daemon-reload
systemctl list-timers --all | grep -Ei 'lares-|disk-guard'   # expect nothing
```

### 6f. Revoke the access you gave to outside services

Deleting the server does not withdraw permission; the tokens it held are still valid until the
service that issued them is told otherwise. Do each of these at the service itself, in its own
settings — this runbook does not walk you through anyone else's screens, because they change.

- **The calendar and mail provider:** for each connected account, remove this installation's
  access in that account's own third-party-access settings, and disable or delete the OAuth
  client if it was created only for this installation.
- **The workspace chat service:** uninstall the app from the workspace, and rotate or revoke its
  tokens.
- **The messaging bot service:** revoke the bot's token, or delete the bot outright.
- **The model gateway:** delete the API key this installation used, and check the billing page
  afterwards to confirm nothing is still calling with it.
- **Anything reached over SSH** — a backup target, a git host: remove this server's public key
  from that host's authorised keys.

### 6g. What a teardown does not reach

Say this out loud before you consider the job done. Erasing the server does **not** erase:

- **Your off-site backups.** They live at the storage target under its own retention rules and
  will keep existing until you delete them there on purpose. The key the server backed up with
  is deliberately append-only — it cannot delete anything — so deleting the snapshots takes the
  second key from your own machine, or the provider's own controls. Decide deliberately: those
  snapshots are also your last copy.
- **Any git remote a vault was pushed to.** A vault that was mirrored to a hosted repository is
  still there, in full history, under that account.
- **Anything already sent out.** Messages delivered, calendar events created, documents written,
  and whatever the model gateway or a chat service retains in its own logs under its own
  retention. Those live in other people's systems now, and only those systems can remove them.

## 7. If something goes wrong

### The export refuses

Every one of these stops the whole export rather than producing an archive that is quietly
missing something. The message is on standard error and names the path.

| What it says | What to do |
| --- | --- |
| `refusing — '<path>' is under <root>, which never leaves this box` | You listed a path under the credentials directories. Remove it; carry secrets by hand (5c). |
| `refusing — '<path>' is named .env, which never leaves this box` | Same: drop that path from the list. |
| `refusing — '<path>' is an age-encrypted secret file, which never leaves this box` | Same. |
| `refusing — <dir> contains a secret file that must never leave this box:` | A `.env` or `*.age` file is sitting somewhere *inside* a directory you listed, and the lines under the message name it. Either move that file out of the tree, or drop the directory from `EXPORT_DATA_PATHS` and copy what you need from it by hand. |
| `working directory root '<path>' does not exist` | `EXPORT_WORKDIR_ROOT` points nowhere. Point it at a disk-backed directory with room (2c). |
| `postgres unreachable — refusing an incomplete export` | The stack is not running, or the database container is not healthy. Start it and try again. |
| `postgres returned NO databases — refusing an incomplete export` | The server answered but listed nothing. Do not work around this: something is wrong with the database, and an export now would be empty. |
| `no dumps produced` / `dumped N of M databases — refusing an incomplete export` | A database was skipped. Check the disk has room (2c) and re-run; a partial export restores to a partial installation. |
| `vault path '<path>' does not exist — refusing an incomplete export` | A path in `EXPORT_VAULT_PATHS` is wrong or already gone. Fix the spelling — do not just delete the entry unless you are sure. |
| `data path '<path>' does not exist — refusing an incomplete export` | The same, for `EXPORT_DATA_PATHS`. |

The export cleans up after itself on every exit, successful or not: the working directory under
`EXPORT_WORKDIR_ROOT` is removed either way, so a refusal leaves nothing half-written.

### A checksum does not match

If `sha256sum -c` reports `FAILED` for any file, or the archive's checksum differs between the
server and your own machine, **do not continue to section 6.** Treat the copy as bad:

1. Re-copy the archive (4f) and compare again — a truncated transfer is the common cause, and it
   is harmless once repeated.
2. If the checksum is wrong on the *server* too, the archive itself is bad. Delete it and run
   the export again (section 3). Check free disk first: a full disk produces exactly this.
3. Never edit `manifest.json` to make a check pass. The manifest is the only independent record
   of what the archive should contain.

### A restore fails

- **`pg_restore: error: could not execute query … role "<name>" does not exist`** — re-run the
  restore with `--no-owner`, as step 3 does. (`globals.sql`, the Postgres roles, is verified in the
  manifest but was not replayed in the rehearsal.)
- **`database "<name>" already exists`** — you are restoring onto a server that is not empty.
  Stop. Decide deliberately whether that database is wanted; do not drop anything on the new
  server while it is the only thing standing.
- **A version complaint from `pg_restore`** — run it *through* the database container, as every
  command here does. A `pg_restore` installed on the host can be older than the server that
  wrote the dump, and then it refuses the file.
- **`git bundle verify` says a prerequisite is missing** — the bundle was created with `--all`
  from a complete repository, so it should need no prerequisite. A bundle that asks for one is a
  damaged file: go back to the checksum (4b).
- **A restored database has far fewer tables than the old one** — the dump restored to almost
  nothing. Re-check that dump's checksum and its `pg_restore --list` output before trusting any
  of it.

If a restore cannot be made to work and the old installation is still standing, that is the
whole reason section 4 comes first. Nothing in section 6 has happened yet.
