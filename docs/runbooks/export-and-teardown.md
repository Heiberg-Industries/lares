# Leaving cleanly — export the installation, prove it, restore it elsewhere, then tear this one down

> **This is the written procedure, not a rehearsed one.** Every command below is taken from a
> script in this repository (`services/box/ops/export.sh`, `restore-drill.sh`, `backup.sh`) or
> from the way those scripts already call Postgres, git and tar on the server. Nobody has yet
> walked the whole path end to end. The first rehearsal — on a throwaway server, with a
> throwaway copy of the archive — is the owner's, and it should happen **before** the day this
> is needed for real. Where a step has no rehearsed command behind it, it says so in place.

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

`export.sh` takes what you tell it to take. Its built-in defaults are deliberately small, and
they are **not** the same list your nightly backup uses. Anything you do not name is left
behind, silently as far as the archive is concerned (the script says so in its last lines, but
it cannot know what you meant to include).

Read what the nightly backup actually covers, which is two things — the path list written into
`backup.sh`, and the Docker volumes named in the backup settings file:

```bash
# The directories the nightly snapshot walks:
sed -n '/^PATHS=(/,/^done$/p' /opt/agent-box/backup.sh

# The Eve workflow file/blob volumes it also archives, by volume name:
grep '^LARES_WORKFLOW_VOLUMES=' /etc/agent-box/backup.env

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
- **Do not put `/opt/agent-box` in `EXPORT_DATA_PATHS`.** It contains a `.env` file, and the
  export refuses outright rather than quietly leaving a secret out (section 7). Copy the
  compose files you want by hand, and carry the secrets separately (section 5g).

### 2b. The other settings the export reads

| Setting | What it does | Default |
| --- | --- | --- |
| `EXPORT_VAULT_PATHS` | the bare git repositories to bundle | `/srv/brain.git /srv/atlas.git` |
| `EXPORT_DATA_PATHS` | the directory trees to tar | `/srv/lares /srv/taste` |
| `EXPORT_DIR` | where the finished archive is written | `/var/backups/export` |
| `EXPORT_WORKDIR_ROOT` | scratch space while it works; never `/tmp`, which can be a small RAM disk | `/var/tmp` |
| `LARES_ENGINE_VERSION` | recorded in the manifest, so the archive says which engine wrote it | `unknown` |
| `AGENT_BOX_EXPORT_ENV` | a settings file to read first, if you keep the export's settings apart from the backup's | — |
| `AGENT_BOX_BACKUP_ENV` | the settings file used when the one above is unset | `/etc/agent-box/backup.env` |
| `PGUSER` | the Postgres role the export connects as. An existing installation may use a different role and must set this to its actual role, or the export refuses with "postgres unreachable" | `lares` |

The settings file is optional. If it exists it is *read*, never copied — it is a secret and
stays on this server.

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

```bash
/opt/agent-box/export.sh
```

It reads Postgres through the database container, so the stack must be running. It will refuse
the whole export rather than produce a partial one — every refusal is in section 7.

On success it prints the archive's path and the two lists it used. Read those last four lines
before going any further: they are the script telling you what it did **not** take.

```
export: wrote /var/backups/export/lares-export-<YYYY-MM-DD>.tar
```

Inside that one `.tar` are:

| File | What it is |
| --- | --- |
| `globals.sql` | the Postgres roles, from `pg_dumpall --globals-only` |
| `<database>.dump` | one dump per database, Postgres custom format |
| `<vault>.bundle` | one git bundle per vault, holding every branch and tag |
| `<directory>.tar` | one tar per data directory |
| `manifest.json` | the engine version, the date, and every file's name, size and `sha256` |

No secret is inside. The dumps do hold your saved sign-ins to outside services, but only in
encrypted form — see section 5g.

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
DC="docker compose -f /opt/agent-box/compose.yaml -f /opt/agent-box/compose.override.yaml"
for f in "$CHECK"/*.dump; do
  echo "== $f"
  $DC exec -T db pg_restore --list < "$f" | head -5
done
```

Both compose files, always — `compose.yaml` on its own is an invalid project on this server and
the command exits non-zero for a reason that has nothing to do with your dump.

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

### 4f. Copy the archive off this server, and check it again there

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

This is the path `services/box/ops/restore-drill.sh` rehearses every month against the nightly
snapshot: create a database, `pg_restore` the dump into it through the container, count the
tables. The drill restores into throwaway databases; here you are restoring into the real ones
on a new server, so the steps around the dumps differ, and where they do it is marked.

Before any of this, `services/box/ops/install.sh --restore <archive>` — or choosing "restore
from a backup" on the installer's first screen — re-runs section 4's checks for you and prints
the steps below by name, including which two have never been rehearsed. It never performs a
restore itself; the steps that follow are still yours to run, by hand, on the new server.

Bring the new server up to the point where the stack's database container runs and is empty.
Then:

```bash
DC="docker compose -f /opt/agent-box/compose.yaml -f /opt/agent-box/compose.override.yaml"
RESTORE=$(mktemp -d /var/tmp/lares-restore.XXXXXX)
tar -C "$RESTORE" -xf lares-export-<YYYY-MM-DD>.tar
$DC exec -T db pg_isready -U "${PGUSER:-lares}"
```

### 5a. Roles first

`globals.sql` holds the Postgres roles. Load it before any dump, so a dump that references a
role finds it:

