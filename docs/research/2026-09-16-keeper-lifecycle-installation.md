# Task14 installation contract — preparation only, Task20 remains manual

No deployment or production mutation is performed by this change. Native image builds/parser tests are CI gates; compiled-file/CLI smoke is not proof of a working agent turn. The installation must pin CI artifacts by full SHA256 digest. Builder images remain the default Dockerfile target; the new `runtime` target produces `lares-<role>-runtime`.

## Manual prerequisites

Task20 preflight found that the original generated services omitted installation data mounts
and non-door credentials. Configure `lifecycle.bindings` before adopting an existing runtime.
This root-owned map is keyed by agent name and is never accepted from a Console action or
agent definition. Each entry specifies `role`, optional `ownerId` (the existing owner-clock
namespace, which may differ from the login email), explicit `environment`, `mounts`, `secrets`,
and optional `workflowVolume`. For example:

```json
{
  "bindings": {
    "example": {
      "role": "creative",
      "ownerId": "existing-owner",
      "environment": {"ATLAS_PATH": "/srv/atlas", "TZ": "Europe/Oslo"},
      "mounts": [{"source": "/srv/atlas", "target": "/srv/atlas", "readOnly": false}],
      "secrets": {"LANGFUSE_KEY_FILE": "/etc/lares/secrets/telemetry"},
      "workflowVolume": "existing-example-workflow-files"
    }
  }
}
```

The fragment belongs inside the complete lifecycle config. Review every retained store,
bare Git repository, read-only gitconfig, provider credential and integration setting against
the actual old runtime. Keeper must see data sources at the same host paths (read-only mounts
are sufficient for preflight); it refuses missing/symlinked sources rather than creating empty
directories. Bind mount targets are restricted to `/srv/`, `/data/` and read-only `/etc/gitconfig`.
Existing workflow file volumes are external, mounted with `nocopy`, and never owned/deleted
by keeper. An adopted PostgreSQL workflow store and a workflow file volume are separate things.
Credentials use the existing file-first environment contracts and receive the same narrow
root:10001 0440 provisioning as other runtime secrets. The travel adapter's legacy Google
keys are role-restricted; chief Google authority must still use its selected-mailbox contract.
Core identity, claims, proxy, database, process options and the schedule master cannot be
overridden through this map. A role change with old bindings is refused until the installation
bindings are reviewed. Installation changes require explicit reconciliation, never an implicit
restart on definition save. Stored owner namespace does not replace claimed transport identity.

Fresh installs add a narrower `lifecycle.defaultBindings` map keyed by role. It exists because the
installer knows the real owner and shared platform-secret paths before the owner has named their
first agent. An exact `bindings[agentName]` entry always wins; otherwise the matching role default
supplies only the owner id and route-password file. The keeper's writable secret root is below its
same-path `/srv/lares` mount, while installer-owned database and route-password inputs remain on
the separate read-only `/etc/lares/secrets` mount. Existing installation configs are unchanged.

Fresh on-box installs also set `runtime.gatewayMasterKeyFile` and leave `runtime.gatewayKeys`
empty. After the owned resource reservation, keeper creates `<name>-gateway-key` under its managed
secret root before calling LiteLLM `/key/generate` with that exact key. The key is `llm_api` only,
allow-listed to `<models.alias_prefix>-{brain,writer,utility,gate,embed}`, and capped at `$5` per
`1d`. Retries use `/v2/key/info` with the local key's SHA-256 in the request body, so neither a URL
nor an error contains the plaintext; an interrupted successful create remains recoverable from the
already-persisted file. A mismatched remote alias, model allow-list, budget, duration or key type is
refused rather than silently rewritten. Exact per-name `runtime.gatewayKeys` remain the existing or
external-gateway compatibility path and win without an admin API call. Deleting an owned agent
deletes a managed virtual key by hash and verifies absence before the managed local file is removed;
exact installation-supplied key paths are neither revoked nor removed.

