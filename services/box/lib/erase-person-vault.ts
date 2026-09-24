// services/box/lib/erase-person-vault.ts — W5B-s7: erase a person's files from the vault, and be
// honest about what git keeps.
//
// THE DATABASE HALF (lib/erase-person.ts) can promise that no ROW names the person, because every
// table it touches comes from an inventory a repository test forces new tables into. The vault can
// make no such promise from a list: it is a directory of markdown with no index of who a file
// belongs to, so finding a person here is a full walk, and the only marks to go on are the
// frontmatter keys `owner:` and `participants:`.
//
// WHAT IS WALKED THAT NOTHING ELSE WALKS. `_meta/` is excluded from the notes store's list and
// search (`packages/agent-kit/src/notes-store.ts`, EXCLUDED_DIRS) — as a privacy measure, because
// it holds one member's conversation logs. That exclusion is exactly why an erase must walk it BY
// HAND: the most personal files in the vault are the ones search is forbidden to see. `.git`,
// `.locks`, `.obsidian` and `node_modules` are skipped; `_meta` is not.
//
// WHAT IS DELIBERATELY NOT DELETED. A note whose `participants:` list names this person AND
// somebody else is also the other person's data. Deleting it would erase one member's record by
// erasing another's; editing their name out of it would rewrite a note neither of them wrote that
// way. So a `shared` hit is returned, never touched, and the report names it for a person to
// decide by hand. Only a note where EVERY participant is one of this person's own spellings is
// theirs alone, and only that is removed.
//
// SPELLINGS, NOT A NAME. The caller passes `PersonIdentity.spellings` — the canonical id and every
// older one. A note stamped `owner:` under a handle the person used two years ago is theirs, and
// the whole point of the identity track is that it goes too. An EMPTY spelling list throws rather
// than matching nothing (or, one careless `.includes("")` later, everything).
//
// TRACKED AND UNTRACKED ARE TWO DIFFERENT DELETES. `writeRawNote` (vault-raw.ts) writes files that
// were never added to git — on a real box, every conversation log under `_meta/conversations/`.
// `git rm` does not see them and will not remove them. So the tracked paths go through one
// `git rm`, the untracked ones through `rmSync`, and the commit counts only the files it actually
// records — claiming eight removals in a commit that removes seven would be the same kind of lie
// this whole routine exists to avoid.
//
// IT DOES NOT PUSH, unlike `removeNote` in `packages/agent-kit/src/vault-git.ts`. An erase is
// coordinated by a person across several places at once, and a push that fails halfway leaves a
// worse state than a local commit somebody sends deliberately. The CLI prints the push command.
//
// THE FRONTMATTER PARSE IS LOCAL, AND WHY. `services/box` depends on `pg`, `pg-boss`,
// `better-sqlite3` and `@lares/network` — not on `@lares/agent-kit`, where `noteScope` lives, and
// not on `@lares/vault-format`. Adding a dependency to reach one 20-line parse would put the whole
// agent kit into the box image. So the parse below is written here, following `noteScope`'s CRLF
// rule exactly (a file saved with `\r\n` used to defeat an LF-only check and fall back to the
// store default — pre-launch wave 3A). It reads MORE than `noteScope` does: block-style lists and
// quoted scalars, which `noteScope`'s one-line regex does not handle. That is deliberate. A reader
// that misses a form sees a wider note than it should; a walker that misses a form leaves a
// person's file behind and reports success.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, rmSync, statSync, type Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** One vault file that names the person, and why we think so. */
export interface VaultHit {
  /** Store-relative, forward-slashed — the same shape every other vault path in this system has. */
  path: string;
  /** `owner` — stamped as theirs. `sole-participant` — a conversation with nobody else in it.
   *  `shared` — theirs AND somebody else's, so not ours to delete. `meta` — an `owner:` hit under
   *  `_meta/`, the directory list and search refuse to show. */
  why: "owner" | "sole-participant" | "shared" | "meta";
  /** Whether git knows about this file. Untracked files need a plain `rm`; `git rm` cannot see
   *  them. A vault that is not a git repository at all has no tracked files. */
  tracked: boolean;
}

/** What the commit says about itself, because the git log is where somebody will look in a year.
 *  `services/box/ops/vault-purge.sh` is the separate, destructive step (W5B-s9). */
export const ERASE_COMMIT_NOTE =
  "These files are removed from the working tree and from this commit forward. They remain in " +
  "this repository's history and can still be read with `git log -p`, and they remain in any " +
  "backup taken before now. Removing them from history is a separate, destructive step — " +
  "`services/box/ops/vault-purge.sh` — which rewrites every commit id and must be coordinated " +
  "with every clone and every sync job's recorded commit.";

