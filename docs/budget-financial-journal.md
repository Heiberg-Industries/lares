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

## Explicit fresh-install ceremony

This administrator-only step is for a genuinely new installation. An empty
database is insufficient evidence: an old empty backup can also contain no budget
rows. Do not run the fresh ceremony after restoration, host loss or an interrupted
earlier ceremony. Those cases require owner-directed recovery, which is not
implemented here. There is no force, reset or automatic adoption command.

Before configuring financial custody, run as root in the keeper container:

```sh
docker compose --env-file /etc/lares/keeper.env \
  -f /opt/lares/compose.lares-keeper.yaml exec -T lares-keeper \
  /app/services/keeper/node_modules/.bin/tsx \
  /app/services/keeper/bin/budget-financial.ts \
  prepare-fresh --confirm-fresh-installation
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

## Kernel ownership, framing and capacity

On Linux, util-linux `flock` locks an inherited open file description. The parent
retains that descriptor for the writer lifetime after the acquisition child exits.
A competing writer refuses immediately. There is no PID file, TTL, lock stealing
or expiring lease. Closing an active operation refuses. Normal keeper shutdown
stops new financial operations, drains the current owner and appends/fsyncs a clean
writer-close before releasing custody. A crash leaves an unclean writer; a
subsequent prepared open durably freezes it before any result can resume.

Each canonical JSON line has a version, sequence, operation UUID, previous digest,
strict record body and SHA256 integrity digest. Records are at most 65,536 bytes;
the file is at most 8 MiB and 8192 records. Proposals contain at most 128 atoms.
Prepared operations reserve space for begin, maximum proposal, terminal,
checkpoint control, writer-close and a freeze before database checkout. Capacity
exhaustion refuses new work. There is no compaction, truncation or tail repair.
Short writes are handled; fsync precedes advancement of operation state.

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
- `pg_postmaster_start_time()` with all six fractional digits;
- the current database's OID;
- the last completed operation's checkpoint tuple, or null before one exists.

A clean keeper-only restart can resume continuity with the identical running
PostgreSQL instance and matching completed checkpoint. A missing or ambiguous
observation, PostgreSQL restart, fresh cluster, changed database, mismatched
checkpoint or unclean journal durably freezes custody. Matching later database
state never clears a freeze. No database epoch is used as a recovery witness.

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
and PostgreSQL continuity probe before this source reaches main. Its pool-one
transaction with no financial row changes proves continuity/commit ordering only;
it is not proof of production activation or all financial writers.