Generated runtimes also need writable, bounded tmpfs caches at the role's
`node_modules/.cache` and the agent kit's real `/app/packages/agent-kit/node_modules/.cache`
path. Eve loads authored modules there during startup; a `.eve` tmpfs alone is insufficient.
Only `.eve/sandbox-cache` is masked, retaining shipped metadata. If retained sessions still
reference a pre-rename app root, installation bindings can list `legacySandboxRoots`; each
must be a single old `/app/services/<name>` directory, never a current role/service root.
These are ephemeral sandbox compatibility mounts, not persistent stores.

CI exercises the chief runtime against disposable PostgreSQL and a local Anthropic-protocol
fixture: first turn, mounted duties, session alias retention across a real restart, and a new
session seeing edited duties/model. This is runtime/routing proof, not a live provider test.
Dynamic aliases are persisted as session state and reconstructed into the installation's
provider at step scope. Returning a bare alias from Eve's dynamic model resolver instead
routes to Vercel AI Gateway, irrespective of the compiled fallback's provider.

Backups must include `/srv/lares` and encrypt `/etc/lares` into the existing off-box age escrow
bundle. `services/box/ops/backup.sh` now does both, and refuses a Lares configuration directory
without a configured recipient. Keep all new credentials and keeper configuration under
`/etc/lares`, not the data root. Other custom installation paths require explicit backup coverage.
Check the encrypted archive contents through a disposable restore and retain the previous
images, file volumes, source mounts and PostgreSQL stores through rollback acceptance.
List the exact retained file volume names in backup.env `LARES_WORKFLOW_VOLUMES`; PostgreSQL
dumps do not contain Eve's file/blob storage. Missing configured volumes fail the backup before
a snapshot is recorded. Restore each archive path into its corresponding external volume;
never point this list at the running PostgreSQL data volume.

1. Apply migrations 039–045 (043 conversations, 044 door connections, 045 separate runtime control) after backups and review. No keeper startup migration exists. Create an **empty** workflow template database manually with the exact release's world-postgres migrations, and close its connections. `lifecycle.workflowTemplate` and `workflowOwner` identify it. Never use an existing agent database as the template. Keeper only issues fixed CREATE DATABASE FROM TEMPLATE, COMMENT, and verified DROP DATABASE operations.
2. Supply the strict `lifecycle` config described in `services/keeper/lib/lifecycle-config.ts`. All retained egress sources, direct/internal exceptions, integration endpoint URLs and gateway/telemetry hostnames must be explicit. Missing arrays are rejected. Inventory every network reservation, including stopped rollback services and non-agent services; `reservedAddresses` supplements live Docker network inspection. No old agent credentials, domain database, gateway or proxy defaults are supplied.
3. For an existing or external gateway, configure per-name key files in `runtime.gatewayKeys`. For a fresh on-box gateway, configure `runtime.gatewayMasterKeyFile` instead and keep the exact map empty; keeper will create and register the per-agent files as described above. In both cases configure the shared domain `databaseUrl`, password-free `workflowServer`, runtime password file, gateway and proxy URLs. Existing workflow database names are registered below, never inferred from the shared domain URL. Configure admin DB credentials separately. The runtime PG user must have access to the template-cloned stores; do not give containers the keeper admin credential.
4. Mount the keeper-owned host root at the **same absolute path inside keeper** so Docker daemon bind sources resolve correctly. Keeper configuration, agents, retired definitions, egress staging, generated compose, backups and runtime secret files must be within explicitly mounted roots. `rolesDir=/app/services`; `templatesDir=/app/packages/agent-kit/templates`. Keep secrets directory root-owned 0700. Fixed permission provisioning changes only explicitly selected regular single-link files to root:10001 0440, so the non-root runtime can read file-backed compose secrets; it never grants directory traversal. Slack needs `<name>-slack-token` and `<name>-slack-signing-secret`; Telegram needs `<name>-telegram-token` and `<name>-telegram-webhook-secret`. Disabled/pending doors are allowed. Task17 must provide both fields before enabling a door, and changing a mounted secret requires explicit runtime reconciliation.
5. Set up the **owned** `lares-egress-proxy` with a directory mount `/config` and its pinned Squid image. Do not silently recreate the old fleet proxy: its single-file mount pins an obsolete inode after atomic replacement. Initial reviewed generated `squid.conf` must exist before starting the owned proxy. Existing/non-agent consumers and their endpoints must be migrated deliberately or retained explicitly. The separate digest-pinned nft helper uses host networking and only NET_ADMIN, applies only `inet saga_egress`, and never flushes the host ruleset. Manual installation must verify this owned table is the intended old seal before allowing takeover. `installationPrepared:true` records this prerequisite, not an automated migration.
6. Add generated agents and keeper compose paths to both drift-guard sources independently. The guard compares actual BOX to REPO and retains its explicit `--accept` flow. Review changed drift; never auto-accept generated writes. Git backup is optional and off by default; leave `agents.backup_remote` absent or blank to run without Git credentials. If enabled, supply a dedicated noninteractive credential for a private definitions-only repository and a verified known_hosts mount/config. Do not copy developer SSH credentials. Disabled backup is informational; a configured backup auth failure is separately returned after disk save. See [definition backups](../runbooks/definition-backups.md).
7. Approve a representative capacity measurement before setting `agents.ceiling`; the observed value 1 remains pending. No migration adopts it. No host override exists.

