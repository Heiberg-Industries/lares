// services/box/lib/first-owner.ts — W8C-s7: the owner becomes a real member, with a real id.
//
// THIS IS THE MOST DANGEROUS FILE IN THE INSTALLER. A wrong id here is SILENT and PERMANENT:
// every note, reminder, standing fact and forget-ledger row would be filed under a person who
// does not exist, and `forget_ledger`'s hashes can never be re-keyed (W5I-s7). Work through this
// file slowly; every branch below either does nothing, or does exactly one thing inside one
// transaction.
//
// Fresh migrations contain no owner seed. A fresh register starts empty; the operator
// supplies the owner's identity. The legacy seed reader remains for older SQL layouts,
// and never guesses an identity when a seed is absent. Existing nonempty registers
// refuse replacement unless that older seed can be positively identified as unused.
// No stored identity or forget-ledger hash is re-keyed by publication cleanup.
import type { Queryable } from "./db.js";
import { MEMBER_SCOPE } from "./member-scope.js";
import { REGISTER_TABLES, matchClause } from "./erase-person.js";
import { resolvePerson, spellingsFor, type PersonIdentity } from "./person-identity.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Where this installation's own SQL lives, resolved from this file's own location rather than
 *  passed in — `isUntouchedEngineSeed` and `createFirstOwner`'s signatures (below) take no
 *  `sqlDir`, so this is the one place that has to know where `014_identity.sql` is. `bin/doctor.ts`
 *  and `bin/first-owner.ts` each resolve the same directory the same way, relative to where THEY
 *  live, for exactly the same reason `bin/doctor.ts` already did before this file existed. */
const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");

/** The one file that seeds an owner row, so a fresh install starts with somebody else's name in
 *  it. Named here as a FILE, not as a person. */
const ENGINE_SEED_FILE = "014_identity.sql";

/** Matches `014_identity.sql`'s own `INSERT INTO users (id, display_name, primary_email) VALUES
 *  (...)` and captures what it inserts, so this module never carries that value as a literal. */
const ENGINE_SEED_INSERT =
  /INSERT INTO users \(id, display_name, primary_email\)\s*VALUES\s*\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/;

/** Matches the seed file's `INSERT INTO user_aliases (system, alias, user_id) VALUES ...` block,
 *  capturing everything between `VALUES` and the statement's own terminating `;` (which, in
 *  `014_identity.sql`, comes after the `ON CONFLICT` clause, not right after the last tuple —
 *  the capture including that clause's text is harmless, since it holds no quoted triple). */
const ENGINE_SEED_ALIAS_BLOCK =
  /INSERT INTO user_aliases \(system, alias, user_id\)\s*VALUES([\s\S]*?);/;

/** One `('system', 'alias', 'user_id')` tuple inside that block. */
const ENGINE_SEED_ALIAS_TUPLE = /\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g;

/** Besides `users`/`user_aliases` (`REGISTER_TABLES`, `lib/erase-person.ts`), one more table is
 *  migration-seeded scaffolding tied to the engine's own seed row rather than evidence somebody
 *  used this identity — see the header. Walking it in `isUntouchedEngineSeed` would make a FRESH
 *  install answer `false`, which is exactly backwards.
 *
 *  `forget_ledger` IS walked, and that is deliberate. It is the one table this module must never
 *  WRITE to — its `match_hash` is derived from the owner string and can never be re-keyed (see its
 *  own inventory entry) — and that is exactly why a seed row it names must never be deleted: the
 *  rows left behind could not be re-pointed at anybody, ever. Reading it is not touching it, so
 *  the walk asks it the same read-only question it asks every other member table. */
const NEVER_WALKED_TABLES: readonly string[] = ["org_member_policy"];

/** What `014_identity.sql` seeds: the owner row it inserts, and the aliases it inserts for that
 *  same row. `null` when the file is missing or its INSERT has changed shape — never guessed. */
export interface EngineSeed {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly aliases: ReadonlyArray<{ readonly system: string; readonly alias: string }>;
}

