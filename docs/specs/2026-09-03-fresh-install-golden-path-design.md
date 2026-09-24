# The fresh-install golden path — QA for the installation the owner does not have (ORB-197, DRAFT)

**Status:** DRAFT for the owner, 2026-09-03. A circle release gate; nothing here runs yet.
**The risk it exists for:** every test in the fleet runs against a box carrying years of state —
populated Postgres, vault history, working OAuth grants. A circle member starts from NOTHING, and
no machinery measures that experience. "Works on the owner's box" says nothing about a blank server
and the docs alone.

## The path, as a numbered run

Each step names what it exercises, whether it is scripted or human, and what "pass" means. A
failure at any step files as an INSTALLER or DOCS bug (never as "the tester did it wrong"), and
the run stops there — the number of the step reached is the run's score.

| # | Step | Scripted / human | Exercises | Pass |
|---|---|---|---|---|
| 1 | Provision a throwaway Hetzner box (CX-class, EU), Docker, Tailscale | scripted (the box runbook's own commands) | the box baseline | SSH over Tailscale works; nothing else installed |
| 2 | `install` — the overlay's one command: engine checkout, secrets directory, Postgres, the migrations `sql/*.sql` applied IN ORDER | scripted | the "no auto-migrate" rule, the secrets-by-file convention | `lares_state` has every schema the manifest lists; zero secrets in env |
| 3 | Backup target + escrow (ORB-187) | human (the escrow proof cannot be delegated) | the installer's refusal to continue without a target, an initialised repository, a live heartbeat and a proven escrow | `restic snapshots` succeeds from the tester's laptop with the escrowed password |
| 4 | Onboarding wizard: owner identity (canonical id), org, time zone, doors | human (the wizard is what is under test) | the identity registry, the org/member tables (sql 028/029), quiet hours | the console (or CLI) shows one owner, one org, zero agents |
| 5 | Connect Calendar + Gmail (both accounts if the tester has two) | human | the fleet's own GCP project's OAuth, `oauth_tokens` + `TOKEN_ENC_KEY_FILE` | a read tool lists today's events; a Gmail search returns a thread |
| 6 | Create the first agent from a role template (chief-of-staff), a name, a voice | scripted (the kit's `assemble`) + human (the voice text) | `agent.json` grants, the assembled persona, the write-shape lint, the declaration conformance suite | `pnpm build && pnpm test` green for the new service; the persona names only granted capabilities |
| 7 | First door: Slack app from the read-only manifest as a RECORD, the relay URL, one DM | human | the "no in-repo manifest is applyable" rule (ORB-153), the relay, sealed egress | the agent answers a DM within the turn budget; the approval card on a gated write renders without the raw block |
| 8 | Wait for the first brief (or force the slot on a test clock) | scripted | the schedule gate, the brief contract, the freshness heartbeat (ORB-175) | a morning brief arrives — or "nothing to say" leaves a heartbeat row |
| 9 | Teardown honesty: run the restore drill from the box's first backup onto a second throwaway box | scripted (ORB-187's `restore-drill.sh`) | the whole backup path | the manifest comparison passes; the first brief's session is in the restored database |
| 10 | Destroy both boxes; record the run | scripted | — | the run's row: date, engine commit, step reached, bugs filed |

## Rules of the run

- **Docs only.** The tester may read `docs/` and the CLI's own output — never this repo's HANDOFF,
  never a Slack thread, never the owner. Every time the tester has to ask, that is a bug in the docs.
- **A fresh account.** The tester's Google, Slack and Telegram identities are throwaway ones
  created for the run; the fleet's own OAuth project must admit them without the owner's intervention.
- **Time-boxed.** A step that takes longer than its budget (installer 20 min, wizard 15 min,
  doors 20 min) is a finding even if it eventually passes.
- **Every release.** Before a circle release, one full run on the release candidate; the run's
  row goes in `docs/runbooks/golden-path-runs.md`. The dogfood gate (the owner's own box on the same
  candidate for a week) is its sibling, not its substitute.

## The parity gap, stated once (2026-09-04)

the owner's agents run on a box built by hand over months. The seven September drafts make the fleet
more capable and safer; none of them gives a second person the path from a blank server to a
working Saga. That path — the `install` command, the wizard, the console that fronts every knob —
is the real Lares parity work and sits above the drafts in priority. **The console comes first:**
Lares is for non-technical owners, so every setting a spec introduces lands as a console surface,
and the UI gets its own design pass once the features are in. The brief for that pass, in the owner's
words: simple, minimal but beautiful and delightful, with some playfulness.

## What exists today, and what the run will hit first

Steps 6 and 7 mostly exist (role templates, `assemble`, the conformance suites, the read-only
manifest rule); step 8's heartbeat is ORB-175; step 3 and 9 are ORB-187; **steps 2 and 4 do not
exist** — there is no `install` command and no wizard, only runbooks written for one box. The
first run will stop at step 2. That is the point: the score is the roadmap.

## Acceptance

- The table is agreed and lives beside the parent spec's QA section.
- One run has been performed on a throwaway box by someone who is not the owner (or by the owner with
  a fresh account and the docs-only rule), its row recorded, its bugs filed.
- The run is repeated on every circle release candidate; the row is part of the release note.

## Open questions

1. ~~Who is the first tester?~~ **Decided 2026-09-04: the owner first, on a throwaway Hetzner box —
   not locally.** A local run skips exactly what the path exists to test: the box baseline, secrets
   by file, sealed egress and the backup target. A circle member runs it for the first real release.
2. Does the run include Telegram (a second bot to mint) or is Slack enough for v1?
   (Recommendation: Slack only for the gate; Telegram optional.)

## Non-goals

Load testing; multi-user onboarding (ORB-185's DPIA gate stands); the console's UI polish.
