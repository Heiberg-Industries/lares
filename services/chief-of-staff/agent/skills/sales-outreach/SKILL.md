---
name: sales-outreach
description: Use when the owner asks you to research a company and draft outreach, follow up with a prospect, or otherwise do sales-outreach work — this replaces the retired Nora agent.
---

# Sales outreach

Nora is retired — this is her whole loop as a Saga skill: research → draft → approval card
→ send → track for a reply. There is no separate agent to hand off to; do this yourself.

## 1. Which mailbox

Ask which mailbox to send from if it isn't obvious from context — don't assume. The owner's
connected mailboxes, and which audience each is for, are in my own voice section; when it has
to be right rather than remembered, `identity_my_addresses` is the registry of what is actually
enrolled. Pass whichever one I picked as `account` on every Gmail tool call below.

## 2. Do-not-contact check

Before drafting anything, look up the person (`twenty_lookup` / `twenty_get_person`). If
`doNotContact` is true, stop and tell the owner why — never draft or send to a flagged person.

## 3. Research

Enrich the target company: `agent-kit__orakel_enrich_org` (by org number) or
`agent-kit__orakel_enrich_domain` (by domain), and `read_url` on their site if useful. This
is best-effort — a miss on research
never blocks drafting; note what you couldn't find and proceed with what you have.

## 4. Draft

Call `voice_guide` with a one-line description of what the email is about, the `account`
you picked in §1, and the recipient's language if known. The `account` matters: examples
come from that mailbox's own sent mail, because tone shifts by audience and each mailbox has
its own. Follow its `voiceGuide` instructions and use
its `exampleEmails` for tone if any came back — both may be empty if no voice profile is set
up yet, in which case draft normally, briefly and personally, referencing something real
from the research.

## 5. Send — the tool call IS the approval card

Call `gmail_send` with the drafted subject/body and the chosen `account`. This is gated
(`approval: always()`) — calling it renders the owner's 👍/👎 card directly. Do not ask "should I
send this?" first; the tool call itself is the ask. Do not fabricate a threadId or pretend it
sent before the approval resolves.

## 6. After a successful send

Once `gmail_send` returns (meaning it was approved and actually sent), do both of these:

- Call `outreach_track` with the returned `threadId` AND `sentAt`, the `account` you sent
  from, and the Twenty `personId` if you have one. `sentAt` anchors reply-detection to the
  actual send time — omitting it can make a very fast reply invisible. This starts automatic
  reply-watching — you do not need to wait around in this conversation for a reply; a
  separate schedule checks for one and will start a fresh conversation with the owner when it
  finds one.
- Call `twenty_comm_state` with `state: "email_sent"` on the person record (only if you have
  a `recordId` — skip silently if you don't, don't block on it).

## What happens next

When a reply arrives, the reply-watch schedule starts a new conversation instructing you to
triage it (positive / negative / meeting_request / unsubscribe / not_now / bounce) and, for
positive or meeting_request, draft a reply — same voice-guide-then-gated-send shape as above.
You do not need to do anything proactively here; just handle that conversation normally when
it starts.
