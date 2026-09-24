// services/box/lib/erase-person.ts — W5B-s6: erase a person from every table that names them,
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
// anybody it does not hold is refused (owner ruling D2 — a member of this installation, never a
// third party a note happens to be about). Every table is then matched with
// `= ANY(spellingsFor(person, idKind))`, never `= <the id>`: the whole point of the identity track
// is that rows written under an older spelling go too, and this routine must not assume the
// migrations that unified those spellings (box 083/085) have been applied.
//
// WHAT IS DELIBERATELY NOT DELETED.
//  - An `actor` column records WHO DID something in an administrative log (owner ruling D6). The
//    row stays and the name is replaced with the literal `erased`: the log still shows that
//    somebody changed a permission, and no longer shows who.
//  - A `clearedWholeOnly` table (the learned writing-voice corpus) has no person column at all. It
//    is cleared in full ONLY when the person being erased is the installation's one member;
//    otherwise it is left and named in the report.
//  - A row whose person column is NULL cannot be attributed to anyone. It is counted and named,
//    never guessed at — box 084's own rule for the dream tables, applied to every member table.
//  - The path-keyed sync tables (`notion_sync_*`, `atlas_*`) are reached through vault paths, not
//    through a person column. Without `opts.paths` they are named in `outstanding` and left
//    alone; with it (W5B-s8, once the vault pass has run and knows which files just went) they
//    are deleted for exactly those paths, in the same transaction as everything else.
//
// TABLE AND COLUMN NAMES ARE INTERPOLATED INTO SQL, and can be only because every one of them
// comes from `MEMBER_SCOPE` — a constant in this repository — and never from a request, a
// settings row or anything an operator typed. `opts.person` is a bound parameter everywhere.
// This is the same rule `lib/person-identity.ts`'s `unresolvableValues` states; do not add a
// caller that passes a name from outside.

import type { Pool, PoolClient } from "pg";
import type { Queryable } from "./db.js";
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
  | "delete-by-person-column"
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
 * `reachedBy` in the inventory, and services/box/sql/072's own header — the column is text
 * precisely so it can name a row in either). Their ids are read and HELD before anything is
 * deleted, because once the owning row is gone the join is impossible.
 *
 * Exported for `lib/export-person.ts`, which reaches `memory_proposals` the same way — through
 * the ids of rows this person owns, never through a column of its own.
 */
export const HELD_ID_SOURCES = ["standing_facts", "dream_preferences"] as const;

/** Reached through a vault path rather than through a person column. Named in `outstanding` (and
 *  left untouched) when `opts.paths` is absent; deleted, keyed on exactly those paths, when
 *  `opts.paths` is given — W5B-s8, once the vault pass has run and knows which files just went. */
const PATH_KEYED_SYNC_TABLES = [
  "notion_sync_docs",
  "notion_sync_proposals",
  "notion_sync_fidelity",
  "atlas_notes",
  "atlas_proposals",
] as const;

/**
 * Which column each path-keyed table matches a vault path on — confirmed against the real
 * `CREATE TABLE` statements (`services/box/sql/015_notion_sync.sql`, `016_notion_sync_phase3.sql`,
 * `019_atlas_sync.sql`), not assumed from the inventory's prose. The notion-sync family stores
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
  "The relationship records, which live in a separate database on this server — a different file " +
    "that this routine does not open.",
  "Any backup taken before this run. Restoring one would bring the erased records back, so the " +
    "backups have to be expired or re-taken separately.",
];

/** What the erase does with one inventory entry, derived from the entry's own fields wherever
 *  that is possible. Exported so the test can prove the inventory and this file agree. */
export function eraseHandlingFor(entry: ScopedTable): EraseHandling | null {
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

/** The literal a cleared audit trail reads afterwards (owner ruling D6). */
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

/** Rows whose person column is NULL: nobody's, as far as this database can tell. Counted and
 *  stated, never deleted and never attributed — box 084's rule for the dream tables, which is the
 *  only honest rule for any nullable person column. Actor columns are excluded: a missing actor
 *  is a missing operator label, not a person's own data. */
async function unattributedLines(q: Queryable): Promise<string[]> {
  const lines: string[] = [];
  for (const entry of MEMBER_SCOPE) {
    if (entry.scope !== "member" || entry.idKind === "actor") continue;
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
export async function erasePerson(
  db: Pool,
  opts: {
    person: string;
    dryRun: boolean;
    /** Store-relative vault paths the vault pass (W5B-s7) just removed or found untracked, for
     *  the SAME person, in the SAME run. When given (even as an empty array), the path-keyed
     *  sync-state tables are deleted for exactly these paths, inside the same transaction as the
     *  member deletes. When absent, those tables are untouched, as before this option existed. */
    paths?: readonly string[];
  },
): Promise<EraseReport> {
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
    person = await resolvePerson(db, opts.person);
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
          "Nothing was changed: erasing somebody from most of the places that name them is worse " +
          `than erasing them from none. Apply ${entry.createdBy}, then run this again.`,
      );
    }
  }
  if (report.refusals.length > 0) return report;

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
  const client: PoolClient = await db.connect();
  try {
    await client.query("BEGIN");
    const done: ErasePlan[] = [];
    for (const { plan, write } of plans) {
      const { rowCount } = await client.query(write.sql, write.params);
      if ((rowCount ?? 0) > 0) done.push({ ...plan, rows: rowCount ?? 0 });
    }
    await client.query("COMMIT");
    report.deleted = done;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    // 42P01 = undefined_table. A table dropped between the check above and this write; the same
    // refusal, for the same reason, and the transaction has already taken it all back.
    const code = (err as { code?: string }).code;
    report.refusals.push(
      code === "42P01"
        ? `A table this erase needs disappeared while it was running (${messageOf(err)}). ` +
            "Nothing was changed."
        : `This erase was stopped before anything was changed: ${messageOf(err)}`,
    );
    report.deleted = [];
  } finally {
    client.release();
  }

  return report;
}

interface PlannedStep {
  plan: ErasePlan;
  rows: number;
  write: { sql: string; params: unknown[] };
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
 *  and only the name goes (owner ruling D6). */
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
    out.push("**Nothing was erased.** This run refused, and the database is exactly as it was.");
    out.push("");
    for (const refusal of r.refusals) out.push(`- ${refusal}`);
    out.push("");
    out.push("Fix what is named above and run it again.");
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
