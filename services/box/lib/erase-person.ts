// services/box/lib/erase-person.ts — erase a person from every table that names them,
// or erase nothing.
//
// THE ONE PROMISE. When this routine reports success, no row in this database names the person.
// Not "no row in the tables somebody remembered to list" — the sweep is driven FROM
// `lib/member-scope.ts`, the inventory that a repository test (tests/member-scope-inventory.test.ts)
// forces every new table into. There is no second hand-written table list in this file, and the
// one hand-written map below (EXTRA_PERSON_COLUMNS) only ADDS columns the inventory's own `reason`
// text already names; a table that reaches this file with no handling at all fails
// tests/erase-person-db.test.ts by name rather than being skipped in silence.
//
// THE SECOND PROMISE, WHICH IS WHY THIS IS WORTH BUILDING AT ALL. A person erased from five tables
// out of six is a worse state than a person erased from none: the first looks done. So this is one
// transaction, and ANY table the sweep cannot reach — a migration that was never applied — is a
// REFUSAL that rolls everything back and names the file to apply. A dry run opens no transaction
// at all and issues nothing but reads.
//
// WHO. `opts.person` is whatever the operator typed — a canonical id, an old chat handle, an email
// address. The first thing that happens is `resolvePerson` (lib/person-identity.ts), which is also
// the membership check: the identity register is the list of this installation's members, so
// anybody it does not hold is refused (a member of this installation, never a
// third party a note happens to be about). Every table is then matched with
// `= ANY(spellingsFor(person, idKind))`, never `= <the id>`: the whole point of the identity track
// is that rows written under an older spelling go too, and this routine must not assume the
// migration that unified those spellings has been applied.
//
// WHAT IS DELIBERATELY NOT DELETED.
//  - An `actor` column records WHO DID something in an administrative log. The
//    row stays and the name is replaced with the literal `erased`: the log still shows that
//    somebody changed a permission, and no longer shows who.
//  - A `clearedWholeOnly` table (the learned writing-voice corpus) has no person column at all. It
//    is cleared in full ONLY when the person being erased is the installation's one member;
//    otherwise it is left and named in the report.
//  - A row whose person column is NULL cannot be attributed to anyone. It is counted and named,
//    never guessed at — the rule the dream tables follow, applied to every member table.
//  - The path-keyed sync tables (`notion_sync_*`, `atlas_*`) are reached through vault paths, not
//    through a person column. Without `opts.paths` they are named in `outstanding` and left
//    alone; with it (once the vault pass has run and knows which files just went) they
//    are deleted for exactly those paths, in the same transaction as everything else.
//
// TABLE AND COLUMN NAMES ARE INTERPOLATED INTO SQL, and can be only because every one of them
// comes from `MEMBER_SCOPE` — a constant in this repository — and never from a request, a
// settings row or anything an operator typed. `opts.person` is a bound parameter everywhere.
// This is the same rule `lib/person-identity.ts`'s `unresolvableValues` states; do not add a
// caller that passes a name from outside.

import type { Pool, PoolClient } from "pg";
import type { Queryable } from "./db.js";
import {isJournaledPersonErasureOwner} from "../../keeper/lib/person-erasure.js";
import { MEMBER_SCOPE, type ScopeClass, type ScopedTable } from "./member-scope.js";
import {
  resolvePerson,
  spellingsFor,
  IdentityRegisterMissing,
  PersonAmbiguous,
  PersonNotFound,
  type PersonIdentity,
} from "./person-identity.js";

/** One table, and what the erase did (or would do) to it. */
export interface ErasePlan {
  table: string;
  scope: ScopeClass;
  rows: number;
  how: string;
}

export interface EraseReport {
  person: string;
  dryRun: boolean;
  planned: ErasePlan[];
  deleted: ErasePlan[];
  /** Stated, never hidden: what this routine did NOT reach. */
  outstanding: string[];
  refusals: string[];
  /** Set when the person erased was the installation's only member — the report says so, because
   *  it means the installation now has nobody. Absent on a refusal. */
  wasOnlyMember?: boolean;
}

/**
 * What this routine does with one inventory entry. `null` means it has no idea — which is a test
 * failure (tests/erase-person-db.test.ts), never a silently skipped table.
 */
export type EraseHandling =
  | "retire-and-redact-budget-liability"
  | "delete-by-person-column"
  | "delete-through-member-owner-cascade"
  | "replace-name-in-audit-row"
  | "register-goes-last"
  | "cleared-only-when-sole-member"
  | "reached-through-ids-resolved-first"
  | "named-as-out-of-reach";

/** The identity register itself. Deleted LAST, inside the same transaction, in this order: an
 *  alias row points at a `users` row, and everything else is matched through both.
 *  Exported so `lib/export-person.ts` — the read-only twin of this routine — reaches exactly the
 *  same two tables rather than keeping a second copy of their names. */
export const REGISTER_TABLES = ["user_aliases", "users"] as const;

