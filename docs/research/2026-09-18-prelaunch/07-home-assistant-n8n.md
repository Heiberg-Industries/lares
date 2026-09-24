# 07 — Home Assistant, n8n (and Activepieces): how to run an integration ecosystem and a first run for non-developers

Research for LAR-71, 2026-09-18. Read-only. Depth on questions 2 (integrations), 3 (first run), 8 (community); 5–7 brief; 1 and 4 n/a.

## Header

| Source | Repo | Default-branch commit (date) | Latest release (date) | Licence | Stars |
|---|---|---|---|---|---|
| Home Assistant core | github.com/home-assistant/core | `98357628` on `dev` (2026-09-18) | 2026.9.3 (2026-09-18) | Apache-2.0 | 90.7k |
| HACS (community store for HA) | github.com/hacs/integration | `adb7d83e` (2026-09-05) | 2.0.5 (2025-01-28) | MIT | 7.7k |
| HA architecture (ADRs) | github.com/home-assistant/architecture | pushed 2026-09-11 | n/a | — | 364 |
| n8n | github.com/n8n-io/n8n | `e94dff42` on `master` (2026-09-18) | n8n@2.39.8 (2026-09-18) | Sustainable Use License 1.0 (+ `.ee` files under a separate Enterprise licence) — NOT open source | 205k |
| Activepieces | github.com/activepieces/activepieces | `7129df19` on `main` (2026-09-18) | 0.91.0 (2026-09-14) | MIT, except `packages/ee/` and `packages/server/api/src/app/ee` (commercial) | 24.5k |

**What I read:** HA developer docs (quality scale, checklist, manifest, config flow, application credentials, repairs, LLM API, scaffold), HA user docs (onboarding, analytics, release FAQ, Raspberry Pi install, 2026.9 release notes, install-method deprecation post, 2021 security disclosure), Open Home Foundation structure page. In code: `script/hassfest/quality_scale.py` (full), `script/scaffold/` tree and `gather_info.py`, `homeassistant/loader.py` (custom-integration warning and blocklist), `homeassistant/generated/`, a sample `quality_scale.yaml`, the ADR list. n8n docs (node building style, credentials files, HTTP helpers, verification guidelines, n8n-node CLI, community-node risks/blocklist/verified install, HITL for tools, Docker and one-line install, telemetry, v3.0 breaking changes); n8n code: `LICENSE.md`, `packages/nodes-base/package.json`, request helpers under `packages/core/src/execution-engine/node-execution-context/utils/request-helpers/`, `packages/cli/src/modules/breaking-changes/README.md`, `@n8n/node-cli` templates. Activepieces: `LICENSE`, `packages/pieces/CLAUDE.md`, `docs/mcp/*.mdx`, `packages/pieces/community/mcp-client/`.

**Unverified / not read:** HA's `my.home-assistant.io` OAuth redirect mechanics (well known, but the doc pages I fetched did not state it — marked unverified where used). Where exactly the quality tier is shown on each integration's public doc page (I saw it in release notes and know the manifest field; the doc-page badge is unverified today). n8n's setup screen contents (owner account form — unverified in docs today). n8n/HA contributor agreement details. Activepieces sandbox modes (doc page pointed elsewhere; not followed). Exact HA integration count (GitHub API listing caps at 1,000; hassfest lists imply well over 1,300). The n8n January-2026 supply-chain incident is from security press (The Hacker News, CSO Online, Endor Labs), not from n8n itself.

---

## 1. MEMORY — n/a

Neither product has agent memory in Lares's sense. HA's "truth" is a config-entry store + registries in JSON under `.storage/`, plus a recorder database; n8n's is a SQL database with encrypted credentials.

## 2. INTEGRATIONS (deep)

### 2.1 Home Assistant — structure

**One folder per integration, everything else generated.** An integration is `homeassistant/components/<domain>/` with `manifest.json`, `__init__.py`, `config_flow.py`, `strings.json`, `quality_scale.yaml`, optional `application_credentials.py`, `repairs.py`, `diagnostics.py`, plus `tests/components/<domain>/`. The author does **not** hand-edit any central registry: `python3 -m script.hassfest` reads every manifest and regenerates `homeassistant/generated/config_flows.py`, `integrations.json`, `application_credentials.py`, `zeroconf.py`, `dhcp.py`, `ssdp.py`, `usb.py`, `bluetooth.py`, `mqtt.py` and the root `CODEOWNERS` file (validators in `script/hassfest/`: `manifest.py`, `config_flow.py`, `codeowners.py`, `dependencies.py`, `requirements.py`, `translations.py`, `quality_scale.py`, … — 35 validators). CI fails if generated files are stale. **This is the direct cure for Lares's "adding one touches 6+ places": the six places still exist, but a machine writes five of them from one manifest.**

**Manifest** (developers.home-assistant.io/docs/creating_integration_manifest). Required: `domain`, `name`, `codeowners`, `dependencies`, `documentation`, `integration_type` (`device|entity|hardware|helper|hub|service|system|virtual`), `iot_class` (`assumed_state|cloud_polling|cloud_push|local_polling|local_push|calculated`), `requirements` (pinned PyPI packages). Optional: `config_flow`, `single_config_entry`, `quality_scale`, `loggers`, `after_dependencies`, discovery matchers (`zeroconf`, `ssdp`, `dhcp`, `bluetooth`, `usb`, `mqtt`, `homekit`), and `version` (custom integrations only). `iot_class` is the interesting one for Lares: a **single, user-visible honesty label about where data goes** ("cloud polling" vs "local push"). Naming rule: if a product has both, the cloud one must carry "Cloud" in its name.

**Scaffold** — `python3 -m script.scaffold integration` (code: `script/scaffold/`, prompts in `gather_info.py`). It asks: name, your GitHub handle, the PyPI library, the IoT class, "does it need authentication?", "is it discoverable?", "OAuth2?" — and generates the folder, a config flow, config-flow tests, translations and a `quality_scale.yaml` with every rule set to `todo`. Further templates: `config_flow`, `config_flow_discovery`, `config_flow_oauth2`, `config_flow_helper`, `backup`, `device_trigger`, etc. (`script/scaffold/templates/`).

