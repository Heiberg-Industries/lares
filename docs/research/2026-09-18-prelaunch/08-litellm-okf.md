# 08 — LiteLLM (gateway) and Google's Open Knowledge Format (memory format)

Research date 2026-09-18, Linear LAR-71. Read-only. Two infrastructure dependencies, so only the questions named in the task are answered; the rest are "n/a".

---

## CORRECTION 2026-09-21 (W8F-F7c) — two facts in this file were wrong, checked live against GHCR

Read from the registry by hand while choosing the gateway's base image (manifest HEAD for the
digests, then each image's own config blob for its `User`). Both errors would have cost the
reader something real, so they are corrected here rather than only in a commit message.

1. **The `-non_root` build is a SEPARATE REPOSITORY, not a tag suffix.** "Minimal config" below
   said `ghcr.io/berriai/litellm:<version>@sha256:… (or the -non_root variant)`, which reads as
   a tag: `ghcr.io/berriai/litellm:v1.101.0-non_root` is a **404**. It is
   `ghcr.io/berriai/litellm-non_root:<version>`. Anyone pinning what that line implied would
   have pinned nothing.
2. **v1.102.0 is a released stable tag**, not the `v1.102.0-rc.2` pre-release the Header records
   (it shipped between 2026-09-18 and 2026-09-21).

Digests read on 2026-09-21, recorded so the next reader does not have to fetch them again:

| image | digest |
|---|---|
| `ghcr.io/berriai/litellm:v1.101.0` | `sha256:d295634e09c648dcdb72c4cc2dd226f5fb87823a73e88cbbed6f205e4deb044b` |
| `ghcr.io/berriai/litellm-non_root:v1.101.0` | `sha256:633ae8495a5146fef15298a9d4eadb7ff2634b2218274c2666d2d77d11ace30b` |
| `ghcr.io/berriai/litellm-non_root:v1.102.0` | `sha256:0fc63424aab32e62185948b7a59180c8ab483cc3e706fcfdf7bf46262297247f` |

And the fact that decided the variant, also read from the config blobs: the default image is
`User: "root"`; `-non_root` is `User: "65534"` — a uid with no gid, so gid 0. Lares's secrets are
`0440 root:$LARES_RUNTIME_GID`, and compose's file-secrets are bind mounts that keep the host's
owner and mode (the long-syntax `uid`/`gid`/`mode` keys are swarm-only), so **the `-non_root`
image cannot read this installation's credentials** without a `user:` override naming the
runtime gid. The verdict table's "non-root image — adopt" is therefore not free; it is
conditional on that override, which the stack does not set today.

## Header

### Source A — LiteLLM
- Repo: https://github.com/BerriAI/litellm — docs https://docs.litellm.ai
- Default branch `main`, commit `0bd8b7fe`, 2026-09-18. Stars 59,080. Open issues+PRs 5,235.
- Latest stable release **v1.101.0** (2026-09-15). Pre-releases: v1.102.0-rc.2 (2026-09-16), v1.103.0-dev.2 (2026-09-18). Cadence: several tags per week.
- Licence: **MIT, except everything under `enterprise/`** which is under the "BerriAI Enterprise license" (`LICENSE`, `enterprise/LICENSE.md`). GitHub reports `NOASSERTION` because of the split.
- Read in code: `litellm/cost_calculator.py`, `litellm/litellm_core_utils/litellm_logging.py`, `litellm/exceptions.py`, `litellm/proxy/auth/auth_exception_handler.py`, `litellm/proxy/management_endpoints/key_management_endpoints.py`, `enterprise/litellm_enterprise/proxy/auth/route_checks.py`, `litellm/llms/anthropic/experimental_pass_through/messages/transformation.py`, `Dockerfile`, `docker-compose.yml`, `security.md`, `model_prices_and_context_window.json` (4,307 entries), the GitHub security-advisories list, and issues #35691, #38176, #40050, #41424, #27954.
- Read in docs: proxy/users, proxy/virtual_keys, proxy/custom_pricing, proxy/prod, proxy/deploy, proxy/reliability, anthropic_unified, completion/prompt_caching, data_security, enterprise, blog/security-update-march-2026.
- **Unverified**: real idle memory of the proxy on a quiet single-user box (no measurement was run — rules forbid it); startup time (only the compose healthcheck `start_period: 40s` as a hint); whether fix #40572 is in v1.101.0 or only in 1.102+; Mistral prompt-caching support via LiteLLM (not in LiteLLM's supported list).

### Source B — Open Knowledge Format (OKF)
- Repo: https://github.com/GoogleCloudPlatform/open-knowledge-format — created **2026-08-11**, commit `ad30107c` (2026-08-21, the last commit). **6 commits total, one committer (Amir Hormati, Google).** No releases/tags. Stars 507, forks 35, 20 open issues/PRs.
- Spec history lives in the earlier home, https://github.com/GoogleCloudPlatform/knowledge-catalog (`okf/`, 9.2k stars): v0.1 imported 2026-06-12 (`ee67a5c`), **v0.2 on 2026-07-24** (`780fe9d`, PR #227), timestamps tightened 2026-08-21 (`62432a0`), then "point readers at the dedicated OKF repository" (`6265173`).
- Announcement: Google Cloud blog "How the Open Knowledge Format can improve data sharing" (https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/), 2026-06-12 per Search Engine Journal. (Blog body not fetched — date is second-hand.)
- Licence: **Apache-2.0** for spec and tooling (`LICENSE.md`, headers in every source file). Google CLA required for contributions.
- Read fully: `SPEC.md` (1,006 lines), `README.md`, `CONTRIBUTING.md`, `src/reference_agent/tools/bundle_tools.py`, `bundle/index.py`, `bundle/document.py`, `prompts/reference_instruction.md`, `connectors/gcp-knowledge-catalog.md`, `pyproject.toml`, all 29 issues/PRs (titles + who commented), and Lares's own `services/atlas/lib/okf.ts` for comparison.

---

# SOURCE A — LiteLLM

## Q1 Memory, Q2 Integrations, Q4 Defining an agent, Q5 More than one person
n/a — LiteLLM is a model gateway, not an agent project. (It has users/teams/orgs, covered under Q7 only as budget scopes.)

## Q3 First run

**Is a database required? Yes, for everything Lares wants from it.** Docs (proxy/users, proxy/deploy): "Budgets require a PostgreSQL database… Without a database, budgets are unavailable; `max_budget` fails open rather than blocking requests. Virtual keys cannot be resolved without database access, returning error: 'No connected db.'" Without a DB the only credential is the master key. So the smallest viable deployment for Lares = **one LiteLLM container + Postgres** (Lares already runs Postgres; LiteLLM wants its own database/schema and runs `prisma migrate deploy` on startup — `DISABLE_SCHEMA_UPDATE=true` to stop that).

