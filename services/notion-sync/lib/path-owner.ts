// Who owns a vault path — for the forgotten-file guard alone (W5I-s9).
//
// THE BUG THIS REPLACES: `resolveInstallationOwner` (formerly here in cli.ts) asked
// "how many rows does `users` hold?" ONCE PER TICK, and answered `null` — guard off,
// for EVERYONE — the moment a second member existed. The guard is per-file; the
// question should have been per-file too. This module asks it per file instead.
//
// WHAT THE VAULT ACTUALLY LOOKS LIKE TODAY, checked rather than assumed: ADR-0017
// rule 1 plans `private/<member>/` and `shared/`, explicitly "one folder per member
// **once a second member exists**" — that layout is wave-5 track 5C's work and does
// NOT exist yet. Today a note's person marker is its FRONTMATTER: `scope:` (`private`
// | `org` | `participants`) and `owner:`, the same two keys
// `packages/agent-kit/src/notes-store.ts`'s `noteScope` reads. notion-sync cannot
// import `@lares/agent-kit` (it ships in the sync-jobs image, which has no kit, and
// the kit is not on this package's dependency list either way), so `readFrontmatter`
// below is a small, local re-implementation of just those two keys — not `noteScope`
// itself. The rule below works on today's layout AND on 5C's, so this module does not
// need redoing once that lands.
//
// FOUR RULES, tried in order, first match wins:
//   1. The note's own frontmatter `owner:`, resolved through the identity register
//      (`users` / `user_aliases`, `services/box/sql/014_identity.sql`) so an alias
//      still works. LIVE TODAY.
//   2. A leading `private/<member>/` path segment naming a `users.id` directly
//      (ADR-0017 rule 1's per-member vault area). Matches nothing until track 5C
//      creates that layout — harmless before then.
//   3. Exactly one row in `users` — the only member there is. LIVE TODAY, but only
//      once the shared-area check below has ruled the path out.
//   4. Otherwise: unknown owner.
//
// A SHARED PATH IS CHECKED BEFORE RULE 3, not folded into it: `shared/`, `atlas/` and
// an explicit `scope: org` mark a path as belonging to nobody in particular, even on a
// single-member installation. Without this, a single-member box would attribute every
// shared/org note to its sole member — and the moment a second member's own edit
// touches that same shared note, the guard would read it as "the sole member's own
// file", which is exactly the kind of misattribution this slice exists to prevent.
//
// FAILS OPEN, ALWAYS. `{ owner: null }` means the guard does not fire and the sync
// proceeds — a sync that stops because ownership is unclear would be a worse product
// than one that occasionally re-creates a file, and ADR-0017's guard is a
// memory-hygiene promise, not access control. NEVER THROWS: every failure — a missing
// table, a closed pool, a malformed row — is caught and answered `register-unreadable`.
//
// NEVER GUESSES ACROSS MEMBERS. This function answers "whose ledger does THIS path
// belong to", never "who is the installation's owner" — the caller (cli.ts) checks
// only the resolved owner's own ledger, so one member's forget can never suppress
// another member's file.
import type { Queryable } from "@lares/agent-box";

export type PathOwner =
  | { owner: string; how: "frontmatter-owner" | "member-area" | "sole-member" }
  | { owner: null; why: "shared-area" | "several-members-no-marker" | "register-unreadable" };

/** The two frontmatter keys this guard reads (`noteScope`'s grammar, reimplemented
 *  locally — see this file's header for why). Absent or malformed frontmatter reads
 *  as "no scope, no owner", never an error. */
function readFrontmatter(raw: string): { scope?: string; owner?: string } {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end === -1) return {};
  const head = text.slice(4, end);
  const get = (key: string): string | undefined => {
    const m = head.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m?.[1]?.trim();
  };
  return { scope: get("scope"), owner: get("owner") };
}

/** `shared/`, `atlas/` (a leading path segment) or an explicit `scope: org` — a note
 *  that is nobody's in particular, checked before the sole-member fallback so a
 *  single-member installation never attributes a shared note to its one member. */
function isSharedArea(vaultPath: string, scope: string | undefined): boolean {
  if (scope === "org") return true;
  const first = vaultPath.split("/")[0];
  return first === "shared" || first === "atlas";
}

/** Resolves one spelling (a canonical id, or any `user_aliases` alias) to the
 *  register's canonical id, or `null` if the register does not recognise it. A tiny
 *  local resolve, not `services/box/lib/person-identity.ts`'s `resolvePerson` — that
 *  throws on an unknown spelling, and this guard's whole contract is to fail open,
 *  never to throw. */
async function resolveOwnerSpelling(db: Queryable, spelling: string): Promise<string | null> {
  const direct = await db.query<{ id: string }>("SELECT id FROM users WHERE id = $1", [spelling]);
  if (direct.rows.length > 0) return direct.rows[0]!.id;
  const alias = await db.query<{ user_id: string }>(
    "SELECT user_id FROM user_aliases WHERE alias = $1", [spelling],
  );
  return alias.rows.length > 0 ? alias.rows[0]!.user_id : null;
}

/** Who owns the note at `vaultPath`, for the forgotten-file guard alone.
 *
 *  FAILS OPEN, always: `{ owner: null }` means the guard does not fire and the sync
 *  proceeds. A sync that stops because ownership is unclear would be a worse product
 *  than one that occasionally re-creates a file — and ADR-0017's guard is a
 *  memory-hygiene promise, not an access control. Never throws. */
export async function ownerOfPath(db: Queryable, vaultPath: string, frontmatter: string): Promise<PathOwner> {
  try {
    const { scope, owner: declaredOwner } = readFrontmatter(frontmatter);

    // Rule 1 — the note's own frontmatter owner, resolved through the register.
    if (declaredOwner !== undefined) {
      const resolved = await resolveOwnerSpelling(db, declaredOwner);
      if (resolved !== null) return { owner: resolved, how: "frontmatter-owner" };
    }

    // Rule 2 — a leading `private/<member>/` segment naming a `users.id` directly
    // (ADR-0017 rule 1, arrives with wave-5 track 5C; matches nothing before then).
    const segments = vaultPath.split("/");
    if (segments[0] === "private" && segments.length > 1) {
      const { rows } = await db.query<{ id: string }>("SELECT id FROM users WHERE id = $1", [segments[1]]);
      if (rows.length > 0) return { owner: rows[0]!.id, how: "member-area" };
    }

    // A shared path belongs to nobody in particular, checked BEFORE the sole-member
    // fallback (see this file's header).
    if (isSharedArea(vaultPath, scope)) return { owner: null, why: "shared-area" };

    // Rule 3 — exactly one member in the register is the only member there is.
    const { rows: allUsers } = await db.query<{ id: string }>("SELECT id FROM users");
    if (allUsers.length === 1) return { owner: allUsers[0]!.id, how: "sole-member" };

    // Rule 4 — several members, and nothing above resolved one: unknown.
    return { owner: null, why: "several-members-no-marker" };
  } catch {
    return { owner: null, why: "register-unreadable" };
  }
}