The runtime `proxyUrl` is passed to the actual Slack, Telegram, generic proxy-fetch and Google adapter environment contracts (`SLACK_PROXY_URL`, `TELEGRAM_PROXY_URL`, `EGRESS_PROXY_URL`), as well as HTTP/HTTPS proxy variables. Set it to the keeper-owned proxy's reachable address, including any nondefault port.

The owned proxy must use Compose `init: true` (or `docker run --init`). Squid refuses
`-k reconfigure` when its PID file identifies PID 1. Without init, the parser and startup
checks can pass while the first real keeper reconciliation fails during proxy reload.
Verify an actual reload before accepting the installation; no image rebuild is needed
for this Compose setting.

Generated schedules default **OFF**. The installation-only `lifecycle.runtime.schedulesLive` boolean defaults to `false` when omitted and emits `EVE_SCHEDULES_LIVE=0`. Only explicit `true` emits `1`; strings such as `"true"` are rejected. An enabled master still respects each definition's schedule switch. The console definition cannot enable the master. Example fields within the existing `lifecycle.runtime` object (retain its other required fields):

```json
{
  "proxyUrl": "http://lares-egress-proxy:8888",
  "schedulesLive": false
}
```

Enabling the master is a separate reviewed installation cutover: change the keeper configuration, reload keeper and explicitly reconcile the intended runtimes (restarts them). Review every existing definition's schedule settings first; an omitted schedule entry keeps the shared gate's historical enabled behavior once the master is on. Publishing compose for another agent does not itself restart existing agents. No migration or definition save automatically enables schedules.

## Existing-agent adoption (Task19 preparation, Task20 execution)

Task19 supplies offline preparation code, not accepted personal definitions or live registration rows. The strict Calliope persona gate currently fails on existing engine wording changes, so personal migration is blocked before Marcel and Saga. After the strict gate passes (or an explicit owner exception is recorded), Task20 must review exact `agent_resources` mappings against current state. Each row has `name`, existing IPv4 `address`, **existing** `workflow_database`, `ownership='legacy'`, a fresh UUID `ownership_token` (registry identity only; do not add owned database comments), `state='ready'`, `applied_definition` equal to the deployed validated definition JSON, `runtime_control_token=NULL`, `pending=true`, `pending_reason='Manual runtime adoption required'`. Saga keeps its shared workflow/domain database; Marcel and Calliope keep their existing dedicated workflow databases. Never clone their stores, drop shared standing_facts, or mark these legacy databases owned. Existing folder names with missing ownership records refuse runtime mutation instead of becoming new owned resources. Keeper refuses deleting legacy storage before Docker/database effects, even after runtime adoption. Legacy registration alone does not authorize runtime reconciliation, doors, the relay, or conversation controls.

