// Filesystem access for the wiki pass. Under adapters/ because it is an I/O
// boundary like the other two: the pure engine (wiki-sync.ts) receives these
// functions injected and never touches the filesystem itself.
import { readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { isUnderDir } from "../desk-scope.js";
import { collisionKey } from "../vault-target.js";

export interface VaultFilesOptions {
  /** Absolute path of the vault mount (config `vaultPath`, `/srv/brain` on the box). */
  vaultPath: string;
  /** Vault-relative wiki directory (config `wikiDir`). */
  wikiDir: string;
  /**
   * Sub-paths of `wikiDir`, DIR-RELATIVE, that this listing must not descend into
   * — a desk entry's `exclude` list, straight from config (Phase 4). Absent ⇒
   * nothing is pruned, which is the wiki mirror pass's case and the behaviour of
   * every caller before this option existed.
   *
   * Pruned during the walk rather than filtered out of the result: an excluded
   * sub-tree is then never even read from disk, so no later change to this
   * adapter can accidentally open a file the sync has been told is not its
   * business — and a folder with a thousand transcripts costs one readdir, not a
   * thousand entries built and thrown away.
   */
  exclude?: string[];
}

/**
 * Lists and reads the wiki's markdown files.
 *
 * Conventions the engine relies on:
 * - Paths are wikiDir-relative and "/"-joined (built by hand, not by path.join,
 *   so they match the store's vault_path keys on any platform).
 * - Dotfiles and dot-directories are skipped wholesale — `.obsidian/`, `.locks/`,
 *   editor droppings — none of them is content.
 * - Only `*.md` files count (case-insensitive, matching the resolver's stem
 *   handling in wiki-sync.ts); symlinks are ignored rather than followed, so a
 *   link cannot smuggle files from outside the vault into the pass.
 * - A missing wiki directory THROWS (ENOENT) instead of returning an empty
 *   listing: on a cold store the engine's empty-listing guard has no rows to
 *   defend, and a missing `/srv/brain` mount would otherwise be a silent no-op
 *   every tick forever.
 * - `exclude` entries are skipped, by path segment (see VaultFilesOptions).
 */
export function makeVaultFiles(opts: VaultFilesOptions) {
  const rootDir = join(opts.vaultPath, opts.wikiDir);
  const exclude = opts.exclude ?? [];

  async function walk(dir: string, prefix: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      // Tested before the directory/file split so one rule covers both: a
      // directory match prunes the whole branch, and a file whose own path is
      // named by an entry is skipped too — which keeps this listing agreeing
      // exactly with the vault-path predicate the row-side boundaries use
      // (desk-scope.ts). Two rules here would be two chances to disagree.
      if (exclude.some((sub) => isUnderDir(rel, sub))) continue;
      if (entry.isDirectory()) found.push(...await walk(join(dir, entry.name), rel));
      else if (entry.isFile() && /\.md$/i.test(entry.name)) found.push(rel);
    }
    return found;
  }

  async function listWikiFiles(): Promise<string[]> {
    return walk(rootDir, "");
  }

  async function readWikiFile(relPath: string): Promise<string> {
    return readFile(join(rootDir, relPath), "utf8");
  }

  return { listWikiFiles, readWikiFile };
}

export interface VaultWalkOptions {
  /** Absolute path of the vault mount (config `vaultPath`, or the fidelity CLI's
   *  `--vault` override for an off-box run against a bare vault checkout). */
  vaultPath: string;
}

/**
 * Mirrors agent-box's `lib/brain-source.ts` walkMd exclusion-dir SHAPE (skip by
 * directory name, not a blanket dotfile skip), widened by two Phase 3 additions
 * (fidelity gate, spec §18.3): `.claude` (this repo's own kit, never vault
 * content) and `_archive` (spec §7 — archived files are retired, not eligible for
 * the gate). Deliberately NOT `makeVaultFiles`'s own "skip every dotfile"
 * behaviour: that adapter is scoped to one wikiDir and can afford to be blunt;
 * this one walks the whole vault root and only excludes what it's told to.
 */
const FIDELITY_EXCLUDED_DIRS = new Set([
  ".git", ".locks", ".trash", ".obsidian", ".claude", "node_modules", "_archive",
]);

/**
 * How many case-variant spellings of ONE ancestor directory `listCollisionCandidates`
 * will follow before refusing. Normally 1; a case-sensitive box can legitimately hold
 * two or three. Dozens means something is wrong that a human has to look at, and
 * refusing is safer than truncating a guard's input.
 */
const MAX_COLLIDING_DIRS = 64;

/**
 * Lists and reads every markdown file under the WHOLE vault root — the fidelity
 * gate's file universe, recounted at every run (spec §18.3: never cached). Unlike
 * `makeVaultFiles`, not scoped to a single wikiDir: the gate has to see desk
 * folders too, once they exist (T7), without this adapter changing.
 */
