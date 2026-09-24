# eve-calliope deploy checklist

Calliope is an **on-demand** agent: no schedules, no background sweeps, nothing that runs
unless Bendik asks. That makes her cheap to deploy and easy to mis-verify — a healthy
container proves the server booted and nothing more. The things that break invisibly here are
her **Atlas grounding** (a wrong mount now throws instead of degrading, deliberately) and her
**approval cards** (formatters that stay inert without one startup call).

Box: `lares-agent-1`, `192.0.2.20`. Pinned container IP: **`172.18.0.26`** — the egress seal
is keyed to it, so changing it in compose silently unseals her.

## Before

1. **Disk**: `df -h /` on the box. Images accumulate ~1 GB per deploy and nothing prunes; a
   full disk takes Postgres down with it.
2. **Serial**: one box deploy at a time.
3. **`lares_calliope` exists and has the workflow schema.** She has her OWN workflow database
   (2026-08-17 cross-talk rule — see her `agent/agent.ts` header). The box has no
   auto-migrate:

   ```sh
   ssh root@192.0.2.20 "docker exec agent-box-db-1 psql -U lares -d lares_calliope \
     -c \"select count(*) from information_schema.tables where table_schema='workflow';\""
   ```

   Expect **6**. Zero means `sql/001-eve-workflow.sql` was never applied and every durable
   turn dies on its first query.

4. **`EVE_DEV` must be UNSET in her compose environment. Assert it, do not eyeball it:**

   ```sh
   ssh root@192.0.2.20 'docker exec agent-box-eve-calliope-1 env | grep -c "^EVE_DEV="'
   ```

   Expect **0**. She authors no `agent/channels/eve.ts`, so her `/eve/v1/session` route falls
   through eve's unauthored channel auth chain `[vercelOidc(), localDev(), placeholderAuth()]`.
   `placeholderAuth()` is inert on the box — it never produces a `SessionAuthContext`, so the
   route 401s for everyone and she is strictly *more* closed than eve-saga (which fronts HTTP
   Basic). But `localDev()` sits EARLIER in that chain and grants
   `{principalId: "local-dev", authenticator: "local-dev"}` whenever `EVE_DEV === "1"`. Her
   approval gate would still hold — `channelForAuthenticator` returns `undefined` for anything
   but `slack-webhook`, so `assertApprover` throws and both gated tools refuse — but her three
   **ungated** Vault reads (`vault_list`, `vault_read`, `vault_search`) would be open to
   anything on the tailnet.

5. **The bot token, at any deploy that follows a Slack manifest apply.** Her manifest adds
   `app_mentions:read`, and granting a new scope requires reinstalling the app to the
   workspace. Whether that reinstall returns the same `xoxb` value is not guaranteed. After
   applying the manifest, re-read the bot token from Slack and compare it against
   `/etc/agent-box/calliope-slack-bot-token` (`root:saga 440`) BEFORE starting her — otherwise
   she boots with a dead token and the failure reads like a door problem rather than a
   credential one.

   ```sh
   ssh root@192.0.2.20 'md5sum /etc/agent-box/calliope-slack-bot-token'
   ```

6. **Never remove `/etc/agent-box/calliope-slack-app-token`.** It is the rollback lever: turn
   Socket Mode back on in the Slack app and old Calliope (the `calliope:` compose block at
   `172.18.0.13`) resumes instantly.

## After

1. **Health** — eve's documented self-host route:

   ```sh
   ssh root@192.0.2.20 'curl -sf http://172.18.0.26:3000/eve/v1/health'
   ```

   Expect `{"ok":true,"status":"ready"}`.

2. **The egress seal, BOTH directions.** A blocked call surfaces as a **timeout/hang, never
   "not found"** — so when something looks missing later, check the seal before believing the
   absence.

   ```sh
   ssh root@192.0.2.20 'docker exec -i -e TARGET=192.0.2.10 agent-box-eve-calliope-1 node < /opt/agent-box/probe.js'  # OPEN   (gateway)
   ssh root@192.0.2.20 'docker exec -i -e TARGET=1.1.1.1     agent-box-eve-calliope-1 node < /opt/agent-box/probe.js'  # BLOCKED (hang)
   ```

