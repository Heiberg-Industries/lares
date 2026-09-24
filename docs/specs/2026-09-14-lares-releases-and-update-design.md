# Lares releases + the one update command — design (ORB-269)

**Status:** APPROVED (the owner read it 2026-09-15). **Amended 2026-09-15 — order and scope:** ORB-269 executes
BEFORE the installer (ORB-266): the split's Task 12 tags `v0.1.0` from what the box runs; this ticket builds
the release + update mechanics; the ORB-286 batch-6 port is the first real payload (`v0.2.0-rc.1` → dogfood
→ `v0.2.0`). So this ticket **builds the keeper core** (pulled forward from installer Plan 1) and the update
in **overlay mode** — the keeper applies the overlay's compose files as given and takes over *updating*
the owner's fleet, not redrawing it (Part 3a). Plan: `docs/superpowers/plans/2026-09-15-lares-releases-and-update.md`.
Paths are in the `lares` layout.
**Parents:** `2026-08-17-shared-agent-stack-design.md` (update distribution, resolved 2026-09-01: *"tagged
releases with pinned image digests, a CHANGELOG a non-dev can read, and one update command (later a
console button) that pulls, migrates, restarts and verifies"*); `2026-09-11-lares-repo-split-design.md`
Part 3 (release candidates, how an update reaches each edition).
**Builds on:** `2026-09-14-lares-installer-and-wizard-design.md` and its Plan 1 (the keeper, install/repair,
the release manifest, the guarded migrate, the reserved `update` action).
**Blocks:** ORB-287 (the fleet command runs this per installation). **Gate:** must exist before the first
invite — members cannot install what they cannot update (installer spec, Part 7).

## The finding, up front

The ticket (written the morning of 2026-09-14) imagined an update script in each installation's overlay
repo. The installer decisions that afternoon changed the ground: most installations will have **no
overlay** — they run the ready-made agents — and Plan 1 already does most of an update for them. Re-running
a newer release's install command swaps the keeper, pulls the new images, applies new migrations and
removes the images of the release before last.

What is missing is the part that makes an update safe for someone who is not watching: a database
snapshot before anything changes, a real check afterwards, automatic rollback when the check fails, and
telling the owner what changed. That — plus the three release pieces the split plan leaves undone (the
overlay-version check, the plain-language CHANGELOG, and candidate → final) — is this spec.

## Decisions (2026-09-14)

| Question | Decision | Why |
| --- | --- | --- |
| How installations update | **One command on every box, run by the keeper** (`lares update`), for ready-made and overlay installs alike; the console button later calls the same action | Rejected B (a script per overlay repo: ready-made installs have no overlay, so a second mechanism anyway) and C (automatic nightly updates: a bad release breaks every house unattended, and nothing should happen without the owner). |
| How a final release is made | **Promote: the final tag re-labels the candidate's exact images** — same digests, no rebuild | Members get byte-for-byte what ran on the owner's box. The split plan's v0.1.0 rebuild-from-the-same-commit is replaced by this from the first release after it. |
| How long a candidate runs first | **By release size:** a fix release one full day (a morning brief, an evening brief, a night of schedules); a feature release 7 days; a security fix may be promoted after 1 day with a note in the release | Fixes should reach members fast; features carry the risk. |
| Automatic updates | **None at launch.** A notice and one command | Nothing happens to a house without its owner. |
| Where overlays learn about new releases | **In the overlay repo**, by a scheduled job — the engine never references an overlay | The engine repo contains nothing about any installation (its CLAUDE.md rule). |

## Part 1 — What a version number means

`vMAJOR.MINOR.PATCH`, with candidates `vX.Y.Z-rc.N`.

| Kind | Example | May contain |
| --- | --- | --- |
| Patch | 0.3.**1** | fixes and security fixes; migrations only when a fix needs one; no new settings |
| Minor | 0.**4**.0 | features, new settings, new migrations |
| Major | **1**.0.0 | a change to the overlay format (the `overlay` number in `agent.json`) — the only kind that can break an owner's own agents |

**The migration rule — "add now, remove later":** every migration in a release must leave a database the
*previous* release's code still runs against. Add a column now, stop using the old one, remove it in a
later release. This is what makes rolling images back safe without rolling the database back. A release
that must break the rule is a major one and says so in its CHANGELOG entry, marked *breaking*.

Candidates are seen only by installations on the candidate channel (the owner's box; the local VM).

## Part 2 — What a release contains

1. **The tag** and the **published manifest** (`release.json`, a release asset): every image by digest — the
   box services, the ready-made agents, the console, the sync jobs and, in the published copy, the keeper
   itself. It also carries:
   - `overlay`: the overlay format version this release accepts;
   - `kind`: `patch`, `minor`, `major` or `security`;
   - `tools`: for each ready-made agent, its resolved tool list as sorted names plus a sha256, recorded
     while the image is built (the same resolved list the split's gate compares).
2. **The one-file installer** (`install.sh`, Plan 1).
3. **A CHANGELOG section**, plain language for an owner, each line marked:
   ```markdown
   ## v0.4.0 — 2026-10-02
   - **feature** — Your agents can read PDF attachments in Telegram.
   - **fix** — The morning brief no longer lists a cancelled meeting.
   - **security** — Sign-in links now expire after 10 minutes instead of an hour.
   ```
   Every change a user can notice adds its line under `## Unreleased` in the same change. The release
   workflow moves `Unreleased` under the new version and **refuses a tag with no section**.
4. **Release notes** carrying: the CHANGELOG section, `overlay: N`, the dogfood dates ("ran on the dogfood
   box from … to …"), and the golden-path run row (ORB-197) once that run exists.

**Promote** is started from the owner's Mac (`scripts/promote.sh <candidate>` in lares). It reads the dogfood
box's update record over SSH (`lares update history --json`: when the candidate was installed, whether its
check passed — written by `lares update`, Part 3) and refuses a candidate that failed its check or has not
run its required time (the decisions table, measured from that install). Only then does it trigger the
promote workflow, which re-tags every image of the candidate to the final version without rebuilding and
publishes the final release with the candidate's manifest re-labelled. The box never reports anything to
GitHub; the Mac asks the box, as the owner's own tooling for his own box.

## Part 3 — The update command

`lares update [version] [--candidate] [--yes]`, on the box:

1. **Find the target.** The latest final release, or the latest candidate on the candidate channel
   (setting `updates.channel`: `stable` | `candidate`). An explicit version must be newer than the running
   one; going back is `lares rollback`.
2. **Tell the owner.** Print the CHANGELOG between the running and the target version — security lines
   first — and ask "Update now?". `--yes` skips the question (for the fleet command, ORB-287).
3. **Check before touching anything:** enough disk for the new images and a snapshot; on an overlay
   install, that the overlay's agent list for this engine version exists and its `overlay` number matches
   the release's (otherwise stop: *"your overlay hasn't been rebuilt for v0.4.0 yet"*).
4. **Snapshot** every database (`pg_dump`) to `/srv/lares/snapshots/pre-<version>.dump`; keep the last two.
5. **Swap and apply.** A short-lived helper container replaces the keeper with the target's keeper (a
   process cannot replace its own container); the new keeper runs install in update mode — pull, migrate,
   apply.
6. **Check, within five minutes:** every service running and healthy; each agent's live tool list
   (`/eve/v1/info`, read on the box network) equal to the manifest's; every migration of the release in the
   ledger; the gateway and the console answering.
7. **Pass →** record the update (version, time, check result) in an update history the keeper keeps
   (`lares update history`; the promote step reads it over SSH), print *"updated v0.3.1 → v0.4.0"*.
   **Fail → roll back automatically:** the previous manifest re-applied (its images are still on disk —
   Plan 1 keeps one previous release), then the helper swaps the previous keeper back. The database stays
   as it is (safe by the migration rule); the snapshot stays. Print what failed and *"your house is back
   on v0.3.1; nothing was lost"*, and exit non-zero.

`lares rollback` does step 7's rollback by hand, to the previous release only. A migration that fails
halfway rolls back that file (Plan 1's migrate runs each file in one transaction); earlier files of the
same release stay applied, which the migration rule makes harmless; the update is then rolled back as a
failed check. The snapshot exists for the case the rule was broken by mistake: `lares restore-snapshot`
prints the exact restore steps rather than doing it — restoring a database is never automatic.

The keeper action `update` (reserved in Plan 1) is the same flow, so the console's button later is a UI
over it. Progress is written to `/etc/lares/update-status.json`, which the CLI and the console both read.

## Part 3a — Two modes, overlay mode first (amended 2026-09-15)

> **ADR-0015 (2026-09-15) changes the long-term picture.** Agents become definitions resolved at runtime, so an
> update for a definition-based installation is new images plus a restart, and the check compares each agent's
> live tools with what its definition grants. The overlay mode below becomes **transition machinery for
> the owner's box** — and **the owner decided 2026-09-15 not to build it**: v0.2.0 ships by the manual route, and this
> spec's update flow is built for definition-based installs only (its plan is revised after the agent-definitions
> spec). Everything else in this spec — versions, the release, promote, the keeper's update
> flow, the notice — stands.

The flow in Part 3 has one step that differs by the kind of installation: **how the new images get into the
compose file**. Everything else — finding the target, the changelog, the snapshot, the keeper swap, the
migrations, the check, the rollback, the history — is shared code.

| Mode | Who | Where the compose file comes from | Built by |
| --- | --- | --- | --- |
| **Overlay** | installations with their own overlay repo — first, the owner's box | the overlay repo's `box/` folder, **as given**: the overlay's build writes the new image pins into it and tags the overlay `engine-vX.Y.Z[-rc.N]`; the keeper copies that tag's `box/` files into place | **this ticket** |
| **Rendered** | ready-made installations (no overlay) | the keeper renders it from settings + the release manifest (installer Plan 1) | the installer (ORB-266), wiring its renderer into the same flow |

In overlay mode the keeper changes **nothing it did not receive**: the network map, the fixed IPs, the host's
nft egress seal and every environment value stay exactly as the overlay has them (the owner, 2026-09-15:
"updating only"). Rolling back = the previous overlay tag's `box/` files, brought up again. Redrawing an
overlay install's compose from settings remains the installer's later "adopt" step.

Overlay-mode details that bind the plan:
- **Both compose files, always.** the owner's box runs `compose.yaml` + `compose.override.yaml`; a command with
  only the first silently drops the override's settings (recorded trap). The keeper reads the file list
  from its configuration and never runs compose with a subset.
- **The drift guard is kept in step:** after a passed update the keeper re-accepts the drift baseline
  (`compose-drift-guard.sh --accept`); after a rollback, likewise, on the restored files.
- **The migration ledger adopts once:** the first keeper run on an existing database records every engine
  SQL file already applied (`migrate --adopt-existing`), so the ledger starts from the truth instead of
  re-running history.

## Part 4 — Overlay installs

- **`agent.json` carries `"overlay": N`.** The kit's build check in the overlay's Dockerfile compares it
  with the engine's number and fails closed with a sentence an owner can act on:
  *"This overlay is written for overlay format 1; engine v1.0.0 expects 2. See the CHANGELOG for v1.0.0
  (the 'breaking' lines) for what to change."*
- **The overlay's build publishes, per engine version, a tag and an agent list.** It writes the new image
  pins into `box/compose.yaml`, commits, tags the overlay `engine-vX.Y.Z[-rc.N]`, and attaches `agents.json`
  = `{ engine, overlay, agents: { <name>: { image, tools } } }` to that tag's release. The keeper reads both
  with the secret `overlay-read-token` (the overlay repo is private).
- **A scheduled job in the overlay repo** (hourly) sees a new engine release — candidates too, on the
  candidate channel — bumps the pin, builds, runs the kit's checks, and publishes the tag + agent list. When
  the engine promotes a candidate, the job tags the same overlay commit `engine-vX.Y.Z` and publishes the
  same agent list: the overlay's images are promoted exactly like the engine's.
- **the owner's cycle:** engine candidate tagged → lares-heiberg rebuilds itself within the hour →
  `lares update --candidate` on lares-agent-1 → the dogfood time → promote → his box already runs the
  promoted bytes. This replaces the manual route (bump `ENGINE_TAG`, pin the digest by hand, accept the
  drift guard) from the first release this ticket ships.

## Part 5 — The update notice

- Setting `updates.check`, **on by default**. Once a day the console (and `lares status`) reads GitHub's
  public releases list for the engine repo and sends nothing else; the docs say exactly that — GitHub sees
  the request, as it sees any web request.
- Shows *"v0.4.0 available — 1 security fix"* with the CHANGELOG section. On the candidate channel it shows
  candidates.
- While the repo is private (until ORB-272) the check cannot read the list and says *"can't check for
  updates yet"* — never an error, never a wrong "you're up to date".

## Part 6 — What proves it worked

1. One real release: candidate → the local VM and the owner's box via `lares update --candidate` → the
   dogfood time → promote → final, with the final's digests equal to the candidate's.
2. Three deliberate failures, each in the local VM against **a copy of the owner's fleet compose with fake
   secrets** (the owner, 2026-09-15 — the live box only ever sees the real, good release):
   - an overlay built against the wrong format fails its build with the Part 4 sentence;
   - a release whose agent tool list differs from its manifest fails the check and the house comes back
     on the previous version by itself;
   - a migration that fails halfway leaves the house on the previous version, the snapshot on disk.
3. Promote refuses a candidate younger than its required time.
4. Keeper tests for every step, with fakes for Docker and GitHub; the GitHub releases API and the image
   re-tag are proven by live runs, not fixtures (root CLAUDE.md § Third-party APIs) — the re-tag's claim
   "same digest" in particular.

## Part 7 — Order and dependencies

- **Order (amended 2026-09-15):** the split (its Task 12 tags `v0.1.0` from the running box) → **this
  ticket** → the first payload (ORB-286 batch-6, `v0.2.0-rc.1` → dogfood → `v0.2.0`) → the installer
  (ORB-266), which reuses the keeper core built here and adds rendered mode.
- **Built here, pulled forward from installer Plan 1:** the settings package, the guarded migrate with its
  ledger (+ adopt), the release manifest, file secrets, the action sockets and the host `lares` command.
  Installer Plan 1's matching tasks become "already built — verify only".
- **Plan phases:** (1) the keeper core; (2) CHANGELOG discipline, the published-manifest additions
  (`kind`, `tools`, keeper), the overlay-format check; (3) the update and rollback flow in overlay mode +
  the host command + the bootstrap that puts the keeper on an existing box; (4) the overlay side in
  lares-heiberg (scheduled rebuild, pins, tag, agent list); (5) promote; (6) the notice; (7) the Part 6
  proofs — the failures in the local VM, the real release on the owner's box.

## Non-goals

- Automatic updates.
- The console's update button (a UI over the `update` action, with the console work).
- The fleet command (ORB-287) — this spec gives it `--yes` and a non-zero exit on a failed check.
- Signed releases and image signatures (cosign or similar) — a later hardening step, recorded here so it
  is not forgotten.
- Downgrades past the previous release.

## Open questions

None by design. Two facts are established by live runs in the plan: that re-tagging keeps the digest, and
the exact shape of GitHub's releases response the notice and `lares update` read.
