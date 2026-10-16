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
tool from Telegram answers that approving it is not available there yet and asks the owner to use
Slack. To check: ask the agent to use a tool that writes, tap Approve on the card, and confirm the
write happened. Then set `OUTSIDE_TELEGRAM_APPROVALS_PROVEN` to `true` in
`packages/agent-kit/src/outside-connections.ts` and ship a new image.
