// The ONE definition of "may this service CREATE a vault file at this path"
// (Phase 4, T3b). A create is the first write in this service whose target path is
// derived from Notion CONTENT — a Meetings row's title (T4), a Notion-born page's
// title and Folder (T6) — rather than from a file the push pass already found on
// disk. Everything else this service writes, it first read; a create writes
// somewhere nothing has ever been.
//
// So the path itself is untrusted input, and this module is the SHAPE half of the
// answer: everything decidable from the string alone, with no filesystem. The other
// half — "does something already live there?" and "does this path reach outside the
// vault through a symlink?" — needs real inodes and lives in
// adapters/vault-writer.ts, at the write, under the note lock.
//
// BOTH halves run at APPLY time, not only when the proposal was made. A proposal
// sits in the queue between being proposed and being approved, and Bendik may take
// days. Checking only at propose time is a time-of-check/time-of-use hole: a human
// creates a file at that exact path in the window, and the approval quietly
// overwrites hand-written work. A propose-time check is a courtesy (refuse early,
// never queue something that cannot land); the apply-time one is the guarantee.
//
// Pure — no node:fs, no config, no vendor imports — so the engine can call it
// without giving up being a pure engine, and so the same function answers on both
// sides of the queue.

/**
 * Vault folders this service owns and must never create a file in, matched by path
 * SEGMENT anywhere in the path — `_archive/x.md` and `zero7/_archive/x.md` are both
 * refused, `_archived-notes/x.md` is not.
 *
 * - `_archive` — retired files (spec §7). Creating one there is creating something
 *   already declared dead, where nothing will ever look for it.
 * - `_meta` — vault machinery, not content.
 */
export const MACHINE_OWNED_DIRS = ["_archive", "_meta"] as const;

/**
 * Machine-owned only as the vault's own TOP-LEVEL folder.
 *
 * `wiki` is the one-way mirror: its files are a projection of the vault dir the wiki
 * pass owns, so a file created there fights that projection on every tick. It is
 * anchored at the vault root — config.ts validates `wikiDir` as a bare
 * vault-relative folder and refuses a `deskDirs` entry that overlaps it — so
 * `orakel/wiki/notes.md` is a human's folder that happens to be called wiki, not the
 * mirror, and is allowed.
 *
 * `wiki` is the deployed `wikiDir` and the parser's default (config.ts
 * DEFAULT_WIKI_DIR). If that config key is ever changed this constant moves with it:
 * a mismatch would let a create land inside the mirror, which is the one failure
 * this entry exists to prevent.
 */
export const MACHINE_OWNED_ROOT_DIRS = ["wiki"] as const;

/**
 * Byte budgets, not character budgets. A create's name comes from a Notion title,
 * and these are Norwegian titles: the letters ae/oe/aa cost two bytes each in
 * UTF-8, so a 200-character title can be a 260-byte filename. Linux caps one path
 * component at 255 BYTES (NAME_MAX) and a whole path at 4096 (PATH_MAX); ext4 gives
 * no warning, it gives ENAMETOOLONG at the write.
 *
 * Caught here rather than left to the filesystem because a create that fails at the
 * adapter has no doc row to record the error against - `recordDocError` is an UPDATE
 * keyed on vault_path, and a create has no row - so it would log one line and retry,
 * hourly, forever, invisible to the console and to the stale-proposal escalation
 * alike. A refusal is visible, final, and names the part that was too long.
 *
 * Deliberately well under the true limits: the vault path is joined onto the vault
 * root, and `_archive/` is prepended if the file is ever retired, so a path that
 * only just fits today breaks on a later, ordinary operation.
 */
export const MAX_SEGMENT_BYTES = 200;
export const MAX_PATH_BYTES = 1024;

const UTF8 = new TextEncoder();
function byteLength(text: string): number {
  return UTF8.encode(text).length;
}

