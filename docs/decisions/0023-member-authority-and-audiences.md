# ADR 0023 — Member authority and conversation audiences

**Date:** 2026-10-21
**Status:** Accepted (contract groundwork; runtime integration pending)
**Amends:** ADR-0015, ADR-0017 and ADR-0020 by specifying future authority boundaries

## Context

An agent's grants alone cannot decide what it may reveal in a conversation with several
people. The engine needs shared terms for the member an action serves, the human who actually
spoke, the audience receiving results, and the account and resource involved. These terms must
also survive scheduled work and approval pauses. Existing identity resolution and approval
ledger evidence remain separate; neither is replaced by a second authentication engine.

## Decision

1. `@lares/agent-kit/authority-contract` exports strict, transport-independent schemas and
   inferred types. Unknown fields are refused, including nested credential fields. These
   are secret-free metadata contracts: no credential references, custody paths, tokens or raw
   provider payloads belong in them. Labels and reasons must contain display-safe metadata;
   shape validation cannot detect secrets placed inside an otherwise valid string.
2. A member has a stable identity, organisation, existing `OrgRole`, and lifecycle status.
   Provider identity is issuer plus subject and tenant where relevant. Email equality never
   links identities. Console sign-in and connected-account consent are separate. New members
   and company accounts begin draft-and-ask. Only the authorised company account manager may
   expand company automation; personal automation may be expanded only by that member.
3. A turn records its acting member separately from its authentic human speaker. Jobs act
   for their owner and have no human speaker. Approval resumes retain the original actor;
   the resolver is separate. Resumed jobs retain their job and run identifiers and null
   speaker. A null actor is limited to unknown-speaker place-only access. It never grants
   organisation or private-source access. Trusted admission must verify these identities;
   parsing an object does not verify who supplied it.
4. An audience is known, nonempty, and contains verified members or externally scoped
   platform/workspace/subject identities. Unknown membership or unresolved stale authority
   refuses access. The pure reader comparison requires the whole audience to fit within
   current readers and, for published material, the readers captured at publication. Missing
   readers refuse. A widened audience or changed place starts a fresh session. Results,
   counts, histories and artifacts must all follow this boundary without revealing that an
   inaccessible source exists. Place outsiders see only that place's eligible conversation
   and area. Revision freshness is resolved by trusted consumers, never inferred from parsing.
5. Ownership is explicit and separate from grants, agent stewardship/editing, account
   management and credential custody. Organisation membership grants exclude restricted
   members. Owner or administrative status does not inherit private credentials or data.
   Agent reach intersects its grants, the acting member's authority and the audience; there
   are no implicit company-wide editors.
6. Accounts and resource bindings use stable identifiers. Company resources require explicit
   bindings; labels confer no authority. Account selection rechecks generation and grants
   before resolving credentials. Receipts contain only neutral identity, action, account,
   resource, provider receipt and approval or automation provenance metadata.
7. Exact-action approvals bind actor, agent, call, audience revision, account generation,
   optional resource/brand/template, action and payload hash, policy revision and expiry.
   Missing identities or changed payload, account, resource, template or authority refuse,
   as do expired or revoked approvals. Own-account approval requires its member; company
   approval requires current approve authority. Engine always-ask rules still win. Existing
   ledger evidence proves neither current authorization nor exactly-once execution.
8. Jobs bind owner, delivery audience, account generations, template/scope hashes and
   authority reference. Each execution needs a fresh session and current authority. Removed
   owners, changed scope/template, revoked grants/accounts, reconsent, import or pending
   adoption stop execution. Adoption explicitly renews authority. Imported jobs require
   disabled pending-adoption state; imported approvals and actions remain disabled too.
   Shared delivery is not company authentication.
9. Budget attribution identifies installation, member, agent, place, optional paired job/run
   and one selected gateway endpoint. Denied and unavailable are explicit outcomes. Missing
   attribution or unavailable enforcement cannot fall back to another route. Shapes do not
   prove enforcement at the gateway; a controlled live probe remains required.
10. Vault bindings name the area, kind, owner/resource, backing store, relative path and
    access revision. Writes additionally bind content revision, origin and turn authority;
    changed files refuse. Access-derived mounts preserve one logical taste home, with no
    private directory fallback from agent ownership and no second people's store. Frontmatter
    cannot change ownership or access. Existing origin vocabulary is reused.
11. Import v1 inventories every declared application category, including zero-count safety,
    sync, settings and suppression categories, with counts/checksums and stable identity and
    provenance mappings. Contacts, source links and retained domain records (including CRM,
    Tracks and calendar/mail cache records) have explicit inventory categories. Only conversation usability may fall back to a recoverable archive.
    Every other omission or unresolved mapping blocks an actual move. Reconciliation checks
    category completeness, counts and unique mappings; it cannot verify archive contents or
    checksums without storage integration. Ordinary exports contain no secrets; protected
    transfer/reconnect inventory is separate metadata. Reconnect remains outstanding until
    resolved. Import never infers company sharing.

## Consequences

Consumers can share reviewed wire shapes without copying authority rules. Pure audience and
inventory comparisons are useful building blocks, not permission decisions. The category
inventory is versioned; additional application categories require an explicit contract revision.

This change integrates no runtime path, changes no database and supplies no runnable
multi-user isolation guarantee. Admission adapters, current membership/grant/revision checks,
source filtering, approval execution, gateway enforcement, storage/import verification and
controlled two-member acceptance remain future work. No third-party response handling is
introduced and no provider-backed proof is claimed.

## Agent ownership and access storage

