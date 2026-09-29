# Fresh-install golden-path runs

This ledger records what a blank-server run actually proved. A partial run is not a release sign-off. The [tested install path](../decisions/0022-the-tested-install-path.md) and [golden-path design](../specs/2026-09-03-fresh-install-golden-path-design.md) define the intended scope; the latter predates the web-chat-first decision, so its Slack-first order is historical.
The current next-session order and destructive-test boundary are in the
[28 September handoff](../design/console-lar50-next-session-2026-09-28.md).

## 2026-09-25 — partial first-conversation checkpoint

| Item | Observed result |
| --- | --- |
| Candidate | Public `main` and test server at `8417f0c`; `releases/2026-09-25-test.2.json` installed. |
| Environment | Throwaway Hetzner `lares-install-test` server in Helsinki, CPX32, IP `2.29.59.136`; `lares.heiberg.co` pointed to it during the run. |
| First checkpoint | The owner reported Google sign-in, creation of the `install-proof` agent, and one provider-backed web-chat reply succeeded. The agent reached the ready state. |
| Console refresh | The refreshed `/chat/install-proof` page loaded, but showed an empty transcript. The earlier reply could not be inspected to confirm that the “something this page cannot show yet” marker was gone. The local transcript regression test covers the Eve step marker; it is not live browser proof. |
| Remaining LAR-50 work | Calendar and Gmail read checks, first brief or freshness heartbeat, a backup and restore rehearsal, and a complete docs-only run remain unproved. |
| Teardown | After owner confirmation, the Hetzner server and both Primary IPs were deleted. The project showed no servers or Primary IPs afterward. There were no Hetzner backups or snapshots. |
| DNS | The owner chose to keep the `lares.heiberg.co` A record for later reuse with his real IP. It still pointed to the retired test IP when this run ended. |

This was a useful first-conversation proof, not completion of LAR-50. The next paid test window needs its own candidate, explicit scope, and acceptance record.

## 2026-09-28 — fresh install and model checkpoint (in progress)

| Item | Observed result |
| --- | --- |
| Candidate | PR #32 source `6889c0e2df775735cddced0986ffb49ff576bf15`; manual image workflow [run #36](https://github.com/Heiberg-Industries/lares/actions/runs/36394359750) succeeded. The console image `ghcr.io/heiberg-industries/lares-engine-console@sha256:e410a61fe004a87facce6435da64c36dfd5377a2642ece1b1df5df4cf2570f34` was pulled anonymously by the test server. The test-only release manifest `2026-09-28-console-test.1` pins that image and box migration `089_agent_avatars.sql`; it was not made a public release. |
| Environment | Owner-provisioned blank Ubuntu 24.04 server `lares-install-test-2`, IP `89.167.43.7`, with `lares.heiberg.co` already pointed to it by the owner. The approved `lares.is` site and its repository were untouched. |
| Fresh-install repair | The first real installer attempt generated secret files, then stopped before containers or a provider call because host `pnpm` was missing. The dry run had not checked this. Installed checksum-verified Node 24.21.0, pinned pnpm 9.15.0, Ubuntu build tools, and frozen-lockfile dependencies in the isolated source checkout; the resumed installer preserved the generated secrets. The installer preflight now checks for host Node, pnpm and box dependencies before writing anything; its focused test passed. This repaired source still needs a clean blank-server rerun. |
| Installer result | The resumed installer completed. The gateway made one real Claude Opus 5 completion; all 74 box migrations through `089_agent_avatars.sql` applied; owner `bendik` and the first organisation were created; db, console, gateway, Caddy, Keeper and egress proxy started. Public `/api/auth/login` returned 307 with valid TLS. The installer correctly ended at `/agents/new` without claiming an agent or conversation. |
| Spend | LiteLLM's local `LiteLLM_SpendLogs` showed one call, 20 tokens and USD 0.00018 at this checkpoint. The owner approved a USD 5 API test ceiling. |
| Browser handoff | Google offered `bendik@heiberg.co`; the automated Chrome tab blocked its OAuth callback with `ERR_BLOCKED_BY_CLIENT`. Normal Chrome then showed `Auth failed`. A server-side test with an intentionally invalid authorization code returned Google's `invalid_client` for the saved credentials. The owner replaced the secret through a hidden SSH prompt; the same test returned `invalid_grant`, confirming Google accepts the client credentials. After restarting only the console, the owner signed in and the authenticated Home page loaded. No credential value was logged or copied into this ledger. |
| First agent | The authenticated wizard created `console-proof`, Chief of Staff, with zero granted capabilities, skills or schedules. The create request timed out in the UI with an unknown outcome; its recovery link led to the persisted edit page. The agent container was running and registered at 08:30:14 UTC. There was no second create attempt. Agent search miss/clear, overview, access, schedules and activity tabs loaded; a description edit saved and persisted after reload. The timeout is a real user-facing defect even though creation succeeded. |
| Provider-backed chat | One short web-chat turn with `console-proof` returned a real reply and the transcript survived a page reload. New conversation showed an empty state. The gateway then recorded two calls total, 6,687 tokens and USD 0.04214625, below the owner-approved USD 5 ceiling. Reload during a pending reply, approval replay and cross-agent isolation were not proved. |
| Installed screens | Home, Agents, agent detail/edit, Chat, Activity, Connections, Settings, Backup, Deadlines, Saved preferences, Market watch, Proactivity, Signals, signal routes/catalogue, Meeting follow-ups and Email writing style were opened under the owner session. Deadlines, Market watch and Proactivity first failed with the generic unavailable page; Settings could not load quiet hours or time zone. Console logs named a missing `AGENT_OWNER_USER_ID`. The installer had created `bendik` but omitted that owner identity and `OWNER_HOME_TZ` from the console container. PR #32 commit `08c8259` now renders both; 45 focused installer tests and box typecheck passed. The test stack was re-rendered from that source and only the console recreated; the same screens then loaded with empty data and Settings showed 21:00–07:00 quiet hours. This is a manual repair of the initial install, not clean first-install proof. |
| Google account and agent connection | The owner approved the data callback and consent for `bendik@heiberg.co`; Connections displayed one live mailbox with five scopes. The owner separately approved binding that mailbox to disposable `console-proof` and enabling only Gmail and Calendar capabilities. The OAuth callback stored the token but reported incomplete agent connection. The installer-generated Keeper configuration had no `lifecycle.runtime.google`, so `email.connect` refused it. Root-only test configuration and client files were added manually, Keeper restarted, and its audited `email.connect` succeeded without repeating consent. The first agent apply failed because the new client files were `0600`, while Keeper's read-only mount requires pre-provisioned root:10001 `0440`. After correcting those modes, the apply succeeded at 09:01 UTC, though the console's 10-second request timed out before reporting success. A reload showed “Owner connection applied,” no pending changes, Gmail and Calendar selected, and all schedules off. These are manual repairs, not clean installer proof. |
| Calendar and Gmail read | A bounded web-chat request asked for counts only, with no titles, senders, bodies or writes. The agent's persisted response named `calendar_list_events` and `gmail_search`, reported successful calls, one event today in Europe/Oslo and 185 unread messages. Two tool parts are present in the live transcript, but the deployed console renders each as “something this page cannot show yet”; PR #32 source now names ordinary tool calls without showing private results. This is provider-backed agent-reported read evidence; a separate API trace or independently inspected tool result was not captured. No write was requested. The reply survived page reload. |
| Spend after Google read | LiteLLM's local `LiteLLM_SpendLogs` showed four calls, 38,067 tokens and USD 0.22890675 total, under the owner-approved USD 5 ceiling. |
| Remaining configuration and protection | The installer recorded `Etc/UTC` from the server as the owner time zone; the owner selected `Europe/Oslo`, and the test installation was changed manually. Deployed Connections still shows catalogue Workspace A/B cards; PR #32 source now derives Google cards from actual clients and accounts, pending a new image check. Signals and its routes/catalogue report the spine unavailable. Backup reports “Not protected,” with no nightly verification or restore drill. CRM status is unavailable. Several empty tool pages still contain fleet-specific names or infrastructure paths on this blank installation; these need a separate copy/product review. |
| Source follow-up | PR #32 now includes an explicit root-only `configure-google-keeper.py` operator step for data clients, tested by a dry run against this installation and a credential-free synthetic write/idempotence run. It was not used to repair the live configuration. The current installer still replaces the Keeper configuration on rerun, so this step must be repeated after an installer rerun; the next clean docs-only run must prove that handoff. |
| Console-only update | The owner approved one further test image from exact PR #32 commit `7c5bc766663402cdfe1735e3343d6461bca8a093`. Manual console-image [run #36404384528](https://github.com/Heiberg-Industries/lares/actions/runs/36404384528) completed successfully and published `ghcr.io/heiberg-industries/lares-engine-console@sha256:acc7ef42829df2644466d393e611c16842c2ae8ae755a8109254daf709c4b15a`. The server anonymously pulled that digest; `/opt/lares/compose.yaml.pre-7c5bc76` retains the prior pin. Only `console` was recreated. The full stack remained up and public `/api/auth/login` returned HTTP 307. No migration or further provider call was made. |
| Updated installed UI | After reload, the persisted chat shows `calendar_list_events completed` and `gmail_search completed` in place of the unsupported-part marker. Connections shows the single configured Google client/account (`heiberg`, one mailbox, five scopes) rather than example Workspace A/B cards; other catalogue integrations remain mostly unknown and the CRM status remains unavailable. Settings still displays Europe/Oslo and 21:00–07:00 quiet hours. `/agents/new` opens, but the installed one-agent capacity is occupied by `console-proof`, so a second creation was not attempted. These observations do not prove pending chat, approval replay, all tool states, or a clean creation outcome. |
| One-server test option | LAR-50's stated acceptance asks for a complete documented fresh install and a rehearsed backup/restore; it does not require two simultaneously running physical servers. The owner proposed discarding this first, disposable installation and rebuilding the same server with a clean OS. Its first-test data need not be preserved for the golden path. After the **new** install has the agent, connected account and brief/session records to check, make and verify an encrypted export **off the box**; then reprovision and restore onto that new installation. This proves the workflow across separate installations on the same machine, though not recovery from physical host failure. No rebuild, export or restore has been run in this checkpoint. |
| Export audit for the later rehearsal | The current installation uses `/opt/lares/compose.yaml`, `/etc/lares` and `/srv/lares`, including `/srv/lares/secrets`; it has no Docker named volumes and Backup says “Not protected.” The existing `services/box/ops/export.sh` hard-codes the older `/opt/agent-box` compose pair and its nested-secret filter would not exclude `/srv/lares/secrets` merely by name. It must **not** be run against `/srv/lares` as-is. Repair and test a current-install export plus external encryption/escrow, checksum and restore prerequisites **before the second reprovision**, when the new install's data will be needed for the restore comparison. |
| Prepared next candidate | `releases/2026-09-28-console-test.2.json` pins the successfully published `7c5bc76` console digest and the same proven base, Keeper and role image digests, with migration `089_agent_avatars.sql`. This is a test manifest on draft PR #32, not a public release. The owner has not yet rebuilt the server or run this manifest through a clean install. |
| Remaining LAR-50 work | Clean docs-only rerun with host prerequisites, owner environment and Google Keeper setup; first brief/freshness heartbeat; pending-chat reload, approval replay and cross-agent isolation; configured-data and failure states of the installed screens; off-box backup escrow and a restore onto a newly provisioned installation (the same physical server may be reused sequentially); final teardown evidence. Keep LAR-50 open. |

