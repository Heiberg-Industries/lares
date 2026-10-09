# Roadmap and integration inventory

**Date:** 8 October 2026. **Status:** planning document, published 9 October 2026, not an approved delivery schedule. The private security review it draws on is not in this repository. Planning inventory and proposed sequencing. Existing code means found in this checkout (local `main` at `d8d1177`; remote `main` independently checked through `c38ae50d`), not verified on an installation.

Lares is an open-source, self-hosted engine with a chief of staff as its default experience.
Private is the default; organisation sharing is an explicit choice once the boundaries work.
Other agents and personal templates remain possible without becoming required onboarding work.
The roadmap should reduce maintenance and unnecessary model calls while preserving useful extension points.

## Personal and business use: one engine

Present personal and business use separately on the website, with concrete examples and a common
setup path. These are use cases, not separate products, engines or permission systems. Onboarding
asks what the user wants help with and recommends editable templates and connections. Chief of
staff remains the suggested starting point, not a mandatory role. Travel, taste and coaching are
valid personal uses; users can choose one agent or several. Paid setup services configure the same
engine for each client's needs. Do not create a separate coach application or fork by default.

Use case and audience are independent: personal/business/mixed describes the work; private/shared
describes who can access it. Business context can be private. Choosing a business template must
never imply sharing email, direct messages or personal preferences.

Taste combines explicit preferences with source material such as saved Google Maps lists, Spotify
playlists and Apple Music collections to suggest places or music a user *might* enjoy. Keep saved,
visited, listened-to and explicitly liked distinct from inferred preferences. Preserve source and
date, let the user correct or remove preferences, and treat suggestions as hypotheses. The existing
`packages/taste` format includes places, tracks, playlists, dishes and notes. Google saved-list
import exists; Spotify and Apple Music connections remain planned, with separate capability checks.
Taste is private by default and reusable by any authorised agent, not owned by one travel persona.

## Coverage and limits

This inventory combines the current engine declarations and implementation paths, local ADRs,
specs and research, the full project issue listing, historical design material, and the product decisions of 8 October. Issue titles and
summaries were inventoried. The follow-up sweep fetched full descriptions and all returned comment
pages for the non-closed issues, refreshed recent closures, and checked related historical
tracker items and private historical planning material. It is not a
claim that every issue comment, historical plan, external document or unrecorded idea has been
exhaustively reconciled. Private operational details and tracker references are deliberately
excluded from this public document.

Use this as the starting point for a complete roadmap, with each item assigned a decision,
dependency, acceptance test and public source. Keep implemented, deployed, verified, proposed
and deferred distinct. A closed ticket alone is not deployment evidence. Historic specifications
describe their date and can disagree with current code.

## Integrations present in the engine

| Integration or source | Existing scope | Evidence and limit |
| --- | --- | --- |
| Gmail | Search/read, drafts, recipient handling, signatures and gated sending; triage/follow-up workflows | `services/chief-of-staff/catalogue/gmail_*.ts`, `lib/google.ts`. Per-member connection ownership remains part of multi-user work. |
| Google Calendar | List calendars/events, availability and conflicts, create/update/delete events | `services/chief-of-staff/catalogue/calendar_*.ts`; travel has calendar reads. Effective scopes depend on consent and grants. |
| Google Drive, Docs, Sheets and Slides | Read supplied links through Drive export/download | `services/chief-of-staff/lib/google-drive.ts`, `google-doc.ts`. Sheets export is the first sheet; this is not a general editing suite or continuous Drive knowledge sync. |
| Slack | Conversation channel, approval interactions, selected source reads and relationship import | `services/*/agent/channels/slack.ts`, chief-of-staff `lib/slack-source.ts`, network importers. Channel access and source access are separate grants. |
| Telegram | Conversation channel, messages and approval interactions | Chief-of-staff/travel channel implementations. Audio handling is separate planned work. |
| Notion | Document and meeting-transcript synchronisation, proposals and follow-up inputs | `services/notion-sync`, chief-of-staff Notion helpers and `services/atlas/lib/adapters/notion-source.ts`. A neutral transcript contract is still planned. |
| Twenty CRM | People/company lookup, notes, opportunities/stages and communication state | Chief-of-staff `catalogue/twenty_*.ts`, network sync. Current API-key wiring is distinct from planned per-user OAuth. |
| Orakel | Business search and organisation/domain enrichment | `packages/agent-kit/src/orakel-client.ts` and catalogue tools; requires the installation's own account/access. |
| GitHub repository sources | Read repository content as business-knowledge input | `services/atlas/lib/adapters/github-source.ts`. Not a general issue/PR/code-writing agent integration. |
| Karakeep | Bookmark input to digest work; optional Notion clipping is planned as a replacement | Connection registry and chief-of-staff digest code. Keep working until an optional Notion replacement, where adopted, is verified. |
| Web pages | URL reading through the readability service | `packages/agent-kit/src/readability-client.ts`, `read_url` tools. URL reading is not a general web-search integration. |
| Mac Contacts, iMessage and call history | Local import into the relationship graph | `services/network/lib/importers/`. Generic importers exist; Mac scheduling, permissions and transfer onboarding need packaging. Message history import is not an iMessage sending channel. |
| LinkedIn, Facebook and Instagram exports | File-based relationship/history imports | Network `linkedin.ts`, `meta.ts`. Not live account APIs or publishing. Replica content policy lives in `services/network/lib/replica.ts`. |
| Google Maps saved-list exports | Manual Google Takeout CSV import into the taste store | `packages/taste/src/takeout.ts`, console taste import. Saved places, not location history or proof that a user visited or liked a place. |
| Entur and Google Directions | Transit planning and directions | `packages/agent-kit/src/entur-client.ts`, travel `lib/transit.ts`. |
| Google Places | Nearby places and place links | Travel places helpers and catalogue. Optional API key. |
| MET Norway and Open-Meteo | Weather, sunrise/ocean and marine data paths | `services/travel/lib/weather.ts`. Geographic coverage and source freshness need source-specific checks. |
| Avinor and AeroDataBox | Flight status | Travel `lib/flights-io.ts`; optional commercial fallback credential. |
| Strava | Route/segment discovery | Travel `lib/strava.ts`. Does not establish training-plan upload capability. |
| Frankfurter | Currency conversion | Travel `lib/currency.ts`. |
| Polymarket and Kalshi | Market data and read-side analysis | `packages/agent-kit/src/markets/`. Not trade execution. |
| LiteLLM | Model requests, purpose aliases and budget-error handling | Shared gateway provider/helpers. Console management and broader recommendations remain roadmap work. |
| Local signals and optional tracing | Read operational signals; export traces to the configured collector | Signal helpers and Langfuse/OpenTelemetry integration. These are operational services, not business-data connectors or central Lares telemetry. |

Console web chat is another interaction surface. Vault, memory, reminders, deadlines, obligations,
trips, shopping lists, taste and writing profiles are internal capabilities, not external vendors.

