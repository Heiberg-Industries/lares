import { join } from "node:path";
import { homedir } from "node:os";
import type { Db } from "../db.js";
import { withSnapshot } from "../snapshot.js";
import { upsertContact, findContactByIdentity } from "../resolve.js";
import { normalizeEmail, normalizePhone } from "../normalize.js";
import { decodeAttributedBody } from "./attributed-body.js";

export const DEFAULT_CHATDB_PATH = join(homedir(), "Library", "Messages", "chat.db");
/** Apple epochs count from 2001-01-01T00:00:00Z. */
export const APPLE_EPOCH_OFFSET_S = 978307200;

export type IMessageSummary = { messages: number; newHandles: number; backfilled: number };

function handleToIdentity(handle: string): { kind: "email" | "phone"; value: string } | null {
  const email = normalizeEmail(handle);
  if (email) return { kind: "email", value: email };
  const phone = normalizePhone(handle);
  if (phone) return { kind: "phone", value: phone };
  return null;
}

export function importIMessage(db: Db, chatDbPath: string = DEFAULT_CHATDB_PATH): IMessageSummary {
  const summary: IMessageSummary = { messages: 0, newHandles: 0, backfilled: 0 };
  withSnapshot(chatDbPath, (snap) => {
    const rows = snap
      .prepare(
        `SELECT m.guid AS guid, m.date AS date, m.is_from_me AS fromMe, m.text AS text, m.attributedBody AS attributedBody, h.id AS handle
         FROM message m JOIN handle h ON m.handle_id = h.ROWID
         WHERE m.date > 0`,
      )
      .all() as { guid: string; date: number; fromMe: number; text: string | null; attributedBody: Buffer | null; handle: string }[];

    const ins = db.prepare(
      "INSERT OR IGNORE INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (?, 'imessage', ?, ?, ?, ?)",
    );
    const upd = db.prepare(
      "UPDATE interactions SET content = ? WHERE channel = 'imessage' AND external_id = ? AND content IS NULL",
    );
    const contactCache = new Map<string, number>();

    const tx = db.transaction(() => {
      for (const r of rows) {
        const identity = handleToIdentity(r.handle);
        if (!identity) continue;
        let contactId = contactCache.get(identity.value);
        if (contactId === undefined) {
          const existing = findContactByIdentity(db, identity.kind, identity.value);
          if (existing !== null) contactId = existing;
          else {
            contactId = upsertContact(db, { displayName: identity.value, source: "imessage", identities: [identity], resolved: false });
            summary.newHandles++;
          }
          contactCache.set(identity.value, contactId);
        }
        const at = new Date((r.date / 1e9 + APPLE_EPOCH_OFFSET_S) * 1000).toISOString();
        const content = r.text ?? decodeAttributedBody(r.attributedBody);
        const inserted = ins.run(contactId, r.fromMe ? "outbound" : "inbound", at, content, r.guid).changes;
        summary.messages += inserted;
        // Backfill: if INSERT didn't add a new row (changes === 0) and we have decodable content,
        // try to update rows that were previously imported with NULL content.
        if (inserted === 0 && content !== null) {
          summary.backfilled += upd.run(content, r.guid).changes;
        }
      }
    });
    tx();
  });
  return summary;
}
