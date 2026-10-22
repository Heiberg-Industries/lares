import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Run `fn` while holding an advisory lock on ONE vault note. Mirrors the
 * `note-lock.sh` flock pattern (the claude-obsidian pattern) but in-process,
 * for the chief-of-staff service's Brain write tools: writers to the SAME note serialise; writers
 * to different notes don't block each other. Locks are keyed by note path within
 * a single process via an in-memory promise chain, AND across processes via an
 * exclusive lockfile under `<vaultRoot>/.locks/`.
 *
 * Legacy note adapters use this lock; `vault-git.ts` instead takes the repository-wide
 * lock below because different notes share a Git index.
 */
const chains = new Map<string, Promise<unknown>>();

async function withFileLock(lockfile: string, fn: () => Promise<void>): Promise<void> {
  // Cross-process exclusivity: 'wx' fails if the lockfile already exists.
  const { open, rm } = await import("node:fs/promises");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      handle = await open(lockfile, "wx");
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) throw new Error(`note-lock: timed out on ${lockfile}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    await fn();
  } finally {
    await handle.close();
    await rm(lockfile, { force: true });
  }
}

export function withNoteLock<T>(
  vaultRoot: string,
  notePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = join(vaultRoot, ".locks");
  mkdirSync(lockDir, { recursive: true });
  const lockfile = join(lockDir, notePath.replace(/[/\\]/g, "_") + ".lock");

  // In-process: chain same-note calls so two awaits in one process also serialise.
  const prior = chains.get(lockfile) ?? Promise.resolve();
  let result!: T;
  // Wrap in a new promise so the eviction cleanup runs synchronously inside the
  // settlement path — before the awaiting caller resumes. A side-chain `.finally()`
  // would add extra microtask hops and the map entry would still be live when the
  // caller checks `__chainsSize()` immediately after `await`.
  const next: Promise<T> = new Promise<T>((resolve, reject) => {
    prior
      .catch(() => undefined)
      .then(() => withFileLock(lockfile, async () => { result = await fn(); }))
      .then(
        () => {
          if (chains.get(lockfile) === next) chains.delete(lockfile);
          resolve(result);
        },
        (err: unknown) => {
          if (chains.get(lockfile) === next) chains.delete(lockfile);
          reject(err);
        },
      );
  });
  chains.set(lockfile, next);

  return next;
}

/** Test-only: current number of retained in-flight chains. */
export function __chainsSize(): number {
  return chains.size;
}

/** Environment overrides must not redirect repository identity, index or local transport. */
export function vaultGitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
}

/** Git has one shared index per repository. This serializes callers using this API,
 * including writers of different notes and callers reaching the same repository by alias.
 * Legacy per-note writers are separate; guarded roots must not be shared with them.
 * Stale locks are never stolen automatically: a timed out writer refuses for operator review.
 * This is an advisory engine lock, not protection against hostile concurrent OS processes. */
export async function withVaultRepositoryLock<T>(vaultRoot: string, fn: () => Promise<T>): Promise<T> {
  const common = execFileSync("git", ["-C", vaultRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", env: vaultGitEnvironment(), stdio: ["ignore", "pipe", "pipe"] }).trim();
  const canonical = realpathSync(common);
  let result!: T;
  await withFileLock(join(canonical, "lares-vault.lock"), async () => { result = await fn(); });
  return result;
}

/** Exact ownership exception for the two installer-managed working-store families. Callers
 * must already have authorized and validated the inventory/area before reaching this helper.
 * The path shape is rechecked here so this cannot become a general Git trust switch. */
export async function withGuardedVaultRepositoryLock<T>(vaultRoot: string, localOrigin: string, fn: () => Promise<T>): Promise<T> {
  const match = /^\/srv\/vault\/(?:private|shared)\/([a-f0-9-]{36})$/.exec(vaultRoot);
  if (!match) return withVaultRepositoryLock(vaultRoot,fn);
  if (localOrigin !== `/var/lib/lares-vault-git/${match[1]}.git` ||
      realpathSync(vaultRoot) !== vaultRoot || realpathSync(localOrigin) !== localOrigin ||
      !lstatSync(join(vaultRoot, ".git")).isDirectory()) throw new Error("Vault repository unavailable");
  const common = execFileSync("git", ["-c", `safe.directory=${vaultRoot}`, "-C", vaultRoot,
    "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", env: vaultGitEnvironment(), stdio: ["ignore", "pipe", "pipe"] }).trim();
  const canonical = realpathSync(common);
  if (canonical !== join(vaultRoot, ".git")) throw new Error("Vault repository unavailable");
  let result!: T;
  await withFileLock(join(canonical, "lares-vault.lock"), async () => { result = await fn(); });
  return result;
}