**Redis is "optional" but see the trap below**: without Redis, until the fix merged 2026-09-12 (#40572), a cold spend counter was seeded twice and the key hit its cap at half the real spend (#40050; maintainer: "I would recommend deploying with Redis though for production deployments").

**Minimal config** (from repo `docker-compose.yml` + docs):
```yaml
# compose: image ghcr.io/berriai/litellm:<version>@sha256:…
#   (the non-root build is a SEPARATE repository — ghcr.io/berriai/litellm-non_root:<version>
#    — not a tag suffix; see the CORRECTION at the top of this file)
# env: LITELLM_MASTER_KEY=sk-…  LITELLM_SALT_KEY=…  DATABASE_URL=postgresql://…
#      LITELLM_MODE=PRODUCTION  LITELLM_LOG=ERROR  LITELLM_LOCAL_MODEL_COST_MAP=True
model_list:
  - model_name: lares-brain
    litellm_params: { model: anthropic/claude-sonnet-…, api_key: os.environ/ANTHROPIC_API_KEY }
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL
  allow_client_side_credentials: false     # see Q6, CVE-2026-84377
  disable_error_logs: true                 # see Q6, CVE-2026-42208 workaround + less DB churn
litellm_settings:
  max_budget: 10          # whole-installation cap
  budget_duration: 1d
```
- `LITELLM_SALT_KEY` encrypts provider keys stored in the DB; "Do not change it after adding a model… changing it makes them unreadable" (proxy/prod). If Lares keeps models in `config.yaml` (not `STORE_MODEL_IN_DB`), provider keys never enter the DB and the salt key matters less — simpler for an installer.
- Health: `/health/liveliness`, `/health/readiness`.

**Footprint — this is the problem.** proxy/prod: "Give each pod **1 vCPU and 4Gi of memory**, as both requests and limits… **4Gi is a floor rather than a target**", because the bundled Prisma query engine's resident memory "reflects the largest write a pod has ever done". They also recommend `--max_requests_before_restart 10000` "to bound memory growth". Field reports: ~1.5 GiB per container in normal use creeping to 3.5 GiB after 12 h on v1.87 (#27954, open, 11 comments; one user says fine again on 1.94); older 60-comment thread #12685 "Heavy RAM usage over time". The runtime image also ships Node (for the Prisma CLI) and a pgbouncer binary (`Dockerfile:128-130`). On Lares's 8 GB reference box with agents peaking at 3 GB, a component whose vendor says "4 GiB floor" does not fit comfortably next to Postgres. Real idle use on a one-person box is probably far lower (hundreds of MB) — **unverified, must be measured with a live probe before the installer promises 8 GB**. Mitigations: `--num_workers 1`, a compose `mem_limit` of ~1.5 GB plus `--max_requests_before_restart`, do not store prompts in spend logs, `disable_error_logs`.

**Startup**: unverified; the project's own compose gives the healthcheck a 40 s `start_period`, and Prisma migrations run on every boot.

## Q6 Safety — the proxy's security record

**Supply chain, 24 March 2026** (LiteLLM blog security-update-march-2026; Datadog, Snyk, Upwind write-ups): attacker group "TeamPCP" stole LiteLLM's PyPI publishing credentials via a prior compromise of **Trivy**, the security scanner in LiteLLM's CI. Malicious **PyPI versions 1.82.7 and 1.82.8** were live from 10:39 UTC for roughly 40 minutes (tens of thousands of downloads). 1.82.8 shipped a `litellm_init.pth` that runs on every Python start: credential harvesting, Kubernetes lateral movement, a persistent systemd backdoor. IoCs: `models.litellm[.]cloud`, `checkmarx[.]zone`. **The official Docker image was not affected** ("pins dependencies in requirements.txt and does not rely on the compromised PyPI packages"). Afterwards: new "CI/CD v2" pipeline with isolated environments, rotated maintainers, SHA-256 checksums for v1.78.0–1.82.6, clean v1.83.0 on 2026-03-30, and **all images signed with cosign from v1.83.0** — verify against the key pinned by commit hash (`README.md:573-579`):
`cosign verify --key https://raw.githubusercontent.com/BerriAI/litellm/0112e53046018d726492c814b3644b7d376029d0/cosign.pub ghcr.io/berriai/litellm:<tag>`

**CVEs — 14 published advisories between 2026-04-03 and 2026-08-26, three critical** (`gh api repos/BerriAI/litellm/security-advisories`):

| ID | Sev | What | Fixed in |
|---|---|---|---|
| CVE-2026-42208 | critical | **Pre-auth SQL injection in API-key verification** — crafted `Authorization` header on any LLM route reaches the DB. Workaround `disable_error_logs: true` | 1.83.7 |
| CVE-2026-49468 | critical | **Auth bypass via Host header** on management routes (blocked by any reverse proxy that pins `server_name`) | 1.84.0 |
| CVE-2026-35030 | critical | Auth bypass via OIDC userinfo cache-key collision | 1.83.0 |
| CVE-2026-84377 | medium | **Any holder of a virtual key can pass `api_base`/`base_url`/`fallbacks` in the request body and make the proxy send its stored provider key to an attacker's server** (SSRF + credential exfiltration). Workaround `allow_client_side_credentials: false` | 1.96.2 (+backports to 1.88.x) |
| CVE-2026-59823 | medium | SSRF via `user_config` request parameter | 1.83.9 |
| CVE-2026-35029 | high | Privilege escalation via unrestricted config endpoint | 1.83.0 |
| GHSA-69x8-hrgq-fjj8 | high | Password-hash exposure / pass-the-hash | 1.83.0 |
| CVE-2026-42271, -59822 | high | MCP stdio command execution; MCP OAuth bypass | 1.83.7 / 1.84.0 |
| CVE-2026-42203 | high | Template injection in `/prompts/test` | 1.83.7 |
| CVE-2026-40217, -59821, -59820, -59819 | med/low | Custom-code guardrail sandbox escape; Skills archive path traversal; OIDC file read | 1.83.7–1.84.0 |

Why CVE-2026-84377 matters to Lares specifically: a prompt-injected agent holds a virtual key. Before 1.96.2 that was enough to steal the owner's Anthropic key. **Minimum safe version today: ≥ 1.96.2 (or a patched 1.88–1.95 line).**

**Hardening LiteLLM recommends / Lares should apply**
- Pin by digest (Lares does) **and verify the cosign signature in CI** before recording the digest.
- Use the non-root image variant; `readOnlyRootFilesystem` is supported if four paths are writable (`LITELLM_MIGRATION_DIR`, `LITELLM_UI_PATH`, `LITELLM_ASSETS_PATH`, `PRISMA_BINARY_CACHE_DIR`) — proxy/prod.
- Master key in env only, must start with `sk-`, never handed to agents; `LITELLM_SALT_KEY` set once; `LITELLM_MODE=PRODUCTION` (stops `.env` auto-load).
- `DISABLE_ADMIN_UI=True` is OSS (`litellm/proxy/common_utils/admin_ui_utils.py`). **`DISABLE_ADMIN_ENDPOINTS` and `DISABLE_LLM_API_ENDPOINTS` are Enterprise** (`enterprise/litellm_enterprise/proxy/auth/route_checks.py:16-39`) — so Lares cannot split "admin plane" from "LLM plane" inside LiteLLM for free; do it at the network layer: the proxy listens only on the internal Docker network, agents reach only `/v1/messages` + `/v1/embeddings` through Lares's existing allow-list proxy, and only keeper/console reach `/key/*`, `/spend/*`.
- Give the LiteLLM container its own outbound allow-list (provider hostnames only). That is the real defence against the SSRF class.
- `security.md` states misconfiguration (no master key) is "explicitly not in scope". Bug bounty $500–3,000, video repro required.

Untrusted content, sandboxing, approvals: n/a (gateway).

**Phones home?** `security.md`: "**Telemetry — We run no telemetry when you self host LiteLLM**"; "No data or telemetry is stored on LiteLLM Servers". Code search for `telemetry` finds only opt-in exporters (OTel, Langfuse, Datadog, PostHog…) and `NEXT_TELEMETRY_DISABLED=1` in the UI build. **One outbound call by default**: on start (and on reload) it fetches the price map from `raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` (`litellm/litellm_core_utils/get_model_cost_map.py`). Sends nothing about the installation, but it is a call to GitHub (US). **Disable with `LITELLM_LOCAL_MODEL_COST_MAP=True`** — prices then come from the copy baked into the image, which is also better for Lares's "fixture vs live" rule (prices change only when the pinned digest changes).

## Q7 Cost and visibility (deep)

**Scopes that can carry a budget** (proxy/users): global proxy (`litellm_settings.max_budget` + `budget_duration`), organisation, team, team member, internal user, **virtual key**, end-user/"customer" (the `user` field in the request; budgets made with `/budget/new` + `/customer/new`), and "agent"/session caps (`max_budget_per_session`, `max_iterations`). A key can carry several windows at once via `budget_limits` ("$10/day AND $100/month"). **Enterprise-only**: per-model budgets on a key/user (`model_max_budget`, `key_management_endpoints.py:7568-7572`), tag budgets, temporary budget increases, budget tiers, soft-budget email alerts, programmatic spend reports.

Lares's plan maps cleanly onto OSS: $5/day per agent key and $2/day per background-job key = key `max_budget` + `budget_duration: "1d"`; $10/day per installation = `litellm_settings.max_budget: 10, budget_duration: 1d` (or put all keys in one team with `max_budget: 10`).

**Reset**: durations `30s/30m/30h/30d/1mo`. `24h`/`1d` resets at **midnight UTC**, not the owner's local midnight; the reset job polls every ~10 minutes (`proxy_budget_rescheduler_min_time/max_time`).

**What happens at the cap — exact shape (code, commit 0bd8b7fe)**: `litellm/exceptions.py:989-1015` sets `status_code = 429`; `litellm/proxy/auth/auth_exception_handler.py:49-55` wraps it:
```
HTTP 429
{"error":{"message":"Budget has been exceeded! Current cost: 5.02, Max budget: 5.0",
          "type":"budget_exceeded","param":null,"code":"429"}}
```
**The docs still show older shapes** (400/401 with `"type":"auth_error"` and `ExceededTokenBudget:` text) — docs and code disagree; this is exactly a "fixture vs live probe" item. Consequences for Lares: (1) **429 is retried by default by the Vercel AI SDK** (maxRetries 2), so a capped agent makes three calls and waits before failing — detect `error.type === "budget_exceeded"` and do not retry; (2) the body is OpenAI-shaped, not Anthropic-shaped, even on `/v1/messages`, so the Anthropic provider's error parser may surface only a generic message — unverified, needs the live probe; (3) enforcement happens **before** the call using spend recorded so far, so one in-flight expensive call can overshoot the cap; spend is written in batches (`proxy_batch_write_at`, 60 s recommended) — caps are "roughly", not "exactly".

**Pricing for aliases and unpriced models — the silent-cap trap is real, and confirmed in code.**
- A `model_name` alias (`lares-brain`) is priced from `litellm_params.model` (e.g. `anthropic/claude-…`) looked up in the price map. Known upstream model ⇒ priced correctly, including cache read/write rates. So plain aliases of Anthropic/Bedrock/Vertex/Mistral/Scaleway/OVH models are fine.
- If the upstream model is **not in the map**, `cost_calculator.py:370/379` raises "Model not found in cost map" → caught in `litellm_logging.py:1830-1851` → logged at **DEBUG level only** as `response_cost_failure_debug_information` → cost `None` → spend `0` → **the budget never trips and nothing visible tells the owner**. With Lares's recommended `LITELLM_LOG=ERROR` the message is never seen.
- The documented fix is `model_info.input_cost_per_token` / `output_cost_per_token` (+ `cache_read_input_token_cost`, `cache_creation_input_token_cost`) or `base_model:`. **But open bug #35691 (2026-08-03, reproduced on v1.96 and v1.98 by three more users, no maintainer fix)**: for models not in the built-in map, the response shows the right cost while the **persisted spend is $0** even with custom pricing set. So custom pricing cannot be trusted without a live check.
- Docs: if both costs are **explicitly `0`**, LiteLLM "automatically skip[s] ALL budget checks" for that model. All 29 `ollama/*` entries in the map are priced `0.0`. A free local model therefore also bypasses the per-key and installation caps' *checks* (harmless for money, but it means "cap reached" does not stop local-model loops).
- Scaleway (19 models incl. `qwen3-embedding-8b`, `bge-multilingual-gemma2`), OVHcloud (15), Nebius (59), Mistral (94) are in the map. IONOS and STACKIT are not (would go through `openai/` + `api_base` and hit the unpriced path).
- Related open holes: **#38176** — `provider_budget_config` never counts `/v1/messages` or `/v1/responses` spend (fix PR #38172 unmerged); #26701 same for embeddings. Lares does not plan provider budgets, but do not start.
- History: budget-not-enforced bugs recur (#10750 pass-through routes, #11962/#12905 user budget ignored when key has a team, #15967 auto-created end users, #17054 org budget, #25799 DB-added model budgets). All closed, but the pattern says: **every cap Lares promises needs its own committed live probe** (`tests/live/litellm-budget.live.mts`: create key with $0.01 cap → call each alias → assert `/key/info` spend > 0 → assert the next call returns the 429 shape).

**Rate limits**: `rpm_limit`, `tpm_limit`, `max_parallel_requests` on key/user/team; per-model variants `model_rpm_limit`/`model_tpm_limit`; `token_rate_limit_type` input/output/total. Across multiple proxy instances these need Redis; single instance is in-memory.

**Fallbacks and retries** (proxy/reliability): `router_settings.fallbacks: [{"lares-brain": ["lares-brain-eu-fallback"]}]`, `context_window_fallbacks`, `content_policy_fallbacks`, `num_retries`, `request_timeout`, `allowed_fails` + `cooldown_time`; several deployments under one `model_name` are load-balanced. Cross-provider fallbacks work, all OSS. Caveat: a cross-provider fallback behind `/v1/messages` changes caching behaviour (see next section).

**Per-key model allow-list**: `models: ["lares-brain","lares-gate"]` on `/key/generate` — OSS. "Model access groups" on wildcard models are Enterprise (`key_management_endpoints.py:4306-4310`).

**Admin API Lares needs** (all authenticated with the master key, all OSS unless marked):
- `POST /key/generate` (`models`, `max_budget`, `budget_duration`, `rpm_limit`, `key_alias`, `metadata`, `duration`, optional custom `key` value), `POST /key/update`, `POST /key/delete`, `POST /key/block` / `/key/unblock`, `GET /key/info?key=` (spend, budget, reset time), `GET /key/list`.
- **`POST /key/{key}/regenerate` — Enterprise** ("Regenerating Virtual Keys is an Enterprise feature", `key_management_endpoints.py:5611-5614`). Scheduled `auto_rotate` rides on the same. **Lares must rotate the OSS way: generate new → swap in the agent's secret → delete old.** **Tags on keys are Enterprise too** (`:1388-1389`) — use `key_alias` + `metadata` to label agent vs job keys.
- Spend: `GET /spend/logs` (per request, filter by key/date), `/key/info`, `/user/info`, `/team/info`, `/global/spend/*`; response header `x-litellm-response-cost` on every call (cheap per-turn cost display for the console). `/global/spend/report` and permissioned spend routes are Enterprise.
- Keys are stored hashed; the plaintext is shown once at creation.

**What the owner sees when something fails**: the 429 above; Slack alerting for budget crossings is OSS (`alerting: ["slack"]`); email soft-budget alerts are Enterprise. Tracing: callbacks to Langfuse/OTel are OSS and opt-in.

## Prompt caching pass-through

- **Anthropic direct behind `/v1/messages`: yes, passes through.** The native path (`litellm/llms/anthropic/experimental_pass_through/messages/transformation.py`) forwards the Anthropic body; the only `cache_control` rewrite is `_remove_scope_from_cache_control` (strips the `scope` sub-field for backends that reject it, lines 86-110). Lares's memory-in-system-prompt breakpoints survive.
- **Pricing of cached tokens**: usage carries `cache_creation_input_tokens` and `cache_read_input_tokens`; cost uses `cache_creation_input_token_cost` (1.25x), `cache_creation_input_token_cost_above_1hr`, `cache_read_input_token_cost` (0.1x) from the map — e.g. `eu.anthropic.claude-sonnet-4-5…`: input 3.3e-06, cache write 4.125e-06, cache read 3.3e-07 (EU profile carries a 10% uplift over the US price). Spend therefore reflects caching correctly **when the model is in the map**.
- **Bedrock (eu-*) and Vertex (europe-*) Claude**: supported; `cache_control` converted to Bedrock `cachePoint` / kept for Vertex. But a steady stream of breakage: #26320 (open — top-level `cache_control` not converted for Bedrock on `/v1/messages`), #33281 (open — Bedrock guardrail config silently drops it), #20418 / #23149 / #23873 (closed — Vertex placement, `scope`, file blocks).
- **OpenAI behind `/v1/messages`**: request is translated by an adapter; OpenAI caches automatically (≥1,024 tokens) and ignores breakpoints. If the model is in `mode: responses`, **the bridge drops `cache_control` entirely and flattens the system prompt** (#41424, open, 2026-09-16) → zero cache reads.
- **Mistral**: Mistral's own API has caching (opt-in `prompt_cache_key`, cached tokens at 10% — Mistral docs), but Mistral is **not** in LiteLLM's prompt-caching provider list (OpenAI, Anthropic, Gemini, Vertex, Bedrock, Deepseek, xAI) — treat as not passed through / not priced. Unverified in code. **Scaleway**: automatic server-side caching, no `prompt_cache_key`, 50–90 % hit rate "not guaranteed" (Scaleway docs).
- `cache_control_injection_points` lets the gateway add breakpoints itself (e.g. always cache the system message) — useful if eve/AI SDK ever stops emitting them.
- Practical point for Lares: standing facts (cap 40) injected into the system prompt every turn **must be byte-stable and ordered** or every turn is a cache write at 1.25x instead of a read at 0.1x. Put volatile memory after the last breakpoint.

## Licence split and AGPL

- MIT: the SDK, the proxy, virtual keys, key/user/team/global budgets, rate limits, fallbacks, spend logs, admin UI, Slack alerts, cosign-signed images.
- Enterprise licence (`enterprise/`, needs `LITELLM_LICENSE`; "may only be used in production" with a subscription; modifications belong to BerriAI; "forbidden to copy, merge, publish, distribute"): SSO beyond 5 users, JWT auth, audit logs, RBAC extras, IP allow-lists, **key regeneration/rotation**, secret-manager integrations, tag budgets, **per-model budgets per key**, temp budget increases, soft-budget emails, spend reports, per-team guardrails/logging, max request size limits, **`DISABLE_ADMIN_ENDPOINTS` / `DISABLE_LLM_API_ENDPOINTS`**, key tags.
- **What Lares's plan touches that is Enterprise**: "rotate keys" (if done with `/key/regenerate`), key tags, per-model caps per agent, admin/LLM endpoint split, audit log of admin actions. All have OSS workarounds (above) except the audit log — keeper should write its own record of every admin call it makes.
- The `enterprise/` code **is inside the official image** (`Dockerfile:75` copies `enterprise/pyproject.toml`; features are licence-key gated at runtime). Lares must not enable, patch, or redistribute it.
- **AGPL**: Lares talks to LiteLLM over HTTP as a separate container and pulls the upstream image by digest — no linking, no code copied, so no licence interaction ("mere aggregation"). Do **not** re-host a modified LiteLLM image from Lares's registry (that would be distributing the enterprise directory); reference upstream's digest.

## EU routing

- **Anthropic has no EU region.** Its API's `inference_geo` accepts only `us` or `global` (as of Sept 2026, per several 2026 write-ups; not checked against Anthropic's docs — unverified). The only ways to get Claude processed in the EU are **AWS Bedrock `eu-*` inference profiles** (`bedrock/eu.anthropic.claude-…` + `aws_region_name: eu-central-1`; 8 current `eu.anthropic.*` Claude entries incl. sonnet-5, opus-5, haiku-4-5 in the map) or **Google Vertex `europe-west1/4`** (`vertex_ai/claude-…` + `vertex_location`). Azure Foundry Claude in EU: timeline unclear (Microsoft Q&A). **All three are US hyperscalers — this collides with Lares's "no US cloud in the data path" rule.** Data stays in an EU region, but under a US company's control (CLOUD Act exposure). Lares has to say which promise it is making: "EU region" (Claude via Bedrock-EU is allowed) or "EU vendor" (no Claude at all).
- **EU-vendor options, all first-class LiteLLM providers with prices in the map**: `mistral/*` (Paris; 94 entries), `scaleway/*` (Paris; Mistral Medium 3.5, gpt-oss-120b, Qwen3.5-397B, Llama-3.3-70B, GLM-5.2, DeepSeek-V4-flash…), `ovhcloud/*` (15), `nebius/*` (NL/FI; 59), `nscale/*` (16). IONOS / STACKIT / Aleph Alpha: via `openai/<model>` + `api_base` → unpriced path, set `model_info` and live-probe.
- **Embeddings in the EU**: `scaleway/qwen/qwen3-embedding-8b`, `scaleway/BAAI/bge-multilingual-gemma2`, `mistral/mistral-embed`, `mistral/codestral-embed`, `nebius/BAAI/bge-multilingual-gemma2`; via hyperscalers `cohere.embed-v4:0` / `amazon.titan-embed-text-v2:0` on Bedrock eu-*. Self-hosted on the box: a small multilingual model via `ollama/` or `hosted_vllm/` (priced 0 → budget checks skipped).
- Alias pattern: `lares-brain` → two deployments (primary + EU fallback) under one `model_name`, or `fallbacks`. Embedding alias must not fall back across models — vectors from different models are not comparable.

## Alternatives (one line each)

| Option | Facts (2026-09-18) | Fit |
|---|---|---|
| **Bifrost** (maximhq/bifrost) | Go, Apache-2.0, 8.2k stars, pushed today; virtual keys + hierarchical budgets in OSS (`plugins/governance`), native `/anthropic` drop-in route, single small binary, SQLite or Postgres. Clustering, guardrails, MCP gateway, OIDC are enterprise. | **The credible fallback** — far smaller footprint. Needs the same live probes (cache_control pass-through, cap error shape, unpriced models). |
| Portkey gateway (OSS) | TypeScript, MIT, 13k stars, last push 2026-05-25. OSS part is routing/fallback/guardrails only; **keys, budgets, spend live in the hosted (US) control plane**. | Loses caps and keys → no. |
| Helicone AI gateway | Rust, **GPL-3.0**, 630 stars, **last push 2025-11-21** (stale). Caps/observability depend on Helicone platform. | No. |
| TensorZero | Rust, Apache-2.0, 11.7k stars — **GitHub reports the repo archived, last push 2026-06-11** (reason unverified). Needed ClickHouse; no per-key budgets. | No. |
| OpenRouter | Hosted, US. | Ignored per brief. |
| **No gateway** (AI SDK provider registry / `customProvider` aliases) | Zero extra RAM, zero extra CVE surface, aliases still work in code. | **Loses**: hard caps enforced outside the agent process, per-agent keys (provider key would sit in every agent container), one audit/spend point, fallbacks as config, model allow-lists. Keep only as a documented "tiny box" mode if Lares writes its own spend counter in keeper. |

## Patterns worth stealing (LiteLLM)
1. **Purpose aliases with several deployments under one name + `fallbacks`** — already Lares's design; add an EU fallback deployment per alias (`proxy/reliability`).
2. **`x-litellm-response-cost` response header** — show cost per turn in the console without querying the DB.
3. **Multiple budget windows on one key** (`budget_limits`: day AND month) — a monthly ceiling is what an owner actually wants to know.
4. **`cache_control_injection_points`** — cache the system prompt at the gateway as a safety net.
5. **Cosign key pinned by commit hash** (`README.md:573-579`) — Lares's own images should be signed and verified the same way.
6. **`security.md` with explicit "known non-issues" and severity classes** — good template for Lares's own security policy.
7. **`LITELLM_LOCAL_MODEL_COST_MAP=True`** — a "no network at start" switch; Lares's "nothing phones home" should be testable the same way.

## Traps they hit
- PyPI compromise through a **compromised security scanner in CI** (Trivy). Lesson for Lares CI: pin every GitHub Action and tool by digest; publishing credentials must not be reachable from jobs that run third-party tools.
- 14 CVEs in 5 months, several pre-auth. The proxy must never face the internet or an untrusted network.
- Budget bugs recur on every new route (pass-through, `/v1/messages`, embeddings, provider budgets). Docs lag code (error shape).
- Unpriced model ⇒ $0 spend, logged at DEBUG only; custom pricing not reliably persisted (#35691).
- Without Redis, spend counter doubled until 2026-09-12 (#40050 → #40572).
- Memory creep is a long-running theme (#12685, #27954); vendor answer is "4 GiB floor" and periodic worker restarts.
- Enterprise gates appear inside OSS endpoints at runtime (regenerate, tags, `model_max_budget`) — discovered by a 4xx, not by reading the README.

---

# SOURCE B — Open Knowledge Format

## Q1 Memory — the format

**What OKF is**: "a directory of markdown files with YAML frontmatter. There is no schema registry, no central authority, and no required tooling" (`SPEC.md:10-13`). Files are the truth; `index.md` is a derived listing; nothing else is specified (no storage, no search, no recall, no consolidation — explicit non-goals, §1). Recall, forgetting, dreaming, scaling, per-user scoping: **the spec is silent on all of them** — Lares owns those.

**Frontmatter — every field**

| Field | Status | Meaning | Spec |
|---|---|---|---|
| `type` | **REQUIRED, the only one** | Short free-text kind; no central registry; consumers MUST tolerate unknown values | §4.1 |
| `title` | recommended | Display name; else derived from filename | §4.1 |
| `description` | recommended | One sentence; used verbatim by index generators/search snippets | §4.1 |
| `resource` | recommended | Canonical URI of the thing described; absent for abstract concepts | §4.1 |
| `tags` | recommended | YAML list | §4.1 |
| `sources[]` | optional | Provenance list. Each entry: `resource` (**required in an entry**; URL, bundle path, or a free-text scope descriptor), `id` (stable key for footnotes), `title`, credibility signals `author` (actor), `usage_count`, `last_modified` | §5.1 |
| `usage_window` | optional | `{from,to}` sibling of `sources`, frames `usage_count` | §5.1 |
| `generated` | optional | `{by, at}` — `by` required inside it (an actor); `at` = "the content's last meaningful change" | §5.2 |
| `verified` | optional | List of `{by, at}` confirmations; a bare mapping MUST be read as a one-element list | §5.2 |
| `status` | optional | `draft` \| `stable` (default when absent) \| `deprecated` | §5.4 |
| `stale_after` | optional | Absolute instant; stale when `now >= stale_after` | §5.5 |
| `runtime`, `parameters`, `computation`, `executor`, `attester` | only for `type: Attested Computation` | Sanctioned SQL/dbt computation + deterministic checker | §10 — **irrelevant to Lares** |
| `okf_version` | optional | **Only allowed in the bundle-root `index.md`** — the single place an index may have frontmatter | §8, §12 |
| anything else | allowed | "Producers MAY include any additional keys. Consumers SHOULD preserve unknown keys when round-tripping and MUST NOT reject documents with unrecognized fields." | §4.1 |

**Actor convention** (§7): `<producer>/<version>` for agents (`reference_agent/gemini-2.5-pro`), `human:<id>`, `process:<id>`. Producers MUST use `human:` for hand-authored or human-confirmed content, because **trust tiers** (§5.3) key off it: no `verified` ⇒ unverified; verified only by non-humans ⇒ machine-confirmed; verified by a `human:` ⇒ human-reviewed. "Advisory signals, not access control."

**Timestamps**: every one "an ISO 8601 datetime with an explicit UTC offset" (`SPEC.md:284`). This was tightened on 2026-08-21 (PR #6) from date-only `YYYY-MM-DD` **without a version bump** — issue #24: "`okf_version: "0.2"` now names two documents".

**Reserved filenames** (§3.1, any directory level; MUST NOT be used for concepts):
- `index.md` — no frontmatter (except root `okf_version`); sections of `# Heading` + `* [Title](relative-url) - description`; entries SHOULD reuse each concept's `description`; optional; consumers MAY synthesise one.
- `log.md` — `# …` title, then `## YYYY-MM-DD` headings newest first with prose bullets; bold lead word (`**Update**`, `**Creation**`, `**Deprecation**`) is convention only.
- Nothing else is reserved. `references/` is a naming convention (§6.3).

**Linking** (§6): ordinary markdown links; `/`-rooted bundle-relative form is "recommended", relative also allowed; links are **untyped** — the relationship is "conveyed by the surrounding prose"; consumers MUST tolerate broken links. Per-claim attribution = markdown footnote whose label equals a `sources[].id` (keyed, not positional, "because agents constantly rewrite these documents"). No `[[wikilinks]]` (requested in #9). Inconsistency inside the repo: the reference agent's prompt **forbids** `/` links ("Never start a link with `/` (that breaks GitHub rendering)", `prompts/reference_instruction.md`), and #29 shows the spec's own examples contradict §6.2 on relative paths.

**Bundle layout** (§3): any directory tree; concept ID = path minus `.md`; ship as git repo (recommended), tarball, or subdirectory.

**Conformance** (§11) — three rules only: every non-reserved `.md` has parseable YAML frontmatter; every frontmatter has non-empty `type`; `index.md`/`log.md` follow their structure *when present*. Consumers MUST NOT reject for missing optional fields, unknown types, unknown keys, broken links, or missing indexes. **Consequence: nearly any Obsidian vault with a `type:` key is already "OKF-conformant" — the word promises very little.**

**v0.1 → v0.2** (§13): two breaking changes — `timestamp` → `generated.at`; body `# Citations` list → frontmatter `sources` (consumers MAY still read the old forms). Additive: `sources` + credibility signals + `usage_window`, `generated`, `verified`, `status`, `stale_after`, the actor convention, `Attested Computation` and its keys, `# Computation` heading.

**Roadmap**: no v0.3/v1.0 date anywhere. §12 "Considered and deferred" lists only attestation work (receipt/verdict wire formats, attester ABI and sandboxing "likely bundled with future work on serving and Skills", attestation caching, Looker/dbt templates). §5.1 says deeper lineage (`derived_from`) is "out of scope for v0.2". Versioning rule: minor = backward-compatible additions, major = may rename required fields or reserved filenames. Open community proposals that touch memory: typed relationships (#16, 8 comments), `supersedes`/`contested_by` (#22), `imported` — take a concept from another bundle without inheriting its trust (#15), `refuted` (#13), `revised` vs `generated` (#28), deletion/tombstones (#11), JSON Schema for frontmatter (#8). **None has a maintainer reply.**

### Can OKF carry Lares's provenance needs?

| Lares needs | OKF v0.2 | Verdict |
|---|---|---|
| Who wrote this memory (owner / which agent / nightly dream cycle) | `generated.by` with `human:bendik`, `chief-of-staff/<model>`, `process:dream-cycle` | **Fits exactly.** |
| Owner confirmed it | `verified: [{by: human:<id>, at}]` → "human-reviewed" tier | **Fits.** Maps onto the dream cycle's "promote at confidence ≥ 0.8": promoted-but-unconfirmed = no `verified`; owner-approved = `human:`. |
| Where it came from (which email, meeting, web page) | `sources[]` with `resource`, `id`, `title`, `author`, `last_modified` | **Fits**, including per-sentence footnotes. |
| **It came from untrusted third-party content** (prompt-injection hygiene) | Nothing. `sources[].author` is an "authority signal", trust tiers only describe who *verified*, and they are "advisory… not access control". | **Needs an extension field.** |
| **When the fact was true** (valid-from / valid-to; "lived in Oslo 2019–2024") | Nothing. `generated.at` = when written, `sources[].last_modified` = when the source changed, `stale_after` = when to stop trusting. No validity interval, no supersession. | **Needs extension fields.** |
| Forgetting / correction | `status: deprecated` ("kept for links and history") + `log.md`. Deletion is undefined (#11: removed vs never-written are indistinguishable). | Partial. |
| Confidence score | Deliberately excluded: "It does not store a credibility score: a score is subjective, unportable… and goes stale" (§5.1). | Extension field if wanted; OKF's argument against storing one is worth reading. |
| Private / org / participants scope | Nothing. | Extension field or directory layout. |

Custom fields are explicitly legal (§4.1) and other tools SHOULD preserve them. The spec offers **no namespacing convention**; to avoid colliding with future OKF keys (e.g. a future `relationships` or `imported`), prefix Lares's own: `lares_origin: owner | agent | third_party`, `lares_valid_from`, `lares_valid_to`, `lares_supersedes`, `lares_scope`, `lares_confidence`.

## How the reference agent uses a bundle

**The "reference agent" is a producer, not a consumer.** README: "The agent below is a **proof of concept** demonstrating *one* way to produce OKF bundles automatically." It is a Google ADK + Gemini + BigQuery Python CLI (`pyproject.toml`: `google-adk`, `google-cloud-bigquery`). It works one concept per invocation: `read_existing_doc` → `read_concept_raw` → optional `sample_rows` → `list_concepts` (to pick link targets) → exactly one `write_concept_doc` (`prompts/reference_instruction.md`); a second "web pass" crawls seed URLs with a page cap and host allow-list. There is **no retrieval**: no index pre-load, no link walking at query time, no grep, no embeddings. The only other consumer in the repo is the static HTML graph viewer (bundle embedded as JSON, Cytoscape + marked from a CDN, client-side search over title/id/tags).

The spec's *intended* consumption model is **progressive disclosure through `index.md`** — "letting a human or agent see what is available before opening individual documents" (§8), "navigate the hierarchy one level at a time instead of loading the entire bundle into context" (README). `bundle/index.py::regenerate_indexes` builds them bottom-up: entries grouped by `type`, sorted by title, description from frontmatter, and directory descriptions **synthesised by a small LLM** (`gemini-flash-latest`). **No guidance anywhere on bundle size, chunking, maximum file length, or search.** Sample bundles are 10–40 files.

Useful producer-side details in the code:
- `write_concept_doc` stamps `generated: {by: reference_agent/<model>, at: now}` automatically — the model never supplies it (`tools/bundle_tools.py`).
- **Augmentation guard**: during the web pass the tool refuses a write that drops existing `# Schema` fields or shrinks `sources` — "augment, not replace" — and returns a corrective error to the model.
- The YAML loader removes the timestamp resolver so dates stay strings and round-trips do not rewrite the author's text (`bundle/document.py`).
- Issue #26: regenerating the root `index.md` silently drops `okf_version`; parallel producers collide on `index.md`/`log.md` when merged.

## Adoption and repo health

**Ecosystem (young, broad, shallow)** — GitHub search, 2026-09-18: `scaccogatto/okf-skills` (Claude Code plugin + skills + GitHub Action, MIT, 391 stars), `jyjeanne/okf-rs` (Rust validate/serve, 102), `OWOX/models` (visual editor, 89), `0dust/OKFy` (72), `sniperunder123/okf-knowledge` (Claude Code `/okf` skill, 65), **`openknowledge-sh/openknowledge`** (CLI, Apache-2.0, 56, pushed today), `oak-invest/kiso` (static-site publisher, 42), `aws-samples/sample-okf-llm-wiki` (28 — an AWS sample, notable), `W4G1/okf` (Rust, 24), Obsidian plugins `MartinForReal/okf-enforcer` (14, in the Obsidian community directory) and `kennyg/obsidian-okf` (2, no licence), linters `thisismydesign/okf-lint`, `rpmoore/okf-lint`, `cwest/okfctl`, MCP server `alexandre-leites/okf-vault`, safety scanner `darshanNhb/okf-guard` (prompt-injection screening before content becomes a concept; never writes `verified`), a strict superset `DavidROliverBA/aix-format`, GitBook explainer, okf.md site, three "awesome-okf" lists. Much of the press is SEO speculation. Google's own path in is the Knowledge Catalog (Dataplex) connector via `kcmd`.

**Spec repo health — weak.** Created 2026-08-11; 6 commits; **last commit 2026-08-21; one committer**; no tags or releases; **zero maintainer comments on any of the 20 open issues/PRs** (every comment has author_association NONE; only the CLA bot answers PRs); a wording-only PR (#17) has sat 13 days. The one substantive spec change so far tightened a rule without bumping the version (#24). The community is doing the design work in the issue tracker on its own (#16, #22, #26).

**Public promise**: say **"plain markdown files, compatible with OKF v0.2"** and pin the spec commit (`ad30107c`) in the conformance test, as issue #24's author does ("We pin `ad30107c` in our interoperability fixtures rather than resolving a version string"). Do not make "your memory is OKF" the headline: conformance asks only for a `type:` key, the spec can change under the same version number, governance is one silent Google employee, and OKF's centre of gravity is data catalogues (BigQuery tables, metrics, attested SQL), not personal memory. The durable promise is "markdown + YAML in git that Obsidian opens"; OKF is a compatible dialect of that.

## Q8 Community (OKF)
- Licence Apache-2.0 for spec, agent, viewer, bundles — compatible with AGPL-3.0 if Lares copies code (keep the notice). A format carries no licence obligation.
- Governance: none stated. No steering group, RFC process, or foundation. `CONTRIBUTING.md`: spec changes "held to a higher bar. **Open an issue describing the problem and the proposed change before sending a pull request**"; tooling PRs welcome; Google CLA required; all submissions reviewed via PR.
- Release cadence: none — version lives in the first lines of `SPEC.md`.
- "What works / what doesn't": README is candid that agent and viewer are proofs of concept; the connector doc opens with "Read Limitations first".

## Q2–Q7 for OKF
n/a — a file format: no integrations, installer, agent definitions, users, runtime safety or cost. (Safety-adjacent: trust tiers are advisory only; `okf-guard` is a third-party idea for screening content before it is written.)

## Patterns worth stealing (OKF)
1. **Actor convention + `generated` stamped by the write tool, never by the model** (`SPEC.md §7`, `tools/bundle_tools.py::write_concept_doc`). Lares's memory-write tool should stamp `generated.by` itself from the running agent's identity.
2. **`generated` vs `verified` kept separate; trust tier derived, not stored** (§5.2–5.3). Maps directly onto the dream cycle: promoted = generated by `process:dream-cycle`; owner tap on an approval card = `verified` by `human:`.
3. **Keyed footnotes to `sources[].id`** (§5.1) — survives agents reordering lists.
4. **`stale_after` as an absolute instant** (§5.5) — a plain comparison, no TTL arithmetic. Good for "flight on 3 Oct" memories.
5. **Generated `index.md` per folder with one-line descriptions** (`bundle/index.py`) — a cheap navigation layer for an agent with keyword-only search and no index; forces every note to have a good `description`.
6. **Augmentation guard on writes** (`bundle_tools.py`) — refuse a write that loses existing sources/fields; return an instructive error. Protects memory from a careless rewrite.
7. **No stored credibility score** (§5.1 reasoning) — argument for not persisting the dream cycle's 0.8 confidence in the file.
8. **YAML loader that does not coerce dates** (`bundle/document.py`) — round-trip safety; relevant to the Notion↔markdown sync.

## Traps they hit (OKF)
- Breaking change shipped under the same version string (#24).
- Spec, reference prompt and sample bundles disagree on link paths (#29, #14, prompt vs §6.1).
- Regenerating indexes drops `okf_version`; reserved filenames collide on merge (#26).
- Deletion is indistinguishable from "never written" (#11).
- `generated.at` is overloaded — "created" and "last changed" are one field (#28).
- Links are untyped, so "supersedes", "contradicts", "about person X" cannot be queried (#16, #22).

---

# Verdicts for Lares

## LiteLLM

| Idea | Verdict | Why |
|---|---|---|
| Keep LiteLLM as the mandatory gateway | **adapt** | MIT, self-hosted, no telemetry, does keys + caps + aliases + fallbacks in OSS. But 14 CVEs in 5 months, a "4 GiB floor", and recurring budget bugs → keep it, fenced and probed; design so the gateway is swappable (Bifrost) and optional on tiny boxes. |
| Pin ≥ 1.96.2 by digest **and** verify cosign signature in CI | **adopt** | Fixes key-exfiltration CVE-2026-84377; image was unaffected by the PyPI attack; signature closes the registry-tamper gap. |
| `allow_client_side_credentials: false`, `disable_error_logs: true`, `DISABLE_ADMIN_UI=True`, `LITELLM_LOCAL_MODEL_COST_MAP=True`, `LITELLM_MODE=PRODUCTION`, non-root image | **adopt** | Each maps to a real CVE workaround or to "nothing phones home". |
| Admin vs LLM plane split with LiteLLM's own flags | **ignore** | Enterprise-only. Do it with Lares's network allow-list: agents reach `/v1/messages`+`/v1/embeddings` only. |
| Own outbound allow-list for the LiteLLM container | **adopt** | Real defence against the SSRF class; fits the existing sealed-network design. |
| Key budgets $5/$2 per day + global $10/day | **adopt** | OSS, maps 1:1. Note resets are midnight **UTC**; caps are approximate (pre-call check, batched writes). |
| Trust caps without a live probe | **ignore** | Unpriced model ⇒ $0 ⇒ cap never fires, DEBUG-only log (`litellm_logging.py:1830-1851`); custom pricing persistence bug #35691 open. Ship `tests/live/litellm-budget.live.mts` per alias. |
| Console refuses to save an alias whose upstream model has no price | **adopt** | Turns the silent failure into a visible one. Check `/model/info` for non-null costs at save time. |
| Rotate keys via `/key/regenerate` | **ignore** | Enterprise. Generate-new → swap → delete-old. Label with `key_alias`/`metadata`, not tags. |
| Treat HTTP 429 + `type: budget_exceeded` as non-retryable, show a plain-language "daily cap reached" | **adopt** | AI SDK retries 429 by default; docs show a different shape than code → probe it. |
| Anthropic `cache_control` via `/v1/messages` | **adopt** | Passes through natively; cache read/write priced from the map. Keep injected memory byte-stable before the breakpoint. |
| Cross-provider fallback behind the same alias | **adapt** | Works, but caching silently degrades on OpenAI-responses/Bedrock paths (#41424, #26320, #33281). Fallback to the same model family where possible. |
| Claude via Bedrock eu-* / Vertex europe-* as "the EU option" | **adapt** | Only way to get Claude in an EU region, but both are US clouds — contradicts Lares's stated policy. Offer as an explicit owner choice, default EU-vendor aliases (Mistral, Scaleway). |
| Scaleway / Mistral embeddings alias | **adopt** | First-class providers, priced, EU vendors. |
| Redis alongside LiteLLM | **adapt** | Not needed on one instance once #40572 is in the pinned version — verify with the probe; skip Redis to save RAM. |
| Bifrost as documented fallback gateway | **adapt** | Apache-2.0, Go, small, OSS virtual keys + budgets, Anthropic route. Evaluate with the same probes before promising. |
| No-gateway mode | **ignore** (for now) | Loses out-of-process caps, per-agent keys, single audit point. |
| Re-host or patch the LiteLLM image | **ignore** | Image contains `enterprise/` code under a no-redistribution licence. Reference upstream digest only. |

## OKF

| Idea | Verdict | Why |
|---|---|---|
| Public claim "your memory is OKF" | **adapt** → "plain markdown, OKF v0.2-compatible", pinned to spec commit `ad30107c` | One silent maintainer, 6 commits, breaking change without version bump, conformance = "has a `type` key". |
| `generated: {by, at}` with the actor convention, stamped by the write tool | **adopt** | Exactly Lares's "who wrote this memory". Currently deliberately not adopted (`services/atlas/lib/okf.ts` comment). |
| `verified` for owner confirmation → derived trust tier | **adopt** | Fits the approval-card and dream-cycle promotion model; no stored score. |
| `sources[]` instead of Lares's `canonical_sources` | **adapt** | Same role; using OKF's key makes third-party OKF tools (validators, Obsidian plugins, viewers) understand Lares's provenance. Either rename or emit both for a while — owner decision. |
| `stale_after`, `status: deprecated` | **adopt** | Cheap expiry and soft-forget; both optional. |
| Extension fields for untrusted origin, validity interval, supersession, scope | **adopt**, prefixed `lares_` | OKF has nothing for these; custom keys are explicitly legal and must be preserved by other tools; prefix avoids collision with open proposals #15/#16/#22. |
| Generated per-folder `index.md` | **adapt** | Best cheap aid for keyword-only recall; but Atlas's rule today is "has neither and must not grow one" — revisit, and mind #26 (regeneration drops `okf_version`). |
| Write-guard that refuses lossy rewrites | **adopt** | Small, protects memory from agent mistakes. |
| Attested Computation family, credibility `usage_count` | **ignore** | Data-catalogue concerns. |
| Copying reference-agent code | **ignore** | Python/ADK/BigQuery producer; nothing to reuse but ideas (Apache-2.0 would allow it). |
| Propose Lares's memory extensions upstream | **adapt** | CONTRIBUTING says open an issue first; but no issue has had a maintainer reply in 4 weeks — low cost, low expectation. |

---

# Things that contradict Lares's current plan

1. **"Spend caps protect the owner" is not true by default.** Any alias whose upstream model LiteLLM cannot price records $0 and never trips the cap, with only a DEBUG log; custom pricing is unreliable right now (#35691); explicitly-zero-priced (local) models skip budget checks entirely. Caps need a committed live probe per alias and a console guard.
2. **"Rotate keys through the admin API"** — `/key/{key}/regenerate` and key tags are Enterprise. So are per-model budgets per key and disabling admin endpoints.
3. **8 GB reference box vs LiteLLM's documented "4 GiB is a floor".** With agents peaking at 3 GB plus Postgres, the gateway as documented does not fit; real idle use must be measured and a memory limit + worker recycling set, or a lighter gateway considered.
4. **"EU-only, no US cloud in the data path" vs Claude.** Anthropic has no EU region; EU-region Claude exists only on AWS/Google (US companies). The default `lares-brain` cannot be both Claude and compliant with the vendor policy as written. The policy needs to say "EU region" or "EU vendor".
5. **"Nothing phones home"** — LiteLLM fetches its price map from GitHub on start unless `LITELLM_LOCAL_MODEL_COST_MAP=True`. Must be in the default compose.
6. **Cap error handling** — the cap arrives as HTTP 429 (retried by the AI SDK by default) with an OpenAI-shaped body; LiteLLM's docs show a different shape than its code. Fixture-vs-live rule applies.
7. **An agent's virtual key was, until v1.96.2, enough to steal the provider key** (CVE-2026-84377). The gateway is part of the prompt-injection blast radius, not outside it; it needs its own outbound allow-list and `allow_client_side_credentials: false`.
8. **Budget day = UTC day**, not the owner's local day.
9. **OKF optional families are deliberately not adopted today** (`services/atlas/lib/okf.ts`), yet they are precisely the part of OKF that answers Lares's provenance requirement (`generated`, `verified`, `sources`). And two requirements — "this came from untrusted content" and "when was this true" — are **not** in OKF at all and need `lares_*` extension fields.
10. **"Memory is OKF" as a public promise** rests on a 5-week-old repo with one silent maintainer and a spec that already changed incompatibly under the same version number. Pin the commit; promise "OKF-compatible markdown".
11. **OKF says nothing about recall, size, or search**, and its reference agent does not read bundles at all. Lares's keyword-only search has no upstream pattern to lean on beyond generated `index.md` files; the unused pgvector + an EU embeddings alias remains Lares's own decision.
