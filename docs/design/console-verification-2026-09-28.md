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
the owner completed Google's Gmail/Drive/Calendar consent. Connections now
shows one live mailbox with five scopes. The agent-specific connection start
was blocked by the automated Chrome tab. The owner had already approved binding
the disposable agent, so Keeper's audited `email.connect`, definition save and
reconcile actions applied that saved account without another Google consent.
The editor then showed **Owner connection applied**, with only Gmail and
Calendar capabilities enabled and both set to **Ask first**. In live chat the
agent completed `gmail_search`, `calendar_list_events` and
`calendar_conflicts`, returning only an inbox count and a next-24-hours event
count. No provider write was requested. The full transcript, including the
tool labels, survived page reload. The new installation's four recorded model
calls cost USD 0.18612325; adding the earlier disposable installation's
USD 0.22890675 gives USD 0.41503 observed cumulative spend, under the approved
USD 5 cap.

The owner-approved export was refreshed after those reads. It contains five
non-template database dumps, globals, agent definitions and retired definitions;
all eight manifest entries passed size and SHA-256 checks. Its SHA-256 is
`50ba122d508c0df515aa0794910274dc25011da2af9a74a4a7936425077b29f1`.
The age-encrypted off-box copy decrypted to the same checksum without writing
plaintext on the Mac. A separate scratch database restored the `lares_state`
dump with matching counts for agent definitions, OAuth tokens, agent
conversations and heartbeat rows, then was dropped. This proves dump replay,
not a complete installation restore. The `/etc/lares` credential escrow was
refreshed after Google setup and contains 21 entries; its decrypted checksum
matches the source stream. Per-agent secrets under `/srv/lares/secrets` are not in the archive,
and their regeneration on a new installation remains to be tested.

A further live Connections check showed the fresh installation's Google card
claiming it was “Used by” fleet components such as `email-watcher` and
`notion-sync`, even though those names came from static catalogue declarations.
PR #32 now shows actual agent grants on the card and moves built-in declarations
into connection details with an explicit caveat. The 27 focused connection
tests and console typecheck pass; this copy change is not in the deployed image.

Settings links load Proactivity, Backup, Email writing style and Signal routes;
Connections links to Meeting follow-ups. On this blank installation Backup
correctly says **Not protected** and Signal routes says the spine is unavailable.
Proactivity incorrectly offered do-not-disturb controls for the old Saga,
Marcel and Calliope fleet, and Meeting follow-ups told the owner to ask Saga.
PR #32 now reads the valid agent list for proactivity controls and writes, and
uses generic meeting copy. Focused proactivity tests and typecheck pass. Email
writing style still exposes legacy learn-key choices and has no mailbox cards
until a learn run; that workflow has not been verified on this test install.

### Fresh-target restore and restored console check

The owner rebuilt the same disposable Hetzner server again. Its new SSH key was
matched to the fingerprint read inside Hetzner Console, and the clean Ubuntu
disk had no Lares directories. Exact PR #32 source `2d3031c` installed the
existing digest-pinned test manifest with the saved, separately encrypted
credentials. The new database was then replaced with all five verified dumps,
and portable agent files and configuration were restored. Table and key row
counts matched the export. Keeper's first agent reconcile exposed a missing
step in the portable export: `/srv/lares/secrets` was intentionally excluded,
but LiteLLM still held the old agent key alias. The single obsolete hashed key
was removed through the local gateway API; Keeper's audited retry regenerated
the agent runtime files and returned no pending change.

The owner session opened Home with `console-proof`; the old chat transcript
loaded. One new bounded provider-backed turn completed Gmail and Calendar
reads, returned only counts, and survived page reload. Connections still
showed the live one-mailbox, five-scope account and Ask first agent grants.
This is live restore and chat proof, separate from local design completion.
The installed console image remains the older test digest, so its catalogue
still labels fleet services as Google consumers and its empty Notion section
shows an operator command for the old layout. PR #32 source now gives a
never-run Notion sync an honest empty state, hides frozen recovery guidance
until a frozen row exists, and no longer prints a host command whose compose
layout it cannot verify. The source change is not yet deployed. Other configured, pending and failure
states in the screen inventory remain unverified, and LAR-50 stays open.

