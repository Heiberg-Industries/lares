// The vault write boundary — the ONLY place this service mutates the Brain, and
// the reason runApplySync/runPullSync can stay pure engines. Under adapters/ for
// the same reason notion-client.ts is: it holds the vendor-ish knowledge (git, the
// fleet's note lock) the engines must not.
//
// Modeled on agent-box's `commitNote` (brain-source.ts) rather than reusing it,
// deliberately (Phase 3 plan decision 3): commitNote SERIALISES frontmatter from a
// Record and hardcodes a `note(saga):` message. Write-back has to be byte-verbatim
// — the frontmatter block is carried over from the file on disk untouched, and a
// re-serialisation would rewrite quoting, key order and comments on every apply.
// What IS reused, exactly: `withNoteLock` (the lock the fleet's own writers take,
// spec §5 as amended) and the add/commit/push-tolerating-failure sequence.
import { mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname, sep } from "node:path";
import { withNoteLock } from "@lares/agent-box";
import { refuseVaultTarget } from "../vault-target.js";

export interface VaultWriterOptions {
  /** Absolute path of the vault clone (config `vaultPath`, `/srv/brain` on the box). */
  vaultPath: string;
}

/** Where an archived file goes (spec §7: retire, never delete). */
const ARCHIVE_DIR = "_archive";

