# Backup and restore per installation — DRAFT for the owner (ORB-187, Lares sub-project 10)

**Status:** DRAFT, 2026-09-03. A circle launch blocker: no installation may reach a second real user
without this. Everything below generalises what the owner's own box already does and what its two
failures taught (`docs/runbooks/backup-and-restore.md`).

## What the box taught, and what the engine must therefore enforce

| Lesson (date) | Rule it becomes |
|---|---|
| The nightly dump backed up NOTHING for two weeks and reported success (2026-07-01 → 07-14) | a backup is verified by reading the ARCHIVE, never by the job's exit code (`backup-verify.sh` asserts every directory and a plausible dump size) |
| The restic password and `TOKEN_ENC_KEY` existed only on the box they protect | the three unrecoverable secrets are escrowed by the owner BEFORE the first agent starts, and the escrow is proven from another machine |
| An empty `HC_URL` pinged nothing for weeks (ORB-150) | arming a backup without a live heartbeat target is refused; a missing target fails closed, loudly |
| Atlas, the network replica and uncommitted Brain were in no backup | coverage comes from an installation MANIFEST, not from a hand-typed path list |
| Only the owner knew the restore steps | restore is a command, rehearsed on a schedule, with its last pass date visible |

## What is backed up — the installation manifest

The engine writes `installation.json` at install time and every component registers what it
owns; the backup reads the manifest, never a hard-coded list:

- **Vaults**: every notes store (`brain`, `atlas` — bare git repos AND working trees, because an
  uncommitted note is still a note);
- **State**: the installation's Postgres (`lares_state`, every schema — workflow, graphile,
  identity, spend);
- **Agent data**: each agent's data directory (`/srv/eve-<name>`: trips, ledgers, caches that are
  expensive to rebuild);
- **The network replica** (`/srv/network`), knowing it is a REPLICA of a Mac-side source — restore
  order matters (source first if it exists);
- **A secrets MANIFEST** — the list of secret names and a fingerprint of each (sha256 of the value),
  never the values — so a restore can say which of the 26 credentials it is missing and which it
  got back, instead of discovering each one as an outage;
- **Not backed up, by design**: secret values (escrow is the owner's), images (the registry is
  the store), logs.

## Where — the owner's own storage, never a default bucket

The sovereignty posture forbids a default US bucket, and "someone who is not the owner" has no
Hetzner Storage Box by default. So the target is a REQUIRED install-time choice with three
supported shapes, all restic: an SFTP target (Hetzner Storage Box, any host the owner controls),
an S3-compatible EU bucket (Scaleway, Hetzner Object Storage, their own MinIO), or a local path
on a second disk (accepted with a written warning that one machine is not a backup). The
installer refuses to start the first agent until a target exists and `restic init` has succeeded
against it. The default retention is the box's: daily for 14, weekly for 8, monthly for 6.

## How — one script family, driven by the manifest

`backup.sh` (restic + an `age`-encrypted `pg_dump` per database), `backup-verify.sh` (reads the
archive: every manifest directory present in the newest snapshot, every dump larger than a floor
derived from the previous one, the newest snapshot younger than the schedule allows), and
`restore-drill.sh` (below) become engine scripts installed by the overlay with the manifest as
their only input. Timers: backup nightly, verify nightly after it, drill monthly. All three are
what `input-freshness.sh` already is on the box: they check the thing, not the log.

## The heartbeat — alerting on absence

`backup-verify.sh` pushes UP/DOWN to the installation's uptime monitor (Kuma or Healthchecks —
the engine ships the Kuma path because the box runs it), with the two rules the box paid for:
the monitor window is at least 2× the pusher's period on BOTH interval and retry, and **a
missing or unreachable push URL is a DOWN of its own** — the verify script refuses to report
"fresh" without a monitor to tell. Arming is proven the way ORB-150 proved it: a deliberately
failed run must page the owner before the installation is called protected.

## Restore, rehearsed — `restore-drill.sh`

Monthly, unattended: restore the newest snapshot into a scratch directory and the newest dump
into a scratch database, compare against the manifest (every directory, every schema, row counts
within tolerance of the live database), record the pass date where the owner can see it (the
console's health page and the verify heartbeat's message), and delete the scratch. A drill that
has not passed in 45 days is a DOWN. Before the first outside user: one FULL drill onto a fresh
box, timed, written into that installation's runbook — the box's own drill (2026-07-15, passed)
is the template.

## The owner's escrow — the step that cannot be delegated

At install the engine prints the three secrets that have NO recovery path — the restic password,
`TOKEN_ENC_KEY`, the storage target's key — with the instruction to store them in a password
manager AND one copy kept physically apart, and it does not mark the installation protected until
the owner proves the escrow from a machine that is not the box: `restic snapshots` against the
repository with the password taken from the escrow. Everything else in the secrets manifest is
re-mintable by hand — painful, not fatal — and the manifest is what says which.

## Acceptance

- A fresh installation cannot start its first agent without a backup target, an initialised
  repository, a live heartbeat and a proven escrow.
- `backup-verify.sh` reads the archive and pages on absence, staleness and missing coverage; a
  deliberately staled backup pages the owner (proven once per installation).
- `restore-drill.sh` passes monthly and its last pass date is visible; one full drill onto a fresh
  box is written up before the second real user.
- the owner's box is migrated onto the same scripts (the manifest replaces its hand-typed `PATHS`),
  with no gap in its existing coverage — the `backup-verify.sh` assertions from ORB-154 survive
  as manifest rules.

## Decisions (all three settled 2026-09-04)

1. ~~Is a local-path target acceptable at all for a circle member?~~ **Decided 2026-09-04: yes,
   with the written warning and a monthly reminder** — refusing it blocks the hobbyist installs
   the circle starts with.
2. ~~Does the console own "protected / not protected", or is the CLI enough for v1?~~ **Decided
   2026-09-04: the console owns it.** Lares is for non-technical owners; the command line is
   plumbing. "Protected / not protected", the escrow proof, the last drill date and the target all
   get a console page; the heartbeat message mirrors it.
3. ~~Scratch database or throwaway container for the drill?~~ **Decided 2026-09-04: scratch
   database for the monthly drill, a throwaway box for the one full drill** before the second
   real user.

## Non-goals

Cross-installation replication; backing up the Mac-side sources (the network importer's source
database is the owner's Mac and stays their own Time Machine's problem, stated in the manifest);
secret rotation.
