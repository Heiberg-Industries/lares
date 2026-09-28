# Console verification and live test boundary — 28 September 2026

PR #32 remains a draft. This record separates local design checks from the
fresh-install and provider-backed evidence required by LAR-50. The approved
marketing site and its private repository are outside this review.

## Screen and state inventory

| Screens | Local state and interaction checks | Still needs live candidate evidence |
| --- | --- | --- |
| Home, Agents, agent detail | Empty/one/many agents, search miss, 23 capabilities, read failure, saved workflow state, access controls and pending effects were reviewed with synthetic data; current source tests cover the data adapters. | Runtime health, actionable approvals and spend require the authoritative backend in LAR-20. Real Keeper lifecycle remains unproved. |
| Create and edit agent | Purpose, identity/access, review, dirty close, retirement, exact-name deletion, avatar upload/reset, and unknown write outcomes have local browser/source coverage. | Create/edit/retire/delete and avatar persistence through a real Keeper and migrated installation. |
| Chat | Empty state now links to agent creation. Local tests cover owner/agent drafts, suggestions that do not send, Eve replay/ownership, approval presentation, scroll behavior and recovery. | One provider-backed turn, reload during/after a turn, approval replay and cross-agent isolation on the exact candidate. |
| Connections | Connection cards, mailbox add/remove, status and custody distinctions, Notion/CRM states, and permission controls retain their real data paths. The permission table now scrolls within the page on narrow screens. | Calendar and Gmail read checks, account add/remove and permission effects on the test installation. |
| Settings | Stacked sections and synchronized theme controls are retained. Quiet hours/time zone are read from the existing settings flow; links reach backup, writing style and alert routing. | Verify actual configured values and all linked controls in the installed console. |
| Activity and tools | Activity, Deadlines, Market watch, Saved preferences, Backup, Meeting follow-ups, Proactivity, Signals and Email writing style retain existing actions and empty/error states. The remaining operational pages now share the console heading and control treatment; wide tables scroll within their surface. | Exercise each tool with installed data, including empty, populated, failure and pending-write states where applicable. A source build does not establish these live states. |

The 28 September local build lists all application and API routes. Source testing
passed 670 tests in the restricted runner, then the 11 socket/database tests
passed with local runtime access. Typecheck and production build passed after
the page changes. This inventory is a code and local-review checkpoint, not a
claim that every installed screen has been observed.

## Proposed live window, before execution

1. Pin the exact PR #32 commit and its build-only console image digest. Review
   migration order and take a verified backup before `089_agent_avatars.sql`.
2. Provision two temporary, isolated test boxes and a fresh test account. Use
   the documented installer and wizard from a blank server. Use a temporary
   test hostname or Tailscale access; do not change `lares.heiberg.co` DNS or
   the deployed `lares.is` website. Do not reuse the deleted Hetzner server.
3. On the primary box, check authenticated desktop and phone layouts for every
   screen in the inventory. Create, edit, retire and delete a disposable agent;
   upload and reset an avatar; connect a disposable Google account and perform
   Calendar and Gmail reads; check the first brief or freshness heartbeat.
4. Run one bounded provider-backed web-chat exchange with that agent. Reload
   during and after a reply; inspect transcript and approval replay, new-chat
   isolation and the absence of the earlier step-marker text. Record provider,
   model, time, outcome and spend without copying credentials or private content.
5. Prove backup escrow and restore onto the second box. Compare manifests and
   the first brief/session records, then tear both boxes down and record provider
   resources actually removed. Append the observed result and defects to
   `docs/runbooks/golden-path-runs.md`; keep LAR-50 open until every criterion
   passes.

This window creates paid infrastructure and makes real provider calls. Its exact
candidate, account, cost ceiling, test hostnames and teardown owner must be
agreed before it starts. CI, the local fixture, and the September 25 partial
run do not replace it.

## Live checkpoint — 28 September

