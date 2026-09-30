# Console and LAR-50 — next-session handoff (28 September 2026)

For the closing 29 September checkpoint and current next-session order, use
[the newer handoff](console-lar50-handoff-2026-09-29.md).

## Start here

**29 September current pin:** The console-only image from PR #32 source
`6b801692d05278f1287b78d2228689bb67a57f93` is installed on the disposable
server at digest `sha256:ce29621357025ca109cbba09481ae62f87bc81a6f1abcc7c1a72f9510bfa513c`.
The earlier `test.4` statements below are historical. The previous temporary
worktree was cleared; the branch was reopened at
`/private/tmp/lares-console-redesign-20260929`. Recheck its existence before
using it in a later session.

**28 September continuation:** PR #32 source `f7f15f2268e733feb538c1cdb0b0b860707a0acb`
was published as a console-only test image and installed on the disposable
server. Its digest is
`sha256:9c80d04adf86f6fc86840d4dbdbd1ea9c346d703ab769febe2b468b8737292ea`;
`releases/2026-09-28-console-test.4.json` records the unchanged base pins.
The authenticated desktop check found the new Preferences label, agent image
preview and compact page treatments. Signals remains unavailable because its
record service cannot be reached; Backup still reports **Not protected**.
See the newer exact-image section of the screen record and the latest run
ledger entry below before using the historical `test.3` notes in this handoff.