**API client code lives outside core.** "One of the foundational rules of Home Assistant is that we do not include any protocol specific code. Instead, this code should be put into a standalone Python library and published to PyPI." (developers.home-assistant.io/docs/api_lib_index). The docs give no rationale on that page; the rationale is visible in the Bronze rule `dependency-transparency`: the library must be OSI-licensed, on PyPI, **built and published from a public CI pipeline**, and the published version must match a tagged release in a public repo — "There are no exceptions to this rule." Effect: the integration in core is a thin adapter that reviewers can actually read; vendor quirks are versioned separately; supply chain is auditable. Platinum adds `async-dependency` and `inject-websession` (the library must accept HA's shared HTTP session — i.e. **HA controls the socket**, which is the same instinct as Lares's allow-list proxy).

### 2.2 Home Assistant — the quality scale (exact rules)

ADR-0022 in home-assistant/architecture; rules in code at `script/hassfest/quality_scale.py` lines 38–94. Tiers are cumulative.

- **Bronze (20 rules — the floor for every NEW integration):** `config-flow` (UI setup, no YAML), `test-before-configure` (test the connection inside the setup flow), `test-before-setup` (check at start-up that it can run), `unique-config-entry` (no duplicates), `config-flow-test-coverage` (100% on the setup flow), `dependency-transparency`, `brands`, `common-modules`, `runtime-data`, `action-setup`, `appropriate-polling`, `entity-event-setup`, `entity-unique-id`, `has-entity-name`, and six docs rules (`docs-high-level-description`, `docs-installation-instructions`, `docs-removal-instructions`, `docs-actions`, `docs-triggers`, `docs-conditions`).
- **Silver (10 — reliability):** `reauthentication-flow`, `integration-owner`, `log-when-unavailable` ("log once when unavailable and once when back"), `entity-unavailable`, `action-exceptions`, `config-entry-unloading`, `parallel-updates`, `test-coverage` (>95%), `docs-configuration-parameters`, `docs-installation-parameters`.
- **Gold (21 — best experience):** `repair-issues`, `reconfiguration-flow`, `diagnostics`, `discovery`, `discovery-update-info`, `devices`, `dynamic-devices`, `stale-devices`, entity polish (category, device class, disabled-by-default, translations, icon and exception translations) and seven more docs rules (`docs-known-limitations`, `docs-troubleshooting`, `docs-supported-devices`, `docs-supported-functions`, `docs-use-cases`, `docs-examples`, `docs-data-update`).
- **Platinum (3 — engineering):** `strict-typing`, `async-dependency`, `inject-websession`.
- **Off-scale labels:** `no score`, `internal` (building blocks), `legacy` (YAML-only, maybe unowned), `custom` (not shipped by HA), `virtual`.