### Why this is not yet a uniform integration catalogue

Only Google, Notion and Slack currently have production integration-manifest folders under
`integrations/`; `_fixtures/microsoft-365.json` is explicitly a fixture, not an integration.
The broader connections registry includes more vendors and is already generated, together with
the integration secret-mount list, by `packages/agent-kit/bin/generate-connections.ts`. The keeper
imports `@lares/agent-kit/integration-secrets`; platform-owned secrets are a separate concern.
An earlier review's description of two entirely independent hand-written lists is outdated.
Remaining work is coverage, naming, ownership, capability/use mapping and end-to-end consistency,
not inventing the generator again. The quality files carry `tier: none`
and unfinished evidence, credential-test and shared-client items. Listing an SDK in a manifest
does not prove that the adapter uses it: Notion/Slack still have direct HTTP paths, and the
shared request and credential helpers do not mean every vendor has been migrated to them.

Treat completing the manifest coverage, connection ownership and working setup/repair experience
as foundation work. Do not make a new catalogue by copying another list that will drift.

## Planned integrations and extensions

| Planned item | State and next decision |
| --- | --- |
| External MCP connections | Core extension priority, not complete. Register a connection, explicitly allow tools, classify effects, scope credentials and egress, and enforce existing approvals. Homebridge is the first planned acceptance case. |
| Homebridge | Private, external connector for read/control. Prove the extension mechanism with a read first, then an approved reversible action. |
| Microsoft 365 | Outlook mail/calendar, OneDrive and Teams are a planned parity direction, not implemented by the fixture. Extract mailbox/calendar contracts and scope the first adapter; no launch parity claim. |
| Google Drive as knowledge source | Continuously tracked Drive sources for the business vault, distinct from reading a supplied URL. Decide file/folder scope, formats, ownership and freshness. |
| Transcript sources | Neutral list/attendee/read contract with Notion first; Zoom, Meet, Teams and note-takers are future adapter candidates, not committed connectors. |
| Fiken accounting | **Paused; no current delivery priority.** Retain design for later prioritisation: receipts, draft invoices, open items and purchase/payment records. No moving money or invoice sending in the initial contract. Receipt OCR scope needs a decision. See the accounting design. |
| Other accounting vendors | **Deferred with accounting.** Tripletex, PowerOffice and Conta are later adapter candidates against the extracted contract. Do not build speculative adapters before demand. |
| Twenty per-user OAuth | Replace shared credential assumptions while retaining named, gated CRM tools. |
| Spotify | OAuth plus accumulated playlist/listening history in the private taste store. Needs member ownership and observable sync. Apple Music is retained as a separate planned taste-source candidate, not implied by Spotify support. |
| Coaching connections | Garmin/TrainerRoad calendar feeds, intervals.icu activity/wellness and Oura recovery data appear in historical coaching plans. Workout creation and bulk transfer to Garmin are a further research item. Keep private-template work separate from default-product delivery; historical probe results are not current Lares implementation. |
| Publishing | Draft, approve, publish to blog/social destinations. Ghost and LinkedIn are candidates; historical mentions of an inbound Ghost mirror do not establish an engine connector in this checkout. |
| Business numbers | Read financial, pipeline and model-spend state through source adapters; avoid creating a second source of truth. |
| Voice | Voice-note transcription/replies and a possible agent-as-MCP interface are research/planning work. They are distinct from the Mac call-history importer. |
| Additional conversation channels | Evaluate reusable channel adapters when requested. WhatsApp, Teams or Discord availability upstream is not a promise that Lares implements them. |
| Model candidates | OpenAI, Anthropic, Mistral and Aleph Alpha/Kolibri; connection and task evaluation precede recommendations. Jev remains a set of optional experiments. |

## Integration categories and connection choices

Classify each integration in the same manifest, with independent fields rather than separate
personal and business subsystems:

| Dimension | Examples and purpose |
| --- | --- |
| User-facing domain | Communication, calendar, knowledge, relationships/CRM, projects/design, taste/travel, health/coaching, home, accounting, model services. Supports console browsing. |
| Capability role | Conversation channel, live read/action tool, background source sync, file import, model service. One vendor can serve several roles. |
| Connection method | Official SDK/API, approved remote or self-hosted MCP, file import, local helper. Choose per capability, not solely per vendor. |
| Ownership and access | Connection/account owner, private/shared scope, agent grants and action approvals. Separate from the selected use case. |
| Operational evidence | Maintainer, version, data path, supported actions, live probe, health, last successful sync and setup/repair steps. |

MCP is a connection method; an integration is the useful capability supplied through it. Calling
a known MCP tool does not inherently need another model call. Background sync and deterministic
work can use it too, provided the server supports the required lifecycle and volume.

**Proposed ADR-0019 revision, not yet adopted:** evaluate an official, maintained MCP server before
writing a new vendor adapter. Preserve named business operations and the common permission/action
boundary regardless of transport. Use SDK/API paths where MCP lacks required operations, reliable
pagination/sync, precise account scopes, predictable errors or write retry safety. Compare setup,
maintenance, latency, complete-task cost and data handling; protocol choice alone proves none of
these. Existing working adapters need measured benefit and parity before replacement.

Evidence checked 8 October 2026:

- Linear provides an official remote MCP server for issue/project
  operations, with read-only access available. It is a strong new-connection candidate.
