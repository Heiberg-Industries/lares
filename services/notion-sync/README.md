# @lares/notion-sync

Keeps a Markdown vault and a Notion workspace in step. Notion is the human surface;
Markdown on disk stays the substrate agents read and write.

**Phase 1 (this release)** ships one job: filling Notion meeting `Attendees` from Google
Calendar. The config, Notion adapter and state tables it introduces are the foundation the
later phases reuse — `vaultPath` and `projects[]` are validated today but not yet read by
the attendee job itself.

Design: `docs/superpowers/specs/2026-08-03-notion-vault-sync-design.md`

## Configuration

The service is driven entirely by a JSON config — no project names live in the code, so
this package is usable outside Heiberg Industries. Copy
`ops/notion-sync.config.example.json` and point `NOTION_SYNC_CONFIG` at it (default
`/etc/lares/notion-sync.config.json`).

| Key | Meaning |
|---|---|
| `notionVersion` | Pinned Notion API version. Must be `2026-03-11` or later (compared as an ISO date) — earlier versions lack the Markdown Content endpoints. |
| `meetingsDataSourceId` | Data source (collection) id of the Meetings database. |
| `vaultPath` | Vault root, e.g. `/srv/vault`. Validated at load time; not read by the Phase 1 attendee job — reserved for the vault-translation phases. |
| `selfEmail` | The owner's own address, or a **list** of them. Sorted last in the generated attendee string. A principal with enrolled mailboxes in more than one org owns more than one address; the job additionally unions this with every mailbox the calendar resolver actually resolves, so this key only has to name aliases the resolver cannot see. |
| `calendarWindowDays` | How many days back from now to search for a matching calendar event (the search window always also extends one day forward, to catch same-day meetings). Optional — defaults to `400`. Must be a positive, finite number. |
| `projects[]` | `{ notionProject, vaultFolder }` pairs — the Notion `Project` select value mapped to a vault folder. Must be non-empty with unique `notionProject` values. Validated today but not read by the Phase 1 attendee job — reserved for later phases. |
| `deskDirs[]` | `{ dir, project, exclude? }` — the human-editable folders, each pushed by the same engine as the wiki with its own Notion `Project`. Presence of this key is what turns the desk passes on; `docsDataSourceId` is required alongside it (desk rows live in the same Docs database). Dirs are bare vault-relative paths and may not overlap `wikiDir` or each other. `exclude[]` names sub-folders (relative to `dir`) that this dir's passes must leave alone — the carve-out that hands `<dir>/transcripts/` to the transcript pass. |
| `twoWayDirs[]` | The pilot dial: which desk dirs `notion-sync enable-two-way` will accept. Every entry must be one of `deskDirs`' dirs. Listing a dir here changes nothing on its own — direction is per row, and only the command flips it, only after both fidelity legs pass. Optional, defaults to `[]`. |
| `mirrorFilePrefixes[]` | Vault-path prefixes that stay one-way md→Notion whatever folder they live in — machine-generated files inside an otherwise human-edited desk folder. `enable-two-way` refuses them. Optional, defaults to `[]`. |
| `transcripts` | `{ dir, projects[] }` — where Notion Meetings transcripts land in the vault. Absent ⇒ the transcript pass does not run. |
| `people` | `{ dataSourceId, databaseId? }` — the Notion **People** database the attendee projection writes to. Absent ⇒ the People pass does not run. See *The People database contract* below for the exact properties it requires. |

**Two known gaps in config validation**, both recorded rather than fixed because tightening a
parser is how a whole service stops starting over one line:

- `wikiDir` is checked for slashes inline instead of going through `requireBareDir` like every
  other directory key, so a value with surrounding whitespace (`"wiki "`) parses. It would then
  simply not match any real folder.