/** The id, display name, email and aliases `services/box/sql/014_identity.sql` seeds, read from
 *  the file itself — the ONE implementation of this reader in the repository; `lib/doctor.ts`'s
 *  owner check imports this rather than keeping its own copy. */
export function readEngineSeed(sqlDir: string): EngineSeed | null {
  try {
    const text = readFileSync(join(sqlDir, ENGINE_SEED_FILE), "utf8");
    const matched = ENGINE_SEED_INSERT.exec(text);
    if (!matched) return null;
    const id = matched[1]!;

    const aliases: Array<{ system: string; alias: string }> = [];
    const block = ENGINE_SEED_ALIAS_BLOCK.exec(text);
    if (block) {
      let tuple: RegExpExecArray | null;
      ENGINE_SEED_ALIAS_TUPLE.lastIndex = 0;
      while ((tuple = ENGINE_SEED_ALIAS_TUPLE.exec(block[1]!))) {
        if (tuple[3] === id) aliases.push({ system: tuple[1]!, alias: tuple[2]! });
      }
    }

    return { id, displayName: matched[2]!, email: matched[3]!, aliases };
  } catch {
    return null;
  }
}

/** The register id, and what the free text arrives as (W5I-s7's ruling: NO shape heuristics
 *  beyond "not blank" — this stays free text by design). */
export interface FirstOwnerInput {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
}

export type FirstOwnerOutcome =
  | { kind: "created"; id: string; removedEngineSeed: boolean }
  | { kind: "already"; id: string }
  | { kind: "refused"; why: string };

/** What a run WOULD do, decided by reads alone. `createFirstOwner` below executes exactly this,
 *  and `bin/first-owner.ts`'s practice run narrates exactly this — ONE implementation, so a
 *  preview can never promise something different from what the real run then does. */
export type FirstOwnerDecision =
  | { kind: "already"; id: string }
  | { kind: "create"; id: string; removeSeedId: string | null }
  | { kind: "refused"; why: string };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Doubles the quotes in a SQL string literal — the same escape `lib/migration-runner.ts`'s
 *  `literal()` uses, and for the same reason: these values travel inside a multi-statement
 *  query, where bound parameters are not available. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * True only when the row `users.id = <the engine's own seed id>` is exactly what
 * `014_identity.sql` inserted, and nothing else on this box names it — see the file header for
 * what "nothing else" is walked against. Fails closed: anything this cannot be sure of (the seed
 * file unreadable, a query failing, the register missing) answers `false`, never `true`.
 */
