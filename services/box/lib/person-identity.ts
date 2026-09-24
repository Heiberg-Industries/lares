// services/box/lib/person-identity.ts — W5I-s1: one person, every spelling they have.
//
// WHY THIS FILE IS THE CORRECTNESS CORE. Every later erase, export and forget goes through
// `resolvePerson`. Its failure mode is SILENCE: a spelling it does not know about is a row nobody
// erases, reported as success. So what this module does when it CANNOT resolve something matters
// more than what it does when it can — every unresolved case below throws, with a sentence a
// person can read. Nothing here ever answers "no rows" when the truthful answer is "I do not
// know".
//
// WHAT IT READS, AND ONLY READS. `users` and `user_aliases` (services/box/sql/014_identity.sql),
// the identity register — the one place in the system that knows two spellings are the same
// person (owner decision D3: the register is the one truth). `unresolvableValues` additionally
// reads ONE member table named by the inventory. This module writes nothing, alters nothing and
// creates nothing.
//
// THE THREE (FOUR) SPELLING FAMILIES come from `lib/member-scope.ts`'s `idKind`, and this module
// is the only sanctioned way to turn a person into the set of spellings a given family uses:
//   registry   — the register's own id space (`users.id`): the canonical id, and nothing else.
//   principal  — a door-native or legacy spelling (`oauth_tokens.principal` is frozen at one):
//                every alias the register holds, plus the canonical id.
//   owner-key  — a free-text `owner` column convention fills with the canonical id: the canonical
//                id FIRST, then the legacy spellings, because convention already writes the
//                canonical id there and an older row may not have caught up.
//   actor      — whoever changed an administrative row: the canonical id, as the register writes
//                it. (Conservatively classed `member` by the inventory; see its header.)
// `spellingsFor` is exhaustive over `IdKind` and THROWS on a kind it does not know. That is the
// tie between this module and the inventory: a new id convention added to `member-scope.ts`
// without teaching this file about it is a loud failure, never a quietly empty spelling list.
//
// TABLE AND COLUMN NAMES COME FROM `MEMBER_SCOPE` ONLY, NEVER FROM OUTSIDE. `unresolvableValues`
// interpolates a table and a column into SQL — it can do that safely only because it first looks
// the pair up in the inventory and refuses anything that is not a `member` entry there. Do not
// add a caller that passes a name typed by a person or read from a request.

import type { Queryable } from "./db.js";
import { MEMBER_SCOPE, type IdKind } from "./member-scope.js";

/** Every spelling one person has, grouped by the id convention that uses it. */
export interface PersonIdentity {
  /** The register's canonical id — `users.id`. The one truth (owner decision D3). */
  id: string;
  /** Every `user_aliases` row for this person, by system. */
  aliases: ReadonlyArray<{ system: string; alias: string }>;
  /** The spellings to match a `principal`-kind column on: every alias, plus the canonical id. */
  principals: readonly string[];
  /** The spellings to match an `owner-key` column on. The canonical id first, then the
   *  legacy spellings, because convention already fills these with the canonical id. */
  ownerKeys: readonly string[];
  /** Every spelling, de-duplicated — the set a `column IN (...)` match uses. */
  spellings: readonly string[];
}

/** Nothing in the register answers to this spelling. Never an empty answer: an erase that got
 *  one would delete nothing and report success. */
export class PersonNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonNotFound";
  }
}

/** Two different register ids claim the same spelling. The resolver never guesses which. */
export class PersonAmbiguous extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonAmbiguous";
  }
}

/** The register itself is not on this box. An unreachable register must never be read as
 *  "this person has no spellings" — the rule `services/chief-of-staff/lib/identity-client.ts`
 *  already states for `listAliases`. */
export class IdentityRegisterMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityRegisterMissing";
  }
}

const REGISTER_MISSING =
  "The identity register is not on this box: the tables `users` and `user_aliases` are missing " +
  "(apply services/box/sql/014_identity.sql). Without them nobody can tell one person's " +
  "spellings from another's, so this is an error rather than an empty answer.";

/** De-duplicate, keeping first-seen order. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Both register tables must exist before anything reads them. `to_regclass` answers NULL for a
 *  relation that is not there, so this needs no error-code guessing and costs one round trip. */
async function assertRegisterPresent(db: Queryable): Promise<void> {
  const { rows } = await db.query<{ has_users: boolean; has_aliases: boolean }>(
    "SELECT to_regclass('users') IS NOT NULL AS has_users, " +
      "to_regclass('user_aliases') IS NOT NULL AS has_aliases",
  );
  const present = rows[0];
  if (!present || !present.has_users || !present.has_aliases) {
    throw new IdentityRegisterMissing(REGISTER_MISSING);
  }
}

/**
 * Resolve a person by ANY spelling: the canonical id, or any alias in any system.
 *
 * Throws `PersonNotFound` when nothing resolves, `PersonAmbiguous` when two different `users.id`
 * rows claim the same spelling, and `IdentityRegisterMissing` when the register is not on this
 * box — never guesses, never returns a partial answer, never returns an empty one.
 *
 * Matching is exact and case-sensitive, because that is how the columns are matched later: where
 * a long-lived box has accumulated two spellings that differ only in case, the register carries
 * BOTH as alias rows and both resolve. Guessing at case here would be a second, unrecorded
 * matching rule that the columns themselves do not follow.
 */