/**
 * `memory_proposals.existing_id` names a row in one of these two tables (see that entry's
 * `reachedBy` in the inventory, and services/box/sql/001_baseline.sql's own header — the column is text
 * precisely so it can name a row in either). Their ids are read and HELD before anything is
 * deleted, because once the owning row is gone the join is impossible.
 *
 * Exported for `lib/export-person.ts`, which reaches `memory_proposals` the same way — through
 * the ids of rows this person owns, never through a column of its own.
 */
export const HELD_ID_SOURCES = ["standing_facts", "dream_preferences"] as const;

/** Reached through a vault path rather than through a person column. Named in `outstanding` (and
 *  left untouched) when `opts.paths` is absent; deleted, keyed on exactly those paths, when
 *  `opts.paths` is given (once the vault pass has run and knows which files just went). */
const PATH_KEYED_SYNC_TABLES = [
  "notion_sync_docs",
  "notion_sync_proposals",
  "notion_sync_fidelity",
  "atlas_notes",
  "atlas_proposals",
] as const;

/**
 * Which column each path-keyed table matches a vault path on — confirmed against the real
 * `CREATE TABLE` statements (`services/box/sql/001_baseline.sql`, `001_baseline.sql`,
 * `001_baseline.sql`), not assumed from the inventory's prose. The notion-sync family stores
 * `vault_path`; the Atlas family stores `note_path`. Both are written as a plain, "/"-joined path
 * relative to the WHOLE vault mount (`services/notion-sync/lib/config.ts`'s own comment: "vault_path
 * … built as `${wikiDir}/...`" — i.e. it already includes the wiki sub-folder, not just a path
 * inside it), which is exactly the shape `erase-person-vault.ts`'s `VaultHit.path` uses. A `--vault`
 * pointed at the same root a sync job walks needs no translation between the two.
 */
const PATH_KEYED_SYNC_COLUMNS: Readonly<Record<string, string>> = {
  notion_sync_docs: "vault_path",
  notion_sync_proposals: "vault_path",
  notion_sync_fidelity: "vault_path",
  atlas_notes: "note_path",
  atlas_proposals: "note_path",
};

/**
 * THE ONE HAND-WRITTEN MAP, and the narrow reason it exists: two inventory entries say in their
 * own `reason` text that a SECOND column also names a person, and a `ScopedTable` has room for
 * only one. Nothing here is invented — each line quotes the inventory entry it comes from. The
 * third such note, `outreach_threads.person_id`, is deliberately absent: that entry says in as
 * many words "do not key an erase on person_id" (it names the third-party recipient).
 */
const EXTRA_PERSON_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  resource_grants: ["principal_member_id"],
  // "requested_by_user_id also names a person — the requester — and is a second thing an erase
  //  must consider."
  cross_member_reads: ["requested_by_user_id"],
  // "owner_email (the claim email) is a second, unenforced person-identifying column worth
  //  checking by hand." An email address is one of the spellings the register holds.
  agent_door_connections: ["owner_email"],
};

/**
 * What this routine did NOT reach — rendered on EVERY report, including a clean one, because the
 * value of an erase is entirely in whether the person can believe it, and a list of limits that
 * only appears when something went wrong is a list nobody reads.
 *
 * The first line is ADR-0020 rule 5 in plain words: eve's own session and workflow rows are "kept
 * only as long as eve needs them to run — not subject to the twelve-month setting, and not
 * treated as a historical record" (docs/decisions/0020-conversations.md).
 */
export const ERASE_OUTSTANDING: readonly string[] = [
  "Anything said in a conversation that is still open. While a conversation is running the words " +
    "also sit in the agent's own working store, which is cleared when the agent no longer needs " +
    "it to run, on its own schedule rather than by this routine.",
  "The vault's git history. Deleting a note removes the file from today's vault; older versions " +
    "of it stay in the git history until that history is rewritten, which is a separate step.",
  "Any backup taken before this run. Restoring one would bring the erased records back, so the " +
    "backups have to be expired or re-taken separately.",
];

/** What the erase does with one inventory entry, derived from the entry's own fields wherever
 *  that is possible. Exported so the test can prove the inventory and this file agree. */
export function eraseHandlingFor(entry: ScopedTable): EraseHandling | null {
  if (["budget_accounts", "budget_windows", "budget_gateway_bindings", "budget_attempts"].includes(entry.table)) return "retire-and-redact-budget-liability";
  if (["outside_custody_accounts", "outside_custody_revisions", "outside_custody_operations"].includes(entry.table)) return "delete-through-member-owner-cascade";
  if (entry.scope === "member") {
    if ((REGISTER_TABLES as readonly string[]).includes(entry.table)) return "register-goes-last";
    if (entry.idKind === "actor") return "replace-name-in-audit-row";
    return "delete-by-person-column";
  }
  if (entry.scope === "resolved") {
    if (entry.clearedWholeOnly) return "cleared-only-when-sole-member";
    if (entry.table === "memory_proposals") return "reached-through-ids-resolved-first";
    if ((PATH_KEYED_SYNC_TABLES as readonly string[]).includes(entry.table)) {
      return "named-as-out-of-reach";
    }
  }
  return null;
}

