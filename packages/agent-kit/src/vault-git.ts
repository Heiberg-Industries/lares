import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

import { resolveInStore } from "./notes-store.js";
import { withVaultRepositoryLock, vaultGitEnvironment } from "./note-lock.js";
import { createHash } from "node:crypto";
import { ARTICLE_FULL_TEXT_KEY, articleCompanionPath } from "@lares/vault-format/article";

/**
 * The git mechanics behind the vault write tools (`vault_write`, `vault_file`, `vault_drop`):
 * the git invocations are `git add`, `git commit -q -m <msg>`, `git rev-parse --short HEAD`,
 * `git push -q origin HEAD`, `git mv` and `git rm -q`.
 *
 * Path safety reuses `notes-store.ts`'s `resolveInStore` (the traversal- and
 * symlink-safe containment check already proven by every read tool) rather than a
 * simpler prefix-only check.
 *
 * A PUSH FAILURE IS NEVER SWALLOWED. Logging a warning and returning success anyway would
 * trust a mirror to reconcile later, and nothing here guarantees one, so a silent local-only
 * commit would be a real silent-failure gap: the vault would look updated to the caller while the bare
 * remote never got it. Here a push failure throws `VaultPushFailedError` instead, carrying
 * the local commit hash it durably made — the caller/model learns the commit exists, but
 * is not (yet) synced to the bare remote.
 */

export interface VaultWriteResult {
  commit: string;
}

/** A `git push` to the bare remote failed. The local commit is durable (see `.commit`) but
 *  has NOT reached the local bare origin — a silent local-only write here is exactly the
 * silent-failure shape, so this is thrown rather than swallowed. */
export class VaultPushFailedError extends Error {
  constructor(readonly commit: string, cause: unknown) {
    super(
      `vault push to origin failed after local commit ${commit}: the commit is durable ` +
        `locally but has NOT reached the bare remote yet (a vault that looks ` +
        `updated locally while the bare never got it is the silent-failure shape this ` +
        `refuses to produce).`,
      { cause },
    );
    this.name = "VaultPushFailedError";
  }
}

// ── YAML frontmatter serialiser (no external deps) ──

export function serializeFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (value === null || value === undefined) {
      lines.push(`${key}:`);
    } else if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