export async function resolvePerson(db: Queryable, who: string): Promise<PersonIdentity> {
  await assertRegisterPresent(db);

  // `users.id` first, `user_aliases.alias` second. The LEFT JOIN back onto `users` is not
  // decoration: it separates "an alias points at an id the register does not hold" (a broken
  // register — still not found, but for a different reason worth saying out loud) from a
  // spelling nobody has ever used.
  const { rows } = await db.query<{ candidate: string; in_register: boolean }>(
    `SELECT c.candidate, (u.id IS NOT NULL) AS in_register
       FROM (SELECT id AS candidate FROM users WHERE id = $1
             UNION
             SELECT user_id      FROM user_aliases WHERE alias = $1) c
       LEFT JOIN users u ON u.id = c.candidate
      ORDER BY c.candidate`,
    [who],
  );

  if (rows.length === 0) {
    throw new PersonNotFound(
      `Nobody in the identity register answers to "${who}". Nothing was matched and nothing was ` +
        "changed. Check the spelling, or add it to the register as an alias of the person it " +
        "belongs to.",
    );
  }
  if (rows.length > 1) {
    const claimants = rows.map((r) => `"${r.candidate}"`).join(", ");
    throw new PersonAmbiguous(
      `"${who}" is claimed by more than one person in the identity register (${claimants}). ` +
        "Refusing to guess which one was meant — remove the wrong alias row first, then run this " +
        "again.",
    );
  }
  const only = rows[0];
  if (!only.in_register) {
    throw new PersonNotFound(
      `"${who}" is an alias of "${only.candidate}", but the identity register holds no person ` +
        `with that id. The register is inconsistent; repair it before erasing or exporting ` +
        "anything.",
    );
  }

  const id = only.candidate;
  const aliasRows = await db.query<{ system: string; alias: string }>(
    "SELECT system, alias FROM user_aliases WHERE user_id = $1 ORDER BY system, alias",
    [id],
  );
  const aliases = aliasRows.rows.map((r) => ({ system: r.system, alias: r.alias }));
  const aliasSpellings = aliases.map((a) => a.alias);

  return {
    id,
    aliases,
    // A principal column holds a door-native or legacy spelling, so the aliases lead; the
    // canonical id is included because several tables NAMED `principal` are in fact written with
    // it (see member-scope.ts's `idKind: "registry"` entries and their reasons).
    principals: unique([...aliasSpellings, id]),
    // An owner column is convention-filled with the canonical id, so that leads.
    ownerKeys: unique([id, ...aliasSpellings]),
    spellings: unique([id, ...aliasSpellings]),
  };
}

/**
 * The spellings to match, for one table's `idKind`.
 *
 * Exhaustive over `IdKind` on purpose: an id convention added to `lib/member-scope.ts` that this
 * function has not been taught throws instead of returning a list, because an empty or partial
 * list is exactly the silence this track exists to remove.
 */
export function spellingsFor(person: PersonIdentity, kind: IdKind): readonly string[] {
  switch (kind) {
    case "registry":
      return [person.id];
    case "actor":
      // An audit column is free text: whoever wrote it may have used any spelling the person has
      // ever had. Matching all of them can only find MORE of this person's rows — no alias of
      // theirs is also "system" or "console" — whereas matching the id alone would let an erase
      // leave their name behind in a log and report success.
      return person.spellings;
    case "principal":
      return person.principals;
    case "owner-key":
      return person.ownerKeys;
    default: {
      const unknown: never = kind;
      throw new Error(
        `The inventory names an id convention this resolver does not know: "${String(unknown)}". ` +
          "Teach services/box/lib/person-identity.ts which spellings that convention uses before " +
          "any erase or export runs — an unknown convention must never resolve to an empty list.",
      );
    }
  }
}

/**
 * Values in `table.column` that resolve to NOBODY in the register. An erase that finds any of
 * these must REFUSE, not report success: they may be a person the register has never heard of.
 *
 * `table` and `column` must name a `member` entry in `MEMBER_SCOPE`, and are checked against it
 * before they are interpolated into SQL. They never come from outside this repository.
 *
 * Two honest limits, stated rather than papered over:
 *  - rows whose column IS NULL hold no value and are not reported here; a nullable person column
 *    is a separate gap, and the inventory is where it is recorded.
 *  - if the table itself is not on this box (a box that has not applied the migration that creates
 *    it) the underlying error is allowed to escape. Failing loudly is the point; answering `[]`
 *    would read as "every value here belongs to a known person".
 */
export async function unresolvableValues(
  db: Queryable,
  table: string,
  column: string,
): Promise<readonly string[]> {
  const entry = MEMBER_SCOPE.find((t) => t.table === table);
  if (!entry || entry.scope !== "member" || entry.column !== column) {
    throw new Error(
      `"${table}"."${column}" is not a member column in the inventory ` +
        "(services/box/lib/member-scope.ts). This function reads only table and column names the " +
        "inventory itself names — never a name from outside.",
    );
  }

  await assertRegisterPresent(db);

  const { rows } = await db.query<{ value: string }>(
    `SELECT DISTINCT t.${column} AS value
       FROM ${table} t
      WHERE t.${column} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM users u        WHERE u.id    = t.${column})
        AND NOT EXISTS (SELECT 1 FROM user_aliases a WHERE a.alias = t.${column})
      ORDER BY 1`,
  );
  return rows.map((r) => r.value);
}
