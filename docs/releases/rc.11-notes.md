# rc.11 release notes

rc.11 follows rc.10 (`releases/2026-10-16-rc.10.json`) and is recorded in
`releases/2026-10-19-rc.11.json`. It is the release after the rc.10
confirmation run: a fresh install of the tested path, checked by hand, with every rough edge it
found fixed, plus two larger changes to how the owner reaches their agents. Messages an agent
starts by itself now have a chosen route with web chat as the last resort, and connecting Slack or
Telegram is a paste and a tap instead of a ten-step ritual. It adds one database file
(`services/box/sql/004_web_inbox.sql`). The database image, the gateway and the proxy in front of
the console are the same as in rc.10. The keeper, console, sync jobs, firewall helper, egress proxy
and both agent images were rebuilt from the new source.

## What changed

### Where messages go

- **Every automatic message has a route you choose.** The morning and evening brief, weekly
  summary, nudges, deadline warnings, proposals, e-mail triage, meeting follow-ups, outreach
  replies, CRM routing, the digest and reminders each try an ordered list of doors: web chat, Slack,
  Telegram. The first connected door is used. If none is connected the message goes to web chat,
  which every agent has, and the record says why ("Morning brief went to web chat: Telegram is not
  connected"). Before, a message whose door was not connected was dropped with one line in a log.
  An agent with nothing saved keeps its usual door and falls back to web chat the same way. Quiet
  hours, do-not-disturb and daily limits apply to whichever door is used.
- **A grid to choose it.** On an agent's page, Schedules tab, "Where messages go": one row per kind
  of message, one column per door, doors numbered 1st to 3rd. Doors that are not connected are
  labelled. Rows you have not saved show today's behaviour, marked "today". A new chief of staff
  starts with every kind going to its first chat door, then web chat.
- **A web chat inbox.** Messages left in web chat show above the chat with Reply and Mark as read
  (and Mark all as read); a dot beside Chat in the sidebar shows unread ones. The page looks every
  30 seconds while the tab is visible; nothing is pushed. A message that exists to ask for an
  approval arrives as the facts plus a Reply, and the approval card then appears in that chat and
  under Waiting on you. Meeting follow-ups routed to web chat are never sent automatically. Telegram's
  one-tap buttons on proposals stay Telegram-only; Slack and web chat get the text.
- **Brief hours can no longer sit inside quiet hours.** Saving a brief hour, a door's quiet hours or
  a routing is refused when a brief would fall inside the quiet window of the door it goes to, with
  a sentence naming the brief, the hour and the window. A routing save only checks the kinds it
  changes. If the check cannot read what it needs, the save goes ahead as before.
- **Web chat approvals on a fresh installation.** rc.10 let a signed-in web chat approve when no door
  was claimed; rc.11 fixes the case it missed: with no door or e-mail claim yet, approval falls back
  to the installation's administrator (the owner's console address) instead of nobody. A claimed
  door still takes precedence.

### Connecting a door

- **Telegram: paste the token, tap one link.** Paste the bot token and press Connect. The console
  saves it, checks it with Telegram, switches the door on, applies it, registers the webhook and
  shows "Tap to connect". Tapping it and pressing Start connects the owner; nothing is copied.
- **Slack: paste two values and send one message.** The manifest, with this installation's
  addresses, opens or copies in one press. Paste the bot token and signing secret and press
  Connect; the console checks the token, switches the door on, applies it, and shows the one
  message to send, with a Copy button.
- **The page finishes by itself.** After your tap or message the page notices, applies the last
  change and reloads. An "Applying..." box shows while work runs; a door you have not touched reads
  "Not set up" instead of "Pending"; the "Refresh connection status" button is gone. The one-time
  code is unchanged in kind: it expires after 10 minutes, ten wrong tries lock it, and only a
  signed-in owner can issue it. Telegram's `/start <code>` counts as the same claim as
  `claim <code>`; a bare `/start` is not a claim.