/** The literal a cleared audit trail reads afterwards. */
const ERASED = "erased";

/** Every column of a table that names a person: the inventory's own, plus the extras above. */
function personColumnsOf(entry: ScopedTable): readonly string[] {
  return [entry.column!, ...(EXTRA_PERSON_COLUMNS[entry.table] ?? [])];
}

/** `(col = ANY($1::text[]) OR col2 = ANY($1::text[]))` — one bound parameter, every spelling.
 *  Exported so the export (`lib/export-person.ts`) SELECTs exactly the rows this routine would
 *  DELETE: one match rule, in one place, for both halves of ADR-0020 rule 7. */
export function matchClause(entry: ScopedTable): string {
  const parts = personColumnsOf(entry).map((c) => `${c} = ANY($1::text[])`);
  return parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`;
}

/** Every table this routine touches, so its absence can be a refusal BEFORE anything is written.
 *  The path-keyed sync tables only have to be there when `opts.paths` was given — otherwise this
 *  routine never opens them at all. Exported because the export reads the very same set (with
 *  `includePathKeyed: false`, which it always is there: an export names those tables rather than
 *  opening them). */
export function tablesThatMustExist(includePathKeyed: boolean): ScopedTable[] {
  return MEMBER_SCOPE.filter((t) => {
    const handling = eraseHandlingFor(t);
    if (handling === null) return false;
    if (handling === "named-as-out-of-reach") return includePathKeyed;
    return true;
  });
}

async function countWhere(q: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await q.query<{ n: number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

const OUTSIDE_CUSTODY_TABLES = ["outside_custody_accounts", "outside_custody_revisions", "outside_custody_operations", "private_metadata_devices"] as const;
const OUTSIDE_CUSTODY_FK_SHAPE_SQL = `
WITH expected(child, child_columns, parent, parent_columns) AS (
  VALUES
    ('outside_custody_accounts', ARRAY['owner_member_id']::text[], 'users', ARRAY['id']::text[]),
    ('outside_custody_accounts', ARRAY['resource_id']::text[], 'agent_access', ARRAY['agent_name']::text[]),
    ('outside_custody_revisions', ARRAY['owner_member_id']::text[], 'users', ARRAY['id']::text[]),
    ('outside_custody_revisions', ARRAY['account_id','owner_member_id']::text[], 'outside_custody_accounts', ARRAY['account_id','owner_member_id']::text[]),
    ('outside_custody_operations', ARRAY['owner_member_id']::text[], 'users', ARRAY['id']::text[]),
    ('outside_custody_operations', ARRAY['account_id','owner_member_id']::text[], 'outside_custody_accounts', ARRAY['account_id','owner_member_id']::text[]),
    ('private_metadata_devices', ARRAY['owner_member_id']::text[], 'users', ARRAY['id']::text[]),
    ('private_metadata_devices', ARRAY['connected_account_id','owner_member_id']::text[], 'connected_accounts', ARRAY['id','owner_member_id']::text[]),
    ('private_metadata_devices', ARRAY['custody_account_id','owner_member_id']::text[], 'outside_custody_accounts', ARRAY['account_id','owner_member_id']::text[]),
    ('agent_access', ARRAY['owner_member_id']::text[], 'users', ARRAY['id']::text[])
)
SELECT e.child, e.child_columns, e.parent, e.parent_columns, c.conname,
       ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ord) AS actual_child_columns,
       ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.ord) AS actual_parent_columns,
       c.confdeltype, c.confupdtype, c.confmatchtype, c.convalidated, c.condeferrable, c.condeferred,
       (SELECT count(*)::int FROM pg_trigger t WHERE t.tgconstraint=c.oid AND t.tgisinternal) AS internal_ri_triggers,
       (SELECT count(*)::int FROM pg_trigger t WHERE t.tgconstraint=c.oid AND t.tgisinternal AND t.tgenabled='O') AS enabled_ri_triggers
  FROM expected e
  LEFT JOIN pg_class child ON child.relname=e.child
  LEFT JOIN pg_namespace child_ns ON child_ns.oid=child.relnamespace AND child_ns.nspname='public'
  LEFT JOIN pg_class parent ON parent.relname=e.parent
  LEFT JOIN pg_namespace parent_ns ON parent_ns.oid=parent.relnamespace AND parent_ns.nspname='public'
  LEFT JOIN pg_constraint c ON c.conrelid=child.oid AND c.confrelid=parent.oid AND c.contype='f'
    AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ord)=e.child_columns
    AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.ord)=e.parent_columns
 WHERE child_ns.oid IS NOT NULL AND parent_ns.oid IS NOT NULL
 ORDER BY e.child, e.parent, e.child_columns`;

type CustodyFkShape = {
  child: string;
  child_columns: string[];
  parent: string;
  parent_columns: string[];
  conname: string | null;
  actual_child_columns: string[] | null;
  actual_parent_columns: string[] | null;
  confdeltype: string | null;
  confupdtype: string | null;
  confmatchtype: string | null;
  convalidated: boolean | null;
  condeferrable: boolean | null;
  condeferred: boolean | null;
  internal_ri_triggers: number;
  enabled_ri_triggers: number;
};

async function hasExpectedOutsideCustodyForeignKeys(q: Queryable): Promise<boolean> {
  const { rows } = await q.query<CustodyFkShape>(OUTSIDE_CUSTODY_FK_SHAPE_SQL);
  const actor = await q.query<{ has_fk: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='actor_member_id'
    WHERE c.conrelid='public.outside_custody_operations'::regclass AND c.contype='f'
      AND a.attnum=ANY(c.conkey)
  ) AS has_fk`);
  return rows.length === 10 && actor.rows[0]?.has_fk === false && rows.every((row) => row.conname !== null &&
    JSON.stringify(row.child_columns) === JSON.stringify(row.actual_child_columns) &&
    JSON.stringify(row.parent_columns) === JSON.stringify(row.actual_parent_columns) &&
    row.confdeltype === "c" && row.confupdtype === "a" && row.confmatchtype === "s" &&
    row.convalidated === true && row.condeferrable === false && row.condeferred === false &&
    row.internal_ri_triggers === 4 && row.enabled_ri_triggers === 4);
}