/** Internal Git calls cannot inherit an alternate GIT_DIR/index or use network transports. */
export function runVaultGit(vaultRoot: string, args: string[]): string {
  return execFileSync("git", ["-c", "protocol.allow=never", "-c", "protocol.file.allow=always",
    "-C", vaultRoot, ...args], { encoding: "utf8", env: vaultGitEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
}
const runGit = runVaultGit;
export function vaultContentRevision(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export class VaultStagedChangesError extends Error {
  constructor() { super("Vault has staged changes; refusing a mixed commit"); this.name = "VaultStagedChangesError"; }
}
export class VaultContentChangedError extends Error {
  constructor() { super("Vault contents changed; read the current files before trying again"); this.name = "VaultContentChangedError"; }
}
/** Trusted server guard; content expectations are mandatory for every touched path.
 * revalidate runs after waiting for the repository lock, while caller DB locks remain held. */
export interface VaultGitGuard {
  expectedContents: Readonly<Record<string, string | null>>;
  localOrigin: string;
  revalidate: () => Promise<void>;
  companion: { path: string; revision: string } | null;
}
function assertExpected(root: string, expected: Readonly<Record<string, string | null>>, paths: string[]): void {
  if (Object.keys(expected).sort().join("\0") !== [...new Set(paths)].sort().join("\0")) throw new VaultContentChangedError();
  for (const path of paths) {
    const wanted = expected[path];
    if (wanted !== null && (typeof wanted !== "string" || !/^[a-f0-9]{64}$/.test(wanted))) throw new VaultContentChangedError();
    const abs = resolveInStore(path, root);
    let bytes: Buffer;
    try { bytes = readFileSync(abs); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && wanted === null) continue;
      throw new VaultContentChangedError();
    }
    if (wanted === null || vaultContentRevision(bytes) !== wanted) throw new VaultContentChangedError();
  }
}
async function prepare(root: string, guard: VaultGitGuard | undefined, paths: string[], companion: string | null): Promise<void> {
  if (guard) {
    await guard.revalidate();
    // pushURL and URL must each resolve to the one trusted local bare repository.
    for (const args of [["remote", "get-url", "--all", "origin"], ["remote", "get-url", "--push", "--all", "origin"]]) {
      const urls = runGit(root, args).trim().split("\n");
      if (urls.length !== 1 || !isAbsolute(urls[0]) || realpathSync(urls[0]) !== realpathSync(guard.localOrigin)) throw new Error("Vault local origin unavailable");
    }
    if (!lstatSync(guard.localOrigin).isDirectory() || runGit(guard.localOrigin, ["rev-parse", "--is-bare-repository"]).trim() !== "true") throw new Error("Vault local origin unavailable");
    if (companion !== (guard.companion?.path ?? null)) throw new VaultContentChangedError();
    if (guard.companion && guard.expectedContents[guard.companion.path] !== guard.companion.revision) throw new VaultContentChangedError();
    assertExpected(root, guard.expectedContents, paths);
  }
  if (runGit(root, ["diff", "--cached", "--name-only", "--ita-visible-in-index", "-z"]).length) throw new VaultStagedChangesError();
}

function gitShortHead(vaultRoot: string): string {
  return runGit(vaultRoot, ["rev-parse", "--short", "HEAD"]).toString().trim();
}

/** Push HEAD to origin, or throw `VaultPushFailedError` carrying the local commit hash. */
function gitPushOrThrow(vaultRoot: string, commit: string): void {
  try {
    runGit(vaultRoot, ["push", "-q", "origin", "HEAD"]);
  } catch (err) {
    throw new VaultPushFailedError(commit, err);
  }
}

/**
 * The text companion an article note names with `full_text:`, as a store-relative path beside
 * the note, or null (no key, an unsafe value, a missing file, or an unreadable note). Moves and
 * deletes use it so the note and its `.txt` always travel together; anything unexpected means
 * "no companion", never an error, so a plain note behaves exactly as before.
 */
export function vaultCompanionOf(vaultRoot: string, notePath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(resolveInStore(notePath, vaultRoot), "utf8");
  } catch {
    return null;
  }
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const value = text
    .slice(4, end)
    .match(new RegExp(`^${ARTICLE_FULL_TEXT_KEY}:[ \\t]*(.+)$`, "m"))?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (value === undefined) return null;
  const companion = articleCompanionPath(notePath, value);
  if (companion === null) return null;
  try {
    return existsSync(resolveInStore(companion, vaultRoot)) ? companion : null;
  } catch {
    return null;
  }
}

/** Create (or overwrite) a note with serialised frontmatter + body, commit, push. Used by
 *  `vault_write` for the `_inbox/<slug>.md` convention.
 *
 *  `message` is optional and defaults to the role-neutral `note: <path>` wording — no persona
 *  name, because the engine ships with none (this repo's own rule). It exists because the kit
 * is shared by more than one agent: a role's own write tool, or a scheduled job
 *  like the dream cycle's, can pass its own message, and the vault's git log is the only audit
 *  trail those writes have. */
export async function commitNote(opts: {
  vaultRoot: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  message?: string;
  guard?: VaultGitGuard;
}): Promise<VaultWriteResult> {
  const { vaultRoot, path, frontmatter, body } = opts;
  resolveInStore(path, vaultRoot);
  return withVaultRepositoryLock(vaultRoot, async () => {
    if (opts.guard) await opts.guard.revalidate();
    const abs = resolveInStore(path, vaultRoot); // throws NotePathEscapesStoreError first
    await prepare(vaultRoot, opts.guard, [path], null);
    resolveInStore(path, vaultRoot);
    mkdirSync(dirname(abs), { recursive: true });
    resolveInStore(path, vaultRoot);

    const content = `${serializeFrontmatter(frontmatter)}\n\n${body}`;
    writeFileSync(abs, content, "utf8");

    runGit(vaultRoot, ["add", "--", path]);
    runGit(vaultRoot, ["commit", "-q", "-m", opts.message ?? `note: ${path}`, "--", path]);
    const commit = gitShortHead(vaultRoot);
    gitPushOrThrow(vaultRoot, commit);
    return { commit };
  });
}

/** Move an existing note to a new path AS-IS via `git mv`, preserving its bytes and history
 *  (`git log --follow`). Used by `vault_file`. */
export async function moveNote(opts: {
  vaultRoot: string;
  sourcePath: string;
  destPath: string;
  message: string;
  guard?: VaultGitGuard;
}): Promise<VaultWriteResult> {
  const { vaultRoot, sourcePath, destPath, message } = opts;
  resolveInStore(sourcePath, vaultRoot);
  resolveInStore(destPath, vaultRoot);
  return withVaultRepositoryLock(vaultRoot, async () => {
    if (opts.guard) await opts.guard.revalidate();
    const destAbs = resolveInStore(destPath, vaultRoot);
    resolveInStore(sourcePath, vaultRoot); // reject traversal on the source too, before any git call

    // An article's text companion keeps its name and moves to the note's new folder.
    if (opts.guard) await opts.guard.revalidate();
    const companion = vaultCompanionOf(vaultRoot, sourcePath);
    const companionDest = companion === null ? null : articleCompanionPath(destPath, basename(companion));
    await prepare(vaultRoot, opts.guard, [sourcePath, destPath, ...(companion ? [companion] : []), ...(companionDest ? [companionDest] : [])], companion);
    // Refuse BEFORE the first move: failing between the two would leave the note moved and its text behind.
    if (companionDest !== null && companionDest !== companion && existsSync(resolveInStore(companionDest, vaultRoot))) {
      throw new Error(`cannot move ${sourcePath}: ${companionDest} already exists`);
    }

    if (existsSync(destAbs)) throw new Error("Vault destination already exists");
    mkdirSync(dirname(destAbs), { recursive: true });
    for (const p of [sourcePath, destPath, ...(companion ? [companion] : []), ...(companionDest ? [companionDest] : [])]) resolveInStore(p, vaultRoot);
    // git mv preserves the file's bytes (and its history) — a true move, not a rewrite.
    runGit(vaultRoot, ["mv", "--", sourcePath, destPath]);
    if (companion !== null && companionDest !== null && companionDest !== companion) {
      runGit(vaultRoot, ["mv", "--", companion, companionDest]);
    }
    runGit(vaultRoot, ["commit", "-q", "-m", message, "--", sourcePath, destPath, ...(companion ? [companion] : []), ...(companionDest ? [companionDest] : [])]);
    const commit = gitShortHead(vaultRoot);
    gitPushOrThrow(vaultRoot, commit);
    return { commit };
  });
}

/** Delete a note (`git rm`), committed + pushed so the removal is canonical + reversible via
 *  git history. Used by `vault_drop`. */
export async function removeNote(opts: {
  vaultRoot: string;
  path: string;
  message: string;
  guard?: VaultGitGuard;
}): Promise<VaultWriteResult> {
  const { vaultRoot, path, message } = opts;
  resolveInStore(path, vaultRoot);
  return withVaultRepositoryLock(vaultRoot, async () => {
    if (opts.guard) await opts.guard.revalidate();
    resolveInStore(path, vaultRoot); // reject traversal, before any git call

    if (opts.guard) await opts.guard.revalidate();
    const companion = vaultCompanionOf(vaultRoot, path);
    await prepare(vaultRoot, opts.guard, [path, ...(companion ? [companion] : [])], companion);
    resolveInStore(path, vaultRoot);
    if (companion) resolveInStore(companion, vaultRoot);
    runGit(vaultRoot, ["rm", "-q", "--", path]);
    if (companion !== null) runGit(vaultRoot, ["rm", "-q", "--ignore-unmatch", "--", companion]);
    runGit(vaultRoot, ["commit", "-q", "-m", message, "--", path, ...(companion ? [companion] : [])]);
    const commit = gitShortHead(vaultRoot);
    gitPushOrThrow(vaultRoot, commit);
    return { commit };
  });
}