Migration **045_agent_runtime_control.sql** separates runtime authority from storage ownership. It backfills authority only for existing `ownership='owned'` rows; new owned creation explicitly sets the token. Legacy rows default to NULL. The nullable `runtime_control_token` must equal the current `ownership_token`; changing incarnation cannot carry old authority across. No keeper action adopts a legacy resource.

Manual adoption is a reviewed transaction, performed only after the old service has been deliberately stopped/disconnected and its address released. Match **all** of exact name, current UUID, existing workflow database, existing address, `ownership='legacy'` and `state='ready'`; set `runtime_control_token=ownership_token`, `pending=true` and a reconciliation-required reason. Assert **exactly one affected row** and roll back on zero or multiple rows. Take the keeper namespace advisory lock (the same lock as definition actions) and keep keeper stopped or otherwise exclude concurrent operations while changing authority. Never change `ownership`, clone/rename the retained store, or add an owned database COMMENT. No registration/adoption SQL has been executed by Task19.

Only a successful explicit `definition.reconcile` clears pending, publishing the fixed `lares-<name>` service with the current incarnation label and full secret mounts. Failure leaves pending and routes/authority closed; operator inspects and explicitly retries. Unadopted rows stay in egress inventory but are excluded from generated compose, so updating another agent does not publish a replacement for them. Revocation sets the token NULL (and pending=true): subsequent controls/managed authority refuse. This is not a synchronous cancellation of already executing work, nor a stop of an old unmanaged service; stop/disconnect it explicitly as part of the manual cutover. Legacy database provisioning and deletion remain refused regardless of runtime authority.

The role digest map must point at compatible **runtime** images, not builders. Gateway/password/door files are installation-supplied per agent. Registering metadata is NOT the container cutover: current services `eve-saga`, `eve-marcel`, `eve-calliope` are not `lares-saga`, `lares-marcel`, `lares-calliope`. Task20 must deliberately stop/disconnect the old service and release its reserved address before starting its replacement, preserving rollback containers/images. Verify no duplicate writer, workflow replay, routes (`/eve/` and `/.well-known/workflow/`), real turn, sessions, schedules and memory before accepting the transition. Keeper never reconciles or removes those fleet service names. This is a manual migration gate, not a verified automatic transition recipe.

## Action and failure contracts

`definition.capacity {}` returns `{ceiling:number|null,activeCount,approved,creationAvailable}`. Null means unapproved/unconfigured; zero is distinct. Create requires capacity and installation lifecycle config. `definition.save` returns `runtime:{pending,reason}`; get/list also include `runtime`. A changed door/role contract returns `Apply connection changes (restarts agent)`. `definition.reconcile {name,hash}` is audited, compares the exact current valid saved hash, stops only that agent, validates/applies the generated seal, reloads Squid and then starts its owned service. Task16/17 must expose the restart meaning and pending result; a saved door is not necessarily an active mount.

Grant changes publish/reload egress on save immediately without ordinary container restart. Runtime tools remain session-pinned. Squid's changed ACL governs **new CONNECT requests**; existing tunnels may survive, and no connection-drain guarantee is made. Reload/validation failure stops the affected agent and leaves pending state; audit reports failure, not a successful grant revocation.