export function makeVaultWalk(opts: VaultWalkOptions) {
  const root = opts.vaultPath;

  async function walk(dir: string, prefix: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (FIDELITY_EXCLUDED_DIRS.has(entry.name)) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) found.push(...await walk(join(dir, entry.name), rel));
      else if (entry.isFile() && /\.md$/i.test(entry.name)) found.push(rel);
    }
    return found;
  }

  async function listAllFiles(): Promise<string[]> {
    return walk(root, "");
  }

  async function readVaultFile(relPath: string): Promise<string> {
    return readFile(join(root, relPath), "utf8");
  }

  /**
   * Is there anything at this path right now? The apply engine's never-overwrite
   * guard (T3b), asked immediately before a create.
   *
   * `lstat`, not `stat`: a DANGLING symlink is something, and the create's O_EXCL
   * write will refuse it — so this must say "yes" too, or the engine would report a
   * clean create and then fail at the adapter for a reason it never mentioned.
   *
   * ENOENT is the answer "no". Any other error (EACCES, EIO, a broken mount) is NOT:
   * it is a question this adapter could not answer, and swallowing it as "no" would
   * turn an unreadable vault into a green light to create files in it. It throws, the
   * engine records the failure, and the proposal stays queued for the next tick.
   */
  async function vaultFileExists(relPath: string): Promise<boolean> {
    try {
      await lstat(join(root, relPath));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  /**
   * Every existing vault path that COULD be the same file as `relPath` on a
   * case-/normalisation-insensitive filesystem — the input to apply's guard 3b
   * (T6 review rounds 2–3). The comparison itself is not made here: the engine makes
   * it, with `findCollidingPath`, the same function the propose side uses.
   *
   * **The ancestry is resolved, not spelled literally, and that is the whole fix of
   * round 3.** Round 2 did `readdir(dirname(join(root, relPath)))` — the LITERAL
   * parent — so for a target `zero7/prosjekt/notat.md` against an existing
   * `zero7/Prosjekt/Notat.md` the readdir ENOENT'd on `zero7/prosjekt`, returned
   * nothing, and the create landed: two directories and two files on the box, one of
   * each on the Mac, the hand-written note shadowed on the next pull. A `Folder`
   * naming a directory that does not exist yet is the ORDINARY way to file a new
   * page, so this was not an exotic path.
   *
   * So each ancestor segment is matched by `collisionKey` rather than by string
   * equality, and ALL matching spellings are followed — on a case-sensitive
   * filesystem `Prosjekt` and `prosjekt` can both exist, and only one of them may
   * hold the colliding file. That makes this O(depth) readdirs over a handful of
   * branches, never a walk: the propose side reads the whole vault once per tick
   * because it decides about many pages at once; this runs per approved create.
   *
   * Returns vault-relative PATHS (not basenames) so the engine compares whole paths,
   * exactly as the propose side does — one question, one answer, both sides.
   * Directories and non-markdown entries are included: a DIRECTORY called
   * `Notater.md` collides with a file called `notater.md` on APFS just as a file
   * would, and `mkdir` and `open` would both land on it.
   *
   * A missing ancestry is `[]` — the ordinary create-into-a-new-folder case, and
   * nothing can collide below a directory that exists in no spelling. Any other
   * failure (EACCES, EIO, a broken mount) THROWS, for the same reason
   * `vaultFileExists` refuses to swallow one: a directory this adapter could not read
   * is a question it could not answer, and answering "nothing collides" would turn an
   * unreadable vault into a green light to create in it.
   *
   * Called only for a path that has already passed `refuseVaultTarget` (apply's guard
   * 2 runs first), so no segment here can be `..`, absolute or a dot-directory.
   */
  async function listCollisionCandidates(relPath: string): Promise<string[]> {
    const segments = relPath.split("/");
    // Vault-relative directories whose path collides with the target's ancestry so
    // far. "" is the vault root, which always exists.
    let dirs = [""];
    for (const wanted of segments.slice(0, -1)) {
      const wantedKey = collisionKey(wanted);
      const next: string[] = [];
      for (const dir of dirs) {
        for (const name of (await entriesOf(dir)).sort()) {
          if (collisionKey(name) === wantedKey) next.push(dir === "" ? name : `${dir}/${name}`);
        }
      }
      if (next.length === 0) return [];
      if (next.length > MAX_COLLIDING_DIRS) {
        // Refusing beats truncating. A silently-shortened candidate list is a
        // silently-weakened guard, and this is only reachable by a vault holding
        // dozens of case-variant spellings of one folder — itself a thing a human
        // needs to know about.
        throw new Error(
          `notion-sync: ${relPath} has more than ${MAX_COLLIDING_DIRS} case-variant ancestor ` +
          `directories ("${wanted}") — refusing to guess which one a create belongs in`,
        );
      }
      dirs = next;
    }
    const candidates: string[] = [];
    for (const dir of dirs) {
      for (const name of await entriesOf(dir)) {
        candidates.push(dir === "" ? name : `${dir}/${name}`);
      }
    }
    return candidates;
  }

  /** One directory's entry names; `[]` when it does not exist, throws otherwise. */
  async function entriesOf(relDir: string): Promise<string[]> {
    try {
      return await readdir(join(root, relDir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  return { listAllFiles, readVaultFile, vaultFileExists, listCollisionCandidates };
}
