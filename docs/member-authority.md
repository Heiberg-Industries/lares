# Member admission storage

`@lares/agent-kit/member-store` supplies server-only PostgreSQL storage primitives. This is
foundation work: existing console login, routes and channel identity resolution do not use it.
It does not enable a second-member UI or establish complete multi-user isolation.

## Identity and admission

SQL `007_member_identity_sessions.sql` preserves `users.id`, existing rows and all other data.
It adds `status` (`invited`, `active`, `removed`) and `automation_mode`. Existing users and
legacy bootstrap inserts retain `active`; the invitation API explicitly creates `invited`
users with `draft-and-ask`. This legacy default must not be used as a new admission mechanism.
A populated database with missing organisation assignments, duplicate normalised emails, or
an organisation without an active owner refuses the migration atomically. Reconcile the
specific existing records explicitly before retrying; never merge users on email equality.
Email uniqueness prevents ambiguous invitations but does not establish identity.

An active owner can issue an invitation for a new member. The generated 256-bit token is
returned once for delivery by trusted server code; only its SHA-256 hash is stored. Acceptance
requires possession of that token and a fresh `VerifiedProviderProof`. Invitations expire,
are consumed once, can be revoked, and are invalidated by member removal. Removed records
are retained and cannot be reactivated or reinvited by these primitives.

Provider identity is the exact issuer, subject and optional tenant. It is globally unique
and cannot move to a different member through linking. Linking requires explicit current
member authorisation (their own record) or an active owner in the same organisation. Provider
proof must come from a trusted admission adapter using a maintained authentication library,
including its callback/nonce/state and issuer/audience checks. `verifiedAt` is a freshness
check, not cryptographic proof. The store never accepts a provider token, verifies a signature,
or infers identity from email. Do not expose it as a model-facing endpoint or tool. Connected
mailbox/calendar consent is separate and is not created here.

## Sessions and current authority

Session creation requires a fresh proof for an already linked active member. Session tokens
also contain 256 random bits and are returned only at issuance. Status lookups return the
shared secret-free `Member` shape; neither raw tokens nor their hashes appear in those results.
Session lookup rechecks expiry, revocation and active member status. Individual sign-out,
sign-out-all and removal revoke server-side sessions. Removal also invalidates invitations.
The last active owner cannot be removed, deleted, moved or demoted, including through direct
SQL; designate another active owner first. Organisation locks serialize member-store writes;
a unique database identity key arbitrates linking across organisations.

`currentMember(db, id, { lock: 'share' })` is the common active-member check for other stores.
Use a transaction's `PoolClient` and keep its row lock until the protected mutation commits.
The unlocked lookup and `PgMemberStore.currentMember` are snapshots, not authorization for a
later mutation. Admission callers must authenticate the actor before supplying an id. No
resource/grant policy, private-data inheritance or runtime authentication changes are included.

## Verification

Run the focused `packages/agent-kit/tests/member-store.test.ts` database tests and the box
member-scope inventory/person-identity tests against disposable PostgreSQL containers.
The CI image probe applies every numbered migration to an empty pgvector database and
reapplies this migration with invited/removed members and existing identity/session data.
Provider-backed sign-in, route isolation and controlled two-member acceptance remain separate
runtime integration work; disposable database tests are not provider verification.
