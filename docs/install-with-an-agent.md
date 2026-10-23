# Installing Lares with a coding agent

This guide is written for a coding agent (Claude Code, Codex or similar) that a person has asked
to "install Lares on this server". The agent runs on the person's own computer and reaches the
server over SSH as root. The person answers questions and pastes values; the agent does the rest.

It does not replace [install.md](install.md). That guide and the downloaded script `get-lares.sh`
(which runs the installer) are the source of truth. This way of installing works for rc.12 and
later only. This one tells the agent how to drive them,
what to ask, how to handle secrets, and where to stop. Where the two disagree, install.md and the
installer's own messages win; tell the person about the difference.

**If you are the person:** open your coding agent on a computer that can `ssh root@<server>`, and
say: "Install Lares on this server using docs/install-with-an-agent.md". Keep a second terminal
window open; you will use it to type secrets the agent should never see.

## Rules for the agent

Read these first. They hold for the whole install.

- **Never build on the server.** No `docker build`, no image assembly, no `eve build`. Images come
  from CI and are pulled by digest from the release file. Nothing is installed on the server
  either: no Node.js, no pnpm, no clone of the repository. The only things you download are the
  one script `get-lares.sh` and, through it, the release's images.
- **Never edit engine code to make an install pass.** If the installer refuses and the reason is
  not something on the server you can fix, stop, show the person the message, and suggest they
  report it (install.md, "Getting help").
- **Never reboot the server**, and never stop services the person did not ask you to stop, unless
  the person is present and has said yes. Some servers need a passphrase at boot.
- **Never see a secret.** The model key and the Google client secret are typed by the person into
  their own terminal (step 4). Do not ask them to paste either into the chat. Do not pass a secret
  as a command argument or environment value. Do not `cat`, `less`, `grep` without `-c`, or
  otherwise print `/etc/lares/secrets/*`, `/etc/lares/console-oauth.env` or the model key file.
- **Run one command at a time and read what it prints.** The installer explains every refusal in
  plain words and usually prints the fix. Act on that, not on guesses.
- **Ask one question at a time, in plain words.** The person may not be technical.

All commands below run on the server as root, through `ssh root@<server> '<command>'`, unless they
say otherwise.

## 1. Check the server

Make sure you can reach it and are root:

```bash
ssh root@<server> 'id -u && lsb_release -ds && uname -m'
```

Expect `0`, Ubuntu 24.04 and `x86_64`. If you are not root (the installer exits 77), ask the person
for root access; do not work around it.

Install the tools the installer needs, if they are missing (install.md section 1). Only Docker
with Compose v2, `curl` and `python3` are needed:

```bash
apt-get update
apt-get install -y docker.io docker-compose-v2 curl python3
```

Then fetch the one script, and decide which release to install (step 5 says how to choose). Read
the script's header before you run it; it says exactly what it does and which two hosts it reaches
(`raw.githubusercontent.com` and `ghcr.io`):

```bash
curl -fsSLO https://raw.githubusercontent.com/Heiberg-Industries/lares/main/services/box/ops/get-lares.sh
```

Then run its check with that release's full name (the example name only shows the shape; step 5
says which to use). It changes nothing on the server, asks nothing, and prints every problem it
finds in one pass, each with a fix:

```bash
bash get-lares.sh --release <release-name> --dry-run
```

This is the single check. It covers memory (6 GiB), disk (20 GiB free), Docker and Compose v2,
ports 80 and 443 and the release's engine image. Fix what it prints and run it again until it
reports no problems. If memory or disk is too small, tell the person; that needs a bigger server,
not a workaround.

The dry run does not check the domain. That comes after the person names it (step 2).

## 2. Ask the person

Ask these one at a time. Explain why each one is needed in one sentence.

1. **The domain** the console will live at, for example `example.com` or `lares.example.com`.
   It must already point at this server. Check it yourself:

   ```bash
   getent ahostsv4 example.com | awk '{print $1}' | sort -u   # what the name points at
   hostname -I                                                # this server's addresses
   ```

   If they differ, tell the person to create an A record for the domain with the server's public
   address at their domain provider, and wait until it shows up here. The installer refuses
   (exit 78) until it does.
