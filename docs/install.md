# Installing Lares on your own server

This guide takes a technical self-hoster from an empty server to a running console with the
backup jobs in place. It follows the one **tested path**: a fresh Ubuntu server and the
installer `services/box/ops/install.sh`. Read
[ADR-0022](decisions/0022-the-tested-install-path.md) for what "tested path" means. Lares is
alpha software; there is no tagged release yet, only release candidates. Try it on a disposable
server first.

The installer stops at the console's "create your first agent" page. Creating the first agent
and talking to it is done in the console and is not covered by this guide beyond a pointer.

## 1. What you need

- **A server.** Ubuntu 24.04, x86-64, root SSH access, at least 6 GiB of memory and 20 GiB of
  free disk. The installer refuses a smaller box and prints the numbers it found. Other Linux
  distributions and macOS are best-effort and have not been tried.
- **Ports 80 and 443 free.** Caddy listens on both and fetches its own certificate.
- **A domain name** whose A record already points at the server (for example `example.com`).
  The installer checks this before it writes anything and stops if the name does not resolve to
  this machine.
- **A model provider key.** The shipped gateway configuration uses an Anthropic API key. A chat
  subscription does not include API access. The installer tests the key with a real call.
- **A Google OAuth client for console sign-in.** Create an OAuth web client in your Google Cloud
  project and register the redirect address `https://example.com/api/auth/callback` (with your
  own domain). You need its client id and client secret. Connecting Gmail and Calendar later
  needs a second client with those scopes; that is done from the console, not at install time.
- **On the server:** Docker with Compose v2, Node.js 24, pnpm 9.15.0, `curl`, and `git`. The
  installer runs small Node commands from the checkout, so Node is needed on the server itself.
  Ubuntu 24.04's own `nodejs` package is version 18 and is too old. As root:

  ```bash
  apt-get install -y docker.io docker-compose-v2 curl git
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
  npm install -g pnpm@9.15.0
  ```
- **A place for backups** that is not this server: an SFTP host, an S3-compatible bucket, or a
  second disk. See section 9.
- **A chat channel.** None is needed to install. Web chat in the console is the first door. Slack
  and Telegram are connected afterwards.

Set the server's time zone before you install (`timedatectl set-timezone <zone>`). The installer
reads it and uses it as the owner's clock for quiet hours and briefs. It does not ask.

## 2. Getting the code and the images

Nothing is built on your server. Images are built in CI and pulled by digest. A release is a
small file that lists the digest of every image. The release candidate in this repository is
`releases/2026-10-16-rc.10.json`.

On the server, as root:

```bash
git clone https://github.com/Heiberg-Industries/lares.git
cd lares
pnpm install --frozen-lockfile
```

The installer runs a few small commands from this checkout (rendering the stack file,
migrating the database), so it needs the dependencies installed from the lockfile. That is the
only install step on the server. No image is built there.

You do not pull images yourself. The installer renders a Compose file from the release file and
starts it, and Docker pulls each image by its digest.

## 3. The folder layout

The installer creates these. You do not make them by hand, except the optional `installation`
folder in section 7.

| Path | What it holds |
| --- | --- |
| `/etc/lares/secrets/` | The installation's secrets, one file each (section 4). Never commit or copy these off the server in plain text. |
| `/etc/lares/installation.env` | The answers to the installer's questions (section 4). |
| `/etc/lares/console-oauth.env` | The Google sign-in client for the console. You create it (section 5). |
| `/etc/lares/keeper.json` | The keeper's configuration, rendered from the release file. |
| `/opt/lares/compose.yaml` | The rendered stack: database, console, gateway, Caddy. |
| `/opt/lares/compose.lares-keeper.yaml` | The keeper and the egress proxy. |
| `/srv/lares/agents/<name>/` | One folder per agent: `agent.json`, `duties.md`, `voice.md`. Written by the keeper when you save an agent in the console. |
| `/srv/lares/retired/` | Definitions of retired agents. |
| `/srv/lares/secrets/` | Keys the keeper creates per agent. Keeper-owned. |
| `/srv/lares/installation/` | Optional. Your installation's own data, such as the deadline calendar (section 7). |
| `/srv/taste/` | The console's taste store. |
| `/var/lib/lares/postgres/` | The database files. |

An agent is a definition, not a build ([ADR-0015](decisions/0015-agents-are-definitions-resolved-at-runtime.md)).
You do not write `agent.json`, `duties.md` or `voice.md` by hand to install. The console's
"new agent" page creates them from a role template and the keeper saves them.

## 4. Settings and secrets