- [Figma](https://developers.figma.com/docs/figma-mcp-server/) provides official MCP access;
  verify client availability, permissions and the exact required tools in a bounded pilot.
- [Google Workspace](https://developers.google.com/workspace/guides/configure-mcp-servers)
  documents service-specific MCP servers in Developer Preview. Preview enrolment and actual tool
  coverage need checking; this is not proof of parity with Lares's Gmail sending or calendar writes.
- [Twenty's own documentation](https://github.com/twentyhq/twenty/blob/main/packages/twenty-docs/user-guide/ai/capabilities/mcp.mdx)
  describes native MCP access to CRM data. Check the target deployment/version and named CRM
  operations before choosing it over the existing adapter. An existing owner decision specifically
  retains curated Twenty tools while moving credentials to per-user OAuth. Keep that decision;
  the general MCP proposal is not approval to replace those tools. Other CRMs need their own assessment.

The accepted ADR currently prefers official SDKs for core concepts and reserves external MCP for
extensions. Reconcile that decision before implementing this proposal; do not build both paths
speculatively. MCP does not grant consent to a new hosting provider or remove infrastructure policy.

## Foundation for adding tools without rebuilding the engine

[ADR-0019](../decisions/0019-integrations.md) remains the authority: official SDKs and small typed
adapters for core concepts; external MCP for installation-specific tools; no arbitrary plugin
code loaded into the engine. A tool is one action; an integration supplies connections/actions;
a skill combines already-granted actions; an agent selects a role and grants. Adding a tool
does not require inventing another agent.

Recommended completion order:

1. **One integration description:** vendor, concepts, credential kind, owners, hosts, data path,
   capabilities, quality evidence and maintainer. Generate console rows and network declarations.
2. **Connection lifecycle:** connect, explicitly test, refresh, revoke, reconnect and report failures.
   Separate vendor connection, connected account, member ownership and agent grants.
3. **One execution boundary for tools:** validate arguments, resolve the acting member, check grants,
   decide approval in code, execute with bounded time/retry, record result/error and show receipts.
   A retry must not duplicate a write. Unknown MCP effects default to asking; server-provided
   annotations do not establish trust. Changed schemas/tools require review rather than new access.
4. **Vendor-neutral concepts as needed:** mailbox/calendar first for the second vendor, accounting
   only when accounting is resumed, transcripts from the existing meeting workflow. Preserve vendor-specific
   features through explicit capabilities rather than forcing a lowest-common-denominator API.
5. **Governed discovery:** list/describe/call or tool search may reduce prompt size, but must expose
   only authorised tools and run every call through the same boundary. Start with explicit grants
   and deterministic selection; a model-based selector has to justify its cost.
6. **Reusable background sync:** checkpoints, deduplication, incremental updates, last-success and
   visible failure states. Fetching unchanged data and scheduling work need no model. Reuse the
   existing jobs/runtime rather than introducing another workflow system by default.
7. **Contributor path:** one worked adapter, one external MCP example, a scaffold and targeted
   checks. A new supported connector gets its console surface when built, not in a later redesign.

Foundation acceptance: a contributor adds one external connector without editing engine code;
a second member cannot read/use the first member's credentials; new tools do not inherit grants;
an approval survives restart and authorises exactly the displayed action; revoked access stops
the next action; connection failures are distinguishable from empty results. Verify the live API
contract as well as offline tests. Existing provider-owned data sources and new infrastructure
choices must be described separately; reusing a library does not authorise a hosted service.

## Memory foundation

**Yes, the file format remains OKF-based.** [ADR-0017](../decisions/0017-the-vault.md) pins
OKF v0.2 compatibility to `ad30107c` of
[GoogleCloudPlatform/open-knowledge-format](https://github.com/GoogleCloudPlatform/open-knowledge-format).
Upstream describes a vendor-neutral Markdown/YAML format, independent of an agent framework or
serving system. Using it does not require Google Cloud, Gemini or Google's reference agent.

Lares owns the memory behaviour around that format:

| Layer | Current mechanism and boundary |
| --- | --- |
| Readable knowledge | Git-backed Markdown notes with metadata. `packages/vault-format/src/okf.ts` checks types and Lares extension names/origin; `packages/agent-kit/src/okf.ts` re-exports it. This is a shallow conformance check, not proof that a statement is true or that every optional provenance field is semantically validated. |
| Structured facts and operations | Database records for standing facts, relationships and operational state. The design assigns one authoritative writable home per fact class; it does not store everything in both Markdown and Postgres. The network import pipeline also uses a local SQLite database. |
| Retrieval | `packages/agent-kit/src/notes-store.ts` performs token-based file search, scope filtering, reads, lists and backlinks. It is not a deployed Jev/vector search layer. Existing writing-example embeddings serve a different purpose. |
| Conversation context | A bounded standing-facts block is assembled for a session; current chief-of-staff code also handles changes with a turn addendum. It does not load the entire archive into each prompt. |
| Learning | Origin tracking and the shared learning gate distinguish owner statements from external text and agent inference. Current dream promotion uses that gate and proposals. ADR-0018 describes the intended review/retirement rules; verify all writers against them rather than assuming an ADR proves completion. |
| Inspection and removal | Memory read/export helpers, use tracking and forget-ledger code exist. A dedicated console Memory page was not found in this checkout. End-to-end per-person erasure, re-import behaviour and multi-user attribution still need acceptance evidence. |

Keep this foundation unless measurements reveal a concrete problem. Jev, conventional embeddings
or precomputed attributes should be optional, rebuildable retrieval indexes over eligible sources,
not replacement authorities. Permissions and currentness cannot be delegated to similarity scores.
Before shared use, reconcile the format's `lares_scope` field with actual reader/writer handling
of scope and ownership, and test every sync/import path. Before adding another memory platform,
measure missed retrievals, stale facts, wrong-person matches, missing context and correction effort.

### Knowledge editor choice

Notion is an optional administration/sync surface, not the knowledge authority or an onboarding
requirement. ADR-0017 already allows Markdown-based editing, including Obsidian. Users should be
able to maintain eligible knowledge with their preferred editor, including Claude or Codex against
files they are authorised to access. This does not assert full administration parity today.

Keep OKF metadata, source origin and visibility intact across editors. Specify validation and
conflict feedback, deletion/forgetting behaviour and a way to see sync status; an external editor
must not silently erase Lares metadata or reintroduce forgotten content. Structured database facts
need controlled read/write/export tools and console controls rather than requiring raw database
editing. Test a file-editor round trip and an optional Notion round trip against the same knowledge.

## Console completeness requirement

Every supported user/admin option must be discoverable in the console and configurable by the
appropriate role: agents/templates, providers/models/gateway, tools/MCP, connections/accounts,
permissions, channels, schedules, budgets, knowledge/sync/editors, taste sources and operations.
Use clear groups and Advanced sections; onboarding recommendations must not hide the full catalogue.
Unavailable options explain why and how to enable them. Visibility never grants access to another
member's private accounts or settings; credentials remain masked.

### Credentials and gateway setup — confirmed 8 October

External accounts belong to the installation owner or member: they supply their own provider/API
keys, or authorise access through OAuth sign-in where supported. An administrator supplies any
required provider app/client credentials; ordinary members should not need to copy OAuth tokens.
Lares generates internal security material (such as service, session and webhook secrets) where
appropriate. No shared vendor credentials ship with the engine.

The console must cover required external credentials and their lifecycle: add/connect, show masked
configuration status, test, replace/rotate, reconnect and remove/revoke where supported. Distinguish
removing a local credential from revoking it at the provider. Explain account ownership and which
agents may use it. Never include secret values in model context, logs, previews or exports.

Include gateway administration in the same requirement: provider endpoint and credentials,
available models, purpose mappings, permitted fallback, spending limits and connection health.
Reuse the existing gateway and secret storage boundaries. Internal secrets need managed status and
recovery/rotation actions where applicable, not ordinary editable plaintext fields. Host bootstrap
steps that precede a running console need explicit instructions and later console visibility.
These are acceptance requirements, not a claim that every lifecycle control is already implemented.

Maintain a settings-to-screen checklist as an acceptance requirement. A feature is not complete
while its normal configuration requires editing environment variables or JSON. Where a host-level
installation step genuinely cannot run in the console, show its status and precise instructions.
Distinguish shipped options from future roadmap entries, rather than presenting nonfunctional toggles.
Opening setup, inspecting settings and ordinary configuration must not require a model call.

## Vercel reuse assessment

Upstream sources checked 8 October 2026. These are reuse candidates, not a package-upgrade instruction.

| Project | Lares position and proposed use |
| --- | --- |
| [eve](https://github.com/vercel/eve) | Already the runtime. Prefer its existing tools, connections, skills and durable sessions; evaluate new APIs through the existing upgrade track and upstream small general fixes. Avoid another agent runtime. |
| [AI SDK](https://github.com/vercel/ai) and [MCP client](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools) | Already used for models. Reuse provider interfaces, structured output and MCP transport where compatible. Prefer eve's connection layer when it already owns the lifecycle; avoid two parallel MCP clients for the same connection. Lares still owns permission, egress and credential policy. |
| [Chat SDK](https://github.com/vercel/chat) | Strong candidate for reducing duplicated channel adapters: messages, attachments, streaming and interactive cards. Test one channel behind the existing session/approval boundary before replacing anything. A Teams chat adapter does not provide Outlook or OneDrive access. |
| [Workflow SDK](https://github.com/vercel/workflow) | Already present through the runtime and explicit Postgres-world dependencies. Upstream documents self-hosting with Postgres. Reuse this path for durable work; do not introduce a competing scheduler without measured need. |
| [just-bash](https://github.com/vercel-labs/just-bash/tree/main/packages/just-bash) | Already a role-service dependency. Could support scoped file processing or a later workspace experiment. Its virtual shell is not a VM isolation boundary; keep filesystem scope, network restrictions and process/resource containment. Installing it does not justify exposing a general shell to every agent. |
| [AI Elements](https://github.com/vercel/ai-elements) | Already accepted and piloted: `tools/design-preview` uses official Conversation, ConversationContent and ConversationScrollButton source. Extend selective reuse for message rendering, input, tool status and attachments through the existing shared theme. Audit each component's production-console port status; the preview does not establish shipped console coverage. Keep Eve as the conversation owner. See `docs/design/console-ui-stack.md`. |

Hosted Vercel Connect, AI Gateway, storage and Sandbox are separate products, not an automatic
consequence of using these libraries. Retain self-hosted infrastructure, installation-controlled
credentials and the existing model gateway. For each reuse candidate, check the pinned version,
licence, dependencies, self-hosted path, data flows and how much maintained Lares code it removes.

## Feature inventory for roadmap decisions

These themes retain future ideas without turning them all into launch requirements. Proposed
lanes are Foundation, First useful assistant, Expansion, Experiment and Optional template.

| Theme | Work retained in the inventory | Proposed lane and dependencies |
| --- | --- | --- |
| Install and release | Docs-only install ending in a delivered brief; first public release/update notice; migration/restart/recovery; public images and fork-friendly builds | Foundation; observed end-to-end acceptance |
| Runtime maintenance | eve upgrade, patch reduction/upstreaming, dependency/security maintenance, restart/resume reliability, measured memory footprint and capacity limits | Foundation; preserve approval and tool behaviour |
| Integration foundation | Manifest coverage, shared clients/credentials, neutral concepts, MCP, contributor scaffold, repairs and connection states | Foundation; sequence above |
| Ownership and privacy | Members/roles, private/shared/participants scope, account ownership, per-member imports, approvals and budgets; retention, export and erasure | Foundation before shared use |
| Security and recovery | Injection tests, sealed network access, no implicit external reporting, backup/restore rehearsal, trustworthy health and failure signals | Foundation |
| Agent setup | Templates, identity, providers/settings, permissions, channels, save/start and developer preview | First useful assistant; existing builder amendment |
| Clipping | Optional Notion capture and digest input that can replace a bookmark service; console connection/destination setup; verify transition | **High priority — confirmed**; reusable engine capability, no installation-specific fork |
| Daily usefulness | Briefs/digests, schedules/quiet hours, language/timezone, deadlines/renewals, obligations, meeting follow-ups and calendar conflict resolution | First useful assistant; source freshness and delivery evidence |
| Email and writing | Show and revise drafts, owner instructions, relationship context, examples, draft/final capture, reviewed learning and later long-form writing | First useful assistant; baseline before learning expansion |
| Approvals | See exact proposed content, revise/cancel while waiting, acknowledge queued messages, reliable delivery when an agent is down | First useful assistant; durable execution |
| Chat and attachments | Persistent transcripts, documents/images/links across channels, clear unsupported formats, mobile console and agent-page refinement | First useful assistant |
| Models and spending | Gateway console, caps, activity/cost view, provider health, tested recommendations and explicit fallback | First useful assistant; truthful scope of limits |
| Cost reduction | Deterministic gates, skip unchanged inputs, cache measurement, prompt stability, bounded tool output and incremental context | Foundation and measured optimisation |
| Knowledge and learning | Vault recall, currentness, source origin, reviewable learning batches, forgetting, skills/procedure proposals and portable knowledge | Core improvement; preserve one authoritative home per fact |
| Retrieval/routing experiments | Jev direct retrieval, reusable attributes, embeddings comparison, compaction, tool selection and routing | Experiment; separate decision per measured result |
| Business expansion | Microsoft 365, Drive sync, transcript adapters, CRM OAuth, business numbers and publishing | Expansion after foundation; choose by demand |
| Accounting | Fiken contract, receipts, invoices, OCR scope and later vendor adapters | Paused; retained for later priority decision, not a foundation prerequisite |
| Personal expansion | Mac-helper onboarding, taste profiles, Google saved lists, Spotify, Apple Music and personal travel improvements | Expansion; private member scope |
| Coaching | Training/calendar sync, athlete/recovery sources, evidence-backed knowledge, check-ins and workout planning/export | Optional template first; re-scope historical coach-service plans |
| Agent specialisation | Travel/creative/support templates, bounded subagents and inter-agent handoffs | Optional/Expansion; no requirement for the single-agent default |
| Support and contribution | Agent-readable docs, user-approved bug/feature intake, community support, example adapters, contributor terms and public documentation | Foundation then Expansion; nothing phones home |
| Website and setup services | Accurate positioning/docs, legal and contribution material, booking/help, operations across separately owned installations | Parallel product/operations work; same open-source engine |
| Assisted onboarding and advanced workspaces | Optional conversational setup, generated definitions, sandbox/code tools and learned procedures | Experiment/Expansion; plain setup works without these |

### Marketing and documentation release requirement — confirmed 8 October

The marketing website and user/developer documentation are required delivery work as the roadmap
ships. Include them in the security review and each affected release checklist; do not leave them as an
unscheduled final clean-up. Update positioning, personal/business examples, open-source and paid
setup explanations, actual integration availability, console screenshots, onboarding, credentials,
gateway/model setup, clipping and update/recovery instructions to match verified shipped behaviour.
Clearly distinguish available features from planned ones, including any one-click update claim.

Acceptance: walk through the published setup and update instructions against the release being
shipped, check links/screenshots and remove outdated claims. Prepare relevant documentation with
the feature and coordinate website publication with release availability. This records future work;
it does not authorise publishing or claim the current website has been updated.

### Decisions to reconcile before scheduling

- The accepted SDK-first core integration rule versus the proposed capability-based MCP evaluation.
- The older conversational-onboarding-first plan versus the new form-first, no-required-model setup.
- The older coach launch-role/separate-service plan versus private definitions and optional templates.
- Alias-only UI and no model recommendations versus visible providers/models and evidence-backed recommendations.
- Mandatory triage in front of every message versus deterministic gates and measured optional routing.
- Old issue paths, claims of missing components and review statuses versus current code and acceptance evidence.
- Microsoft parity, publishing destinations and additional channels are directions, not a promise to ship every vendor.

For a claim of complete roadmap coverage, finish a source-to-item ledger: every open issue and
unresolved review finding maps to a row; every historical idea is retained, superseded, rejected
or explicitly unknown; linked external/private documents and relevant issue comments are checked.
Then approve priorities and sequence. Do not silently drop an idea because it is deferred.

## Coverage sweep and latest delivery evidence — 8 October

No pull, deployment, provider test or tracker mutation was performed. A concurrent status-only
pull request may move the documentation again; implementation evidence below is pinned to the
individual merged pull requests rather than a claim that the working tree contains them.

Items whose code is on main but which still await live acceptance are not features still to
implement. This review does not independently reproduce those live checks.

| Delivery item | Evidence and remaining boundary |
| --- | --- |
| Database checks report unreachable databases instead of healthy-looking output | [PR 84](https://github.com/Heiberg-Industries/lares/pull/84) merged 8 October. The deliberately wrong-database check remains for the next deployment. |
| Configuration errors identify invalid fields without echoing secrets | [PR 85](https://github.com/Heiberg-Industries/lares/pull/85) merged 8 October. |
| Calendar clash detection uses the owner's day clock in briefs | [PR 86](https://github.com/Heiberg-Industries/lares/pull/86) merged 8 October. Conversational-tool clock parity and visible invalid-timezone reporting remain separate possible follow-ups. |
| Stable deny-all proxy before first-agent creation | Existing [PR 13](https://github.com/Heiberg-Industries/lares/pull/13), merged. An unobserved pre-agent container-state check remains; retain it in fresh-install acceptance. |
| Dependency sweep and flaky-test fixes | Batches 1–13 completed; eve 0.71 remains a separate track. Existing release candidate images predate later fixes and are not current-main delivery evidence. |
| Injection suite | Branch plan read: corpus/block delimiting and flags, raw-text prompt restructuring, then a separately budgeted live test. Planned, not implemented. Approval status remains with that workstream. |
| Jev pilot | Historical preparation exists outside this repository. Public `lares/pull/15` is a keeper-socket fix, not the Jev pilot. Reconcile and port the prepared experiment before execution; do not merge historical private Git history into the public repository, and do not infer a live benchmark from offline preparation. |

### Features and follow-ups previously missing or too broadly grouped

These are retained for prioritisation, not newly approved implementation. Historical findings
with old runtime paths need current-code verification before they become build tickets.

| Item | Disposition and roadmap home |
| --- | --- |
| Article, podcast and newsletter discovery/extraction | Explicit content-intake work, separate from publishing and simple URL reading. Evaluate open-source capture/extraction tools against real inputs. |
| Browser/mobile clipping: bookmark service → Notion | **High priority, confirmed 8 October.** Implement Notion clipping as a reusable Lares capability, as an optional replacement for a bookmark service such as Karakeep. Include browser/mobile capture, source links and captured content, incremental ingestion, duplicate handling and use in briefs/digests. Select the destination and connect the account in the console. Decide existing-bookmark import scope before implementation; verify the replacement before the old path is retired. Notion stays optional. |
| Task-system deadlines in briefs | Read unfinished/overdue tasks from the chosen task source, initially the historical Notion candidate. Distinct from legal deadlines and inferred email obligations; no second task database by default. |
| Travel mail labelled after receipt | Historical ingestion correctness/quota issue: detect newly applied labels, not merely newly received mail; dedupe and compare request volume. Re-verify against the current travel pipeline. |
| Persistent contact identity corrections | Remember explicitly confirmed aliases/merges, preferably in the authoritative contact source. Reversible correction and conflict handling; do not infer identity from similarity alone. |
| Enrichment for unfamiliar contacts | User-requested, permitted source lookup; distinguish live profiles from already-supported export imports. Candidate research, not scraping access or a new connector claim. |
| Proactive delivery destinations | Per-message/job channel selection is not covered by schedule-time settings. Capture separately, including installations without Slack and alert delivery alternatives. |
| Calendar resolution beyond overlapping stays | Decline invitations, recognise superseding bookings, and account for travel time. Three distinct deferred cases, not implied by the existing overlap-resolution code. |
| Calendar consistency and skipped checks | Follow up conversational-tool versus brief day clocks; decide whether invalid-timezone skips should be visible. Retain even though the brief day-clock fix has merged. |
| Freshness for opt-in schedules | Distinguish deliberately off from broken; decide opt-in grace, older definitions, and per-agent rather than shared per-role heartbeat ownership. |
| Behavioural role evaluations with alerts | Golden task cases across models, release regression evidence, failed/missing-run alerts and bounded judge spend. Separate from structural permission tests and model recommendation rankings. |
| Honest spending-cap messages | Match the actual reset period; old daily wording can mislead for monthly caps. Do not revive a previously dropped installation-wide-cap scope without a new decision. |
| Unified attention/repairs and activity | Pending actions across agents, connection repair, current action receipts and model cost. Replace stale audit-source assumptions; each failure should lead to a useful repair path. |
| Autonomy recommendations | Approval history may propose a permission change for review; never promote authority automatically or override always-ask actions. Research-derived option, not a launch prerequisite. |
| Scoped file-search baseline | Compare authorised list/glob/grep/read-style retrieval with existing vault search in the memory evaluations; do not expose unrestricted shell/filesystem access or bypass provenance and privacy filters. |
| One general runtime image | Explicit completion of the agents-as-definitions direction: consolidate duplicate channels, schedules, clients and catalogues only with measured parity. A distinct maintenance item, not another agent feature. |
| Agent voice onboarding and theme controls | Optional voice interview, font/colour/theme customisation and template illustrations. Keep the agent's speaking voice separate from the user's email-writing voice. Not a reason for compulsory generation calls. |
| Coding assistance | Preserve the original question: connect a specialist coding harness or delegate bounded work when useful. No commitment to build another coding runtime. |
| Later coaching scope | Training-calendar reconciliation; morning/recovery check and weekly planning; nutrition for training; reviewed evidence library and watched sources; planned-versus-performed analysis, deterministic load/interference metrics, personal-response learning and workout export. Optional personal work on the same engine. |
| Later personal data sources | Apple Health export bridge, illness/injury records and avalanche context were in the coach plan. Retained candidates, not current connectors; health access stays separately granted. |
| Oura onboarding lifecycle | Per-installation OAuth setup and correct callback/privacy/terms pages; a managed shared app/relay is a separate future service decision requiring provider re-verification. No private registration data belongs in engine defaults. |
| Alternative CRM adapters | HubSpot/Pipedrive remain demand-driven candidates behind the integration boundary, not just Twenty OAuth work. |
| CRM source-schema transition | Handle a CRM field-name mismatch with the supplying CRM application; preserve the engine-facing value and verify the live contract. Integration maintenance, not a general schema migration for every user. |
| Platform and distribution options | Full Mac-hosted engine installation is distinct from the Mac helper and remains deferred. Cross-platform secrets, signed releases/image verification and registry cleanup remain explicit later operational work. |
| Managed setup operations | Sequential upgrades, stop on failed verification, version/health ledger and later operator UI for separately owned installations. Keep private client inventory outside the public engine. |
| Public readiness | Public pullable images, maturity scorecard, current security posture/second security review, contribution agreement and intake, community access, support docs and website legal/contact/booking checks. Engine source availability alone does not close these. |

### Decisions that must not be resurrected as an unqualified backlog

- Public open source replaces the old invitation-only repository-access model; contact/booking
  replaced the website waitlist direction. Historic edition/pricing ideas need current product decisions.
- Automatic installation telemetry remains rejected. Website analytics is separate and must obey
  current infrastructure policy; old analytics-vendor lists are not adoption approval.
- The engine is already split into its own repository. Old “do not split yet” text is superseded.
- Personal configurations and optional templates replace a mandatory multi-agent launch roster.
- Ordinary setup works without an onboarding-agent model call. Conversational setup stays optional.
- Consumer subscriptions as runtime backends, automatic unattended fleet upgrades and several
  unrelated client installations sharing one server are historical rejected/deferred directions,
  not commitments. This does not restrict using Claude/Codex as an authorised file editor.
- Accounting stays paused. Training coaching stays optional. New semantic routing, memory platforms,
  restricted-reader agents and external automation services need an evidence-based decision, not
  automatic adoption because a research report mentioned them.

### Source coverage and remaining uncertainty

The filesystem inventory found **187 Markdown files**, including **85 under `docs/`**, before this
sweep's edits. All were enumerated; the `docs/` headings, future-work markers and source references were screened.
Specs, ADRs, current status, design notes, research and source-adjacent docs were reconciled by theme;
this is a coverage review, not a fresh line-by-line correctness audit of every historical document.
Fixtures/personas are implementation/test inputs, not 102 additional independent roadmap documents.

Sources also checked: historical parent/launch, installer,
permissions, multi-user, release and coaching plans; earlier review ledger/findings; and private
historical planning material. Archived copies
were treated as historical duplicates rather than independent delivery evidence.

The table below assigns each local `docs/` file a coverage home. “History” preserves evidence and
supersession; it does not mean every statement is current. Source-adjacent README files for agent-kit,
board/memory evaluations, console accounts, sync services, network, box operations and the UI preview
were also checked for roadmap-bearing caveats. The console accounts guide still describes build-time
grants, so documentation reconciliation is itself retained work.

Not claimed: every cloud document, unrelated project ticket, archived branch or nested attachment
has been exhaustively read; every historical review checkbox has been proven fixed; or any installation
has been updated. The website and its documentation live in a private repository and must be reconciled with shipped behaviour. Website implementation and the original full
coaching concept have not been freshly audited here (the latter is represented through the design's
27-section coverage table).
Known ideas now have a roadmap home; acceptance, priority and some historical dispositions still
need decisions. Keep this distinction when turning the inventory into a delivery roadmap.

| Local source | Roadmap home / treatment |
| --- | --- |
| [CURRENT_STATUS.md](../CURRENT_STATUS.md) | Entry point and current source-status log |
| [README.md](../README.md) | Entry point and current source-status log |
| [decisions/0010-knowledge-store-authority.md](../decisions/0010-knowledge-store-authority.md) | Architecture and governing decisions; historical amendments require reconciliation |
| [decisions/0013-agents-name-purposes-gateway-maps-models.md](../decisions/0013-agents-name-purposes-gateway-maps-models.md) | Architecture and governing decisions; historical amendments require reconciliation |
| [decisions/0014-proactivity-contract.md](../decisions/0014-proactivity-contract.md) | Architecture and governing decisions; historical amendments require reconciliation |
| [decisions/0015-agents-are-definitions-resolved-at-runtime.md](../decisions/0015-agents-are-definitions-resolved-at-runtime.md) | Architecture and governing decisions; historical amendments require reconciliation |
| [decisions/0016-fleet-runs-on-eve.md](../decisions/0016-fleet-runs-on-eve.md) | Architecture and governing decisions; historical amendments require reconciliation |
| [decisions/0017-the-vault.md](../decisions/0017-the-vault.md) | Architecture and governing decisions; historical amendments require reconciliation |
| [decisions/0018-learning-and-dreaming.md](../decisions/0018-learning-and-dreaming.md) | Architecture and governing decisions; historical amendments require reconciliation |
| [decisions/0019-integrations.md](../decisions/0019-integrations.md) | Architecture and governing decisions; historical amendments require reconciliation |
| [decisions/0020-conversations.md](../decisions/0020-conversations.md) | Architecture and governing decisions; historical amendments require reconciliation |
| [decisions/0021-releases-and-upgrades.md](../decisions/0021-releases-and-upgrades.md) | Architecture and governing decisions; historical amendments require reconciliation |
| [decisions/0022-the-tested-install-path.md](../decisions/0022-the-tested-install-path.md) | Architecture and governing decisions; historical amendments require reconciliation |
| [decisions/README.md](../decisions/README.md) | Architecture and governing decisions; historical amendments require reconciliation |
| [design/console-implementation.md](../design/console-implementation.md) | Console and website; dated design/release evidence, not current deployment |
| [design/console-lar50-handoff-2026-09-29.md](../design/console-lar50-handoff-2026-09-29.md) | Console and website; dated design/release evidence, not current deployment |
| [design/console-lar50-next-session-2026-09-28.md](../design/console-lar50-next-session-2026-09-28.md) | Console and website; dated design/release evidence, not current deployment |
| [design/console-refinement.md](../design/console-refinement.md) | Console and website; dated design/release evidence, not current deployment |
| [design/console-release-readiness-2026-09-29.md](../design/console-release-readiness-2026-09-29.md) | Console and website; dated design/release evidence, not current deployment |
| [design/console-structure.md](../design/console-structure.md) | Console and website; dated design/release evidence, not current deployment |
| [design/console-ui-stack.md](../design/console-ui-stack.md) | Console and website; dated design/release evidence, not current deployment |
| [design/console-verification-2026-09-28.md](../design/console-verification-2026-09-28.md) | Console and website; dated design/release evidence, not current deployment |
| [design/execution-plan.md](../design/execution-plan.md) | Console and website; dated design/release evidence, not current deployment |
| [design/lar50-rebuild-teardown-decision-2026-09-29.md](../design/lar50-rebuild-teardown-decision-2026-09-29.md) | Console and website; dated design/release evidence, not current deployment |
| [design/marketing-refinement.md](../design/marketing-refinement.md) | Console and website; dated design/release evidence, not current deployment |
| [design/motion.md](../design/motion.md) | Console and website; dated design/release evidence, not current deployment |
| [design/release-candidate-2026-09-25.md](../design/release-candidate-2026-09-25.md) | Console and website; dated design/release evidence, not current deployment |
| [how-to/erasing-a-person.md](../how-to/erasing-a-person.md) | Export, erasure and member privacy |
| [pr-ci.md](../pr-ci.md) | Contribution and release verification |
| [research/2026-09-01-engine-security-sweep.md](../research/2026-09-01-engine-security-sweep.md) | Security, approvals and audit reconciliation |
| [research/2026-09-01-governance-reconciliation.md](../research/2026-09-01-governance-reconciliation.md) | Security, approvals and audit reconciliation |
| [research/2026-09-04-lares-voice-feasibility.md](../research/2026-09-04-lares-voice-feasibility.md) | Voice interfaces; distinct from writing style |
| [research/2026-09-14-orb-286-door-attachment-matrix.md](../research/2026-09-14-orb-286-door-attachment-matrix.md) | Chat, documents and attachment conformance |
| [research/2026-09-16-agent-container-memory.md](../research/2026-09-16-agent-container-memory.md) | Runtime maintenance, capacity and lean operation |
| [research/2026-09-16-door-installation.md](../research/2026-09-16-door-installation.md) | Install, definitions, release and lifecycle evidence |
| [research/2026-09-16-eve-0.32-dynamic-seams.md](../research/2026-09-16-eve-0.32-dynamic-seams.md) | Runtime maintenance, capacity and lean operation |
| [research/2026-09-16-keeper-lifecycle-installation.md](../research/2026-09-16-keeper-lifecycle-installation.md) | Install, definitions, release and lifecycle evidence |
| [research/2026-09-18-eve-session-rows-retention.md](../research/2026-09-18-eve-session-rows-retention.md) | Memory, provenance, conversation retention and erasure |
| [research/2026-09-18-prelaunch/01-gbrain-gstack.md](../research/2026-09-18-prelaunch/01-gbrain-gstack.md) | Research candidates across memory, integration, safety and setup; governed by later ADRs |
| [research/2026-09-18-prelaunch/02-openclaw.md](../research/2026-09-18-prelaunch/02-openclaw.md) | Research candidates across memory, integration, safety and setup; governed by later ADRs |
| [research/2026-09-18-prelaunch/03-anthropic-guidance.md](../research/2026-09-18-prelaunch/03-anthropic-guidance.md) | Research candidates across memory, integration, safety and setup; governed by later ADRs |
| [research/2026-09-18-prelaunch/04-openai-guidance.md](../research/2026-09-18-prelaunch/04-openai-guidance.md) | Research candidates across memory, integration, safety and setup; governed by later ADRs |
| [research/2026-09-18-prelaunch/05-vercel-eve.md](../research/2026-09-18-prelaunch/05-vercel-eve.md) | Research candidates across memory, integration, safety and setup; governed by later ADRs |
| [research/2026-09-18-prelaunch/06-database-first-memory.md](../research/2026-09-18-prelaunch/06-database-first-memory.md) | Research candidates across memory, integration, safety and setup; governed by later ADRs |
| [research/2026-09-18-prelaunch/07-home-assistant-n8n.md](../research/2026-09-18-prelaunch/07-home-assistant-n8n.md) | Research candidates across memory, integration, safety and setup; governed by later ADRs |
| [research/2026-09-18-prelaunch/08-litellm-okf.md](../research/2026-09-18-prelaunch/08-litellm-okf.md) | Research candidates across memory, integration, safety and setup; governed by later ADRs |
| [research/2026-09-18-prelaunch/09-hermes-khoj.md](../research/2026-09-18-prelaunch/09-hermes-khoj.md) | Research candidates across memory, integration, safety and setup; governed by later ADRs |
| [research/2026-09-18-prelaunch/10-practitioner-sweep.md](../research/2026-09-18-prelaunch/10-practitioner-sweep.md) | Research candidates across memory, integration, safety and setup; governed by later ADRs |
| [research/2026-09-18-prelaunch/README.md](../research/2026-09-18-prelaunch/README.md) | Research candidates across memory, integration, safety and setup; governed by later ADRs |
| [research/2026-09-19-email-voice/01-tooling-and-vendors.md](../research/2026-09-19-email-voice/01-tooling-and-vendors.md) | Email/writing quality and reviewed learning |
| [research/2026-09-19-email-voice/02-techniques-and-practice.md](../research/2026-09-19-email-voice/02-techniques-and-practice.md) | Email/writing quality and reviewed learning |
| [research/2026-09-19-email-voice/03-writing-voice-design-DRAFT.md](../research/2026-09-19-email-voice/03-writing-voice-design-DRAFT.md) | Email/writing quality and reviewed learning |
| [research/2026-09-19-email-voice/README.md](../research/2026-09-19-email-voice/README.md) | Email/writing quality and reviewed learning |
| [runbooks/2026-09-19-oauth-principal-rename.md](../runbooks/2026-09-19-oauth-principal-rename.md) | Install, release, recovery and migration acceptance |
| [runbooks/blank-ubuntu-install-candidate.md](../runbooks/blank-ubuntu-install-candidate.md) | Install, release, recovery and migration acceptance |
| [runbooks/current-layout-backup.md](../runbooks/current-layout-backup.md) | Install, release, recovery and migration acceptance |
| [runbooks/definition-backups.md](../runbooks/definition-backups.md) | Install, release, recovery and migration acceptance |
| [runbooks/export-and-teardown.md](../runbooks/export-and-teardown.md) | Install, release, recovery and migration acceptance |
| [runbooks/golden-path-runs.md](../runbooks/golden-path-runs.md) | Install, release, recovery and migration acceptance |
| [runbooks/keeper-managed-switch.md](../runbooks/keeper-managed-switch.md) | Install, release, recovery and migration acceptance |
| [runbooks/naming-migration.md](../runbooks/naming-migration.md) | Install, release, recovery and migration acceptance |
| [solutions/2026-09-19-eve-060-pairing.md](../solutions/2026-09-19-eve-060-pairing.md) | Runtime and verification lessons; historical evidence |
| [solutions/2026-10-01-a-safety-net-that-hid-a-fail-closed-agent.md](../solutions/2026-10-01-a-safety-net-that-hid-a-fail-closed-agent.md) | Runtime and verification lessons; historical evidence |
| [solutions/2026-10-06-a-test-path-under-proc-hung-linux-ci.md](../solutions/2026-10-06-a-test-path-under-proc-hung-linux-ci.md) | Runtime and verification lessons; historical evidence |
| [solutions/2026-10-07-undici-8-and-the-proxy-paths.md](../solutions/2026-10-07-undici-8-and-the-proxy-paths.md) | Runtime and verification lessons; historical evidence |
| [specs/2026-08-31-lares-engine-overlay-inventory-design.md](../specs/2026-08-31-lares-engine-overlay-inventory-design.md) | Agent definitions, templates, skills and extension boundary |
| [specs/2026-08-31-lares-org-and-multi-user-design.md](../specs/2026-08-31-lares-org-and-multi-user-design.md) | Ownership, members, scopes and sharing |
| [specs/2026-09-01-accounting-concept-design.md](../specs/2026-09-01-accounting-concept-design.md) | Accounting; paused |
| [specs/2026-09-01-skills-layer-design.md](../specs/2026-09-01-skills-layer-design.md) | Agent definitions, templates, skills and extension boundary |
| [specs/2026-09-03-backup-and-restore-per-installation-design.md](../specs/2026-09-03-backup-and-restore-per-installation-design.md) | Install, definitions, release and lifecycle evidence |
| [specs/2026-09-03-deadline-primitive-design.md](../specs/2026-09-03-deadline-primitive-design.md) | Schedules, proactive delivery, deadlines and honest health |
| [specs/2026-09-03-fresh-install-golden-path-design.md](../specs/2026-09-03-fresh-install-golden-path-design.md) | Install, definitions, release and lifecycle evidence |
| [specs/2026-09-03-injection-test-suite-design.md](../specs/2026-09-03-injection-test-suite-design.md) | Security, approvals and audit reconciliation |
| [specs/2026-09-03-proactivity-contract-design.md](../specs/2026-09-03-proactivity-contract-design.md) | Schedules, proactive delivery, deadlines and honest health |
| [specs/2026-09-03-schedule-output-freshness-design.md](../specs/2026-09-03-schedule-output-freshness-design.md) | Schedules, proactive delivery, deadlines and honest health |
| [specs/2026-09-11-lares-repo-split-design.md](../specs/2026-09-11-lares-repo-split-design.md) | Install, definitions, release and lifecycle evidence |
| [specs/2026-09-14-lares-installer-and-wizard-design.md](../specs/2026-09-14-lares-installer-and-wizard-design.md) | Install, definitions, release and lifecycle evidence |
| [specs/2026-09-14-lares-releases-and-update-design.md](../specs/2026-09-14-lares-releases-and-update-design.md) | Install, definitions, release and lifecycle evidence |
| [specs/2026-09-15-lares-agent-definitions-design.md](../specs/2026-09-15-lares-agent-definitions-design.md) | Agent definitions, templates, skills and extension boundary |
| [specs/2026-09-18-eve-upgrade-design.md](../specs/2026-09-18-eve-upgrade-design.md) | Runtime maintenance, capacity and lean operation |
| [specs/2026-09-18-origin-model-design.md](../specs/2026-09-18-origin-model-design.md) | Memory, provenance, conversation retention and erasure |
| [specs/2026-09-19-multi-user-what-is-left.md](../specs/2026-09-19-multi-user-what-is-left.md) | Ownership, members, scopes and sharing |
| [specs/2026-10-06-dependency-sweep-plan.md](../specs/2026-10-06-dependency-sweep-plan.md) | Runtime maintenance, capacity and lean operation |
| [specs/2026-10-08-roadmap-and-integration-inventory.md](../specs/2026-10-08-roadmap-and-integration-inventory.md) | Current roadmap inventory and this coverage review |
| [website-repository.md](../website-repository.md) | Website and managed-setup boundary |

## Related decisions and designs

- [Agent setup and model/Jev plan](2026-09-15-lares-agent-definitions-design.md)
- [Integration architecture](../decisions/0019-integrations.md)
- [Integration manifests and quality](../../integrations/README.md)
- [Engine inventory and concept boundaries](2026-08-31-lares-engine-overlay-inventory-design.md)
- [Multi-user gaps](2026-09-19-multi-user-what-is-left.md)
- [Accounting contract](2026-09-01-accounting-concept-design.md)
- [Writing research](../research/2026-09-19-email-voice/README.md)
- [Prelaunch research](../research/2026-09-18-prelaunch/README.md)

## Security-review sequencing input — 8 October

The 8 October security review produced 20 findings, independently source-reviewed and verified,
which are summarised below by subject rather than by code. Full install/update/restore repetition is **deferred by the owner**,
not silently passed against new code.

### Delivery order and existing-work mapping

| Order | Scope | Existing work to extend | Acceptance, including console and documentation |
| --- | --- | --- | --- |
| 1 | Exact-origin checks for raw authenticated mutations | Security sweep | Hostile same-site request cannot mutate; legitimate console and signed webhook flows work; document deployment assumptions |
| 1 | Pinned artifact availability and advisory triage | Security/dependency/release acceptance | Every digest retrieves; exact images scanned; reachable issues fixed or disposition justified; package/source/image status stated separately |
| 2 | Private-owner setup, credentials, gateway and honest failure states | Connections, gateway, cost/activity and builder work | Users enter/connect/revoke/test their own external credentials; internal material generated by Lares; all settings reachable in console; setup/help docs match behaviour |
| 2 | Notion clipping | Existing capture/integration work; explicit new clipping slice if absent | Bounded requests; reuse existing capture surface and client; destination test in console; verify replacement before retiring prior path; decide historical import separately |
| 3 | Injection and writing quality | Existing injection, persona-eval and writing-learning work | Real tool/approval/restart provenance; factuality plus blind voice review; dated model/provider evidence visible beside console choices; deterministic operations avoid LLM calls |
| 4 | Shared/private members | Existing members/roles and per-member memory lanes | Resource and credential isolation proven before enabling private multiuser claims; shared onboarding explains visibility |
| Alongside affected work | Neutral defaults / SDK reuse / runtime simplification | Integration foundation and architecture sweep | Small independent changes; preserve egress, auth, retry bounds and approvals; measure before consolidating runtime |
| Alongside releases | Update notices, docs and marketing | Existing release notification and website/docs work | Honest availability/version state, guidance first; one-click only after recovery gates; publish tested capabilities and current screenshots |
| Deferred | Install/update/restore remedies and rehearsal | Existing lifecycle/recovery work | Findings retained; revisit timing explicitly; do not use this deferral to promise proven one-click recovery |

Every delivery slice must include its console controls/status, failure messages, user documentation
and any changed marketing claims. Personal and business use remain two presentations of one engine;
optional coaching/travel/taste templates do not require a second runtime. Accounting remains paused.
No review finding authorises a rewrite, deployment, provider change or a previously deferred feature.

The next artifact work is scoped in the [release-image remediation plan](2026-10-08-release-image-remediation-plan.md): rebuild current fixes first, then target residual toolchain/upstream findings, and verify final published digests before a new candidate manifest. Publication and deployment remain separate gates.
