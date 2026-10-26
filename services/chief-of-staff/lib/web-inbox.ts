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
import { currentMember } from "@lares/agent-kit/member-store";
import { PgGrantStore } from "@lares/agent-kit/grant-store";

export interface WebContinuityFence {
  memberId: string;
  accessRevision: number;
  accountEpochs: { id: string; generation: number; lifecycleRevision: number; status: string }[];
}

async function currentFence(db: Pick<Pool, "query">, memberId: string, agent: string): Promise<WebContinuityFence | undefined> {
  const member = await currentMember(db as never, memberId, { lock: "share" });
  if (!member) return undefined;
  const accessRevision = await new PgGrantStore().captureUse(member.id, agent, { db: db as never });
  if (accessRevision === undefined) return undefined;
  const { rows } = await db.query<{ id: string; generation: number; lifecycle_revision: number; status: string }>(
    "SELECT id, generation, lifecycle_revision, status FROM connected_accounts WHERE owner_member_id=$1 ORDER BY id FOR SHARE", [member.id],
  );
  return { memberId: member.id, accessRevision, accountEpochs: rows.map(row => ({ id: row.id, generation: Number(row.generation), lifecycleRevision: Number(row.lifecycle_revision), status: row.status })) };
}

/** Capture before the web-only model call. A reconnect while that call is running invalidates
 *  publication; later reconnects invalidate retrieval. This fence is deliberately conservative:
 *  any connected-account lifecycle change retires the post. */
export async function captureWebContinuityFence(db: Pick<Pool, "query" >, memberId: string, agent: string): Promise<WebContinuityFence | undefined> {
  const pool = db as Pool;
  if (typeof pool.connect !== "function") return currentFence(db, memberId, agent);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fence = await currentFence(client, memberId, agent);
    await client.query("COMMIT");
    return fence;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export interface InboxMessage {
  owner: string;
  agent: string;
  /** The schedule that wrote it (`morning-brief`, `track-routing`, ...). */
  kind: string;
  title: string;
  /** What the owner reads. */
  body: string;
  /** What "Reply" opens a chat with, when it should differ from the body: for a message that
   *  asks the agent to act, the instruction the agent would have been given in a chat app. */
  context?: string;
  /** Same key the proactivity ledger uses, so a retried tick writes the message once. */
  itemKey: string;
  /** Present only when captured before generated web text and unchanged at publication. */
  continuityFence?: WebContinuityFence;
}

export async function putInbox(db: Pick<Pool, "query">, m: InboxMessage): Promise<void> {
  const pool = db as Pool;
  const tx = typeof pool.connect === "function" ? await pool.connect() : undefined;
  const client = tx ?? db;
  try {
    if (tx) await tx.query("BEGIN");
    let fence: WebContinuityFence | undefined;
    if (m.continuityFence) {
      const current = await currentFence(client, m.owner, m.agent);
      if (current && JSON.stringify(current) === JSON.stringify(m.continuityFence)) fence = current;
    }
    await client.query(
      `INSERT INTO web_inbox (owner, agent, kind, title, body, context, item_key, continuity_member_id, continuity_access_revision, source_account_epochs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (owner, agent, item_key) DO NOTHING`,
      [m.owner, m.agent, m.kind, m.title, m.body, m.context ?? null, m.itemKey, fence?.memberId ?? null,
        fence?.accessRevision ?? null, fence ? JSON.stringify(fence.accountEpochs) : null],
    );
    if (tx) await tx.query("COMMIT");
  } catch (error) {
    if (tx) await tx.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    tx?.release();
  }
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
