// The forget ledger: what the owner told the agent to forget, keyed on a one-way hash so a re-
// import or re-sync can be checked against it without this table ever holding readable words.
// See services/box/sql/076_forget_ledger.sql for the full rationale and the honest limit it
// states. Lives in @lares/vault-format (dependency-free, present in every image, including the
// sync-jobs image, which does not contain @lares/agent-kit) so services/box, services/chief-of-staff
// (the forget/remember tools, the dream) and services/notion-sync can all import the same key
// derivation. @lares/agent-kit/forget-ledger re-exports this module for role services, the same
// way it re-exports @lares/vault-format/origin.
//
// ONE RULE FOR THE KEY (W5I-s7): `owner` is always the identity register's canonical id
// (`users.id`, services/box/sql/014_identity.sql) — never a channel-native spelling (a
// Slack/Telegram id, an email address) and never empty. Every WRITER (chief-of-staff's
// `forget`/`remember`, services/chief-of-staff/catalogue/forget.ts and catalogue/remember.ts) and
// every READER (notion-sync's forgotten-file guard, services/notion-sync/lib/cli.ts's
// `ownerOfPath` in lib/path-owner.ts) must arrive at that same string for the same person, or a forget
// written by one silently stops protecting the other's reads. `assertCanonicalOwner`, called
// first by every function below that touches a row, is the mechanical half of that rule — it
// refuses a BLANK owner, the one thing that can be known without the register, before it is
// ever hashed into a row nobody could find again. It does not guess from the shape of the string
// (the register allows any id), and it cannot catch a value that merely DISAGREES with the
// register (e.g. an installation's fail-soft
// configured owner key drifting from the register's own id) — that is a live-agreement question,
// not a shape question, and chief-of-staff's `checkOwnerKeyAgreement` (W5I-s5b,
// services/chief-of-staff/lib/identity-client.ts) is what catches THAT, once per process, and
// opens a repair rather than silently filing memory under the wrong name.
//
// OLD ROWS CAN NEVER BE RE-KEYED. `match_hash` is a one-way hash of the owner string, the kind
// and the normalised words — the words themselves are never stored (see `forgetKey` below), so
// there is no way to recompute a row's hash under a different owner spelling after the fact. If
// an installation's canonical owner key ever changes — a second member replaces the first, a
// migration renames the slug — every row written under the old spelling simply stops matching: a
// re-import or a re-sync it used to block would go through unblocked, silently, because the
// lookup hashes the NEW owner string and finds nothing. Box 083
// (`083_owner_key_is_the_register_id.sql`) rewrote fifteen other owner columns to the register's
// id for exactly this reason and named `forget_ledger` as the one table it could not follow;
// `checkOwnerKeyAgreement`'s repair is the closest thing this system has to a safety net for that
// gap — it tells the owner the configured key has drifted from the register before more rows
// accumulate under the wrong one, but it does not, and cannot, fix what is already written. (A
// second lookup under the person's other known spellings —
// `services/box/lib/person-identity.ts`'s `spellingsFor(person, "owner-key")` — would let an old
// row under a legacy spelling keep protecting after a key change; this slice does not build that,
// since nothing here calls the resolver and it would need to be reachable from both
// chief-of-staff and notion-sync — a decision for later, not invented here.)
import { createHash } from "node:crypto";