**Enforcement (verified in `validate_iqs_file`):** each integration carries `quality_scale.yaml` where every rule is `done`, `todo`, or `exempt` **with a mandatory comment** (sample: `overkiz/quality_scale.yaml` — `docs-conditions: {status: exempt, comment: "This integration does not have any conditions."}`). hassfest fails CI if the manifest claims a tier whose rules (and all lower tiers') are not all `done`/`exempt`. Eight rules also have **code-level validators** that inspect the source (`script/hassfest/quality_scale_validation/`: `config_flow`, `discovery`, `reconfiguration_flow`, `runtime_data`, `strict_typing`, `test_before_setup`, `unique_config_entry`); the rest are reviewer-judged. Error text: "New integrations are required to at least reach the Bronze tier."

**Honest grandfathering.** The same file hard-codes three allow-lists: `INTEGRATIONS_WITHOUT_QUALITY_SCALE_FILE` (910 entries today), `INTEGRATIONS_WITHOUT_SCALE` (955), `NO_QUALITY_SCALE` (77 internal). hassfest errors if a listed integration *gains* a file ("please remove from the list") — so the debt list can only shrink. Six years after the scale was introduced, most of core is still ungraded. **Lesson: the scale works as a gate on new work and a ratchet on old work, not as a big-bang clean-up.**

**Shown to users:** in every monthly release post under "Integration quality scale" with 🏆/🥇/🥈 and the contributor's name (seen in 2026.9 notes) — i.e. it is also a *recognition* mechanism for volunteers. Tier can be downgraded (e.g. loses its code owner).

### 2.3 Home Assistant — setup, OAuth, re-auth, repairs

- **Config flow** (`config_flow.py`, class extends `ConfigFlow`): a small state machine of `async_step_<id>` methods — `user`, discovery steps (`zeroconf`, `dhcp`, …), `reauth`, `reconfigure`. Text and error messages live in `strings.json` under `config.step / error / abort`, so **error wording is reviewed and translated, not improvised**. Unique-ID rules stop the same account being added twice. "Integrations with a config flow require full test coverage of all code in `config_flow.py` to be accepted into core."
- **Shared OAuth2 helper** (`config_entry_oauth2_flow`, scaffold `config_flow_oauth2`): the integration author writes ~10 lines — `application_credentials.py` returning `AuthorizationServer(authorize_url, token_url)` — and gets the redirect handling, token storage on the config entry, PKCE option (`LocalOAuth2ImplementationWithPkce`), and **token refresh owned by HA, not the library** ("structure your Python API library in a way that allows Home Assistant to be responsible for refreshing tokens"). Two credential sources: the owner pastes their own client id/secret in the **Application Credentials** UI, or **Nabu Casa's cloud account-linking** holds a central client id/secret ("a seamless user experience"). The second is convenient but puts a vendor in the sign-in path — relevant to Lares's sovereignty rule.
- **Re-auth**: the integration raises `ConfigEntryAuthFailed`; HA stops the integration, shows "needs attention", and starts `async_step_reauth` → `reauth_confirm`. "On success, reauth flows are expected to update the current entry and abort; they should not create a new entry" (`async_update_reload_and_abort`). This is a Silver rule.
- **Repairs** (issue registry, `homeassistant.helpers.issue_registry`): `async_create_issue(domain, issue_id, is_fixable, is_persistent, severity=WARNING|ERROR|CRITICAL, breaks_in_ha_version, learn_more_url, translation_key, issue_domain)`. Fixable issues ship a `RepairsFlow` in `repairs.py` (a mini wizard: explain → confirm → fix, can hand off to the reconfigure flow). "Repair issues are also how a user-facing deprecation in an integration is announced, which is one of their most common uses." One inbox, plain language, a version number for when it will break, and a button.

### 2.4 Home Assistant — un-reviewed integrations (custom components + HACS)

- Mechanism: drop a folder in `config/custom_components/`; it runs **in the same process, with the same privileges as core**. Custom manifests must carry a `version`.
- Warnings the user sees: a log line on every start — `CUSTOM_WARNING`, "We found a custom integration %s which has not been tested by Home Assistant. This component might cause stability problems…" (`homeassistant/loader.py:155,711`).
- **Core keeps a blocklist of third-party code**: `BLOCKED_CUSTOM_INTEGRATIONS` (`loader.py:101`) — 8 entries added 2024–2025, each with the version below which the integration is refused and a reason: "breaks Home Assistant", "crashes Home Assistant", "prevents recorder from working", "breaks the template engine". That is the visible cost of in-process plugins: **strangers' code can take the whole product down, and the core team ends up policing it in core's source**.
- **HACS** is itself a custom integration (needs a GitHub account; not part of HA). Its "default list" checks are structural only — valid manifest, passes `hassfest` and the HACS action, has a release, has a description/topics/issues enabled, brand icon — **no security review**, and "new additions still take months to be reviewed" (hacs.xyz/docs/publish/include).
- **What went wrong:** January 2021 — a directory-traversal hole in HACS and three other custom integrations let an unauthenticated attacker read any file "including any credentials". Core shipped an emergency filter in 2021.1.5, Nabu Casa blocked affected cloud access, and the post had to add "Custom integrations are not created and/or maintained by Home Assistant. Users install them at their own risk" plus a reminder not to harass authors (home-assistant.io/blog/2021/01/23/security-disclosure2/).

### 2.5 n8n — nodes, credentials, request helper

- **Two building styles** (docs.n8n.io/connect/create-nodes/plan-your-node/choose-a-node-building-style): **declarative** — the node is data: each operation has a `routing` object (method, URL, body, response handling); no `execute()`; "simpler to write, with less risk of introducing bugs… more future-proof"; and **programmatic** — required only for triggers, non-REST APIs, or heavy transformation. "If your node isn't on this list, build it in the declarative style."
- **Credentials are separate, reusable types** (`packages/nodes-base/credentials/*.credentials.ts`, 410 registered): a class with `name`, `displayName`, `documentationUrl`, `properties` (the form), `authenticate` (a *declaration* of where the secret goes: `header: {Authorization: 'Bearer {{$credentials.token}}'}`, or `qs`, `body`, `auth`), and **`test`** — a request n8n fires when the owner presses Save, so a bad key is caught at setup. OAuth2 credentials `extends oAuth2Api` and only supply URLs and scopes. Secrets are encrypted at rest with an instance key. The generic HTTP Request node can reuse any credential type, so a missing node is never a dead end.
- **Shared request helper** — `this.helpers.httpRequestWithAuthentication.call(this, 'credentialType', options)`. In code (`packages/core/src/execution-engine/node-execution-context/utils/request-helpers/`): `authentication.ts`, `oauth.ts`, `pagination.ts`, `factory.ts`. `oauth.ts` refreshes on 401 (or a per-credential `tokenExpiredStatusCode`), refreshes slightly *before* stored expiry, takes a **cross-process refresh lock** so two workers do not both burn a single-use refresh token, persists the new token, and returns a plain-language failure: "Access could not be refreshed because the connected account has revoked access, the refresh token expired, or the account password or permissions changed. Open the credential and reconnect it to continue." (line 142). `pagination.ts` gives declarative pagination with `maxRequests` and a `continue` expression. Retry is a per-node setting in the engine, not per integration. **Every one of those is something Lares currently has 4 + 3 + 5 hand-written copies of.**
- **Places touched to add a built-in node:** the node folder (`X.node.ts`, `X.node.json` "codex" metadata, icon, optional `GenericFunctions.ts`, `__schema__/`, `test/`), one credentials file, and two lines in `packages/nodes-base/package.json` (`n8n.nodes`, `n8n.credentials` — 444 and 410 entries). So ~3 places. n8n now steers almost all new integrations to community packages instead of core.
- **Generator:** `npm create @n8n/node@latest` → `n8n-node new | dev (hot reload) | build | lint | release` (`packages/@n8n/node-cli`, templates for declarative/programmatic). The linter is the first gate for verification.
- **Testing expectation:** lighter than HA — lint + manual run; core nodes have unit tests and workflow-JSON fixtures. No equivalent of Lares's live-probe rule anywhere in HA or n8n; **Lares's "a fixture is what we believe; a live probe is what it does" is stricter than both** and worth keeping.

### 2.6 n8n — community nodes

- Distributed as **npm packages** named `n8n-nodes-*`, installed from the UI by owner/admin. They run **in the n8n process**: "community nodes have full access to the machine that n8n runs on, and can do anything, including malicious actions" and "any community node that you use has access to data in your workflows" (docs…/community-nodes/risks).
- **Verification programme** (…/reference/verification-guidelines): **no runtime dependencies at all**; "must not interact with environment variables or attempt to read/write files"; TypeScript; passes the n8n linter; **MIT licence**; English only; one service per package; no duplicates of existing nodes; and **must be published from a GitHub Action with npm provenance** (mandatory from 2026-05-01) so the package provably matches the repo. Verified nodes appear in the editor's node search; unverified need manual install. There is a **blocklist** for nodes that are "intentionally malicious" or "low quality (low enough to be harmful)".
- **Incident (press-sourced, Jan 2026):** at least eight malicious npm packages posing as n8n nodes (Google Ads, Stripe, Salesforce look-alikes); one reached ~3.5k weekly downloads; they presented a real-looking credential form and exfiltrated decrypted OAuth tokens at run time (thehackernews.com/2026/01/n8n-supply-chain-attack-abuses.html; csoonline.com/article/4115417; endorlabs.com "n8mare on auth street").
- **Reversal:** n8n 3.0 (scheduled October 2026) flips `N8N_UNVERIFIED_PACKAGES_ENABLED` from `true` to **`false`** by default (docs.n8n.io/changelog/v30-breaking-changes). After five years, the default for un-reviewed in-process code became "off".

### 2.7 Activepieces — where it differs

- A piece is one folder: `src/index.ts` (`createPiece()`), `src/lib/auth.ts`, `actions/` (one file each), `trigger/`, `common/`, `i18n/`. Auth is one of `PieceAuth.SecretText | OAuth2 | CustomAuth`, **all with a `validate` callback** (same idea as n8n's `test`). A shared `httpClient` from `@activepieces/pieces-common` with retries (and a documented trap: retries forced to 0 for stream bodies). CLI: `npm run create-piece | create-action | create-trigger`, plus one manual line in `tsconfig.base.json`. 733 community pieces + 27 core in-repo; each is versioned and published to npm, so an instance can update one piece without upgrading the platform.
- **Contributor guide written for coding agents:** `packages/pieces/CLAUDE.md` — a 1-page "how to build a piece" aimed at Claude/Cursor. Most new pieces are now written with AI help; they met contributors where they are.
- **Pieces as MCP — and the pivot.** The 2025 pitch was "every piece is an MCP server". Today's code/docs (`docs/mcp/overview.mdx`, `tools.mdx`, `tool-search.mdx`) show a different shape: one built-in MCP server per instance (OAuth, project-scoped, "credentials are never exposed… `ap_setup_guide` returns instructions for the user to configure connections in the UI, rather than handling secrets through MCP"), and instead of thousands of tools, **three meta-tools: `ap_search_actions` → `ap_get_piece_props` → `ap_run_action`** over a pgvector index of action descriptions, with per-action "AI metadata" and an `audience: 'human'` flag to hide actions from agents. Matches below a relevance threshold are dropped so "the agent can say so instead of running a wrong tool". Degrades to keyword search without an embedding key (semantic mode needs an OpenAI key — a US vendor in the path).
- **The reverse is supported:** `packages/pieces/community/mcp-client` — a piece that connects to any external MCP server (Streamable HTTP / HTTP / SSE; auth none / bearer / API key / custom headers) and calls its tools. n8n has the same (`MCP Client Tool` node + `MCP credentials`, and an "MCP registry server in one click" page).

### 2.8 Writes and approval

HA: no approval concept (automations act). n8n: **human-in-the-loop for agent tools** — tools that need approval are wired through a "human review" step; approval can arrive on a *different* channel than the conversation (Chat, Slack, Discord, Telegram, Teams, Gmail, WhatsApp, Google Chat, Outlook); the reviewer sees `$tool.name` and `$tool.parameters`; deny cancels the call; the docs tell you to explain denial handling in the system prompt; no documented timeout/escalation (docs.n8n.io/build/integrate-ai/ai-examples/human-in-the-loop-for-tools). Lares's approval cards + ratchet + always-ask are already ahead of this; nothing to borrow except "approval on a different channel than the chat".

---

## An integration framework for Lares, borrowed

Plain-language summary: **one folder + one manifest per integration; a checker that generates every other registration from the manifest; one shared "talk to the outside world" helper that owns sign-in, token refresh, retries and the allow-list; a three-step quality ladder whose bottom step is Lares's existing six-point checklist; and anything un-reviewed stays outside the engine as an MCP connection.**

### A. The manifest (`integrations/<id>/integration.json`)

| Field | Borrowed from | Purpose in Lares |
|---|---|---|
| `id`, `name`, `documentation` | HA `domain`/`name`/`documentation` | folder name = id |
| `owners` (GitHub handles) | HA `codeowners` → generated CODEOWNERS | who gets the issue; losing the owner drops the tier |
| `contracts`: e.g. `["mailbox","calendar"]` | HA entity platforms | which neutral Lares contract it implements — this is the missing "Google behind mailbox/calendar" seam |
| `data_path`: `self_hosted \| eu_cloud \| non_eu_cloud \| owner_chosen` + `region` | HA `iot_class` | one honest, user-visible label. HA makes cloud/local a first-class badge; Lares's equivalent is *where the data goes*. |
| `outbound_hosts`: `["api.notion.com"]` | HA `inject-websession` instinct; Lares checklist pt 3 | **the allow-list proxy config is generated from this** — documentation and enforcement become the same artefact |
| `auth`: `{type: oauth2\|api_key\|none, credential: "googleOAuth2", scopes: [...]}` | n8n credential types | credential types are shared (one Google sign-in, not five) |
| `secrets`: `["NOTION_TOKEN"]` | Lares checklist pt 4 | checker fails on any undeclared secret read |
| `sdk`: `{package, version, licence}` | HA `requirements` + `dependency-transparency` | official SDK pinned; licence must be AGPL-compatible; checker verifies |
| `capabilities`: `[{id:"mail.send", kind:"write", approval:"ask_first\|always_ask"}]` | none — Lares-specific | grants and the ratchet read this; neither HA nor n8n has it |
| `setup_flow: true`, `single_instance` | HA `config_flow`, `single_config_entry` | console wizard exists |
| `telemetry: "none"` | Lares checklist pt 5 | declared and grep-checked |
| `live_probe`: `tests/live/<api>.live.mts` | Lares rule | checker verifies the file exists and is named in the manifest |
| `tier`: `bronze\|silver\|gold` | HA `quality_scale` | must be backed by `quality.yaml` |

### B. The checker and the scaffold

- `pnpm lares:integration new` — asks the HA scaffold's questions (name, your handle, official SDK?, sign-in type, which contract, data path/region) and generates the folder, a setup-flow stub, a contract-test stub, a live-probe stub, `quality.yaml` with all rules `todo`.
- `pnpm lares:check` (the hassfest analogue, run in CI): validates the manifest schema; **generates** the registry, the capability catalogue, the proxy allow-list, the console's integration list and CODEOWNERS; fails if generated files are stale; validates `quality.yaml` (`done | todo | exempt + comment`) against the claimed tier. Keep a committed `INTEGRATIONS_WITHOUT_SCALE` list for today's Notion/Slack/Google code that may only shrink.
- Ship an `integrations/CLAUDE.md` like Activepieces's — Lares contributors will be using coding agents.

### C. Tiers, mapped to the six-point checklist

Keep **provenance** and **quality** as two separate axes (HA does: `custom/internal/legacy` vs bronze–platinum). Lares's "private → contributed → shipped" is provenance; it should not be confused with quality.

| Tier | Rules | Source |
|---|---|---|
| **Bronze = the six points + setup** (floor for anything shipped in the engine) | (1) live probe committed and named; (2) `data_path`/region declared; (3) `outbound_hosts` declared and enforced; (4) secrets by declaration; (5) no telemetry; (6) contract tests pass against the neutral default agent; **plus** set up from the console with no file editing (`config-flow`); credential tested at save (`test-before-configure`, n8n `test`); can't be added twice (`unique-config-entry`); uses the shared request helper, no hand-rolled fetch (`common-modules`); SDK transparency; docs: what it does / how to set up / how to remove | Lares checklist + HA Bronze |
| **Silver = survives real life** | re-auth flow when the token dies; named owner; "log once when down, once when back"; every `write` capability declares its approval class; rate limits/backoff honoured via helper; failed action raises a plain-language error; live probe re-run recorded per release | HA Silver |
| **Gold = best experience** | repairs for every owner-fixable failure; reconfigure without delete-and-re-add; redacted diagnostics download; known-limitations + troubleshooting docs; translations; push/webhook instead of polling where the vendor allows | HA Gold |

Skip Platinum; fold "strict typing" into Bronze (TypeScript makes it free). Publish tier + `data_path` badge in the console's integration picker and in release notes with the contributor's name.

### D. Shared credential + request helper (the n8n pattern)

- `packages/connect/credentials/<type>.ts`: form fields, `authenticate` declaration (where the secret goes), `test` request, and for OAuth2 just `authorizeUrl`, `tokenUrl`, `scopes`, PKCE flag.
- `request(ctx, credentialType, options)`: injects auth; refreshes before expiry and on 401; **single-flight refresh lock** (n8n had to add cross-process locking — refresh tokens are often single-use); pagination helper; retry with backoff; routes through the allow-list proxy; on unrecoverable auth failure throws a typed `AuthFailed` that the platform — not the integration — turns into a re-auth repair.
- **OAuth without a vendor in the path:** adopt HA's *Application Credentials* half (owner pastes their own client id/secret into the console; the console shows the exact redirect URL to register) and **not** the Nabu-Casa-style central account-linking. If managed hosting arrives later, a Lares-run EU linking service can be added as the convenient option, exactly as HA layers it.

### E. Setup flow, re-auth and repairs in the console

- Setup flow = small declared state machine per integration (`user` → `oauth`/`api_key` → `test` → `pick scope` → done), text in a strings file so wording is reviewed.
- One **Repairs inbox** in the console (and a one-line nudge to the owner's Slack/Telegram door): `createIssue({integration, id, severity, fixable, persistent, breaksInVersion, learnMoreUrl, textKey})`. Fixable issues open a mini-wizard (re-auth, re-pick calendar, approve new scope). Deprecations use the same inbox with `breaksInVersion`. Lares already has the beginnings (the Backup page's protected / unproven / not-protected states, LAR-54) — generalise that into the issue registry rather than building per-page alarms.

### F. Un-reviewed integrations: does HA/n8n experience support "MCP outside the engine"?

**Yes — strongly, and it is the single clearest lesson in this report.** Both projects let strangers' code run in-process, and both paid for it: HA carries a hard-coded blocklist of third-party integrations that "crash Home Assistant" and had a credential-leaking hole via HACS-distributed code in 2021; n8n documents that community nodes "can do anything", suffered token-stealing look-alike packages in January 2026, and is flipping unverified packages to off-by-default in 3.0. n8n's verification rules (no dependencies, no env, no filesystem) are an attempt to get by policy what a process boundary gives for free. An MCP connection is out-of-process, reaches Lares only through declared tools, never sees Lares's credential store, and sits behind the same allow-list proxy and approval cards. Both n8n and Activepieces already ship an MCP *client* as the escape hatch.

Caveats from their experience: (1) an MCP server still sees whatever the agent sends it and returns untrusted text — treat results as untrusted content and keep writes behind approval; (2) Activepieces's pivot from "one tool per action" to **search → inspect → run** shows tool lists don't scale — cap/scope tools per MCP connection via grants; (3) show a HA-style plain warning when adding one ("not reviewed by Lares; it will see what the agent sends it") and label `data_path` as unknown; (4) keep a generic "HTTP request with a saved credential" tool as n8n does, so a missing integration is never a dead end.

---

## 3. FIRST RUN (deep)

### Home Assistant
- **Path:** flash HA OS to an SD card with Raspberry Pi Imager (or buy a Green/Yellow box) → plug in Ethernet + power → open `homeassistant.local:8123`. "On a Raspberry Pi 4 or 5, this page should be available within a minute"; if not within 5 minutes, reflash. Then "Preparing Home Assistant" downloads ~700 MB. Realistically 15–25 minutes, no terminal, no keys, no accounts, no public URL.
- **Onboarding wizard (4 questions):** (1) **"Create my smart home" OR "Restore from backup"** — restore is on the very first screen; (2) owner name/username/password; (3) home location → sets timezone, units, currency in one step; (4) analytics — "Sharing is disabled by default", four separate toggles; Finish → a dashboard that already shows auto-discovered devices (discovery matchers in manifests make this work; the onboarding doc page itself does not mention it — from prior knowledge, unverified today).
- **Validation/errors:** each integration tests its connection inside the setup flow; errors come from reviewed `strings.json`; later failures land in Repairs.
- **Install methods cut (May 2025 post):** *Core* (Python venv) and *Supervised* (your own Linux + supervisor) deprecated, plus 32-bit architectures; six months' notice, unsupported from 2025.12; only **HA OS** and **Container** remain. Reasoning, quoted: "These are advanced installation methods, with only a small percentage of the community opting to use them" — 2.5% and 3.3% of installs per opt-in analytics — and they created a disproportionate support burden. Users were told **through a repair notification** in 2025.6. "Unsupported" = still runs, but "issue reports will no longer be accepted". ADRs 0012–0016 define each supported method precisely.

### n8n
- `curl -fsSL https://get.n8n.io | sh` — needs Docker + Compose v2; creates `./n8n/` with `compose.yml` and `.env` with **generated secrets**, SQLite, waits until healthy and only then prints `http://localhost:5678`; idempotent ("safe to run more than once"). Or the classic `docker run … n8nio/n8n`. Then an owner-account screen (unverified today), then an empty canvas/templates. ~5 minutes to first workflow on localhost. A public URL is needed only for webhooks/OAuth callbacks — which is where most self-hosters actually get stuck.
- The docs say it bluntly: "n8n recommends self-hosting for expert users. Mistakes can lead to data loss, security issues, and downtime" — and push everyone else to Cloud.
- n8n 3.0 stops publishing a runnable npm package; Docker becomes the only real path (same consolidation HA did).

### Activepieces
Docker Compose with Postgres + Redis; sign-up screen; not examined further.

---

## A first-run and release discipline for Lares, borrowed

**Onboarding**
1. **Exactly one supported install** for launch (one command on fresh Ubuntu → Docker Compose, images by digest). Write an ADR that says so, HA-style. Everything else is "community-supported, no issues accepted". HA and n8n both *ended up* here after years of supporting more.
2. Installer behaves like n8n's: checks prerequisites first, **generates every secret**, is safe to re-run, waits for health, prints one URL. The 69 settings become: generated (secrets), derived (from one "where are you?" question, as HA derives timezone/units/currency from location), or defaulted. Target ≤ 5 questions before first conversation; everything else later via the console.
3. **Screen one: "Start fresh" or "Restore from a backup".** Lares already has the backup/restore-drill work (LAR-54) — put restore at the front door; it is also the migration path between servers.
4. Gateway mandatory is fine if the wizard asks for *one* model key and tests it on the spot (n8n `test`, HA `test-before-configure`). Every wizard step ends with a live check and a reviewed plain-language error.
5. First door: a built-in web chat at the URL the installer prints, so first conversation needs no Slack/Telegram app. Slack/Telegram then become the first two "integrations" added through the new setup flow — dog-fooding it.
6. Show `data_path` badges in the integration picker from day one.

**Releases**
- **Predictable cadence** with a **beta window** (HA: first Wednesday monthly, beta the week before; CalVer `YYYY.M.patch`). For a solo maintainer, monthly + one-week beta on the owner's own box is realistic; CalVer tells owners at a glance how stale they are.
- **Automatic backup before every update** and one-click rollback (HA) — combine with pull-by-digest.
- **Release notes format (HA's, in order):** headline features → new integrations (with contributor and tier) → tier promotions → noteworthy changes → **"Backward-incompatible changes"** as one collapsible entry per integration: what changed, what to do, PR link → full changelog link → separate developer blog for API changes.
- **Deprecation policy (ADR-0021):** minimum six months; automatic migration is *required* where possible; if migration fails, raise a repair that says what happened and what to do. Every deprecation appears in Repairs with `breaksInVersion`.
- **Pre-upgrade report (n8n):** `packages/cli/src/modules/breaking-changes/` — one small rule class per breaking change scans *this instance* and produces **Settings → Migration Report** ("these 3 workflows use a removed node"). For Lares: "these agents hold grant X that is renamed; this overlay sets a removed compose value."
- **ADRs**: HA's public ADR repo has only 22 records; they are short and define *what is supported*. Lares's `docs/decisions/` already does this — publish it with the repo.

---

## 4. DEFINING AN AGENT — n/a (one striking note)

Both added agent features on top of the integration base rather than beside it. HA: an `llm.py` platform per integration contributes tools (`async_get_tools`, evaluated per request with an `LLMContext`), the owner chooses which entities are *exposed* to assistants, tool names now require a domain prefix (2026.9 notes), and the whole tool set is re-exported through HA's MCP Server integration. n8n: AI Agent node with tool sub-nodes, MCP client/server nodes, HITL step. Takeaway: **an integration's actions should be declared once and surface three ways — as agent tools, as console actions, and (optionally) over MCP — with exposure controlled by the owner per agent.** Lares's grants already do the last part.

## 5. MORE THAN ONE PERSON (brief)
HA: owner + admin + user roles, per-user dashboards, per-person device tracking; permissions are coarse and long-criticised. n8n: owner/admin/member, projects, credential *sharing* (a credential can be used in a workflow without revealing the secret) — that "use without reveal" idea fits Lares's org-scoped credentials. Fine-grained RBAC, SSO and per-user "dynamic credentials" are `.ee` (paid).

## 6. SAFETY (brief)
HA: no sandbox for integrations; trust through review + dependency-transparency + blocklist. n8n: task runners isolate *user code* (Code node) but not community nodes; SSRF block-lists for outbound requests (3.0 widens them to 100.64.0.0/10 — note: that is the Tailscale address range Lares uses to reach its box; irrelevant unless Lares copies the list); credentials encrypted with an instance key; HITL for tools. Neither has Lares's sealed egress; Lares is ahead. Borrow: the manifest-declared hosts feeding the proxy (so it stays ahead without hand maintenance).

## 7. COST AND VISIBILITY (brief)
HA: no spend concept; failure visibility = Repairs + "needs attention" badges + per-integration **diagnostics download** (redacted JSON for bug reports — a Gold rule; very effective for volunteer support). n8n: execution log per workflow with per-node input/output, OpenTelemetry export, error workflows; no spend caps (LLM cost is the provider's problem). Borrow diagnostics download.

## 8. COMMUNITY (deep)

- **HA contribution flow:** PR to `core` for code + PR to `home-assistant.io` for docs + PR to `brands` for the logo; bot assigns codeowners from the manifest; hassfest + tests gate; new integrations must be Bronze; one platform per initial PR to keep reviews small (from prior knowledge, unverified today). Codeowners per integration is the scaling trick: ~1,300+ integrations cannot be maintained by a core team; the manifest makes ownership explicit and Silver requires it.
- **Docs split:** user docs (home-assistant.io — one page per integration with a fixed skeleton: description, prerequisites, setup, options, supported devices, known limitations, troubleshooting, removal) vs developer docs (developers.home-assistant.io) vs developer blog for API deprecations. The quality scale's 15 `docs-*` rules are what force the user page to exist.
- **Stating what works:** the tier + `iot_class` + "known limitations" section, all mandated by rules. n8n/Activepieces have nothing comparable; verified/unverified is their only signal.
- **Privacy posture (HA analytics):** opt-in, asked once in onboarding, off by default, four levels (basic: uuid/version/install type/country; usage: **names and versions of integrations, including custom ones**; statistics: counts; diagnostics: crash reports to Sentry). Sent 15 min after start then daily; "The exact data that is sent is also printed to your log"; aggregate public at analytics.home-assistant.io; stored "in Cloudflare's Key-Value store for a maximum of 60 days". It is what let them *justify* cutting install methods with numbers (2.5% / 3.3%). **n8n is the opposite:** "n8n enables telemetry collection by default" on self-hosted, opt-out by env var, pulse every 6 hours.
  - For Lares ("nothing phones home"): keep the rule. HA proves opt-in can be done honestly, but its pipeline sits on US infrastructure (Cloudflare, Sentry) and Lares's promise is simpler to say and to verify. Cheaper substitutes: GitHub reactions/issues per integration, release-feed download counts (the update check "sends nothing" but the feed host still sees a fetch — say so plainly in the docs), and an optional "copy my anonymous setup summary" button the owner pastes into an issue by hand.
- **Governance/sustainability:** HA and sister projects are owned by the **Open Home Foundation**, a Swiss non-profit *Stiftung* (chosen for rule of law, privacy, independence); projects were transferred to it in 2024; "Funding and support flow in a single direction: from partners to the Open Home Foundation"; commercial partners (Nabu Casa, Apollo Automation) are "contractually required to contribute a majority of its profit from selling licensed products". Nabu Casa's paid cloud (remote access, voice, backups storage, OAuth account-linking) funds the full-time developers. The paid product sells *convenience around* the self-hosted core and never gates local features — the right template for "Lares managed hosting later".
- **Licence effects:** HA Apache-2.0 — no CLA friction, vendors contribute their own integrations, thousands of contributors. Activepieces MIT + `ee` folders — 733 community pieces in three years, each an npm package. n8n Sustainable Use License — "You may use or modify the software only for your own internal business purposes"; not OSI open source; the community is huge *as users* (205k stars) but node contributions were pushed out to MIT-licensed npm packages, and n8n **requires MIT for verified nodes** — a copyleft-or-restricted core with permissive plugins. For Lares: AGPL-3.0 core is compatible with importing Apache-2.0/MIT ideas and code from HA/Activepieces; **n8n code must not be copied** (licence is not AGPL-compatible); consider stating that integrations/manifests contributed to Lares are accepted under a permissive inbound licence or the light contributor agreement already planned, and keep the contributor agreement light — HA's scale came partly from having none of that friction.
- **Release cadence:** HA monthly + beta week + patches; n8n weekly minors with very frequent patches (2.39.8 today) and a yearly major with a long-lead breaking-changes page; Activepieces roughly weekly/biweekly.

---

## Patterns worth stealing

1. **Manifest → generated registries** — HA `script/hassfest/*`, `homeassistant/generated/*`. Cures "6+ places".
2. **Scaffold that asks the five questions** — HA `script/scaffold/gather_info.py`; n8n `npm create @n8n/node`.
3. **Tier file with `done / todo / exempt + comment`, CI-enforced, floor for new work, shrinking grandfather lists** — `script/hassfest/quality_scale.py`.
4. **`iot_class`-style honesty label** — for Lares: `data_path` + region.
5. **Credential types as declarations with a `test` request** — n8n `packages/nodes-base/credentials/`, Activepieces `PieceAuth.*({validate})`.
6. **One request helper owning auth injection, refresh-before-expiry, refresh lock, pagination, plain-language auth error** — n8n `…/request-helpers/oauth.ts`, `pagination.ts`.
7. **Platform-owned re-auth** — HA `ConfigEntryAuthFailed` → `async_step_reauth`, update entry in place.
8. **Repairs / issue registry with `breaks_in_ha_version` and fix flows** — HA `helpers/issue_registry`, `repairs.py`.
9. **Application Credentials (owner brings own OAuth client)** — HA `application_credentials.py`; no vendor in the sign-in path.
10. **Dependency transparency** — public CI build, tagged release, OSI licence; n8n's npm-provenance requirement is the JS equivalent.
11. **Restore on onboarding screen one; auto-backup before update** — HA onboarding + release FAQ.
12. **Idempotent one-line installer that generates secrets and waits for health** — n8n `get.n8n.io`.
13. **Per-instance pre-upgrade Migration Report** — n8n `packages/cli/src/modules/breaking-changes/`.
14. **Release notes with a fixed "Backward-incompatible changes" block and contributor credit per tier promotion** — HA 2026.9 post.
15. **Search → inspect → run instead of one tool per action; `audience: 'human'` flag** — Activepieces `docs/mcp/tool-search.mdx`.
16. **`CLAUDE.md` inside the integrations folder** — Activepieces `packages/pieces/CLAUDE.md`.
17. **Diagnostics download** (redacted) — HA Gold rule `diagnostics`.
18. **Approval may travel on a different channel than the chat** — n8n HITL doc.

## Traps they hit

- **In-process third-party code:** HA's `BLOCKED_CUSTOM_INTEGRATIONS` (8 entries, "crashes Home Assistant"…), the Jan-2021 HACS credential-leak disclosure; n8n's "can do anything" warning, Jan-2026 token-stealing packages, and the 3.0 flip of unverified packages to off.
- **Review queues don't scale on volunteers:** HACS default-list additions "still take months"; HA's 910-entry ungraded list after ~6 years.
- **Too many install methods:** HA cut Core/Supervised/32-bit (5.8% of users, disproportionate support); n8n 3.0 drops the runnable npm package.
- **Opt-out telemetry in a self-hosted product** (n8n) is a standing reputational cost; HA's opt-in still depends on US services.
- **Central OAuth account-linking** (Nabu Casa) is the smoothest UX but makes a company part of every sign-in.
- **n8n's licence** capped code contribution to core and forced a split ecosystem (restricted core, MIT plugins).
- **Tool explosion:** Activepieces moved away from "every action is an MCP tool".
- **Retries replaying drained streams** — Activepieces `httpClient` forces retries to 0 for stream bodies; a shared helper must know this.
- **Single-use refresh tokens + multiple workers** — n8n had to add a cross-process refresh lock.

## Verdicts for Lares

| Idea | Verdict | Why |
|---|---|---|
| One folder + `integration.json` manifest; checker generates all registrations | **Adopt** | Direct fix for "6+ places"; pure build-time, runs on owner's server, no licence issue (idea, not code) |
| Scaffold command | **Adopt** | Cheap; makes the first contribution possible; pair with `integrations/CLAUDE.md` |
| Quality tiers with `quality.yaml` (done/todo/exempt+comment), CI-enforced, Bronze floor, shrinking grandfather list | **Adopt** (3 tiers, not 4) | Lares's six points become Bronze; separates quality from provenance |
| `data_path`/region badge (from `iot_class`) | **Adopt** | Sovereignty made visible; unique to Lares's pitch |
| `outbound_hosts` in manifest → generated proxy allow-list | **Adopt** | Turns a documentation rule into enforcement; neither source has it |
| Shared credential types with `test` + shared request helper (refresh, lock, pagination, retry) | **Adopt** (re-implement; do NOT copy n8n code — licence) | Collapses 4 Notion / 3 Slack / 5 Google paths; Activepieces's MIT `httpClient` can be read for reference |
| API client in a separate library | **Adapt** | Lares's version: "official SDK first, pinned, licence-checked; hand-written HTTP only through the helper" |
| Application Credentials (owner's own OAuth client) | **Adopt** | No third party in sign-in path |
| Central cloud account-linking | **Ignore for now** / adapt later for managed hosting in EU | Breaks "no vendor in the data path" for self-hosters |
| Platform-owned re-auth + Repairs inbox with fix flows and `breaksInVersion` | **Adopt** | Generalises the LAR-54 backup alarm pattern; the right UX for a non-developer owner |
| In-process community plugins (HACS / n8n community nodes) | **Ignore** | Both sources' worst incidents; Lares's "MCP connections outside the engine" is supported by their experience |
| MCP client for user-added tools, with warning, scoped tools, approval on writes | **Adopt** (already planned) | n8n and Activepieces both converged on it as the escape hatch |
| Expose Lares integrations as an MCP server | **Adapt / later** | Useful, but use search→inspect→run, not one tool per action |
| Generic "HTTP request with saved credential" tool | **Adapt** | Prevents dead ends; must stay behind allow-list + approval |
| Restore-from-backup on onboarding screen one; auto-backup before update | **Adopt** | Builds on LAR-54 |
| Single supported install method, stated in an ADR | **Adopt** | Both sources retreated to this |
| Idempotent installer that generates secrets, waits for health, prints one URL | **Adopt** | Replaces most of the 69 settings |
| Monthly CalVer release + beta week + fixed "Backward-incompatible changes" block | **Adapt** | Cadence sized for a solo maintainer |
| Six-month deprecation with mandatory migration + repair | **Adapt** | Note: contradicts the owner's personal "no migration code" preference — that holds while Lares has one installation and ends the day strangers install it |
| Per-instance Migration Report before major upgrades | **Adapt / later** | Valuable once overlays exist in the wild |
| Opt-in analytics (HA style) | **Ignore** | "Nothing phones home" is simpler and verifiable; HA's pipeline is on US infra. Use public, passive signals instead |
| Opt-out telemetry (n8n style) | **Ignore** | Violates Lares's rule |
| Foundation ownership | **Ignore now** | Premature; note Swiss *Stiftung* + one-way funding as the long-term model |
| Paid convenience around a fully-functional self-hosted core (Nabu Casa) | **Adopt as principle** | Template for managed hosting without gating local features |
| n8n Sustainable Use / fair-code licence | **Ignore** | AGPL-3.0 is real open source; n8n's choice split its ecosystem |
| Permissive licence required for contributed integrations (n8n requires MIT for nodes) | **Adapt** | Consider permissive inbound for `integrations/` so vendors can contribute without AGPL worries — needs a legal decision |
| Diagnostics download (redacted) | **Adopt (Gold rule)** | Lets a non-developer file a useful bug report |
| HITL approval on a different channel than the chat | **Adapt** | Small extension of existing approval cards |

## Contradictions with what Lares does or plans

1. **The "adapter ladder" mixes two things.** HA keeps *where code lives* (core / custom) separate from *how good it is* (bronze–platinum). Lares's private → contributed → shipped is provenance only; the six-point checklist is a quality floor. Split them.
2. **"No migration code / change everything at once"** stops being true at open-source launch. HA's rule — deprecate ≥ 6 months, migrate automatically, raise a repair — is the price of having strangers' installations.
3. **Overlay rule vs integrations.** "An overlay may add files under `agents/<name>/` and set compose values. Nothing else" means a private integration has no home except MCP. That is consistent with the evidence here — but it should be *said* explicitly, because contributors will otherwise expect a `custom_components/` equivalent.
4. **Build-time tool resolution** (until ADR-0015 lands) conflicts with UI-driven setup flows: HA/n8n add an integration at run time with no rebuild. The setup-flow/repairs pattern presumes runtime-resolved definitions.
5. **69 settings and a 10-step wizard** vs HA's 4 questions and n8n's zero. The designed wizard is likely twice too long.
6. **Live probes are stricter than either source** — keep them; nobody else verifies fixtures against reality, and it is a differentiator worth stating in CONTRIBUTING.
