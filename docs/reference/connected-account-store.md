# Personal connected-account persistence

`PgAccountStore` stores member-owned connected-account and selected-resource metadata. It
uses the shared `ConnectedAccountView` and `ResourceBinding` shapes. It does not connect a
provider, enable console routes, or claim complete multi-user isolation. A server-only
association can link an explicitly verified account to its existing encrypted OAuth row.
Existing encrypted OAuth and keeper custody remain unchanged. Legacy OAuth rows
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

SQL012 adds `connected_account_credentials`, a server-only association to existing OAuth
custody. It stores no token value. Composite foreign keys require the exact canonical member
and connector on both sides. No alias, email or display label selects a credential, and legacy
rows remain unassociated. Account views and resource resolution never include custody row IDs.

A trusted account lifecycle caller may supply an `OAuthCredentialCommit.persist(db)` callback
to create, renew or reviewed replacement. Use the existing OAuth writer with the supplied
transaction; return only its exact token row ID. The account transition, credential write and
association commit together or all roll back. In particular, a same-email upsert that collides
with another identity's association rolls back rather than corrupting its old credentials.
Replacement must use a new custody row; an alias collision may require a new consent flow and
must refuse rather than reuse the old account's row. Ordinary token rotation for the same
verified account can retain its row and authority generation.

`resolvePersonalResource` returns a current secret-free account/resource snapshot after active
membership, ownership, account status, generation and resource-kind checks. A snapshot alone
must not authorize later credential resolution. `withPersonalResourceCredential` repeats those
checks and requires a matching generation-bound credential association in the same transaction.
Its trusted server callback receives the existing encrypted credential material and the same
transaction client for current authority rechecks while member,
account, resource, association and custody locks are held. Never return that material to a
model, log or client, and never hold these locks while waiting for human approval.

Revocation/reconsent/failure leaves historical associations intact but invalidates their
generation. Reconnecting with metadata alone does not reactivate credentials; an explicit
verified credential commit is required. Deleting the token row removes its association and
future resolution refuses. Removing a member refuses resolution immediately. Company resources
still refuse. This storage API alone does not supply runtime turn admission, grant/audience
checks, exact-action approvals or provider verification. The bounded personal Gmail caller
below integrates current private console authority for its two read operations only.

## Personal Gmail reads in private console turns

The chief-of-staff `gmail_accounts` read tool lists the current authenticated member's Google
account IDs, generations, statuses and mailbox binding IDs with display labels. It never
returns provider subjects, organisation configuration, custody IDs or token material. Its
executor requires the current original human's private singleton console authority; native,
resolver, unknown or retired sessions refuse. The listing is a snapshot, not a credential
capability or a provider-health check.

For a tagged console turn, `gmail_read` and `gmail_search` require an explicit `selection`:
`{ accountId, generation, resourceBindingId }`. Obtain those exact values from `gmail_accounts`.
An email address in the legacy `account` parameter, missing selection, stale generation,
another member's account, a calendar binding or missing current authority refuses without a
provider call. Server authentication supplies the member and audience; tool inputs cannot.
Native untagged channels retain their existing legacy `account` and default-selection flow;
they cannot use a personal selection or recover an associated credential through that path.

The runtime resolves only the generation-bound associated credential under the account store's
member, account, resource and custody locks. It checks Google connector/issuer, mailbox subject
binding and an actual Gmail read scope from that same grant. A Google mailbox's stored external
ID is the verified provider subject, never a Gmail `userId`; the existing adapter always calls
`users.me` using the exact resolved credential. OAuth refresh and Gmail calls share a 15-second
abort deadline with retries disabled. A request interceptor enforces that deadline after the
installed SDK merges its own refresh retry options, with no per-request timeout that can replace
an expired shared signal. Authority rechecks reuse the locked transaction rather than acquiring
a second pool connection. Errors contain no provider or credential details.

Mail bodies retain quoted, bounded pages and third-party taint. Personal console reads report
sender history as `I could not check`; they do not consult another account's sent mailbox.
This slice enables only read/search. Signatures, calendar, drafting/sending and shared/company
accounts have no personal-account execution path here. A successful consent alone does not
establish live provider health or complete connection acceptance.

### Keeper-managed personal client files

The root-owned keeper configuration `lifecycle.runtime.google` supplies `tokenKeyFile` and
`clients`, each client carrying `clientIdFile` and `clientSecretFile` host sources. Values stay
in files. The legacy `principal` field is optional for personal-only configuration and remains
required for the separate selected email-door path; it never identifies the actor of a personal
read. Agent definitions and tool inputs cannot supply these file sources. The
`configure-google-keeper.py` setup helper configures legacy email-door access only and refuses
an existing personal-only Google configuration; do not add a principal to satisfy that helper.

Only a chief-of-staff definition with an effective Gmail grant receives personal client mounts:
its scope must not be `none` and its autonomy must not be `never`. Explicit reconciliation uses
the desired definition. Rendering other agents or credential rollback uses their applied
definitions, so saving a pending capability change never silently changes another runtime's
mounts. Adding/removing Gmail creates a pending runtime change requiring explicit reconciliation.
An absent Google configuration leaves other capabilities running and personal reads unavailable.

