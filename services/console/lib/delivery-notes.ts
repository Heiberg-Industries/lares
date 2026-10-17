/**
 * "Morning brief went to web chat: Telegram is not connected" - for each kind of message, the note
 * on its LATEST sent message when that message did not go where the owner asked. A kind whose latest
 * message went where it was asked has no note: the sentence goes away once the problem does.
 *
 * Reads `initiations.fallback_note` (box/sql/004_web_inbox.sql). A database without the column
 * answers with no notes rather than an error: the grid is still usable.
 */
import { DELIVERY_KIND_LIST, ITEM_PREFIX, type DeliveryKind } from "./delivery";
import { pool } from "./db";
import { ownerId } from "./proactivity";

export async function fallbackNotes(agent: string): Promise<Partial<Record<DeliveryKind, string>>> {
  try {
    const { rows } = await pool.query<{ item_key: string; fallback_note: string | null }>(
      `SELECT item_key, fallback_note FROM initiations
        WHERE owner = $1 AND agent = $2 AND status = 'sent'
        ORDER BY id DESC LIMIT 300`,
      [ownerId(), agent],
    );
    const out: Partial<Record<DeliveryKind, string>> = {};
    const seen = new Set<DeliveryKind>();
    for (const row of rows) {
      const kind = DELIVERY_KIND_LIST.find((k) => row.item_key.startsWith(`${ITEM_PREFIX[k]}/`));
      if (!kind || seen.has(kind)) continue;
      seen.add(kind);
      if (row.fallback_note) out[kind] = row.fallback_note;
    }
    return out;
  } catch {
    return {};
  }
}
