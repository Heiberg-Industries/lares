# Connections and accounts (console)

The **Connections** page (`/integrations`) is where the owner sees and manages what the agents on
this installation are connected to: Google accounts, the Notion key, saved-link clipping, and
what each agent may do with each connection. It is how you connect accounts without editing files
on the server.

## The model: account, connection, agent access, autonomy

- **Account** — a connected Google account (mailbox and calendar), stored encrypted in the
  installation's database, keyed by owner, provider and address. The provider is Google. One
  consent covers the scopes the agents use: `gmail.readonly`, `gmail.compose` (drafts and send)
  and `calendar.readonly`.
- **Connection** — a card on the page for something the installation can reach: a Google client,
  Notion, an outside tool server. It shows a status, which agents have access, and details.
- **Agent access** — an agent only has the powers (capabilities) in its definition. The
  definition is saved by the keeper under `/srv/lares/agents/<name>/`; the console edits it (Edit
  agent, then Access) and a change reaches the running agent when you apply it ("Apply connection
  changes (restarts agent)"). Two agents holding the same capability is one connection and two
  grants.
- **Autonomy** — for each agent and capability the table at the bottom of the page shows a level:
  acts on its own, asks first, or never (a live, reversible revoke). A change reaches the agent at
  its next action. Some actions always ask whatever the level: moving money, deleting data,
  contacting someone for the first time, publishing, an agent changing its own autonomy.

## Connecting a Google account

There are two entry points, both ending at Google's consent screen and back to
`/api/accounts/google/callback`:

1. **Connections page, "Connect a Google account".** Type the address; its domain decides which
   configured Google client is used.
2. **An agent's own mailbox (chief of staff only).** On the agent's page, under Connect doors, the
   Email door: "Connect mailbox with Google". The agent must be running, and it can then use only
   that mailbox. Apply the connection changes afterwards.

Either needs a Google **data** client set up first. It is separate from the client that signs you
in to the console. As root on the server:

1. Add `GOOGLE_CLIENT_ID_<ORG>` and `GOOGLE_CLIENT_SECRET_<ORG>` (an explicit lower-case
   organisation id, for example `org-one`) to `/etc/lares/console-oauth.env`.
2. Register `https://<console-host>/api/accounts/google/callback` as a redirect address on that
   Google client.
3. From the Lares checkout, run the configuration command, then restart the keeper:

   ```sh
   sudo python3 services/box/ops/configure-google-keeper.py --org org-one --dry-run
   sudo python3 services/box/ops/configure-google-keeper.py --org org-one
   sudo docker compose --env-file /etc/lares/keeper.env -f /opt/lares/compose.lares-keeper.yaml restart
   ```

   The command writes no credential to the screen or the command line. It copies the two client
   values into `root:10001` `0440` files that the keeper mounts read-only, adds the installed owner
   and the organisation to `/etc/lares/keeper.json`, and sets `CONSOLE_PRINCIPAL_ID` in the console
   file to the installed owner. It does not connect a mailbox or switch an agent on.
4. Recreate the console so it reads the file again: `sudo docker compose -f /opt/lares/compose.yaml up -d --force-recreate console`.
5. Connect the mailbox (either entry point above) and complete Google's consent screen.

Re-run step 3 after any installer re-run that replaces `/etc/lares/keeper.json`; the installer
carries the Google settings over when it can read the file and stops without touching it when it
cannot (see the install guide).

The token key (`token-enc-key` in `/etc/lares/secrets`, the `TOKEN_ENC_KEY` setting) is shared
between the console and the agents, so a token the console stores is one the agent can read. The
installer generates it once; back it up (install guide, section 4). Removing an account on the
page deletes its stored token, so the agents lose access. It does not revoke the grant at Google:
do that in the Google account's third-party access settings.

## Models (Settings page)

The **Models** section on Settings is read-only. It shows the address of the model gateway, whether
Lares runs it or it is managed elsewhere, whether it is answering (with the time it was checked), and
for each purpose (Brain, Writer, Utility, Gate, Embed) whether the gateway serves it, which provider
and model are behind it where the gateway says, and which agents use it. It reads this once each time
the page opens, through the keeper, and never makes a model request or costs money. "Provider not
tested" means exactly that: Lares has checked that the gateway answers, not that the provider behind
it accepts a request, because testing that sends a paid request. A gateway managed elsewhere shows
only whether it is reachable.

## Saved links from Notion (the Clipping card)

Links saved into one Notion database you choose (phone share sheet, browser clipper, or a pasted link
in a new row) are brought into the inbox at each digest pass and read and filed by the digest like
any other link; the same link saved twice, or a pass that runs twice, never makes a second copy.
Edits and trashing in Notion follow the clip only while it still waits in the inbox, never after it is
filed. The database needs a title column and one URL column. Only links are copied, never the pages.

Set it up on the Connections page, in the Clipping card under the Notion key card:

1. Add the Notion key in the Notion key card above, and share the database with your Lares connection
   in Notion (the three dots, then Connections).
2. Paste the database's link and press Read database. The chief of staff reads it within a minute and
   the card lists the columns it found, with the URL column already chosen when there is one clear
   choice.
3. Pick the columns (URL is required; note, tags and saved-at are optional) and press Save columns.
   Saving starts the import from now: links saved before that are not imported, and changing to a
   different database starts again from now.
4. Optionally press Add Status, For and Origin columns. It adds only the columns that are missing and
   never changes one that already exists; a column with the same name but another type is reported
   and left alone.
5. Press Test, then switch clipping on, then press Import now (or wait for the next digest).

**Test** reads one page of rows and says how many links would be imported, how many came from the URL
column and how many from the title, how many rows have no link, and how many were already imported.
It writes nothing. **Import now** runs one import pass, the same one the digest runs; the two never
run at the same time. **Switch clipping on** lets the chief of staff receive the Notion key (the
keeper restarts that one agent after you confirm the list shown); **Switch clipping off** takes it
away again. Only the installation's credential administrator sees the switch. The Source buttons
(Notion, Karakeep, Both) choose which source the digest reads; Both is for the changeover, and nothing
in Karakeep is deleted.

The buttons that read Notion work through requests the chief of staff answers within a minute (the
card checks every 5 seconds while one is waiting). If the chief of staff has not picked a request up,
or not finished it, within ten minutes the card says "The chief of staff did not pick this up." or
"The chief of staff did not finish this."; that means the agent is not running or the switch is off,
not that Notion said no. "Clipping status unavailable." means Lares could not read its own records.
If Notion cannot be read (not shared with the connection, key refused, column changed, rate limit,
timeout) the card and the digest message say so in one line, a repair entry is opened, and the last
good fetch time is kept; it never shows a quiet "0 new".

This supports exactly one organisation-wide source using the Notion key the keeper manages, and does
not move existing Karakeep bookmarks. A link saved in Notion first and in Karakeep later still lands
twice (only the Notion side checks for the other). The live probe
`services/chief-of-staff/tests/live/notion-clipping.live.mts` is what shows how Notion really answers;
run it by hand when the pinned Notion API version or the SDK changes.

## Not done yet

- Removing an account does not revoke the token at Google.
- Adding a capability to an agent from this page is done in Edit agent, not on the Connections
  page.
- One owner principal per installation; there is no selector for several.