The owner approved a USD 5 API ceiling, provisioned a fresh Ubuntu server at
`89.167.43.7`, and pointed `lares.heiberg.co` to it. This supersedes the proposed
temporary-hostname step above for this test. One exact console image was
published from `6889c0e` and anonymously pulled by that server. The fresh
installer completed after a missing host Node/pnpm/toolchain prerequisite was
repaired; its real model check succeeded and box migration `089_agent_avatars.sql`
applied. Google sign-in, one restricted first-agent creation and a provider-backed
web-chat reply with transcript reload now have live proof. Agent creation reported
an unknown-outcome timeout although Keeper completed it. Owner-scoped tools first
failed because the generated console stack omitted the owner's identity; PR #32
now includes the renderer fix and the test stack was repaired. The owner then
connected the Google mailbox and approved access for the disposable agent. A
missing Keeper Google configuration and incorrect credential file modes needed
manual repair; the agent's Calendar and Gmail read request then returned counts
and survived reload. The deployed chat still renders two ordinary tool parts as
generic placeholders; PR #32 source now labels tool activity without showing
private results. The live editor also exposed unstyled connection controls and
10-second lifecycle timeouts; the branch now uses the shared button component,
scoped door layout and a 60-second timeout for creation and reconciliation.
Connections now derives Google workspace cards from configured clients and stored
accounts, so a blank installation no longer displays the catalogue's example
Workspace A/B cards.
These source changes have not been redeployed or visually rechecked on the test
server. Brief/heartbeat,
backup/restore, a clean installer run and all configured tool states still need proof.
The current evidence and remaining gates are in
[`golden-path-runs.md`](../runbooks/golden-path-runs.md). LAR-50 remains open.

### Later console check and one-server retest plan

The owner approved a second exact-commit test image from `7c5bc76`. Its
digest-pinned console replaced only the test console service. The persisted
chat now labels both Google tool calls, Connections shows the one configured
Google client/account, and Settings still shows Europe/Oslo and quiet hours.
No provider call or migration was part of that update. The agent wizard opens,
but this installation's one-agent capacity is occupied by `console-proof`.

The owner proposed reusing the same server. LAR-50 can be tested sequentially:
discard this first disposable installation, genuinely reprovision the OS, run
the documented install, then create and verify an off-box encrypted export of
the **new** installation before a second reprovision and restore rehearsal.
The existing export script targets the older installation and needs repair
before that later backup. Neither reprovision has happened yet.

### Rebuilt-server checkpoint

The owner rebuilt the same test server from Ubuntu 24.04 and ran the real
installer from pinned source `4d8d00d` with the `2026-09-28-console-test.2`
manifest. The fresh schema reached `089_agent_avatars.sql`; the live model
check and one subsequent provider-backed `console-proof` chat reply succeeded.
Google sign-in initially failed because the saved public client ID contained
an adjacent JSON fragment. After correcting that one field, sign-in as the
owner succeeded. The agent was created through the live wizard with only
Gmail and Calendar capabilities and no schedules; its first response survived
reload. The first chat view briefly showed an inaccessible conversation until
**New conversation** was used.
The same hostname and agent slug had been used in an earlier disposable
installation, leaving a stale browser session key. PR #32 now clears that key
on the explicit `created=1` transition and then removes the one-time URL flag,
so a later reload can resume the new conversation normally.

The installer also copied a stale `/etc/timezone` value (Etc/UTC) despite the
active Europe/Oslo host clock. The test installation was repaired and Settings
now displays Europe/Oslo. PR #32 contains installer checks for both input
defects and an accurate notice for disabled optional Git definition backup.
Those source corrections are not in the deployed test image. The Backup page
still says **Not protected**; Google data consent, agent-level Calendar/Gmail
reads, brief/heartbeat, and restore rehearsal remain unverified on this
rebuilt installation. LAR-50 stays open.

The corrected export script has since produced and hash-verified a local
archive with every non-template database and portable agent definitions. After
specific owner approval, the archive and configuration were streamed into
separate age-encrypted files on the owner's Mac. This is transfer and integrity
evidence; the archive has not been restored. A fresh Saved preferences check
also found Norwegian copy and an internal path on the English screen. PR #32
now removes those from the page body and translates the import, list maintenance,
and pin audit controls. Related typecheck and 45 taste-store/browse tests pass;
the new copy has not been deployed to the test image.

A tightly scoped schedule probe then produced a real `morning-brief/tick`
heartbeat on the rebuilt installation. The schedule and global runtime switch
were returned to off. No Telegram door was configured, so no brief was
delivered. Google data-client configuration now appears in Connections, and
the account flow reached Google's Gmail/Drive/Calendar scope screen. Consent
and the agent-level read checks remain pending.