**Secrets** are files in `/etc/lares/secrets/`, owned by root with group id 10001, mode 0440.
They are never environment values. The installer generates these once and never overwrites an
existing file: `console-session-secret`, `database-password`, `eve-route-password`,
`gateway-key`, `gateway-master-key` and `token-enc-key`. It writes your model key to
`model-provider-key`.

Back up `token-enc-key` and `model-provider-key` somewhere safe. If `token-enc-key` is lost,
every saved sign-in to an outside service becomes unreadable (you would reconnect them).

**Settings** the installer asks for, once, and writes to `/etc/lares/installation.env`:

1. the domain,
2. your e-mail address,
3. your name,
4. the model key (read without echo, written straight to its secret file).

You can answer without prompts: `--domain`, `--email`, `--name`, and `--model-key-file <path>`
(a file holding only the key). Never pass the key itself as an argument.

The same file also gets `OWNER_HOME_TZ`, `CONSOLE_ALLOWED_EMAILS` (comma-separated; only these
addresses can sign in), the gateway address and the default model alias. To let a second person
in, add their address to `CONSOLE_ALLOWED_EMAILS` and run the installer again.

Every setting an agent or the console can read is declared in
`packages/vault-format/src/settings.ts`, with what breaks without it.

## 5. Running the installer

First save the console's Google client. On a fresh server the folder does not exist yet, so
create it first:

```bash
mkdir -p /etc/lares
```

Then create `/etc/lares/console-oauth.env`, owned by root, mode 0600, with two lines. Put the
bare values in, without quotes:

```
GOOGLE_CLIENT_ID_CONSOLE=<client id ending in .apps.googleusercontent.com>
GOOGLE_CLIENT_SECRET_CONSOLE=<client secret>
```

If you skip this, the installer does everything else and stops at the end, telling you to create
the file and run it again. Nothing is lost.

Running the installer again is always safe. A re-run keeps the Google mail and calendar settings
you connected earlier, and it restarts the keeper only when its settings file
(`/etc/lares/keeper.json`) actually changed. If that file has been damaged by hand and cannot be
read, the installer stops and says so, without touching it.

Check the box without changing anything:

```bash
./services/box/ops/install.sh --dry-run
```

It prints every problem it finds in one pass, each with a fix to paste. Fix them, then run the
real install from the repository root:

```bash
./services/box/ops/install.sh --release releases/2026-10-16-rc.10.json
```

On a fresh server the real run first asks whether to start fresh or check a backup archive.
Press Enter to start fresh. (`--dry-run` does not ask.) For an unattended run, add `--yes` and the answers:

```bash
./services/box/ops/install.sh --yes --release releases/2026-10-16-rc.10.json \
  --domain example.com --email you@example.com --name "Your Name" \
  --model-key-file /root/model-key.txt
```

The installer then, in order: generates the secrets, writes the four answers, renders and starts
the stack, proves the model key with a real call through the gateway, creates and migrates the
database, makes you the first member of the installation, configures and starts the keeper, and
checks that the console answers at `https://example.com`.

It is safe to run again after any failure. A secret or answer that already exists is left as it is.
An existing `/srv/lares` makes the run an update of what is there, not a fresh start.

Exit codes: 64 bad arguments, 75 a service did not become ready in time, 77 not root, 78 a
check failed (the reason is printed).

`--restore <archive>` only checks that a backup archive is genuine and reports what it holds. It
does not restore. Restoring is a manual procedure in
[the export and restore runbook](runbooks/export-and-teardown.md), section 5.

## 6. First start and checking it worked

When the installer finishes it prints `https://example.com/agents/new`. It says plainly that no
agent is running yet. To check the stack:

```bash
docker compose -f /opt/lares/compose.yaml ps
docker compose -f /opt/lares/compose.yaml logs --tail 200 console caddy
```

You should see `db`, `console`, `lares-gateway` and `caddy` running. The keeper and the egress
proxy run from `/opt/lares/compose.lares-keeper.yaml`; list them with
`docker compose --env-file /etc/lares/keeper.env -f /opt/lares/compose.lares-keeper.yaml ps`.

Then open the console. Signing in with Google as the e-mail address you gave proves the OAuth
client, the domain and the certificate. Create your first agent on `/agents/new`.

## 7. The console and the deadline calendar file

The console is the web page at your domain. Use it to create and edit agents, grant what they
may touch, connect integrations and check backup and model status. Caddy is the only public
listener; Postgres is bound to the server's loopback address only.

The **Deadlines** page can show a standing yearly calendar of statutory deadlines. The engine
ships none. It is installation data, in a JSON file you write:

```json
{
  "jurisdiction": "Example jurisdiction",
  "rules": [
    {
      "key": "annual-report",
      "title": "File the annual report",
      "month": 7,
      "day": 31,
      "yearOffset": 1,
      "recurrence": "yearly",
      "consequence": "A late fee applies."
    }
  ]
}
```

`month` is 1 to 12, `day` 1 to 31, `yearOffset` 0 or 1 (1 means the deadline falls in the year
after the fiscal year it concerns), and `recurrence` is `none`, `yearly`, `bimonthly` or
`monthly`. Every rule needs a unique `key`. Without the file, the page works for deadlines you
add one at a time.

Put the file in the installation folder and make it readable by the console, which runs as user
10001:

```bash
mkdir -p /srv/lares/installation
chmod 0755 /srv/lares/installation
cp deadline-calendar.json /srv/lares/installation/deadline-calendar.json
chmod 0644 /srv/lares/installation/deadline-calendar.json
```

Then run the installer again, with the same release file:

```bash
./services/box/ops/install.sh --release releases/2026-10-16-rc.10.json
```

When `/srv/lares/installation/deadline-calendar.json` exists, the installer mounts it into the
console container read-only, at the same path, and sets `DEADLINE_CALENDAR_FILE` to it. Every
later run keeps doing so, so you never edit `/opt/lares/compose.yaml` by hand. If the file is
there before the first install, the first run picks it up.

The backup, the export and the restore drill include `/srv/lares/installation` when it exists.

The installer also gives your chief-of-staff agent the same file when it exists, read-only, and
tells the agent where to find it. A chief of staff created after the re-run has it from the
start. One that already runs gets it the next time its connections are applied: save a change to
its definition in the console, then press Apply connection changes. The creative agent never
gets it. If the calendar is a link or a folder rather than a plain file, the installer prints a
warning and leaves the agent without it.

Once the chief of staff has the file, keep it in place. If you remove it, run the installer again
before you next change that agent; until then the keeper refuses to apply the agent, because the
file it was told to mount is missing.

## 8. Outside tools, integrations and chat apps

After your first agent runs, connect what it needs from the console: Google accounts under
Integrations, then Slack or Telegram as further doors.

The installer already stored your public address as the door address, so nothing needs editing
on the server. Open the agent in the console and use its "Connect doors" section. You paste the
bot's credentials and press "Connect". The console then saves them, checks them with Telegram or
Slack, switches the door on, applies it to the agent (which restarts it, about a minute) and
prepares a one-time connection that is valid for 10 minutes. Until you complete that last step,
nobody can use the door. When you do, the page notices by itself, applies the last change and
reloads.

**Telegram** (chief-of-staff agent):

1. In Telegram, open the verified @BotFather account and send `/newbot`. Give the bot the
   agent's display name and a username ending in `bot`. Copy the token it gives you; treat it as
   a password.
2. In the agent's "Connect doors" section, paste the token under Telegram and press "Connect".
3. When "Tap to connect" appears, tap it on your phone (or open it in Telegram) and press Start.
   That is the whole connection; nothing is copied or typed.

**Slack** (chief-of-staff and creative agents):

1. Press "Create this Slack app from its manifest" (or "Copy manifest" and paste it under Create
   new app, From a manifest). Slack opens with the app filled in, including this installation's
   request addresses; confirm it.
2. Install the app into your workspace. From it, copy the Bot User OAuth Token (under OAuth &
   Permissions) and the Signing Secret (under Basic Information).
3. Paste both under Slack and press "Connect".
4. When the console shows the message to send, open a direct message with the app in Slack and
   send exactly that (for example `claim 0123...`; "Copy" puts it on your clipboard).

Tools the engine does not ship come in
as outside tool servers listed in the agent's definition ([ADR-0019](decisions/0019-integrations.md)).
If a server needs a key, see [placing a token file](runbooks/outside-tool-tokens.md).

Optional: back up agent definitions to a private Git repository. It is off by default; see
[definition backups](runbooks/definition-backups.md). It is not a server backup.

## 9. Backups and the restore drill

The base install does not switch backups on; `install.sh --backups` does, and the installer's last
message points there. Do not rely on the installation for data you need to keep until backups are
switched on and proven.

One command does it. Before you run it:

1. Install the tools on the server: `apt-get install -y restic age curl`.
2. Make an age key pair **on your own machine**, not on the server: `age-keygen -o lares-backup.key`.
   Keep the private key (the file) there and in a password manager. The server only ever gets the
   public line that starts with `age1`. The encrypted bundle of `/etc/lares` rides in each
   snapshot and only that private key opens it.
3. Decide where backups go: an SFTP host you control, an S3-compatible bucket, or a path on a
   second disk. Create an uptime check (period 1 day, grace 2 hours) at a service such as
   healthchecks.io and note its https address.