Work in `/private/tmp/lares-console-redesign-20260929` on
`codex/console-redesign`. Recheck Git, [PR #32](https://github.com/Heiberg-Industries/lares/pull/32),
[LAR-50](https://linear.app/heiberg-industries/issue/LAR-50/the-fresh-install-golden-path-qa-for-the-installation-bendik-does-not),
the test server and the owner session before acting; these states can change.
Protected `/Users/bendik/Developer/lares` main was clean at `8417f0c` and seven
commits behind origin/main at this handoff. PR #29 (Agents) and #20 (Chat) were
still separate open drafts. PR #32 was open and draft at `0147953`; its last
docs-only CI run had no failures and two checks still running when observed.
GitHub PR #20 is the Chat draft; it is unrelated to Linear issue LAR-20
(cost and activity).

At the original handoff, the console *image* was built from PR #32 commit `b29fe92`, not
the later documentation commits. GHCR workflow
[`36423360122`](https://github.com/Heiberg-Industries/lares/actions/runs/36423360122)
published `ghcr.io/heiberg-industries/lares-engine-console@sha256:1aaeb010fc5b4dd994b970385577cfe75acdd71df9b3343d4349b2b4f3b50b7c`.
The server anonymously pulled it and its revision label matched `b29fe92`.
`releases/2026-09-28-console-test.3.json` changes only that console pin from
test.2. No new migration or provider call accompanied the console-only update.

The owner-provisioned, disposable `lares-install-test-2` (#167781592) still runs
at `89.167.43.7` behind `lares.heiberg.co`. Its SSH ED25519 fingerprint was
read in Hetzner Console and pinned in
`/private/tmp/lares-test-rebuild-known_hosts`. Do not accept a changed host key
without checking it in Hetzner Console again. The server runs the restored
database, `console-proof` agent, Keeper, gateway, Caddy and egress proxy. The
old and post-restore chat turns load; Gmail and Calendar reads returned only
counts, and their OAuth token survived restore. `Backup` still says **Not
protected**. The root-only restore extraction and temporary off-box encrypted
escrow copies were removed after verification; do not assume a current off-box
backup exists. The console has one-agent capacity and that slot is occupied.

Approved public marketing and docs are deployed at `lares.is` from the private
`Heiberg-Industries/lares-website` repository. Do not change that deployment,
repository or `lares.heiberg.co` DNS as part of console/LAR-50 work. The old
first Hetzner test server was deleted. The owner approved a USD 5 cumulative
API test ceiling; known spend through the restore is at least USD 0.52843975
plus one small model check that the restored ledger no longer contains. Check
the current spend and bound any further real model request before using it.

## What is proved

- Blank Ubuntu OS installation with saved answers/credentials, schema through
  `089_agent_avatars.sql`, owner sign-in, one agent, provider-backed chat,
  Calendar/Gmail reads, and a recorded `morning-brief/tick` freshness heartbeat.
- Manifest-verified export and a same-server fresh-target restore of five
  databases, agent files and separately escrowed configuration. Restored
  conversations, Google token decryption and a new read-only provider turn
  worked. The restore required manual removal of one obsolete LiteLLM key hash
  because per-agent plaintext secrets are intentionally excluded from export.
- The exact `b29fe92` console image showed the corrected Connections grant,
  Notion empty state, newer Settings layout, writing-style controls, and
  available empty/configured states across Home, Agents, Chat, Activity and
  tool screens. Desktop Agents/Chat and phone-size Agents/Chat/Connections were
  visually checked. Saving the existing writing-style limits persisted on reload.

See [the run ledger](../runbooks/golden-path-runs.md) for dates, observations,
spend and defects, and [the screen record](console-verification-2026-09-28.md)
for the design inventory. These are observed states, not a blanket console or
LAR-50 sign-off.

## Next work, in order

1. **Finish exact-image console proof on the current restored installation.**
   Recheck the current console digest and spend. The bounded pending-reply reload
   and the owner's avatar-retention check already passed on the earlier image;
   the new editor preview and several compact desktop pages have been checked
   on `f7f15f2`. Exercise remaining safe UI states, including populated
   Preferences, edit/retire/delete recovery, connection changes, and
   pending/failure states where a disposable setup permits them. Approval
   replay and cross-agent isolation need a planned second-agent arrangement
   because the current box holds one agent.
2. **Decide console design readiness separately.** Compare the installed image
   to the September 25 mockups and screenshot feedback, preserving the newer
   Settings layout. Keep PR #32 draft until the owner has reviewed the actual
   console result and the remaining functional-state findings are resolved or
   explicitly scoped. Do not merge #29 or #20 into this by assumption.
3. **Plan the remaining LAR-50 run before destroying this installation.** The
   ticket requires a complete documented fresh install from a blank server,
   the onboarding flow, connected Calendar/Gmail reads, a first brief (or an
   explicitly accepted freshness-heartbeat substitute), provider-backed chat
   restoration, a recoverable backup/restore and final teardown evidence. The
   previous reinstall reused saved answers and credentials, so it does not
   satisfy the docs-only owner-input step. Reusing the same Hetzner server is
   technically sound, but a rebuild will permanently erase the current
   restored installation. Confirm the current test data may be discarded and
   arrange any required backup before that action. Use the owner-held throwaway
   credentials through hidden prompts; do not paste them into chat or logs.
4. **Rehearse the documented run and finish the ticket honestly.** Record each
   observed step, cost and defect in `golden-path-runs.md`. Fix or track the
   missing generic restore-key-rotation step and backup protection. Record
   actual Hetzner and local teardown only after the owner approves final
   destructive cleanup. Keep LAR-50 In Progress until its acceptance is met.

The installed `test.4` image is a test pin, not a public release. Local CI,
source tests and available empty states do not prove the remaining live states.

## Subsequent owner review

The owner reports the dirty-editor close check passed and an uploaded avatar
remained after reload. Desktop screenshots now cover Connections, Preferences,
Deadlines, agent detail/edit, Activity, Signals, Settings and Market watch.
The screenshot set in this section shows `b29fe92`; the later `f7f15f2`
image has now received a partial exact-image desktop review. Mobile review is
intentionally later.
On the blank Preferences screen, filtering cannot be proved without a
disposable entry. The console design-system and density changes are recorded
in `console-verification-2026-09-28.md`; they do not alter the LAR-50 backup,
fresh-install, provider and teardown gates above.

## Owner's final desktop check before the next visual pass

There is no saved Preferences entry on this disposable installation. To test a
populated view without importing personal files, open **Preferences → Paste a
list** and choose **places — one place per line**. Use list name `Console QA`,
city `Oslo`, country `Norway`, and one line `Console QA Test Place`. Save,
reload, and confirm that one places row appears with the list, city and country
available in filters. Filter **Name contains** with `Console QA`, then with
`no-match-qa`, and use **Reset**. Confirm the positive row, the explicit
no-match message, and the restored full view. Delete only the `Console QA Test
Place` row, accept its permanent-delete prompt, reload, and confirm the count
returns to zero. Do not import a real Google Takeout archive for this check.

The owner already showed the current image preview and applied Google mailbox
in the editor; the source and prior live check cover image persistence after
reload and current connection status. No further provider-backed request is
needed for this UI pass. Do not click **Enable door**, **Disable door**,
**Retire agent**, **Delete agent**, permission-level controls, or account
**Connect** merely for a visual check; those change live state.

The new screenshots still show the agent editor's long open Slack and Telegram
setup blocks, uneven field/button rows, and a Save definition button visually
crowding the image card. The Connections Google account card is much taller
than its content; its permissions explanation and table are comparatively
dense. These are specific next-pass visual targets, not a reason to erase the
restored server. `TasteImport.tsx` and `TasteEntryRow.tsx` also retain inline
pixel spacing/font-size declarations despite the design-system-only direction.
Audit those and other remaining operational components for shared tokens and
primitives before the next image. Do not claim a font-loading defect from the
screenshots alone; inspect computed fonts or loaded assets when that check is
available. Mobile remains deferred by the owner.

## Preferences save defect found during the owner's QA

The owner followed the disposable `Console QA Test Place` flow above. Save
displayed React error 441. The test server's console log identified the actual
failure: `EACCES` while creating `/srv/taste/places`. The fresh installer had
neither provisioned `/srv/taste` nor mounted it into the console. The test
server now has a backed-up Compose file, a 10001-owned `/srv/taste` directory
and a writable console bind mount. Only the console container was recreated;
its image remains `test.4`. A container write probe passed. PR #32 has the
corresponding installer/renderer and export-default correction. A clean
installation and real browser Save/reload/delete are still unproved. Retest
the same QA entry before planning any rebuild.

The owner then reported that Save succeeded. A server check found the one
disposable `Console QA` place file and no new save error. At that checkpoint,
the server file alone did not establish populated browser behavior.

The owner subsequently showed the populated row after reload, a no-match
filter state, and the delete confirmation; Delete worked and a server check
found zero Preferences files afterward. This confirms the disposable
save/reload/delete path. The screenshot exposed Norwegian row copy and red
freshness labels alongside English text, plus an unstyled Reset link. PR #32
source now uses shared status/button components and English row details. The
`test.4` image still shows the old treatment; a new exact image would be needed
for visual sign-off. Do not rebuild the whole server for this source-only pass.

## 2026-09-29 console image checkpoint

The owner authorized and installed a console-only test image from PR #32 commit
`6b801692d05278f1287b78d2228689bb67a57f93`. All PR checks and the manual
[image run](https://github.com/Heiberg-Industries/lares/actions/runs/36529611279)
passed. The test server now runs console digest
`sha256:ce29621357025ca109cbba09481ae62f87bc81a6f1abcc7c1a72f9510bfa513c`;
its OCI revision matches the commit. The prior Compose pin is backed up at
`/opt/lares/compose.yaml.pre-6b80169`. Only the console container was
recreated; `/srv/taste` remains mounted. The owner's authenticated Chrome tab
loaded `/taste`, where the empty-state legend now shows shared neutral English
**New/Changed** badges. Computed body and heading font is Instrument Sans
Variable. The Preferences store is empty, so populated row details and Reset
still need exact-image visual review. Do not infer that a fresh install or
Preferences export/restore passed from this console image update.
