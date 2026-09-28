# Console and LAR-50 — next-session handoff (28 September 2026)

## Start here

Work in `/private/tmp/lares-console-redesign-20260925` on
`codex/console-redesign`. Recheck Git, [PR #32](https://github.com/Heiberg-Industries/lares/pull/32),
[LAR-50](https://linear.app/heiberg-industries/issue/LAR-50/the-fresh-install-golden-path-qa-for-the-installation-bendik-does-not),
the test server and the owner session before acting; these states can change.
Protected `/Users/bendik/Developer/lares` main was clean at `8417f0c` and seven
commits behind origin/main at this handoff. PR #29 (Agents) and #20 (Chat) were
still separate open drafts. PR #32 was open and draft at `0147953`; its last
docs-only CI run had no failures and two checks still running when observed.
GitHub PR #20 is the Chat draft; it is unrelated to Linear issue LAR-20
(cost and activity).

The current console *image* was built from exact PR #32 commit `b29fe92`, not
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
   Recheck the image pin and spend. Run one bounded provider-backed web-chat
   turn on `b29fe92`, reload during/after its reply, and verify the transcript.
   Exercise the remaining safe UI states, including avatar persistence,
   edit/retire/delete recovery, connection changes, and pending/failure states
   where a disposable setup permits them. Approval replay and cross-agent
   isolation need a planned second-agent arrangement because the current box
   holds one agent. Do not infer them from source tests or an old-image turn.
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

The installed `test.3` image is a test pin, not a public release. Local CI,
source tests and available empty states do not prove the remaining live states.

## Subsequent owner review

The owner reports the dirty-editor close check passed and an uploaded avatar
remained after reload. Desktop screenshots now cover Connections, Preferences,
Deadlines, agent detail/edit, Activity, Signals, Settings and Market watch.
The installed image is still `b29fe92`; PR #32 source changes made after that
image need a fresh exact-image review. Mobile review is intentionally later.
On the blank Preferences screen, filtering cannot be proved without a
disposable entry. The console design-system and density changes are recorded
in `console-verification-2026-09-28.md`; they do not alter the LAR-50 backup,
fresh-install, provider and teardown gates above.