There is no transaction across disk, PG, firewall, proxy and Docker. Pending resource rows survive failures. Reconcile explicitly retries current desired state; it never guesses success. A crash after database CREATE but before its ownership COMMENT is ambiguous and refuses automatic reuse/deletion. An operator must inspect the journal and database before repairing metadata. Database names are random UUID identifiers, with matching registry token, PostgreSQL owner and database comment required before deletion; mismatches refuse before effects. Deletion plans are idempotent after a verified drop, and missing archived directories can resume from their exact persisted identity. A crash between final registry cleanup steps can leave a deleting resource tombstone requiring operator inspection; never reclassify it as a new incarnation automatically. Retirement preserves workflow data and shared owner facts.

Deletion also clears demonstrably agent-owned **current** authority/session state through `agent-current-state.ts`: ratchet, agent_registry, exact proactivity settings, exact/slash-prefixed heartbeat keys, sessions (their confirmations cascade), reminders, trigger_schedules, workflow_jobs, digest_requests and digest_skips. This fixed table map requires the baseline manual migrations before effects; it never accepts action-supplied SQL. The cleanup transaction sets local `lares.actor` to the authenticated action actor, so 038's ratchet DELETE trigger retains attributed history. Other agents, wildcard owner settings, audit/ratchet_audit/approval_events/initiations and shared owner facts remain. Task17 must extend this same cleanup contract for current claim/connection state before allowing slug reuse.

Rollback from a neutral runtime is **not** merely removing `LARES_DEFINITION_DIR`: that falls back to the engine's neutral persona. Task20 must retain and restore the pinned old personal overlay image/service/config, with its preserved workflow store and address, after stopping the replacement. Keep rollback containers/images and verify a real session after restoring the old route.

## Task16 builder and explicit conversation reset

Set the installation's `models.alias_prefix` string setting to its actual gateway alias prefix. The console refuses to offer a model picker without a valid setting; neutral `installation-*` template aliases are never used for creation. Apply manual migration **043_agent_conversations.sql** before installing the new keeper and runtime images. No ceiling is adopted by the builder; capacity remains unapproved until the owner approves a measurement.

The new runtime images contain an observe-only eve hook and a dedicated authenticated `/lares/runtime/conversations/reset` route. The hook records at most 500 recent root conversational session IDs per incarnation, no transcript; unmanaged/legacy runtimes without the identity variables do nothing. The owner sees up to 50 recent records, not a claim that all are still active. Existing sessions may not appear until a subsequent observed event. Missing projection data is not permission to guess an ID.

Keeper's explicit runtime reconciliation provisions a random per-agent `<name>-runtime-control` secret at root:10001 **0440**, mounts it read-only, and sets `LARES_AGENT_INCARNATION` plus the matching `lares.incarnation` container label from `agent_resources.ownership_token`. This is a new image/mount contract; existing agents need the reviewed Task20 migration and explicit reconciliation, not an automatic restart on ordinary save. The current incarnation's secret is never returned to the console. Ordinary reconciliation preserves it. Successful owned deletion removes it after storage ownership verification and before releasing the slug, so recreation generates a fresh credential. Legacy or mismatched database ownership refuses deletion before secret removal. The projection is included in owned-agent current-state deletion, while keeper reset audit history remains.

`conversation.list {name}` reads recent sessions for the current ready incarnation. `conversation.reset {name,incarnation,sessionId,confirm:true}` verifies the projection/resource join, then uses a fixed Docker exec program in the one container matching project, service and incarnation labels. The program authenticates to the runtime using its mounted dedicated secret and targets the exact immutable session ID. It cannot accept a command, host, path, or URL from the action caller. The runtime rechecks ownership before calling eve's documented `attachSession(id).reset`, and duplicate requests never follow a replacement address owner. Reset deliberately ends pending replies and approvals; the UI asks the owner explicitly, preserves durable history, and does not execute an approval. The next message to the released chat address starts fresh. A failure after sending can have an unknown outcome: inspect state, never automatically retry.

Repeatable local proof (disposable PostgreSQL, mock model, temporary app/workflow directory/free port, no provider calls): `pnpm -C services/keeper exec tsx tests/conversation-runtime.probe.mts`. This is an installed eve runtime proof, not a deployment or production-session reset.
