# Outside tools: placing a token file

An agent's definition can list outside tool servers under `outsideTools`. When an entry says
`"token": true`, the server needs a key. The keeper mounts one file per such entry into the agent's
container, and for now the owner places that file on the server by hand.

For an agent named `<agent>` and an entry named `<name>`, put the key (the bare token, nothing
else) in the keeper's secrets folder as `<agent>-outside-<name>-token`. The file must be a regular
file, not empty and not a link. The keeper refuses to save the definition while the file is missing,
and the agent sees it at `/run/secrets/outside-<name>`. Restart the agent after the keeper has
re-rendered its compose file; changing the file's content alone needs the same restart. The engine
never names these files in a fixed list: the names come from the definition.

In the Console, the agent's Outside connections page edits only these declarations. Saving a change
marks it pending; use **Apply saved declarations** to reconcile it. The page compares the saved
declaration with the last applied declaration. Apply may update the recorded runtime definition
before agent startup fails, so an error does not prove that the previous declaration remains
applied. The page uses a refreshed applied-definition comparison when available; if it cannot
confirm the result, it marks the status unavailable and requires a refresh before another Apply.
There is no durable Apply-failure history. Applying declarations does not stage, activate or revoke
a separately held credential, and removing a declaration does not revoke or delete that credential.

The member page's private discovery flow accepts a credential for one bounded tool-description
lookup. A completed discovery awaits review; a staged candidate awaits Apply. These are distinct
states, and a newer discovery and staged candidate may coexist. This flow does not itself activate a
runtime credential. The page may show an active saved revision beside either pending state; this
reports custody state only and does not prove that the outside server is reachable or that a
credential has been mounted for agent use. A status that the current member cannot safely inspect
is shown as unavailable.

## Outside tools: locked tool descriptions

The words an outside server uses to describe its tools are read by the agent's model, but the owner
never wrote them. So the agent keeps a fingerprint (two hashes in the `outside_tool_pins` table,
created by `services/box/sql/001_baseline.sql`, with the review columns from `003_outside_tool_seen.sql`) of what each entry's allowed tools were
described as the first time it connected. At the start of every session it asks the server for its
tool list once and compares. If the descriptions are different, that connection is switched off for
the session and a repair opens: "outside tool `<name>` changed its tool descriptions; review and
re-approve". Editing an entry's address or allowed tools in the definition starts a fresh record
(the next connection is trusted as new). A connection that cannot be checked is switched off the same way: if the server does not answer the
check, or its key file cannot be read, the connection is off for that conversation and a repair
opens: "outside tool `<name>` could not be checked, so it is switched off for this conversation".
It is checked again in the next conversation. This is deliberate: a server that fails the check
could otherwise serve different descriptions to the agent afterwards.

When the descriptions differ, the agent also keeps what the server now says (the allowed tools'
names, descriptions and input schemas, and their fingerprint) next to the record. It never accepts
them itself. The agent's Access tab in the console shows the tool as locked, with the old and new
fingerprints and the new descriptions (next to the old ones when those were kept). After reading
them, press "Accept new tool descriptions". The keeper accepts only the fingerprint the page showed:
if the server changed its descriptions again in the meantime, it refuses and asks you to reload.
The next conversation then finds a match, keeps the connection and clears the repair; no restart is
needed. Very long descriptions (over 64 KiB) are not kept, only their fingerprint; the console says
so.

The record holds hashes and the descriptions the server published, never the address or a key. The
same Access tab says, for each outside tool that needs a key, whether its key file is in place. It
checks only that the file exists, is not empty and is not a link; it never reads the key.

## Outside tools on Telegram

Until the owner has seen a Telegram approval work on the real bot, an agent asked to use an outside
tool from Telegram refuses, and its answer says the approval is not available there yet and
suggests Slack. Nothing is done on that attempt. The same approval can be given in the console's
web chat, where the approval card appears in the chat and under Waiting on you; the refusal text
itself still names only Slack. To check Telegram: ask the agent to use a tool that writes, tap
Approve on the card, and confirm the write happened. Then set `OUTSIDE_TELEGRAM_APPROVALS_PROVEN`
to `true` in `packages/agent-kit/src/outside-connections.ts` and ship a new image.

A message that an agent sends on its own and that asks for such an approval (for example a CRM
routing proposal) can be routed to web chat in "Where messages go"; it then arrives in the web chat
inbox as the facts plus a Reply, and the approval card appears once you reply.
