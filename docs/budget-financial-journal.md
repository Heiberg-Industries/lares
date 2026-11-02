# Inactive financial custody and continuity

This is a protected custody, continuity and transaction foundation.
`productionGatewayBudgetAuthority` remains closed. Preparation, a clean restart,
matching database checkpoints and matching journal heads never authorize spending.
The optional transaction adapter is available to the five existing financial
store writers; this does not connect every financial owner or activate production.

## Dedicated host custody

Financial custody lives at `/var/lib/lares/budget-financial`, outside ordinary
database backups and the encrypted `/etc/lares` and selected `/srv` backup paths.
Only the keeper mounts its host namespace, `/var/lib/lares`. Role containers do
not receive that mount. Do not add this namespace to ordinary restore input.

The custody directory is root-owned mode 0700. `writer.lock`, `first-use.json`,
`suppression.key` and `journal.jsonl` are regular, singly linked, root-owned mode
0600 files; symlink leaves and unsafe ancestry are refused. The suppression key
is exactly 32 raw bytes and matches both the one-shot receipt and genesis
fingerprint. A missing or changed key requires recovery, never replacement.

`HostFinancialJournal.openExisting` creates no directory or key, repairs no tail
and adopts no restored history. Prepared runtime startup additionally requires
the original receipt, database control record and preparation-complete record.
Installer reruns preserve an explicit `budgetFinancial` binding; they do not
infer preparation from directory presence. An invalid prior binding refuses the
render before writing either output file.

Reruns also preserve an existing `budgetNative` binding and
`gatewayBudget.serviceKeyFile` exactly as configured. These paths are retained
only from a valid prior keeper configuration; the installer does not create,
copy or infer either protected file. Malformed bindings, or native custody
without its financial binding, stop rendering before either output file is
written. Preservation does not activate spending or prove the files are ready.

## Explicit fresh-install ceremony

This administrator-only step is for a genuinely new installation. An empty
database is insufficient evidence: an old empty backup can also contain no budget
rows. Do not run the fresh ceremony after restoration, host loss or an interrupted
earlier ceremony. Those cases require owner-directed recovery, which is not
implemented here. There is no force, reset or automatic adoption command.

`sudo lares budget setup` runs this ceremony on an installed server, with the keeper stopped. It
runs the following command in a throwaway container of the keeper image:

```sh
budget-financial.ts prepare-fresh --confirm-fresh-installation \
  --operator-password-file /etc/lares/operator/database-password
```

The command takes one database client and exclusive transaction locks on all six
budget tables, rejects existing financial rows, and acquires the kernel writer
lock. It writes/fsyncs a one-shot receipt, renames it into place and fsyncs its
directory **before** creating the key or genesis. It fsyncs new files and directory
entries. Kernel ownership is retained through the actual same-client database
COMMIT acknowledgement; only afterward is the preparation-complete journal
record written and fsynced. Initial files without that record require recovery.
An unknown COMMIT or completion-write/fsync failure never reports preparation
success; when possible the retained owner also persists a permanent freeze.

Any existing custody directory, receipt, partial ceremony, nonempty budget state
or conflicting writer requires recovery. Do not retry a failed preparation by
removing files. Concurrent ceremonies cannot adopt or replace the winner's files.

After successful preparation, add this optional field to the existing root-owned
`/etc/lares/keeper.json`, preserving mode 0600, then restart the keeper. Keep the
other fields in its JSON object:

```json
"budgetFinancial": {"directory": "/var/lib/lares/budget-financial"}
```

Startup opens existing custody and verifies continuity before exposing sockets.
These steps prepare custody only. Spending remains closed.

Three startup outcomes follow. When continuity holds, Keeper takes the writer lease.
When the journal is frozen, or the check durably freezes it, Keeper keeps running with
spending closed: it logs that the ledger is frozen, takes no writer lease and refuses
every journal operation, while restore's host freeze still works. When the database
cannot answer yet, this start fails and writes nothing, and the restart policy tries
again. Custody that cannot be opened at all (missing key, changed files, another
writer) still stops Keeper, because a missing journal must never look like an
installation without financial custody.

## Kernel ownership, framing and capacity

On Linux, util-linux `flock` locks an inherited open file description. The parent
retains that descriptor for the writer lifetime after the acquisition child exits.
A competing writer refuses immediately. There is no PID file, TTL, lock stealing
or expiring lease. Closing an active operation refuses. Normal keeper shutdown
stops new financial operations, drains the current owner and appends/fsyncs a clean
writer-close before releasing custody. It does this before closing its database pools,
so a database that has already gone cannot delay it. Those pools tolerate dropped
connections, so a database restart does not end the process. A crash leaves an unclean
writer; a subsequent prepared open durably freezes it before any result can resume.

