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
