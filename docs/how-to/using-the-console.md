# Using the console

The console is the web page at your installation's domain. Sign in with your explicitly linked
Google or configured Microsoft 365 work identity. This is a tour of the owner screens, in the order
of the menu on the left. Installing is in [`install.md`](../install.md).

Every page is in the menu, its title is its menu words, and its address is those words:
**Reviews** is `/reviews`. A few more items are greyed out in the menu with a "Coming" tag; they are
not built yet. Under your name at the foot of the menu are **Your membership**, **Appearance** and
**Sign out**.

## Signing in and out

The sign-in page offers **Continue with Google** and **Continue with Microsoft 365 work
account**. Microsoft requires the owner to configure an organisational tenant and client first.
Sign-in requests identity only; it does not connect a mailbox or calendar. Email/password and
email-link sign-in remain unavailable.

**Sign out**, under your name, revokes the current server session before returning to the sign-in
page. **Sign out everywhere** on **Your membership** revokes all your sessions. An unavailable
membership store refuses access and reports an unavailable state; it does not pretend you are
signed out. First sign-in on a fresh installation uses the discovery and fresh-callback steps in
the [install guide](../install.md#6-first-start-and-checking-it-worked). Existing installations do
not use this first-owner bootstrap; recovery needs separate review. The old email allow-list is
not admission authority. See
[member admission](../member-authority.md#first-owner-setup-on-fresh-installations).

## Overview

A quiet overview: the failed workflows of your agents (under **Alerts**), your agents, and the
latest permission checks, with a link to each full page. Approval requests are not listed here; a
card points to **Reviews**.

## Reviews

Every approval an agent is waiting for, from every conversation, with everything it would do.
Decide here or in the place it was asked (web chat, Slack, Telegram). A Telegram card too long for
one message links here. You only see items for agents you own. If an agent could not be read, the
page says why (did not answer in time, refused the console's request, could not be reached,
returned an error) rather than hiding it.

## Chat

**Chat** talks to an agent in the browser. Web chat is the one door every agent has.

Above the chat, **messages the agent left for you** appear: a brief, a nudge, a notice, or a
request that needs your approval. Each has **Reply** (opens a new chat with the message already in
the box, ready to send) and **Mark as read**, and there is **Mark all as read**. Older read messages
sit under "Earlier messages". A dot beside Chat in the menu shows while something is unread.
The page looks for new messages when it opens and about every 30 seconds while the tab is visible
(the dot every 60); nothing is pushed.

A message that asks the agent to do something (a track routing proposal, an outreach reply, a
meeting follow-up to send) arrives as the facts plus a Reply. The approval card then appears in
that chat, and in **Reviews**. Meeting follow-ups routed to web chat are never sent
automatically for this reason.

## Agents

The list of agents, and **Create agent** (pick a role, name it, write its duties and personality,
choose what it may touch; the keeper saves the definition and starts it). A fresh installation
starts with a limit of 1 as a conservative setting, not a measurement of this server’s capacity.
The **Agents** card on **General** shows a separate rough RAM estimate: about 2.5 GiB for Lares,
2 GiB kept free, and 1.5 GiB per agent. Only the installation owner can change the limit; review
that estimate first. If you cannot change it, ask the installation owner to review the **Agents**
card on **General**.

An agent's page has four tabs and two buttons, **Chat** and **Edit agent**:

- **Overview**: who it is and its state.
- **Access**: what it may touch, grouped as reads, acts without asking, and you decide. Locked
  outside-tool descriptions are accepted here
  ([`outside-tool-tokens.md`](../runbooks/outside-tool-tokens.md)). For a chief of staff it also
  holds **Mailbox**: which of your Google accounts it sorts mail and writes reply drafts in
  (drafts only, it never sends). Choose the account under "Works on"; only the agent's owner can.
  If you disconnect or reconnect the account, the line says "Mailbox paused" and why; press
  **Confirm** after a reconnect, or choose again. Connect the account first on **Your accounts**
  (or with **Connect Google** on this line), using "Read mailbox and calendar, and write drafts".
- **Schedules**: the recurring work it does, each with a sentence saying what it does and when,
  and **Where messages go** (below).
- **Activity**: recent permission checks for this agent.

**Edit agent** changes the definition. It also holds **Connect doors**: Slack, Telegram and, for
the chief of staff, the e-mail door
([`install.md`, section 8](../install.md#8-doors-outside-tools-and-integrations)). Changes to
doors and credentials reach the running agent when you press **Apply connection changes**; that
restarts the agent for about a minute. So does a change of role, personal accounts or, where
spending is set up, model. Every other change needs no restart. Instructions, personality, language and outside tools reach the agent at its next conversation; schedules and where messages go, the next time a schedule runs. The description is a label; the agent does not read it. Saving a
change ends the agent's open web-chat conversations, and any approval waiting in them; the page says
so before you save. Start a new conversation afterwards.

For a chief of staff, each door that reads "Connected" has **Send a test brief to Slack** (or
Telegram): the agent writes this morning's brief now and sends it there, starting with "Test brief",
within about two minutes. The line below the button says "Sent to Telegram at 10:42", or why it was
not sent. It costs about one normal brief from your own monthly limit, ignores quiet hours and
do-not-disturb because you asked, and never counts as the day's brief. It is refused when the agent
is not running, the door is not connected, the agent is shared, the morning brief is off, a test is
already on its way, or after ten in a day. On the tested path, the real-install check presses it
once for Slack and once for Telegram (stand-ins for both apps) and sees each brief arrive in its
chat and charged to you as an owner job.

### Where messages go

On the Schedules tab. A grid with one row per kind of message the agent starts by itself (morning
brief, evening brief, weekly summary, nudges, deadlines, proposals, email triage, meeting
follow-up, outreach replies, track routing, digest, reminders) and one column per door (web chat,
Slack, Telegram). Number the doors 1st, 2nd and 3rd for each row. The message tries them in that
order, skipping any door that is not connected, and **web chat is always the last resort**, so
nothing is dropped. A door that is not connected is labelled "(not connected)". Rows you have not
saved are filled in with what happens today and marked "today"; **Save** writes every row, and it
applies the next time that message is sent. A chief of staff made in the console starts with every
row on web chat and switches to its first connected chat app by itself ("Briefs and other messages now go to
Telegram first"); after that, only you change the grid.

When a message went somewhere other than you asked, the page says so ("Morning brief went to web
chat: Telegram is not connected"), and so does the list of decisions on **Quiet hours and
delivery**. The sentence goes away when the latest message of that kind went where asked.

## Writing style

One card per mailbox describing how you write, learned from that mailbox's Sent mail; your edits
always win. A mailbox with an empty card uses the **Shared defaults** card. **Re-learn from Sent
mail** runs the learning again. **Learn settings** limits how far back it reads and how many
messages it checks, and an example e-mail can be unticked to exclude it from style matching (it
stays stored). A new proposal from learning is shown for you to accept.

## Your accounts

The Google and Microsoft work accounts you connected, each with the agents that use it. Connect
a Google account here (the install guide's section 8, under "E-mail", says what the installation
needs first). An account you connect stays yours: an agent works on it only when you choose it on
that agent's page. Older mailbox connections from an earlier way of connecting mail are listed
for the owner, who can remove them. Details:
[`services/console/docs/integrations-and-accounts.md`](../../services/console/docs/integrations-and-accounts.md).

## Integrations

The services shared by the whole installation, in two lists, **Enabled** and **Available**, with a
search box. Only the owner turns them on or changes them. Each opens a page with which agents use
it, when it was last used, where its key is kept, test buttons and what each agent may do with it
(acts on its own, asks first, never).

The **Notion** page holds every Notion setting, in the order you set them up: the Notion key, the
**Meetings database**, **People sync**, **Clipping**, the status of the document sync, and the
Notion proposals waiting for your yes or no.

- **Meetings database**: meeting follow-ups read your meeting notes from Notion, so they need the
  id of this database. With it unset the follow-up schedule says so each time it runs. Owner only;
  saving restarts the agents that read it. See the install guide, "Meeting follow-ups and Notion".
- **People sync**: meeting attendees and People records, once an hour. It is off until you switch
  it on, run a preview that shows what it would do, and accept it. See "The Notion sync
  (optional)" in the install guide.

## Outside tools

Tools from servers outside Lares. Each row shows its status, how many tools it offers and which
agents use it; open one to choose which agents may use it. **Add custom connector** takes a name
and the server's address, then shows what Lares found there. See
[`outside-tool-tokens.md`](../runbooks/outside-tool-tokens.md).

## Deadlines

The standing calendar of deadlines and renewals: what is **Open** (with days left, source,
reminder step and consequence; **Done** and **Dismiss** each ask for a reason), **Candidates** the
mail scanner spotted but has not turned into a row, and the last 20 closed. **Add a deadline** adds
one at a time. A section below holds the **Reminders** switch and, with a standing yearly calendar
file, **Add the year's legal deadlines**
([`install.md`, section 7](../install.md#7-the-console-and-the-deadline-calendar-file)). Nothing
here calls an authority; every date is confirmed by a human.

## Meeting follow-ups

Recurring meeting series an agent may send the follow-up e-mail for without asking first. Revoking
a series does not delete its history; it goes back to needing your approval. You switch a series
on by asking the agent. The Meetings database these follow-ups read is set on the Notion page
under **Integrations**.

## Saved preferences

Places, music and preferences your agents can draw on, stored on this installation. The console
writes them and agents read them; nothing syncs by itself. Import a Google Maps list (the CSV from
Google Takeout) or paste a list; importing the same list again updates its entries. "Maintain saved
places" fills in city and country from coordinates (offline), sets a list's country and checks pins
against their source links.

## Permission checks

The decisions made about what your agents may do, newest first, with a filter by agent name. It
records permission decisions, not completed work; that is in the original conversation.

## Alerts

Recent alerts, events and reports from your services, filterable by severity, kind, state and
project. A button leads to **Alert routing**.

## Members

Who can sign in to this installation, and the invitations that are still open. The designated
existing owner can create one-use invitations, revoke an open invitation, remove another member's
access or sign out their sessions. Deliver invitation links privately.

There are three levels. The **owner** is the person who set up the installation and sees every
page. An **admin** sees the agents and can use the shared pages (connections, tools, activity,
quiet hours and delivery, alert routing), but cannot create or edit an agent, set up an agent's
chat app, answer an approval, let a tool run without asking, or open **Members**, **Backups** or
**General**. A **member** sees only **Chat**, **Your accounts** and **Your membership**. The owner
picks Admin or Member for each person on this page, and can also invite someone directly as an
admin. A change takes effect the next time that person opens a page. Giving a second person the
owner role does not make them the owner here: they use the console as a member.

## General

Settings shared by the whole installation: the **time zone** (read-only here), **Models**
(read-only: the gateway's address and whether it answers, and for each purpose which agents use it;
it never makes a paid request), the **agent limit** and the **agent settings**.

The agent settings are the chief-of-staff values that used to be typed into the server's
configuration file, one block per area: **Business data** (CRM tracks, commercial brands, authority
sender domains), **CRM** (organisation number field), **Digest** (where saved articles are filed,
Slack target), **Telegram** (bot username) and **Console address**. A list setting is edited as one
box per value, with Add and Remove. Only the installation owner can change them; saving restarts
the agents that read the value, and each setting says whether it was saved here or still comes
from the installation file. See the install guide, "Business data and other agent settings".

## Quiet hours and delivery

The one gate every unprompted message passes
([ADR-0014](../decisions/0014-proactivity-contract.md)):

- **Do not disturb**, for every agent or one agent: nothing starts at all, including reminders
  you set yourself.
- **Quiet hours**, per door, on your clock (the installer takes it from the server's time zone).
  The default is 21:00 to 07:00. The window can move but must stay at least 8 hours long. A
  reminder you set yourself still arrives inside quiet hours; anything the world caused waits until
  the window ends. This card also sets the language of the briefs.
- **When the agents speak**: the hour of each brief and similar schedule, with a sentence about
  each. A change is picked up within about five minutes and applies from the next full hour. A
  brief goes out only at the start of its hour. Moving a brief's hour after today's has gone out
  does not send a second one.
- **Brief hours cannot sit inside quiet hours.** Saving a brief hour, a door's quiet hours or a
  routing is refused when a brief would fall inside the quiet window of the door it goes to,
  because it would be held back every day. The page says which brief, which hour and which window,
  and offers the two fixes: choose an hour outside quiet hours, or change where it goes. A routing
  save only checks the kinds it changes.
- **Limits**: the most you can be interrupted in one day (defaults 20 events and 3 escalations
  per door, 30 in total). Lower them freely; those numbers are the highest they can go.
- **Today** and **Last 50 decisions**: what was sent, held back (dropped for good) or is waiting
  (deferred), with the reason. A message held back is recorded, never lost.

## Alert routing

Where alerts are sent and what each one means. **Delivery** turns a whole destination on or off.
**Catalogue** opens the plain sentence shown with each kind of alert: what it means and what to do
next. **Advanced** edits the rules that decide which Slack channel each alert goes to; a mistake is
refused when you save.

## Backups

A read-only record: **Protected** (last night's backup was verified and a restore from it was
rehearsed within the last 45 days), **Unproven** (verified, but no restore ever rehearsed) or
**Not protected**, with the checks behind it: the nightly backup check and the monthly restore
test. It runs nothing itself. Switching backups on is
[`lares backups`](../install.md#9-backups-and-the-restore-drill).

## Under your name

**Your membership** shows your role, what it gives you and the **Sign out** and **Sign out
everywhere** buttons. **Appearance** switches the console between light, dark and following your
device. **Sign out** ends this session.
