# Member admission storage

`@lares/agent-kit/member-store` supplies server-only PostgreSQL storage primitives. Console sign-in uses these sessions and provider identities. Every console data page, action
and member API checks current database admission. Channel identity resolution is still a
separate boundary; this does not establish complete multi-user isolation.

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
resource/grant policy or private-data inheritance is implied. Console admission is described below.

## Verification

Run the focused `packages/agent-kit/tests/member-store.test.ts` database tests and the box
member-scope inventory/person-identity tests against disposable PostgreSQL containers.
The CI image probe applies every numbered migration to an empty pgvector database and
reapplies this migration with invited/removed members and existing identity/session data.
The console tests exercise callback state/nonce/PKCE, signature, issuer/audience/expiry,
provider mapping, current session checks and route coverage against simulated local responses.
Provider-backed sign-in and controlled two-member acceptance remain separate acceptance gates;
local source tests and disposable database tests are not provider verification.


## Console admission and the current access boundary

The browser receives an opaque 256-bit session token. Its database hash, expiry, revocation and
current active membership are checked in Node at every member entry point. Edge middleware
checks mutation origins and offers navigation based on cookie syntax only; it cannot authorise
a request. Old signed-email cookies are refused. Sign-out revokes the current server session;
any active member can sign out all their own sessions from `/membership`. The designated
owner can revoke invitations, remove another member or revoke their sessions in `/members`.
Owner-only directory reads return same-organisation member and invitation metadata, with no
provider credentials, token values or hashes.

**The existing console remains an unscoped owner surface.** Its global/private screens,
server actions and APIs require an active session whose stable member id equals
`AGENT_OWNER_USER_ID` and whose current role is `owner`. A different owner, member or restricted
member receives only their own `/membership` view and sign-out controls. Giving a second
member the owner role does not open those screens. Removal or demotion takes effect on the
next protected request. This is a staged admission boundary, not a claim that shared console,
connected accounts, channel conversations or private-resource isolation are complete.

The keeper and web-chat transport still receive the designated owner's current database
`primary_email` after stable-id admission. That address preserves their existing transport and
audit contracts; it is never used to look up, link or authorise console membership. Migrating
those contracts is a separate integration step. `/api/doors/<agent>/<platform>/events` is an
explicit platform-authenticated webhook relay and does not use member browser sessions.

## Provider setup and existing-owner adoption

The installation loads console sign-in settings from its existing protected
`console-oauth.env`. Keep the existing Google client settings:

- `GOOGLE_CLIENT_ID_CONSOLE` and `GOOGLE_CLIENT_SECRET_CONSOLE` (or `_FILE`).
- `CONSOLE_OAUTH_REDIRECT`: the exact HTTPS `/api/auth/callback` URI registered with the provider.
- `CONSOLE_SESSION_SECRET` (or the existing runtime secret-file setup): signs the short-lived
  OAuth transaction cookie; sessions themselves are random database-backed tokens.

Microsoft sign-in uses the same maintained `openid-client` library with the additional
`MICROSOFT_CLIENT_ID_CONSOLE`, `MICROSOFT_CLIENT_SECRET_CONSOLE` (or `_FILE`) and
`MICROSOFT_TENANT_ID_CONSOLE`. The tenant must be a fixed organisational tenant UUID, never
`common`, `organizations`, `consumers` or the Microsoft consumer tenant. Register a confidential
web application with the same callback. Only `openid email` is requested. This signs a person
in; it grants no Microsoft Graph, mailbox or calendar access. The installer still requires the
Google client for fresh installations; Microsoft-only installation is not implemented here.

An existing owner's `users.id` and all owned data stay intact. Before switching sign-in,
explicitly verify that the configured `AGENT_OWNER_USER_ID` names the intended active owner
with an organisation and a usable primary address for the existing transport contracts.
Obtain that person's exact provider issuer/subject (plus tenant for Microsoft) using the
manual probe below, then set `CONSOLE_BOOTSTRAP_IDENTITY` to that identity's JSON object in the
protected environment. The callback binds only a fresh verified proof matching that exact
object to the existing active designated owner. It creates no replacement user and never
matches email. A known identity cannot be reassigned. Remove the bootstrap setting once the
owner signs in successfully. An unset or mismatched mapping refuses unknown identities.
`CONSOLE_ALLOWED_EMAILS` is no longer admission authority; existing installer settings may
still retain it until their separate configuration update.

New members use owner-created invitations. `/members` returns the bearer link once; deliver
it privately to the intended person. Anyone holding the link can bind their verified identity
to the invited member, regardless of the record's contact email. The signed OAuth transaction
binds provider, PKCE verifier, state, nonce, invitation and return path; changing callback query
parameters cannot swap the invitation. Both the invitation page and authentication responses
send `no-store` and `no-referrer`. An invitation expires, works once and can be revoked. New
members begin draft-and-ask, and sign-in alone does not expand automation or data access.

The manual probe is `services/console/tests/live/console-oidc.live.mts`, run explicitly for
`google` or `microsoft` with an owner-supplied client and registered local callback. It verifies
a real provider sign-in through the same maintained client without writing members, sessions
or mailbox credentials. It prints no token or provider payload. For explicit bootstrap
preparation only, `OIDC_PROBE_SHOW_IDENTITY=1` prints the secret-free exact identity object;
keep that output private. Microsoft live execution remains deferred until the owner requests
it. Neither the existence of the probe nor local simulated-provider tests proves live success.


## Private console turn authority

`013_console_turn_authority.sql` adds an immutable, durable binding for each console session:
agent, runtime incarnation, Eve session id, server-generated admission nonce, stable member id,
private place and singleton audience revision. It does not use the prunable
`agent_conversations` projection as authority. Exact repeated binding is safe; changing its
member, nonce, place or audience refuses. Reset retires it; clear and compaction retain it.

The console forwards stable identity separately from its legacy approval email header. Every
session-addressed request rechecks current membership and runtime incarnation, including
streams, approval-only replies and controls. Browser-supplied authority headers are discarded.
Both role services bind first-message creation from an authored `session.started` hook, which
Eve awaits before dynamic capabilities; message-free creation is bound from the proxy's returned
session id before issuing the browser capability. Capability signatures use the exact stable
member id.

`@lares/agent-kit/console-turn-authority` exports `requireConsoleTurnAuthority(ctx)` for trusted
server consumers. It requires current human-message authentication, agreement with the original
admission tuple, current designated-owner membership and a current managed runtime. It returns
stable actor and speaker ids, the private place/audience and session/turn ids. Policy revision
1 identifies this admission contract; it is not a fingerprint of the permission board's full
policy. No model input can select a member or audience. Native channels, jobs, unknown sessions
and approval resolvers cannot acquire this authority by borrowing the session initiator.

All four Vault read factories validate tagged console calls before store access; filtered
read/search/backlink calls use that stable member as their reader. Plain note listings and
aggregate counts still have legacy scope limits. Both role catalogues check authority before
execution and request-time approval policy evaluation, retaining Eve's durable descriptors.
Approval-only resumes of bound console sessions fail closed until original-action authority
is durably stored. The Waiting page keeps native Slack/Telegram ownership checks and transports
a separate stable resolver identity without inventing a private console binding.

This remains a designated-owner console slice. It does not enable second-member access to
unscoped screens, provide complete audience filtering or claim multi-user release acceptance.
