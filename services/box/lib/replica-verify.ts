import Database from "better-sqlite3";
import { ALWAYS_STRIPPED_CHANNELS, CONTENT_WINDOW_DAYS } from "@lares/network/lib/replica.js";

/**
 * Privacy gate for the agent box: assert the pushed network.db replica obeys
 * the content policy (mirrors services/network/lib/replica.ts):
 *   - Meta channels (facebook, instagram) NEVER carry content.
 *   - Every other channel only carries content within the rolling
 *     CONTENT_WINDOW_DAYS window (with one extra day of slack, since an
 *     export that ran before midnight can leave rows just inside the window
 *     but just past `now`).
 * If the table or column is absent, that is also acceptable (nothing to
 * leak); a row that violates either rule is a hard failure.
 */
export function verifyReplicaContentPolicy(
  dbPath: string,
  now: Date = new Date(),
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='interactions'")
      .get();
    if (!hasTable) return { ok: true, reasons };

    const cols = db.prepare("PRAGMA table_info(interactions)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "content")) return { ok: true, reasons };

    const metaPlaceholders = ALWAYS_STRIPPED_CHANNELS.map(() => "?").join(",");
    const metaLeak = db
      .prepare(`SELECT COUNT(*) AS n FROM interactions WHERE content IS NOT NULL AND channel IN (${metaPlaceholders})`)
      .get(...ALWAYS_STRIPPED_CHANNELS) as { n: number };
    if (metaLeak.n > 0) {
      reasons.push(`interactions.content: ${metaLeak.n} Meta row(s) (facebook/instagram) carry content`);
    }

    // one extra day of slack: an export that ran before midnight can leave rows
    // just inside the 90-day window but past `now − 90d` by the time this runs.
    const threshold = new Date(now.getTime() - (CONTENT_WINDOW_DAYS + 1) * 86_400_000).toISOString();
    const stale = db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(at) AS oldest FROM interactions WHERE content IS NOT NULL AND channel NOT IN (${metaPlaceholders}) AND at < ?`,
      )
      .get(...ALWAYS_STRIPPED_CHANNELS, threshold) as { n: number; oldest: string | null };
    if (stale.n > 0) {
      reasons.push(`interactions.content: ${stale.n} row(s) older than 90 days carry content (oldest at ${stale.oldest})`);
    }

    return { ok: reasons.length === 0, reasons };
  } finally {
    db.close();
  }
}

/** Alias — services/box/ops/push-network-replica.sh calls it by this
 * name via `tsx -e`; same gate, new rule (Meta stripped, 90-day window). */
export const verifyNoRawContent = verifyReplicaContentPolicy;
