/**
 * The store path a proposed note is written to, derived from its title.
 *
 * Pure string functions, no imports, no I/O — deliberately its own module rather than a corner
 * of `vault-git.ts`, so that `approval-summary.ts` (which must never throw, and which is
 * evaluated at server startup) can name the path a write is about to touch without pulling
 * `node:child_process` and the lockfile machinery into its module graph.
 *
 * WHY THIS IS SHARED RATHER THAN LOCAL (ORB-135 fix round 1). The write tools do not accept a
 * path from the model — they derive one — which is what makes a traversal argument
 * *unrepresentable* rather than merely refused. The approval card must therefore show the
 * DERIVED path, because that is the thing that says whether an existing note is about to be
 * overwritten. Two copies of the derivation is exactly the drift that ends with a card naming
 * one file while the tool writes another, so there is one copy and both sides import it.
 *
 * Ported verbatim from `services/agent-runtime/lib/adapters/hands/atlas.ts:21-23` (identical to
 * `hands/brain.ts`'s and to the kit's own `extension/lib/note-write-tools.ts`'s private copy —
 * that third copy is left alone here only because this round is additive; folding it in is a
 * one-line follow-up).
 */

/** A title reduced to a filename-safe slug. Empty or fully-punctuation titles become "note",
 *  so the result is never an empty filename. */
export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "note"
  );
}

/**
 * The `_inbox/<slug>.md` convention both Brain and Atlas writes follow — a queue of proposed
 * notes that a human (or the filing pass) later moves somewhere permanent.
 *
 * Containment is a PROPERTY OF THIS FUNCTION, not of a downstream check: `slug()` maps every
 * character outside `[a-z0-9]` to a hyphen, so `..`, `/`, `\` and a leading `.` cannot survive
 * it. A model asking to write `../../etc/passwd` or `.git/config` gets
 * `_inbox/etc-passwd.md` / `_inbox/git-config.md`. That is stronger than refusing a bad path,
 * because there is no path to refuse.
 */
export function inboxNotePath(title: string): string {
  return `_inbox/${slug(title)}.md`;
}
