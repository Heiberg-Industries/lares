# ADR 0019 — Integrations: official SDKs and typed adapters for the core, a manifest that generates the registries, un-reviewed tools only through MCP

**Date:** 2026-09-18
**Status:** Accepted
**Supersedes:** —
**Amends / reconciles:** the adapter ladder (private, contributed, shipped) and the preference for a
typed client over a hosted MCP server for core concepts. Neither is withdrawn; this ADR states how
they fit together (see Context).

## In plain language

1. Lares had grown several separate ways of talking to Notion and Slack, and of signing a person into Google — each copy solving the same small problems (retries, rate
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
8. Nothing changes for an owner; this is what the coding agents build from.

## Context

**The duplication was real.** Notion had three independent hand-rolled HTTP clients, one of them
inline in a schedule that runs inside a sealed container whose only egress is a proxy, so it built
its own dispatcher rather than reuse the shared client. Slack was reached through hand-rolled
clients against `https://slack.com/api` rather than the official package. Google sign-in had
several separate OAuth wirings, all already built on the official `googleapis` package (or
`googleapis-common`, deliberately, to keep `googleapis`'s large bundle out of the shared kit); the
SDK choice was already right, but the refresh, retry and error handling around it was written
several times over. Some consumers already do it right: the Atlas Notion source takes the page reader
as an injected dependency rather than building its own client.

**The connections list was hand-maintained and drifted.** `packages/agent-kit/src/connections.ts`
was a hand-written array describing credential custody, secrets and instances per vendor, and
comments elsewhere pointed at a registry file that no longer exists. Stale comments are exactly
the drift a generated registry removes by construction.

**A region field already exists and is enforced.** `packages/agent-kit/src/persona/capability-docs.ts`
defines `AdapterRegion` (`{countries, reason} | "global"`) and requires it on every
`kind: "adapter"` capability doc, checked by `packages/agent-kit/tests/capability-region.test.ts`.
The manifest below carries the same field forward rather than inventing a new one.

**The never-widen check already exists**, one layer below where ADR-0015 describes it.
`packages/agent-kit/src/manifest.ts` states the rule ("a skill composes capabilities the
agent ALREADY holds... it can never widen access"); the enforcement itself is
`assertSkillsWithinGrants` in `packages/agent-kit/src/skill-grants.ts`, which throws naming
the skill, the capability and both scopes when a skill's declared requirement exceeds its agent's
grant.

**Reconciling two positions.** The adapter ladder sets out private (outside the process, speaking
MCP), contributed (a PR, reviewed against a six-point checklist: live probe, declared region,
egress documented, secrets by declaration, no telemetry, contract tests) and shipped (merged,
maintained by the project), and recommends that a member's *private* integration stay outside the
engine and speak MCP. Separately, for accounting, the public MCP servers for the vendor are all
read-only and cover none of the write half, which is where the entire value is — so there is
nothing to reuse and a typed client is preferred. Read together, these are not in tension: the
adapter ladder is about **provenance** — where an integration's code lives and who maintains it
(private / contributed / shipped) — while "typed client, not MCP" is about **quality and
capability** for the concepts the core needs to reason about precisely (a write needs a typed
capability the ratchet can gate; a read-only MCP wrapper cannot express that). This ADR states
explicitly what was implicit: provenance and quality tier are two separate axes. A private
integration can be MCP and still meet the quality bar for its owner's own use; a *core* concept
(mailbox, calendar, accounting, CRM) is always a typed adapter, whatever its provenance, because
the ratchet and the approval cards need to know exactly what a write does.

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
   Home Assistant `hassfest` pattern).
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
9. **A Repairs inbox**, generalising the existing backup-alarm pattern: what broke, how
   bad, from which release it stops working, how to fix it — fed by sign-in failures, rate
   limits, a stale generated file, or a failed live-probe re-run.
10. **No third-party code runs inside the engine.** Un-reviewed tools reach an agent only through
    MCP, outside the engine process: a tool allow-list per connection; reads *and* writes stay
    behind approval until the connection is trusted; tool descriptions are pinned and diffed on
    every change (an official vendor's own MCP server can carry commercial instruction text in its tool descriptions — that text must never reach the core prompt unreviewed); the server's own instruction text is kept out of the core prompt; where the
    server runs is recorded against the connection.
11. **Microsoft 365 comes after the first public release**, on the official Graph SDK for JavaScript, behind the
    same neutral mailbox/calendar contract as Google — not on Microsoft's own hosted "Work IQ"
    MCP servers, and not on Google's own hosted Workspace MCP servers. Both are previews, vendor-hosted, add a hop rather than remove one, and expose
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
- A stale registry (like the dangling registry comments that motivated this) becomes structurally impossible: the file the checker generates cannot disagree with the
  manifest that produced it.
- Provenance and quality no longer get confused with each other, which the adapter ladder already needed but did not say plainly.

**Negative / accepted trade-offs:**
- Collapsing three Notion clients and the Slack clients into one each is a real refactor across
  several services, not a small one; it touches `services/notion-sync`,
  `services/chief-of-staff` and `services/atlas`.
- The manifest and checker are new build-time machinery that must itself be tested before
  anything depends on it (a stale-generated-file bug here would be worse than hand-maintained drift, because it would look authoritative).
- Microsoft 365 stays unavailable in the first public release; an owner who needs it must wait.

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

- The exact schema and CLI for the manifest scaffold (`pnpm lares:integration new`, a borrowed shape) — a build decision, not this ADR.
- Whether the six-point checklist's "contract tests" need a formal neutral contract for `crm`
  the way `accounting` already has one — `crm` has no contract document.

## Cross-references

- ADR-0015 (agents are definitions), ADR-0016 (eve)
- Research on Home Assistant/n8n (the manifest-generates-registry pattern) and on the Microsoft/Google hosted MCP servers
