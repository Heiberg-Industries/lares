# ADR 0019 — Integrations: official SDKs and typed adapters for the core, a manifest that generates the registries, un-reviewed tools only through MCP

**Date:** 2026-09-18
**Status:** Accepted
**Supersedes:** —
**Amends / reconciles:** `docs/specs/2026-08-31-lares-engine-overlay-inventory-design.md` ("The
adapter ladder — private, contributed, shipped") and the integration programme's own preference
for a typed client over a hosted MCP server (recorded in
`docs/specs/2026-09-01-accounting-concept-design.md`). Neither document is withdrawn; this ADR
states how they fit together (see Context).

## In plain language

1. Today Lares talks to Notion four separate ways, Slack three separate ways, and signs a person
   into Google five separate ways — each copy solving the same small problems (retries, rate
   limits, refreshing a token) slightly differently.
2. This decision says: one official software library per vendor, written once, used everywhere.
3. For the handful of things every installation needs — a mailbox, a calendar, bookkeeping, a
   CRM — Lares writes its own small, typed connector rather than leaning on a general-purpose
   tool-calling protocol (MCP) that the model has to interpret at run time.
4. A new "manifest" file describes each integration once — what it touches, which countries it
   works in, which outside addresses it calls, which secrets it needs — and a checker writes the
   connections list, the documentation and the console's rows from that one file, so they cannot
   drift apart.
5. Anything the owner adds that has not been reviewed — a spreadsheet tool, an unfamiliar
   vendor's server — stays outside the engine and reaches it only through the reviewed connection
   protocol (MCP), sandboxed, never running as part of the engine's own code.
6. Microsoft 365 is not part of the first public release; it arrives afterwards, built the same
   careful way as everything else.
7. Whether an integration is Lares's own work, a contribution, or a member's private connector is
   now a separate question from how good it is — a private integration can still meet the same
   quality bar, and a shipped one is always held to it.
8. Nothing changes for an owner today; this is what the coding agents build from next.

## Context

**The duplication is real and verified in this worktree.** Notion has three independent
implementations: a hand-rolled HTTP client at `services/notion-sync/lib/adapters/notion-client.ts:172`
(`const NOTION_API = "https://api.notion.com"`), a second at
`services/chief-of-staff/lib/notion-page.ts:17`, and a third, fully independent one inline in a
schedule at `services/chief-of-staff/agent/schedules/meeting-followup.ts:682-722` (its own
`NOTION_API`, its own token reader, its own egress-proxy wiring — the file's own header explains
why it cannot simply call the first client: it runs inside a sealed container whose only egress
is a slack-proxy squid instance, so it builds its own dispatcher rather than reuse one). A fourth
apparent site, `services/atlas/lib/adapters/notion-source.ts`, is **not** a duplicate: it takes
`getPageMarkdown` as an injected dependency, and its own header says so — "takes `getPageMarkdown`
as a dependency rather than building a client: the real one comes from [notion-sync]'s
`makeNotionClient`" — and `services/atlas/bin/atlas-sync.ts:29` does import `makeNotionClient`
from notion-sync. So the real count is three independent Notion clients; the fourth site already
does what this ADR asks for everywhere else.

Slack has three independent implementations, all hand-rolled against `https://slack.com/api`:
`services/network/lib/slack.ts:17`, `services/network/lib/importers/slack-reader.ts:33`, and
`services/chief-of-staff/lib/slack-source.ts:68`. None imports `@slack/web-api`.

Google sign-in has five separate OAuth wirings, all already built on the official `googleapis`
package (or `googleapis-common`, deliberately, to keep `googleapis`'s 26 MB bundle out of the
shared kit — `packages/agent-kit/src/google-auth.ts:229-236`): `packages/agent-kit/src/google-auth.ts`,
`services/chief-of-staff/lib/google.ts:62`, `services/travel/lib/google.ts:79`,
`services/notion-sync/lib/adapters/calendar-oauth.ts:12`, and `services/console/lib/account-oauth.ts:3`.
The SDK choice is already right; the refresh, retry and error handling around it is written five
times over.

**The connections list is hand-maintained and already carries dangling references.**
`packages/agent-kit/src/connections.ts` is a hand-written `const defs: ConnectionDef[] = [...]`
array (`connections.ts:41`) describing credential custody, secrets and instances per vendor; its
own header (`connections.ts:1-3`) says the other half of an integration lives in a file called
`registry.ts`, which does not exist anywhere in this worktree (confirmed by search). Five other
files carry comments pointing at `lib/integrations/registry.ts`
(`services/chief-of-staff/tests/commercial.test.ts:52`, `services/chief-of-staff/lib/twenty-people.ts:10`,
`services/chief-of-staff/agent/tools/commercial_who_to_contact.ts:5`,
`services/creative/catalogue/studio_ideate.ts:29`) or `services/agent-runtime/lib/integrations/registry.ts`
(`services/creative/lib/llm-complete.ts:14`) — `services/agent-runtime` itself does not exist in
this repo (it was decommissioned and archived, per ADR-0016). These are stale comments from
before the runtime split, not live code paths, but they are exactly the drift a generated
registry removes by construction.

**A region field already exists and is enforced.** `packages/agent-kit/src/persona/capability-docs.ts:99-105,137-138`
defines `AdapterRegion` (`{countries, reason} | "global"`) and requires it on every
`kind: "adapter"` capability doc, checked by `packages/agent-kit/tests/capability-region.test.ts`.
The manifest below carries the same field forward rather than inventing a new one.

**The never-widen check already exists**, one layer below where ADR-0015 describes it.
`packages/agent-kit/src/manifest.ts:60-64` states the rule ("a skill composes capabilities the
agent ALREADY holds... it can never widen access"); the enforcement itself is
`packages/agent-kit/src/skill-grants.ts:89-105`, `assertSkillsWithinGrants`, which throws naming
the skill, the capability and both scopes when a skill's declared requirement exceeds its agent's
grant.

**Reconciling the two older positions.** `docs/specs/2026-08-31-lares-engine-overlay-inventory-design.md:133-168`
sets out an adapter ladder — private (outside the process, speaking MCP), contributed (a PR,
reviewed against a six-point checklist: live probe, declared region, egress documented, secrets
by declaration, no telemetry, contract tests), shipped (merged, maintained by the project) — and
separately, at lines 421-442, recommends that a member's *private* integration stay outside the
engine and speak MCP against a concept contract ("the parent spec already treats MCP as the reach
mechanism... no custom code per client"; that parent spec,
`docs/superpowers/specs/2026-08-17-shared-agent-stack-design.md`, is not present in this
worktree — it lives in the private companion repository the overlay-inventory doc was copied
from, per that document's own header note).
Separately, `docs/specs/2026-09-01-accounting-concept-design.md:66-67` states, for the accounting
concept specifically: "The three public Fiken MCP servers are all read-only... they cover none of
the write half, which is where the entire value is. Nothing to reuse there" — the closest
citable statement in this worktree of "prefer our own typed client over a remote MCP server" (the
standalone "integration programme" spec the brief names was not found as its own file in this
worktree; this accounting document, which cites "the integration programme (§ Workstream E)" as
a source, is what exists). Read together, these are not in tension: the adapter ladder is about
**provenance** — where an integration's code lives and who maintains it (private / contributed /
shipped) — while "typed client, not MCP" is about **quality and capability** for the concepts the
core needs to reason about precisely (a write needs a typed capability the ratchet can gate; a
read-only MCP wrapper cannot express that). This ADR states explicitly what was implicit:
provenance and quality tier are two separate axes. A private integration can be MCP and still
meet the quality bar for its owner's own use; a *core* concept (mailbox, calendar, accounting,
CRM) is always a typed adapter, whatever its provenance, because the ratchet and the approval
cards need to know exactly what a write does.

## Decision

1. **Official vendor SDKs first.** `googleapis` (already used), `@notionhq/client`,
   `@slack/web-api`. A hand-rolled HTTP client is only for a vendor with no maintained SDK.
2. **One shared request helper** for vendors with no SDK: timeout, retry with backoff, a
   single-flight refresh lock, pagination, and four error kinds — down, not authorised, rate
   limited, not subscribed.
3. **Shared credential types with a `test` call.** One shape per auth kind (API key, OAuth2),
   checked at save time, not discovered on first real use.
4. **Owner-supplied OAuth client; no vendor in the sign-in path.** The owner pastes their own
   client id/secret into the console; Lares never operates a central account-linking service on
   the owner's behalf.
5. **Typed adapters, never MCP, for the core concepts:** mailbox, calendar, accounting, CRM.
   These are the concepts the ratchet and approval cards reason about; an adapter's write calls
   are named, typed and gated the way `accounting`'s contract already is
   (`accounting.inbox_submit`, `accounting.record_purchase`, etc. — deliberately no
   `send_invoice` or `pay`).
6. **One manifest per integration; a checker generates the registries.** The manifest is the
   single source; `connections.ts`, the capability docs, the console's integration rows and the
   outbound allow-list are all generated from it. CI fails when a generated file is stale (the
   Home Assistant `hassfest` pattern — report 07).
7. **Quality tiers, enforced in CI.** The existing six-point checklist from the overlay-inventory
   doc (live probe, declared region, outbound hosts documented, secrets by declaration, no
   telemetry, contract tests) is the entry tier. A `quality.yaml` per integration records
   `done | todo | exempt + comment` per rule; a claimed tier not backed by its rules fails the
   build.
8. **Provenance (core / contributed / private) is recorded separately from quality.** The
   adapter ladder answers "who maintains this and where does it live"; the quality tier answers
   "how good is it". A private integration is never asked to meet a bar it cannot reach through
   MCP; a contributed or shipped integration is always asked to meet the entry tier before it
   merges.
9. **A Repairs inbox**, generalising the existing backup-alarm pattern (LAR-54): what broke, how
   bad, from which release it stops working, how to fix it — fed by sign-in failures, rate
   limits, a stale generated file, or a failed live-probe re-run.
10. **No third-party code runs inside the engine.** Un-reviewed tools reach an agent only through
    MCP, outside the engine process: a tool allow-list per connection; reads *and* writes stay
    behind approval until the connection is trusted; tool descriptions are pinned and diffed on
    every change (report 10's finding: an official vendor's own MCP server can carry commercial
    instruction text in its tool descriptions — that text must never reach the core prompt
    unreviewed); the server's own instruction text is kept out of the core prompt; where the
    server runs is recorded against the connection.
11. **Microsoft 365 comes after launch**, on the official Graph SDK for JavaScript, behind the
    same neutral mailbox/calendar contract as Google — not on Microsoft's own hosted "Work IQ"
    MCP servers, and not on Google's own hosted Workspace MCP servers. Report 10's direct answer
    (2026-09-18): both are previews, vendor-hosted, add a hop rather than remove one, and expose
    either ten generic verbs (Microsoft's `do_action <path>` shape) or draft-only tools (Google's
    Gmail MCP has no send) — neither gives the ratchet the typed, named writes it needs, and both
    put an additional vendor gateway between Lares and a mailbox Lares can already reach directly
    with the SDK.

## The manifest

| Field | Purpose |
| --- | --- |
| `name` | folder name = integration id |
| `concept` | the neutral Lares contract it implements, if any (`mailbox`, `calendar`, `accounting`, `crm`) — absent for a vendor-specific integration with no shared contract |
| `capability` | the capability id(s) it backs, matching `packages/agent-kit/src/persona/capability-docs.ts` |
| `region` | ISO 3166-1 alpha-3 countries + reason, or `"global"` — the existing `AdapterRegion` shape, unchanged |
| `data_path` | `self_hosted \| eu_cloud \| non_eu_cloud \| owner_chosen` — where the vendor actually processes data |
| `outbound_hosts` | every host the adapter reaches; generates the proxy/squid allow-list entry |
| `secrets` | named secret files only; the checker fails on any undeclared secret read |
| `credential_type` | which shared credential type it uses, and whether the owner supplies their own OAuth client |
| `quality tier file` | pointer to its `quality.yaml` |
| `codeowner` | who is notified when it breaks |

**Generated files the checker produces:** `packages/agent-kit/src/connections.ts`, the capability
docs' vendor/region fields, the console's Connections rows, and the outbound proxy allow-list.
All four become derived output; none is hand-edited once the manifest exists.

## Consequences

**Positive:**
- One Notion client, one Slack client, one Google sign-in flow — the retry, rate-limit and
  refresh logic each current copy solves separately is solved once.
- A stale registry (like the five dangling `lib/integrations/registry.ts` comments found in this
  pass) becomes structurally impossible: the file the checker generates cannot disagree with the
  manifest that produced it.
- Provenance and quality no longer get confused with each other, which the overlay-inventory
  doc's own ladder already needed but did not say plainly.

**Negative / accepted trade-offs:**
- Collapsing three Notion clients and three Slack clients into one each is a real refactor across
  several services, not a small one; it touches `services/notion-sync`,
  `services/chief-of-staff`, `services/atlas` and `services/network`.
- The manifest and checker are new build-time machinery that must itself be tested before
  anything depends on it (a stale-generated-file bug here would be worse than today's
  hand-maintained drift, because it would look authoritative).
- Microsoft 365 stays unavailable at launch; an owner who needs it must wait.

## Operational rules

- Do: write one manifest before writing a new integration's code; let the checker generate
  everything else.
- Do: keep provenance and quality tier as two separate fields on every integration, always.
- Don't: let a private, MCP-based integration claim a quality tier meant for a typed core
  adapter.
- Don't: add a vendor-hosted MCP server as a core integration, however convenient, while the
  vendor's own SDK exists.
- Don't: let an MCP server's own instruction text reach the core prompt unreviewed.

## Open questions

- The exact schema and CLI for the manifest scaffold (`pnpm lares:integration new` in report
  07's borrowed shape) — a build decision for wave 6 of the pre-launch programme, not this ADR.
- Whether the six-point checklist's "contract tests" need a formal neutral contract for `crm`
  the way `accounting` already has one — `crm` has no contract document in this worktree today.

## Cross-references

- `docs/specs/2026-08-31-lares-engine-overlay-inventory-design.md` (adapter ladder)
- `docs/specs/2026-09-01-accounting-concept-design.md` (typed contract over MCP, for accounting)
- ADR-0015 (agents are definitions), ADR-0016 (eve)
- Research reports `07` (Home Assistant/n8n — the manifest-generates-registry pattern), `10`
  (practitioner sweep — the Microsoft/Google MCP direct answer)
