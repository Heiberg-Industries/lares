# Using the console

The console is the web page at your installation's domain. Sign in with your explicitly linked
Google or configured Microsoft 365 work identity. This is a tour of the existing owner screens.
Installing is in [`install.md`](../install.md).

Pages under Settings and Connections are not all in the sidebar. They are reached from the page
named in brackets.

## Sign-in, members and sign-out

The sign-in page offers **Continue with Google** and **Continue with Microsoft 365 work
account**. Microsoft requires the owner to configure an organisational tenant and client first.
Sign-in requests identity only; it does not connect a mailbox or calendar. Email/password and
email-link sign-in remain unavailable.

The designated existing owner can open **Members** to create one-use invitations, revoke an
open invitation, remove another member's access or sign out their sessions. Deliver invitation
links privately. Other active members get only their own **Your membership** page and sign-out
controls while shared resource access is being integrated. Giving a second member the owner
role does not open the existing shared console screens or inherit private data.

**Sign out** revokes the current server session before returning to the sign-in page. **Sign
out everywhere** on the membership page revokes all your sessions. An unavailable membership
store refuses access and reports an unavailable state; it does not pretend you are signed out.
Existing installations need explicit provider-identity adoption of their stable owner id; the
old email allow-list is no longer admission authority. See
[member admission and setup](../member-authority.md#provider-setup-and-existing-owner-adoption).

## Home

A quiet overview: agents that have failed workflows, your agents, and the latest permission
checks. Approval requests are not here; they are in Waiting on you.

## Waiting on you

Every approval an agent is waiting for, from every conversation, with everything it would do.
Decide here or in the place it was asked (web chat, Slack, Telegram). A Telegram card too long for
one message links here. You only see items for agents you own. If an agent could not be read, the
page says why (did not answer in time, refused the console's request, could not be reached,
returned an error) rather than hiding it.

## Chat, and the web chat inbox

**Chat** talks to an agent in the browser. Web chat is the one door every agent has.

Above the chat, **messages the agent left for you** appear: a brief, a nudge, a notice, or a
request that needs your approval. Each has **Reply** (opens a new chat with the message already in
the box, ready to send) and **Mark as read**, and there is **Mark all as read**. Older read messages
sit under "Earlier messages". A dot beside Chat in the sidebar shows while something is unread.
The page looks for new messages when it opens and about every 30 seconds while the tab is visible
(the dot every 60); nothing is pushed.

A message that asks the agent to do something (a CRM routing proposal, an outreach reply, a
meeting follow-up to send) arrives as the facts plus a Reply. The approval card then appears in
that chat, and in Waiting on you. Meeting follow-ups routed to web chat are never sent
automatically for this reason.

## Agents

The list of agents, and **New agent** (pick a role, name it, write its duties and personality,
choose what it may touch; the keeper saves the definition and starts it). The box holds a limited
number of agents; the new-agent page says why and how many (the limit protects the server from
running out of memory, and a fresh install starts at one).

An agent's page has four tabs and two buttons, **Chat** and **Edit agent**:

- **Overview**: who it is and its state.
- **Access**: what it may touch, grouped as reads, acts without asking, and you decide. Locked
  outside-tool descriptions are accepted here
  ([`outside-tool-tokens.md`](../runbooks/outside-tool-tokens.md)).
- **Schedules**: the recurring work it does, each with a sentence saying what it does and when,
  and **Where messages go** (below).
- **Activity**: recent permission checks for this agent.

**Edit agent** changes the definition. It also holds **Connect doors**: Slack, Telegram and, for
the chief of staff, the e-mail door
([`install.md`, section 8](../install.md#8-doors-outside-tools-and-integrations)). Changes to
doors and credentials reach the running agent when you press **Apply connection changes**; that
restarts the agent for about a minute.

### Where messages go

On the Schedules tab. A grid with one row per kind of message the agent starts by itself (morning
brief, evening brief, weekly summary, nudges, deadlines, proposals, email triage, meeting
follow-up, outreach replies, CRM routing, digest, reminders) and one column per door (web chat,
Slack, Telegram). Number the doors 1st, 2nd and 3rd for each row. The message tries them in that
order, skipping any door that is not connected, and **web chat is always the last resort**, so
nothing is dropped. A door that is not connected is labelled "(not connected)". Rows you have not
saved are filled in with what happens today and marked "today"; **Save** writes every row, and it
applies the next time that message is sent.

When a message went somewhere other than you asked, the page says so ("Morning brief went to web
chat: Telegram is not connected"), and so does the Proactivity ledger. The sentence goes away when
the latest message of that kind went where asked. A new chief of staff starts with every kind going
to its first chat door, then web chat.

## Activity

**Permission activity**: the decisions made about what your agents may do, newest first, with a
filter by agent name. It records permission decisions, not completed work; that is in the original
conversation. **Signals & events** (a button on the page) lists recorded alerts, events and
reports, filterable by severity, kind, state and project, with a catalogue of what each signal type
means and **Signal routes** (also under Settings, "Alert routing") for where alerts are delivered.
What the agents sent you and what was held back is on the Proactivity page.

## Preferences

Places, music and food notes your agents can draw on, stored on this installation. The console
writes them and agents read them; nothing syncs by itself. Import a Google Maps list (the CSV from
Google Takeout) or paste a list; importing the same list again updates its entries. "Maintain saved
places" fills in city and country from coordinates (offline), sets a list's country and checks pins
against their source links.

## Proactivity

[Settings, Manage] The one gate every unprompted message passes
([ADR-0014](../decisions/0014-proactivity-contract.md)):

- **Do not disturb**, for every agent or one agent: nothing starts at all, including reminders
  you set yourself.
- **Quiet hours**, per door, on your clock (the installer takes it from the server's time zone).
  The default is 21:00 to 07:00. The window can move but must stay at least 8 hours long. A
  reminder you set yourself still arrives inside quiet hours; anything the world caused waits until
  the window ends.
- **When the agents speak**: the hour of each brief and similar schedule, with a sentence about
  each. A change is picked up within about five minutes and applies from the next full hour. A
  brief goes out only at the start of its hour. Moving a brief's hour after today's has gone out
  does not send a second one.
- **Brief hours cannot sit inside quiet hours.** Saving a brief hour, a door's quiet hours or a
  routing is refused when a brief would fall inside the quiet window of the door it goes to,
  because it would be held back every day. The page says which brief, which hour and which window,
  and offers the two fixes: choose an hour outside quiet hours, or change where it goes. A routing
  save only checks the kinds it changes.
- **Ceilings**: the most you can be interrupted in one day (defaults 20 events and 3 escalations
  per door, 30 in total). Lower them freely; those numbers are the highest they can go.
- **Today** and **Last 50 decisions**: what was sent, held back (dropped for good) or is waiting
  (deferred), with the reason. A message held back is recorded, never lost.

The page also sets the language of the briefs.

## Deadlines

A calendar of deadlines and renewals you add one at a time; with a standing yearly calendar file it
shows those too
([`install.md`, section 7](../install.md#7-the-console-and-the-deadline-calendar-file)).

## Connections

Accounts, recorded connection status and what each agent may do with each. Connect a Google
account here, add the Notion key, set up saved-link clipping, and set each agent's autonomy
level per capability (acts on its own, asks first, never). Details:
[`services/console/docs/integrations-and-accounts.md`](../../services/console/docs/integrations-and-accounts.md).
Two further pages are reached from the buttons at the top.

### Meetings

[Connections, Meetings] Recurring meeting series an agent may send the follow-up e-mail for without
asking first. Revoking a series does not delete its history; it goes back to needing your approval.
You switch a series on by asking the agent. Meeting follow-ups read your meeting notes from Notion,
so they need the `NOTION_MEETINGS_DATA_SOURCE_ID` setting (the id of your Meetings database); with
it unset the schedule says so each time it runs. It is set in the server's keeper configuration,
not in the console; see the install guide, "Meeting follow-ups and Notion".

### Voice (Email writing style)

[Connections, Email writing style] One card per mailbox describing how you write, learned from that
mailbox's Sent mail; your edits always win. A mailbox with an empty card uses the shared defaults.
You can re-run the learning, limit how far back it reads and how many messages it checks, and
untick an example e-mail to exclude it from style matching (it stays stored). A new proposal from
learning is shown for you to accept.

## Backup

[Settings, View backup status] A read-only record: **Protected** (last night's backup was verified
and a restore from it was rehearsed within the last 45 days), **Unproven** (verified, but no
restore ever rehearsed) or **Not protected**, with the checks behind it: the nightly backup verify
and the monthly restore drill. It runs nothing itself. Switching backups on is
[`lares backups`](../install.md#9-backups-and-the-restore-drill).

## Settings

Quiet hours and time zone (links to Proactivity), **Models** (read-only: the gateway's address and
whether it answers, and for each purpose which agents use it; it never makes a paid request),
appearance (light, dark, or follow your device), backup and recovery, and links to Email writing
style and Alert routing.