/** Never walked. `_meta` is NOT among them: see the header. `.trash` is not either — a note the
 *  owner moved to the trash is still their note until the trash is emptied. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([".git", ".locks", ".obsidian", "node_modules"]);

/**
 * Whether a path stays inside `root`, lexically AND after symlinks are followed.
 *
 * Both halves are load-bearing, and this is a deliberate copy of `resolvesWithin` in
 * `packages/agent-kit/src/notes-store.ts` rather than an import (see the header on dependencies).
 * The lexical check alone lets a symlink inside the vault reach anything it points at; the
 * resolved check alone denies everything when the ROOT is itself a symlink, which it is on macOS
 * (`/var` → `/private/var`) and on any box where the vault sits on a mounted volume.
 *
 * Exported so `lib/export-person.ts` asks the very same question — of the files it copies OUT of
 * a vault, and of the directory it writes them to — rather than keeping a second containment
 * check that could answer differently.
 */
export function resolvesWithin(candidate: string, root: string): boolean {
  const isUnder = (path: string, base: string): boolean =>
    path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);

  const resolvedRoot = resolve(root);
  if (!isUnder(resolve(candidate), resolvedRoot)) return false;

  let realRoot: string;
  try {
    realRoot = realpathSync(resolvedRoot);
  } catch {
    realRoot = resolvedRoot;
  }
  let real: string;
  try {
    real = realpathSync(resolve(candidate));
  } catch {
    // A path that does not exist is judged on its lexical form alone — it reads nothing.
    return true;
  }
  return isUnder(real, realRoot);
}

/** `a` → `a`; `"a"` → `a`; `'a'` → `a`. YAML's two quoted scalar forms, and nothing cleverer:
 *  anything more would be a YAML parser, and a wrong one. */
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2) {
    const first = s[0];
    if ((first === '"' || first === "'") && s.endsWith(first)) return s.slice(1, -1).trim();
  }
  return s;
}

interface Frontmatter {
  owner: string | undefined;
  participants: string[];
}

const NO_FRONTMATTER: Frontmatter = { owner: undefined, participants: [] };

/**
 * `owner:` and `participants:` out of a note's frontmatter.
 *
 * CRLF is normalised first, exactly as `noteScope` does. Both list forms are read — inline
 * (`participants: [a, b]`) and block (`participants:` then `  - a`) — because Obsidian writes one
 * and hand-edited notes carry the other, and a walker that knows only one leaves files behind.
 */
function parseFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return NO_FRONTMATTER;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return NO_FRONTMATTER;
  const lines = text.slice(4, end).split("\n");

  let owner: string | undefined;
  const participants: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const ownerMatch = /^owner:\s*(.+)$/.exec(line);
    if (ownerMatch !== null && owner === undefined) {
      const value = unquote(ownerMatch[1]!);
      if (value.length > 0) owner = value;
      continue;
    }
    const participantsMatch = /^participants:\s*(.*)$/.exec(line);
    if (participantsMatch === null) continue;

    const inline = participantsMatch[1]!.trim();
    if (inline.length > 0) {
      // `[a, b]` or a bare `a, b` — the form `noteScope` reads.
      for (const part of inline.replace(/^\[|\]$/g, "").split(",")) {
        const value = unquote(part);
        if (value.length > 0) participants.push(value);
      }
      continue;
    }
    // A block list: every following `- item` line, until something that is not one.
    for (let j = i + 1; j < lines.length; j += 1) {
      const item = /^\s*-\s*(.+)$/.exec(lines[j]!);
      if (item === null) break;
      const value = unquote(item[1]!);
      if (value.length > 0) participants.push(value);
      i = j;
    }
  }

  return { owner, participants };
}

/** The set of spellings, checked. An empty list would make every `includes` below answer "no" —
 *  and one careless blank spelling would make it answer "yes" to every unowned note. */
function spellingSet(spellings: readonly string[]): ReadonlySet<string> {
  if (spellings.length === 0) {
    throw new Error(
      "findPersonFiles needs at least one spelling of the person's name; an empty list would " +
        "match nothing, and a blank spelling would match everything.",
    );
  }
  for (const spelling of spellings) {
    if (spelling.trim().length === 0) {
      throw new Error("findPersonFiles was given a blank spelling; a blank must never match.");
    }
  }
  return new Set(spellings.map((s) => s.trim()));
}

/** Every tracked path, relative to `root`. A root that is not a git work tree has none, which is
 *  the honest answer: `git rm` will remove nothing there, and `rmSync` does the whole job. */
function trackedPaths(root: string): ReadonlySet<string> {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(out.split("\0").filter((p) => p.length > 0));
  } catch {
    return new Set();
  }
}

