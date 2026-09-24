import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A single-flight refresh lock, box-local: it makes `fn` (a token refresh) run at most
 * once at a time for a given `key`, across every process on this box.
 *
 * A second caller that arrives while another is refreshing does NOT run `fn` itself —
 * it waits for the winner, then re-reads through `recheck`. That is what makes this
 * single-flight rather than merely serialised: a plain mutex would let the second caller
 * refresh again once the first releases, which is exactly the case ADR-0019 rule 2 exists
 * to prevent (two agents each getting a new OAuth token for the same stored grant, each
 * invalidating the other's — a vendor may then revoke the whole grant, forcing the owner
 * to sign in again). If the winner finishes without `recheck` ever producing a value (it
 * threw, or it simply didn't persist anything the waiter can see), the waiter takes the
 * now-free lock and refreshes itself rather than hanging.
 *
 * Cross-process: an exclusive lock DIRECTORY under `config.root`, acquired with a bare
 * `mkdirSync` (no `recursive: true`) — atomic create-or-`EEXIST` on every filesystem, which
 * is the whole mechanism. Mirrors `note-lock.ts:40-77`'s flock-style directory lock. This is
 * what covers three role containers on one box sharing one stored sign-in (`google-auth.ts`'s
 * five wirings).
 *
 * In-process: the exact same directory-and-poll path handles it too, deliberately, rather
 * than layering an extra in-process promise chain on top (`note-lock.ts`'s `Map<string,
 * Promise<unknown>>`). That layering was tried and rejected here: because Node's fs calls are
 * synchronous and single-threaded, two same-process callers already can't both succeed at
 * `mkdirSync` for the same key — one always gets `EEXIST` deterministically, with no
 * coalescing needed to prevent a double-acquire. Chaining the SECOND caller fully behind the
 * FIRST's entire completion (queue rather than race) would instead make it start its own
 * `acquireDirLock` only after the first has already released the directory — at which point
 * it would win `mkdirSync` and run `fn` again itself, defeating single-flight for same-process
 * callers. Racing both into the same wait-and-poll-`recheck` loop the cross-process case uses
 * is what makes one process's two callers behave the same as two processes' callers.
 *
 * NOT a distributed lock. It is box-local, and it depends on every agent seeing the same
 * `root` — on the box that means a shared tmpfs, and in wave 8 it means one the installer
 * creates. That limitation is deliberate, not an oversight.
 *
 * Nothing is wired to this in this wave. Moving `google-auth.ts`'s five Google wirings onto
 * it is a later change; doing it here would be a refactor bundled into a foundation.
 */

const DEFAULT_ROOT = join(tmpdir(), "lares-refresh-locks");
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_WAIT_MS = 20_000;
const POLL_MS = 50;

export interface RefreshLockConfig {
  /** Where the lock directories live. Defaults to `${os.tmpdir()}/lares-refresh-locks`. */
  root?: string;
  /** A held lock older than this is assumed abandoned. Default 30_000. */
  staleMs?: number;
  /** How long to wait for another holder before giving up. Default 20_000. */
  waitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface ResolvedConfig {
  root: string;
  staleMs: number;
  waitMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function resolveConfig(config?: RefreshLockConfig): ResolvedConfig {
  return {
    root: config?.root ?? DEFAULT_ROOT,
    staleMs: config?.staleMs ?? DEFAULT_STALE_MS,
    waitMs: config?.waitMs ?? DEFAULT_WAIT_MS,
    now: config?.now ?? Date.now,
    sleep: config?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/** A key can never escape `root`: everything outside this set becomes `_`. */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function heldAtMs(dir: string): number | undefined {
  try {
    const raw = readFileSync(join(dir, "held-at"), "utf8");
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function tryAcquire(dir: string): boolean {
  try {
    mkdirSync(dir);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function withRefreshImpl<T>(
  cfg: ResolvedConfig,
  key: string,
  fn: () => Promise<T>,
  recheck: () => Promise<T | undefined>,
): Promise<T> {
  const dir = join(cfg.root, safeKey(key));
  mkdirSync(cfg.root, { recursive: true });

  const deadline = cfg.now() + cfg.waitMs;

  for (;;) {
    if (tryAcquire(dir)) {
      writeFileSync(join(dir, "held-at"), String(cfg.now()));
      try {
        return await fn();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // Someone else holds it (in this process or another). A held-at we can't read means
    // the holder is mid-acquire or already gone — treat it the same as stale, so a crash
    // between mkdir and the held-at write can never wedge the key forever.
    const heldAt = heldAtMs(dir);
    if (heldAt === undefined || cfg.now() - heldAt > cfg.staleMs) {
      console.warn(
        `refresh-lock: breaking stale lock for ${key} (held ${heldAt === undefined ? "with no readable timestamp" : `${cfg.now() - heldAt}ms`})`,
      );
      rmSync(dir, { recursive: true, force: true });
      continue; // retry the acquire immediately — no need to wait behind a dead holder
    }

    if (cfg.now() >= deadline) {
      throw new Error(`refresh-lock: another process is still refreshing ${key} after ${cfg.waitMs}ms`);
    }

    await cfg.sleep(POLL_MS);

    const result = await recheck();
    if (result !== undefined) return result;
    // Nothing to read yet. Loop back to the top: either the holder still has it (another
    // EEXIST, another wait) or it has finished and released — in which case `tryAcquire`
    // now succeeds and we become the new holder, refreshing ourselves.
  }
}

export function makeRefreshLock(config?: RefreshLockConfig): {
  withRefresh<T>(key: string, fn: () => Promise<T>, recheck: () => Promise<T | undefined>): Promise<T>;
} {
  const cfg = resolveConfig(config);
  return {
    withRefresh: (key, fn, recheck) => withRefreshImpl(cfg, key, fn, recheck),
  };
}