Each canonical JSON line has a version, sequence, operation UUID, previous digest,
strict record body and SHA256 integrity digest. Records are at most 65,536 bytes;
a book is at most 8 MiB and 8192 records. Proposals contain at most 128 atoms.
Prepared operations reserve space for begin, maximum proposal, terminal,
checkpoint control, writer-close and a freeze before database checkout. There is no
compaction, truncation or tail repair, and no book is ever removed.
Short writes are handled; fsync precedes advancement of operation state.

## Ledger books

The journal is a series of books. Book 1 is `journal.jsonl`; later books are
`journal-000002.jsonl` and so on. When a book cannot hold the next operation, and no
operation is in progress, Keeper seals it with a final `book-seal` record, then writes the
next book's first record, `book-open`. That record continues the same sequence and digest
chain and holds the sealed book's whole-file SHA256 and length. It is written to a `.partial`
file, fsynced, renamed into place and the directory fsynced. A full book therefore does not
stop work while the disk has room, and a keeper restart can record its writer lease.

Startup verifies every sealed book against the fingerprint in the next book, and checks the
newest book record by record. A changed, shortened, missing, renamed or unknown book file
stops startup. Removing the newest book leaves a sealed last book, which freezes. A crash while
changing book also leaves a sealed last book and freezes, like any other unclean writer. If the next
book exists but cannot be finished, the writer stops in memory and adds nothing to the sealed book,
including for `budget.freeze`; the writer lease left open makes the next start freeze durably.

Before sealing, Keeper requires free disk for two more books. If that is missing it refuses
new work and writes nothing, without a freeze, so freeing disk space is enough to carry on.
Books are not covered by ordinary backups, and they keep growing: about 24.5 KB per model
call, or roughly 9 GB a year at 1,000 calls a day. `lares doctor` reports the current book, the
space used and free, and any freeze.

The financial projection permits opaque account, window, binding and attempt
UUIDs, monetary values, reviewed prices, suppression digests, correlation hashes,
financial state and tombstones. It never serializes database rows generically.
Live identity, email, agent/session names, authority references, tickets, native
provider coordinates, credential fingerprints, prompts and raw provider bodies
have no permitted field. Integrity hashes detect corruption under protected
custody; they do not prevent privileged host rewrites or full host rollback.

## Database continuity and transaction order

A strict control record in the journal binds its journal identity to:

- PostgreSQL's `pg_control_system().system_identifier` as decimal text;
- `pg_postmaster_start_time()` with all six fractional digits, recorded as evidence;
- the current database's OID;
- the last completed operation's checkpoint tuple, or null before one exists.

Identity is the system identifier and the database OID. Continuity holds when both
match and every checkpoint and financial row matches the journal's complete fold.
The start time is not compared, because every ordinary restart changes it. Each
observation record keeps the start time it saw, so restarts stay visible in history.
A keeper restart, a PostgreSQL restart under a running keeper and a full server
reboot therefore all resume when that comparison holds and the journal has nothing
unfinished.

A fresh cluster, changed database, mismatched row or checkpoint, or unclean journal
durably freezes custody. So does a missing or ambiguous observation, except during
Keeper startup: no operation has run then, so a database that does not answer proves
nothing and the start simply fails without a record. An answer that is wrong, or a
database with no ledger tables, still freezes. Matching later database state never clears a freeze. No database epoch is
used as a recovery witness.

An older copy of the same database lacks later checkpoints and rows, so it is refused
even though its identity matches. The one exception is a copy swapped in by hand with
no financial change since it was taken: its money rows are correct, but non-financial
data such as a spending limit saved afterwards may be older, and nothing detects that.
`restore.sh` is not affected, because it freezes custody before replacing anything.

A process crash, a power cut, or a restart that lands inside a running operation
still leaves an unclean journal or an unknown outcome, and still freezes custody.

### What is compared, and when

Every step, meaning transaction start, pre-COMMIT and post-COMMIT observation, compares:

- database identity and every table's row count;
- every account, window, binding and tombstone, and every attempt that is not yet summarised;
- the newest 64 to 128 checkpoints and every checkpoint of a non-gateway operation.

Once per operation, at transaction start, each current month's count and amounts are compared
per attempt state, including summarised attempts. Those are the numbers admission uses.

Settled and retired attempts and their grants are summarised to a fingerprint once 64 are
waiting, and at every book change and keeper start, so each step stops reading them one by one.
Prepared attempts past their expiry follow at a book change or keeper start. An attempt proposed
again, such as a settled one becoming a conflict, returns to the compared rows.