/**
 * The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes, never splitting
 * a character in half.
 *
 * Exported alongside the budgets because a proposer that DERIVES a filename from a
 * Notion title (T4's slug, T6's) has to fit it before asking, and the alternative —
 * each proposer carrying its own idea of the limit — is how the two ends of one rule
 * drift apart. `refuseVaultTarget` stays the arbiter; this is what lets a caller
 * arrive with something it will accept.
 *
 * Iterates code POINTS (`for…of`), not UTF-16 units, so a surrogate pair — an emoji
 * in a meeting title — is kept or dropped whole rather than truncated into a lone
 * half that no filesystem and no editor can render.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = byteLength(ch);
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

/**
 * One vault path (or one filename) in the form BOTH filesystems the vault lives on
 * agree about (Phase 4, T6 review rounds 1–2).
 *
 * Every other rule in this module is a question about a string that a pure function
 * can settle. "Is something already there?" is the one that is asked of the KERNEL —
 * and the kernel answers for the filesystem it is running on. The box is Linux/ext4
 * and case-SENSITIVE; the machine Bendik actually reads the vault on is APFS and is
 * not. So a hand-written `zero7/Notater.md` genuinely does not exist at
 * `zero7/notater.md` on the box: the `lstat` guard's answer is correct, the `O_EXCL`
 * write succeeds, and the commit the box pushes carries BOTH files. One `git pull`
 * later they are one path, his note is shadowed in the working tree and staged as
 * modified-to-Notion's-content, and an Obsidian Git auto-commit overwrites it in
 * history. The guard was never violated; it was routed around by the filesystem.
 *
 * So the comparison has to be made where a pure function can make it, in a form
 * neither filesystem can disagree with. NFC **before** lowercase, and the order is
 * load-bearing: case-folding a decomposed sequence leaves the two spellings
 * different, and `å` typed on a Mac arrives decomposed while the same letter typed on
 * Linux arrives composed.
 *
 * Nothing is ever WRITTEN in this form — it exists only to compare. Lives here, with
 * the other create-target rules, because it has two callers that must never disagree:
 * the propose side (notion-born-sync.ts, an early readable refusal) and the apply
 * side (apply-sync.ts guard 3b, the authoritative one, immediately before the write).
 */
export function collisionKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * THE predicate — one question, asked identically on both sides of the queue
 * (T6 review round 3): **is any of these existing vault paths the SAME FILE as
 * `target` on a case-/normalisation-insensitive filesystem?** Returns the colliding
 * path (so a refusal can name it) or null.
 *
 * A shared `collisionKey` was not enough, and that is the mistake this replaces.
 * Round 2 shared the key and then built two different predicates on it: the propose
 * side compared WHOLE PATHS against the whole vault, the apply side compared
 * BASENAMES inside the literally-spelled parent. Those disagree the moment the
 * variant is in an ancestor DIRECTORY — `zero7/Prosjekt/` versus `zero7/prosjekt/` —
 * because the apply side's `readdir` of the literal spelling ENOENTs, returns
 * nothing, and the create lands. Two directories and two files on the box; one of
 * each on the Mac; the hand-written note shadowed on the next pull. Byte for byte
 * the destruction the guard was added to prevent.
 *
 * So the comparison is over the WHOLE PATH on both sides, and it is this function.
 * What differs between the two callers is only which existing paths they can afford
 * to offer it: the propose side hands it the whole vault listing (one walk per tick,
 * many candidates at once), the apply side hands it what the adapter found by
 * resolving the target's ancestry case-insensitively (a handful of readdirs, one
 * approved create). Same question, same answer, different amounts of I/O to reach it.
 *
 * `path !== target` because the EXACT path is guard 3's business, and calling it a
 * capitalisation collision would be a false sentence about a true refusal.
 */
export function findCollidingPath(target: string, existing: Iterable<string>): string | null {
  const key = collisionKey(target);
  for (const path of existing) {
    if (path !== target && collisionKey(path) === key) return path;
  }
  return null;
}