Source review also found that Email writing style exposed model and learn-key
fields that the current `voice-learn` schedule never reads. PR #32 now shows
only the live lookback and per-mailbox message-cap settings, bounds their writes,
and uses the console's rounded control treatment. This needs an exact-image
visual check; no Sent-mail learning run has been exercised on the test server.

The owner approved a GHCR image from exact commit `b29fe92`. Workflow
`36423360122` published digest `sha256:1aaeb010fc5b4dd994b970385577cfe75acdd71df9b3343d4349b2b4f3b50b7c`,
and only the disposable server's console service was replaced. The authenticated
browser showed the corrected Google agent grant, Notion empty state and
writing-style controls, while Settings retained its newer stacked layout and
Europe/Oslo values. Home, agent screens, Chat, Activity and the tool pages loaded
their available configured/empty states. Desktop Agents and Chat, plus phone-size
Agents, Chat and Connections, were visually inspected. The phone Chat composer
was reachable after page scroll. This establishes the current image's observed
states, not the unexercised pending, failure, write and multi-agent states.

The [next-session handoff](console-lar50-next-session-2026-09-28.md) separates
the remaining exact-image console checks from the destructive docs-only
fresh-install and LAR-50 acceptance run.

### Manual avatar check and editor feedback

The owner used Chrome's file picker on the installed `b29fe92` image and sent
screenshots of the edit page. After **Save image**, the page said **Image saved.**
The Agent image section showed only the file chooser and buttons, with no
visible current image. The later screenshot showed the same section without
the status message. These screenshots establish the success message and a
missing editor preview; they do not independently prove that the image rendered
after reload or on Agents/Chat. The editor source had no preview element.

PR #32 now adds a current-image preview to that section and updates it after
save or restore. Focused avatar tests, console typecheck and production build
pass locally. This fix is source-only until a new exact image is approved and
installed; the running test image still has the old editor.

The next source-only copy pass shortens the Tools label and page heading from
**Saved preferences** to **Preferences**, retaining the `/taste` route and data
behavior. The one-agent capacity notice also uses singular grammar and one
clear next action. These changes await the next console image.

### Owner screenshot review and compact design-system pass

The owner confirmed the editor close check passed and the uploaded agent image
remained visible after reload. The owner captured Connections and a disposable
Deadline row. The empty Preferences installation has no entry with which to
verify filtering; mobile review is deferred. The 22 desktop screenshots show
the installed `b29fe92` image, so they still display the older Saved preferences
label, capacity grammar and editor without an image preview.

The screenshots exposed mixed native and custom controls, excessive spacing in
some cards and empty states, and technical labels that obscure the next owner
action. PR #32 source now uses shared button/input patterns and token-based
control classes on Signals, Connections account add, Preferences import/filter,
Deadlines, Market watch and the conversation reset control. Operational cards,
tables and disclosures use tighter shared spacing while retaining full-height
controls. Connections places catalogue-only unknown entries in a secondary
disclosure; Preferences opens the add/import flow on an empty installation;
Signals gives an actionable unavailable state. The agent editor collapses
advanced sections when editing, reduces repeated timing copy, and shows human
schedule labels without changing their saved keys. The agent detail groups
disabled schedules and removes nested empty-state framing. Settings now calls
the Backup link a status view and links specifically to the optional definition
backup guide. These are source-only changes; no image was published or installed.

This does not establish typography or layout on the installed server. The
next exact-image visual check should cover desktop Connections, Preferences
(empty and populated), Deadlines, Signals error state, Market watch, agent
detail/edit, and Settings. It should check actual Instrument Sans/DM Mono font
loading, labels, alignment, density and control states. The existing public
integrations document mixes old fleet assumptions with fresh-install notes, so
the console deliberately does not link to it until a current owner guide exists.