async function custodyRowsForOwner(q: Queryable, memberId: string): Promise<Record<(typeof OUTSIDE_CUSTODY_TABLES)[number], number>> {
  const counts = {} as Record<(typeof OUTSIDE_CUSTODY_TABLES)[number], number>;
  for (const table of OUTSIDE_CUSTODY_TABLES) {
    counts[table] = await countWhere(q, `SELECT count(*)::int AS n FROM ${table} WHERE owner_member_id=$1`, [memberId]);
  }
  return counts;
}

async function hasForeignCustodyOnOwnedAgent(q: Queryable, memberId: string): Promise<boolean> {
  return (await countWhere(q, `SELECT count(*)::int AS n
    FROM outside_custody_accounts custody
    JOIN agent_access access ON access.agent_name=custody.resource_id
    WHERE access.owner_member_id=$1 AND custody.owner_member_id IS DISTINCT FROM $1`, [memberId])) > 0;
}

/** Rows whose person column is NULL: nobody's, as far as this database can tell. Counted and
 *  stated, never deleted and never attributed — the rule the dream tables follow, which is the
 *  only honest rule for any nullable person column. Actor columns are excluded: a missing actor
 *  is a missing operator label, not a person's own data. */
async function unattributedLines(q: Queryable): Promise<string[]> {
  const lines: string[] = [];
  for (const entry of MEMBER_SCOPE) {
    if (entry.scope !== "member" || entry.idKind === "actor" || entry.table === "vault_areas") continue; // NULL owner_member_id deliberately means organisation ownership.
    if ((REGISTER_TABLES as readonly string[]).includes(entry.table)) continue;
    const n = await countWhere(
      q,
      `SELECT count(*)::int AS n FROM ${entry.table} WHERE ${entry.column} IS NULL`,
    );
    if (n > 0) {
      lines.push(
        `${n} record${n === 1 ? "" : "s"} in "${entry.table}" name nobody at all — written before ` +
          "this installation recorded who each one belonged to. They were left alone rather than " +
          "guessed at.",
      );
    }
  }
  return lines;
}

/** The lines about what the sweep could see but chose not to touch, in plain words.
 *  `pathsGiven` is true exactly when `opts.paths` was given to `erasePerson` — the sync tables
 *  were then actually reached, so the generic "not reached" sentence is replaced by the one honest
 *  limit that is left: the sync job's own watermark, which this routine still does not touch. */
