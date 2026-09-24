// services/atlas/lib/adapters/atlas-writer.ts
// The Atlas write boundary — the ONLY place this service mutates the store, and the reason
// every engine module above it can stay pure.
//
// Modeled on notion-sync's vault-writer (which is itself modeled on agent-box's commitNote)
// and reusing `withNoteLock`, the lock the fleet's own writers take. What it does NOT reuse
// is any frontmatter serialisation: the bytes handed to it are written verbatim.
//
// Commit-then-push, and a failed push is reported rather than thrown: the box's bare remote
// can be briefly unavailable, and discarding the COMMIT for that would mean re-deriving and
// re-proposing the same note on the next tick. The working clone is the source of the next
// read either way; the push is how the box's OTHER containers see it.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname, relative } from "node:path";
import { withNoteLock } from "@lares/agent-box";

export interface AtlasWriter {
  /** Every .md file, Atlas-relative, sorted — never .git or .locks. */
  listNotes(): string[];
  readNote(relPath: string): string;
  writeNotes(
    files: Array<{ path: string; raw: string }>,
    message: string,
  ): Promise<{ committed: boolean; pushed: boolean }>;
}

export interface AtlasWriterOptions {
  atlasPath: string;
  /** Injected in tests so a push can be made to fail without a real remote. */
  run?: (cmd: string, args: string[], cwd: string) => string;
}

const SKIP_DIRS = new Set([".git", ".locks", "node_modules"]);

/**
 * Parses `git status --porcelain -z` output into the paths it reports as dirty.
 *
 * `-z`, not the default porcelain format: git C-QUOTES any path it considers unusual in the
 * DEFAULT format — a plain SPACE is enough (`?? "note with space.md"`, quotes included), and
 * so is any non-ASCII byte (`core.quotePath` defaults to true). Reading that output with
 * `line.slice(3)` gets back the quoted string, which then never matches the unquoted path
 * this writer actually wrote to disk — a genuinely new file gets misclassified "invisible to
 * git" and thrown as if it were gitignored (review round 3, IMPORTANT). This is exactly the
 * class of defect this write boundary keeps producing: a guard that's correct for the paths
 * someone happened to test and silently wrong for the rest. `-z` is the machine-readable
 * form — NUL-terminated, and it NEVER quotes or escapes — and this is machine-reading it.
 */
function parsePorcelainZPaths(output: string): string[] {
  const fields = output.split("\0").filter((f) => f.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i]!;
    const statusCode = record.slice(0, 2);
    paths.push(record.slice(3));
    // Rename/copy records are the one place `-z` changes SHAPE, not just escaping: the
    // record holds the ORIGINAL path, and the NEW path arrives as the very next NUL-separated
    // field — rather than one `orig -> new` line, as the default format writes it. This writer
    // only ever adds or overwrites a note at a path it was given (mkdir + writeFileSync); it
    // never calls `git mv` and never deletes, so an R/C status should never occur for a path
    // THIS call is responsible for. Handled here anyway, rather than assumed away: if an
    // unrelated actor's staged rename happens to collide with a path in our pathspec, both the
    // original and new path are recorded as dirty, so whichever one matches a path we're
    // tracking is still found — and the paired field is consumed so it can't be misread as an
    // unrelated record's own status line.
    if (statusCode.includes("R") || statusCode.includes("C")) {
      i += 1;
      const newPath = fields[i];
      if (newPath !== undefined) paths.push(newPath);
    }
  }
  return paths;
}

