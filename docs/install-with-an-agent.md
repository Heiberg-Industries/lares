# Installing Lares with a coding agent

This guide is written for a coding agent (Claude Code, Codex or similar) that a person has asked
to "install Lares on this server". The agent runs on the person's own computer and reaches the
server over SSH as root. The person answers questions and pastes values; the agent does the rest.

It does not replace [install.md](install.md). That guide and the installer
`services/box/ops/install.sh` are the source of truth. This one tells the agent how to drive them,
what to ask, how to handle secrets, and where to stop. Where the two disagree, install.md and the
installer's own messages win; tell the person about the difference.

**If you are the person:** open your coding agent on a computer that can `ssh root@<server>`, and
say: "Install Lares on this server using docs/install-with-an-agent.md". Keep a second terminal
window open; you will use it to type secrets the agent should never see.

## Rules for the agent

Read these first. They hold for the whole install.

- **Never build on the server.** No `docker build`, no image assembly, no `eve build`. Images come
  from CI and are pulled by digest from the release file. `pnpm install --frozen-lockfile` in the
  checkout is the one allowed install step.
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

Install the tools the installer needs, if they are missing (install.md section 1):

```bash
apt-get update
apt-get install -y docker.io docker-compose-v2 curl git
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
npm install -g pnpm@9.15.0
```

Ubuntu's own `nodejs` package is too old; use the NodeSource one above. Check with
`node --version` (v24) and `pnpm --version` (9.15.0).

Get the code and its locked dependencies:

```bash
git clone https://github.com/Heiberg-Industries/lares.git /root/lares
cd /root/lares && pnpm install --frozen-lockfile
```

Then run the installer's own check. It changes nothing, asks nothing, and prints every problem it
finds in one pass, each with a fix:

```bash
cd /root/lares && ./services/box/ops/install.sh --dry-run
```

This is the single check. It covers memory (6 GiB), disk (20 GiB free), Docker and Compose v2,
Node 24, pnpm 9.15.0, the checkout's dependencies and ports 80 and 443. Fix what it prints and run
it again until it reports no problems. If memory or disk is too small, tell the person; that needs
a bigger server, not a workaround.

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
2. **Their e-mail address.** Only this address can sign in to the console at first. It must be the
   Google account they will sign in with.
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

Use the newest release file in `releases/`:

```bash
cd /root/lares && ls releases/*.json | sort -V | tail -n 1
```

Read its notes in `docs/releases/` (the file whose name matches the release, for example
`rc.N-notes.md`) and tell the person anything they say must be done by hand.

Run the installer unattended. `--yes` is required when it is driven over SSH without a terminal:
it answers the "start fresh or check a backup" question with "start fresh". Without it the
installer exits 64.

```bash
cd /root/lares && ./services/box/ops/install.sh --yes \
  --release "$(ls releases/*.json | sort -V | tail -n 1)" \
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
| 75 | A service did not become ready in time | Usually slow image pulls or a slow first start. Run the same command again. If it repeats, read `docker compose -f /opt/lares/compose.yaml logs --tail 200` and tell the person what it says. |
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
docker compose --env-file /etc/lares/keeper.env -f /opt/lares/compose.lares-keeper.yaml ps
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
cd /root/lares && PGHOST=127.0.0.1 DATABASE_PASSWORD_FILE=/etc/lares/secrets/database-password \
  pnpm -C services/box doctor
```

Then ask the person to open `https://example.com/` in their browser, press **Continue with
Google** and sign in with the e-mail address they gave. If Google says access is blocked, they
have not added themselves as a test user (step 3, item 3) or the redirect address does not match
exactly (item 5).

## 7. Hand over to the person

Stop here. These are the person's to do, in the console and with their own keys:

- **The first agent.** They create it on `https://example.com/agents/new`.
  [Using the console](how-to/using-the-console.md) is a tour of the pages.
- **Backups.** The install does not switch them on. Tell the person, plainly, not to rely on the
  installation for anything they need to keep until backups are on. They run
  `./services/box/ops/install.sh --backups` (install.md section 9). It needs an age key pair made on
  their own machine and a backup location that is not this server. You can help them through it,
  but the private age key never goes to the server or into the chat.
- **Doors and integrations** (Slack, Telegram, e-mail), after the first agent runs (install.md
  section 8).

Finish by giving the person a short summary: the console address, that sign-in worked, that no
agent runs yet, and that backups are off until they switch them on.