3. **The Atlas mount is real and readable.** `ATLAS_PATH` unset, or a store that is missing or
   holds no markdown, now throws (`StorePathNotConfiguredError` / `StoreUnhealthyError`)
   instead of degrading into "no prior material found". That loudness is the point — she must
   not run ungrounded while sounding reasonable — but find it out from a probe, not from her
   first brief:

   ```sh
   ssh root@192.0.2.20 'docker exec agent-box-eve-calliope-1 sh -c "ls /srv/atlas | head -3; ls -d /srv/atlas.git"'
   ```

   `vault_write` additionally needs `/srv/atlas` to be a **git working clone with a reachable
   `origin`** (that is what `/srv/atlas.git` is), not merely a directory — a push failure
   throws `VaultPushFailedError` rather than being swallowed.

4. **The relay reaches her, and nothing else does.** The negative test is a deliverable, not an
   afterthought:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' \
     -d '{}' https://calliope.example.com/eve/v1/slack
   ```

   Expect **401** — the request reached eve and eve rejected it for a missing signature. Check
   the **body**, not just the status: eve's own 404 is JSON
   (`{"error":true,…"Cannot find any route matching…"}`) and means it arrived; nginx's 404 is
   the stock HTML page and means it never left ops-1.

   `/eve/v1/health` on her public hostname must 404 — the relay block exposes exactly one
   exact-match location.

5. **Traces.** Query from **inside the box**, by service name `eve-calliope`. Her spans land in
   the Langfuse project `lares-agents`, which is NOT the project a Claude session's Langfuse
   MCP connector is bound to; two sessions have already concluded "traces never land" from an
   empty MCP query against the other project. Recipe:
   `docs/solutions/2026-08-17-langfuse-traces-were-never-missing.md`. The container also says
   so at boot: `[instrumentation] exporting traces to … as "eve-calliope"`.

6. **Approval cards read like sentences.** `agent/instrumentation.ts` calls
   `registerApprovalSummary()`; without it her `vault_write` card degrades to
   `Approve tool call: vault_write` with the derived path buried in collapsed JSON. First
   gated tool call after a deploy is the check.

7. **Drift guard**: `ssh root@192.0.2.20 '/usr/local/bin/compose-drift-guard.sh --accept'`
   after every deliberate compose change.

## What this deploy does NOT need

- **No `.well-known/workflow` tailscale-serve path.** Established from source, not assumed:
  with `@workflow/world-postgres`, the queue resolves its own execution base URL as
  `http://localhost:<port>` and POSTs the flow callback to itself
  (`@workflow/world-postgres/dist/queue.js`'s `getExecutionBaseUrl()` →
  `createWorkflowUrl(baseUrl, {type:"flow"})`). The callback never leaves the container, so it
  never traverses tailscale. Confirmed live: eve-marcel has **no** such serve path and 58
  workflow runs in `lares_marcel` are `completed`, the most recent the same day this was
  checked. The only thing that needs an externally reachable `/.well-known/workflow` is
  `createWebhook()` — a URL handed to a third party — and Calliope creates none.
- **No `CALLIOPE_LIVE`.** Nothing in this service reads it; it is the OLD runtime entrypoint's
  gate (`services/agent-runtime/bin/calliope.ts`). eve apps gate per feature
  (`EVE_SCHEDULES_LIVE`, `EVE_DREAM_LIVE`, `EVE_DIGEST_LIVE`) and she has no schedules at all.
- **No `VAULT_PATH`, no `/srv/brain` mount.** That absence is her least-privilege line and her
  test suite asserts it. She grounds on the business Atlas only, never the personal Brain.
- **No squid change.** She reaches `.slack.com` and `cloud.langfuse.com`, both already
  allow-listed in `services/box/proxy/squid.conf`.
