import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * Copy an SQLite db (and its -wal/-shm sidecars, which hold un-checkpointed
 * writes) to a temp dir, open the copy read-only, run `fn`, clean up.
 * Used for Apple's live databases (Messages, Contacts, CallHistory) which
 * other processes keep open.
 */
export function withSnapshot<T>(sourcePath: string, fn: (db: Database.Database) => T): T {
  if (!existsSync(sourcePath)) {
    throw new Error(
      `Database not found: ${sourcePath}. If this is an Apple database, ` +
        `check that your terminal has Full Disk Access (System Settings → Privacy & Security).`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "lares-network-snap-"));
  try {
    const dest = join(dir, basename(sourcePath));
    copyFileSync(sourcePath, dest);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(sourcePath + ext)) copyFileSync(sourcePath + ext, dest + ext);
    }
    const db = new Database(dest, { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