2. **Their e-mail address**, for the existing owner record and contact details. Email equality
   does not admit the owner; their exact verified provider identity must be explicitly linked
   before first sign-in (install.md section 6).
3. **Their name**, as it should appear in the console.
4. **Their time zone**, for example `Europe/Oslo`. The installer does not ask; it reads the
   server's clock. Set it before installing: `timedatectl set-timezone <zone>`.
5. **Whether they have a model key.** The shipped setup uses an Anthropic API key (from the
   Anthropic Console, not a chat subscription). Do not ask for the key itself; they type it in
   step 4.
6. **Whether they have a Google sign-in client.** If not, relay step 3.

Also check that ports 80 and 443 are open from the internet, not only free on the server. Many
hosting providers have a firewall in their web panel. Ask the person to allow inbound TCP 80 and
443 there; Caddy needs both to fetch its certificate.

## 3. The Google sign-in client (relay to the person)

The console's sign-in is "Continue with Google". It needs an OAuth client the person creates in
their own Google Cloud account. Relay these steps, replacing `example.com` with their domain:

1. Go to <https://console.cloud.google.com/> and create a project (or pick one), for example
   "Lares".
2. Open **Google Auth Platform** (APIs & Services, OAuth consent screen). If asked to configure it:
   app name "Lares", your e-mail as support and contact address, audience **External**.
3. Under **Audience**, while the app is in "Testing", add your own e-mail address as a **test
   user**. Without that, Google refuses your sign-in.
4. Under **Clients**, choose **Create client**, application type **Web application**.
5. Under **Authorised redirect URIs**, add exactly `https://example.com/api/auth/callback`.
6. Create it. Google shows a **client ID** (ending in `.apps.googleusercontent.com`) and a
   **client secret**. Keep the window open.
7. Paste the **client ID** into the chat. It is not a secret. Do **not** paste the client secret;
   you will type it in your own terminal in the next step.

Gmail and Calendar need a second client with more permissions. That comes after the install, from
the console (install.md section 8), not now.

## 4. Put the secrets on the server

Two secrets go onto the server, typed by the person, never seen by you.

First, create the Google client file with the client ID only. You write this one; the ID is not
secret:

```bash
mkdir -p /etc/lares
umask 077
printf 'GOOGLE_CLIENT_ID_CONSOLE=%s\n' '<client id>' > /etc/lares/console-oauth.env
chown root:root /etc/lares/console-oauth.env
chmod 0600 /etc/lares/console-oauth.env
```

Then ask the person to run these two commands **in their own terminal window**, not through you.
Each asks for a value without showing it on screen. Replace `<server>` before you hand them over.

The Google client secret:

```bash
ssh -t root@<server> 'read -rsp "Google client secret: " s && echo && printf "GOOGLE_CLIENT_SECRET_CONSOLE=%s\n" "$s" >> /etc/lares/console-oauth.env && echo saved'
```

The model key:

```bash
ssh -t root@<server> 'umask 077 && read -rsp "Model key: " k && echo && printf "%s\n" "$k" > /root/lares-model-key && echo saved'
```

Each should print `saved`. Check without reading the values:

```bash
stat -c '%U %a' /etc/lares/console-oauth.env /root/lares-model-key   # expect: root 600
grep -c '^GOOGLE_CLIENT_ID_CONSOLE=.' /etc/lares/console-oauth.env      # expect: 1
grep -c '^GOOGLE_CLIENT_SECRET_CONSOLE=.' /etc/lares/console-oauth.env  # expect: 1
wc -l < /root/lares-model-key                                          # expect: 1
```

If a count is 0 or more than 1, ask the person to run that command again (for the secret, recreate
the file with the ID line first, so there is only one secret line).

## 5. Run the installer

Choose the release. A release is named by its full file name without `.json`, for example
`2026-10-21-rc.12` (the shape: date, then `rc.` and a number). Use the newest one that is rc.12
or later. List the folder from your own machine, not the server:

```bash
gh api repos/Heiberg-Industries/lares/contents/releases --jq '.[].name' | sort -V | tail -n 3
```

(or open <https://github.com/Heiberg-Industries/lares/tree/main/releases> in a browser). Drop the
`.json` ending. A short name such as `rc.12` or `latest` is refused.

Read that release's notes in `docs/releases/` on GitHub (the file whose name matches, for example
`rc.N-notes.md`) and tell the person anything they say must be done by hand.