/** TRUE when the index already differs from HEAD — somebody staged something before this run. */
function hasStagedChanges(root: string): boolean {
  try {
    execFileSync("git", ["-C", root, "diff", "--cached", "--quiet"], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

function isGitWorkTree(root: string): boolean {
  try {
    const out = execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** Every `.md` under `root`, absolute. Symlinks that leave the root are not followed, and a
 *  symlinked directory is visited once — a link back to an ancestor would otherwise never end. */
function walkMarkdown(dir: string, root: string, seenDirs: Set<string>, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // An unreadable directory is reported by the caller's own checks, not guessed at.
  }

  for (const entry of entries) {
    const abs = join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();

    if (entry.isSymbolicLink()) {
      if (!resolvesWithin(abs, root)) continue; // Out of the vault: not ours, not followed.
      try {
        const stat = statSync(abs);
        isDirectory = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue; // A broken link names no file.
      }
    }

    if (isDirectory) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      let key = abs;
      try {
        key = realpathSync(abs);
      } catch {
        /* judged on its lexical form */
      }
      if (seenDirs.has(key)) continue;
      seenDirs.add(key);
      walkMarkdown(abs, root, seenDirs, out);
    } else if (isFile && entry.name.endsWith(".md")) {
      out.push(abs);
    }
  }
}

/**
 * Every `.md` under `root` that names one of `spellings`, including `_meta/`.
 *
 * READ-ONLY. Nothing here writes, moves or removes anything; `erasePersonFiles` does that, from
 * the hits this returns, so that a person can read the list before anything happens to it.
 */
export function findPersonFiles(root: string, spellings: readonly string[]): VaultHit[] {
  const spelled = spellingSet(spellings);
  const tracked = trackedPaths(root);

  const files: string[] = [];
  walkMarkdown(root, root, new Set<string>(), files);

  const hits: VaultHit[] = [];
  for (const abs of files) {
    let raw: string;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      continue; // A file that cannot be read names nobody we can prove.
    }
    const path = relative(root, abs).split(sep).join("/");
    const { owner, participants } = parseFrontmatter(raw);

    // An `owner:` hit wins: the note is stamped as this person's, whoever else it mentions.
    if (owner !== undefined && spelled.has(owner)) {
      const why = path === "_meta" || path.startsWith("_meta/") ? "meta" : "owner";
      hits.push({ path, why, tracked: tracked.has(path) });
      continue;
    }
    if (participants.some((p) => spelled.has(p))) {
      const why = participants.every((p) => spelled.has(p)) ? "sole-participant" : "shared";
      hits.push({ path, why, tracked: tracked.has(path) });
    }
  }

  hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return hits;
}

/** `git rm` takes every path as an argument; a vault with thousands of a person's files would
 *  otherwise overrun the command line. */
function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Remove the person's files: `git rm` for the tracked ones, plain `rm` for the untracked ones,
 * ONE commit, and never a push.
 *
 * `shared` hits are neither removed nor edited — they come back in `leftShared` for a person to
 * decide by hand.
 *
 * `commit` is null when this run recorded nothing in git: a dry run, a run with nothing tracked to
 * remove, or a vault that is not a git repository at all. In that last case the untracked removal
 * still happens — the files go, and the caller is told there is no commit to push.
 */
export async function erasePersonFiles(opts: {
  vaultRoot: string;
  hits: readonly VaultHit[];
  dryRun: boolean;
}): Promise<{ commit: string | null; removed: string[]; untracked: string[]; leftShared: string[] }> {
  const { vaultRoot, hits, dryRun } = opts;

  // Containment is checked for EVERY hit, before anything is removed and before a dry run
  // reports, so that a bad path is a refusal rather than a delete somewhere else on the disk.
  for (const hit of hits) {
    if (!resolvesWithin(join(vaultRoot, hit.path), vaultRoot)) {
      throw new Error(`refusing to erase ${hit.path}: it resolves outside the vault at ${vaultRoot}`);
    }
  }

  const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const leftShared = hits.filter((h) => h.why === "shared").map((h) => h.path).sort(byPath);
  const mine = hits.filter((h) => h.why !== "shared");
  const removed = mine.filter((h) => h.tracked).map((h) => h.path).sort(byPath);
  const untracked = mine.filter((h) => !h.tracked).map((h) => h.path).sort(byPath);

  if (dryRun) return { commit: null, removed, untracked, leftShared };

  // The commit below records whatever is staged. Anything somebody else staged beforehand would
  // ride along inside a commit that says it is an erase — so that is a refusal, before any file
  // is touched, not something to tidy up afterwards.
  if (removed.length > 0 && isGitWorkTree(vaultRoot) && hasStagedChanges(vaultRoot)) {
    throw new Error(
      `refusing to erase in ${vaultRoot}: the vault already has staged changes. ` +
        "Commit or unstage them first, so the erase commit holds the erase and nothing else.",
    );
  }

  // `-f`: a person's note with an unsaved local edit is still that person's note. Without it
  // `git rm` stops on the first modified file, part-way through the batches.
  for (const batch of chunked(removed, 200)) {
    execFileSync("git", ["-C", vaultRoot, "rm", "-q", "-f", "--", ...batch]);
  }
  for (const path of untracked) {
    rmSync(join(vaultRoot, path), { force: true });
  }

  // The commit counts the files it actually records. The untracked ones were never in git and
  // never will be; the report tells the person about them, the commit does not pretend to.
  if (removed.length === 0 || !isGitWorkTree(vaultRoot)) {
    return { commit: null, removed, untracked, leftShared };
  }
  const subject = `erase: ${removed.length} file(s) for one person`;
  execFileSync("git", ["-C", vaultRoot, "commit", "-q", "-m", `${subject}\n\n${ERASE_COMMIT_NOTE}`]);
  const commit = execFileSync("git", ["-C", vaultRoot, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return { commit, removed, untracked, leftShared };
}