Then, as root, from the checkout:

```bash
./services/box/ops/install.sh --backups
```

It asks four things: where backups go, the public age key, the uptime check address and, for an
S3 bucket, the path of a root-only file with the key pair (`AWS_ACCESS_KEY_ID=` and
`AWS_SECRET_ACCESS_KEY=` lines; keys are never typed on the command line). If there is no
repository password yet it makes one, shows it once, and waits until you type `saved`: keep a
copy in a password manager, because without it every backup is unreadable. For an unattended run
pass the answers as flags (`--repository`, `--age-recipient`, `--hc-url`, `--s3-credentials-file`,
`--password-file`, `--password-saved`) with `--yes`; `--help` lists them all and `--dry-run` shows
the plan without changing anything.

It refuses, changing nothing, when an answer is unsafe: a repository on this server's own disk
(unless you pass `--accept-same-machine`, which is a stopgap, not a backup), a password or key
inside the repository address, an age private key, a missing or placeholder uptime address, a
repository that exists but will not open with the password, or an existing
`/etc/lares/backup.env` that disagrees with your answers or has been edited by hand, an older
backup setup in `/etc/agent-box` (pass `--reconfigure` to replace either; the old file or unit is
kept beside the new one as `<name>.previous`), and password or credentials files that are not
owned by root or are readable by others. A repository on this server's own disk, when you accept
it, works but is reported as NOT off-site, never as Protected.
You can run it again safely; with the same answers it changes nothing.

At the end it runs a backup, a restore rehearsal and the daily check once, and prints
**Protected** only if all three passed. Protected means: a snapshot exists, a restore from it
worked, and the check read it back and reached your uptime address. If one fails it names which
and where to read why (`journalctl -u <unit>`). The console's Backup page shows the same state.

What the command does, for those who want to know:

- Copies `backup.sh`, `backup-verify.sh` and `restore-drill.sh` to `/opt/lares/` (mode 0750, root)
  and the six `lares-backup*` and `lares-restore-drill*` units to `/etc/systemd/system/`.
- Writes `/etc/lares/backup.env` (mode 0400) with `LARES_CURRENT_LAYOUT=1`, `RESTIC_REPOSITORY`,
  `RESTIC_PASSWORD_FILE`, `AGE_SECRETS_RECIPIENT`, `HC_URL` and, for S3, the key pair.
- Opens the restic repository, or creates it (`restic init`) only when restic says plainly that
  none exists there. A wrong password never creates a new one.
- Runs `systemctl daemon-reload` and enables the three timers.

The full description of the scripts is in
[`services/box/ops/README.md`](../services/box/ops/README.md).

### Restoring onto a new server

If the server is lost, the nightly snapshot brings the installation back onto a fresh one with
`restore.sh`. Each snapshot also carries two encrypted things only your age key opens: the
settings in `/etc/lares` and the agents' token folder `/srv/lares/secrets` (the sign-ins for each
chat door and outside tool). Restoring the token folder means you do not reconnect them one by
one. A server whose backups were switched on before this was added has no token folder in its
older snapshots; the first nightly backup after updating adds it.

You need: the repository address and password (`/etc/lares/backup.env` and
`/etc/lares/restic-password` are inside the bundle), your age private key file, and a fresh
Ubuntu server with the tools from section 1. The age key never goes onto the new server.

1. **Switch the old server off** (power it down, or stop its services). Two live servers would both
   answer chat and both write to the same backup repository.
2. **Point DNS at the new server now**, before the install: change the domain's A record to the
   new server's address and wait until it resolves there. The installer in step 4 checks this and
   refuses to go on otherwise.
3. **On your own machine**, give restic the repository and the bucket keys. The repository
   address for an S3-compatible bucket is `s3:https://<endpoint>/<bucket>`; for an SFTP host it is
   `sftp:<user>@<host>:<path>`. Set these in your shell (the names restic reads), with your own
   values:

   ```bash
   export RESTIC_REPOSITORY='s3:https://<endpoint>/<bucket>'
   export AWS_ACCESS_KEY_ID='<bucket access key>'
   export AWS_SECRET_ACCESS_KEY='<bucket secret key>'
   export RESTIC_PASSWORD='<repository password>'
   ```

   Then `restic snapshots` should list your snapshots. Use `-r "$RESTIC_REPOSITORY"` as shown
   below, or leave the `-r` off. The repository password is the one you saved when you switched
   backups on. Do not write these values into a file on the new server.
