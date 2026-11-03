# Gmail draft-to-sent probe

Question: when an agent writes a Gmail draft and the owner sends it, can we find the sent
message again? Google documents that sending a draft deletes the draft and creates a new
message with a new id. This probe tests whether a marker header we put on the draft survives
the send, from Gmail on the web and from the Gmail phone app.

## The only write

Each `create` run makes one draft addressed to the owner's own address. Nothing else is
written, and nothing is sent by the probe; the owner sends the draft to themselves. `inspect`
is read-only.

## Owner-run steps (do them twice: once with Gmail web, once with the Gmail phone app)

1. Inside the chief-of-staff environment, from `services/chief-of-staff/tests/live`:
   `PROBE_ACCOUNT=<mailbox> node --import tsx gmail-draft-to-sent.live.mts create`
   It prints a draft id, message id, thread id, marker and start history id. Keep that
   terminal output private; these are the only places identifiers are printed.
2. Open the draft in Gmail (web for the first run, phone app for the second) and press Send
   without editing anything.
3. Wait a minute, then run the `inspect ...` line that `create` printed:
   `PROBE_ACCOUNT=<mailbox> node --import tsx gmail-draft-to-sent.live.mts inspect --draft ... --message ... --thread ... --marker ... --since ...`
4. The JSON contains only booleans, counts and record-type names (no ids, addresses,
   subjects or text), so it can be pasted into a ticket. Note which client was used.

If the output says "not sent yet, or not visible yet", wait a minute and run inspect again.
On any provider failure the probe prints one plain line and no details.

## What it can establish

- Whether the draft and its message are gone after the send (`draftStillExists`,
  `draftMessageStillExists`) and whether the sent message has a different id
  (`sentIdEqualsDraftMessageId`).
- Whether the sent message is found through the same thread, newest message labelled SENT
  (`sentFound`, `sameThread`).
- Whether the `X-Lares-Draft-Marker` header survived (`markerHeaderSurvived`) and whether a
  standard Message-ID header exists. The draft's Message-ID is compared only if the draft is
  still present (otherwise that field is null).
- What the mailbox history shows between `create` and `inspect` (record types; whether the
  draft message appears as deleted and the sent message as added).
- Whether the sent plain-text body equals the text the probe wrote, ignoring whitespace.

## What it cannot establish

- Behaviour of other clients, other accounts, or drafts the owner edits before sending.
- Anything about drafts that have replies or quoted text: the probe's draft starts a new thread.
- Whether the thread lookup stays reliable when several sent messages share a thread; it picks
  the newest SENT message.
- Behaviour over time: history records expire, and the probe checks a single send.