## 2026-09-28 — same-server clean reinstall attempt (in progress)

| Item | Observed result |
| --- | --- |
| Rebuild | The owner rebuilt Hetzner server `lares-install-test-2` (#167781592) with Ubuntu 24.04. Hetzner activity reported success; SSH reached the same IPv4 `89.167.43.7` with a newly pinned host key. `/srv/lares` and `/etc/lares` were absent on first login. No prior test data was exported; the owner identified it as disposable. |
| Host preparation | Installed Ubuntu packages `docker.io` and `docker-compose-v2`, build tools, Git, curl and Python; set Europe/Oslo; installed checksum-verified official Node v24.21.0 and pinned pnpm 9.15.0. The checkout is pinned to PR #32 source `4d8d00d` with frozen-lockfile dependencies. The manifest `2026-09-28-console-test.2` has ten digest-pinned images and migration `089_agent_avatars.sql`; its console image was already anonymously pulled in the previous installation. |
| Preflight corrections | Ubuntu's package is `docker-compose-v2`; the earlier installer suggestion named `docker-compose-plugin`, which `apt` could not locate on this image. A noninteractive `--dry-run` also refused before checks unless given `--yes`. PR #32 source `4d8d00d` corrects both; 26 focused restore/preflight tests passed. A source checkout on the rebuilt server then ran `install.sh --dry-run` without `--yes`, exiting 0 and reporting that nothing was changed. |
| Real install | The owner ran the real installer from detached source `4d8d00d` with saved Google sign-in credentials and an Anthropic key entered through a hidden terminal prompt. Six base containers started, `/api/auth/login` answered over verified HTTPS, the model check recorded one LiteLLM call (USD 0.00018000), and the `lares_state` migration ledger reached `089_agent_avatars.sql` (74 entries). The fresh `bendik@heiberg.co` member existed. |
| Sign-in correction | The first Google redirect returned `invalid_client`. A diagnostic of field shape only found that the public client ID had a 13-character adjacent JSON fragment after its `.apps.googleusercontent.com` suffix. I removed that fragment atomically from `/etc/lares/console-oauth.env` without changing or displaying the secret, restarted only the console, and signed in successfully as `bendik@heiberg.co`. PR #32 now has a preflight format check for this copied-JSON case; the tested live installer predates that fix. |
| First agent and chat | Created `console-proof` through the browser as a chief-of-staff agent with only Gmail and Calendar integration capabilities; all schedules and other capabilities were disabled. Its container became healthy. The create action took roughly a minute. The first chat page initially said its conversation could not be reopened; **New conversation** cleared it. A real provider-backed chat reply then appeared, and the transcript survived a page reload. The UI labelled the optional Git definition backup as failed; source inspection shows absent `agents.backup_remote` returns `disabled`, so PR #32 now distinguishes that state in the first-chat notice. The current test image still shows the old wording. |
| Time zone | The rebuilt host's active time zone was Europe/Oslo, but `/etc/timezone` remained Etc/UTC; the installer read that stale file first and wrote UTC into its installation settings and console stack. I atomically set `OWNER_HOME_TZ=Europe/Oslo` in the test installation and recreated only the console; Settings then showed Europe/Oslo and 21:00–07:00 quiet hours. PR #32 now prefers the active `timedatectl` value. The tested live installer predates that fix. |
| Local export checkpoint | The Backup screen said **Not protected**. The old export script targeted `/opt/agent-box` and its broad data default would reach `/srv/lares/secrets`. PR #32 now targets `/opt/lares/compose.yaml`, defaults to portable `agents` and `retired` trees, refuses nested secret paths, and includes all non-template databases including `postgres`. A local-only export was run from that corrected script on the rebuilt server. Its archive `/var/backups/export/lares-export-2026-09-28.tar` contains five database dumps, globals and two data tars; all eight manifest entries matched their size and SHA-256, and no credential path was included. Archive SHA-256: `b0f1d8aa33cb398c2400fd9d380e5c0bef6a00fa313a6a72a77da492e1d8c37c`. It contains sensitive data, remains on the server, and is **not** off-box protection or restore proof. |
| Encrypted off-box copy | After exact owner approval, I streamed the archive and a separate `/etc/lares` configuration tar over pinned SSH into age-encrypted files under `/private/tmp` on the owner's Mac. The age identity and both ciphertext files have mode 0600. Decrypting the archive stream reproduced SHA-256 `b0f1d8aa33cb398c2400fd9d380e5c0bef6a00fa313a6a72a77da492e1d8c37c`; the configuration ciphertext decrypted to a tar with 19 entries. No plaintext archive or configuration copy was written to the Mac. These temporary copies are for the restore rehearsal and must be removed afterward. This proves encrypted transfer and integrity, not restoration. |
| Installed screen spot checks | Home showed the fresh zero-agent state; after creation Agents showed one `console-proof` agent with two capabilities, and its Access/Schedules tabs reflected the chosen permissions and disabled schedules. Connections showed a missing Google data client and permission rows set to **Ask first**. Settings showed Europe/Oslo after the manual repair, with quiet hours 21:00–07:00; Backup showed **Not protected**. Activity and Deadlines loaded empty states, and the Add deadline form opened. Market watch loaded with refresh off. Saved preferences loaded, but its body remains Norwegian and exposes an internal `/srv/taste` path on this English installation. PR #32 now corrects page, import, maintenance and pin-audit copy; the deployed test image still has the defect. Other installed states still need review. |
| Freshness heartbeat | Temporarily enabled only `morning-brief` in the `console-proof` definition and set that agent's `EVE_SCHEDULES_LIVE=1`, then recreated only its runtime. The `saga/morning-brief/tick` row advanced to `2026-09-28 11:05:00.090674+00` (13:05 Europe/Oslo); the pass row remained at migration time, and no Telegram owner door was configured. This proves a live scheduler tick, **not** a delivered brief. I then disabled the saved schedule, reset `EVE_SCHEDULES_LIVE=0`, and recreated only the agent. |
| Google account and agent reads | The owner saved a `heiberg` data-client pair through hidden SSH prompts and ran `configure-google-keeper.py`. The owner completed Google's five-scope consent for `bendik@heiberg.co`; Connections showed **live, 1 mailbox, 5 scopes**. The automated tab blocked a second agent-specific consent start, but the owner had already approved binding this disposable agent. Keeper's audited `email.connect`, definition save and reconcile actions bound the stored account and restarted only `console-proof`. Its editor then showed **Owner connection applied** and Gmail/Calendar permissions **Ask first**; all other capabilities and schedules remained off. A live chat request completed `gmail_search`, `calendar_list_events` and `calendar_conflicts`, returned only inbox and next-24-hours event counts, and made no write request. The transcript survived reload. |
| Refreshed export and partial restore | After the Google read, the corrected export script produced a new 675840-byte archive with five database dumps, globals and two portable data tars. All eight manifest entries matched size and SHA-256, and no credential path was included. Archive SHA-256: `50ba122d508c0df515aa0794910274dc25011da2af9a74a4a7936425077b29f1`. The age-encrypted off-box copy decrypted to the same checksum without plaintext on the Mac. Separate scratch databases replayed all five dumps: `empty_workflow` 8 tables, agent workflow 13, `lares_state` 69, `litellm` 78 and `postgres` 0. Key `lares_state` row counts matched the original: `agent_definitions` 1/1, `oauth_tokens` 1/1, `agent_conversations` 1/1 and `heartbeat` 32/32. Every scratch database was dropped. This proves dump replay, **not** a fresh installation restore. The `/etc/lares` escrow was refreshed **after** Google data-client setup and now has 21 entries, including that client's credential files; its decrypted stream SHA-256 `df2b174e9bb488e077e93c66d233884370a3180d73f3f97de9fbae24147ab49b` matched the source stream. `/srv/lares/secrets` is excluded and runtime key regeneration remains to be tested. |
| Provider spend | The rebuilt installation's LiteLLM spend ledger recorded four calls totaling USD 0.18612325 after the Google read. Combined with USD 0.22890675 from the earlier deleted test installation, observed cumulative test spend is USD 0.41503, under the approved USD 5 ceiling. |
| More screen checks | Settings linked to Proactivity, Backup, Email writing style and Signal routes; Connections linked to Meeting follow-ups. Backup correctly said **Not protected**, Signal routes said the spine was unavailable, and the other pages loaded empty and configured controls. Proactivity incorrectly displayed DND controls for Saga, Marcel and Calliope on the fresh installation; Meeting follow-ups referred to Saga. PR #32 now derives proactivity agent scopes from valid installed definitions and uses generic meeting copy, with 77 focused proactivity tests and typecheck passing. The deployed image has not been refreshed to show these fixes. Email writing style still offers legacy learn-key choices and its learn workflow is not live-verified. |
| Signals, Home and Agents | `/signals` and `/signals/catalogue` explicitly reported the spine unavailable; the routes did not present missing data as an empty success. Home and Agents showed the one `console-proof` agent, two capabilities, no active workflow, and no recorded permission checks. The one-agent creation ceiling remained visible. These are empty/configuration states, not proof of populated Signals delivery or actionable approvals. |
| Remaining gate | Rehearse restore onto a newly provisioned installation, verify the remaining console screens and configured states, then perform full teardown evidence before closing LAR-50. The current test image predates several PR #32 source fixes. Keep provider spend under the approved USD 5 cumulative ceiling. |

## 2026-09-28 — same-server fresh-target restore rehearsal

| Item | Observed result |
| --- | --- |
| Target identity | Hetzner activity showed `lares-install-test-2` (#167781592) rebuilt again with Ubuntu 24.04. The ED25519 fingerprint read inside Hetzner's authenticated web console matched the new network key, `SHA256:b0kEtrucjakeElxU2VLJGyg6red6OladrqG+OBmj/KI`; SSH was pinned to it. First login found `/etc/lares`, `/srv/lares`, `/opt/lares` and the old source checkout absent. The owner had reset a temporary root console password to obtain the in-console fingerprint; `sshd -T` reported `permitrootlogin without-password`, so root password SSH login remains disabled. |
| Fresh host and stack | Installed Ubuntu `docker.io`, `docker-compose-v2` and build tools, checksum-verified official Node 24.21.0 and pnpm 9.15.0. Set Europe/Oslo and checked out exact draft PR #32 source `2d3031c024cc5e2a9db0acf41b7190ea28ed873d`; frozen-lockfile install and installer dry run passed. Streamed the prior age-encrypted `/etc/lares` escrow over pinned SSH, initially extracting only installation settings, OAuth client and secrets. The real installer used `2026-09-28-console-test.2`, preserved those files, made one real provider model-check call, migrated through `089_agent_avatars.sql`, and completed at the first-agent page. This proves a blank-OS install with restored answers and credentials, not a new owner's four-question entry. |
| Database restore | Stopped Keeper, egress proxy, console, gateway and Caddy; kept Postgres running. Decrypted the age archive over pinned SSH into a root-only temporary directory. All eight manifest entries passed exact size and SHA-256 checks. Recreated the four non-`postgres` databases, loaded their dumps using the pinned database container's `pg_restore --exit-on-error --no-owner --no-privileges`, and replayed the empty `postgres.dump` into the existing `postgres` database. Table counts matched the pre-rebuild scratch proof: `empty_workflow` 8, agent workflow 13, `lares_state` 69, `litellm` 78, `postgres` 0. `lares_state` restored one agent definition, one OAuth token, one conversation and 32 heartbeat rows. The fresh Postgres role already existed and used the escrowed password, so `globals.sql` was verified in the manifest but not replayed. |
| Files and runtime recovery | Extracted `agents.tar` and `retired.tar` into the empty `/srv/lares` trees, then restored the complete 21-entry `/etc/lares` escrow. After the stack restarted, the old LiteLLM `lares-agent-console-proof` key alias remained in its database but its plaintext file under `/srv/lares/secrets` had intentionally not been exported. Keeper's first audited reconcile failed before changing the resource state. A schema/count check found exactly one obsolete hashed key; the local LiteLLM API removed only that hash (HTTP 200, alias count 0). An audited retry generated the new per-agent gateway and runtime-control files, reconciled `console-proof`, and returned `pending: false`. This key-rotation step is required for the current export design; it must be documented and automated or guarded before calling this a general restore path. |
| Live restore proof | All base services and `console-proof` started. The previous owner browser session, one-agent Home, stored chat turns and Google connection survived. A new provider-backed chat turn completed `gmail_search`, `calendar_list_events` and `calendar_conflicts`, reported only 25 inbox messages and three next-24-hour events, and made no write request. That new turn and the old transcript survived browser reload. Connections showed one live mailbox with five scopes; Gmail and Calendar agent permissions remained Ask first. The restored OAuth encryption key therefore supported real provider reads, beyond row-count proof. |
| Spend and remaining gates | The restored gateway recorded two post-restore calls totaling USD 0.11340975. The prior observed cumulative test spend was USD 0.41503; the fresh install's model-check call occurred before the old gateway database replaced it and is absent from the restored spend ledger. Total known spend is at least USD 0.52843975 plus that one small check, below the USD 5 ceiling. Backup still has no nightly protection. The deployed console image predates later PR #32 source fixes; source design completion, every configured tool state, pending-chat reload, approval replay, cross-agent isolation, a full docs-only first install, and teardown remain open. LAR-50 stays In Progress. |
| Temporary escrow cleanup | After the new Google reads and chat reload passed, the root-only `/var/tmp/lares-restore` extraction was removed. The two temporary age ciphertext files and their identity were removed from `/private/tmp` on the owner's Mac, as approved for this rehearsal. The live disposable installation remains running and still reports **Not protected** until a separate backup schedule is configured. |

## 2026-09-28 — exact console candidate after restore

| Item | Observed result |
| --- | --- |
| Candidate | Owner approved one console-only GHCR publication from exact PR #32 commit `b29fe92208f1952c2584cf6f2d5a654c4a32e529`. [Workflow #36423360122](https://github.com/Heiberg-Industries/lares/actions/runs/36423360122) passed; its published `linux/amd64` digest is `ghcr.io/heiberg-industries/lares-engine-console@sha256:1aaeb010fc5b4dd994b970385577cfe75acdd71df9b3343d4349b2b4f3b50b7c`. The anonymous pull on the server returned the exact approved source revision label. `releases/2026-09-28-console-test.3.json` records that digest with the unchanged remaining image and migration pins. All PR #32 source checks for this commit passed, as did local console typecheck, focused voice tests and production build. |
| Console-only update | Copied `/opt/lares/compose.yaml` to `compose.yaml.pre-b29fe92`, replaced its one console image pin, validated compose, and recreated only `console` with `--no-deps`. The first substitution command stopped at `sed` before changing compose or containers because its delimiter appeared in the image reference; a corrected command completed. The database, gateway, Keeper, agent, egress proxy and Caddy remained running. Public HTTPS `/api/auth/login` returned 307. No migration, new OAuth consent or provider call was part of this update. |
| Installed browser check | Authenticated Settings still displayed Europe/Oslo and 21:00–07:00 quiet hours. Connections now showed the one live Google mailbox with five scopes and actual `console-proof` agent access instead of catalogue fleet names; Notion displayed “No sync run recorded” with no obsolete `/opt/agent-box` recovery command. Email writing style showed only live lookback and message-cap settings, with no inactive model or learn-key choices. Home, Agents, agent detail/edit, Chat, agent creation at one-agent capacity, Activity, Deadlines, Saved preferences, Market watch, Proactivity, Backup, Meeting follow-ups, Signals, routes and catalogue were reopened. Their configured or empty states loaded; Signals explicitly reported its missing spine, CRM status was unavailable, Backup still said **Not protected**, and Email writing style had no learned mailbox cards. Restored Chat still displayed its prior and post-restore read-only tool turns. Desktop Agents/Chat and phone-size Agents/Chat/Connections were visually checked; the phone Chat composer was reachable by page scroll. No approval action or new model request was sent in this browser sweep. |
| Writing-style save | Saved the existing 365-day lookback and 300-message cap in the installed console. The UI reported **Saved**; both values persisted after page reload. This exercised the bounded settings write without starting a Sent-mail learn run or a provider call. |
| Remaining acceptance | The latest console is now installed, but the one-agent ceiling prevents a second live agent. Pending-reply reload, approval replay, cross-agent isolation, avatar persistence, live edit/retire/delete, populated or failed tool states, a Sent-mail learning pass, a fully docs-only four-question install, nightly backup protection and final teardown remain unverified. Keep PR #32 draft and LAR-50 In Progress. The live server is still disposable and running. |

## 2026-09-28 — current-image continuation before any rebuild

| Item | Observed result |
| --- | --- |
| Fresh state check | GitHub PR #32 was open and draft at `8c57fd8d444b25db0d9eb40db9a8e62fef091614`; its tests workflow `36424837496` completed successfully. Linear LAR-50's description still required further acceptance, but its status had been changed to Done at 12:56 UTC. The status was corrected to In Progress at 13:02 UTC. Pinned-SSH read-only inspection found `lares-install-test-2` running all seven expected containers. The running `lares-console-1` image reference, image ID, repository digest, compose pin and OCI revision all matched the approved digest `sha256:1aaeb010fc5b4dd994b970385577cfe75acdd71df9b3343d4349b2b4f3b50b7c` and source `b29fe92208f1952c2584cf6f2d5a654c4a32e529`. |
| Current-image pending-reply and reload | In the authenticated Chrome owner session, a bounded read-only prompt requested only Gmail inbox and next-24-hour Calendar counts. Reloading while the reply was pending recovered the same conversation and showed completed `gmail_search`, `calendar_list_events` and `calendar_conflicts` parts while the agent was still answering. The final reply reported successful reads and counts only; a second reload recovered the complete new turn and all earlier turns. No provider write was requested. This proves the pending and completed reload path on the installed `b29fe92` image for this one agent, not approval replay or cross-agent isolation. |
| Edit and connection states | The `console-proof` description was changed with the live editor, saved, and observed after reload, then restored to its original text with another successful save. The editor retained Gmail and Calendar as its only enabled capabilities, both **Ask first**, with the selected owner mailbox and applied connection. Connections showed one live Google mailbox, five scopes and actual `console-proof` agent access; expanded details separated built-in catalogue consumers from confirmed running agents. Settings still displayed stacked groups, Europe/Oslo and 21:00–07:00 quiet hours. The retire dialog described preserved workflow data; the delete dialog required typing `console-proof` and warned that owned data removal cannot be undone. Both dialogs were cancelled; lifecycle persistence was not exercised. |
| Spend | Before this new turn, the restored LiteLLM ledger showed six calls and USD 0.299533. Afterward it showed eight calls and USD 0.42528125, an increase of USD 0.12574825. Adding the earlier deleted installation's USD 0.22890675 gives at least USD 0.654188 known cumulative spend, plus the small model-check call lost when the restored database replaced the fresh one. This remains below the owner-approved USD 5 ceiling. |
| Remaining exact-image limits | The one-agent capacity still prevents cross-agent isolation. A generated 128px PNG was prepared for the avatar check, but Chrome's automation file chooser rejected `setFiles` before upload; no image reached the server. Avatar persistence, a real approval replay, actual retirement/deletion recovery, account removal/reconnection effects, populated/failure tool states and a Sent-mail learn run have not been proved here. The restored installation remains running with its agent and Google connection intact; no rebuild has been started. |
| Owner avatar feedback | The owner then used Chrome's native file picker. A screenshot of the installed editor showed **Image saved.** after submission, but the Agent image section had no preview, so the owner could not see the uploaded image there. A later screenshot showed the same controls without that message. This does not establish visual persistence after reload or confirm where else the avatar rendered. PR #32 source now adds an editor preview; focused tests, typecheck and build pass locally. The fix is not in the installed `b29fe92` image. |

## 2026-09-28 — compact console image on the disposable installation

| Item | Observed result |
| --- | --- |
| Exact candidate | The owner approved a console-only publication from PR #32 source `f7f15f2268e733feb538c1cdb0b0b860707a0acb`. [Workflow #36439401423](https://github.com/Heiberg-Industries/lares/actions/runs/36439401423) passed typecheck and build/push. Its linux/amd64 image is `ghcr.io/heiberg-industries/lares-engine-console@sha256:9c80d04adf86f6fc86840d4dbdbd1ea9c346d703ab769febe2b468b8737292ea`; the server pulled it anonymously and the OCI revision matched the exact source commit. `releases/2026-09-28-console-test.4.json` changes only this pin from test.3. |
| Console-only install | Saved the previous compose file to `/opt/lares/compose.yaml.pre-f7f15f2`, changed the console digest in `/opt/lares/compose.yaml`, validated compose and ran `docker compose up -d --no-deps console`. Only `lares-console-1` was recreated; the database, gateway, Keeper, agent, egress proxy and Caddy remained up. The running image and compose pin matched the new digest. Public HTTPS `/api/auth/login` returned 307 into the existing sign-in flow. No migration, provider request, agent restart or other service update was part of this operation. |
| Authenticated desktop check | Reloading the owner's Chrome session showed **Preferences** in the sidebar and heading; its empty installation has 0 entries and opens Add or import preferences. The agent editor showed a current-image preview and singular one-agent capacity copy. The owner had previously reported that the uploaded image was retained after reload; this check showed a rendered current image but did not compare pixels with the uploaded PNG. Connections showed the one live Google account, one mailbox, five scopes and `console-proof` grant, with 15 catalogue-only entries collapsed. Deadlines showed the owner's disposable open row, a clearer reminder column and Done/Dismiss explanations. Permission activity showed an explicit empty state. Market watch showed the revised refresh explanation and shared controls. Settings still showed Europe/Oslo and 21:00–07:00 quiet hours, with separate backup-status and optional-definition-backup guide links. |
| Service and backup limits | Signals displayed the new actionable unavailable state: its record service could not be reached. This is an unresolved service condition, not proof of populated Signals behavior. Backup loaded and still reported **Not protected**: the nightly backup check and monthly restore drill are both recorded as never run. The earlier manually rehearsed restore is documented above but is not recorded by the recurring backup-status system. No backup or restore was run in this console check. |
| Remaining acceptance | Desktop layout was checked for Connections, blank Preferences, Deadlines, Activity, Signals unavailable, Market watch, Settings, Backup and the agent editor preview. Populated Preferences, remaining operational pages and configured/error/write states, actual font-load inspection, approval replay and cross-agent isolation remain open. Mobile review was deferred by the owner. Keep PR #32 draft and LAR-50 In Progress; do not plan a rebuild from this partial console check alone. |

## 2026-09-28 — Preferences write failure and narrow test-server repair

| Item | Observed result |
| --- | --- |
| Owner reproduction | On the exact `test.4` console image, the owner entered a disposable place, `Console QA Test Place`, with list `Console QA`, Oslo and Norway. Clicking Save displayed React error 441. The screenshot shows the form still populated and the page still reporting zero entries; it does not show a successful save. |
| Root cause | The console log recorded `EACCES: permission denied, mkdir '/srv/taste/places'`. The running console uses uid/gid 10001, but `/srv/taste` was absent and its Compose service had no mount for that path. The empty Preferences page had therefore masked a fresh-install provisioning defect. |
| Source fix | PR #32 now creates `/srv/taste` as a console-writable host directory, mounts it into the console, and includes it in the export script's default portable data paths. The generated Compose and installer integration tests pass. This source change has **not** been installed by a clean reinstall; the current test image is unchanged. |
| Live repair | On the disposable server, backed up `/opt/lares/compose.yaml` to `compose.yaml.before-taste-20260928`, created `/srv/taste` owned by 10001:10001 with mode 0750, added its console bind mount, validated Compose, and recreated only `lares-console-1` with `--no-deps`. Docker reported the console running with a writable `/srv/taste` mount; a create/remove probe inside that container passed. The database, agent, Keeper, gateway and Caddy were not recreated. |
| Remaining proof | The owner must click Save again or re-enter the same disposable place, reload, verify the populated row and filters, then delete only that QA row. The mount probe proves write access, not the full browser save flow or export/restore of Preferences data. Keep LAR-50 In Progress. |
| Owner save retest | After the mount repair, the owner reported that Save succeeded. A read-only server check found exactly one file in `/srv/taste/places` matching the disposable `Console QA` entry and no new console error. Reload, filtering, deletion and export/restore remain separate checks. |
| Populated-view review and cleanup | The owner's screenshots showed the saved place after reload, the no-match filter state with the total still at one, and the exact-name delete confirmation. The owner reported Delete worked; a server check found zero files under `/srv/taste` afterward and no new console error. The screenshots also exposed Norwegian freshness badges and detail fragments on the English page, a red outlined tag treatment, and an unstyled Reset link. PR #32 source now uses the shared status badge and button patterns and English row details. This visual correction is not in the installed `test.4` image. |

## 2026-09-29 — console-only visual-correction image

| Item | Observed result |
| --- | --- |
| Source and checks | Draft PR #32 head `6b801692d05278f1287b78d2228689bb67a57f93` had all reported checks green. [Manual console image run](https://github.com/Heiberg-Industries/lares/actions/runs/36529611279) passed typecheck and linux/amd64 build/push. |
| Immutable image | Published `ghcr.io/heiberg-industries/lares-engine-console@sha256:ce29621357025ca109cbba09481ae62f87bc81a6f1abcc7c1a72f9510bfa513c`. Anonymous pull on the test server succeeded; the image's OCI revision exactly matched the PR head and architecture was amd64. `releases/2026-09-29-console-test.1.json` records this console pin and unchanged other image pins. |
| Server change | Backed up Compose to `/opt/lares/compose.yaml.pre-6b80169`, replaced only the console image pin, asserted the `/srv/taste` bind mount, validated Compose, and recreated only `lares-console-1` with `--no-deps`. The console reported running at the new digest/revision; the other six expected containers remained up with prior uptimes. No migration, provider call, agent restart or full server rebuild was performed. |
| Browser and route | Public `/taste` returned HTTP 307 to authentication. The owner's authenticated Chrome tab loaded the updated page after reload. The empty Preferences legend visibly renders English New/Changed with the shared quiet status treatment. Computed body and heading font is Instrument Sans Variable. `/srv/taste` still contained zero files after the earlier QA cleanup. |
| Remaining proof | The populated row details and Reset control are source-tested but have not been visually exercised on this exact image because the QA entry was deleted. Fresh-install provisioning, Preferences export/restore, backup protection, approval replay, cross-agent isolation and mobile remain separate gates. Keep PR #32 draft and LAR-50 In Progress. |

## 2026-09-29 — owner close-of-session decision

The owner accepted the current desktop console image as good for now and chose
to defer further visual polish while moving to release review. The exact-image
populated Preferences row and Reset control, and mobile, remain follow-ups.
This decision does not complete the golden-path acceptance or authorize a
server rebuild, merge, production deployment or teardown. The next-session
order and exact checkpoint are in the
[29 September handoff](../design/console-lar50-handoff-2026-09-29.md).

## 2026-09-29 — release review and rebuild preparation (no rebuild)

The focused [release review](../design/console-release-readiness-2026-09-29.md)
verified PR #32, LAR-50 and the exact test-server image. A host-key-pinned,
read-only server check found all seven expected containers, the console digest
`sha256:ce29621357025ca109cbba09481ae62f87bc81a6f1abcc7c1a72f9510bfa513c`
with OCI revision `6b80169`, one owned ready agent, one stored avatar, zero
Preferences files, and five non-template databases. The current LiteLLM ledger
contains eight rows and USD 0.42528125; the broader known cumulative spend is
at least USD 0.654188 plus the earlier small model check. DNS currently
resolves to `89.167.43.7`. Backup `verify` and `drill` rows remain empty; no
Lares backup timers, backup configuration or archive in the default export path
were found.

This review fixed a same-day export overwrite risk and added a guarded helper
for the orphaned LiteLLM hash that appears after restoring without runtime
secrets. The export regression test passed. The helper's read-only mode refused
the current active agent because its plaintext key exists; it has not yet
rotated a key on a fresh target. PR #32's previous head `26cc76f` completed
[tests run 36531506658](https://github.com/Heiberg-Industries/lares/actions/runs/36531506658)
successfully. The source-only fixes at `7e6f810` completed
[tests run 36532606100](https://github.com/Heiberg-Industries/lares/actions/runs/36532606100)
successfully.

After the owner signed in to Hetzner, a read-only provider check confirmed
running Helsinki CPX32 `lares-install-test-2` #167781592 in project
`lares-install-test`. Provider Backups are disabled and the server has zero
snapshots. Primary IPv4 #152047957 (`89.167.43.7`) and IPv6 #152047958 are
assigned with Auto Delete enabled. The project has no Volumes, Floating IPs,
Firewalls, Storage Boxes or Object Storage buckets. This rules out a provider
backup or project storage target for the current test installation. The exact
resource and discard boundary are recorded in the release review.

No installation, migration, provider call, backup, restore, rebuild or teardown
was performed in this review. The earlier off-box rehearsal escrow was reported
removed at the prior handoff; other Mac copies were not checked. The current
installation remains disposable only after an explicit
owner decision. The next clean run must prove docs-only owner input, first-brief
acceptance, protected backup and restore including Preferences, and final
teardown before LAR-50 can close.

## 2026-09-29 — approved blank-OS rebuild (installation pending)

The owner explicitly approved rebuilding only `lares-install-test-2`
(Hetzner #167781592). In the signed-in Hetzner control plane, I selected
Ubuntu 24.04, confirmed the exact server name in the destructive dialog, and
submitted Rebuild. Hetzner then showed **Server rebuilt** in that server's
activity list. The same page still showed assigned IPv4 `89.167.43.7` and
IPv6 `2a01:4f9:c015:520f::/64`; neither Primary IP nor DNS was changed. The
rebuild overwrote the disk; no export was taken from the disposable restored
installation. Provider Backups were disabled and there were no snapshots.

The ED25519 fingerprint read inside Hetzner's authenticated server console
matched the freshly scanned network key exactly:
`SHA256:Dw372usD9K/t5uBPcFmbjTLAo5+e/ZJquer4psZbTPc`. SSH using only that
pinned key reached hostname `lares-install-test-2`. Read-only checks found
Ubuntu 24.04, 7745 MiB RAM, about 142 GiB free on `/`, no `/etc/lares`,
`/srv/lares` or `/opt/lares`, and no listener on ports 80 or 443. The host is
at `Etc/UTC` and has no Docker, Node or pnpm executable yet. No host
prerequisite, Lares stack, first agent, provider call, backup or restore has
been run on the new OS. LAR-50 remains In Progress.

## 2026-09-29 — guided owner install on rebuilt server (agent proof pending)

The owner installed Docker Compose 2.40.3, checksum-verified Node v24.21.0,
pnpm 9.15.0, and frozen-lockfile dependencies on the blank Ubuntu host. They
checked out detached PR #32 source `87832d2e8d9693ca896701f01b2253eb8df9b1b9`.
The release-manifest dry run reported that nothing changed. The owner then
saved the console OAuth client privately; a read-only SSH check confirmed its
root ownership, mode `0600`, and the expected ID/secret line shapes without
printing either value.

The owner reports the real interactive installer finished successfully after
the fresh-start and four-answer path. Independent read-only checks found the
same detached source revision, generated `/opt/lares/compose.yaml`, `/srv/lares`,
and all six base containers running: database, console, gateway, Caddy, Keeper
and egress proxy. The running console image is the exact
`2026-09-29-console-test.1` digest
`sha256:ce29621357025ca109cbba09481ae62f87bc81a6f1abcc7c1a72f9510bfa513c`,
with OCI revision `6b801692d05278f1287b78d2228689bb67a57f93`. The
`lares_state.schema_migrations` ledger has 74 entries through
`089_agent_avatars.sql`. Public HTTPS returned 307 to sign-in for `/`,
`/api/auth/login`, and `/agents/new`, with certificate verification result 0.
The installer's model check is implied by its reported success but its gateway
usage row has not yet been independently counted in this run.

This is an assisted run, so it does not prove the strict docs-only owner
acceptance. Fresh-account sign-in, first agent, provider-backed chat,
Calendar/Gmail read, first brief or accepted freshness heartbeat, Preferences
export/restore, fresh-target key repair, recurring off-box backup protection,
and teardown remain open. LAR-50 stays In Progress and PR #32 stays draft.

## 2026-09-29 — minimal programmatic recovery fixtures

At the owner's request, the new installation was seeded programmatically for
the narrow remaining recovery checks. The audited Keeper host socket reported
capacity one and zero agents before the write. Its `definition.create` action
created `restore-proof` from the Chief of Staff starting point with no grants,
skills, doors or enabled schedules. It returned `pending: false`; the database
shows one valid definition, Keeper audit records `definition.create|ok`, and
the agent container is running. Definition Git backup reported `disabled`.
This is a recovery fixture, not a repeated browser first-agent acceptance run.

The shared `@lares/taste` serializer created one disposable Preferences note,
`/srv/taste/notes/lar-50-restore-marker.md`, with no private content. Its
parse/serialize round trip passed, and the console's uid 10001 can read it.
The marker has not yet been exported or restored. No chat conversation or
Google data connection was repeated on this installation; the 28 September
fresh-target rehearsal already proved those records and a live Google read,
though it needed manual orphaned-key repair. The guarded replacement helper,
Preferences recovery, recurring off-box protection and final teardown remain
unproved. LAR-50 stays In Progress.

## 2026-09-29 — local recovery export and acceptance clarification

The current-layout `services/box/ops/export.sh` produced
`/var/backups/export/lares-export-2026-09-29.tar` on the test server. Its
archive SHA-256 is
`fd79fed231603e1fc2b1ff11467717e3af782c3f3380e8d2af81a9f2910d63a7`.
All nine manifest members matched their recorded size and SHA-256. The nested
agent bundle contains `restore-proof/agent.json`, and the Preferences bundle
contains `notes/lar-50-restore-marker.md`. The archive has no credential paths.
It is still on the same server, contains sensitive database records, and has
not been restored. It is neither off-box protection nor a recovery result.

The owner explicitly accepted the previously observed `morning-brief`
freshness heartbeat in place of a delivered first brief for this acceptance
run. The 28 September ledger entry records what that heartbeat proved and its
limits. The owner asked whether the off-box backup target could wait until a
later test. LAR-50 still requires a repeatable backup-protection path; the
current Backup screen says **Not protected**, so this gate remains open.
The legacy scheduled backup, verifier and drill scripts target the older
`/opt/agent-box` dual-Compose layout and cannot be safely installed unchanged
on this `/opt/lares` installation. In particular, their broad `/srv/lares`
snapshot would include the live `secrets` directory. Do not run those scripts
here. LAR-50 remains In Progress.

## 2026-09-29 — current-layout backup preparation, not yet protected

The owner approved and created a private Hetzner Object Storage bucket in
Falkenstein, separate from the Helsinki test server, and saved its newly
generated project-wide S3 credential pair in a password manager. A dedicated
daily Healthchecks check was created with a two-hour grace period and the
existing email/Slack integrations. Neither a remote snapshot nor a heartbeat
receipt has been observed yet.

PR #32 commit `09d1f56` adds explicit current-layout branches to the existing
backup and verifier scripts. The old agent-box default remains in place. The
new path archives all databases, portable agent and Preferences stores, and an
age-encrypted `/etc/lares` bundle, while refusing the plaintext secrets parent
and unclassified data directories. The verifier requires these paths, the
encrypted bundle, a real heartbeat target and plausible dumps. Focused backup
and verifier tests passed (29 tests), as did the agent-box typecheck and Bash
syntax checks. The test server has `age` 1.1.1 and `restic` 0.16.4 from Ubuntu;
root-owned staged scripts match the reviewed SHA-256s
`eb5f4bfc25e01789dc3613aadc77b32926771405cbe4d6da8646560d8dd77d73`
and `1876c93aae738a843420f7d1b0f5af3ee7ebeaeaf6f99cf7baf659298df2529c`.
The systemd units pass `systemd-analyze verify` but both timers are disabled.
The off-box age identity and restic repository password are in a private local
Mac directory for this rehearsal; they still need durable owner escrow.
The server has the repository password and a root-only one-time helper for the
owner to enter the S3 pair without echo or shell history. At this checkpoint,
the helper has not been completed and `/etc/lares/backup.env` is absent.
Backup therefore remains **Not protected**.

## 2026-09-29 — first remote backup and read-back

The owner entered the saved S3 pair into the root-only server prompt. A
read-only check verified `/etc/lares/backup.env` is `0400` and root-owned,
and validated the expected field shapes without printing any value. The
remote restic repository was initialized in the private Falkenstein bucket.

The first backup attempt failed closed on an unclassified generated
`compose.lares-agents.yaml` file; its temporary plaintext dumps were removed.
The script now explicitly classifies that generated file without archiving it.
The next backup produced snapshot
`e96a6c1902bfcafcb2c741c36cbd6145382b50508fb3842795543a285ac765f6`
at `2026-09-29T20:50:36+02:00`: 11 files, approximately 444 KiB source and
120 KiB stored. The initial verifier then failed closed because `restic ls`
lists the encrypted bundle only when queried inside the `pg/secrets`
subdirectory. After correcting that lookup, the verifier passed against the
same remote snapshot: globals, all five non-template database dumps, the
three portable Lares stores and encrypted configuration were present. The
small, empty built-in `postgres` dump uses its own 1024-byte floor; the live
export measured 1078 bytes. The verifier service also passed through systemd.

Independent read-back from the Mac found that exact snapshot. The restored
Preferences marker had SHA-256
`e3f98c54efb594a547f43babd31a24b4d014012f54a84f6a66e10ec32cf78d26`,
matching the live server file, and the encrypted configuration bundle
decrypted in a stream with the Mac-only age identity to a tar with 21 entries.
No plaintext bundle was written to disk. The Healthchecks check shows a
recent success and enabled owner email plus the existing `orbis-alerts` Slack
integration. Its event log records a failure POST, `new → down`, then the
successful GET and `down → up` recovery. Receipt by an individual email or
Slack client was not checked. `backup_status.verify` is true;
`backup_status.drill` has never run. Both systemd timers are enabled, with
the next backup at 03:00 UTC and verification at 05:00 UTC on 30 September.
The console's source classifies this as **Unproven** until a restore passes;
that label has not been independently viewed in the browser.

The owner confirmed the S3 pair, Mac-only age identity and repository password
are saved in the password manager. From the Mac, a fresh hidden-prompt check
using the **saved S3 values** found snapshot `e96a6c19` and independently
dumped the Preferences marker with SHA-256
`e3f98c54efb594a547f43babd31a24b4d014012f54a84f6a66e10ec32cf78d26`.
This proves the saved S3 pair can read the remote recovery point, with the
local repository-password file. A full fresh-target restore, guarded
gateway-key recovery, strict unassisted docs-only owner install, and final
teardown remain open. Production deployment is separate. Keep LAR-50 In
Progress and PR #32 draft.

An attempted durable Mac copy of `/etc/lares/backup.env` was rejected by
automatic approval review because it contains S3 credentials and secret
export was not explicitly authorized. No local copy was made. The temporary
read-back script was removed. Recovery after a rebuild will require the S3
pair the owner saved in the password manager; the restic password and age
identity are separate Mac-only files whose contents the owner reports saving
in the password manager. The temporary files must not be treated as durable
escrow.

## 2026-09-29 — owner-initiated same-server rebuild

After the saved-key read-back, the owner submitted the prepared Ubuntu 24.04
rebuild of Hetzner test server `lares-install-test-2` #167781592. Hetzner's
activity log showed `Server is being rebuilt` followed by `Server rebuilt`
around 19:40 UTC. Its browser console displayed a fresh Ubuntu 24.04 tty1
login; the same IPv4 and IPv6 addresses remained attached. The old pinned SSH
host key was correctly rejected. A new ED25519 key was offered over the
network; it was not trusted until checked in the provider console. Keep
LAR-50 In Progress.

The owner logged into the new root tty. In that provider console,
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` returned
`SHA256:TDOrT3zP9GO/n+Hf2UJI0b50CmrLbNeycwygcAisd7k`, matching the new
network-offered ED25519 key. A separate known-hosts file was pinned to that
key; strict SSH login then confirmed Ubuntu 24.04.4 and a nearly empty 150 GB
root filesystem. Host packages from the owner runbook plus `age` and `restic`
installed successfully. Docker Compose is 2.40.3, time zone Europe/Oslo,
official Node 24.21.0 tarball checksum `OK`, and pnpm 9.15.0. Source is
detached at `87832d2e8d9693ca896701f01b2253eb8df9b1b9`; frozen dependency
install completed. The installer dry run with
`releases/2026-09-29-console-test.1.json` exited zero and stated nothing had
changed. Before the real installer, the owner used a hidden-prompt Mac helper
to read the saved off-box recovery point and stream only the escrowed console
OAuth client into `/etc/lares/console-oauth.env` on the rebuilt server. A
root-only, non-secret shape check found the two expected fields and mode
`0600`; no installation config or Compose file existed yet. In the provider
console, the exact pinned installer started, the default fresh path was
selected, and it reached the domain question. The owner is entering the four
private answers there; completion and first-agent proof remain pending.

PR #32's latest head `2f5b72a` has no pending or failed checks. Its final
change gives the existing-install finish-test fixture the OAuth file that an
existing installation requires; the focused seven-test run and full GitHub
checks passed. The test server remains on the separately pinned installer
source `87832d2e`.

The real four-question run then stopped at its live model check, before
database migrations or first-owner creation. LiteLLM logged a forbidden
control character in the Anthropic request header. A byte-class-only check of
the root-only model key found an ESC byte before every printable character,
plus one trailing ESC. We removed only that exact injected pattern and
recreated only the test gateway. On resume, Anthropic returned HTTP 401 with
`authentication_error` and “API key is invalid.” The installation is still
partial: base Compose services are running, but Keeper and the owner setup
are absent. A new key must be entered through a safer private channel and
the live check must pass before acceptance can continue.

The PR branch now rejects control characters in model-key input, with a
focused regression test. This code fix has not been installed on the test
server, whose exact release source remains pinned. The owner has a hidden
Mac Terminal helper that sends a replacement provider key only over the
provider-console-verified, pinned SSH connection; it does not echo or save
the key on the Mac. No replacement or successful provider call is claimed
at this checkpoint.

## 2026-09-29 — fresh first-agent and conversation proof

The owner supplied a new Anthropic provider key through the hidden Mac
Terminal helper. A shape/permission-only server check found one printable
line with the expected provider prefix, owned by root:10001, mode `0440`.
Only the test gateway was recreated to mount that file. The saved-answer
installer resume exited zero. Its live gateway check reported a real model
completion, migrations ran, the `empty_workflow` template was prepared, the
owner was enrolled as a real member, and Keeper plus its egress proxy started.
The installer explicitly reported no agent or conversation yet. This was a
four-question owner run followed by a documented key-entry repair and resume,
not an uninterrupted pass.

The rebuilt server's running console image is still exactly
`ghcr.io/heiberg-industries/lares-engine-console@sha256:ce29621357025ca109cbba09481ae62f87bc81a6f1abcc7c1a72f9510bfa513c`,
with OCI revision `6b801692d05278f1287b78d2228689bb67a57f93`.
Base and Keeper Compose services are running; the initial databases were
`postgres`, `litellm`, `lares_state`, and `empty_workflow`. Public HTTPS for
`/agents/new` redirected to sign-in before the authenticated owner Chrome
session opened the first-agent form.

The owner session created `lar50-fresh-proof` from the Chief of Staff starting
point, with **no integrations and no enabled schedules**. The console reported
it healthy and opened its web chat. One bounded message requested a one-line
reply without tools or external data; the agent replied, “I'm running —
LAR-50 Fresh Proof, up and responding normally.” Both turns survived a page
reload. This proves a fresh first-agent runtime, provider-backed conversation,
and persisted transcript on the exact console image. Git definition backup
was disabled and the page warned that server backup was not yet configured.

The fresh Connections page showed Google as `missing · no client`: the staged
console OAuth file contains only the sign-in client, not the separate Google
data-client pair required for Gmail and Calendar enrollment. Google data
connection in this run, restore onto this target, recurring backup, and final
teardown remain open. The previous run's Google read and accepted
morning-brief freshness heartbeat remain separately documented above.
