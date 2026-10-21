# Inactive financial journal foundation

This is an inactive custody and transaction adapter. It does not initialize an
installation, reconcile recovery, mount storage into runtimes, or supply a
production recovery witness. `productionGatewayBudgetAuthority` remains closed.
Database checkpoints or matching file/database heads never open spending.

## Protected custody and framing

`HostFinancialJournal.openExisting` accepts only an already established protected
directory with existing `writer.lock`, `suppression.key` and `journal.jsonl` files.
The directory is root-owned mode 0700; files are regular, singly linked,
root-owned mode 0600, with no symlink leaf or unsafe ancestry. The suppression key
is exactly 32 raw bytes and matches the genesis fingerprint. It is retained in
keeper/root custody outside ordinary database restoration. A missing or changed
key is an error, never a reason to generate a replacement.

There is no production initializer in this slice. A future explicit initializer
must prove that budget state is unused, establish key/journal custody once, and
fsync new or renamed directory entries as well as file contents. Restoration and
replacement-host adoption require their separate recovery protocol. Ordinary
role containers receive no writable journal mount.

On Linux, util-linux `flock` locks an inherited open file description. The parent
retains that descriptor for the entire writer lifetime after the acquisition
child exits. A second writer refuses immediately; no PID file, TTL, automatic
lock stealing or expiring lease exists. Closing an active operation refuses.
The actual final Linux keeper-image probe verifies child exit, independent
contention, parent death and refusal of an unclean writer. Local Mac tests use
the actual platform kernel through an explicit test lock adapter; they do not
prove the production Linux implementation.

Each bounded canonical JSON line contains a version, sequence, operation UUID,
previous digest, strict record kind/body and SHA256 integrity digest. A record is
at most 65,536 bytes; the file is at most 8 MiB and 8192 records. Proposal atoms
are bounded to 128. Opening reserves room for a clean writer-close; each operation
reserves its begin, maximum proposal, terminal and writer-close before any database
checkout. Capacity exhaustion refuses new work while allowing a clean close;
this slice has no compaction.
Writes handle short writes and fsync before advancing in-memory state. There is
no silent repair, truncation or adoption of a malformed/partial tail.

Writer-open/close records surround operation records. A failed/crashed writer
cannot be silently adopted even if its final completion line happens to remain
readable after an unacknowledged fsync. Incomplete operations, corruption, custody
change, uncertain writes and disk failures freeze the current writer; an unclean
history requires explicit recovery.

The journal schema permits only projected financial atoms: opaque account,
window, binding and attempt UUIDs; monetary values; fixed reviewed prices;
canonical/provider suppression digests; invocation/request/profile/grant/receipt
correlation hashes; financial state and tombstones. The collector never serializes
database rows generically. Live member/organisation IDs, email, agent/session
names, authority references, ticket material, purpose aliases, native user/team
coordinates, credential fingerprints, prompts and raw provider bodies have no
permitted field. Integrity hashes detect corruption under protected custody; they
do not make a privileged rewrite or full host rollback impossible.

## Owned transaction order

The optional `JournalBudgetFinancialWriter` integrates the actual budget store's
prepare, admission, grant binding, unknown marking and settlement methods:

1. Acquire the host barrier before checking out a pool connection or taking
   database locks; append and fsync an operation-begin record.
2. Let `consoleSourceTransaction` own its real client and transaction. Existing
   source/authority and financial lock ordering remains in force. Nested source
   callbacks reuse that registered owner; they cannot introduce another boundary.
3. After pending mutations and the first source-deadline check, collect exact
   financial snapshots on that same transaction. Append/fsync the proposal.
4. Insert SQL025's checkpoint on the same client/transaction, then check source
   deadlines again. Expiry can still latch retirement at this point.
5. Only an explicit financial COMMIT acknowledgement, followed by durable journal
   completion, may expose the result. No second pool connection is needed.

The transaction outcome distinguishes acknowledged original rollback,
acknowledged revoke-only source retirement, acknowledged financial commit and
unknown outcome. A positively acknowledged original rollback permits a durable
financial abort. If source expiry is latched, the financial mutations and
checkpoint roll back first; the existing exact revoke-only compensation then
runs on the same client. Its COMMIT never finishes the financial proposal.
Source-retirement rollback is also explicit. A lost BEGIN/COMMIT/ROLLBACK
acknowledgement stays unknown despite successful later cleanup, destroys the
borrowed connection, freezes the journal and exposes no spending permit/result.

The private boundary is one-use process provenance, not caller JSON. It reports
its outcome after the checked-out client is released. Checkpoint insertion or
post-fsync deadline failure cannot accidentally leave financial work committed.
Failure of durable completion after acknowledged financial commit retains the
database liability/checkpoint and returns no permit or ticket.

SQL025's immutable operation/proposal checkpoint is a missed-integration aid. It
is neither host durability nor a comprehensive database mutation guard or database
role-isolation boundary. Unadapted methods can still write budget rows; production
activation is therefore prohibited until every financial owner and required
privilege/guard is connected and independently proved.

## Remaining activation boundaries

Runtime invocation attestation and keeper-owned preparation, authentic console
owner removal, root-authorized erasure tombstones, provisioning/window/binding
owners, explicit restore freeze, PostgreSQL restart/instance detection and
owner-directed reconciliation remain separate work. Reconciliation must preserve
unknown liabilities and suppression continuity and invalidate restored
console/resume/job authority before fresh approval. Missing external custody on a
replacement host cannot reopen fresh caps. This foundation does not implement or
claim those guarantees.

Focused filesystem, kernel and real PostgreSQL pool-one fault tests verify the
implemented boundary. The manual keeper/neutral-image workflow must pass the
actual Linux image probe and SQL025 proof before this source reaches main.