The whole ledger is compared row by row at every keeper start, before the writer lease, and
once a night at 03:00 UTC. The night check reads and compares with no barrier held, so model calls
carry on during it. A row can look different while an operation commits it, so a row difference
counts only after the row is read again with the barrier held. Recorded checkpoints cannot change
during the read, so a checkpoint difference needs no re-read. Those re-reads and the final comparison
of database identity and row counts are short holds. If it cannot get the barrier within 5 seconds, it
tries again each minute, up to 30 times. If the database cannot be read that night it logs this and
tries the next night; only an actual difference freezes.

What this leaves open: a hand edit to a finished row that does not change a current month's
totals, or to a finished row from an earlier month, is found at the next keeper start or night
check, not at the next step. An edit made behind the night check's read position waits until the next
check. A restored older database is still found at the next step, through
row counts and the newest checkpoints. The keeper holds a small fingerprint in memory for each
summarised row, about 0.4 KB per model call. Each step's row counts take longer as the tables
grow, and any statement past the financial login's 1.5-second limit freezes the ledger, as a failed
observation always has. Neither has been measured beyond the long proof in the store tests.

The optional `JournalBudgetFinancialWriter` follows this order:

1. Acquire the host barrier before pool checkout or database locks; fsync begin.
2. Let `consoleSourceTransaction` own the actual client and transaction. Verify
   database identity and the last completed checkpoint before pending mutations.
   Existing source, authority and resource lock ordering remains in force.
3. After pending mutations and the first source-deadline check, collect exact
   financial snapshots on that same client and append/fsync the proposal.
4. Insert SQL025's checkpoint on the same transaction. Recheck source deadlines,
   verify continuity and the proposed checkpoint on that same client, then check
   deadlines again before selecting financial commit or source retirement.
5. After explicit financial COMMIT acknowledgement, append/fsync completion and
   then the updated control checkpoint before exposing a result. No second pool
   connection is needed.

Acknowledged original rollback permits durable abort. Source expiry rolls back
financial mutations and checkpoint first; exact revoke-only compensation runs on
the same client. Its COMMIT never completes the financial proposal. Lost
BEGIN/COMMIT/ROLLBACK acknowledgement remains unknown despite later cleanup,
destroys the borrowed connection, freezes custody and exposes no financial result.
Failure of journal/control durability after financial COMMIT retains database
liability/checkpoint and returns no permit or ticket.

### Overlapping operations

The journal runs one operation at a time, and a model call needs four: prepare, admit,
grant and settle. So two people or agents calling at the same moment overlap often.
A step that finds the journal busy waits in line rather than failing the person's turn:

| Step | Waits up to | Place in line |
| --- | --- | --- |
| Prepare | 1 second | Arrival order |
| Admit | 1 second | Arrival order |
| Grant | 1.5 seconds | Ahead of the steps above |
| Settle | 2 seconds | Ahead of the steps above |

Grant and settle go first because the gateway never resends them: a lost grant or
settlement holds that call's whole reservation for good. Prepare and admit have
spent nothing yet, so they can still be refused safely.

The turn passes on when an operation ends and is taken in the same moment, so nothing
overtakes the line. There is no lock stealing and no way to displace a running
operation. A wait that runs out does no work and writes nothing, and the step is refused
as before. A refused prepare or admit has reserved nothing; a refused grant or settle
leaves its reservation held. Stopping the keeper, a restore freeze or any other freeze
refuses everyone in line at once. Every other operation, such as provisioning or member
removal, still refuses straight away if the journal is busy.

The gateway's recovery check before admit does not wait. It reads only committed journal
state, never a pending proposal, while another operation runs. Admit then verifies the
database against the journal in its own turn and compares the check's answer with the
current row under lock, so an answer overtaken by a later change is refused.

A step leaves the line while its caller still has time, so it never starts after the
caller has given up. Prepare's wait ends well inside the broker's 2 seconds. Admit, grant
and settle share the gateway's 3 seconds: admit leaves the line with a second to spare for
its own work and the grant, and grant and settle with 0.3 seconds. Sustained overload still
refuses. A refused prepare ends that turn, and a refused admit ends the conversation.

## Closed account and monthly-window provisioning

### Initial monthly limit in Console

The designated Console owner may choose a positive monthly USD limit for an active member
with a verified sign-in, while that member has no budget account. The owner enters the
amount explicitly; there is no default. Saving the limit records policy only. It does not
create an account or monthly window, open an account, or enable spending. Once a member
budget account exists, the initial-limit control is read-only and this setup path refuses
further changes. Any later cap change needs a separate reviewed path.