- **A door cannot be switched on without credentials.** The refusal now says what to do ("Telegram
  needs a bot token before it can be turned on. Save the credentials first.") and the console no
  longer locks the door panel with an "outcome unknown" warning.

### Console

- **A designed sign-in page.** Signed-out visitors see a sign-in page with Continue with Google
  instead of being sent straight to Google. Microsoft, e-mail and password, and an e-mail link are
  shown as "Coming soon" and do nothing yet. Signing out lands here with "You're signed out", and
  problems (account not allowed, e-mail not verified) show in plain words. After signing in you
  return to the page you were heading for.
- **Sign-out really signs out.** Console sign-in asks Google to show the account picker every time,
  so signing out no longer silently signs you in again as the same account.
- **Wording.** The new-agent page says why there is an agent limit, and the Instructions and
  Personality fields say that what you write is added after the role's built-in description and
  cannot loosen its safety rules (a "Show the built-in default" disclosure shows the role text).
  Language says it is the agent's default and changes only for a conversation when someone asks.
  Every schedule has a one-sentence explanation on the agent's page, in the editor and on the
  Proactivity page. Creating an agent shows progress ("Saving the definition", "Starting the agent",
  "Ready") and says plainly if it failed part-way.
- **Chat replies carry the agent's name** instead of "AGENT", without forced capitals.
- **A tour of the console** is new: [Using the console](../how-to/using-the-console.md).

### Fixes from the fresh-install run

- The install guide creates `/etc/lares` before writing the console sign-in file.
- Schedules that warn about a missing chat principal now log it once per process, not every minute.
- The meeting follow-up schedule no longer falls back to a built-in Notion database. Set
  `NOTION_MEETINGS_DATA_SOURCE_ID` in `/etc/lares/keeper.json` under
  `defaultBindings["chief-of-staff"].environment`; the keeper now accepts it. Without it the
  schedule stops with a clear message and nothing else is affected.

### Documentation

- The install guide: sign-in page, the paste-and-tap doors, the e-mail door, choosing where messages
  go, the web chat inbox and approvals, `lares doctor`, rollback and disk space.
- `services/box/README.md`, the role-template guide and the console's connections guide are rewritten
  for the installer-made layout; the export and teardown runbook no longer carries the old
  `/opt/agent-box` steps. The notion-sync, atlas-sync and sync-jobs pages now say the tested install
  does not start them.

## Upgrading from rc.10

1. **If your chief of staff files meeting follow-ups in Notion**, first set
   `NOTION_MEETINGS_DATA_SOURCE_ID` in `/etc/lares/keeper.json` under
   `defaultBindings["chief-of-staff"].environment` (the id of your Notion meetings database).
   Without it the meeting follow-up schedule stops with a clear message; nothing else is affected.
2. Pull the rc.11 images and swap the digests as for any update, using
   `./services/box/ops/update.sh --release releases/2026-10-19-rc.11.json`. It takes a backup first.
3. **There is one new database file**, `004_web_inbox.sql` (a table for the web chat inbox and a
   column for the reason a message went elsewhere). The update applies it; it is safe to run twice.
   A rollback does not undo it: to go back past it, restore the backup the update took.
4. Open an agent's Schedules tab and look at "Where messages go". Nothing changes until you save,
   except that a message whose door is not connected now goes to web chat instead of being dropped.
5. Nothing else to change for backups, settings or the keeper's configuration.

Check: the sign-in page appears when you are signed out; an agent's Schedules tab shows "Where
messages go"; the Backup page still reads Protected.

## Security scan

Scanner: Trivy 0.75.0 (run as the `aquasec/trivy:0.75.0` container, the same version CI pins), no ignore
list, high and critical findings only, run on 2026-10-19 against the published rc.11 digests (linux/amd64)
named in `releases/2026-10-19-rc.11.json`. The result is the same as rc.10: the same 29 advisories, no new
one and none fixed, and the same count in every image. The Debian base is still 12.15 in every image
except the egress proxy (Alpine 3.24).

| Image | Critical | High |
|---|---|---|
| console | 1 | 56 |
| keeper | 2 | 77 |
| egress proxy (Alpine 3.24) | 0 | 0 |
| firewall helper | 1 | 56 |
| chief-of-staff runtime | 1 | 68 |
| creative runtime | 1 | 68 |
| sync jobs | 1 | 68 |

Every finding is one of those accepted for rc.10, for the reasons given in
[the rc.10 notes](rc.10-notes.md#accepted-findings), and they are accepted again for rc.11. The base
image is reviewed again before v0.1.0. Each of the seven rc.11 images was started on 2026-10-19 and
searched: no `sshd`, `systemd-homed`, `homectl` or `curl` program is present in any of them. No Node
package in any image has a high or critical finding; the only findings outside Debian's packages are
the three Go advisories in the keeper's Docker Compose plugin, as in rc.10.

The new repository shows no open Dependabot alerts. The `sprintf-js` versions behind the moderate
advisory noted for rc.10 (GHSA-hp3w-g68c-fv3c, no patched version) are still in the lockfile, so that
note still applies.
