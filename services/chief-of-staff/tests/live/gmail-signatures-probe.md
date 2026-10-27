# Gmail signature probe

This manual probe compares the HTML structure of one configured send-as signature, one agent
draft, and one message the owner sent from Gmail. It reads only the explicitly selected items;
it does not list or search mail, create or edit drafts, send mail, or change settings.

## Owner-run steps

1. In the owner's own Gmail account, select one configured send-as address, one agent draft,
   and one owner-sent message (preferably a new message or reply that used that signature).
   Copy their identifiers from the owner's normal Gmail workflow. Do not use a bulk export or
   mailbox search to collect samples.
2. In the existing chief-of-staff environment with its already configured Google session, set
   `PROBE_ACCOUNT` if needed, plus `PROBE_SEND_AS_EMAIL`, `PROBE_DRAFT_ID`, and
   `PROBE_SENT_MESSAGE_ID` to those three selections. Run `tsx gmail-signatures.live.mts` from
   `services/chief-of-staff/tests/live`.
3. Keep the JSON output private to the owner. It reports whether HTML was available, element
   counts, inline CSS property names, and whether the configured signature's element-name
   sequence occurs in each sample. It intentionally omits identifiers, headers, text, addresses,
   links, CSS values, profile fields, and HTML. Do not add raw provider responses or sample
   content to logs, tickets, or source control.

The probe's default output says only that it is unavailable if configuration or a provider read
fails; it does not print raw errors or identifiers. A blank or structurally different result is
not proof that Gmail removed or changed the signature. Inspect the owner's source samples locally
if a human visual comparison is needed, and keep that material private.

## What this probe can establish

It reads the configured signature for exactly the selected send-as address using the existing
`users.settings.sendAs.get` adapter call. It can compare structural summaries for the selected
draft and sent message. Finding the configured signature's tag sequence in the sent message is a
useful hint, not reliable isolation of the semantic signature block; quoted replies, wrappers,
or repeated elements can produce false matches.

The current read-only adapter does not expose send-as listings or the `isDefault` / reply-default
flags. Therefore this probe does not answer whether Gmail exposes new-message versus reply
defaults or multiple named signatures through those fields; that remains unproved. It also does
not call People API, so it does not establish which profile fields are readable or what scopes
they require. Finally, read-only access cannot prove that `sendAs.update` would succeed; no write
scope is requested or tested here. Microsoft Graph signature support and the EWS retirement dates
were not researched in this slice and remain pending. No negative finding about any of those
questions should be inferred from this probe.
