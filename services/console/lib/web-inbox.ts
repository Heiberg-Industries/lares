/**
 * The web chat inbox: messages an agent wrote to the owner's web chat door (`web_inbox`,
 * box/sql/004_web_inbox.sql). Web chat cannot be pushed into, so the console looks: when the page
 * opens, and while it is visible (`InboxPanel`, `InboxDot`).
 *
 * Every read degrades to "nothing" when the table is not there yet (a box that has not applied the
 * migration): the chat must keep working without it.
 */
import { pool } from "./db";
import { ownerId } from "./proactivity";

export interface InboxMessage {
  id: number;
  agent: string;
  kind: string;
  title: string;
  body: string;
  /** Present when a reply should start from an instruction rather than from the text shown. */
  context: string | null;
  createdAt: string;
  read: boolean;
}

interface Row {
  id: string | number; agent: string; kind: string; title: string; body: string;
  context: string | null; created_at: Date | string; read_at: Date | string | null;
}

const toMessage = (r: Row): InboxMessage => ({
  id: Number(r.id), agent: r.agent, kind: r.kind, title: r.title, body: r.body, context: r.context,
  createdAt: new Date(r.created_at).toISOString(), read: r.read_at !== null,
});

const missingTable = (e: unknown) => (e as { code?: string })?.code === "42P01";

/** Unread messages for one agent (newest first), plus a few already-read ones for "earlier". */
export async function readInbox(agent: string, opts: { earlier?: number } = {}): Promise<{ unread: InboxMessage[]; earlier: InboxMessage[] }> {
  try {
    const owner = ownerId();
    const unread = await pool.query<Row>(
      `SELECT id, agent, kind, title, body, context, created_at, read_at FROM web_inbox
        WHERE owner = $1 AND agent = $2 AND read_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 50`,
      [owner, agent],
    );
    const earlier = opts.earlier
      ? await pool.query<Row>(
          `SELECT id, agent, kind, title, body, context, created_at, read_at FROM web_inbox
            WHERE owner = $1 AND agent = $2 AND read_at IS NOT NULL ORDER BY read_at DESC, id DESC LIMIT $3`,
          [owner, agent, opts.earlier],
        )
      : { rows: [] as Row[] };
    return { unread: unread.rows.map(toMessage), earlier: earlier.rows.map(toMessage) };
  } catch (e) {
    if (!missingTable(e)) console.warn("web inbox: could not read", e);
    return { unread: [], earlier: [] };
  }
}

/** Unread count across every agent, for the navigation dot. */
export async function unreadCount(): Promise<number> {
  try {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM web_inbox WHERE owner = $1 AND read_at IS NULL`,
      [ownerId()],
    );
    return rows[0]?.n ?? 0;
  } catch (e) {
    if (!missingTable(e)) console.warn("web inbox: could not count", e);
    return 0;
  }
}

/** One message of this owner and agent, or null. */
export async function getInboxMessage(agent: string, id: number): Promise<InboxMessage | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  try {
    const { rows } = await pool.query<Row>(
      `SELECT id, agent, kind, title, body, context, created_at, read_at FROM web_inbox
        WHERE owner = $1 AND agent = $2 AND id = $3`,
      [ownerId(), agent, id],
    );
    return rows[0] ? toMessage(rows[0]) : null;
  } catch (e) {
    if (!missingTable(e)) console.warn("web inbox: could not read a message", e);
    return null;
  }
}

/** Mark one message (or, with no id, every unread message of the agent) as read. */
export async function markInboxRead(agent: string, id?: number): Promise<void> {
  await pool.query(
    id === undefined
      ? `UPDATE web_inbox SET read_at = now() WHERE owner = $1 AND agent = $2 AND read_at IS NULL`
      : `UPDATE web_inbox SET read_at = now() WHERE owner = $1 AND agent = $2 AND id = $3 AND read_at IS NULL`,
    id === undefined ? [ownerId(), agent] : [ownerId(), agent, id],
  );
}

/**
 * What a chat starts with when the owner presses "Reply" on a message. A message that asks the
 * agent to act carries its instruction (`context`) and that is what the chat starts with; any other
 * message is quoted, so the agent has it in front of it.
 */
export function replySeed(m: Pick<InboxMessage, "title" | "body" | "context">): string {
  if (m.context) return m.context;
  const quoted = m.body.slice(0, 1500).split("\n").map((l) => `> ${l}`).join("\n");
  return `About your message "${m.title}":\n\n${quoted}\n\n`;
}
