# Connections and accounts (console)

The **Your membership** page (`/membership`) lets every admitted member connect, reconnect
and disconnect their own personal Google accounts. The installation-wide **Connections** page
(`/integrations`) remains owner-only. Its legacy mailbox list includes only the configured owner
principal's unassociated credentials, never other members' associated personal accounts.

## Personal Google consent

Google data consent is separate from console sign-in. Configure `GOOGLE_CLIENT_ID_<ORG>` and
`GOOGLE_CLIENT_SECRET_<ORG>` through the existing secret-file or environment settings, and register
`https://<console-host>/api/accounts/google/callback` on that data client. The console login client
and its `/api/auth/callback` address are not used for data consent. `GOOGLE_ORG_DOMAINS` or
`GOOGLE_DEFAULT_ORG` selects the configured client; a typed email is only a client-selection/login
hint, never a member identity. Organisation suffixes use letters and digits, for example `EXAMPLE`.

The maintained OIDC client verifies issuer, subject, audience, nonce and signature from the same
consent grant. An encrypted, ten-minute HttpOnly flow cookie binds the current member and opaque
session, selected data client, PKCE, state and reconnect ticket. A new start overwrites that cookie;
every terminal callback clears it. State in a URL alone cannot complete a flow. Returned scopes
must include `openid`, `gmail.readonly`, `gmail.compose`, `calendar.readonly`, `calendar.events`
and `drive.readonly` (the data scopes use their full Google API URLs). Missing actual scope evidence
or a missing refresh token refuses the consent; requested scopes are not treated as granted scopes.

The same verified grant reads Gmail's own profile (`userId: "me"`) and the current primary calendar
(`calendarId: "primary"`, primary flag and owner access required). The mailbox binding's opaque
external ID is the verified Google subject; its address is display metadata. An account-aware Gmail
adapter must always target `me` under that exact associated credential, never use a form field,
display address or mailbox external ID as a Gmail target override. Calendar uses the verified
primary calendar's exact provider ID. Google documents the primary lookup and ownership fields in
[CalendarList.get](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/get)
and the [CalendarList resource](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList).

Account metadata, fresh encrypted credentials, exact custody association and verified resource
bindings commit together. Reconnect requires the same provider subject and a current account,
generation and lifecycle revision. It updates the exact associated custody row even when the
provider's mailbox label/address changes; a collision rolls the transaction back. Existing resource
IDs are preserved. If a new consent no longer verifies an existing resource of the same kind, the
whole reconnect is refused, retaining the last account, token and bindings. A future explicit
resource-replacement lifecycle is needed for that case.

Disconnect changes the account's lifecycle status and invalidates its generation. It does not
revoke the grant at Google: use Google's third-party access settings separately. Associated
credentials remain permanently excluded from legacy credential readers/writers and legacy
removal, including revoked, failed and reconsent accounts. A default/list legacy read that matches
any associated row refuses the ambiguous selection rather than falling back to an older token.
Unassociated legacy credentials retain their old behavior. No email match automatically adopts
stored credentials or changes the installed owner configuration.

## Current integration boundary and manual verification

The UI reports **consent saved; agent use pending integration**. Saving consent does not connect an
agent door or prove provider-backed runtime use. New managed-agent mailbox setup is unavailable
until its account-aware runtime adapter is integrated; its old route refuses before provider work.
Legacy selected mailboxes retain their existing exact principal/org/mailbox and door-incarnation
checks, and cannot select newly associated personal credentials.

`services/console/tests/live/google-account-consent.live.mts` is a manual, opt-in probe of the
actual Google consent response, identity, granted scopes, own Gmail profile and primary owned
calendar. It stores no credential and sends no mail or calendar writes. Local simulated-provider
and database tests establish refusal/transaction behavior; they do not establish live Google
acceptance. The manual probe has not been run as part of this source change.

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

- Disconnecting an account does not revoke the token at Google.
- Adding a capability to an agent from this page is done in Edit agent, not on the Connections
  page.
- Account-aware runtime use and managed-agent consent wiring remain pending integration.
