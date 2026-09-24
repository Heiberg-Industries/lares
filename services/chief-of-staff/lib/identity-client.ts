/**
 * Read-only identity-registry lookup for `agent/tools/identity_my_addresses.ts`.
 *
 * Ported (simplified) from `services/agent-runtime/lib/identity.ts`'s `listAliases`. That
 * module wraps the same query in a process-wide cache plus a 2s timeout and a
 * failure-degrade window, because it is called on nearly every turn by a hand built
 * eagerly at boot — a hang there is a boot hang, and its documented fallback is to pass
 * unknown aliases through rather than throw. None of that applies here: this tool is
 * called on demand, not eagerly, so a genuine registry failure throws
 * `IdentityUnavailableError` instead of silently degrading to `[]` (ORB-51 — an
 * unreachable registry must never look identical to "this user really has no email
 * aliases on file", which the old module's degrade-to-[] behavior would otherwise cause).
 *
 * Configured ownership is read at operation time through `configuredOwnerId()`.
 * No owner value is captured during imports or builds. `canonicalUserId(db)` reads
 * the register directly when the caller has a database connection.
 */
import type { Pool } from "pg";
import { openRepair, resolveRepair } from "@lares/agent-kit/repairs";
import { ownerId } from "./principals.js";

export class IdentityUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "IdentityUnavailableError";
  }
}

/**
 * A caller that assumed exactly one owner (most of this codebase, today — owner decision D1)
 * hit a register holding more than one `users` row. Thrown by `canonicalUserId`, never
 * swallowed into a guessed answer — see that function's docstring.
 */
export class SeveralPeopleOnThisInstallation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeveralPeopleOnThisInstallation";
  }
}

/**
 * The register's single canonical id, read from `users` — the one path that actually LOOKS,
 * rather than repeating a value baked in at compile time or taken from env (`CANONICAL_USER_ID`
 * / `ownerIdFromEnvOrConstant` below). Prefer this wherever a pool is already at hand.
 *
 * FAILS CLOSED, on purpose: a caller reaching for "the owner" here is about to read or write
 * data keyed by that id, so guessing is worse than refusing.
 *  - zero rows (register unseeded, or sql/014_identity.sql not yet applied) and any query
 *    failure both throw `IdentityUnavailableError` — the register could not answer.
 *  - more than one row (a second member has joined — not supported by any caller yet, owner
 *    decision D1) throws `SeveralPeopleOnThisInstallation` rather than silently picking the
 *    first row.
 */
export async function canonicalUserId(db: Pool): Promise<string> {
  let rows: { id: string }[];
  try {
    ({ rows } = await db.query<{ id: string }>(`SELECT id FROM users`));
  } catch (err) {
    throw new IdentityUnavailableError("identity registry query failed (canonical user id)", err);
  }
  if (rows.length === 0) {
    throw new IdentityUnavailableError(
      'identity registry has no rows in "users" — has sql/014_identity.sql been applied?',
    );
  }
  if (rows.length > 1) {
    throw new SeveralPeopleOnThisInstallation(
      `identity registry has ${rows.length} members; a caller that assumed one owner must say which one`,
    );
  }
  return rows[0]!.id;
}

/** Read configured ownership when the operation runs, never during module loading. */
export function configuredOwnerId(env: NodeJS.ProcessEnv = process.env): string {
  return ownerId(env);
}

/** Compatibility name for callers; no fallback or captured import-time value remains. */
export function ownerIdFromEnvOrConstant(env: NodeJS.ProcessEnv = process.env): string {
  return ownerId(env);
}

// ── W5I-s5b: the configured key and the register are checked against each other ────────────
//
// W5I-s5 gave this service one owner key in CODE (`ownerId()` / `CANONICAL_USER_ID` /
// `ownerIdFromEnvOrConstant`) — but every owner-keyed row this agent WRITES still goes under
// that fail-soft key, while notion-sync's forgotten-file guard, the person resolver
// (`services/box/lib/person-identity.ts`) and `canonicalUserId` above all identify the owner
// from the identity REGISTER (`users`). Nothing compared the two. On an installation whose
// register id is not the one literal fallback this service still carries — i.e. every
// open-source installation until that literal is gone — the agent would file memory under one
// name while forget/export/erase look under another, and it would do so silently: a forget
// stops protecting, an erase reports success and leaves the rows. This function is the loud
// version of that failure. It never throws (a caller wires it in fire-and-forget, once per
// process — see `agent/instructions/standing-facts.ts`) and it never repairs anything itself:
// switching keys at runtime would strand every row already written under the old one.
export type OwnerKeyAgreement = "agree" | "disagree" | "several-members" | "register-unreadable";

const OWNER_KEY_REPAIR_KIND = "identity";
const OWNER_KEY_REPAIR_REF = "owner-key";

/** Logged and opened at most once per process — see `checkOwnerKeyAgreement`. Test-only reset. */
let loggedOwnerKeyDisagreement = false;
let ownerKeyRepairMayBeOpen = false;
export function resetOwnerKeyCheckForTests(): void {
  loggedOwnerKeyDisagreement = false;
  ownerKeyRepairMayBeOpen = false;
}