```bash
$DC exec -T db psql -U "${PGUSER:-lares}" -d postgres -v ON_ERROR_STOP=1 < "$RESTORE/globals.sql"
```

*Not rehearsed anywhere in this repository.* The drill asserts `globals.sql` is present but
never loads it. Feeding SQL to `psql` on standard input through `exec -T db` is how this
repository already writes to the database, so the shape is right; the file's own content has
not been replayed. Expect `role … already exists` notices for roles the fresh database created
itself — those are notices, not failures. If `ON_ERROR_STOP=1` aborts on one, read the line it
names; `--no-owner` in 5c means most role problems cost you nothing.

### 5b. Create each database

One per `.dump` file, named exactly as the dump is named:

```bash
for f in "$RESTORE"/*.dump; do
  db=$(basename "$f" .dump)
  echo "== creating $db"
  $DC exec -T db psql -U "${PGUSER:-lares}" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$db\";"
done
```

`CREATE DATABASE` cannot run against the database being created, which is why this connects to
the always-present `postgres` database.

### 5c. Restore each dump

```bash
for f in "$RESTORE"/*.dump; do
  db=$(basename "$f" .dump)
  echo "== restoring $db"
  $DC exec -T db pg_restore --no-owner -U "${PGUSER:-lares}" -d "$db" < "$f"
done
```

`--no-owner` is what the drill uses: object ownership is re-assigned to the connecting role
instead of demanding that every role from the old server exist here with the same name.

Then count what arrived, the way the drill does, and compare it with what you remember of the
old server (the drill's own rule of thumb is that anything below 90% of the original is a
failed restore, not schema drift):

```bash
for f in "$RESTORE"/*.dump; do
  db=$(basename "$f" .dump)
  printf '%s: ' "$db"
  $DC exec -T db psql -U "${PGUSER:-lares}" -d "$db" -tAc \
    "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')"
done
```

### 5d. The vaults

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

*Not rehearsed anywhere in this repository.* No script here restores from a bundle — the check
we do have is `git bundle verify` in section 4d. Two details the bundle does not carry: the
bare repository's `post-receive` hook, which fast-forwards the working clone after every push,
and the working clone's git identity. Both are created by
`services/box/ops/brain-init-remote.sh` and `atlas-init-remote.sh`; those scripts refuse to run
if the bare repository already exists, so copy the hook and the `git config` lines out of them
by hand, or run them first on the empty server and let this loop restore into what they made.

### 5e. The data directories

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

### 5f. What the archive does not contain, and must be re-created by hand

Nothing secret is in the archive, by design. Every item below has to be put on the new server
yourself, from wherever you escrowed it:

- **Everything under `/etc/agent-box`** — the backup settings file and the credentials beside it.
- **`/opt/agent-box/.env`** and the compose files next to it.
- **The token key** (`TOKEN_ENC_KEY`, or the file `TOKEN_ENC_KEY_FILE` points at, by default
  `/run/secrets/token-enc-key`).
- **The OAuth client** — the client id and client secret the installation authenticates with.
- **The model gateway key** and its URL.
- **Every channel token** — the chat bots' tokens, the workspace app's tokens.
- **The backup repository password**, if the new server is to back itself up. Lose it and every
  existing snapshot is unreadable noise.

### 5g. The saved sign-ins, and why losing the token key costs you almost nothing

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
cd /opt/agent-box
docker compose -f compose.yaml -f compose.override.yaml down
```

### 6b. Remove the containers' volumes

```bash
# DESTRUCTIVE — this deletes the live database and every Eve workflow volume.
cd /opt/agent-box
docker compose -f compose.yaml -f compose.override.yaml down -v

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
find /etc/agent-box -type f -exec shred -u {} + 2>/dev/null
rm -rf /etc/agent-box
shred -u /opt/agent-box/.env 2>/dev/null; rm -f /opt/agent-box/.env
[ -d /etc/lares ] && find /etc/lares -type f -exec shred -u {} + 2>/dev/null; rm -rf /etc/lares
rm -rf /run/secrets/*
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
  agent-box-backup.timer agent-box-backup-verify.timer agent-box-restore-drill.timer \
  input-freshness.timer disk-guard.timer compose-drift-guard.timer agent-box-egress.timer
rm -f /etc/systemd/system/agent-box-*.service /etc/systemd/system/agent-box-*.timer
rm -f /etc/systemd/system/input-freshness.* /etc/systemd/system/disk-guard.* \
      /etc/systemd/system/compose-drift-guard.*
systemctl daemon-reload
systemctl list-timers --all | grep -Ei 'agent-box|freshness|disk-guard|drift'   # expect nothing
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
| `refusing — '<path>' is under <root>, which never leaves this box` | You listed a path under the credentials directories. Remove it; carry secrets by hand (5f). |
| `refusing — '<path>' is named .env, which never leaves this box` | Same: drop that path from the list. |
| `refusing — '<path>' is an age-encrypted secret file, which never leaves this box` | Same. |
| `refusing — <dir> contains a secret file that must never leave this box:` | A `.env` or `*.age` file is sitting somewhere *inside* a directory you listed, and the lines under the message name it. Either move that file out of the tree, or drop the directory from `EXPORT_DATA_PATHS` and copy what you need from it by hand. This is what `/opt/agent-box` will always do. |
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

- **`pg_restore: error: could not execute query … role "<name>" does not exist`** — `globals.sql`
  was not loaded, or did not carry that role. Load it (5a), or re-run the restore with
  `--no-owner`, which is what 5c already does.
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