Run the installer unattended. `--yes` is required when it is driven over SSH without a terminal:
it answers the "start fresh or check a backup" question with "start fresh". Without it the
installer exits 64. Every option `get-lares.sh` does not use itself goes on to the installer.

```bash
bash get-lares.sh --release <release-name> --yes \
  --domain example.com --email you@example.com --name "Your Name" \
  --model-key-file /root/lares-model-key
```

It takes several minutes: it writes secrets, renders and starts the stack, proves the model key
with one real call, creates and migrates the database, makes the person the first member and starts
the keeper. Running it again is always safe; nothing that already exists is overwritten.

What the exit code means, and what to do:

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | Finished | Go to step 6. |
| 64 | Bad arguments, or an answer it could not use | Read the message. Usually a typo in a flag, a missing `--yes`, or a model key file that is not one clean line (have the person run the step 4 command again). |
| 75 | A download, the image pull or a service did not work in time | Usually the internet connection, slow image pulls or a slow first start. Run the same command again. If it repeats, read `docker compose -f /opt/lares/compose.yaml logs --tail 200` and tell the person what it says. |
| 77 | Not root | Reconnect as root. |
| 78 | A check failed; the reason is printed | Do what the message says, then run the same command again. Common causes: the domain does not point at this server yet; the model key was refused (wrong key, or no API credit); the Google client file is missing or its ID is malformed. |

When the run finished, remove the model key file. The installer has copied the key into its own
secrets folder:

```bash
rm -f /root/lares-model-key
```

## 6. Check it worked

The installer's last lines print `https://example.com/agents/new` and say that no agent runs yet.
That is the expected end.

Check the stack:

```bash
docker compose -f /opt/lares/compose.yaml ps
env -u COMPOSE_FILE docker compose --env-file /etc/lares/keeper.env ps
```

The first should show `db`, `console`, `lares-gateway` and `caddy` running; the second the keeper
and the egress proxy. Then check the console answers over HTTPS, from your own machine:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://example.com/
```

Any 2xx or 3xx answer is fine. A certificate error usually means ports 80 or 443 are closed at the
hosting provider's firewall (step 2).

Optionally run the read-only health check, which says in plain sentences what is wrong, if
anything:

```bash
lares doctor
```

Before the first owner signs in on a fresh installation, follow
[the first-owner setup](install.md#6-first-start-and-checking-it-worked). The installer does not
collect or verify a provider identity. The person chooses an account on the Console sign-in
page, confirms the public installation origin, and uses the protected `lares owner-bootstrap`
command to pin the discovery tuple after a live database freshness check. Recreate only Console,
then require a new provider sign-in; only that fresh callback can bind the account or issue a
session. The page's five-minute display is discovery only; copied JSON is not authentication and
does not authorize an existing installation. Do not hand-edit `CONSOLE_BOOTSTRAP_IDENTITY` or
use the manual probe output as its value. Existing installations need separately reviewed
recovery. Fresh installation still requires the Google client; Microsoft-only fresh setup remains
deferred.

Then ask the person to open `https://example.com/`, press **Continue with Google**, and choose
that verified provider identity. If Google says access is blocked, check its test-user setting
(step 3, item 3) and exact redirect address (item 5).
A successful installer run or email match alone does not prove sign-in worked.

## 7. Hand over to the person

Stop here. These are the person's to do, in the console and with their own keys:

- **The first agent.** They create it on `https://example.com/agents/new`.
  [Using the console](how-to/using-the-console.md) is a tour of the pages.
- **Backups.** The install does not switch them on. Tell the person, plainly, not to rely on the
  installation for anything they need to keep until backups are on. They run
  `lares backups` (install.md section 9). It needs an age key pair made on
  their own machine and a backup location that is not this server. You can help them through it,
  but the private age key never goes to the server or into the chat.
- **Doors and integrations** (Slack, Telegram, e-mail), after the first agent runs (install.md
  section 8).

Finish by giving the person the console address, whether owner sign-in was actually confirmed
(or the explicit identity-adoption step remains pending), that no agent runs yet, and that
backups are off until they switch them on.