/**
 * Compares the configured owner key (`ownerIdFromEnvOrConstant`) against the identity
 * register's own id and reports which of four shapes it found. Best-effort, like
 * `@lares/agent-kit/repairs` itself: a query failure is a verdict (`register-unreadable`),
 * never a throw.
 *
 *  - `agree` — the common case, the real installation's shape today. Resolves any
 *    previously-opened disagreement repair, but only touches the database when this process
 *    actually opened one (`ownerKeyRepairMayBeOpen`) — an agreeing installation must not pay a
 *    write on every call.
 *  - `disagree` — the defect this slice reports: exactly one member, and its id is not the
 *    configured key. Logs ONE `console.error` line for the whole process (ids only, no
 *    content — the repo's convention throughout `lib/`, e.g. `email-triage.ts`,
 *    `obligation-pipeline.ts`) and opens a repair with a fixed sentence naming neither content
 *    nor a person by name.
 *  - `several-members` — the known, written-down multi-user gap (`person-identity.ts` / W5I-s1:
 *    "not supported by any caller yet, owner decision D1"). Not this slice's defect: opens and
 *    logs nothing.
 *  - `register-unreadable` — zero rows, or the query itself failed (register not yet applied,
 *    box unreachable). Already reported on every path that actually depends on the register
 *    (`canonicalUserId` throws `IdentityUnavailableError` there); a second, independent report
 *    here would just be noise. Opens and logs nothing.
 */
export async function checkOwnerKeyAgreement(
  db: Pool,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OwnerKeyAgreement> {
  let rows: { id: string }[];
  try {
    ({ rows } = await db.query<{ id: string }>(`SELECT id FROM users`));
  } catch {
    return "register-unreadable";
  }
  if (rows.length === 0) return "register-unreadable";
  if (rows.length > 1) return "several-members";

  const registerId = rows[0]!.id;
  const configured = ownerIdFromEnvOrConstant(env);

  if (registerId === configured) {
    if (ownerKeyRepairMayBeOpen) {
      ownerKeyRepairMayBeOpen = false;
      await resolveRepair(db, OWNER_KEY_REPAIR_KIND, OWNER_KEY_REPAIR_REF);
    }
    return "agree";
  }

  if (!loggedOwnerKeyDisagreement) {
    loggedOwnerKeyDisagreement = true;
    console.error(
      `identity-client: configured owner id "${configured}" disagrees with the identity register's id "${registerId}" — memory is being filed under a name that forget, export and erase will not look under`,
    );
  }
  await openRepair(db, {
    kind: OWNER_KEY_REPAIR_KIND,
    ref: OWNER_KEY_REPAIR_REF,
    severity: "error",
    what:
      "The owner id this agent is configured with and the one in the identity register differ, so memory is being filed under a name that forget, export and erase will not look under.",
    howToFix: "Set AGENT_OWNER_USER_ID to the register's id, or correct the register, then restart.",
  });
  ownerKeyRepairMayBeOpen = true;
  return "disagree";
}

/**
 * Every alias `userId` has on `system` (e.g. `"email"`), oldest first. An empty array is a
 * real, honest answer — "the registry has nothing on file for this system" — never
 * conflated with the registry being unreachable, which throws instead.
 */
/**
 * The org's own email domains (`orgs.domains`, sql/032) for the org `userId` belongs to —
 * colleagues' mailboxes and the org's own product senders, which CRM routing must never read
 * as a prospect signal. Lower-cased. An empty array is honest ("this org lists none"); a
 * registry failure throws, as `listAliases` does — an outage must not read as "no exclusions".
 */
/** The member's display name from the registry (`users.display_name`), or null. */
export async function getDisplayName(db: Pool, userId: string): Promise<string | null> {
  try {
    const { rows } = await db.query<{ display_name: string | null }>(`SELECT display_name FROM users WHERE id = $1`, [userId]);
    const n = rows[0]?.display_name?.trim();
    return n ? n : null;
  } catch (err) {
    throw new IdentityUnavailableError("identity registry query failed (display name)", err);
  }
}

export async function listOrgDomains(db: Pool, userId: string): Promise<string[]> {
  try {
    const { rows } = await db.query<{ domains: string[] | null }>(
      `SELECT o.domains FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = $1`,
      [userId],
    );
    return (rows[0]?.domains ?? []).map((d) => String(d).trim().toLowerCase()).filter((d) => d !== "");
  } catch (err) {
    throw new IdentityUnavailableError("identity registry query failed (org domains)", err);
  }
}

export async function listAliases(db: Pool, userId: string, system: string): Promise<string[]> {
  try {
    const { rows } = await db.query(
      `SELECT alias FROM user_aliases WHERE user_id = $1 AND system = $2 ORDER BY created_at, alias`,
      [userId, system],
    );
    return rows.map((r) => String(r.alias)).filter((a) => a !== "");
  } catch (err) {
    throw new IdentityUnavailableError("identity registry query failed", err);
  }
}
