# Personal connected-account persistence

`PgAccountStore` stores member-owned connected-account and selected-resource metadata. It
uses the shared `ConnectedAccountView` and `ResourceBinding` shapes. It does not store or
resolve credentials, connect a provider, enable console routes, or claim complete multi-user
isolation. Existing encrypted OAuth and keeper custody remain unchanged. Legacy OAuth rows
are never adopted by matching an email or display label.

A trusted server adapter supplies account and resource verifiers through `forTrustedAdapter`.
The adapter must verify provider responses and ownership before returning an issuer, subject,
tenant and display-safe label, or a resource identity. These functions are not model-facing
binding tools. Parsing their output checks shape only; it does not verify provider evidence.
Use maintained provider SDKs in adapters. Never return raw provider errors, secrets or tokens
in labels, status reasons or metadata. Sign-in and provider consent remain separate.

Every operation checks the shared current active member in the same database transaction as
its account access. Account ownership is exact; organisation owners do not inherit personal
accounts. Resources bind only to their account's member. Company account creation refuses
until account-manager and grant enforcement are integrated. Personal automation remains
`draft-and-ask` in this storage slice.

Before asynchronous provider work, capture `beginUpdate(memberId, accountId, generation)`.
The resulting metadata ticket carries account authority generation and a lifecycle revision.
Return it unchanged to renewal, status changes or reviewed replacement. Neither counter is a
credential reference. Both are compared under a database lock when a result is committed, so
stale callbacks and concurrent transitions cannot overwrite newer state. Capture before work,
not after it. Tickets do not authenticate callers or replace execution-time grant checks.

An ordinary verified renewal of the same issuer, subject and tenant preserves account ID,
resource IDs and authority generation. Only the internal lifecycle revision advances; a
routine token rotation therefore does not disable stable resource references. Credential
refresh concurrency remains the responsibility of existing credential custody, not this store.

Revocation, reconsent and provider failure advance authority generation and stop resource
selection. An explicit verified reconnect of that same identity restores access, advances
authority generation again and preserves resource IDs. Old jobs and approvals still require
new authority. Labels never establish that two accounts are the same.

A different identity is accepted only through `replace` with an explicit reviewed replacement
marker from a trusted caller. The marker records the caller's reviewed transition; it is not
an approval system. Replacement creates a new account ID and revokes the old account,
advancing its authority generation. The old provider identity and resource bindings remain attached to that revoked
account so receipts and historical references stay intelligible. Newly selected resources
receive new binding IDs,
even when the provider supplies an identical external resource ID. Old bindings never silently
point at the replacement account. Persistent jobs, approvals and grants must recheck current
account generation and resource identity before credential resolution in later integration.

SQL008 is additive and can be reapplied. Both tables carry registry member IDs for export and
erasure, with foreign keys preventing a binding from crossing account owners. Removing a member
makes API access unavailable; deleting their registry row cascades these metadata records.
No provider-backed proof or runtime deployment is supplied by these database tests.