/** ASCII control characters — NUL, newline, tab, ESC and friends. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Is this vault-relative path one a create may target? Returns `null` when it is, or
 * a short human-readable REASON when it is not — phrased to be shown to Bendik in a
 * DM or on the console card, because a refused create he cannot explain is
 * indistinguishable from a broken sync.
 *
 * Each refusal, and why it is here rather than left to the filesystem:
 *
 * - **Escapes.** An absolute path, or any `..` / `.` / empty segment. The writer's
 *   `resolve()` already catches the ones that actually leave the vault, but
 *   `zero7/../orakel/x.md` stays inside and still means something other than what it
 *   says — and a store row keyed on a path that is not its own canonical form joins
 *   to nothing, forever, silently.
 * - **Control characters.** A create's path comes from a Notion title, and a title
 *   can hold a newline. A newline in a pathspec breaks `git add -- <path>` and every
 *   log line that ever prints the path.
 * - **Dot segments.** `.git`, `.obsidian`, `.locks`, `.trash`, `.claude` — none of it
 *   is vault content, and a write into `.git/` can change what code runs. The vault
 *   walkers already skip dotfiles wholesale (adapters/vault-files.ts); this is the
 *   same rule stated on the write side, where it is a guard rather than a filter.
 * - **Whitespace-padded segments,** checked per SEGMENT rather than once over the
 *   whole path: `zero7 /note.md` trims clean as a string and still makes a second,
 *   visually identical folder beside the real one.
 * - **Machine-owned areas.** See the two constants above.
 * - **Too long.** See MAX_SEGMENT_BYTES — a create that fails at the write has no
 *   row to record the failure against, so an over-long name must die here.
 * - **Not markdown.** This service syncs notes. The `.md` requirement is what stops a
 *   Notion title from producing a `.sh`, a `.yml` or a `Makefile` in the vault.
 */
export function refuseVaultTarget(vaultPath: string): string | null {
  if (vaultPath.trim() === "") return "the target path is empty";
  if (CONTROL_CHARS.test(vaultPath)) {
    return "the target path contains a control character (a newline in a Notion title?)";
  }
  if (vaultPath.startsWith("/")) {
    return `the target path is absolute, not vault-relative: ${vaultPath}`;
  }
  if (byteLength(vaultPath) > MAX_PATH_BYTES) {
    return `the target path is too long (${byteLength(vaultPath)} bytes; the limit is ${MAX_PATH_BYTES})`;
  }

  // The machine-owned names are matched case-INSENSITIVELY. On a case-insensitive
  // filesystem (an APFS Mac, where the vault is also cloned) `WIKI/note.md` is the
  // mirror; on the Linux box it is a different folder. Refusing both costs nothing
  // and means the guard does not depend on which machine it happens to run on.
  const segments = vaultPath.split("/");
  for (const segment of segments) {
    if (segment === "") return `the target path has an empty path segment: ${vaultPath}`;
    if (segment === "." || segment === "..") {
      return `the target path walks the tree with "${segment}": ${vaultPath}`;
    }
    if (segment.startsWith(".")) {
      return `the target path enters a dot-directory or dotfile ("${segment}"), which is never vault content`;
    }
    // Per SEGMENT, not once over the whole path. `"zero7 /note.md"` and
    // `"zero7/ note.md"` both survive a trim of the whole string, and both create a
    // SECOND, visually identical folder beside the real one - the malformation
    // config.ts calls the one an operator cannot see. A Notion `Folder` property
    // with a trailing space is the ordinary way to get here.
    if (segment !== segment.trim()) {
      return `a path segment is padded with whitespace: "${segment}"`;
    }
    if (byteLength(segment) > MAX_SEGMENT_BYTES) {
      return `a path segment is too long (${byteLength(segment)} bytes; the limit is ${MAX_SEGMENT_BYTES}): "${segment.slice(0, 40)}…"`;
    }
    if ((MACHINE_OWNED_DIRS as readonly string[]).includes(segment.toLowerCase())) {
      return `the target path is inside "${segment}/", which this service owns and never creates files in`;
    }
  }
  if ((MACHINE_OWNED_ROOT_DIRS as readonly string[]).includes(segments[0].toLowerCase())) {
    return `the target path is inside "${segments[0]}/", the one-way mirror — a file created there fights the projection every tick`;
  }

  if (!/\.md$/i.test(vaultPath)) {
    return `the target path is not a markdown file: ${vaultPath}`;
  }

  // The last of the three padding cases, and the one the segment check above cannot
  // see: `note .md` has no leading or trailing whitespace ANYWHERE — the space sits
  // between the stem and the extension. It is what a title with a trailing space
  // produces once a slug is suffixed with ".md", and it reads as `note.md` at a
  // glance while being a different file. Interior spaces are otherwise ordinary in
  // both folder and file names, so only the stem's own edges count.
  const stem = segments[segments.length - 1].replace(/\.md$/i, "");
  if (stem !== stem.trim()) {
    return `the filename's stem is padded with whitespace: "${stem}.md"`;
  }
  return null;
}