The root-only `budget-financial.ts provision-accounts --host` command accepts a
bounded JSON plan on standard input: one canonical positive `installationCap` and
one to sixteen unique `memberIds`. The host socket passes it to Keeper's
host-only action; this command has no direct-database fallback. Keeper opens the
`provision` journal operation before the transaction checks out its one database
client.

Provisioning locks each selected member's organisation, active user record,
persisted provider identity rows and existing monthly spend-cap policy in stable
order. It derives suppression digests from the protected journal key and refuses
missing or changed identity state, cross-organisation requests, provider overlap,
tombstones, invalid policies and existing accounts that are not closed and
unreconciled. It creates or reuses one installation account and one member
account per selected member, then creates or reuses exactly one UTC-month window
per account. Repeating the same plan reuses the current accounts and windows. An
installation-cap change updates the closed installation account without changing
an immutable current-month window; a later UTC month gets new zero-liability
windows while old windows and attempts remain intact.

Every provisioned account remains `closed` with reason `unreconciled`; endpoint
and recovery fields remain empty. Provisioning does not create gateway bindings,
open accounts, reconcile liability, or enable spending. The bounded response
contains only state, reason and counts, never member or provider identities.

## Opening each new month

A monthly window is immutable and ends at 00:00 UTC on the first of the next month.
While it runs with prepared custody, Keeper opens the next month itself: once at
start, to catch up after downtime, and again right after each month ends. A failed
account retries after one second, doubling up to an hour but never past the next
month change. The checks in between only read, and a pass that finds nothing to do
writes nothing.

Each account gets its own `provision` journal operation, the installation first, so
an older Keeper can still read the journal after a rollback:

- The new window starts at zero. Its opening cap is the installation cap, or the
  member's monthly limit on record at that moment.
- Unused budget does not carry over. Old windows and attempts stay as they were.
- A call admitted before midnight settles against the month it started in. Grants
  and settlements wait for a busy journal (see "Overlapping operations"), because the
  gateway never resends them. A later refusal leaves the reservation held.
- An attempt with no settlement stays charged, at its full reservation, to the month
  it began in, and does not count against later months. No money is released and no
  provider's cost is assumed: a call that was cancelled, reported no usage, or lost its
  settlement simply never gets a lower figure than its reservation. **Within its month
  nothing resolves it**, so many unfinished calls can use up that person's limit or the
  installation limit for the month, and whoever is affected waits for the next month. A
  settlement that arrives later corrects the month the call began in. A prompt larger
  than the reviewed token bound can still cost more than its reservation, and an
  unfinished call never reveals that.
- Each ledger month stays within its limit, but calls still running at midnight belong
  to the old month while the new one has its whole limit. A provider's calendar-month
  invoice can therefore exceed the limit by what those calls cost.
- An attempt with a conflict keeps counting against every later month. It freezes the
  installation account, which stops all spending and all new months. There is no
  command to reconcile it yet.
- A prepared attempt not yet admitted at midnight is retired and never runs. Its
  conversation step does not rearm; the agent's next step is a new attempt.

Members who are open, or still closed and unreconciled during setup, get the month.
A closed member with a current window can still activate. Frozen and never-opened
installations, and retired or erased members, are left alone. A member without a
positive limit, or whose user is not active, is skipped until that changes. A window
that overlaps the month without matching it exactly, or a current window that has
not ended, blocks that account for recovery, as does a member whose organisation has
changed. Skipped and blocked accounts spend no journal records, because a refused
transaction would.

Spending stops until the month is open, which is normally a moment after midnight.
If opening keeps failing, Keeper logs that, with counts and no identities, and agents
stay stopped. A full or frozen journal is one such failure.

The guarded runtime check accepts any later month only with the current window that
the journal recorded, at the caps recorded at activation. A cap change therefore
still needs its own reviewed path.

## Native credential custody and cleanup

Native credential custody is optional and requires prepared financial custody.
Its configuration accepts only the engine's fixed protected host directory.
Keeper opens and verifies it before starting actions that can change SQL rows or
files. An unconfigured legacy installation is accepted only when no native
custody directory exists; an unbound directory requires recovery.

Fresh native custody requires an existing prepared journal, no existing row in
the native binding table (including redacted history), no configured native
binding and no existing custody directory. The root-only `prepare-native
--confirm-fresh-native-custody` action holds journal ownership and an exclusive
binding-table lock through creation. It never adopts or regenerates history.

Member removal and person erasure durably revoke local credentials and remove
their plaintext only after the database and prepared journal acknowledge the
change. Erasure then keeps only a fingerprint and minimal cleanup commitments.
These actions do not call the gateway or delete shared teams or users. They
report pending or blocked native cleanup separately from the acknowledged
database change.

