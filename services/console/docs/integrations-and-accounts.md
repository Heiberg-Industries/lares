# Integrations & Accounts (console)

The **Integrations & Accounts** page (`/integrations`) is where Bendik self-serves the fleet's
Google wiring instead of running `bin/oauth-enroll.ts` or editing the DB.

## The model: agent → integration → account → autonomy

- **Account** — a connected Google account (mailbox + calendar), stored encrypted in the shared
  `oauth_tokens` table, keyed `(principal, provider, email_address)`. Provider is always `google`.
  One consent covers all three scopes the fleet uses: `gmail.readonly`, `gmail.compose`
  (drafts + send), `calendar.readonly`. v1 principal = `U_bendik` (matches the watcher + Saga).
- **Integration (capability / hand)** — a power like `gmail` or `calendar`, built once and
  **granted per agent** in that agent's `agent.json` (`grants[]`). Two agents holding the same
  integration is one connector + two grants, not duplication.
- **Autonomy** — each (agent, capability[, action]) has a level in the live `ratchet` table:
  `autonomous` (acts + audits, no 👍), `gated` (needs 👍), `never` (hard-denied). The page's dial
  writes this table directly via the `setAutonomy` server action.

## What the console can and can't change live

- **Live (DB):** connect/remove Google accounts; set any agent capability's autonomy on the dial.
  `never` is a live, reversible **revoke** (the agent can't use the power even though the grant
  exists). This is the v1 revoke mechanism.
- **Not live (manifest + redeploy):** *adding a brand-new capability* to an agent, because grants
  live in `agent.json`, which is baked into the agent image and read at boot by `buildAgentHands`.
  For v1 the matrix is fixed (Saga: gmail read+draft + calendar read; Nora: gmail draft+send), so
  there's nothing to add from the console.

## Add-account flow (in-browser OAuth)

1. Pick an org (Heiberg / Zero7) and click **Add account** → POST `/api/accounts/google/start`.
2. The console (session-gated) signs a short-lived `state` **bound to the initiating session's
   email**, builds the per-org consent URL, and redirects to Google. The callback rejects a state
   whose email ≠ the completing session (CSRF defence).
3. Google redirects back to `/api/accounts/google/callback`; the console exchanges the code,
   reads the *actual* connected mailbox (`gmail.users.getProfile`), and stores the encrypted
   refresh token via `@lares/agent-box` (same `TOKEN_ENC_KEY` the runtime decrypts with).
4. Back on `/integrations?added=<email>`, the new account appears and is immediately resolvable
   by Saga / the watcher (same DB, same key).

Removing an account deletes its `oauth_tokens` row (the agent loses access). The principal is
bound **server-side** (`CONSOLE_PRINCIPAL`) — the remove action never trusts a client-supplied
principal, so it can't be used to delete another principal's account.

## Config (env)

- `TOKEN_ENC_KEY` (or `TOKEN_ENC_KEY_FILE`) — 64-hex AES key, **must equal the runtime's**.
- `GOOGLE_CLIENT_ID_HEIBERG` / `GOOGLE_CLIENT_SECRET_HEIBERG` (+ `_ZERO7`) — per-org OAuth web
  clients (or their `*_FILE` variants). Mirror the enroll CLI.
- `CONSOLE_PRINCIPAL_ID` (default: the owner key, `AGENT_OWNER_USER_ID`) — must name the same
  value as the fleet's `GOOGLE_PRINCIPAL_ID` and the calendar job's `NOTION_SYNC_PRINCIPAL`.
  Since box 085 that value is the identity register's id (`users.id`); the old legacy spelling
  is no longer a default anywhere. See `docs/runbooks/2026-09-19-oauth-principal-rename.md`.
- `CONSOLE_SESSION_SECRET` — signs both the login session and the OAuth `state`.
- Each org's OAuth **web client** must register the redirect URI
  `https://<console-host>/api/accounts/google/callback`.

## Deploy

1. Set the env above on the console service (Coolify). `TOKEN_ENC_KEY` = the runtime's key.
2. Register the callback redirect URI on the heiberg + zero7 Google OAuth web clients.
3. Redeploy the console (manual — push to main does not auto-deploy).
4. Probe: open `/integrations`, Add account (Heiberg) → Google consent → returns with the mailbox
   listed. Confirm `SELECT email_address, org_id FROM oauth_tokens WHERE provider='google';`
   shows it, and that Saga's workflow can draft on it (Plan 3 probe).

### Keeper-managed fresh installation

The Google sign-in client is separate from a Google **data** client. Before an agent can use a
connected mailbox, put the data client's `GOOGLE_CLIENT_ID_<ORG>` and
`GOOGLE_CLIENT_SECRET_<ORG>` entries in the root-owned `0600` console OAuth env file, and register
`https://<console-host>/api/accounts/google/callback` on that client. The owner still has to
complete Google's consent screen. For an explicit lower-case org id (for example `heiberg`), run
from the Lares checkout on the installed server:

```sh
sudo python3 services/box/ops/configure-google-keeper.py --org heiberg --dry-run
sudo python3 services/box/ops/configure-google-keeper.py --org heiberg
sudo docker compose --env-file /etc/lares/keeper.env -f /opt/lares/compose.lares-keeper.yaml restart lares-keeper
```

The command writes no credential to stdout or argv. It copies the two client values into
root:10001 `0440` files that the Keeper can mount read-only, and adds the installed owner and
explicit org to `/etc/lares/keeper.json`. It does not connect a mailbox or enable an agent.
After the Keeper restart, connect the mailbox in the agent editor, select only the intended
capabilities, enable Email, and apply connection changes. Inspect the agent's current state if
an apply times out before retrying it. Re-run this configuration command after any installer
rerun that replaces `/etc/lares/keeper.json`; the installer does not yet preserve these
post-install Google settings automatically.

## Models (Settings page)

The **Models** section on Settings is read-only. It shows the address of the model gateway, whether
Lares runs it or it is managed elsewhere, whether it is answering (with the time it was checked), and
for each purpose (Brain, Writer, Utility, Gate, Embed) whether the gateway serves it, which provider
and model are behind it where the gateway says, and which agents use it. It reads this once each time
the page opens, through the keeper, and never makes a model request or costs money. "Provider not
tested" means exactly that: Lares has checked that the gateway answers, not that the provider behind
it accepts a request, because testing that sends a paid request. A gateway managed elsewhere shows
only whether it is reachable.

## Follow-ups

- Revoke the token at Google (not just delete the row) on Remove.
- Writable grants (add a capability from the console) once a manifest-write + redeploy hook exists.
- Multi-user: resolve the principal from the authenticated session (not a fixed `CONSOLE_PRINCIPAL`)
  and surface a principal selector once real multi-user lands.
