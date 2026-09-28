# Fresh-install golden-path runs

This ledger records what a blank-server run actually proved. A partial run is not a release sign-off. The [tested install path](../decisions/0022-the-tested-install-path.md) and [golden-path design](../specs/2026-09-03-fresh-install-golden-path-design.md) define the intended scope; the latter predates the web-chat-first decision, so its Slack-first order is historical.

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
| Fresh-install repair | The first real installer attempt generated secret files, then stopped before containers or a provider call because host `pnpm` was missing. The dry run had not checked this. Installed checksum-verified Node 24.21.0, pinned pnpm 9.15.0, Ubuntu build tools, and frozen-lockfile dependencies in the isolated source checkout; the resumed installer preserved the generated secrets. This is a tested-path prerequisite/documentation defect. |
| Installer result | The resumed installer completed. The gateway made one real Claude Opus 5 completion; all 74 box migrations through `089_agent_avatars.sql` applied; owner `bendik` and the first organisation were created; db, console, gateway, Caddy, Keeper and egress proxy started. Public `/api/auth/login` returned 307 with valid TLS. The installer correctly ended at `/agents/new` without claiming an agent or conversation. |
| Spend | LiteLLM's local `LiteLLM_SpendLogs` showed one call, 20 tokens and USD 0.00018 at this checkpoint. The owner approved a USD 5 API test ceiling. |
| Browser handoff | Google offered `bendik@heiberg.co`; the automated Chrome tab blocked its OAuth callback with `ERR_BLOCKED_BY_CLIENT` before a Lares session was established. The owner was asked to sign in in normal Chrome. This does not prove authenticated console screens or Google data access. |
| Remaining LAR-50 work | Create and exercise the first agent; provider-backed chat with reload and transcript; Calendar and Gmail reads; first brief/freshness heartbeat; every installed console screen and functional state; backup escrow and restore onto a second box; final teardown evidence. Keep LAR-50 open. |
