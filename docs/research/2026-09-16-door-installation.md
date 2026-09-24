# Door installation contract — Task20 manual acceptance

Preparation only. No public listener, production database, existing bot, OAuth grant, or agent deployment was changed. Apply manual migration **044_agent_door_connections.sql** after backup and migrations 039–043, then **045_agent_runtime_control.sql** before starting the new keeper/runtime/Console. The schema keeps current incarnation-bound connections and append-only claim evidence separately. Owned slug deletion clears current connections through keeper's existing cleanup transaction and retains claim/keeper audit history.

## Public ingress

The installation Console is currently private at 127.0.0.1:3000. Set the same explicit HTTPS origin in Console `LARES_PUBLIC_DOOR_ORIGIN` and keeper `publicDoorOrigin`; it cannot contain credentials, path, query or fragment. Review [the bounded nginx example](../installation/door-ingress.nginx.conf.example), supply TLS and an explicit private Console upstream, and expose **only** POST `/api/doors/<slug>/(slack|telegram)/events`. Do not expose the Console UI, auth/OAuth routes, eve HTTP API or runtime-control routes through that vhost. Do not apply this example until installation review.

Console needs private network reachability to registered runtime-authorized agent addresses on port 3000. Its relay chooses only `agent_resources` rows with current valid/applied enabled doors, private IPv4 and matching runtime_control_token=ownership_token; fixed role paths are creative Slack, travel Telegram, chief Slack/Telegram. It accepts no upstream URL, port or runtime path from callers. Limits: 256 KiB request, 64 KiB response, 8 s body/upstream deadline, 3 s database query timeout. Original raw bytes, content type and platform authentication headers survive; browser credentials and upstream cookies do not. Eve verifies Slack HMAC/timestamp or Telegram webhook secret before authored claim handling. Role routes remain private. Header presence alone is not authentication.

## Chat setup and claims

1. Create the agent with doors disabled. Creative supports Slack; travel supports Telegram; chief supports both plus email. Cross-role door unification is step 3.
2. Slack: open its generated manifest, create/install the app, then save the `xoxb-` bot token and 32-hex signing secret. Telegram: follow BotFather, save the bot token; keeper generates a 32-byte webhook secret. Pending secret files remain keeper-only 0600; explicit reconcile provisions root:10001 **0440** before mounting. The parent directory stays root-owned 0700. New managed runtimes refuse legacy credential fallback paths.
3. Enable the saved door and select **Apply connection changes (restarts agent)**. Saves do not restart. This mounts the full credential pair. Telegram webhook registration reads `getWebhookInfo` first and refuses another registered URL; the owner must preserve restoration data and disconnect an existing bot explicitly. Registration uses the generated secret and fixed URL, never a caller URL.
4. Request the one-time code, then send `claim CODE` as an ordinary private message to the agent, without a leading slash. Slack intercepts slash commands before they reach the bot; `/claim CODE` remains supported for clients that deliver it as message text. Codes expire in 10 minutes, are SHA256 hashes at rest, and allow at most 10 attempts. Verified claim consumption is atomic, serialized with lifecycle reconciliation, and scoped to agent, door and resource incarnation. The command never reaches model/session history. Issue and consumption cannot silently replace an already claimed chat owner.
5. Refresh status and explicitly apply again. Claiming itself does not restart. The new immutable principal/revision reaches existing admission and approval rechecks. Before apply, pending/disabled/stale/incarnation-mismatched authority fails closed, including native approval callbacks. Managed gated-tool policy also rechecks current authority on consultation; the real runtime probe covers an HTTP approval resumed after pending state changes. There is no automatic retry of uncertain actions.

Read `door.status` for pending versus applied state. Saved credential files are not connection proof. Shared database/network failures are not evidence of an unclaimed owner and never trigger permissive fallback. In-flight work already executing before a change is not synchronously cancelled by saving; use explicit runtime/conversation controls where required.

## Selected Google mailbox

Keep the existing Google OAuth client discovery/encrypted `oauth_tokens` store. Configure **explicit** Console `CONSOLE_PRINCIPAL_ID`, matching keeper `lifecycle.runtime.google.principal`. Managed flow refuses the old Console legacy principal fallback. Example keeper configuration addition:

```json
{"lifecycle":{"runtime":{"google":{"principal":"explicit-owner-principal","tokenKeyFile":"/etc/lares/secrets/token-key","clients":{"tenant":{"clientIdFile":"/etc/lares/secrets/google-tenant-id","clientSecretFile":"/etc/lares/secrets/google-tenant-secret"}}}}}}
```

These fields extend the existing complete lifecycle config; the fragment alone is not valid keeper config. Paths must be within explicitly mounted keeper-owned roots and readable by keeper. Console OAuth discovery must configure the same org/client and encryption key. Reconcile narrowly provisions/mounts the selected org's client files and token encryption key at root:10001 0440; it supplies explicit selected principal/org/mailbox/revision and Google proxy config. There is no synthetic email token file.

Google consent state signs agent+incarnation+authenticated session owner. Callback rechecks identity before storing real encrypted refresh tokens, then keeper verifies that exact mailbox/principal/org row exists and the installation client is configured. A partial token-store/agent-metadata failure is reported as possibly pending/incomplete, not rolled back or retried automatically. Existing Integrations flow/return remains unchanged.

Managed Gmail, Calendar, Drive and `listEnrolledMailboxes` check current connection authority and query/decrypt only the selected token. An explicit different account/principal is refused; a newest unrelated token cannot become the default. Unmanaged legacy org registry/behavior remains. Chief email-triage additionally needs an applied Slack owner door to deliver its cards, and its schedule must be enabled. Gmail/calendar always-ask policy remains in effect. Selected mailbox setup is not proof of successful delivery or a production schedule tick.

## Evidence and outstanding live acceptance

`services/keeper/tests/door-runtime.probe.mts` builds a disposable installed-eve mock runtime and uses disposable PostgreSQL; no gateway or provider call. `packages/board-evals/evals/doors.eval.ts` boots an actual disabled Telegram adapter with no token and completes a mock turn without outbound/credential attempts. Fixtures prove local behavior, not Slack/Telegram acceptance.

Slack official manifest reference: https://docs.slack.dev/reference/app-manifest/ and validator: https://docs.slack.dev/reference/methods/apps.manifest.validate/. Run the manual Slack probe with `SLACK_CONFIGURATION_TOKEN_FILE`; without it the probe prints a create URL and explicitly leaves human app-creation acceptance pending. No real app is created by the probe.

Telegram official method: https://core.telegram.org/bots/api#setwebhook. Run the probe only with a dedicated disposable `TELEGRAM_PROBE_TOKEN_FILE` and `TELEGRAM_PROBE_URL`. It refuses any existing webhook because getWebhookInfo does not expose its old secret/certificate. It restores the original empty URL with deleteWebhook without dropping pending updates, even after setWebhook uncertainty. No Saga/Marcel bot may be used. Dedicated live credentials were not supplied during implementation; **live provider validation remains pending Task20**.

Existing agents require the separately reviewed manual runtime adoption and cutover in [the lifecycle installation contract](2026-09-16-keeper-lifecycle-installation.md). A legacy storage row alone cannot authorize door setup or relay; runtime adoption does not authorize database deletion. Personal migration is still blocked by the strict Task19 persona gate.
