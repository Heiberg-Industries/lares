# Blank Ubuntu install candidate — LAR-50 owner run

This is the **test candidate** on a disposable Ubuntu 24.04 server. It is not a
published one-command distribution or a production deployment. The tester
should follow only this page and the installer's own output. Record every
missing instruction or manual repair in
[the golden-path ledger](golden-path-runs.md); do not silently count a repaired
run as a clean pass. The current acceptance and later restore work are in the
[release review](../design/console-release-readiness-2026-09-29.md).

## Before the four questions

1. Use a fresh Ubuntu 24.04 x86-64 server with at least 6 GiB RAM and 20 GiB
   free, reachable with SSH by key. Point the test domain's A record to this
   server; if the domain has an AAAA record, it must point to this server's
   IPv6. Keep ports 80 and 443 free. On the current Hetzner test, the server is
   #167781592 and the A record is `lares.heiberg.co` → `89.167.43.7`.
2. Verify the SSH host key against the provider's authenticated server console
   before logging in. Do not suppress host-key checking after a rebuild.
3. Log in as root and install the host prerequisites. The following commands
   use the same Ubuntu package names and pinned Node/pnpm versions used in the
   previous disposable run:

   ```bash
   apt-get update
   apt-get install -y docker.io docker-compose-v2 git curl ca-certificates xz-utils build-essential python3
   timedatectl set-timezone Europe/Oslo
   cd /root
   node_version=v24.21.0
   curl -fsSLO "https://nodejs.org/dist/$node_version/node-$node_version-linux-x64.tar.xz"
   curl -fsSLO "https://nodejs.org/dist/$node_version/SHASUMS256.txt"
   grep " node-$node_version-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c -
   ```

   **Stop here and read the checksum result.** Only when it says `OK`, run:

   ```bash
   tar -C /usr/local --strip-components=1 -xf "node-$node_version-linux-x64.tar.xz"
   corepack enable
   corepack prepare pnpm@9.15.0 --activate
   docker compose version
   node --version
   pnpm --version
   ```

   Stop if the checksum, package install, or version checks fail. Do not run an
   unverified downloaded shell script to repair them.
4. Check out the exact test source and install its frozen dependencies. For
   this run, the source commit is `a2cd26ca74c0ba695b4354ce4b1aae8734e883c1`:

   ```bash
   git clone https://github.com/Heiberg-Industries/lares.git /root/lares
   cd /root/lares
   git fetch origin codex/console-redesign
   git checkout --detach a2cd26ca74c0ba695b4354ce4b1aae8734e883c1
   git rev-parse HEAD
   pnpm install --frozen-lockfile
   bash services/box/ops/install.sh --dry-run --release releases/2026-09-29-console-test.1.json
   ```

   The dry run must exit zero and change nothing. The release manifest contains
   image digests; the source checkout is used for the installer and migrations.
   A green PR check or an existing console image is not this blank-server proof.

## Private credentials and the live install

The installer needs a Google **console sign-in** OAuth client. Its authorized
redirect URI is `https://<test-domain>/api/auth/callback`. The existing
client may be reused only if it admits the fresh test account. Save its ID and
secret on this server before the real install, without putting either in a
shell command, history, chat, or repository:

For a repeat run, the same two-field console sign-in client may instead be
restored from the owner's encrypted escrow into this root-only file. That is a
credential handoff, not an installation-state restore: do not restore the
database, owner answers, model key, or agent files before the fresh installer.
Check the resulting file is root-owned and mode `0600`.

```bash
install -d -m 0700 /etc/lares
umask 077
read -r -p 'Console OAuth client ID: ' console_client_id
read -r -s -p 'Console OAuth client secret: ' console_client_secret
printf '\n'
printf 'GOOGLE_CLIENT_ID_CONSOLE=%s\nGOOGLE_CLIENT_SECRET_CONSOLE=%s\n' "$console_client_id" "$console_client_secret" > /etc/lares/console-oauth.env
unset console_client_id console_client_secret
chmod 0600 /etc/lares/console-oauth.env
```

Run the installer **without** `--domain`, `--email`, `--name`,
`--model-key-file`, or `--yes` so the owner actually sees the fresh setup path:

Use a normal SSH terminal for the hidden model-key prompt. The Hetzner browser
console injected control bytes during the 29 September rehearsal; pasting a
key there is not a clean test of the installer.

```bash
cd /root/lares
bash services/box/ops/install.sh --release releases/2026-09-29-console-test.1.json
```

Choose **start fresh**. Answer the domain, owner email, owner name, and model
provider key prompts privately. The key prompt hides input and makes one real
model call; track the run against the existing USD 5 cumulative test ceiling.
Do not copy a prior `/etc/lares` escrow into this installation: doing so skips
the four-question acceptance step. Record the questions, any refusal or repair,
the exact source and manifest, the migration result, and the final URL. A
partial or repaired run stays marked partial.

After the installer reports success, sign in as the designated test owner on
this fresh installation, create one first agent from the console, and prove
one real web-chat reply.
Do not mistake console sign-in for agent data access. To test Calendar and
Gmail, the owner must separately supply a Google Workspace data OAuth client
with the needed scopes and redirect. Save its pair privately in the same
root-only OAuth env file as `GOOGLE_CLIENT_ID_<ORG>` and
`GOOGLE_CLIENT_SECRET_<ORG>`, where `<ORG>` is one lower-case organisation id.
Use the same hidden-prompt pattern above; never put the secret in argv or Git.
Then run `python3 services/box/ops/configure-google-keeper.py --org <org>` as
root and restart only the Keeper, as the helper's `--help` output instructs.
If the callback, scopes, or account eligibility are unclear, stop and record a
documentation blocker rather than guessing. Authorize only read access for
this test and record a bounded Calendar and Gmail read, without private
result content.
Record the first brief delivery or explicit acceptance of a freshness
heartbeat, then follow the release review's encrypted export, fresh-target
restore, Preferences, backup-protection and teardown gates. Do not close
LAR-50 based on installation success alone.
