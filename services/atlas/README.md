# @lares/atlas — the Atlas sync job

Keeps the **Atlas** (`/srv/atlas`, the business knowledge store every business agent grounds
on) derived from its canonical sources, instead of rotting as a hand-tended wiki.

Part A seeded the store by hand. This is Part B: the job that keeps it current.

Spec: `docs/superpowers/specs/2026-08-11-atlas-knowledge-layer-design.md` (§4)
Plan: `docs/superpowers/plans/2026-08-11-atlas-part-b-sync-job.md`
Runbook: `docs/runbooks/atlas-sync.md`

## What it actually does, once a day

1. **Apply** — execute decisions Bendik has already made (a 👍 writes the note; a 👎 writes
   nothing but still records that these exact sources were considered).
2. **Mechanical** — recompute the fields that have exactly one right answer: `last_synced`,
   `canonical_sources`, the OKF `type:`, and `_portfolio.md`'s generated card block. No model,
   no gate.
3. **Narrative** — for each venture note, re-read its sources; if their fingerprint has moved
   since the last accounted-for one, draft new prose and **propose** it. Never overwrite.

The order is load-bearing and is enforced by tests, not by comments.

## The one rule a future reader must not undo

**`last_synced` moves only when something else moved.**

Stamping it every run makes the wall clock a content source: every tick a diff, every diff a
commit, every commit a change to an `atlas:` source that other notes derive from. That is the
whole "correct for one tick, broken on the next" failure class arriving through the front
door. `mechanicalRefresh` takes the date as a **parameter** and never reads the clock, which
is what lets `tests/steady-state.test.ts` catch a regression.

## The four store prefixes

`canonical_sources` entries carry exactly one of these. A fifth must never be invented — an
unrecognised prefix is an error, not a fallback.

| Prefix | Means | Read by |
|---|---|---|
| `repo:` | a path in the repo the note's `codebase:` names | GitHub contents API — so *canonical* means **the pushed state** |
| `vault:` | a path under `/srv/brain` | the mounted vault, read-only |
| `notion:` | a Notion page id | the Notion API |
| `atlas:` | another note in this store | the mount itself |

A bare, unprefixed path is legacy shorthand for `repo:` and the mechanical pass normalises it
— but only on a note that has a `codebase:` for it to mean something against.

## The three note states

| State | Means | What the job does |
|---|---|---|
| `ok` | every source read | may propose a refresh |
| `sources_missing` | a source is genuinely gone (404 / absent file) | **flags, never empties**; proposes nothing |
| `sources_failed` | a source could not be read (network, proxy denial, auth, 5xx) | same, and reported differently |

`missing` and `failed` are different facts and no code path may collapse them. A firewalled
call that reads as "the file isn't there" would propose a note with its content deleted —
that is the ORB-51 defect class, and `lib/adapters/github-source.ts` exists to keep the two
apart. Pings fire on **transition**, so a source unreachable for a week is one message.

## Operator commands

Run on the box, where the store, the database and the tokens are:

```bash
cd /opt/agent-box            # never `docker compose -f …` — that suppresses the override file
docker compose exec atlas-sync /app/node_modules/.bin/tsx services/atlas/bin/atlas-sync.ts <flag>
```

| Flag | Does |
|---|---|
| `--doctor` | probes all four stores and the gateway. Writes nothing. |
| `--check-okf` | conformance report. Writes nothing; exits 1 if anything is non-conformant. |
| `--migrate-okf` | the one-shot OKF migration. Idempotent. |
| `--once` | one tick now, bypassing `ATLAS_SYNC_LIVE`. |
| `--list` | open proposals, with their diffs and both consequences. |
| `--approve <id>` / `--reject <id>` | record a decision. The **write happens on the next tick.** |
| *(no flag)* | the daemon — only runs when `ATLAS_SYNC_LIVE=1`. |

Exactly one mode per invocation; two is an error rather than a silently-picked winner.

## Configuration

Secrets are read from **files**, never plaintext env vars.

| Variable | Notes |
|---|---|
| `ATLAS_PATH` / `BRAIN_PATH` | default `/srv/atlas` and `/srv/brain` |
| `GITHUB_TOKEN_FILE` | one fine-grained read-only PAT, Contents scope, the seven venture repos. One suffices because all seven are owned by the `Heiberg-Industries` org — a fine-grained PAT is scoped to a single owner |
| `NOTION_TOKEN_FILE` | the same integration token notion-sync uses |
| `GATEWAY_KEY_FILE`, `GATEWAY_URL` | the LiteLLM gateway |
| `ATLAS_DRAFT_MODEL` | **no default, by design** — model choice is a deploy-time decision (standing portfolio policy), not something this repo pins months in advance |
| `ATLAS_SYNC_TICK_MS` | daily by default; a non-numeric value is refused at startup, because `setInterval(fn, NaN)` fires every millisecond |
| `ATLAS_SYNC_LIVE` | `"1"` and nothing else starts the daemon |

## Two guards run before the first tick

Both exist because a composition root wired to a **wrong-but-present** value typechecks and
passes the entire test suite. notion-sync shipped exactly that defect three times in one phase.

- `assertReaderWiring` — four prefixes, four distinct reader instances, each reporting the id
  its prefix expects.
- `probeLocalStores` — each local store must answer a file only it has (`SCHEMA.md` for the
  Atlas, `index.md` for the vault). Two correctly-built readers pointed at one root pass every
  type and id check; only asking the filesystem settles it.

A mis-wired deploy therefore crash-loops loudly instead of quietly deriving every note from
the wrong store.