export async function isUntouchedEngineSeed(db: Queryable): Promise<boolean> {
  try {
    const seed = readEngineSeed(SQL_DIR);
    if (seed === null) return false;

    let person: PersonIdentity;
    try {
      person = await resolvePerson(db, seed.id);
    } catch {
      return false; // no such row, the register is missing, or the id is ambiguous.
    }
    if (person.id !== seed.id) return false; // resolved through an alias of someone else.

    const { rows } = await db.query<{ primary_email: string | null }>(
      "SELECT primary_email FROM users WHERE id = $1",
      [seed.id],
    );
    if (rows[0]?.primary_email !== seed.email) return false;

    const seedAliasKeys = new Set(seed.aliases.map((a) => `${a.system}\u0000${a.alias}`));
    const hasExtraAlias = person.aliases.some(
      (a) => !seedAliasKeys.has(`${a.system}\u0000${a.alias}`),
    );
    if (hasExtraAlias) return false;

    const memberEntries = MEMBER_SCOPE.filter(
      (t) =>
        t.scope === "member" &&
        !(REGISTER_TABLES as readonly string[]).includes(t.table) &&
        !NEVER_WALKED_TABLES.includes(t.table),
    );
    if (memberEntries.length === 0) return true;

    const { rows: presenceRows } = await db.query<{ name: string; present: boolean }>(
      "SELECT t.name, to_regclass(t.name) IS NOT NULL AS present FROM unnest($1::text[]) AS t(name)",
      [memberEntries.map((e) => e.table)],
    );
    const present = new Map(presenceRows.map((r) => [r.name, r.present]));

    for (const entry of memberEntries) {
      // Not migrated on this box yet: nothing can name anyone in a table that does not exist —
      // read as zero matches, never as a reason to refuse or to guess.
      if (present.get(entry.table) !== true) continue;
      const spellings = spellingsFor(person, entry.idKind!);
      const { rows: hits } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${entry.table} WHERE ${matchClause(entry)}`,
        [spellings],
      );
      if (Number(hits[0]?.n ?? 0) > 0) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the real owner, or explains why it refused. One transaction: either the new owner
 * exists (and, when it was safe, the engine's own seed is gone with it) or nothing changed at
 * all.
 *
 * `already` is this routine's OWN idempotency, not a duplicate-key error surfacing from
 * Postgres: running this again with the same id is exactly what a re-run of the installer does,
 * and it must say "nothing was needed", not fail.
 */
export async function decideFirstOwner(
  db: Queryable,
  input: FirstOwnerInput,
): Promise<FirstOwnerDecision> {
  const id = input.id.trim();
  if (id === "") {
    return {
      kind: "refused",
      why: "An owner id cannot be blank. Refusing rather than inventing one (W5I-s7).",
    };
  }

  let existingIds: readonly string[];
  try {
    const { rows } = await db.query<{ id: string }>("SELECT id FROM users");
    existingIds = rows.map((r) => r.id);
  } catch (err) {
    return { kind: "refused", why: `The identity register could not be read: ${messageOf(err)}` };
  }

  if (existingIds.includes(id)) {
    return { kind: "already", id };
  }

  if (existingIds.length === 0) {
    return { kind: "create", id, removeSeedId: null };
  }

  const seed = readEngineSeed(SQL_DIR);
  const soleSeedRow = existingIds.length === 1 && seed !== null && existingIds[0] === seed.id;
  const safeToReplace = soleSeedRow && (await isUntouchedEngineSeed(db));
  if (!safeToReplace) {
    return {
      kind: "refused",
      why:
        "The identity register already has somebody else's data in it. A wrong owner id here " +
        "is silent and permanent, so this refuses to touch it automatically — resolve it by " +
        "hand (look at the `users` table, or `services/box/lib/erase-person.ts`) and run this " +
        "again.",
    };
  }
  return { kind: "create", id, removeSeedId: seed!.id };
}

export async function createFirstOwner(
  db: Queryable,
  input: FirstOwnerInput,
): Promise<FirstOwnerOutcome> {
  const decision = await decideFirstOwner(db, input);
  if (decision.kind === "refused") return { kind: "refused", why: decision.why };
  if (decision.kind === "already") return { kind: "already", id: decision.id };
  const { id, removeSeedId } = decision;

  const statements = [
    `INSERT INTO users (id, display_name, primary_email) VALUES (${literal(id)}, ` +
      `${literal(input.displayName)}, ${literal(input.email)})`,
    `INSERT INTO user_aliases (system, alias, user_id) VALUES ('email', ${literal(input.email)}, ` +
      `${literal(id)}) ON CONFLICT (system, alias) DO NOTHING`,
  ];
  // The engine's own seed row goes LAST, and only by name — its aliases and its
  // `org_member_policy` row both carry `ON DELETE CASCADE` back to `users.id`, so this one
  // statement is the whole removal.
  if (removeSeedId !== null) {
    statements.push(`DELETE FROM users WHERE id = ${literal(removeSeedId)}`);
  }

  try {
    await db.query(`BEGIN;\n${statements.map((s) => `${s};`).join("\n")}\nCOMMIT;\n`);
  } catch (err) {
    return {
      kind: "refused",
      why: `Creating the owner failed, and nothing was changed: ${messageOf(err)}`,
    };
  }

  return { kind: "created", id, removedEngineSeed: removeSeedId !== null };
}