`@lares/agent-kit/grant-store` supplies the shared server-only `can` and `listVisible`
path. SQL014 records agent ownership in `agent_access`, separate from runtime control
and incarnation tokens, and named use/edit or organisation use in `resource_grants`.
Only the agent adapter exists. Unsupported resource kinds, permissions and place grants
refuse. A resource owner inherently controls only their own agent; another administrator
inherits no use, editing, credentials or private source authority. Editing and using are
separate, and only the resource owner changes the sharing configuration.

Existing agents remain unadopted until the designated active console owner explicitly
adopts one under their own stable member id, with the current definition fingerprint.
The owner's explicit `org_member_policy` row must exist. Its non-null capability list is
the ceiling for active capabilities of agents they own (`none` grants are inactive).
A missing owner policy refuses adoption/use; a null list is unrestricted and an empty
list allows no active capabilities. A caller's policy does not constrain use of an agent
owned by someone else. The definition and skill never-widen checks remain in force.

Current active membership, organisation, owner capability policy, valid definition,
permission and expiry are checked on every decision. Organisation use excludes restricted
members. Named grants can include active restricted members of the same organisation.
Views contain only authorised resource identity, revision and permissions; sharing
configuration is owner-only. Callers already holding a transaction can pass its database
client, avoiding a second pool connection, and must keep that transaction open through the
protected operation. Direct owner-policy row locks protect decisions from concurrent writes.

Access revisions are monotonic across deletion/re-adoption. Sharing changes replace the
selected grants, retaining revoked rows as immutable tombstones. They also revoke existing
console session bindings in the same transaction. Membership/role changes advance affected
organisation agent revisions and retire bindings while preserving unrelated active grants;
removal or organisation departure tombstones the departing member's direct grants. Changes
to a resource owner's capability policy advance only that owner's agent revisions and
preserve grant configuration. Definition fingerprint/status changes also advance the agent
revision; identical refreshes do not. Rejoining, restoring a role or regranting access cannot revive
a previously captured revision or a revoked binding. Expiry is checked against current
database time, not transaction-start time.

The existing owner-only agent detail page provides adoption and sharing controls. Sharing
records authority only: it does not enable member chat, member editing screens, account
inheritance or private-source access. Runtime admission remains designated-owner-only until
all automatic context and exposed tools have their own scoped consumers. SQL014's migration
and a real PostgreSQL boundary suite are source evidence; the branch runtime-image workflow
and later two-member runtime acceptance are separate evidence.

Strict private console admission now consumes this same `use` decision. SQL016 captures a
separate immutable `agent_access_revision` on every new session binding, leaving audience
and conversation-policy revisions unchanged. Existing unversioned bindings are retained as
revoked history. Current grant authority and binding reads/inserts use one transaction and
connection; caller-owned transactions retain the locks through protected local actions.
Every strict lookup and exact approval resume rechecks the capture. Access restoration,
re-adoption or a definition changing away and back cannot revive an old conversation.
The proxy checks admission before reading the runtime address or route password. Missing
adoption requires an explicit owner action; runtime incarnation tokens never adopt agents.
Console admission remains designated-owner-only pending scoped automatic context and tools.

Strict private console sessions now use a bounded source surface: the chief of staff offers
only granted personal Gmail account listing, message reads and search; the creative role offers
no source tools. Both use neutral role instructions and exclude installation voice, duties,
standing facts, connection inventory, outside tools and native-only skills. Session-local
framework questions and task lists remain available. Private turns do not enter owner learning,
legacy administrative conversation projections or shared usage counts; HTTP traces emit nothing.
Request envelopes accept the console's text and exact card answers, refusing attachments,
callbacks, observers, client context and delegated task modes before dispatch.

SQL017 retires earlier private console bindings and captures an immutable bounded-surface
revision on every fresh session. An old runtime cannot create an active binding by omitting it.
A prompt refresh cannot approve old broad history: the person must start a new conversation.
Current binding/access freshness is checked at dynamic surface resolution, model selection and
both provider execution modes; durable tool callbacks independently refuse unsafe source names.
Admission is still designated-owner-only. These source boundaries do not claim deployed gateway
privacy, member admission or complete two-member runtime acceptance.

## Bounded member private conversations

Active members with current agent `use` authority may start singleton private console
conversations. Administrative console pages remain designated-owner-only. The chat listing
contains only authorised ready agent identity; it includes no sharing configuration, owner
inbox, connections, tools, skills, avatar versions or conversation counts. Browser recovery
uses an opaque member id with its original case and a protocol-versioned storage key.

Strict HTTP authentication uses that stable member id as Eve's principal, so operation-id
retry deduplication is also per member. The raw text-only envelope is validated before Eve
parses it. A request-specific immutable message receipt then checks the same parsed text in
`onMessage`, after Eve consumes the request body. No raw body or credential is retained in
that receipt. Native channel authentication remains separate.

SQL018 advances the private surface capture to revision 2 and retires pre-invalidation
history. Personal account status/generation changes retire every private session belonging
to that account's member. Explicit healthy reconnect advances generation; ordinary encrypted
refresh-token rotation does not. New account insertion does not retire unrelated context.
Restored account access requires a fresh conversation and fresh resource selection. The
previous history cannot be copied into the new session as a recovery mechanism.

The bounded surface exposes only the role's authorised personal mailbox reads plus local
session controls. Questions can be answered in plain text. Structured question-card
continuation is not exposed by the current browser UI; resolver identities are not promoted
into human model authority to support it. The private proxy excludes Eve's administrative
`info` endpoint, whose compiled metadata is broader than this surface.

The offline `packages/board-evals/scripts/member-private-chat-proof.mjs` builds actual role
sources with a synthetic model/provider, uses real migrated PostgreSQL and the real console
proxy, and checks member/capability/history boundaries. It is runtime source proof, not live
provider acceptance or deployment evidence.