async function situationalOutstanding(
  q: Queryable,
  soleMember: boolean,
  pathsGiven: boolean,
): Promise<string[]> {
  const lines: string[] = [];

  const openAdds = await countWhere(
    q,
    "SELECT count(*)::int AS n FROM memory_proposals WHERE action = 'add'",
  );
  if (openAdds > 0) {
    lines.push(
      `${openAdds} suggestion${openAdds === 1 ? "" : "s"} waiting for an answer, each one an ` +
        "inference the agent suggested rather than something anybody said. They record no person, " +
        "so they were left as they are — answer or dismiss them to clear them.",
    );
  }

  if (!soleMember) {
    const corpus = MEMBER_SCOPE.filter((t) => t.clearedWholeOnly);
    for (const entry of corpus) {
      const n = await countWhere(q, `SELECT count(*)::int AS n FROM ${entry.table}`);
      if (n > 0) {
        lines.push(
          `The ${n} sample${n === 1 ? "" : "s"} of the learned writing voice. They record whose ` +
            "words they came from nowhere at all, and somebody else is still a member here, so " +
            "clearing them would take away a writing voice that may not be this person's.",
        );
      }
    }
  }

  if (pathsGiven) {
    lines.push(
      "The Notion and knowledge-base sync job's own bookmark for where it left off (the database " +
        "calls it notion_sync_run) is not reset. It still points at the vault commit from before " +
        "this run; the next sync tick simply reads forward from there again, which is harmless " +
        "unless this vault's history has since been rewritten.",
    );
  } else {
    lines.push(
      "Anything the agents put into Notion or the connected knowledge base. Those records are " +
        "matched by the document they belong to, not by a person, and are cleared with the notes " +
        "themselves rather than here.",
    );
  }

  return lines;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Erase one person from this database. ONE TRANSACTION: it all happens, or none of it does.
 *
 * A refusal (an unknown name, a name two people claim, a missing identity register, a table this
 * box has not created) deletes NOTHING and is reported. `dryRun` opens no transaction, issues
 * nothing but reads, and fills `planned` with what an `--apply` run would do.
 */
// Only this owner may lend an existing transaction to the database/file erasure flow.
// The organisation barrier spans preflight, files and the generated database sweep.
const erasureOwners=new WeakMap<PoolClient,{failed:boolean;owner:object}>();
async function lockErasureMember(client:PoolClient,memberId:string):Promise<void>{
  const isolation=(await client.query<{transaction_isolation:string}>('SHOW transaction_isolation')).rows[0]?.transaction_isolation;
  if(isolation!=='read committed')throw new Error('Person erasure requires a read committed financial transaction');
  const before=(await client.query('SELECT org_id FROM users WHERE id=$1',[memberId])).rows[0];
  if(!before)throw new Error('Membership changed during erasure');
  if(before.org_id){
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lares-console-source:' || $1,0))",[before.org_id]);
    const org=await client.query('SELECT id FROM orgs WHERE id=$1 FOR UPDATE',[before.org_id]);
    if(org.rows.length!==1)throw new Error('Membership changed during erasure');
  }
  const current=(await client.query('SELECT org_id,status,org_role FROM users WHERE id=$1 FOR UPDATE',[memberId])).rows[0];
  if(!current||current.org_id!==before.org_id)throw new Error('Membership changed during erasure');
  // SQL 007 repeats this guard on DELETE. Do the exact same predicate before any vault file is
  // changed so its later refusal cannot leave a half-erased person.
  if(current.org_id&&current.status==='active'&&current.org_role==='owner'){
    const another=(await client.query("SELECT 1 FROM users WHERE org_id=$1 AND id<>$2 AND status='active' AND org_role='owner' LIMIT 1",[current.org_id,memberId])).rows;
    if(!another.length)throw new Error('Cannot erase the last active organisation owner; designate another active owner first');
  }
  // This row lock also blocks FK KEY SHARE from a new custody account, including one
  // attempted by a stale cross-organisation caller. Keep it through file work and commit.
  await client.query('SELECT agent_name FROM agent_access WHERE owner_member_id=$1 ORDER BY agent_name FOR UPDATE',[memberId]);
}
/** Marks the caller's already-open source transaction as the only owner allowed to run the
 * database erasure sweep. The caller owns COMMIT/ROLLBACK and may include vault work before it. */
export async function withPersonErasureClient<T>(client:PoolClient,memberId:string,owner:object,work:()=>Promise<T>):Promise<T>{
  if(!isJournaledPersonErasureOwner(owner,client))throw new Error('A journal-owned source transaction is required');
  const state={failed:false,owner};await lockErasureMember(client,memberId);erasureOwners.set(client,state);
  try{const result=await work();if(state.failed)throw new Error('Database erasure was refused');return result;}
  finally{erasureOwners.delete(client);}
}

export async function erasePerson(
  db: Pool | PoolClient,
  opts: {
    person: string;
    dryRun: boolean;
    /** Store-relative vault paths the vault pass just removed or found untracked, for
     *  the SAME person, in the SAME run. When given (even as an empty array), the path-keyed
     *  sync-state tables are deleted for exactly these paths, inside the same transaction as the
     *  member deletes. When absent, those tables are untouched, as before this option existed. */
    paths?: readonly string[];
    /** Internal single-resolution path used by the journaled root erasure. */
    resolvedIdentity?:PersonIdentity;
    /** Unforgeable per-operation owner issued only by Keeper's journaled erasure boundary. */
    journalOwner?:object;
  },
): Promise<EraseReport> {
  const owned='release' in db?erasureOwners.get(db):undefined;
  if('release' in db&&!owned)throw new Error('An erasure-owned transaction is required');
  if(!opts.dryRun&&(!owned||!opts.journalOwner||owned.owner!==opts.journalOwner||!isJournaledPersonErasureOwner(opts.journalOwner,'release' in db?db:undefined)))throw new Error('A journal-owned source transaction is required');
  const report: EraseReport = {
    person: opts.person,
    dryRun: opts.dryRun,
    planned: [],
    deleted: [],
    outstanding: [...ERASE_OUTSTANDING],
    refusals: [],
  };

  // ── Step 0: who. The register is the membership list; anybody it does not hold is refused. ──
  let person: PersonIdentity;
  try {
    person = opts.resolvedIdentity ?? await resolvePerson(db, opts.person);
  } catch (err) {
    if (
      err instanceof PersonNotFound ||
      err instanceof PersonAmbiguous ||
      err instanceof IdentityRegisterMissing
    ) {
      report.refusals.push(messageOf(err));
      return report;
    }
    throw err;
  }
  report.person = person.id;

  // ── Step 1: can the whole sweep run? Asked before a single row is written, so the answer
  //    "no" costs nothing. `to_regclass` answers NULL for a relation that is not there. ──────
  const required = tablesThatMustExist(opts.paths !== undefined);
  const { rows: presence } = await db.query<{ name: string; present: boolean }>(
    `SELECT t.name, to_regclass(t.name) IS NOT NULL AS present
       FROM unnest($1::text[]) AS t(name)`,
    [required.map((t) => t.table)],
  );
  const present = new Map(presence.map((r) => [r.name, r.present]));
  for (const entry of required) {
    if (present.get(entry.table) === false) {
      report.refusals.push(
        `This box has no "${entry.table}" table, so this person cannot be erased from it. ` +
          "No database rows were changed: erasing somebody from most of the places that name them is worse " +
          `than erasing them from none. Apply ${entry.createdBy}, then run this again.`,
      );
    }
  }
  if (report.refusals.length > 0) return report;

  if (!(await hasExpectedOutsideCustodyForeignKeys(db))) {
    report.refusals.push("Outside credential ownership links are not the expected enforced database shape. Nothing was changed; check the database migrations before erasing this person.");
    return report;
  }
  if (await hasForeignCustodyOnOwnedAgent(db, person.id)) {
    report.refusals.push("Another member still holds outside credentials attached to an agent this person owns. Nothing was changed. Remove or move that custody through its approved owner before erasing this person.");
    return report;
  }

  // Studio runs written before member ownership was introduced contain private briefs and
  // generated content whose owner cannot be inferred from a current channel claim or user list.
  // Refuse the whole export/erase while any such row remains unknown.
  if (await countWhere(db, "SELECT count(*)::int AS n FROM studio_runs WHERE owner_member_id IS NULL")) {
    report.refusals.push("Studio history contains records with no recorded owner. Nothing was changed. Reconcile those records explicitly before exporting or erasing any member.");
    return report;
  }

  // Area metadata deliberately does not resolve or erase backing files. Refuse at the
  // shared preflight, including dry runs, so runErase cannot delete files before discovering
  // that these stable identities cannot yet be reconciled with storage.
  if (await countWhere(db, "SELECT count(*)::int AS n FROM vault_areas WHERE owner_member_id=$1", [person.id])) {
    report.refusals.push("This person owns Vault areas whose backing storage has not been reconciled for erasure. Nothing was changed. Reconcile their area content and retained identities before erasing this person.");
    return report;
  }

  if (await countWhere(db,"SELECT count(*)::int AS n FROM console_vault_source_captures WHERE member_id=$1",[person.id])) {
    report.refusals.push("This person has retained conversation source dependencies. Nothing was changed. Reconcile their conversation history before erasing this person.");
    return report;
  }

  const soleMember = (await countWhere(db, "SELECT count(*)::int AS n FROM users")) === 1;
  report.wasOnlyMember = soleMember;

  // ── Step 2: everything this run is going to do, counted first. Same order as the writes. ──
  const plans = await buildPlan(db, person, soleMember, opts.paths);
  report.planned = plans.filter((p) => p.rows > 0).map((p) => p.plan);
  report.outstanding.push(
    ...(await situationalOutstanding(db, soleMember, opts.paths !== undefined)),
    ...(await unattributedLines(db)),
  );

  if (opts.dryRun) return report;

  // ── Step 3: do it, in one transaction. ────────────────────────────────────────────────────
  if(!('release' in db))throw new Error('A journal-owned source transaction is required');
  const client=db;
  try {
    if (!(await hasExpectedOutsideCustodyForeignKeys(client))) throw new Error('Outside credential ownership links changed during erasure');
    if (await hasForeignCustodyOnOwnedAgent(client, person.id)) throw new Error('Another member still holds outside credentials attached to an agent this person owns');
    // Repeat under the barrier for standalone database erasure as well.
    if(await countWhere(client,"SELECT count(*)::int AS n FROM console_vault_source_captures WHERE member_id=$1",[person.id]))throw new Error('Retained conversation source dependencies prevent erasure');
    const custodyCounts = await custodyRowsForOwner(client, person.id);
    const done: ErasePlan[] = [];
    for (const { plan, write } of plans) {
      if (!write) continue;
      const { rowCount } = await client.query(write.sql, write.params);
      if ((rowCount ?? 0) > 0) done.push({ ...plan, rows: rowCount ?? 0 });
    }
    const custodyRemaining = await custodyRowsForOwner(client, person.id);
    if (OUTSIDE_CUSTODY_TABLES.some((table) => custodyRemaining[table] !== 0)) {
      throw new Error('Outside credential rows remain after their owner was erased');
    }
    for (const table of OUTSIDE_CUSTODY_TABLES) {
      const rows = custodyCounts[table];
      if (rows > 0) {
        const step = plans.find((candidate) => candidate.plan.table === table)!;
        done.push({ ...step.plan, rows });
      }
    }
    report.deleted = done;
  } catch (err) {
    if(owned)owned.failed=true;
    // 42P01 = undefined_table. A table dropped between the check above and this write; the same
    // refusal, for the same reason, and the transaction has already taken it all back.
    const code = (err as { code?: string }).code;
    report.refusals.push(
      code === "42P01"
        ? `A table this erase needs disappeared while it was running (${messageOf(err)}). ` +
            "No database rows were changed."
        : `Database erasure stopped; no database rows were changed: ${messageOf(err)}`,
    );
    report.deleted = [];
  }

  return report;
}

interface PlannedStep {
  plan: ErasePlan;
  rows: number;
  write?: { sql: string; params: unknown[] };
}

/**
 * The order is the correctness argument, and it is the reason this is one function rather than a
 * loop over the inventory:
 *   1. the ids of the rows that OTHER rows name are read and held — once a standing fact is gone,
 *      a proposal about it can no longer be tied to anybody;
 *   2. the tables reached through those held ids;
 *   2.5. the path-keyed sync tables, only when `paths` was given;
 *   3. the whole-corpus tables, when this person is the only member left;
 *   4. every member table, matched on every spelling this person has;
 *   5. the identity register itself, aliases first, LAST of all.
 */
async function buildPlan(
  db: Queryable,
  person: PersonIdentity,
  soleMember: boolean,
  paths: readonly string[] | undefined,
): Promise<PlannedStep[]> {
  const steps: PlannedStep[] = [];

  // 1 — the held ids.
  const heldIds: string[] = [];
  for (const table of HELD_ID_SOURCES) {
    const entry = MEMBER_SCOPE.find((t) => t.table === table)!;
    const spellings = spellingsFor(person, entry.idKind!);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id::text AS id FROM ${entry.table} WHERE ${matchClause(entry)}`,
      [spellings],
    );
    heldIds.push(...rows.map((r) => r.id));
  }

  // 2 — memory_proposals, reached only through those ids.
  {
    const entry = MEMBER_SCOPE.find((t) => t.table === "memory_proposals")!;
    const rows = heldIds.length
      ? await countWhere(
          db,
          "SELECT count(*)::int AS n FROM memory_proposals WHERE existing_id = ANY($1::text[])",
          [heldIds],
        )
      : 0;
    steps.push({
      plan: {
        table: entry.table,
        scope: entry.scope,
        rows,
        how: "removed — a proposed change to something this person had said",
      },
      rows,
      write: {
        sql: "DELETE FROM memory_proposals WHERE existing_id = ANY($1::text[])",
        params: [heldIds],
      },
    });
  }

  // 2.5 — the path-keyed sync-state tables. Only reached when the vault pass already ran and
  // named exactly which files it removed or found untracked; without `paths` these are left for
  // `outstanding` to name, exactly as before this option existed.
  if (paths !== undefined) {
    for (const table of PATH_KEYED_SYNC_TABLES) {
      const column = PATH_KEYED_SYNC_COLUMNS[table]!;
      const rows = await countWhere(
        db,
        `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = ANY($1::text[])`,
        [paths],
      );
      steps.push({
        plan: {
          table,
          scope: "resolved",
          rows,
          how: "removed — the sync job's own record of a file that no longer exists in the vault",
        },
        rows,
        write: {
          sql: `DELETE FROM ${table} WHERE ${column} = ANY($1::text[])`,
          params: [paths],
        },
      });
    }
  }

  // 3 — the whole-corpus tables, only when this person is the one member.
  if (soleMember) {
    for (const entry of MEMBER_SCOPE.filter((t) => t.clearedWholeOnly)) {
      const rows = await countWhere(db, `SELECT count(*)::int AS n FROM ${entry.table}`);
      steps.push({
        plan: {
          table: entry.table,
          scope: entry.scope,
          rows,
          how: "removed in full — this person is the only member, so the whole collection is theirs",
        },
        rows,
        write: { sql: `DELETE FROM ${entry.table}`, params: [] },
      });
    }
  }

  // 4 — every member table except the register, in inventory order.
  for (const entry of MEMBER_SCOPE) {
    if (entry.scope !== "member") continue;
    if ((REGISTER_TABLES as readonly string[]).includes(entry.table)) continue;
    steps.push(await memberStep(db, entry, person));
  }

  // 5 — the register itself, aliases first.
  for (const table of REGISTER_TABLES) {
    const entry = MEMBER_SCOPE.find((t) => t.table === table)!;
    const spellings = spellingsFor(person, entry.idKind!);
    const rows = await countWhere(
      db,
      `SELECT count(*)::int AS n FROM ${entry.table} WHERE ${matchClause(entry)}`,
      [spellings],
    );
    steps.push({
      plan: {
        table: entry.table,
        scope: entry.scope,
        rows,
        how: "removed — this person is no longer a member of this installation",
      },
      rows,
      write: {
        sql: `DELETE FROM ${entry.table} WHERE ${matchClause(entry)}`,
        params: [spellings],
      },
    });
  }

  return steps;
}

/** One member table: a delete, unless the column is an audit trail's actor — then the row stays
 *  and only the name goes. */
async function memberStep(
  db: Queryable,
  entry: ScopedTable,
  person: PersonIdentity,
): Promise<PlannedStep> {
  const spellings = spellingsFor(person, entry.idKind!);
  const where = matchClause(entry);
  const rows = await countWhere(
    db,
    `SELECT count(*)::int AS n FROM ${entry.table} WHERE ${where}`,
    [spellings],
  );

  if (eraseHandlingFor(entry) === "retire-and-redact-budget-liability") {
    // The account entry is first in the inventory. One ordered DB operation retires all
    // authority before redacting any member link; the following entries remain explicit
    // in the plan/report, rather than treating financial person data as operational.
    return {plan:{table:entry.table,scope:entry.scope,rows,how:"member metadata erased; financial liability and replay suppression retained"},rows,
      write:entry.table === "budget_accounts"
        ? {sql:"SELECT budget_retire_member($1,true)",params:[person.id]}
        : {sql:`UPDATE ${entry.table} SET live_member_id=NULL WHERE ${where}`,params:[spellings]}};
  }

  if (eraseHandlingFor(entry) === "delete-through-member-owner-cascade") {
    return {
      plan: { table: entry.table, scope: entry.scope, rows, how: "removed through the member's owner relationship" },
      rows,
    };
  }

  if (entry.idKind === "actor") {
    const sets = personColumnsOf(entry)
      .map((c) => `${c} = CASE WHEN ${c} = ANY($1::text[]) THEN $2::text ELSE ${c} END`)
      .join(", ");
    return {
      plan: {
        table: entry.table,
        scope: entry.scope,
        rows,
        how: "name replaced, row kept — the record still shows that a change was made, not who made it",
      },
      rows,
      write: {
        sql: `UPDATE ${entry.table} SET ${sets} WHERE ${where}`,
        params: [spellings, ERASED],
      },
    };
  }

  return {
    plan: { table: entry.table, scope: entry.scope, rows, how: "removed" },
    rows,
    write: { sql: `DELETE FROM ${entry.table} WHERE ${where}`, params: [spellings] },
  };
}

/**
 * The report, for the person who asked — who is not a developer. No column names, no id
 * conventions, no SQL. Where a place has to be named it is named as a place, once, in the detail
 * table at the end; the paragraphs above it say what happened in words.
 */
export function renderEraseReport(r: EraseReport): string {
  const out: string[] = [];
  out.push(`# Erasing ${r.person}`);
  out.push("");

  if (r.refusals.length > 0) {
    out.push("**No database rows were erased.** This run refused, and the database is exactly as it was.");
    out.push("");
    for (const refusal of r.refusals) out.push(`- ${refusal}`);
    out.push("");
    out.push("Review the refusal and the current files before deciding what to do next.");
    return out.join("\n");
  }

  const acted = r.dryRun ? r.planned : r.deleted;
  const removed = acted.filter((p) => !p.how.startsWith("name replaced"));
  const renamed = acted.filter((p) => p.how.startsWith("name replaced"));
  const removedRows = removed.reduce((n, p) => n + p.rows, 0);
  const renamedRows = renamed.reduce((n, p) => n + p.rows, 0);

  if (r.dryRun) {
    out.push(
      "**This was a practice run. Nothing was changed.** Here is what a real run would do; to " +
        "do it, run the same command again with `--apply`.",
    );
  } else {
    out.push("**Done.** Everything below happened together, in one go.");
  }
  out.push("");

  out.push(
    `**${removedRows} record${removedRows === 1 ? "" : "s"}** ${
      r.dryRun ? "would be" : "were"
    } removed, across ${removed.length} place${removed.length === 1 ? "" : "s"}.`,
  );
  if (renamedRows > 0) {
    out.push("");
    out.push(
      `**${renamedRows} entr${renamedRows === 1 ? "y" : "ies"}** in the installation's own change ` +
        `log ${r.dryRun ? "would be" : "were"} kept, with this person's name replaced by the word ` +
        `"${ERASED}". The log has to go on showing that somebody changed a setting or a ` +
        "permission; it no longer shows who.",
    );
  }
  out.push("");
  out.push(
    r.dryRun
      ? "Afterwards this person would no longer be a member of this installation."
      : "This person is no longer a member of this installation.",
  );
  if (r.wasOnlyMember) {
    out.push("");
    out.push(
      r.dryRun
        ? "They are the only member, so afterwards this installation would have no member at " +
            "all. Nothing would run for anybody until somebody is added."
        : "They were the only member, so this installation now has no member at all. Nothing " +
            "will run for anybody until somebody is added.",
    );
  }

  out.push("");
  out.push("## What this did not reach");
  out.push("");
  for (const line of r.outstanding) out.push(`- ${line}`);

  if (acted.length > 0) {
    out.push("");
    out.push("## Where the records were");
    out.push("");
    out.push("| where | what happened | how many |");
    out.push("|---|---|---|");
    for (const p of acted) out.push(`| ${p.table} | ${p.how} | ${p.rows} |`);
  }

  out.push("");
  return out.join("\n");
}