/** Minimal structural query interface — a `pg` `Pool` and a `PoolClient` both satisfy it, so a
 *  caller can run `recordForgotten` inside a transaction. Lets this dependency-free package type
 *  a DB handle without importing "pg" (mirrors `services/box/lib/db.ts`'s `Queryable`). */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R = any>(text: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

/** What was forgotten. `fact` — a standing_facts row. `note` — a vault file, by store-relative
 *  path. `preference` — a dream_preferences row. */
export type ForgottenKind = "fact" | "note" | "preference";
export const FORGOTTEN_KINDS: readonly ForgottenKind[] = ["fact", "note", "preference"];

/** What wrote the row. `forget` — the single-fact tool. `erase-person` — the bulk erase CLI. */
export type ForgetReason = "forget" | "erase-person";
export const FORGET_REASONS: readonly ForgetReason[] = ["forget", "erase-person"];

export interface ForgetLedgerEntry {
  id: number;
  owner: string;
  kind: ForgottenKind;
  matchHash: string;
  forgottenAt: Date;
  reason: ForgetReason;
}

/** Thrown by `assertCanonicalOwner` — the owner string it was given looks like a channel-native
 *  spelling (a Slack/Telegram id, an email address) or is empty, rather than the identity
 *  register's canonical id. Never thrown for a value that merely disagrees with the register
 *  while still looking canonical — see this module's header. */
export class OwnerIsNotCanonical extends Error {
  constructor(owner: string) {
    super(
      `forget-ledger: owner ${JSON.stringify(owner)} is blank. Every forget_ledger row must be ` +
        "keyed on the identity register's id (users.id), or it protects nothing (see this " +
        "module's header).",
    );
    this.name = "OwnerIsNotCanonical";
  }
}


/** `forgetKey` length-prefixes owner, kind and the normalised words. The owner MUST be the
 *  register's canonical id (`users.id`) — never a channel spelling, never an alias. A hash
 *  computed from a different spelling can never be matched again, because the words are not
 *  stored. `assertCanonicalOwner` throws rather than writing (or checking) an entry keyed on a
 *  string that cannot be the register's id — every function below that touches a row calls it
 *  first. */
export function assertCanonicalOwner(owner: string): void {
  // ONLY what can be known without the register: an empty or blank owner keys nothing. This
  // function deliberately does NOT guess from the SHAPE of the string (an "@", all digits, a
  // leading "U"): the register puts no such rule on `users.id`, so an installation whose owner
  // chose their email address or a number as their id would have every forget, every remember
  // and the Notion guard THROW — for a heuristic. Whether a string really is the register's id
  // needs the register; chief-of-staff's `checkOwnerKeyAgreement` does that check, once per
  // process, and raises a repair.
  if (owner.trim() === "") throw new OwnerIsNotCanonical(owner);
}

/** Lower-cased, punctuation-stripped, whitespace-collapsed — the same normalisation
 *  `services/chief-of-staff/lib/dream/store.ts`'s `normalizeObservationText` uses, repeated here
 *  because this package cannot import a role service. `packages/vault-format/tests/forget-ledger.test.ts`
 *  pins the two against drift by reading that file as text. Used for fact/preference wording;
 *  never used on its own to key a note (see `normaliseForgottenPath`), because it strips the
 *  slashes a path needs. The result of this function is never stored — only its hash is (see
 *  `forgetKey`). */
export function normaliseForgotten(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The path-flavoured normalisation `wasPathForgotten`/`recordForgotten` use for a `note`: a
 *  vault path's identity is its structure, which word-normalisation would destroy by stripping
 *  its slashes. Lower-cased, trimmed, backslashes turned to forward slashes. */
function normaliseForgottenPath(p: string): string {
  return p.trim().toLowerCase().replace(/\\/g, "/");
}

function normaliseFor(kind: ForgottenKind, words: string): string {
  return kind === "note" ? normaliseForgottenPath(words) : normaliseForgotten(words);
}

/** The one-way match key. A lowercase hex SHA-256 digest of the three fields, each LENGTH-PREFIXED
 *  (`<len>:<owner><len>:<kind><len>:<normalised>`). Joining them with a separator would be
 *  ambiguous — an owner id containing the separator could produce the same input as a different
 *  owner with different words, and one member's forget would then block another's `remember`. Nobody who reads a `forget_ledger` row learns the forgotten words from it: at
 *  most, someone holding the database can test one specific guess against this hash. Matching is
 *  exact after normalisation — a paraphrase produces a different key and is not recognised.
 *  `normalised` must already be normalised by the caller (see `normaliseFor`); this function does
 *  no normalisation of its own, so the same key can be produced for wording or for a path. */
export function forgetKey(owner: string, kind: ForgottenKind, normalised: string): string {
  const field = (v: string): string => `${v.length}:${v}`;
  return createHash("sha256").update(field(owner) + field(kind) + field(normalised)).digest("hex");
}

function rowToEntry(row: {
  id: string | number;
  owner: string;
  kind: string;
  match_hash: string;
  forgotten_at: Date;
  reason: string;
}): ForgetLedgerEntry {
  return {
    id: Number(row.id),
    owner: row.owner,
    kind: row.kind as ForgottenKind,
    matchHash: row.match_hash,
    forgottenAt: row.forgotten_at,
    reason: row.reason as ForgetReason,
  };
}

/** Records that `words` (or, for `kind: "note"`, the path in `words`) was forgotten. Only the
 *  hash of the normalised form is stored — `words` itself never reaches this table. Idempotent:
 *  forgetting the same thing twice returns the SAME id and only refreshes `forgotten_at`. */
export async function recordForgotten(
  db: Queryable,
  e: { owner: string; kind: ForgottenKind; words: string; reason: ForgetReason },
): Promise<number> {
  assertCanonicalOwner(e.owner);
  const hash = forgetKey(e.owner, e.kind, normaliseFor(e.kind, e.words));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO forget_ledger (owner, kind, match_hash, reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner, kind, match_hash)
       DO UPDATE SET forgotten_at = forget_ledger.forgotten_at
     RETURNING id`,
    [e.owner, e.kind, hash, e.reason],
  );
  return Number(rows[0]!.id);
}

/** Was this wording forgotten for this owner? Keyed on the NORMALISED words' hash, never on the
 *  id: a re-import creates a new row with a new id and the same words, and the id would miss it. */
export async function wasForgotten(
  db: Queryable,
  q: { owner: string; kind: ForgottenKind; words: string },
): Promise<ForgetLedgerEntry | null> {
  assertCanonicalOwner(q.owner);
  const hash = forgetKey(q.owner, q.kind, normaliseFor(q.kind, q.words));
  const { rows } = await db.query(
    `SELECT id, owner, kind, match_hash, forgotten_at, reason
       FROM forget_ledger
      WHERE owner = $1 AND kind = $2 AND match_hash = $3`,
    [q.owner, q.kind, hash],
  );
  return rows.length > 0 ? rowToEntry(rows[0]) : null;
}

/** Was this exact path forgotten? For the note kind, where the path IS the identity. */
export async function wasPathForgotten(
  db: Queryable,
  q: { owner: string; path: string },
): Promise<ForgetLedgerEntry | null> {
  return wasForgotten(db, { owner: q.owner, kind: "note", words: q.path });
}

/** Undoes `recordForgotten` for an exact match. The one caller today is `remember` (W5B-s3): when
 *  the owner has been told a fact was forgotten and says to keep it anyway, the ledger row for
 *  those exact words is removed in the SAME transaction that writes the fact back — so the
 *  ledger can never go on contradicting a standing fact that now says the opposite. A caller
 *  inside a transaction passes that transaction's own client (mirrors `ForgetLedgerWriter`'s
 *  shape). Idempotent: no matching row is not an error. */
export async function removeForgotten(
  db: Queryable,
  e: { owner: string; kind: ForgottenKind; words: string },
): Promise<void> {
  assertCanonicalOwner(e.owner);
  const hash = forgetKey(e.owner, e.kind, normaliseFor(e.kind, e.words));
  await db.query(`DELETE FROM forget_ledger WHERE owner = $1 AND kind = $2 AND match_hash = $3`, [
    e.owner,
    e.kind,
    hash,
  ]);
}

export function isMissingLedgerTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01";
}