4. **Still on your own machine**, decrypt the bundle and send only the files the new server needs. With
   `restic` and `age` installed locally and the repository reachable from your machine:

   ```bash
   restic -r <repository> dump <snapshot-id|latest> /var/backups/pg/secrets/agent-box-secrets.tar.age \
     | age -d -i lares-backup.key \
     | ssh root@<new-server> 'tar -C / -xf - etc/lares/installation.env etc/lares/console-oauth.env \
         etc/lares/backup.env etc/lares/restic-password etc/lares/secrets srv/lares/secrets'
   ```

   Send exactly those paths. Never `keeper.json` or `keeper.env`: they name the old server's image
   versions. (With `RESTIC_PASSWORD` set, `restic dump` does not ask; for `latest` add
   `--tag nightly`.)
5. **On the new server**, install the same release or a newer one. It reuses the files you just
   sent, so the database comes up with the old password:

   ```bash
   ./services/box/ops/install.sh --yes --release releases/<release-file>.json
   ```

6. **Restore**, as root, from the checkout. `--dry-run` first reads the snapshot and checks
   everything without changing the server:

   ```bash
   ./services/box/ops/restore.sh --snapshot latest --dry-run
   ./services/box/ops/restore.sh --snapshot latest
   ```

   It asks you to confirm the old server is off (for an unattended run pass
   `--yes --old-server-stopped`). It refuses, changing nothing, unless this server is a fresh
   install: no agents, no conversations, no agent running. It also refuses a snapshot written by a
   newer release than this checkout, a snapshot with an unsafe database name or no main database,
   too little free disk, a missing token folder, and a restored address that differs from the one
   the server was installed with (restoring to a different address is not supported yet).
7. **Do what it prints**, in order. The list below is what `restore.sh` prints; steps that do not
   apply to your snapshot are left out of its list and the numbers shift:
   1. Google, once per organisation: add `GOOGLE_CLIENT_ID_<ORG>` and `GOOGLE_CLIENT_SECRET_<ORG>`
      to `/etc/lares/console-oauth.env` if they are not already there, then run
      `python3 services/box/ops/configure-google-keeper.py --org <org>` and restart only the
      keeper: `docker compose --env-file /etc/lares/keeper.env -f /opt/lares/compose.lares-keeper.yaml restart`.
   2. Point DNS for your domain at this server. You already did in step 2; check it still holds.
   3. Only when the snapshot held a deadline calendar: run the installer again with the same
      release so it mounts the calendar:
      `./services/box/ops/install.sh --yes --release releases/<release-file>.json`.
   4. Sign in to the console and open each agent.
   5. Model gateway keys: nothing to do when every agent's key file came back with the token
      folder. For an agent without one, `restore.sh` prints the two
      `rotate-restored-gateway-key.py --agent <name>` commands (a check, then `--execute`) to run
      before applying that agent.
   6. Apply each agent once: press "Start agent (applies saved definition)" when it is stopped, or
      "Apply connection changes (restarts agent)" when the console offers that instead.
   7. Only when an agent has a Telegram door: Telegram remembers the old server's address. After
      the agent is applied, open it in the console, go to its Telegram door and press "Register
      Telegram webhook" once.
   8. Only when `backup.env` names retained file volumes: copying those back is still a manual job.
   9. Check: sign in, send one chat message to an agent and read the reply, and open the Backup
      page to confirm the next backup is scheduled (run `install.sh --backups` again if it is not).

The agents' model keys come back with the token folder, so the old key-repair helper is only
printed for an agent whose key file is missing. If a step fails after the restore has begun, the
server is no longer fresh: rebuild a clean server and start again (the backup repository is never
written to by a restore).

This path has been tested with stand-ins only. Treat the first real restore as a rehearsal:
do it on a spare server before you need it.

To take everything with you, `services/box/ops/export.sh` writes one archive; the runbook explains
how to check it before relying on it.

## 10. Upgrading

Updates are dated releases, each with release notes that list what breaks and how to fix it
([ADR-0021](decisions/0021-releases-and-upgrades.md)). Read the notes for the release first,
for example [rc.10](releases/rc.10-notes.md). To move to a release:

```bash
./services/box/ops/update.sh --release releases/<release-file>.json --dry-run
./services/box/ops/update.sh --release releases/<release-file>.json
```

The update checks that last night's backup was verified, takes a backup, records which images
were running, and pulls the new ones by digest. To put the previous images back, run
`./services/box/ops/rollback.sh`. It goes back one step and does not undo database changes; for
that, restore the backup named before the update.

## Getting help

Lares is a tested path, not supported software. There is no promised response time. Where to ask
and how to report problems is in the [README](../README.md#help). If you get stuck anywhere in
this guide, a note saying where is the most useful thing you can send.