export function makeVaultWriter(opts: VaultWriterOptions) {
  const absVault = resolve(opts.vaultPath);

  /** Same guard as brain-source's assertSafe — a vault-relative path stays inside the vault. */
  function assertSafe(relPath: string): string {
    const abs = resolve(join(absVault, relPath));
    if (!abs.startsWith(`${absVault}/`)) {
      throw new Error(`notion-sync: path traversal detected: ${relPath}`);
    }
    return abs;
  }

  /**
   * The guard `assertSafe` cannot give (T3b), and the absolute path to create at.
   *
   * `resolve()` is pure string arithmetic: it collapses `..` and rejects absolute
   * paths, but it never touches the disk, so a SYMLINKED DIRECTORY inside the vault
   * pointing anywhere at all passes it unchanged. `/srv/brain/escape → /etc` makes
   * `escape/cron.md` a path that reads as vault-relative and writes to /etc.
   *
   * Closing that needs real inodes: walk up to the deepest ancestor of the target
   * that actually EXISTS and ask the kernel for its real path. Everything below that
   * ancestor is about to be created by this call, so nothing there can be a link.
   *
   * The rule is the strict one — the existing ancestry must contain NO symlink at
   * all, not merely no symlink that escapes. Two reasons, and the second is decisive:
   * a link that stays inside the vault today can be re-pointed outside it tomorrow
   * without this service noticing; and `git add -- <path>` refuses outright with
   * "pathspec is beyond a symbolic link", so a file created through one would be
   * written and then fail to commit, leaving an uncommitted file the store already
   * believes is synced. A path git cannot version is not a path this service can
   * create a note at.
   *
   * The vault root is realpath'd FIRST and the target built from that, rather than
   * compared against a merely-resolved root: the mount itself is commonly reached
   * through a link (macOS `/var` → `/private/var`, any symlinked `/srv/brain`), and
   * comparing a real path against a resolved one would refuse every write on those
   * hosts.
   *
   * Used by createVaultFile only, deliberately. The update path writes files the push
   * pass discovered by walking the vault, so its targets are already known-real; a
   * create is the one write whose path comes from Notion content.
   */
  function resolveCreateTarget(relPath: string): string {
    const realVault = realpathSync(absVault);
    const abs = resolve(join(realVault, relPath));
    if (!abs.startsWith(`${realVault}${sep}`)) {
      throw new Error(`notion-sync: path traversal detected: ${relPath}`);
    }
    let ancestor = dirname(abs);
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
      ancestor = dirname(ancestor);
    }
    const realAncestor = realpathSync(ancestor);
    if (realAncestor !== ancestor) {
      throw new Error(
        `notion-sync: refusing to create ${relPath} — ${ancestor} is a symlink to ` +
        `${realAncestor}; a create writes inside the vault itself, never through a link`,
      );
    }
    return abs;
  }

  function git(...args: string[]): void {
    execFileSync("git", ["-C", absVault, ...args]);
  }

  /**
   * Commits ONLY the given paths (`git commit -- <pathspec>`). The vault clone is
   * shared with humans and the fleet's other writers, so whatever else happens to
   * be staged there is none of this service's business: an unscoped commit would
   * sweep someone's work-in-progress into a "notion-sync: apply" commit.
   *
   * Push is best-effort, exactly as in commitNote: the commit is already durable
   * locally and the nightly mirror reconciles, so a temporarily unreachable remote
   * must not turn a completed vault write into a thrown error the engine would
   * then record as a failure.
   */
  function commit(message: string, ...paths: string[]): void {
    git("commit", "-q", "-m", message, "--", ...paths);
    try {
      git("push", "-q", "origin", "HEAD");
    } catch (err) {
      console.warn(`notion-sync: push to the vault remote failed (${message} is durable locally):`, err);
    }
  }

  /**
   * True when `git add` actually staged something FOR THIS PATH. `git diff
   * --cached --quiet` exits 0 for "no staged changes" and 1 for "there are some",
   * so the throw is the signal here rather than the failure. Scoped by pathspec:
   * an unrelated staged file elsewhere in the shared vault clone must not make a
   * no-op apply look like a change worth committing.
   */
  function hasStagedChanges(relPath: string): boolean {
    try {
      git("diff", "--cached", "--quiet", "--", relPath);
      return false;
    } catch {
      return true;
    }
  }

  /** Writes `content` byte-for-byte to `relPath` and commits it. */
  async function writeVaultFile(relPath: string, content: string): Promise<void> {
    const abs = assertSafe(relPath);
    return withNoteLock(absVault, relPath, async () => {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      git("add", "--", relPath);
      // An apply whose reassembled bytes already match the file on disk is a
      // legitimate outcome, not a failure — `git commit` exits non-zero on an
      // empty commit, which would fail the apply, walk the row to 'error' through
      // the 3-strike path and leave the proposal retrying forever. The vault holds
      // the content: that is the applied state. (Never `--allow-empty`: an empty
      // commit in the vault's history is noise a human would have to read past.)
      if (!hasStagedChanges(relPath)) return;
      commit(`notion-sync: apply ${relPath}`, relPath);
    });
  }

  /**
   * Writes a file that does not exist yet, and REFUSES if it does (T3b).
   *
   * Separate from writeVaultFile rather than a flag on it, because the difference is
   * the whole point: writeVaultFile overwrites by design (that is what applying an
   * edit means) and this one must never overwrite anything, ever. A boolean
   * parameter would put both behaviours behind one call site, one line away from
   * each other, and the wrong value there silently destroys a hand-written file.
   *
   * THREE guards, all of them here, all of them at the write:
   *
   *  1. `refuseVaultTarget` — the shape rules (../, absolute, dot-dirs, `wiki/`,
   *     `_archive/`, `_meta/`, non-markdown). Shared with the engine and, in time,
   *     with the propose side: one definition, so they cannot drift apart.
   *  2. `resolveCreateTarget` — the symlink escape `resolve()` cannot see.
   *  3. `flag: "wx"` — O_CREAT|O_EXCL. The kernel fails the open with EEXIST if
   *     anything at all is at that path, including a symlink or a dangling one. This
   *     is what makes "never overwrite" atomic: the engine's own existence check runs
   *     a moment earlier so it can refuse cleanly and tell Bendik why, but between
   *     that check and this write there is a window, and a human saving a note in it
   *     is exactly the accident this must survive. Here there is no window.
   *
   * The disk-facing guards run INSIDE the note lock, next to the write, for the same
   * reason: the closer the check to the syscall, the less there is between them.
   */
  async function createVaultFile(relPath: string, content: string): Promise<void> {
    const refusal = refuseVaultTarget(relPath);
    if (refusal !== null) {
      throw new Error(`notion-sync: refusing to create ${relPath} — ${refusal}`);
    }
    return withNoteLock(absVault, relPath, async () => {
      const abs = resolveCreateTarget(relPath);
      mkdirSync(dirname(abs), { recursive: true });
      try {
        writeFileSync(abs, content, { encoding: "utf8", flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(
            `notion-sync: refusing to create ${relPath} — a file already exists there ` +
            `and a create never overwrites`,
          );
        }
        throw err;
      }
      git("add", "--", relPath);
      // Same reason as writeVaultFile's: `git commit` exits non-zero on an empty
      // commit. A brand-new file always stages something UNLESS the vault's
      // .gitignore covers its path — in which case the file is written and simply not
      // versioned, which is the vault's own decision to have made, not a failed apply.
      if (!hasStagedChanges(relPath)) return;
      commit(`notion-sync: create ${relPath}`, relPath);
    });
  }

  /** Moves `relPath` to `_archive/<relPath>` with git mv (bytes and history preserved). */
  async function archiveVaultFile(relPath: string): Promise<void> {
    assertSafe(relPath);
    const destPath = `${ARCHIVE_DIR}/${relPath}`;
    const destAbs = assertSafe(destPath);
    return withNoteLock(absVault, relPath, async () => {
      mkdirSync(dirname(destAbs), { recursive: true });
      git("mv", "--", relPath, destPath);
      // Both sides of the move — the removal at the old path and the file at the
      // new one — are this commit's business, and nothing else is.
      commit(`notion-sync: archive ${relPath}`, relPath, destPath);
    });
  }

  return { writeVaultFile, createVaultFile, archiveVaultFile };
}
