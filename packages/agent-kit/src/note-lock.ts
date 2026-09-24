import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Run `fn` while holding an advisory lock on ONE vault note. Mirrors the
 * `note-lock.sh` flock pattern (the claude-obsidian pattern) but in-process,
 * for eve-saga's Brain write tools: writers to the SAME note serialise; writers
 * to different notes don't block each other. Locks are keyed by note path within
 * a single process via an in-memory promise chain, AND across processes via an
 * exclusive lockfile under `<vaultRoot>/.locks/`.
 *
 * Ported unmodified from `services/box/lib/note-lock.ts` (Task 9) — every
 * git-writing operation in `lib/vault-git.ts` depends on it.
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