- `syncDirPrefixes` — the set of folders the fidelity gate treats as sync-eligible — is
  deliberately NOT narrowed by `deskDirs[].exclude`. A carved-out sub-folder still gets a
  fidelity verdict recorded; nothing acts on it, because the passes that could are scoped out
  of that sub-tree by other means.

## Environment

Every secret below is read through the box convention: `<NAME>_FILE` (a path, typically
`/run/secrets/<name>`) wins if set, otherwise `<NAME>` as a plain env var.

| Variable | Purpose |
|---|---|
| `NOTION_TOKEN` / `NOTION_TOKEN_FILE` | Notion integration token. Required. |
| `NOTION_SYNC_CONFIG` | Path to the config JSON. Optional — defaults to `/etc/lares/notion-sync.config.json`. |
| `NOTION_SYNC_PRINCIPAL` | **Required, no default.** The OAuth principal whose enrolled calendar mailbox(es) the attendee job reads events from. There is deliberately no fallback: a missing or wrong principal must fail loudly rather than silently resolve to zero mailboxes and flag every meeting row `unmatched`. |
| `TOKEN_ENC_KEY` / `TOKEN_ENC_KEY_FILE` | Required, 64 hex characters (32-byte AES key). Must equal the key the calendar OAuth tokens were encrypted with. This one key decrypts *every* stored OAuth token, so prefer the `_FILE` form and a mounted secret over a plaintext env var. |
| `GOOGLE_CLIENT_ID_HEIBERG` / `GOOGLE_CLIENT_SECRET_HEIBERG` (and the matching `_ZERO7` pair, each with an optional `_FILE` variant) | Per-org Google OAuth client credentials. Phase 1 only recognizes these two org suffixes. At least one complete pair must be set for the job to start — but that check alone is not enough: set one pair **per org the principal has an enrolled mailbox in**. An org with an enrolled mailbox but no configured pair is not a startup error; it's silently skipped per-mailbox (a `console.warn`, not a thrown error) inside the calendar resolver, so that org's real meetings surface as ordinary `no-candidate` unmatched rows — indistinguishable from a genuine no-invite meeting. |
| `GOOGLE_REDIRECT_URI` | Optional. Only used by the initial OAuth consent flow, which this service never runs — it only refreshes tokens that were already enrolled elsewhere. Safe to leave unset. |
| `SIGNAL_SPINE_URL` / `SIGNAL_SPINE_TOKEN` (with the usual `_FILE` variant for the token) | Where the human pings go — a mirror edit reverted, a conflict frozen, an error, and the stale-proposal escalation. **Proposals themselves no longer ping here** (ORB-38): a proposal awaiting approval is a DECISION, and decisions go to Saga's DM, where Bendik answers and 👍s her card. Both optional: unset, every ping is a `console.log` line instead, so the service can be deployed before the pair is wired without a single behaviour change. |
| `TWENTY_BASE_URL` | Base URL of the Twenty CRM instance the People projection reads, e.g. `https://crm.example.com`. **Required once `people` is configured**, and it has no default: a wrong-by-default host would read someone else's CRM. |
| `TWENTY_KEY` / `TWENTY_KEY_FILE` | Twenty API key, read-only in practice — the adapter has no write method. Required once `people` is configured. On the box point `TWENTY_KEY_FILE` at the existing `/run/secrets/twenty-key`. |
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` | State database connection. All optional, defaulting to `db` / `5432` / `lares_state` / `lares`. |
| `PGPASSWORD` | State database password. The connection helper reads `/run/secrets/db_password` first and falls back to this env var. |

The container entrypoint (`bin/notion-sync.ts`) adds four of its own:

| Variable | Purpose |
|---|---|
| `NOTION_SYNC_LIVE` | Must be `"1"` for the daemon to start. Anything else logs "gated OFF" and exits 0. `--once` bypasses the gate. |
| `NOTION_SYNC_TICK_MS` | Pass cadence. Default `3600000` (hourly). |
| `NOTION_SYNC_TOLERANCE_MINUTES` | Start-time match window. Default `15`. |
| `NOTION_SYNC_DRY_RUN` | `"1"` plans and reports but writes nothing. Same as passing `--dry-run`. |

Git identity for the apply pass (`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` and the `COMMITTER`
pair) comes from the environment like every other writer in the fleet; `safe.directory` cannot
be set via env, so the container also needs a mounted `/etc/gitconfig`. Without those, applies
fail at the commit rather than silently writing an uncommitted file.

## Run

**`pnpm typecheck` is a gate again.** It sat red on `main` from 2026-09-01 to 2026-09-05 (ORB-223)
— six errors, all in `tests/attendees.test.ts` and `tests/run.test.ts`, `lib/` clean throughout —
which meant a real type error in `lib/` would have hidden behind the pre-existing red, and the
image workflows run no tests to catch it. It exits 0 now; keep it that way.

Locally, through the Lares CLI:

```bash
pnpm lares notion-sync status                            # resolved config + row counts
pnpm lares notion-sync attendees --dry-run               # show the plan, write nothing
pnpm lares notion-sync attendees                         # apply
pnpm lares notion-sync attendees --tolerance 30          # widen the match window (minutes, default 15)
```

The per-pass commands (the daemon runs all of them, in this order, every tick):

```bash
pnpm lares notion-sync pull --dry-run                    # what Notion holds, and what it would mean
pnpm lares notion-sync apply                             # carry out approve/reject decisions
pnpm lares notion-sync wiki                              # push the wiki mirror
pnpm lares notion-sync desk-push                         # push every desk folder
pnpm lares notion-sync people --dry-run                  # who the meetings name, and what it would project
```

And the operator commands — the one-shot rollouts, the frozen-row decision, and approving or
rejecting a pending proposal. **These are dead as written above**: the `lares` CLI that used to
run them is gone (deleted in the 2026-09 repo split), and the box has no lares checkout at all —
so every one of them is a flag on the daemon binary instead, run through `docker compose exec`
(LAR-64; see the runbook for the full one-shot rule):

```bash
docker compose exec -T notion-sync node node_modules/tsx/dist/cli.mjs services/notion-sync/bin/notion-sync.ts --reconcile --dry-run
docker compose exec -T notion-sync node node_modules/tsx/dist/cli.mjs services/notion-sync/bin/notion-sync.ts --enable-two-way desks/x
docker compose exec -T notion-sync node node_modules/tsx/dist/cli.mjs services/notion-sync/bin/notion-sync.ts --resolve <path> --keep md
docker compose exec -T notion-sync node node_modules/tsx/dist/cli.mjs services/notion-sync/bin/notion-sync.ts --resolve <path> --keep notion
docker compose exec -T notion-sync node node_modules/tsx/dist/cli.mjs services/notion-sync/bin/notion-sync.ts --approve <path>
docker compose exec -T notion-sync node node_modules/tsx/dist/cli.mjs services/notion-sync/bin/notion-sync.ts --reject <path>
```

Typing the old `... notion-sync.ts approve <path>` form (a bare positional, the commander
subcommand shape) is refused loudly rather than silently starting a second daemon tick — see
"Three different dry-run postures" and the Deployment section below for the full one-shot list.

`--tolerance` must be a positive, finite number — anything else is rejected before any
work happens. `attendees` exits non-zero if any row's outcome could not be written to the
state database.

## Deployment

On the agent box this runs as a container off the `lares-sync-jobs` scheduled-jobs image
(ORB-178 — shared only with its sibling atlas-sync, never with saga)
(`command: tsx services/notion-sync/bin/notion-sync.ts`) — non-root, read-only rootfs,
`cap_drop: [ALL]`, internal network, secrets mounted as Docker secrets. It schedules itself
with an in-process hourly ticker rather than a systemd timer, matching every other periodic
job on that box. Nothing is built or checked out on the box.

Deploy and operate: `docs/runbooks/notion-sync.md`.

```bash
tsx services/notion-sync/bin/notion-sync.ts --once --dry-run   # one tick, writes nothing
```

The image ships this package, not the `lares` CLI, so every operator command is a flag on the
same entrypoint. **That is a rule, not an observation: a command that exists only as a
commander subcommand cannot be run where the vault, the database and the token are.** Each
bypasses the `NOTION_SYNC_LIVE` gate the way `--once` does:

```bash
tsx services/notion-sync/bin/notion-sync.ts --fidelity-record
tsx services/notion-sync/bin/notion-sync.ts --reconcile
tsx services/notion-sync/bin/notion-sync.ts --enable-two-way desks/example
tsx services/notion-sync/bin/notion-sync.ts --resolve desks/example/note.md --keep md
tsx services/notion-sync/bin/notion-sync.ts --archive-excluded [--no-dry-run]
tsx services/notion-sync/bin/notion-sync.ts --adoption-report
tsx services/notion-sync/bin/notion-sync.ts --transcripts [--dry-run]
tsx services/notion-sync/bin/notion-sync.ts --notion-born [--dry-run]
tsx services/notion-sync/bin/notion-sync.ts --people [--dry-run]
tsx services/notion-sync/bin/notion-sync.ts --approve <path>
tsx services/notion-sync/bin/notion-sync.ts --reject <path>
```

Three different dry-run postures, each deliberate:

- **Default LIVE, `--dry-run` rehearses** — `--fidelity-record`, `--reconcile`,
  `--enable-two-way`, and the three single-pass flags. The pass flags exist because the Phase 4
  deploy previews one pass at a time and `--once --dry-run` would rehearse all of them.
- **Default DRY-RUN, `--no-dry-run` writes** — `--archive-excluded` alone, because it trashes
  real Notion pages. It refuses `--no-dry-run` alongside `--dry-run`/`NOTION_SYNC_DRY_RUN=1`
  rather than picking a silent winner.
- **Neither** — `--resolve`, `--approve` and `--reject` refuse a dry-run flag (there is nothing
  to rehearse about a decision you have already made, and writing live behind a flag that
  promises otherwise is worse), and `--adoption-report` ignores one (it writes nothing,
  anywhere, ever — it does not even open a database connection).

Run them against a quiesced daemon — `exec` is a second process and the daemon's
don't-re-enter guard is process-local. The runbook's §"Go live" spells the rule out.

## Behaviour worth knowing

- **Never guesses.** A row with no matching calendar event is flagged `unmatched`, not
  filled from the transcript. A wrong email is worse than a blank.
- **Matches on start time, then on title.** The `--tolerance` window (default 15 minutes)
  is the primary filter. When more than one event lands inside it, the row's title is
  compared with each event's summary — normalised (case, punctuation and accents folded
  away) and scored by how many of the shorter title's words the two share. A candidate is
  only chosen if it shares at least half of them *and* beats every other candidate
  outright; a weak or tied comparison still yields `ambiguous`, never a coin flip.
- **Never overwrites.** A row that already has `Attendees` is skipped entirely, before it
  ever reaches the matching logic.
- **Rate-limited.** All Notion calls go through one throttled path (~3 req/s) with 429 retry.
- **Calendar reads are sliced, not truncated.** The window is fetched in 30-day slices
  rather than one call; a slice that comes back at the 250-result page cap raises an error
  instead of silently dropping events, because the underlying calendar client exposes no
  pagination token to recover the rest.
- **An empty calendar result is an error, not a clean run**, whenever there are meeting rows
  to match — it is far more likely to mean a wrong or unenrolled `NOTION_SYNC_PRINCIPAL`
  than a genuinely empty calendar, so the job refuses to sweep the whole table into
  `unmatched` on what's probably a misconfiguration. The same guard applies if the principal
  resolves to zero enrolled mailboxes.
- **"Notion changed" means the content hash changed**, never the timestamp alone. Notion's
  `last_edited_time` is only the cheap pre-filter deciding whether the page is worth
  re-reading (and it re-reads on `>=`, because those stamps are minute-granular); the
  decision itself is `sha256(GET /markdown) != stored notion_hash`. A row that has never
  been baselined (no stored timestamp) is skipped by the tick and left to `reconcile`.
- **Editing a page's `Frontmatter` property in Notion has no effect.** Frontmatter travels
  one way, as a property, and an approved write-back reassembles the vault file from the
  file's OWN frontmatter block (read verbatim from disk at apply time) plus the proposed
  body. A Notion-side frontmatter edit is ignored and overwritten by the next push — put
  it in the vault file instead. **A file with no `lares_origin` stamp cannot be enabled
  for two-way sync.** Both fidelity legs (`fidelity` and `enable-two-way`'s live check)
  refuse a file that would leave a pull with no origin at all, or a lower one than it
  already has — run `notion-sync fidelity`, then add `lares_origin:` to the named files.
- **A rejected proposal still owes a write.** Rejecting does not just close the proposal:
  the Notion page is reverted from the vault on the next tick, and only then is the
  proposal stamped resolved. Until that write lands, the rejection stays in the engine's
  queue — and the revert only runs against the exact content that was rejected. If the
  page changed again in the meantime, nothing is overwritten: the rejection retires and
  the newer content comes back as a fresh proposal to rule on.
- **The tick reads before it writes.** One tick is attendees → transcripts → notion-born →
  pull → apply → push wiki → push each desk dir → people, and that order is load-bearing. The push engine is direction-blind: it
  re-patches anything whose render no longer matches the stored hash. A human's Notion edit
  exists only in Notion until the pull pass has seen it, so a push running first would
  overwrite it before the conflict check could fire. An edit landing *between* pull's read
  and push's patch inside the same tick is still overwritten for a mirror row — bounded by
  one tick, and Notion's page history keeps the content.
- **The push never races an open decision.** A desk file with a pending or approved proposal is
  held back by the push pass entirely (reported as `awaiting approval`), the same way a frozen
  row is. Without that, a vault edit made while a proposal waits would be patched straight over
  the Notion content that proposal is about — the push engine is direction- and proposal-blind
  by design, so the rule lives at its door. The path rejoins the push on the tick after the
  decision: apply runs first, so an applied proposal is no longer open by the time the push
  reads the set.
- **No PASS writes a frozen row's content, on either side.** Not push, not pull, not apply —
  an approved proposal and a queued rejection both wait, still queued, until the row is
  synced again — and not the archive step if the file disappears. A freeze means a human owes
  a `notion-sync resolve` decision, and every pass leaves the two versions exactly as they
  will find them. Two deliberate exceptions, both of them a human's own act or a statement
  about direction rather than content: `notion-sync resolve --keep md` overwrites the Notion
  page from the vault (that IS the decision, and without it nothing would ever carry it out —
  pull would re-detect the conflict before push got a turn), and `reconcile` still stamps a
  frozen row's `Sync` property, icon and lock, because those describe which *direction* the
  row is in, not what either side says — a frozen mirror row that silently stopped looking
  locked would be a worse lie than the freeze is an inconvenience.
- **Nothing becomes two-way by itself.** Every row starts 🔒 Mirror. `enable-two-way` is the
  only thing that changes that, one file at a time, and only when the file both has a passing
  row in the fidelity table *and* survives a live round trip through Notion's own serializer
  right then. Files listed under `mirrorFilePrefixes` are refused outright.
- **Blank lines between blocks do not survive Notion, and the round trip says so.** Notion's
  `GET /markdown` joins top-level blocks with a single `\n` — the vault's own blank lines are
  gone by the time a pull sees the page, and no rule can infer them back. So a pulled body is
  rebuilt in ONE canonical shape (exactly one blank line between top-level blocks; list items,
  table rows, quote/callout bodies and fenced content stay tight), and the fidelity comparison
  removes inter-block blank lines on both sides so a file is not rejected over spacing Notion
  destroyed. Content lines still have to match byte for byte, in order, and a blank line inside
  a fenced code block is content — kept and compared.
  - **A file that passes only through that normalisation gets rewritten once.** Its blocks are
    spaced some way other than the canonical one — most often a hard-wrapped paragraph, which
    comes back as one paragraph per line (Notion genuinely stored those lines as separate
    blocks, and that is what the page shows). `enable-two-way` prints `[reflow: …]` beside
    every such file at flip time and counts them in its summary, so the one-time rewrite is
    known before it happens; the proposal diff itself shows only the human's edit, because
    both sides of that preview are canonicalised the same way.
  - **Where a blank line carries meaning, it is kept and compared.** A blank before a
    `----`/`====` line (thematic break vs setext heading) or before an indented code line
    (code block vs lazy continuation) changes what the document IS, so those blanks survive
    normalisation on the vault side. Notion cannot return them, so such a file fails the live
    leg and stays one-way — refused rather than silently converted.
  - **Not preserved, and known:** list looseness (a pulled list is always tight), and an empty
    Notion paragraph, which comes back as spacing rather than as a construct.
- **State-store bookkeeping failures are contained, not hidden.** A store write that fails
  after a Notion update already succeeded (or after a row is flagged unmatched) never
  aborts the run and is never misreported as a Notion failure — but it is logged with its
  page id and message, counted into the run summary as `bookkeeping-failed`, and makes the
  CLI exit non-zero. See the troubleshooting section of `docs/runbooks/notion-sync.md`.

## The People database contract (Phase 4)

The People pass projects the people your Meetings rows name into a Notion **People**
database and relates each meeting to them. **It is a projection, never a source of truth**
(spec §8.3): every field comes verbatim from Twenty — which is also where the
`services/network` layer already writes what it knows — nothing about a person originates
here, and the pass never writes back to the source. The adapter it reads through
(`lib/adapters/twenty-people.ts`) exposes one function, `listPeople`, and no write method at
all, so that is a property of the code's shape rather than a rule to remember.

Property names and types are part of the database contract, exactly like Meetings'
`Attendees` and Docs' `Name`/`Project`/`Folder`/`Vault Path`:

**People** (`people.dataSourceId`)

| Property | Notion type | Source |
|---|---|---|
| `Name` | Title | Twenty `name.firstName` + `name.lastName` |
| `Email` | **Email** | Twenty `emails.primaryEmail`, lower-cased — the match key. **Written once and never overwritten** |
| `Source` | Select | The source-system label (`Twenty`), supplied by the adapter |
| `Source ID` | Text (rich text) | Twenty's record id — the pointer back, and the key that survives an email change |

**Meetings** (two properties added to the existing database)

| Property | Notion type | Meaning |
|---|---|---|
| `People` | Relation → People | The attendees the pass could verify. Notion's **"Show on People"** backlink is optional; this pass never touches it |
| `People Unmatched` | Text (rich text) | The attendee addresses it could not, comma-separated |

Both Meetings properties READ as empty when they do not exist, so the image is safe to ship
before they are added; only a write fails. `Email` must be Notion's Email type — a Text
property fails the write for every person, every tick.

It also READS, and never writes, two Meetings properties that already exist: `Attendees` (the
list the relation is derived from) and `Meeting Title` (which names the meeting in every report
it makes — a page id alone does not tell you which meeting to open).

Rules the pass follows, and each is deliberate:

- **Only people a meeting names get a row.** Mirroring a whole CRM into Notion is the
  fourth-contact-store mistake this design exists to avoid. Existing rows are kept current
  whether or not a meeting names them; nothing new appears without a meeting behind it.
- **Unmatched means blank-and-flagged.** An attendee that cannot be resolved by email is left
  out of the relation and named in `People Unmatched`. No placeholder person is created, and
  nothing is derived from a display name, a transcript, a domain or a meeting title. Only the
  `<bracketed>` addresses in `Attendees` — which the calendar verified — are ever read.
- **The owner's own addresses are excluded** from the attendee set: `selfEmail` names a person
  who is on every meeting and is deliberately not a CRM record.
- **Additive, never subtractive.** Links are added and never removed. A link you ADD by hand
  survives. A link you REMOVE by hand comes back, if the derivation still reproduces it — only
  the removal of a link the derivation no longer produces sticks. `Attendees` is an invite
  list, not an attendance list, and so is the relation: "she was invited but did not come" is
  not something this property can express, and unlinking does not make it express it. A People
  row the source no longer recognises is left exactly as it is and counted `unsourced`;
  retiring a person is a decision made in Notion.
- **`Email` is the row's KEY and is written once.** It is the durable binding between an
  address and a person, so a historical meeting stays attached to whoever was actually in the
  room even after the CRM moves that address to somebody else — and the record that is handed
  the address is refused and reported, rather than quietly acquiring the row. The cost: the
  row shows the address the person was first projected under, not necessarily their current
  one. `Source ID` points at Twenty, where the current one lives, and any newer address the
  source holds still resolves.
- **An address binds to one person, and never moves to another** — within a tick and across
  them. Claims rank in one order, and it is a fact about the data rather than about which
  record Twenty happens to return first:

  > **the People row's stored key** > **a source record's primary address** > **a source
  > record's additional address**

  An address links to a People row only if it is unbound or already points there; no row is
  ever created keyed on an address something else already binds; and an *additional* address
  never binds one that is some other record's *primary*. So a meeting whose attendee address is
  somebody's identity links that person, whoever else lists it as a secondary address — and a
  stored key is never taken from the row that holds it. Settle it in Twenty; this pass will not
  guess. Every refused claim is reported — in one of **two** places, which is worth knowing when
  you go looking: a refusal decided while binding addresses is a `contested address` naming both
  records, but a record refused *earlier*, because its own primary address is already some other
  row's stored key, is reported on a `skipped` line instead (`… already carries Source ID …`).
  Read both lists, not just the contested one.
  - **A duplicated human therefore yields two People rows**, one per source record, rather than
    consolidating on whichever sorted first. That is the more faithful projection — one row per
    source record, nothing originating here — and both are reported. Merging duplicates is a
    decision only Twenty can make.
  - **A record whose own primary address is already bound gets no row at all**, and therefore
    none of its *other* addresses resolve either: those meetings go unlinked and flagged
    (`People Unmatched`), every tick, until it is settled in Twenty. Blank-and-flagged, so the
    safe direction — but it is wider than the one contested address. This is now confined to a
    record whose primary collides with a stored row key or with an earlier record's primary; a
    record whose primary is merely somebody else's *additional* address is unaffected.
- **A `late link` and a `relabelled` row are pinged, not just logged.** Both are things a human
  cannot undo from Notion (a hand-removed link comes back within the hour), so they go through
  the same signal-spine path as every other "a human must look at this" in this service. Pings
  are silent in `--dry-run`.
- **Repairing a wrong link takes two steps, in this order.** Fix the source first (the address,
  or the duplicate record), *then* unlink by hand in Notion. Unlinking alone does not stick:
  links are additive and re-derived hourly, so a hand-removal only holds once the derivation no
  longer produces that link.
- **Both sides of the relation respect Notion's 25-link inline cap.** A relation that would
  exceed it, or one already at it, is refused and reported rather than written — writing
  either would produce a row Notion can never return whole, or drop links it did not read.
- **No state of its own.** The pass touches neither the vault nor the state database — the
  People rows in Notion *are* its state, and `Source ID`/`Email` are the two identities the
  next tick re-reads.
