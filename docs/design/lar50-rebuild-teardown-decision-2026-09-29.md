# LAR-50 rebuild and teardown decision record — 29 September 2026

**State:** two test rebuilds and one guarded restore were completed; the latest
clean installation remains running and final teardown is unapproved.
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

### Final clean-install checkpoint, 29–30 September

The owner approved and completed a second Ubuntu 24.04 rebuild at about 21:15
UTC. The new host key was matched to Hetzner's on-host fingerprint before
pinned SSH. The subsequent no-answer-flags installer used the four owner
prompts on a blank OS, with documented prerequisites and no restored answers,
database or model key. The first templated agent and provider-backed chat
passed. The separate Google data client was configured, and owner consent
returned one live mailbox with five scopes. The agent-specific mailbox form
yielded Chrome `ERR_BLOCKED_BY_CLIENT`; Safari exposed a missing explicit
Google principal. The data-client helper now pins the installed owner in the
root-only console env, and the test Keeper/console have reloaded it. The owner
is retrying the agent flow; account access has not yet been observed as applied
to this agent, and no same-run provider read is claimed.

The new OS holds one fresh disposable agent and its conversation, the connected
Google token, and root-only backup settings. Encrypted off-box snapshot
`55f4dd18aee67e446c5d16ab2bdb0cb3f269303b52405a6fb72ded8f22ee2b45`
was created at 23:54:25 +02 and read back. A focused fresh-empty-Preferences
drill fix was staged after ten passing tests; the live scratch restore and
verifier passed, with no leftover scratch database or directory. The Backup
page displayed **Protected** and all three timers are enabled. The prior
restore rehearsal and encrypted snapshots remain documented in the ledger;
the current fresh OS has not been replaced by a restore. No production system
was changed.

On 30 September the owner completed the agent-specific Google connection and
mailbox apply. Enabling only the disposable agent's email door mounted its
Gmail and Calendar read tools. A new web conversation showed both read calls
complete, returned counts only, and survived reload. A new encrypted off-box
snapshot `68e4c7088a9aeb913339fe21f8b7f37aa30bcd02e344912ed827f488c7c3dd7d`
was read back; the scratch restore drill and verifier passed again. See the
run ledger for the exact observed sequence. This supersedes the earlier
pending-agent-connection checkpoint above. Final teardown is still unapproved.

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

The 30 September pre-decision inventory in the signed-in Hetzner project
`lares-install-test` showed exactly one running CPX32, `lares-install-test-2`
#167781592, with 160 GB disk and IPv4 `89.167.43.7`. Attached Primary IPv4
#152047957 and IPv6 #152047958 both have Auto Delete enabled. There are no
Floating IPs, Volumes, server snapshots, provider Backups or Hetzner DNS zones.
The one private Falkenstein bucket `lares-lar50-rehearsal-20260929-bk`
#13651453 showed 22 objects / 939.01 KB. A separate authenticated restic
listing found exactly five encrypted snapshots, latest
`68e4c7088a9aeb913339fe21f8b7f37aa30bcd02e344912ed827f488c7c3dd7d`.
Hetzner shows one project-wide S3 credential labelled for the disposable
backup; its key values are not recorded here. The dedicated Healthchecks
`LAR-50 disposable backup verified` check exists with email and Slack
integrations, a one-day period and two-hour grace; its last ping was five
minutes before inspection. Public DNS still resolves `lares.heiberg.co` to
`89.167.43.7`. The DigitalOcean DNS control plane requires a fresh owner
sign-in, so its record and deletion controls were not inspected in this pass.
Repeat the exact inventory immediately before any deletion.

The current OS contains the fresh agent and Google account described above, not
the earlier restored Preferences marker. Deleting the server while retaining
the bucket preserves encrypted recovery material; revoking the project-wide
S3 credential then requires a new credential for any later read. Deleting the
bucket destroys every recovery point in it. Removing the DigitalOcean A record
and the dedicated Healthchecks check should be timed with server deletion to
avoid a stale public route or false backup alarms. The owner must select
retention or destruction of the bucket in the separate teardown decision.

Once the owner approves exact targets, record the pre-delete inventory, remove
the external DNS record and monitor at the agreed time, delete or retain the
bucket and credential as decided, and delete the Hetzner server and both
Primary IPs. Reopen the project inventory afterward and document what remains.
Do not treat the server deletion alone as complete teardown.
