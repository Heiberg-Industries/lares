import { openDbReadOnly } from "@lares/network/lib/db.js";
import { whoAt, dormantQueue, personProfile } from "@lares/network/lib/queries.js";

/**
 * Returns an async query function backed by the read-only network replica.
 *
 * The db is opened per call so the handle always reads the current inode —
 * the replica is atomically replaced by a daily `mv`, meaning a long-lived
 * handle would keep reading the old file after rotation.
 */
export function makeNetworkQuery(dbPath: string) {
  return async function query(verb: string, args: Record<string, unknown>): Promise<unknown> {
    const db = openDbReadOnly(dbPath);
    try {
      switch (verb) {
        case "who-at":
          return whoAt(db, String(args.company ?? ""));
        case "dormant":
          return dormantQueue(db, Number(args.limit ?? 25));
        case "person":
          return personProfile(db, String(args.name ?? ""));
        default:
          throw new Error(`unknown network verb: ${verb}`);
      }
    } finally {
      db.close();
    }
  };
}
