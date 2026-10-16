# Integrations

Each folder here holds one `integration.json`: the single source of truth for what that vendor
integration is allowed to touch — which capabilities it backs, which hosts it may reach, which
secrets it reads, and how it is credentialed (see `docs/decisions/0019-integrations.md` for the
full field-by-field reasoning). `packages/agent-kit/src/connections.ts`, the capability docs'
vendor/region fields, the console's Connections rows and the outbound proxy allow-list are meant
to be generated from these manifests, not hand-edited. A folder whose name starts with `_` (for
example `_fixtures/`) is a test fixture the runtime never loads and the manifest loader always
skips — it exists only to prove the manifest shape can describe an integration before any code
for it is built. A new integration starts by adding a folder here with its own
`integration.json`, never by editing `connections.ts` or a capability doc directly. This is part
of the tested install path, not a promise of support (`docs/decisions/0022-the-tested-install-path.md`).
Where a credential is genuinely per-installation-instance rather than per-vendor — Google's OAuth
client id/secret, one pair per org; a Slack door's bot token and signing secret, one pair per
agent — the manifest's `secrets` field stays empty and those instance-level secret names stay in
`connections.ts`, which is installation data wave 9 moves out of the engine entirely.

## Provenance and quality: two separate questions

An integration's `provenance` answers "who maintains it and where does it live" — is it shipped
with the engine, contributed by someone else, or private to one installation? Its `tier` answers
"how well made is it" — does it pass the entry-level checklist, or more? These are independent.
A private integration written carefully can be tier `bronze`. A shipped integration still being
worked on can be tier `none`. Showing one axis as if it were the other misleads the owner — "core"
does not mean "well tested", and "contributed" does not mean "bad".
