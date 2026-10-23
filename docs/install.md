# Installing Lares on your own server

This guide takes a technical self-hoster from an empty server to a running console with the
backup jobs in place. It follows the one **tested path**: a fresh Ubuntu server with Docker, and one downloaded script,
`get-lares.sh`, which sets everything else up. Read
[ADR-0022](decisions/0022-the-tested-install-path.md) for what "tested path" means. Lares is
alpha software; there is no tagged release yet, only release candidates. Try it on a disposable
server first.

**This way of installing, updating and rolling back works for rc.12 and later only.** Earlier
release candidates do not carry the files `get-lares.sh` needs. A server installed before rc.12
switches over once; see the [rc.12 notes](releases/rc.12-notes.md#switching-a-server-installed-before-rc12).

Installing through a coding agent (Claude Code, Codex)? Point it at
[Installing Lares with a coding agent](install-with-an-agent.md); it drives this guide for you.

The installer stops at the console's "create your first agent" page. Creating the first agent
and talking to it is done in the console; [Using the console](how-to/using-the-console.md) is a
tour of its pages.

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
- **On the server:** Docker with Compose v2, `curl`, and `python3`. That is all. There is no Node.js,
  no pnpm and no checkout of the code on the server. `python3` is only used by a few repair helpers
  that the restore steps name; Ubuntu 24.04 already has it. As root:

  ```bash
  apt-get install -y docker.io docker-compose-v2 curl python3
  ```
- **A place for backups** that is not this server: an SFTP host, an S3-compatible bucket, or a
  second disk. See section 9.
- **A chat channel.** None is needed to install. Web chat in the console is the first door; every
  agent has it. Slack, Telegram and (for the chief of staff) an e-mail door are connected
  afterwards (section 8).

Set the server's time zone before you install (`timedatectl set-timezone <zone>`). The installer
reads it and uses it as the owner's clock for quiet hours and briefs. It does not ask.

## 2. Getting the installer and the images

Nothing is built on your server, and you do not clone the code. Images are built in CI and pulled
by digest. A release is a small file that lists the digest of every image. It lives in the
[`releases/`](https://github.com/Heiberg-Industries/lares/tree/main/releases) folder of this
repository. A release is named by its full file name without `.json`, for example
`2026-10-21-rc.12`: the date, then `rc.` and a number. Use the whole name; a short name such as
`rc.12` or the word `latest` is refused. Use rc.12 or a later one (see the note at the top).

On the server, as root, download the one script and read it before you run it:

```bash
curl -fsSLO https://raw.githubusercontent.com/Heiberg-Industries/lares/main/services/box/ops/get-lares.sh
less get-lares.sh
```

Running it with a release name (section 5) does this, in order:

1. checks the server and prints every problem it finds in one pass, changing nothing;
2. downloads that release's file from the `releases/` folder;
3. pulls the release's engine image by its digest and unpacks the installer scripts from it into
   `/opt/lares/releases/<name>/`;
4. runs the installer from there (`install.sh`);
5. only when the installer succeeded, points `/opt/lares/current` at that release and installs the
   `lares` command in `/usr/local/bin`.

It reaches two hosts only, `raw.githubusercontent.com` and `ghcr.io`, and only when you run it.
Nothing is piped into a shell, and nothing is sent anywhere. The installer renders a Compose
file from the release file and starts it; Docker pulls each image by its digest.

## 3. The folder layout

The installer creates these. You do not make them by hand, except the optional `installation`
folder in section 7.

| Path | What it holds |
| --- | --- |
| `/etc/lares/secrets/` | The installation's secrets, one file each (section 4). Never commit or copy these off the server in plain text. |
| `/etc/lares/installation.env` | The answers to the installer's questions (section 4). |
| `/etc/lares/console-oauth.env` | The Google sign-in client for the console. You create it (section 5). |
| `/etc/lares/keeper.json` | The keeper's configuration, rendered from the release file. |
| `/opt/lares/releases/<name>/` | The installer and update scripts of each release you have installed, one folder per release. |
| `/opt/lares/current` | A link to the release in use. `/usr/local/bin/lares` points through it. |
| `/opt/lares/previous` | A link to the release before the last `lares update`. One level only (section 10). |
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

The same file also gets `OWNER_HOME_TZ`, the legacy `CONSOLE_ALLOWED_EMAILS` setting, the
gateway address and the default model alias. The legacy email list no longer admits anyone.
After the designated owner has linked their exact provider identity (section 6), they invite
another person from **Members** in the console. Other admitted members receive only their own
membership and sign-out page while shared resource access is being integrated.

The installation and agent settings registry is
`packages/vault-format/src/settings.ts`. Current console provider-admission settings and
owner adoption are described in [member admission](member-authority.md#provider-setup-and-existing-owner-adoption).

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

Check the server without changing anything. Use the full release name from section 2 (shown here
as `<release-name>`):

```bash
bash get-lares.sh --release <release-name> --dry-run
```

This still downloads the release's engine image, because the installer's checks live in it. It
writes nothing under `/etc`, `/srv` or `/opt/lares`. It prints every problem it finds in one pass,
each with a fix to paste. Fix them, then run the real install:

```bash
bash get-lares.sh --release <release-name>
```

On a fresh server the real run first asks whether to start fresh or check a backup archive.
Press Enter to start fresh. (`--dry-run` does not ask.) For an unattended run, add `--yes` and the
answers. Every option that `get-lares.sh` does not use itself is handed to the installer unchanged:

```bash
bash get-lares.sh --release <release-name> --yes \
  --domain example.com --email you@example.com --name "Your Name" \
  --model-key-file /root/model-key.txt
```

The installer then, in order: generates the secrets, writes the four answers, renders the stack,
prepares and verifies the database offline, starts Console and Caddy, makes you the first member
of the installation, configures the keeper and checks that Console answers at
`https://example.com`. It does not start the gateway or make a model call. After the owner
confirms this host and completes explicit model budget setup, they can create an agent. Only after
the installer succeeds does `get-lares.sh` switch `/opt/lares/current` to the release and install
the `lares` command.

It is safe to run again after any failure, with the same command. A secret or answer that already
exists is left as it is. An existing `/srv/lares` makes the run an update of what is there, not a
fresh start. A failed download or image pull changes nothing.

Exit codes (both `get-lares.sh` and the installer): 64 bad arguments, 75 a download, an image
pull or a service did not work or become ready in time, 77 not root, 78 a check failed (the reason
is printed).

`--restore <archive>` only checks that a backup archive is genuine and reports what it holds. It
does not restore. To restore onto a new server, see section 9. The
[export and restore runbook](runbooks/export-and-teardown.md) has the by-hand background.

## 6. First start and checking it worked

When the installer finishes it prints `https://example.com/sign-in`. Infrastructure and Console
are ready, but the gateway has not been started and no model call or conversation was tested.
Sign in to confirm this host and finish explicit model budget setup before creating an agent.
To check the stack:

```bash
docker compose -f /opt/lares/compose.yaml ps
docker compose -f /opt/lares/compose.yaml logs --tail 200 console caddy
```

You should see `db`, `console` and `caddy` running. The gateway starts during explicit model
budget setup. The keeper and the egress
proxy run from `/opt/lares/compose.lares-keeper.yaml`; list them with
`env -u COMPOSE_FILE docker compose --env-file /etc/lares/keeper.env ps`.

**Before the first owner sign-in**, complete the explicit
[provider-identity adoption](member-authority.md#provider-setup-and-existing-owner-adoption).
The installer creates the owner record, but does not collect or verify a provider subject. An
email address and a working Google client are not enough to admit that owner.

1. Verify that the running console's `AGENT_OWNER_USER_ID` names the intended existing member,
   with an active status, owner role and organisation. Preserve that stable id and its data;
   do not create a replacement owner or change an id to make sign-in work.
2. Use the manual sign-in probe described in the adoption guide to obtain that person's verified
   exact issuer and subject, plus tenant for Microsoft. On the server, add
   `CONSOLE_BOOTSTRAP_IDENTITY` to the protected `/etc/lares/console-oauth.env`. For Google its
   format is:

   ```text
   CONSOLE_BOOTSTRAP_IDENTITY={"issuer":"https://accounts.google.com","subject":"<verified subject>"}
   ```

   Copy the actual verified identity object; do not substitute an email address or guess the
   subject. A Microsoft identity also includes `tenantId` and its exact tenant-specific issuer.
   Fresh installation still requires the Google client from section 5; Microsoft-only fresh
   setup remains deferred.
3. Recreate only the console from the existing installed release stack so it reads the changed
   environment file. This retains the image selected in that stack:

   ```bash
   docker compose -f /opt/lares/compose.yaml up -d --force-recreate console
   ```

Then open the console at your domain, press **Continue with Google**, and choose the same
provider identity you verified. Only a successful callback matching the explicit mapping links
that identity to the existing owner. After the first successful sign-in, remove the
`CONSOLE_BOOTSTRAP_IDENTITY` line from `/etc/lares/console-oauth.env` and run the same console
recreate command again to remove it from the running environment. Future sign-ins use the
stored identity binding.

After confirming this host and completing model budget setup, create your first agent on
`/agents/new`. To end the session, use **Sign out** at the bottom of the sidebar. To admit another
member, create an invitation from **Members**; changing the legacy email list has no effect on
admission.

To check the installation from the command line, run `lares doctor`, a read-only check that says in
plain sentences what is wrong and what to type to fix it (settings, database, migrations, owner,
backup record, open repairs, gateway):

```bash
lares doctor
```

It runs in a short-lived container of the engine image, so it needs nothing installed on the
server. It changes nothing and makes no network call. Add `--test-model --gateway <url> --alias
<name> --key-file <path>` to also send one tiny, paid completion through your gateway. The key
file must be inside `/etc/lares/secrets/`, the only folder the check can see. Exit code 0 means
nothing failed; 1 means at least one check did. More in
[`services/box/README.md`](../services/box/README.md#lares-doctor).

## 7. The console and the deadline calendar file

The console is the web page at your domain. Use it to create and edit agents, grant what they
may touch, connect integrations, choose where messages go and check backup and model status
([Using the console](how-to/using-the-console.md)). Caddy is the only public listener; Postgres is
bound to the server's loopback address only.

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

Then run the installer again, with the same release name:

```bash
bash get-lares.sh --release <release-name>
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

## 8. Doors, outside tools and integrations

After your first agent runs, connect what it needs from the console. A **door** is a way to reach
an agent. Web chat always exists. Slack and Telegram are chat doors; the chief of staff also has an
e-mail door (a mailbox it may use). Google accounts are connected on the Connections page.

The installer already stored your public address as the door address, so nothing needs editing
on the server. Open the agent in the console and use its "Connect doors" section. You paste the
bot's credentials and press "Connect". The console then saves them, checks them with Telegram or
Slack, switches the door on, applies it to the agent (which restarts it, about a minute) and
prepares a one-time connection that is valid for 10 minutes. Until you complete that last step,
nobody can use the door. When you do, the page notices by itself, applies the last change and
reloads. A door you have not touched reads "Not set up".

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

**E-mail** (chief-of-staff agent). The agent works on one mailbox you choose. It needs a Google
client with Gmail and Calendar scopes, which is separate from the sign-in client from section 5:

1. Add `GOOGLE_CLIENT_ID_<ORG>` and `GOOGLE_CLIENT_SECRET_<ORG>` to `/etc/lares/console-oauth.env`
   (an explicit lower-case organisation id), and register
   `https://example.com/api/accounts/google/callback` (your domain) as a redirect address on that
   client.
2. Run `python3 /opt/lares/current/services/box/ops/configure-google-keeper.py --org <org>` as root, then restart the
   keeper and recreate the console. The commands are in
   [`integrations-and-accounts.md`](../services/console/docs/integrations-and-accounts.md#connecting-a-google-account).
3. With the agent running, open it in the console, and under Email type the mailbox and press
   "Connect mailbox with Google". Complete Google's consent screen, then press "Apply connection
   changes (restarts agent)".

E-mail triage tells you about new mail on a chat door; where those messages go is your choice (next
subsection).

### Choosing where messages go

Each agent starts some conversations itself: the morning and evening brief, the weekly summary,
nudges, deadline warnings, proposals, e-mail triage, meeting follow-ups, outreach replies, CRM
routing, the digest and reminders. On the agent's page, **Schedules** tab, **Where messages go**
is a grid: a row per kind of message, a column per door (web chat, Slack, Telegram). Number the
doors 1st, 2nd and 3rd per row. The message tries them in order and skips doors that are not
connected. **Web chat is always the last resort**, so a message is never dropped: if nothing you
chose is connected, it lands in web chat and the Proactivity page records why ("Morning brief went
to web chat: Telegram is not connected"). An agent with nothing saved keeps its usual door, and
falls back to web chat the same way. Quiet hours, do-not-disturb and daily limits apply to
whichever door is used. Saving a brief hour or a routing that would put a brief inside the chosen
door's quiet hours is refused, with the fix in the message.

### The web chat inbox and approvals

Messages that land in web chat appear above the chat, with **Reply** and **Mark as read**; a dot
by "Chat" in the sidebar shows unread ones. Anything that needs your yes arrives as an approval
card, in the chat you replied from and under **Waiting on you**, where you can decide it from any
conversation. Sending mail or changing something outside the server goes through such a card unless you
have deliberately let that agent act on its own for it. Web chat can approve on a fresh installation that has no other door yet: when no chat door
or e-mail address has been connected, the signed-in owner (the administrator of the installation)
may approve; once a door is connected, that door's strict rules apply. (Telegram's one-tap
Approve and Reject buttons on proposals stay Telegram-only; Slack and web chat get the text.)

### Meeting follow-ups and Notion

The meeting follow-up schedule reads your meeting notes from a Notion database and has no built-in
default. It needs the `NOTION_MEETINGS_DATA_SOURCE_ID` setting (the id of your Meetings data
source) and a Notion key (Connections page, Notion key). Set it in `/etc/lares/keeper.json` under
`defaultBindings["chief-of-staff"].environment` (or under `bindings.<agent-name>.environment` for one
named agent), then let the keeper re-apply its configuration. Until it is set, the follow-up
schedule stops with "NOTION_MEETINGS_DATA_SOURCE_ID is not set" each time it runs, and nothing else
is affected.

### Outside tools

Tools the engine does not ship come in as outside tool servers listed in the agent's definition
([ADR-0019](decisions/0019-integrations.md)). If a server needs a key, see
[placing a token file](runbooks/outside-tool-tokens.md).

Optional: back up agent definitions to a private Git repository. It is off by default; see
[definition backups](runbooks/definition-backups.md). It is not a server backup.

The installer prepares one private store for the configured owner and one shared store for the
organisation. Only that named owner initially has access to the shared store. Each has its own
working repository under `/srv/vault/private/<area-id>` or `/srv/vault/shared/<area-id>` and a
local bare repository under `/var/lib/lares-vault-git/<area-id>.git`. The portable inventory is
`/srv/lares/installation/vault-storage.json`; a `.pending.json` file means initialization has
not completed. Retrying the installer uses the same planned identities and preserves existing
notes and sharing. Foreign directories are never adopted.

These stores do not enable agent tools or mounts. `/srv/taste` stays in its existing location;
converting its existing writers is a separate step. No agent receives a mount of `/srv`.

## 9. Backups and the restore drill

The installer refreshes the installed recovery programs and services without changing the backup
destination or timer enablement. Managed Vault snapshots include the complete working trees
(including untracked files), both local bare repositories, and the inventory. A missing store
refuses the backup, export or restore drill instead of silently leaving it out.

The base install does not switch backups on; `lares backups` does. Do not rely on the installation for data you need to keep until backups are
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

Then, as root:

```bash
lares backups
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
You can run it again safely; with the same answers it changes nothing. A re-run with only `--yes`
reuses the answers saved in `/etc/lares/backup.env`.

**When `lares update` says the backup scripts are older, run `lares backups --yes` once.** The backup scripts are copied into
`/opt/lares/` when backups are switched on, and an update does not replace them. When one of the
copies differs from the new release's, `lares update` finishes with a line like "the backup scripts
in /opt/lares are older than this release's: backup.sh ... They were left as they are". Running
`lares backups --yes` copies the new scripts and units into place (an old file is kept beside it as
`<name>.previous` where it is replaced) and then runs the backup, the restore rehearsal and the
check once more; add `--skip-first-run` if you do not want that.

At the end it runs a backup, a restore rehearsal and the daily check once, and prints
**Protected** only if all three passed. Protected means: a snapshot exists, a restore from it
worked, and the check read it back and reached your uptime address. If one fails it names which
and where to read why (`journalctl -u <unit>`). The console's Backup page shows the same state.

What the command does, for those who want to know:

- Copies `backup.sh`, `backup-verify.sh` and `restore-drill.sh` from the current release to `/opt/lares/` (mode 0750, root)
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
Ubuntu server with the tools from section 1, plus `restic` (`apt-get install -y restic`). The age key never goes onto the new server.

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
5. **On the new server**, download `get-lares.sh` (section 2) and install the same release or a
   newer one, rc.12 or later. It reuses the files you just sent, so the database comes up with the
   old password:

   ```bash
   bash get-lares.sh --release <release-name> --yes
   ```

6. **Restore**, as root, with the `lares` command that step 5 installed. `--dry-run` first reads
   the snapshot and checks everything without changing the server:

   ```bash
   lares restore --snapshot latest --dry-run
   lares restore --snapshot latest
   ```

   It asks you to confirm the old server is off (for an unattended run pass
   `--yes --old-server-stopped`). It refuses, changing nothing, unless this server is a fresh
   install: no agents, no conversations, no agent running. It also refuses a snapshot written by a
   newer release than the one installed here, a snapshot with an unsafe database name or no main database,
   too little free disk, a missing token folder, and a restored address that differs from the one
   the server was installed with (restoring to a different address is not possible yet).
   Vault inventory, stored ownership and both repositories are checked against a temporary
   restoration of the snapshot database before the target changes. A fresh install's exact,
   untouched marker-only stores may be moved into private restore staging; notes, extra refs,
   or mismatched identities refuse this preparation. If restoration then fails, staging is
   retained and services stay stopped. Older snapshots must have no Vault metadata or stores.
7. **Do what it prints**, in order. The list below is what `restore.sh` prints; steps that do not
   apply to your snapshot are left out of its list and the numbers shift:
   1. Google, once per organisation: add `GOOGLE_CLIENT_ID_<ORG>` and `GOOGLE_CLIENT_SECRET_<ORG>`
      to `/etc/lares/console-oauth.env` if they are not already there, then run
      `python3 /opt/lares/current/services/box/ops/configure-google-keeper.py --org <org>` and restart only the
      keeper: `env -u COMPOSE_FILE docker compose --env-file /etc/lares/keeper.env restart`.
   2. Point DNS for your domain at this server. You already did in step 2; check it still holds.
   3. Only when the snapshot held a deadline calendar: run the installer again with the same
      release so it mounts the calendar:
      `bash get-lares.sh --release <release-name> --yes`.
   4. Sign in to the console and open each agent.
   5. Model gateway keys: nothing to do when every agent's key file came back with the token
      folder. For an agent without one, `restore.sh` prints the two
      `rotate-restored-gateway-key.py --agent <name>` commands (a check, then `--execute`) to run
      before applying that agent.
   6. Apply each agent once: press "Start agent (applies saved definition)" when it is stopped, or
      "Apply connection changes (restarts agent)" when the console offers that instead.
   7. Only when an agent has a Telegram door: Telegram remembers the old server's address. After
      the agent is applied, open it in the console, go to its Telegram door and press "Register
      Telegram webhook" once. (A new connection registers it by itself; a restore is the one case
      where you press it.)
   8. Only when `backup.env` names retained file volumes: copying those back is still a manual job.
   9. Check: sign in, send one chat message to an agent and read the reply, and open the Backup
      page to confirm the next backup is scheduled (run `lares backups` again if it is not).

The agents' model keys come back with the token folder, so the old key-repair helper is only
printed for an agent whose key file is missing. If a step fails after the restore has begun, the
server is no longer fresh: rebuild a clean server and start again (the backup repository is never
written to by a restore).

This path has been tested with stand-ins only. Treat the first real restore as a rehearsal:
do it on a spare server before you need it.

To take everything with you, `/opt/lares/current/services/box/ops/export.sh` writes one archive; the runbook explains
how to check it before relying on it.

## 10. Upgrading

Updates are dated releases, each with release notes that list what breaks and how to fix it
([ADR-0021](decisions/0021-releases-and-upgrades.md)). Read the notes for the release first,
for example [rc.11](releases/rc.11-notes.md). The `lares update` command works from rc.12 on; a
server installed before rc.12 switches over once (see the [rc.12 notes](releases/rc.12-notes.md#switching-a-server-installed-before-rc12)).
To move to a release, as root, with its full name from the `releases/` folder (section 2):

```bash
lares update --release <release-name>
```

It downloads that release and its engine image, then runs the update: it checks that last night's
backup was verified, takes a backup, records which images were running, and pulls the new ones by
digest. Then it runs the installer once more in repair mode, so the keeper and its settings
update too. Only when both worked does it make the new release the current one and print
"now on <release-name>". If either step stops, the server stays marked as the old release and you
can run the same command again. Switch on backups (section 9) before your first update; without a
verified backup the update refuses.

The repair step refreshes the installed backup programs, helpers and service units before new
Vault stores are initialized. Existing backup settings and enabled timers are preserved; a
missing destination still leaves backups off (section 9).

**Rolling back.** To put the previous images back, run `lares rollback` (add `--dry-run` to see
what it would do). It reads the record of the last update, shows what it would put back and what
it would not, asks, writes the previous digests into the compose file, pulls and starts them, and
then points `/opt/lares/current` back at the earlier release. It goes back **one level only**,
to the release called `previous`; it refuses to run a second time, and there is no way to name an
older release. It does **not** undo database changes: it runs no migration in either direction,
and it names the backup that was taken before the update. To go back past a database change,
restore that backup. If the keeper renders an agent's compose file from its own configuration,
the keeper's configured image comes back the next time it applies the agent, so change that
configuration too.

**Disk space.** An optional `disk-guard` timer can report root-disk usage to an uptime monitor;
`install.sh` does not install it (see [`services/box/ops/README.md`](../services/box/ops/README.md#disk-guard-optional)).
The backup and restore checks need free disk too: keep some room.

## Getting help

Lares is a tested path, not supported software. There is no promised response time. Where to ask
and how to report problems is in the [README](../README.md#help). If you get stuck anywhere in
this guide, a note saying where is the most useful thing you can send.
