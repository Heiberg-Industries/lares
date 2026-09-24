import { join } from "node:path";
import { homedir } from "node:os";
import type { Db } from "../db.js";
import { withSnapshot } from "../snapshot.js";
import { upsertContact, findContactByIdentity } from "../resolve.js";
import { normalizePhone, normalizeEmail } from "../normalize.js";
import { APPLE_EPOCH_OFFSET_S } from "./imessage.js";

export const DEFAULT_CALLDB_PATH = join(
  homedir(), "Library", "Application Support", "CallHistoryDB", "CallHistory.storedata",
);

export type CallsSummary = { calls: number; unanswered: number };

export function importCalls(db: Db, callDbPath: string = DEFAULT_CALLDB_PATH): CallsSummary {
  const summary: CallsSummary = { calls: 0, unanswered: 0 };
  withSnapshot(callDbPath, (snap) => {
    const rows = snap
      .prepare(
        `SELECT CAST(ZADDRESS AS TEXT) AS address, ZDATE AS date, ZDURATION AS duration,
                ZORIGINATED AS originated, ZANSWERED AS answered
         FROM ZCALLRECORD WHERE ZADDRESS IS NOT NULL`,
      )
      .all() as { address: string; date: number; duration: number; originated: number; answered: number }[];

    const ins = db.prepare(
      "INSERT OR IGNORE INTO interactions (contact_id, channel, direction, at, content, external_id, answered) VALUES (?, 'call', ?, ?, NULL, ?, ?)",
    );
    const tx = db.transaction(() => {
      for (const r of rows) {
        const identity = (() => {
          const phone = normalizePhone(r.address);
          if (phone) return { kind: "phone" as const, value: phone };
          const email = normalizeEmail(r.address); // FaceTime handles can be emails
          if (email) return { kind: "email" as const, value: email };
          return null;
        })();
        if (!identity) continue;
        let contactId = findContactByIdentity(db, identity.kind, identity.value);
        if (contactId === null) {
          contactId = upsertContact(db, { displayName: identity.value, source: "calls", identities: [identity], resolved: false });
        }
        const at = new Date((r.date + APPLE_EPOCH_OFFSET_S) * 1000).toISOString();
        const answeredFlag = r.answered ? 1 : 0;
        const changes = ins.run(contactId, r.originated ? "outbound" : "inbound", at, `call-${r.date}-${identity.value}`, answeredFlag).changes;
        if (r.answered) {
          summary.calls += changes;
        } else {
          summary.unanswered += changes;
        }
      }
    });
    tx();
  });
  return summary;
}
