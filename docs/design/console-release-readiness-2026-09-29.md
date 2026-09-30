# PR #32 release-readiness review — 29 September 2026

## Exact checkpoint

- [Draft PR #32](https://github.com/Heiberg-Industries/lares/pull/32) was open and mergeable at source `26cc76ff3bd0a2d46d9d037e7e27935518f6ed77` before this review's source-only fixes. Its base was `166613e4`; 165 files changed. There were no submitted reviews or inline review threads. [Tests run 36531506658](https://github.com/Heiberg-Industries/lares/actions/runs/36531506658) completed successfully for that head. The fixes were pushed at `7e6f8107668c15941dd2a5c62707f4d85417285b`; [tests run 36532606100](https://github.com/Heiberg-Industries/lares/actions/runs/36532606100) completed successfully for that exact head. Recheck the head and checks again before merge.
- The disposable server's running console reference, local image digest, and Compose pin all matched `ghcr.io/heiberg-industries/lares-engine-console@sha256:ce29621357025ca109cbba09481ae62f87bc81a6f1abcc7c1a72f9510bfa513c`. The image's OCI revision is `6b801692d05278f1287b78d2228689bb67a57f93`. All seven expected containers were up. This is the console-only image, not a clean installation of the PR head.
- Linear [LAR-50](https://linear.app/heiberg-industries/issue/LAR-50/the-fresh-install-golden-path-qa-for-the-installation-bendik-does-not) remains **In Progress**, blocked by LAR-7. Its live acceptance text requires the docs-only owner run, first-brief decision, repeatable restore and backup protection, and teardown evidence.
- The installed desktop UI is accepted as good for now. Populated Preferences styling on this image and mobile remain deferred. They do not currently change this release decision.

## Focused diff review

| Area | Finding | Gate |
| --- | --- | --- |
| Migration | `089_agent_avatars.sql` adds a keyed image table with a 256 KiB database limit and an agent-definition delete cascade. It is additive and covered by the full database export. An older console should ignore the table, but rolling the schema back has not been rehearsed. | Back up and verify before any migration. Do not present a Compose rollback as a database rollback. |
| Installer and Google | The branch adds host Node/pnpm preflight, owner identity and active time zone rendering, a writable `/srv/taste` mount, and a root-only Google Keeper configuration helper. The prior server needed manual repairs, so a blank OS run from this source remains required. | LAR-50 fresh-install run. |
| Owner instructions | The public README gives development prerequisites but no runnable installation command; the original installer spec labels its one-command endpoint a historical proposal. A [candidate-specific blank Ubuntu guide](../runbooks/blank-ubuntu-install-candidate.md) now records the source checkout, private credential handoff and honest manual steps for LAR-50. | Have the owner use only that guide and CLI output on the rebuilt box, record every question, and decide installer distribution before a circle release. |
| Export and restore | The branch's export defaults now include portable agent and Preferences directories and all five non-template databases while excluding secret trees. This review fixed same-day archive replacement: complete exports publish under distinct names. The restored LiteLLM alias can still outlive its excluded plaintext; a guarded helper now checks one stopped, owned agent and exact key policy before deleting that orphaned hash. Its safe refusal was observed on the current active agent; a successful fresh-target run remains unproved. | Manifest, off-box encryption, Preferences restore, key rotation, and recovered agent must be observed in the next drill. |
| Backup | The test server has no backup configuration file, scheduled Lares backup or restore timer, or archive in the default `/var/backups/export` path. The `verify` and `drill` status rows have no results; Backup correctly says **Not protected**. Existing Stage 1.5 backup scripts still describe the older `/opt/agent-box` layout. | Choose and configure a real off-box target, verify a fresh snapshot and rehearse a restore before claiming protection. |
| Console and design system | The new screens use shared `@lares/ui` patterns and primitives for the main navigation, controls, badges and dialogs. Authenticated desktop screens and the exact installed Preferences empty state were checked in the [screen record](console-verification-2026-09-28.md). The test image has one agent and no populated Preferences row, so it cannot prove all live states. | Current desktop visual review is accepted; retain unproved functional states as explicit follow-ups. |
| Dependencies | Draft [PR #29](https://github.com/Heiberg-Industries/lares/pull/29) (Agents) and [PR #20](https://github.com/Heiberg-Industries/lares/pull/20) (Chat) remain open. Their code is integrated into PR #32's diff; neither is a prerequisite merge. | Resolve their draft disposition before merging #32 to avoid duplicate delivery. |
| Publication and rollback | Manual console-image publication requires an explicit `publish` input. The current test manifest pins one exact console digest; previous Compose is backed up on the test server. No production image rollout or rollback was tested by this review. | Keep production deployment, migration timing and rollback approval in a separate decision. |

## Decision at this checkpoint

Keep PR #32 draft and do not call this a circle-release candidate yet. Its source checks and desktop review are useful, but a clean docs-only installation and protected restore path are still unobserved. The source-only export and restore-key fixes can be reviewed and tested on this isolated branch without changing the installed image. Recheck the PR head, CI, and exact release pin before a later merge decision. Production deployment remains a separate gate.

## Current server evidence before a rebuild decision

Read-only, host-key-pinned inspection of `lares-install-test-2` at `89.167.43.7` found one owned ready `console-proof` resource, one avatar, zero Preferences files, five non-template databases, and eight restored LiteLLM spend rows totalling USD 0.42528125 in the current database. The broader documented spend across the two disposable installations is at least USD 0.654188 plus one small model check lost during database replacement. DNS for `lares.heiberg.co` currently resolves to this server. The root filesystem had 134 GiB available; no archive in the default export path, backup timer or restore timer was observed. The earlier off-box escrow copies were reported removed at the prior handoff; this review did not search the owner's Mac for other copies. The current key-rotation helper correctly refused to touch the active agent because its plaintext key exists.

**Provider control-plane check, 29 September:** the signed-in `lares-install-test` Hetzner project shows one running Helsinki CPX32, `lares-install-test-2` **#167781592**, with 4 vCPU, 8 GiB RAM and a 160 GB local disk. Its IPv4 `89.167.43.7` is Primary IP `#152047957`; its IPv6 `2a01:4f9:c015:520f::/64` is Primary IP `#152047958`. Both are assigned to this server with Auto Delete enabled. Provider Backups are disabled; the server has **zero snapshots**. The project has no Volumes, Floating IPs, Firewalls, Storage Boxes or Object Storage buckets. Hetzner's activity list shows server rebuilds roughly 22 and 24 hours before this check. This identifies the resource and confirms there is no provider recovery point; it does not by itself prove all possible off-box copies have been found. [Server overview](https://console.hetzner.com/projects/16148145/servers/167781592/overview), [Backups](https://console.hetzner.com/projects/16148145/servers/167781592/backup), [Snapshots](https://console.hetzner.com/projects/16148145/servers/167781592/snapshots), [Primary IPs](https://console.hetzner.com/projects/16148145/ips/primaryips).

**Rebuild discard boundary:** a new OS install on this same server will erase the current restored database, conversations, OAuth token, avatar, agent files, and server-only configuration. The earlier encrypted off-box rehearsal copies were removed. The run ledger preserves observed proof but cannot recreate the live data. The current installation is disposable only after the owner's explicit decision. Rebuild should target only server #167781592 and retain the assigned Primary IPs and `lares.heiberg.co` DNS for the next test, subject to the provider's rebuild behavior. Capture the selected Ubuntu image and final confirmation before execution.

**Prepared next run:** use the exact reviewed branch commit and digest-pinned test manifest on a blank Ubuntu 24.04 image; have the owner use a fresh test account and enter the four onboarding answers and credentials privately using only public docs; record every question or manual workaround; prove sign-in, first agent, one bounded provider chat, Gmail and Calendar reads, and either an actually delivered first brief or the owner's explicit acceptance of a freshness heartbeat. Add a disposable Preferences record before export. Verify an encrypted archive and configuration escrow off the box, then perform the fresh-target restore and guarded key repair, checking the saved Preferences record, token, conversation and agent. Establish recurring off-box backup verification and restore status, or leave LAR-50 open with the exact protection gap. Track provider spend against the USD 5 ceiling.

**Prepared final teardown:** after the run's checks and evidence are complete, recheck server #167781592, its two assigned Auto Delete Primary IPs, and any resources created during the new run. Preserve the approved proof and decide what to do with `lares.heiberg.co` DNS; it currently points to the test server. Request a separate, specific owner decision before permanent deletion. Record provider confirmation that the server and any billable IPs are gone. Do not close LAR-50 before the accepted golden-path evidence and teardown record exist.

## Approved rebuild result

After this pre-decision review, the owner approved the Ubuntu 24.04 rebuild of
server #167781592. Hetzner reported **Server rebuilt** and retained both
assigned IPs. The new ED25519 host key matched between Hetzner's authenticated
server console and the network; a pinned SSH check confirmed a blank Ubuntu
24.04 host without the three Lares installation directories. The exact
fingerprint and baseline are in the [run ledger](../runbooks/golden-path-runs.md).
This is the start of the next LAR-50 attempt, not a completed install or a
new release-readiness sign-off. The final teardown decision remains separate.

## 30 September follow-up

The final blank-OS run used the documented prerequisites and four interactive
owner answers without a restored answer file. The first templated agent and
provider-backed conversation passed; the fresh Google account connection and
agent-level Gmail/Calendar read passed after fixing the missing explicit
Google principal and enabling the agent's email door. Encrypted off-box backup,
scratch restore drill and verifier passed, while the earlier guarded
fresh-target restore remains recorded separately. The owner accepted the
earlier morning-brief freshness heartbeat as the brief substitute. Exact
evidence and limits are in the [run ledger](../runbooks/golden-path-runs.md).

Draft PR #32 head `07c22b6c511e98b5ae0ebe48a435e6b34792a991` has all 18
reported checks successful in [run 36638260941](https://github.com/Heiberg-Industries/lares/actions/runs/36638260941).
The test server still runs the digest-pinned console image and source noted in
the run ledger; a green branch CI run does not change that installed image.
The current server, IP, backup bucket, credential, monitor and DNS inventory
for a teardown decision is in the
[decision record](lar50-rebuild-teardown-decision-2026-09-29.md). Keep LAR-50
In Progress until teardown is approved, performed and verified. Keep PR #32
draft while its merge and production release are decided separately.

The owner subsequently approved test teardown, while choosing to retain the
`lares.heiberg.co` A record. Hetzner now shows no test server, Primary IP,
bucket or S3 credential, and the dedicated Healthchecks check was removed.
The retained DNS points to the released test IPv4 and needs repointing before
reuse. The observed LAR-50 acceptance and teardown are in the run ledger;
this disposal does not publish or deploy PR #32. The broader LAR-7 build scope
and PR merge/release decision remain open.

## 30 September merge-readiness checkpoint

Draft PR #32 is open and mergeable at `08f9912bfed2e83535d7d1030448918bfa63b702`
against `166613e4a68ad533219990d7bfd9c19a19af5fda`. Its 18 reported
checks all succeeded in [run 36639797724](https://github.com/Heiberg-Industries/lares/actions/runs/36639797724).
No review has been submitted. The focused source review found no new code
blocker in the current-layout backup, verifier, restore drill, installer,
Google-principal repair, or image publication guard since `7e6f810`. This
does not add a live run of the final PR head: the disposable server was
deleted after testing the earlier pinned console image.

This review found that a manual run of the runtime-image workflow could
inherit an unreadable organization-wide `PUBLISH_IMAGES` setting. The branch
now makes manual publication an explicit, default-off input for all its
image builds. At exact source `8b5c97e3b1c7de2a1e04e6cbcad1f4129ee74cc3`,
[manual run 36676470383](https://github.com/Heiberg-Industries/lares/actions/runs/36676470383)
passed Keeper and all three role jobs, including the Chief of Staff runtime
probe that applies migration 089. Its job log showed `push: false`.
[PR tests run 36676623699](https://github.com/Heiberg-Industries/lares/actions/runs/36676623699)
also passed at that same source. This record update adds no runtime change.
Production publication and deployment remain separate.

LAR-50 is Done with the owner's accepted brief heartbeat substitution and
restore proof spanning two disposable installations. The exact observations
and their limits are in the [run ledger](../runbooks/golden-path-runs.md).
PR #20's head `c5ae62e` and PR #29's head `c63c316` are both ancestors of
PR #32's head, with no separate reviews or comments, so they carry no unique
code to merge ahead of #32. Both duplicate drafts were closed as superseded
without merging. The retained `lares.heiberg.co` A record remains
unchanged by owner decision; it points to the released test IPv4 and must be
repointed before reuse.

Keep PR #32 draft for a separate merge decision. Before any production
rollout, decide migration timing and rollback, build and inspect a release
image from the selected merge commit, pin its immutable digest, and plan a
separate deployment. The green CI run and completed LAR-50 test are evidence
for review, not a production image or deployment approval.