export function makeAtlasWriter(opts: AtlasWriterOptions): AtlasWriter {
  const root = resolve(opts.atlasPath);
  const run = opts.run ?? ((cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8" }));

  /**
   * Real inodes, not string arithmetic — a symlinked directory (or a symlinked FILE) passes
   * a resolve() check.
   *
   * Three checks, in order: (1) an Atlas-relative path must not be absolute — `join()` would
   * otherwise fold `/etc/evil.md` INSIDE the root as a string, only to have it fail later at
   * `git add -- /etc/evil.md`, whose pathspec is the raw relPath, not the joined one, leaving
   * a written-but-uncommitted file behind (review round 1, MINOR 6); (2) the target's
   * DIRECTORY must realpath inside the root — this is what catches a symlinked directory
   * (review round 1's original guard); (3) the target FILE ITSELF, once it exists, must also
   * realpath inside the root — a symlinked directory is not the only escape route, a plain
   * symlinked FILE is another, and realpathing only the dirname can never see it (review
   * round 1, CRITICAL 1: a note that IS a symlink defeated containment entirely, on both the
   * read and the write side). A target that doesn't exist yet has no realpath, which is fine
   * either way: it will be created inside a directory already proven real and contained, so
   * it cannot itself be a pre-existing link.
   */
  function safeAbs(relPath: string): string {
    if (relPath.startsWith("/")) {
      throw new Error(`atlas: refusing "${relPath}" — an Atlas-relative path must not be absolute`);
    }
    const abs = resolve(join(root, relPath));
    const realRoot = realpathSync(root);
    if (abs !== root && !abs.startsWith(`${root}/`)) {
      throw new Error(`atlas: refusing to write "${relPath}" — it would escape the store root`);
    }
    let realDir: string;
    try { realDir = realpathSync(dirname(abs)); } catch { return abs; }   // dir not created yet
    if (realDir !== realRoot && !realDir.startsWith(`${realRoot}/`)) {
      throw new Error(`atlas: refusing to write "${relPath}" — its directory escapes the store root via a symlink`);
    }
    let realFile: string;
    try { realFile = realpathSync(abs); } catch { return abs; }           // file doesn't exist yet
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}/`)) {
      throw new Error(`atlas: refusing to access "${relPath}" — it is a symlink whose target escapes the store root`);
    }
    return abs;
  }

  function walk(dir: string, acc: string[]): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const abs = join(dir, entry);
      // lstat, not stat: a SYMLINKED directory must not be descended into (it can point
      // anywhere at all), and lstat is what tells a real directory and a symlink-to-a-
      // directory apart — stat follows the link and would see the latter as the former
      // (review round 1, MINOR 7).
      if (lstatSync(abs).isDirectory()) walk(abs, acc);
      else if (entry.endsWith(".md")) acc.push(relative(root, abs));
    }
    return acc;
  }

  return {
    listNotes() {
      // Sorted, because directory order differs between the box's ext4 and Bendik's APFS,
      // and a run whose OUTPUT depends on that is a run whose diff depends on the machine.
      // Plain codepoint order, not `localeCompare` — collation is ICU/locale-data dependent
      // (varies by Node build and by the box's locale vs Bendik's), which is precisely the
      // kind of machine-dependent ordering this sort exists to rule out.
      return walk(root, []).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    },

    readNote(relPath: string) {
      return readFileSync(safeAbs(relPath), "utf8");
    },

    async writeNotes(files, message) {
      // An empty batch must do NOTHING — not even ask git what's dirty (review round 2, the
      // new IMPORTANT this round's IMPORTANT-2 fix introduced). `git status --porcelain --`
      // with NO pathspec after `--` means "the whole tree", not "these zero paths": every
      // guard below assumes the pathspec scopes to files THIS BATCH is answerable for, and an
      // unscoped status/add/commit reports and then commits whatever ANYONE ELSE has staged —
      // both a commit for a change this service never made (the churn defect the whole plan
      // exists to prevent) and the exact IMPORTANT-3 hijack that pathspec was added to close,
      // reopened through the one door it didn't cover.
      if (files.length === 0) return { committed: false, pushed: false };

      // Validate every path in the batch BEFORE writing anything (review round 1, IMPORTANT
      // 2, part one): resolving `abs` eagerly for the whole batch means a bad path anywhere
      // in it aborts before any file — including an earlier, perfectly good one — is ever
      // written. The old per-file-inside-the-loop check let a good file land on disk with no
      // commit to show for it, orphaned by a LATER path's failure.
      const targets = files.map((f) => ({ f, abs: safeAbs(f.path) }));

      // Paths this call actually wrote bytes to — as opposed to "in the batch", which
      // includes paths already byte-identical on disk. Distinct from `paths` below because
      // the gitignore check (next) can only be about files we KNOW we just touched.
      const touched: string[] = [];
      for (const { f, abs } of targets) {
        let current: string | undefined;
        try { current = readFileSync(abs, "utf8"); } catch { current = undefined; }
        if (current === f.raw) continue;        // byte-identical: no WRITE needed...
        await withNoteLock(root, f.path, async () => {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, f.raw, "utf8");
        });
        touched.push(f.path);
      }

      // ...but "no write needed" is NOT the same claim as "no commit needed" (review round 1,
      // IMPORTANT 2, part two): a PRIOR run can have written these exact bytes to disk and
      // then failed before `git commit` — the hook rejected it, the disk filled, whatever —
      // leaving the working tree byte-identical to what we'd write again while HEAD never
      // moved. Comparing memory to disk alone would call that "nothing to do" and lose the
      // change permanently. Ask git, not memory, whether there is anything to commit for the
      // paths THIS batch is responsible for.
      const paths = files.map((f) => f.path);
      const status = run("git", ["status", "--porcelain", "-z", "--", ...paths], root);
      const dirtyPaths = new Set(parsePorcelainZPaths(status));

      // A file we just wrote bytes to but that git reports NO change for is a contradiction,
      // not a no-op — almost certainly `.gitignore` (the Atlas has none today, but the next
      // caller, Task 9's sync job, will hand this batches routinely). Silently returning
      // `{committed: false}` here would tell the caller nothing happened when something did:
      // the bytes are on disk and will never be committed or pushed unless someone notices.
      const invisible = touched.filter((p) => !dirtyPaths.has(p));
      if (invisible.length > 0) {
        throw new Error(
          `atlas: wrote ${invisible.length} file(s) to disk but git reports no change for ` +
          `${invisible.length === 1 ? "it" : "them"} (likely covered by .gitignore) — refusing ` +
          `to silently report nothing happened: ${invisible.join(", ")}`,
        );
      }

      if (dirtyPaths.size === 0) return { committed: false, pushed: false };

      run("git", ["add", "--", ...paths], root);
      // Scoped with `-- <paths>`, not a bare commit (review round 1, IMPORTANT 3): the
      // working tree of this batch's own paths is the ONLY thing it is answerable for.
      // Without the pathspec, `git commit` sweeps up anything else already staged in the
      // shared clone — a human's in-progress edit, a concurrent writer's half-finished
      // batch — silently, under this service's name and message.
      run("git", ["commit", "-q", "-m", message, "--", ...paths], root);
      try {
        run("git", ["push", "-q", "origin", "HEAD:main"], root);
        return { committed: true, pushed: true };
      } catch (e) {
        console.error(
          `atlas: committed change(s) to ${paths.length} file(s) but the push to origin FAILED ` +
          `(${e instanceof Error ? e.message : String(e)}). The box's other containers will not ` +
          "see this until the next successful push.",
        );
        return { committed: true, pushed: false };
      }
    },
  };
}
