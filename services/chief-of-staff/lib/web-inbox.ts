/**
 * The web chat door's mailbox (`web_inbox`, box/sql/004_web_inbox.sql).
 *
 * eve's web channel has no `receive` handler, so an agent cannot start a turn that appears in an
 * open web chat the way it can in Slack or Telegram. The web door is therefore a plain table: the
 * agent writes the message here, and the console shows unread messages at the top of web chat and
 * as a dot in its navigation. Nothing is pushed; the console looks when the page opens and while
 * it is visible.
 */
import type { Pool } from "pg";

export interface InboxMessage {
  owner: string;
  agent: string;
  /** The schedule that wrote it (`morning-brief`, `crm-routing`, ...). */
  kind: string;
  title: string;
  /** What the owner reads. */
  body: string;
  /** What "Reply" opens a chat with, when it should differ from the body: for a message that
   *  asks the agent to act, the instruction the agent would have been given in a chat app. */
  context?: string;
  /** Same key the proactivity ledger uses, so a retried tick writes the message once. */
  itemKey: string;
}

export async function putInbox(db: Pick<Pool, "query">, m: InboxMessage): Promise<void> {
  await db.query(
    `INSERT INTO web_inbox (owner, agent, kind, title, body, context, item_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (owner, agent, item_key) DO NOTHING`,
    [m.owner, m.agent, m.kind, m.title, m.body, m.context ?? null, m.itemKey],
  );
}

/**
 * Remember, on the ledger's `sent` row, that the message did not go where the owner asked:
 * "Morning brief went to web chat: Telegram is not connected". Best effort - a ledger without the
 * column (migration not yet applied) costs the console its sentence, never the message.
 */
export async function recordFallback(
  db: Pick<Pool, "query">,
  row: { owner: string; agent: string; itemKey: string; note: string },
): Promise<void> {
  try {
    await db.query(
      `UPDATE initiations SET fallback_note = $4
        WHERE owner = $1 AND agent = $2 AND item_key = $3 AND status = 'sent'`,
      [row.owner, row.agent, row.itemKey, row.note],
    );
  } catch (e) {
    console.warn(`delivery: could not record the fallback for ${row.itemKey}`, e);
  }
}