The root-only `cleanup-native --host` action attempts at most one pending key
per invocation and reports the remaining count. Pending and blocked results
exit unsuccessfully. It uses Keeper's host action and has no direct gateway-write
fallback. Cleanup is attempted only when the trusted configured gateway origin
matches the origin recorded with that key.

Keeper also has explicit library-level recovery for interrupted local publication
and native plaintext cleanup. Publication repair uses only complete persisted
snapshot/control pairs and exact retained files; ordinary `openExisting` remains
unchanged. Cleanup recovery holds native ownership while it observes the current
retired-account and revoked-binding projection on the same client and requires the
fresh receipt to belong to the native operation's original financial journal.
It removes only matching local plaintext, preserves the original revocation
receipt, and leaves the open control record open. This path returns no runtime
gate, store or key, and does not authorize gateway deletion, startup recovery or
spending. Uncertain or incomplete evidence remains blocked.

The root-only `provision-native --host` command accepts a bounded JSON request
on standard input with `bindingId`, `credentialGeneration`, `memberId`, `agent`,
`incarnation` and `purposeAlias`. Keeper selects that alias from the configured
`budgetNative.reviewedPolicyFile`, a root-owned `0600` JSON file containing an
`endpointHash` and reviewed policies. The trusted gateway origin and master key
come from existing lifecycle configuration and its protected key file; a request
cannot choose either. The command reports only the binding ID, generation and
`bound-closed` state. Provisioning creates a blocked native key and does not open
budget accounts.

The root-only `activate-native --host` command accepts only the binding ID and
credential generation. Keeper rechecks current source authority and retained
policy, verifies the native key is blocked, then performs explicit activation.
Both commands use the host Keeper socket with a bounded deadline. A timeout,
missing acknowledgement or malformed response does not retry or fall back;
inspect the financial journal and native custody before another attempt.
This describes source-level host wiring. The compiled image and complete
first-use path still require separate release proof before these commands are a
tested installation path.

Native custody is excluded from ordinary backups and encrypted secret bundles.
Restore refuses when configured custody is missing or cannot be opened. Keeper
stops listeners and drains native work before draining the journal and closing
database pools and custody owners.

## Permanent freeze before restore

`restore.sh` inspects binding without opening custody on dry-run. No binding and
no custody is reported as the legacy inactive path. A prepared binding with
missing custody, invalid binding, or existing unbound custody refuses.

Before stopping the keeper or replacing any database, prepared restore invokes
root-only `budget-financial.ts freeze --host`. Its host-only action synchronously
stops new financial operations, boundedly drains the active operation, and
appends/fsyncs a permanent freeze under the lifetime lock before acknowledgement.
Timeout or fsync failure stops restore. PostgreSQL may remain running; this does
not clear the freeze after restoration.

The host socket is reachable only through its root-restricted directory. The
command requires actual root execution; email or actor claims grant no access.
Its client enforces an absolute four-second deadline and a 4096-byte response
limit, including trickled replies. Action refusal, malformed reply or uncertain
socket outcome is not success. An absent/dead listener permits fallback only
after acquiring the same kernel writer lock; active ownership, unsafe custody or
missing prepared files stops restore. No unlocked marker or side file is written.
There is no unfreeze or reconciliation shortcut.

## Remaining activation boundaries and verification

Native shared-team/user provisioning and activation now have explicit source-level
host commands, but neither command is a tested installation path until the
compiled-image and complete first-use proof above passes. Do not run either on a
live installation before that gate. Distinct nonowner application and keeper
financial database logins, host-only access, privilege guards and comprehensive
mutation guards remain required. SQL025's immutable checkpoint is an integration
aid, not database role isolation. Never bypass existing triggers to simulate
readiness.

Owner-directed reconciliation must preserve unknown liabilities and suppression
continuity and invalidate restored console, resume and job authority before fresh
caps, keys and profiles. Missing external custody on a replacement host cannot
reopen fresh caps. None of these remaining activation guarantees is claimed here.

Focused filesystem, subprocess/kernel, socket, configuration and restore tests
cover implemented boundaries. Mac tests do not prove Linux. The manual
keeper/neutral-image workflow must pass its actual final-image Linux lock probe
and PostgreSQL continuity probe before this source reaches main. That probe stops
and starts the real keeper process across PostgreSQL restarts, the way a server
reboot does, and checks the journal closes cleanly and resumes. Its pool-one
transaction with no financial row changes proves continuity/commit ordering only;
it is not proof of production activation or all financial writers.