The personal registry contains at most 32 exact lowercase alphanumeric org IDs, each at most
32 characters, matching canonical IDs stored by personal consent. Historical underscore/hyphen
keys remain available to the legacy selected email door; they are not renamed, discovered or
mounted as personal clients. An all-legacy client configuration emits no personal registry.
Over-capacity canonical configuration refuses rather than silently truncating.

Compose mounts each canonical client at deterministic `personal-google-<org>-id` and
`personal-google-<org>-secret` files under the container's secrets directory. It emits only a
bounded org-to-container-path registry in `LARES_PERSONAL_GOOGLE_CLIENTS`, plus the shared
`TOKEN_ENC_KEY_FILE` path. No host paths, raw secret values or account/member principal enter
that registry. A coexisting email door shares one `google-token-key` mount only when its
source is identical; conflicting sources refuse. Every client and key source is included in
reconciliation and credential preflight/rollback checks, including missing, empty and linked
file refusal before a runtime is stopped.

The personal reader selects the exact credential's org only from this registry, checks all
metadata paths against the fixed container naming contract and refuses missing/noncanonical
orgs. It has no email-door, environment-default, owner or other-client fallback. Native
`orgConfig` and selected email-door restrictions remain separate. Host configuration changes
still need explicit runtime reconciliation and restart; they do not reconnect a provider or
alter account ownership. Full provider and connection acceptance remain separate work.

The manual read-only probe is `services/chief-of-staff/tests/live/personal-gmail.live.mts`.
It requires a trusted server-captured current console context and exact selection in private
local JSON files. It invokes the actual tools and prints only counts/booleans, never mail or
identity contents. Run it explicitly after arranging a current private console turn and the
matching runtime client. Its existence and simulated-provider/database tests are not live
provider proof.

## Internal provider-neutral private reads

The chief-of-staff internal `readPersonalResource` entry point accepts an exact personal
selection and one operation: `mailWindow`, `readMail`, or `calendarWindow`. Window operations
accept ISO timestamps covering at most 31 days and a limit of 1–100. They return bounded items
and an explicit `truncated` flag; they never follow a provider's next-page URL. Gmail's native
raw query API remains separate. No Graph query, arbitrary URL, send, draft, event mutation,
background job, brief publication or new catalogue tool is exposed by this layer.

Both adapters execute inside the current original human's singleton private console turn,
using the selected account generation, resource kind and exact associated credential under
locks. Current authority is rechecked on the same transaction connection. Google uses only its
exact mounted personal client, calls Gmail `users.me`, rechecks each window candidate's
`internalDate`, and supplies the selected calendar ID to the Calendar SDK. Calendar windows
include overlapping events. A missing applicable Google read scope or client refuses.

Microsoft requires an explicitly supplied trusted server DATA configuration with a fixed work
tenant, client and encryption key. There is no environment, owner, email, console-login-client
or other-account fallback. This change does not mount that configuration in deployed runtimes;
without a future trusted runtime wrapper, Microsoft reads refuse. Google calendar client
mounting also remains separate from this internal API. Existing Gmail catalogue tools continue
to enable only their previously documented Gmail operations.

The Microsoft adapter pins discovery, token and signing-key endpoints, uses maintained
`openid-client` refresh, and requests the original stored scope set without `.default`.
An explicit refreshed scope response must match the stored normalized set, including all three
DATA read scopes. Access tokens stay opaque. A refresh ID token is optional; if present, its
signature is validated by the library and contradictory work identity is refused. The same
access token must then return the exact stored object ID and `Member` from Graph `/me` before
any resource read. Mail uses `/me/messages`; calendar uses only
`/me/calendars/<selected-id>/calendarView`, never `/users/<email>` or an inferred shared calendar.
Resource IDs are encoded as one path segment. The official Graph SDK uses only authentication
and HTTP middleware, with no telemetry, retries or redirect following. A trusted dispatcher
can carry its requests through the runtime's sealed egress proxy.

Discovery, refresh, signing-key checks, identity and resource requests share one 15-second
abort signal. Provider requests settle before account locks are released. New refresh tokens
are encrypted and written to the exact current custody association inside that transaction,
with comparisons against previous ciphertext and scopes; renewal does not advance account
generation. A later read failure rolls back that local update. Microsoft documents that
[issuing a new refresh token does not revoke the previous token](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens),
so rollback retains the prior token rather than silently committing a failed read's rotation.
Provider revocation can still invalidate either token; there is no automatic retry or recovery
by another account. Live behaviour remains to be checked during the first technical-user pilot.

Read messages have bounded body pages and truthful unknown sender history. The internal result
still contains private third-party text: future callers must quote it and apply third-party
turn taint before model exposure, and must not publish private results across audiences.
Missing optional provider fields become explicit unknowns; malformed required IDs/times/body
refuse. Calendar reads can include the selected owner's confidential events. This layer does
not establish permission to publish them.

`services/chief-of-staff/tests/live/personal-provider-reads.live.mts` is the committed manual
read-only probe for these response assumptions. It prints counts and booleans only and may
rotate local encrypted custody. It requires a current trusted private turn and exact selections;
Microsoft additionally requires existing provisioned DATA files. It has not been run as part
of this source change. Offline SDK/database tests are not live Microsoft acceptance.
