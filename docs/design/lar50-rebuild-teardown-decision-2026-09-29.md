# LAR-50 rebuild and teardown decision record — 29 September 2026

**State:** rebuild and guarded restore completed; final teardown remains unapproved.
Production deployment is a separate decision. The detailed observations are
in [the run ledger](../runbooks/golden-path-runs.md).

**Rebuild action:** The owner submitted the Ubuntu 24.04 rebuild of server
#167781592 on 29 September at approximately 19:40 UTC. Hetzner reported it
complete, and the console showed the new OS login. The new SSH host key was
confirmed in the Hetzner console, then the guided installation and guarded
off-box restore completed. The final teardown decision has not been made.

## Rebuild of the disposable test server

| Item | Verified state |
| --- | --- |
| Target | Hetzner project `lares-install-test`, server `lares-install-test-2` #167781592, CPX32, Ubuntu 24.04, 160 GB disk in Helsinki. |
| Address | IPv4 `89.167.43.7`, Primary IP #152047957; attached IPv6 /64 Primary IP #152047958. Rebuild should retain these addresses. |
| Current installation | Source `87832d2e8d9693ca896701f01b2253eb8df9b1b9`; exact console image digest `sha256:ce29621357025ca109cbba09481ae62f87bc81a6f1abcc7c1a72f9510bfa513c`. |
| Data that rebuild erases | The current `/etc/lares` configuration, five databases, one `restore-proof` agent, one disposable Preferences marker, locally staged backup scripts/configuration, and the local export. |
| Remote recovery point | Private Falkenstein restic snapshot `e96a6c1902bfcafcb2c741c36cbd6145382b50508fb3842795543a285ac765f6`; verifier passed for five dumps, portable stores and encrypted configuration. Mac read-back matched the live Preferences marker SHA-256 and decrypted the age bundle. |
| Monitoring | Dedicated daily Healthchecks check with two-hour grace and email/Slack integrations; backup and verifier timers enabled for 03:00/05:00 UTC. |
| Backup limit | The private S3 bucket has no Object Lock, and its server credential can delete objects. This is a disposable server-loss recovery rehearsal, not immutable backup protection. The current `backup_status.drill` row is unset; the fresh-target restore must supply the missing proof. |

Before a rebuild, confirm the owner has durably escrowed the S3 key pair,
restic repository password and Mac-only age identity, and repeat off-box
`restic snapshots` using those saved values. The current Mac files are in a
temporary directory. Confirm no other work is using this test server. Then
request an explicit owner decision to rebuild **server #167781592's OS disk**.
No rebuild is permitted merely because this plan exists.

The owner confirmed on 29 September that the S3 pair, repository password and
age identity were saved in the password manager. A Mac hidden-prompt check
using the saved S3 pair found snapshot `e96a6c19` and read its Preferences
marker with the expected SHA-256
`e3f98c54efb594a547f43babd31a24b4d014012f54a84f6a66e10ec32cf78d26`.
A root SSH session is still logged in; close it before rebuilding.

After approval, the shortest remaining sequence is:

1. Rebuild the same server with a clean Ubuntu 24.04 OS, preserving its Primary
   IPs and the off-box bucket. Observe an unassisted, docs-only owner install
   through the four-question flow, connection of Calendar and Gmail, first
   templated agent and a provider-backed first conversation. The owner accepted
   the already observed `morning-brief` freshness heartbeat as the brief
   substitute; preserve that evidence without repeating a delivered brief.
2. Compare the fresh installation to the documented expectations. Then restore
   the pinned off-box snapshot onto that fresh target, with credentials supplied
   from escrow, and run the guarded orphaned-gateway-key helper in its dry-run
   and execute modes only when its exact preconditions hold. Reconcile the
   agent and verify its runtime, database records and Preferences marker.
3. Reinstall and prove backup/verification on the restored target. Record the
   restore verdict and remaining console status. Keep LAR-50 open if any step
   fails or cannot be observed.

### Result and protected recovery point

The rebuilt Ubuntu 24.04.4 server kept both Primary IPs. Its new ED25519 host
key was verified in the provider console before strict SSH access. The
four-answer installer reached a live provider check, where Hetzner's browser
console had inserted control bytes into the hidden model key. A replacement
was entered by the owner through a hidden Mac prompt; the saved-answer
installer resume, first agent, provider-backed chat and reload then passed.
This is a repaired run, not a strict unassisted docs-only install. The
separate Google data client was missing from this fresh run; the 28 September
run contains the observed Calendar/Gmail reads and accepted freshness
heartbeat.

Before restoring old state, off-box snapshot
`8549d5039554eced1cdd96b95dba5440dbc512f1f9c2ea12ef9846b2b387df97`
protected the fresh installation. The original off-box snapshot
`e96a6c1902bfcafcb2c741c36cbd6145382b50508fb3842795543a285ac765f6`
was restored to the rebuilt server. Its agent was reconciled after a guarded
single-key rotation; the Preferences marker matched its prior SHA-256, and a
new provider-backed chat turn survived reload. The restored source snapshot
contains zero Google OAuth tokens and no old conversations, so this restore
does not itself prove recovery of those records.

Post-restore off-box snapshot
`f66cd5a478c35c169999716877fd13c44894c7c56c963597a4e2a84598c7cf40`
was created at 22:53:46 +02. The current-layout monthly drill loaded all five
dumps into scratch databases and removed them; the verifier passed and the
installed Backup page said **Protected**. Backup, verifier and drill timers are
enabled. This proves their manual unit runs; scheduled execution has not yet
occurred. The private bucket has no Object Lock, and its test project S3
credential can delete its snapshots. The Mac-only age identity and repository
password were escrowed by the owner. No production system was changed.

LAR-50 remains In Progress because the repaired install does not meet the
strict docs-only criterion and final teardown has not been observed. PR #32
remains draft. These are acceptance and disposal decisions, not permission to
delete anything.

## Final teardown after acceptance

This requires a **separate** decision after the above evidence is written.
The current Hetzner project has one server, two attached Primary IPs, one
private Object Storage bucket, no server snapshots, no Hetzner server backups,
no volumes, no Floating IPs and no Hetzner DNS zone. The public
`lares.heiberg.co` A record currently resolves to `89.167.43.7`; the domain's
nameservers are at DigitalOcean, outside this Hetzner project. Teardown also
needs to account for the dedicated Healthchecks check and the test-only S3
credential. The Object Storage bucket holds an encrypted restic recovery copy;
deleting it would permanently remove that copy. Confirm whether the owner
wants that copy retained or destroyed before any bucket action.

The final pre-delete check must reopen Hetzner project `lares-install-test`
and confirm the exact server, Primary IPs, bucket and S3 credential inventory.
The server's current OS contains the restored databases, agent and
Preferences store plus the quarantined fresh-agent files. The bucket currently
contains three known snapshots, including the fresh rollback and the
post-restore point above. Deleting the server while retaining the bucket
preserves only that encrypted recovery material; revoking the project-wide S3
credential then requires a new credential for any later read. Deleting the
bucket destroys all three recovery points. Removing the DigitalOcean A record
and the dedicated Healthchecks check should be timed with server deletion to
avoid a stale public route or false backup alarms. The owner must select
retention or destruction of the bucket in the separate teardown decision.

Once the owner approves exact targets, record the pre-delete inventory, remove
the external DNS record and monitor at the agreed time, delete or retain the
bucket and credential as decided, and delete the Hetzner server and both
Primary IPs. Reopen the project inventory afterward and document what remains.
Do not treat the server deletion alone as complete teardown.
