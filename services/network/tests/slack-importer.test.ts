import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../lib/db.js";
import { upsertContact } from "../lib/resolve.js";
import {
  importSlack,
  SlackInvalidCursorError,
  SlackRateLimitError,
  type SlackConversation,
  type SlackMessage,
  type SlackReader,
  type SlackThreadReply,
  type SlackUserInfo,
} from "../lib/importers/slack.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

const OWN = "U-BENDIK";
const PAGE_SIZE = 2;

/** Builds a SlackMessage with the (now-required) mentions/threadHasOwnReply/threadReplies defaulted to "irrelevant", overridable via `extra`. */
function msg(ts: string, user: string | undefined, extra: Partial<SlackMessage> = {}): SlackMessage {
  return { ts, user, mentions: [], threadHasOwnReply: false, threadReplies: [], ...extra };
}

/** One reply inside a thread, as the reader hands it to the importer (ORB-149 defect 2). */
function reply(ts: string, user: string | undefined, extra: Partial<SlackThreadReply> = {}): SlackThreadReply {
  return { ts, user, ...extra };
}

/**
 * A fake SlackReader over an in-memory fixture. Mirrors real Slack behaviour
 * closely enough to exercise cursoring: `conversations.history` returns
 * pages newest-first, honours `oldest` (strictly-after, i.e. exclusive) and
 * paginates via an opaque numeric-string cursor.
 */
function makeFakeReader(opts: {
  conversations: SlackConversation[];
  messagesByConversation: Record<string, SlackMessage[]>; // must be pre-sorted newest-first
  users: Record<string, SlackUserInfo>;
  /** conversation id -> error to throw on its FIRST history() call this run */
  historyErrors?: Record<string, Error>;
  /** userId -> error to throw EVERY time getUserInfo(userId) is called (review round 3,
   *  Important — pins the C2 property at the IMPORTER level: a resolver failure, not just a
   *  reader-level throw, must not advance the cursor past the message it was resolving). */
  getUserInfoErrors?: Record<string, Error>;
  /** Pagination cursors Slack has "forgotten" — history() throws SlackInvalidCursorError for
   *  any cursor in this set, every time. Mutable so a test can heal it between runs, which is
   *  exactly what Slack does when a fresh walk starts (ORB-149 defect 3). */
  invalidCursors?: Set<string>;
}): SlackReader & {
  historyCalls: { conversationId: string; oldest: string | undefined; cursor: string | undefined }[];
  getUserInfoCalls: string[];
} {
  const historyCalls: { conversationId: string; oldest: string | undefined; cursor: string | undefined }[] = [];
  const getUserInfoCalls: string[] = [];
  const thrown = new Set<string>();
  return {
    historyCalls,
    getUserInfoCalls,
    async listConversations() {
      return opts.conversations;
    },
    async history(conversationId, oldest, cursor) {
      historyCalls.push({ conversationId, oldest, cursor });
      const err = opts.historyErrors?.[conversationId];
      if (err && !thrown.has(conversationId)) {
        thrown.add(conversationId);
        throw err;
      }
      if (cursor && opts.invalidCursors?.has(cursor)) {
        throw new SlackInvalidCursorError(`Slack conversations.history rejected cursor ${cursor} as invalid_cursor.`);
      }
      const all = opts.messagesByConversation[conversationId] ?? [];
      const filtered = oldest ? all.filter((m) => parseFloat(m.ts) > parseFloat(oldest)) : all;
      const start = cursor ? parseInt(cursor, 10) : 0;
      const page = filtered.slice(start, start + PAGE_SIZE);
      const nextStart = start + PAGE_SIZE;
      const nextCursor = nextStart < filtered.length ? String(nextStart) : null;
      // Mirrors the real reader's call pattern: one conversations.replies request per thread
      // parent that has replies, made while assembling this page (slack-reader.ts).
      const repliesRequests = page.filter((m) => m.threadReplies.length > 0).length;
      return { messages: page, nextCursor, repliesRequests };
    },
    async getUserInfo(userId) {
      getUserInfoCalls.push(userId);
      const err = opts.getUserInfoErrors?.[userId];
      if (err) throw err;
      return opts.users[userId] ?? null;
    },
  };
}

describe("importSlack", () => {
  it("classifies direction: own user id outbound, others inbound (im: both directions always)", async () => {
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-OTHER" }],
      messagesByConversation: {
        D1: [msg("1700000002.000100", "U-OTHER"), msg("1700000001.000100", OWN)],
      },
      users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
    });

    await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    const rows = db.prepare("SELECT direction FROM interactions WHERE channel='slack' ORDER BY at").all() as { direction: string }[];
    expect(rows).toEqual([{ direction: "outbound" }, { direction: "inbound" }]);
  });

  it("content is NULL on every written row — the privacy boundary (im AND mpim fan-out)", async () => {
    const reader = makeFakeReader({
      conversations: [
        { id: "D1", type: "im", counterpartyUserId: "U-OTHER" },
        { id: "G1", type: "mpim", members: [OWN, "U-A", "U-B"] },
      ],
      messagesByConversation: {
        D1: [msg("1700000001.000100", "U-OTHER")],
        G1: [msg("1700000002.000100", OWN)], // fans out to U-A and U-B
      },
      users: {
        "U-OTHER": { id: "U-OTHER", email: "other@example.com", displayName: "Other Person" },
        "U-A": { id: "U-A", email: null, displayName: "A" },
        "U-B": { id: "U-B", email: null, displayName: "B" },
      },
    });

    await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    const rows = db.prepare("SELECT content FROM interactions WHERE channel='slack'").all() as { content: unknown }[];
    expect(rows.length).toBe(3); // 1 from D1 + 2 fan-out rows from G1
    for (const r of rows) expect(r.content).toBeNull();
  });

  it("idempotent re-import: running twice writes the same rows once", async () => {
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-OTHER" }],
      messagesByConversation: {
        D1: [msg("1700000003.000100", "U-OTHER"), msg("1700000002.000100", OWN), msg("1700000001.000100", "U-OTHER")],
      },
      users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
    });
    const now = () => new Date("2026-08-24T00:00:00Z");

    const first = await importSlack(db, reader, { ownUserId: OWN, now });
    expect(first.interactionRowsWritten).toBe(3);

    const second = await importSlack(db, reader, { ownUserId: OWN, now });
    expect(second.interactionRowsWritten).toBe(0);
    // nothing to process at all this run — the persisted cursor already excludes all 3 (see the
    // dedicated "does not rescan" test below); messagesProcessed reflects that correctly, not 3.
    expect(second.messagesProcessed).toBe(0);

    const total = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
    expect(total.n).toBe(3);
  });

  it("messagesProcessed counts a re-scanned duplicate message, not just net-new rows", async () => {
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-OTHER" }],
      messagesByConversation: { D1: [msg("1700000001.000100", "U-OTHER")] },
      users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
    });
    const now = () => new Date("2026-08-24T00:00:00Z");

    const first = await importSlack(db, reader, { ownUserId: OWN, now });
    expect(first.interactionRowsWritten).toBe(1);
    expect(first.messagesProcessed).toBe(1);

    // Force a genuine re-scan of the same message (simulates a cursor reset/replay) rather than
    // relying on the normal "cursor already excludes it" path.
    db.prepare("DELETE FROM slack_cursors WHERE conversation_id='D1'").run();

    const second = await importSlack(db, reader, { ownUserId: OWN, now });
    expect(second.interactionRowsWritten).toBe(0); // INSERT OR IGNORE — no new row
    expect(second.messagesProcessed).toBe(1); // but it WAS processed — the counts are decoupled
  });

  it("advances the cursor so a second run does not rescan history", async () => {
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-OTHER" }],
      messagesByConversation: {
        D1: [msg("1700000002.000100", "U-OTHER"), msg("1700000001.000100", "U-OTHER")],
      },
      users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
    });
    const now = () => new Date("2026-08-24T00:00:00Z");

    await importSlack(db, reader, { ownUserId: OWN, now });
    const cursorAfterFirst = db.prepare("SELECT oldest FROM slack_cursors WHERE conversation_id='D1'").get() as { oldest: string };
    expect(cursorAfterFirst.oldest).toBe("1700000002.000100"); // the newest ts seen

    reader.historyCalls.length = 0;
    await importSlack(db, reader, { ownUserId: OWN, now });
    // second run passed the persisted cursor as `oldest`, and no message qualified
    expect(reader.historyCalls[0]!.oldest).toBe("1700000002.000100");
    const total = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
    expect(total.n).toBe(2);
  });

  it("a participant with an email joins an existing contact rather than creating a new one", async () => {
    const existing = upsertContact(db, {
      displayName: "Jannik Existing",
      source: "contacts",
      identities: [{ kind: "email", value: "jannik@example.com" }],
    });
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-JANNIK" }],
      messagesByConversation: {
        D1: [msg("1700000001.000100", "U-JANNIK")],
      },
      users: { "U-JANNIK": { id: "U-JANNIK", email: "Jannik@Example.com", displayName: "Jannik Slack Name" } },
    });

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    expect(summary.linkedExisting).toBe(1);
    expect(summary.newContacts).toBe(0);
    const row = db.prepare("SELECT contact_id FROM interactions WHERE channel='slack'").get() as { contact_id: number };
    expect(row.contact_id).toBe(existing);
    const contactCount = db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number };
    expect(contactCount.n).toBe(1); // no duplicate contact created
  });

  it("a participant without an email falls back to a display-name contact", async () => {
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-NOMAIL" }],
      messagesByConversation: {
        D1: [msg("1700000001.000100", "U-NOMAIL")],
      },
      users: { "U-NOMAIL": { id: "U-NOMAIL", email: null, displayName: "No Email Person" } },
    });

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    expect(summary.newContacts).toBe(1);
    const contact = db.prepare("SELECT display_name, resolved FROM contacts").get() as { display_name: string; resolved: number };
    expect(contact.display_name).toBe("No Email Person");
    expect(contact.resolved).toBe(0);

    // re-running finds the SAME contact via the persisted slack_user identity — no duplicate
    const second = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });
    expect(second.newContacts).toBe(0);
    const count = db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("a getUserInfo miss (deactivated/invisible Slack user) creates no junk contact and no row", async () => {
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-GHOST" }],
      messagesByConversation: {
        D1: [msg("1700000001.000100", "U-GHOST")],
      },
      users: {}, // U-GHOST resolves to null
    });

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    expect(summary.interactionRowsWritten).toBe(0);
    expect(summary.messagesProcessed).toBe(1); // still processed — determined unresolvable, not abandoned
    expect(summary.newContacts).toBe(0);
    const contactCount = db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number };
    expect(contactCount.n).toBe(0);
    const rowCount = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
    expect(rowCount.n).toBe(0);
  });

  it("records a slack import_runs row every run", async () => {
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-OTHER" }],
      messagesByConversation: { D1: [msg("1700000001.000100", "U-OTHER")] },
      users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
    });

    await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    const runs = db.prepare("SELECT source FROM import_runs WHERE source='slack'").all() as { source: string }[];
    expect(runs.length).toBe(1);
  });

  it("honours the per-run message cap and reports it in stoppedEarly", async () => {
    const messages: SlackMessage[] = [];
    for (let i = 10; i >= 1; i--) messages.push(msg(`170000000${i}.000100`, "U-OTHER"));
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-OTHER" }],
      messagesByConversation: { D1: messages },
      users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
    });

    const summary = await importSlack(db, reader, {
      ownUserId: OWN,
      now: () => new Date("2026-08-24T00:00:00Z"),
      maxMessagesPerRun: 3,
    });

    expect(summary.interactionRowsWritten).toBe(3);
    expect(summary.stoppedEarly).toEqual({ reason: "messages" });
    const total = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
    expect(total.n).toBe(3);
  });

  it("resumes a capped mid-backlog scan on the next run instead of restarting it", async () => {
    const messages: SlackMessage[] = [];
    for (let i = 6; i >= 1; i--) messages.push(msg(`170000000${i}.000100`, "U-OTHER"));
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-OTHER" }],
      messagesByConversation: { D1: messages },
      users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
    });
    const now = () => new Date("2026-08-24T00:00:00Z");

    const first = await importSlack(db, reader, { ownUserId: OWN, now, maxMessagesPerRun: 3 });
    expect(first.interactionRowsWritten).toBe(3);
    expect(first.stoppedEarly).toEqual({ reason: "messages" });

    const second = await importSlack(db, reader, { ownUserId: OWN, now, maxMessagesPerRun: 10 });
    expect(second.interactionRowsWritten).toBe(3); // the remaining 3, not a rescan of all 6
    expect(second.stoppedEarly).toBeUndefined(); // this run genuinely finished

    const total = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
    expect(total.n).toBe(6);
  });

  it("does NOT report stoppedEarly when the budget exactly fits the available history (no false positive)", async () => {
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-OTHER" }],
      messagesByConversation: {
        D1: [msg("1700000002.000100", "U-OTHER"), msg("1700000001.000100", "U-OTHER")],
      },
      users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
    });

    const summary = await importSlack(db, reader, {
      ownUserId: OWN,
      now: () => new Date("2026-08-24T00:00:00Z"),
      maxMessagesPerRun: 2, // exactly matches the one page of history available
    });

    expect(summary.interactionRowsWritten).toBe(2);
    expect(summary.stoppedEarly).toBeUndefined();
  });

  it("reports stoppedEarly: pages when maxPagesPerConversation is hit before the conversation is exhausted", async () => {
    const messages: SlackMessage[] = [];
    for (let i = 6; i >= 1; i--) messages.push(msg(`170000000${i}.000100`, "U-OTHER"));
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-OTHER" }],
      messagesByConversation: { D1: messages },
      users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
    });

    const summary = await importSlack(db, reader, {
      ownUserId: OWN,
      now: () => new Date("2026-08-24T00:00:00Z"),
      maxMessagesPerRun: 100,
      maxPagesPerConversation: 1, // only the first 2-message page
    });

    expect(summary.interactionRowsWritten).toBe(2);
    expect(summary.stoppedEarly).toEqual({ reason: "pages" });
  });

  it("throws a clear, actionable error instead of silently stalling forever when a page exceeds the whole run's budget", async () => {
    const messages: SlackMessage[] = [];
    for (let i = 6; i >= 1; i--) messages.push(msg(`170000000${i}.000100`, "U-OTHER"));
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-OTHER" }],
      messagesByConversation: { D1: messages },
      users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
    });
    const now = () => new Date("2026-08-24T00:00:00Z");

    // PAGE_SIZE is 2; a cap of 1 can never complete even the first page.
    const first = await importSlack(db, reader, { ownUserId: OWN, now, maxMessagesPerRun: 1 });
    expect(first.errors.length).toBe(1);
    expect(first.errors[0]!.conversationId).toBe("D1");
    expect(first.errors[0]!.error).toMatch(/maxMessagesPerRun/);
    expect(first.interactionRowsWritten).toBe(1); // whatever fit before the stall was detected — not silently discarded

    // it keeps failing LOUDLY every run — never silently "succeeds" with zero progress on 2..6
    const second = await importSlack(db, reader, { ownUserId: OWN, now, maxMessagesPerRun: 1 });
    expect(second.errors.length).toBe(1);
    expect(second.interactionRowsWritten).toBe(0); // message 1 was a no-op re-insert; message 2 still unreachable

    const total = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
    expect(total.n).toBe(1);
  });

  it("a stalled conversation is deprioritized rather than permanently starving every other conversation", async () => {
    const messages: SlackMessage[] = [];
    for (let i = 6; i >= 1; i--) messages.push(msg(`170000000${i}.000100`, "U-OTHER"));
    const reader = makeFakeReader({
      conversations: [
        { id: "D-STALL", type: "im", counterpartyUserId: "U-OTHER" }, // 6 messages, page size 2 -> stalls under cap 1
        { id: "D-HEALTHY", type: "im", counterpartyUserId: "U-B" }, // exactly 1 message -> never stalls
      ],
      messagesByConversation: {
        "D-STALL": messages,
        "D-HEALTHY": [msg("1800000001.000100", "U-B")],
      },
      users: {
        "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other" },
        "U-B": { id: "U-B", email: null, displayName: "B" },
      },
    });
    const now = () => new Date("2026-08-24T00:00:00Z");
    const opts = { ownUserId: OWN, now, maxMessagesPerRun: 1 };

    const first = await importSlack(db, reader, opts);
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]!.conversationId).toBe("D-STALL");
    // D-HEALTHY never even got a chance this run — the stalled conversation consumed the whole budget
    expect(reader.historyCalls.some((c) => c.conversationId === "D-HEALTHY")).toBe(false);

    reader.historyCalls.length = 0;
    await importSlack(db, reader, opts);
    // D-STALL's failed attempt bumped its cursor's updated_at, so D-HEALTHY now sorts first and gets its turn
    expect(reader.historyCalls[0]!.conversationId).toBe("D-HEALTHY");
    const healthyRows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM interactions i JOIN identities ident ON ident.contact_id=i.contact_id WHERE ident.kind='slack_user' AND ident.value='U-B'",
      )
      .get() as { n: number };
    expect(healthyRows.n).toBe(1);
  });

  it("BLOCKING: running out of request budget mid-page does not drop messages or promote the cursor past them, and does not report clean success", async () => {
    // A single-page channel with 5 distinct, never-before-seen senders (each message needs its
    // own users.info lookup). A request budget that runs out during the 2nd sender's lookup used
    // to let the page finish "successfully" (treating budget exhaustion as an ordinary
    // unresolvable-user null), promoting the cursor past senders 2-5 forever.
    const channelReader = makeFakeReader({
      conversations: [{ id: "C1", type: "public_channel" }],
      messagesByConversation: {
        C1: [
          msg("1700000005.000100", "U-5", { mentions: [OWN] }),
          msg("1700000004.000100", "U-4", { mentions: [OWN] }),
          msg("1700000003.000100", "U-3", { mentions: [OWN] }),
          msg("1700000002.000100", "U-2", { mentions: [OWN] }),
          msg("1700000001.000100", "U-1", { mentions: [OWN] }),
        ],
      },
      users: {
        "U-5": { id: "U-5", email: null, displayName: "Five" },
        "U-4": { id: "U-4", email: null, displayName: "Four" },
        "U-3": { id: "U-3", email: null, displayName: "Three" },
        "U-2": { id: "U-2", email: null, displayName: "Two" },
        "U-1": { id: "U-1", email: null, displayName: "One" },
      },
    });
    const now = () => new Date("2026-08-24T00:00:00Z");

    // Budget: 1 for the history() call + 1 for U-5's users.info lookup = 2, exhausted exactly
    // as U-4 (the second sender) needs a users.info lookup.
    const summary = await importSlack(db, channelReader, {
      ownUserId: OWN,
      now,
      maxMessagesPerRun: 100,
      maxRequestsPerRun: 2,
    });

    // The run must NOT report clean success — this is the "silent total drop" shape.
    expect(summary.stoppedEarly).toEqual({ reason: "requests" });

    // Only U-5 was actually resolved and written; U-4..U-1 were never touched this run.
    const written = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
    expect(written.n).toBe(1);
    expect(channelReader.getUserInfoCalls).toEqual(["U-5"]);

    // The cursor must NOT have been promoted past U-4..U-1 — it must still point at (or before)
    // the page's start, so a re-run re-fetches this exact page rather than skipping them forever.
    const cursor = db.prepare("SELECT oldest FROM slack_cursors WHERE conversation_id='C1'").get() as { oldest: string | null } | undefined;
    expect(cursor?.oldest ?? null).not.toBe("1700000005.000100"); // NOT promoted to the page's newest ts

    // A second run (fresh, larger budget) picks up exactly what was missed — no permanent loss.
    const second = await importSlack(db, channelReader, { ownUserId: OWN, now, maxMessagesPerRun: 100, maxRequestsPerRun: 100 });
    expect(second.stoppedEarly).toBeUndefined();
    const totalAfter = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
    expect(totalAfter.n).toBe(5); // all 5 senders eventually captured, none lost
  });

  it("IMPORTER-LEVEL (review round 3, Important): a getUserInfo failure (e.g. missing_scope) is a per-conversation error and does NOT advance the cursor", async () => {
    // Pins the property that actually closes Critical 2 -- earlier tests only proved the READER
    // throws SlackApiError; this proves the IMPORTER's cursor bookkeeping reacts correctly when
    // a resolver fails: the message is never counted as processed and the cursor is left where
    // it was, so a re-run re-sees the message rather than skipping it forever.
    const reader = makeFakeReader({
      conversations: [{ id: "C1", type: "public_channel" }],
      messagesByConversation: {
        C1: [msg("1700000001.000100", "U-NEW", { mentions: [OWN] })],
      },
      users: {},
      getUserInfoErrors: { "U-NEW": new Error("missing_scope") },
    });
    const now = () => new Date("2026-08-24T00:00:00Z");

    const summary = await importSlack(db, reader, { ownUserId: OWN, now });

    // Recorded as a visible per-conversation error -- never a clean-looking success.
    expect(summary.errors).toContainEqual({ conversationId: "C1", error: "missing_scope" });
    expect(summary.interactionRowsWritten).toBe(0);

    // THE property: the cursor must not have advanced past the message whose resolver failed.
    const cursor = db.prepare("SELECT oldest, resume_cursor, pending_high_water FROM slack_cursors WHERE conversation_id='C1'").get() as
      | { oldest: string | null; resume_cursor: string | null; pending_high_water: string | null }
      | undefined;
    expect(cursor?.oldest ?? null).toBeNull();
    expect(cursor?.resume_cursor ?? null).toBeNull();
    expect(cursor?.pending_high_water ?? null).toBeNull();

    // A second run, resolver fixed, picks up exactly the message that was never lost.
    const fixedReader = makeFakeReader({
      conversations: [{ id: "C1", type: "public_channel" }],
      messagesByConversation: { C1: [msg("1700000001.000100", "U-NEW", { mentions: [OWN] })] },
      users: { "U-NEW": { id: "U-NEW", email: null, displayName: "New Person" } },
    });
    const second = await importSlack(db, fixedReader, { ownUserId: OWN, now });
    expect(second.interactionRowsWritten).toBe(1);
  });

  it("a channel message authored by Bendik himself creates no row — no single counterparty to attach it to", async () => {
    const reader = makeFakeReader({
      conversations: [{ id: "C1", type: "public_channel" }],
      messagesByConversation: {
        C1: [msg("1700000002.000100", OWN, { mentions: ["U-OTHER"] }), msg("1700000001.000100", "U-OTHER", { mentions: [OWN] })],
      },
      users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
    });

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    expect(summary.interactionRowsWritten).toBe(1); // only the relevant inbound one
    const rows = db.prepare("SELECT direction FROM interactions WHERE channel='slack'").all() as { direction: string }[];
    expect(rows).toEqual([{ direction: "inbound" }]);
    const own = db.prepare("SELECT id FROM identities WHERE kind='slack_user' AND value=?").get(OWN);
    expect(own).toBeUndefined();
  });

  describe("CONTROLLER RULING: channel/private_channel signals-only gate", () => {
    it("writes a row only when the message mentions Bendik or sits in a thread he participated in", async () => {
      const reader = makeFakeReader({
        conversations: [{ id: "C1", type: "public_channel" }],
        messagesByConversation: {
          C1: [
            msg("1700000003.000100", "U-OTHER", { mentions: [OWN] }), // relevant: mention
            msg("1700000002.000100", "U-OTHER", { threadHasOwnReply: true }), // relevant: thread
            msg("1700000001.000100", "U-OTHER"), // NOT relevant — a broadcast to the channel
          ],
        },
        users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
      });

      const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

      expect(summary.interactionRowsWritten).toBe(2);
      const total = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
      expect(total.n).toBe(2);
    });

    it("ORB-149 defect 2: a RELEVANT thread's replies each become their own interaction — content still NULL", async () => {
      const reader = makeFakeReader({
        conversations: [{ id: "C1", type: "public_channel" }],
        messagesByConversation: {
          C1: [
            msg("1700000010.000100", "U-P", {
              mentions: [OWN], // relevant: the parent mentions Bendik
              threadReplies: [
                reply("1700000011.000100", "U-R1"),
                reply("1700000012.000100", "U-R2"),
                reply("1700000013.000100", OWN), // his own reply: handled, but no single counterparty -> no row
                reply("1700000014.000100", undefined, { botId: "B1" }), // bot: skipped as not-a-person
              ],
            }),
          ],
        },
        users: {
          "U-P": { id: "U-P", email: null, displayName: "Parent Author" },
          "U-R1": { id: "U-R1", email: null, displayName: "Replier One" },
          "U-R2": { id: "U-R2", email: null, displayName: "Replier Two" },
        },
      });

      const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

      // parent + two human replies; Bendik's own reply and the bot reply write nothing
      expect(summary.interactionRowsWritten).toBe(3);
      const rows = db
        .prepare("SELECT external_id, direction, content FROM interactions WHERE channel='slack' ORDER BY external_id")
        .all() as { external_id: string; direction: string; content: unknown }[];
      expect(rows.map((r) => r.external_id)).toEqual([
        "C1:1700000010.000100",
        "C1:1700000011.000100",
        "C1:1700000012.000100",
      ]);
      for (const r of rows) {
        expect(r.direction).toBe("inbound");
        expect(r.content).toBeNull(); // the privacy boundary holds for reply-derived rows too
      }

      // counters stay mutually consistent with replies in the mix
      expect(summary.threadRepliesExamined).toBe(4);
      expect(summary.messagesExamined).toBe(5); // 1 parent + 4 replies
      expect(summary.messagesSkippedNotAPerson).toBe(1); // the bot reply
      expect(summary.messagesProcessed).toBe(4); // parent + 2 human replies + his own reply
      expect(summary.messagesSkippedNotAPerson + summary.messagesProcessed).toBe(summary.messagesExamined);

      // and re-running writes nothing new: the reply rows dedupe on (channel, external_id)
      const second = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-25T00:00:00Z") });
      expect(second.interactionRowsWritten).toBe(0);
    });

    it("ORB-149 defect 2: an IRRELEVANT thread's replies are never examined and write nothing", async () => {
      const reader = makeFakeReader({
        conversations: [{ id: "C1", type: "public_channel" }],
        messagesByConversation: {
          C1: [
            msg("1700000010.000100", "U-P", {
              // no mention of Bendik, and he has never replied in this thread
              threadReplies: [reply("1700000011.000100", "U-R1"), reply("1700000012.000100", "U-R2")],
            }),
          ],
        },
        users: {
          "U-P": { id: "U-P", email: null, displayName: "Parent Author" },
          "U-R1": { id: "U-R1", email: null, displayName: "Replier One" },
          "U-R2": { id: "U-R2", email: null, displayName: "Replier Two" },
        },
      });

      const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

      expect(summary.interactionRowsWritten).toBe(0);
      expect(summary.threadRepliesExamined).toBe(0);
      expect(summary.messagesExamined).toBe(1); // the parent only
      const contacts = db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number };
      expect(contacts.n).toBe(0); // no repliers resolved, so no contacts minted from an irrelevant thread
    });

    it("ORB-149 defect 2: a thread Bendik replied in counts even when he authored the parent — his own posts still write no row", async () => {
      const reader = makeFakeReader({
        conversations: [{ id: "C1", type: "public_channel" }],
        messagesByConversation: {
          C1: [
            msg("1700000010.000100", OWN, {
              threadHasOwnReply: true, // relevant: he is in this thread
              threadReplies: [reply("1700000011.000100", "U-R1"), reply("1700000012.000100", OWN)],
            }),
          ],
        },
        users: { "U-R1": { id: "U-R1", email: null, displayName: "Replier One" } },
      });

      const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

      expect(summary.interactionRowsWritten).toBe(1); // only U-R1's reply
      const rows = db.prepare("SELECT external_id FROM interactions WHERE channel='slack'").all() as { external_id: string }[];
      expect(rows.map((r) => r.external_id)).toEqual(["C1:1700000011.000100"]);
      const own = db.prepare("SELECT id FROM identities WHERE kind='slack_user' AND value=?").get(OWN);
      expect(own).toBeUndefined(); // he is never minted as a contact
    });

    it("ORB-149 defect 2: conversations.replies requests are charged against maxRequestsPerRun", async () => {
      const reader = makeFakeReader({
        conversations: [{ id: "C1", type: "public_channel" }],
        messagesByConversation: {
          C1: [msg("1700000010.000100", "U-P", { mentions: [OWN], threadReplies: [reply("1700000011.000100", "U-R1")] })],
        },
        users: {
          "U-P": { id: "U-P", email: null, displayName: "Parent Author" },
          "U-R1": { id: "U-R1", email: null, displayName: "Replier One" },
        },
      });
      const now = () => new Date("2026-08-24T00:00:00Z");

      // The page costs 4 requests: 1 history + 1 replies + 2 users.info. A budget of 3 is
      // enough ONLY if the .replies call is free — which is exactly the bug. With it charged,
      // the run runs out while resolving the reply's author.
      const first = await importSlack(db, reader, { ownUserId: OWN, now, maxRequestsPerRun: 3 });

      expect(first.repliesRequestsCharged).toBe(1);
      expect(first.stoppedEarly).toEqual({ reason: "requests" });
      const afterFirst = db.prepare("SELECT external_id FROM interactions WHERE channel='slack'").all() as { external_id: string }[];
      expect(afterFirst.map((r) => r.external_id)).toEqual(["C1:1700000010.000100"]); // parent only

      // The cursor was NOT promoted past the unfinished page, so a fresh run picks the reply up.
      const second = await importSlack(db, reader, { ownUserId: OWN, now, maxRequestsPerRun: 100 });
      expect(second.stoppedEarly).toBeUndefined();
      const total = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
      expect(total.n).toBe(2); // no duplicate of the parent
    });

    it("ORB-149 defect 2: a page whose .replies cost alone exceeds the whole run's request budget fails loudly instead of stalling", async () => {
      const reader = makeFakeReader({
        conversations: [{ id: "C1", type: "public_channel" }],
        messagesByConversation: {
          C1: [
            msg("1700000010.000100", "U-P", { mentions: [OWN], threadReplies: [reply("1700000011.000100", "U-R1")] }),
            msg("1700000009.000100", "U-Q", { mentions: [OWN], threadReplies: [reply("1700000008.000100", "U-R2")] }),
          ],
        },
        users: {
          "U-P": { id: "U-P", email: null, displayName: "P" },
          "U-Q": { id: "U-Q", email: null, displayName: "Q" },
          "U-R1": { id: "U-R1", email: null, displayName: "R1" },
          "U-R2": { id: "U-R2", email: null, displayName: "R2" },
        },
      });

      // 1 history + 2 replies = 3 requests for the page; a run budget of 2 can never reach it.
      const summary = await importSlack(db, reader, {
        ownUserId: OWN,
        now: () => new Date("2026-08-24T00:00:00Z"),
        maxRequestsPerRun: 2,
      });

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]!.conversationId).toBe("C1");
      expect(summary.errors[0]!.error).toMatch(/maxRequestsPerRun/);
    });

    it("ORB-149 defect 2: the message budget covers replies, and an interrupted thread resumes without duplicates", async () => {
      const reader = makeFakeReader({
        conversations: [{ id: "C1", type: "public_channel" }],
        messagesByConversation: {
          C1: [
            msg("1700000010.000100", "U-P", {
              mentions: [OWN],
              threadReplies: [reply("1700000011.000100", "U-R1"), reply("1700000012.000100", "U-R2")],
            }),
          ],
        },
        users: {
          "U-P": { id: "U-P", email: null, displayName: "P" },
          "U-R1": { id: "U-R1", email: null, displayName: "R1" },
          "U-R2": { id: "U-R2", email: null, displayName: "R2" },
        },
      });
      const now = () => new Date("2026-08-24T00:00:00Z");

      // Budget 2 = the parent + the first reply; the second reply is left for the next run.
      const first = await importSlack(db, reader, { ownUserId: OWN, now, maxMessagesPerRun: 2 });
      expect(first.stoppedEarly).toEqual({ reason: "messages" });
      expect(first.interactionRowsWritten).toBe(2);

      const second = await importSlack(db, reader, { ownUserId: OWN, now, maxMessagesPerRun: 100 });
      expect(second.interactionRowsWritten).toBe(1); // only the reply that was missed
      const rows = db.prepare("SELECT external_id FROM interactions WHERE channel='slack' ORDER BY external_id").all() as {
        external_id: string;
      }[];
      expect(rows.map((r) => r.external_id)).toEqual([
        "C1:1700000010.000100",
        "C1:1700000011.000100",
        "C1:1700000012.000100",
      ]);
    });
  });

  describe("ORB-149 defect 3: an expired pagination cursor self-heals", () => {
    it("clears the dead cursor, re-fetches from the last committed high-water mark, and writes no duplicates", async () => {
      const messages: SlackMessage[] = [];
      for (let i = 6; i >= 1; i--) messages.push(msg(`170000000${i}.000100`, "U-OTHER"));
      const invalidCursors = new Set<string>();
      const reader = makeFakeReader({
        conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-OTHER" }],
        messagesByConversation: { D1: messages },
        users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
        invalidCursors,
      });
      const now = () => new Date("2026-08-24T00:00:00Z");

      // Run 1 stops after one page and persists a resume cursor mid-backlog.
      const first = await importSlack(db, reader, { ownUserId: OWN, now, maxPagesPerConversation: 1 });
      expect(first.stoppedEarly).toEqual({ reason: "pages" });
      const afterFirst = db.prepare("SELECT oldest, resume_cursor, pending_high_water FROM slack_cursors WHERE conversation_id='D1'").get() as {
        oldest: string | null;
        resume_cursor: string | null;
        pending_high_water: string | null;
      };
      expect(afterFirst.resume_cursor).toBe("2");
      expect(afterFirst.oldest).toBeNull(); // nothing committed yet — the walk never completed
      expect(afterFirst.pending_high_water).toBe("1700000006.000100");

      // Run 2: Slack has forgotten that cursor. Loud, but healed — not re-pinned.
      invalidCursors.add("2");
      const second = await importSlack(db, reader, { ownUserId: OWN, now });
      expect(second.errors).toHaveLength(1);
      expect(second.errors[0]!.conversationId).toBe("D1");
      expect(second.errors[0]!.error).toMatch(/invalid_cursor/);
      expect(second.errors[0]!.error).toMatch(/cleared/);
      const afterSecond = db.prepare("SELECT oldest, resume_cursor, pending_high_water FROM slack_cursors WHERE conversation_id='D1'").get() as {
        oldest: string | null;
        resume_cursor: string | null;
        pending_high_water: string | null;
      };
      expect(afterSecond.resume_cursor).toBeNull(); // the dead cursor is gone, not written back
      expect(afterSecond.pending_high_water).toBeNull(); // re-derived by the fresh walk
      expect(afterSecond.oldest).toBe(afterFirst.oldest); // the re-fetch floor is untouched

      // Run 3: a fresh walk from the committed high-water mark, with no duplicate rows.
      invalidCursors.clear();
      reader.historyCalls.length = 0;
      const third = await importSlack(db, reader, { ownUserId: OWN, now });
      expect(third.errors).toEqual([]);
      expect(third.stoppedEarly).toBeUndefined();
      expect(reader.historyCalls[0]).toEqual({ conversationId: "D1", oldest: undefined, cursor: undefined });
      expect(third.interactionRowsWritten).toBe(4); // messages 1-4; 5 and 6 re-inserted as no-ops

      const rows = db.prepare("SELECT external_id FROM interactions WHERE channel='slack' ORDER BY external_id").all() as {
        external_id: string;
      }[];
      expect(rows.map((r) => r.external_id)).toEqual([
        "D1:1700000001.000100",
        "D1:1700000002.000100",
        "D1:1700000003.000100",
        "D1:1700000004.000100",
        "D1:1700000005.000100",
        "D1:1700000006.000100",
      ]);
      const afterThird = db.prepare("SELECT oldest, resume_cursor FROM slack_cursors WHERE conversation_id='D1'").get() as {
        oldest: string | null;
        resume_cursor: string | null;
      };
      expect(afterThird.oldest).toBe("1700000006.000100"); // caught up, high-water promoted
      expect(afterThird.resume_cursor).toBeNull();
    });

    it("the same conversation is not stalled forever: a second invalid_cursor still heals rather than accumulating", async () => {
      const messages: SlackMessage[] = [];
      for (let i = 6; i >= 1; i--) messages.push(msg(`170000000${i}.000100`, "U-OTHER"));
      const invalidCursors = new Set<string>(["2"]);
      const reader = makeFakeReader({
        conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-OTHER" }],
        messagesByConversation: { D1: messages },
        users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
        invalidCursors,
      });
      const now = () => new Date("2026-08-24T00:00:00Z");

      // Every run walks page 1 fine and dies on cursor "2" — but each run makes real progress
      // (page 1's messages) and never re-pins the dead cursor.
      const first = await importSlack(db, reader, { ownUserId: OWN, now });
      const second = await importSlack(db, reader, { ownUserId: OWN, now });
      expect(first.errors).toHaveLength(1);
      expect(second.errors).toHaveLength(1);
      const cursorRow = db.prepare("SELECT resume_cursor FROM slack_cursors WHERE conversation_id='D1'").get() as {
        resume_cursor: string | null;
      };
      expect(cursorRow.resume_cursor).toBeNull();
      const total = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
      expect(total.n).toBe(2); // page 1 only, written once — no duplicates from the repeated re-walk
    });
  });

  describe("CONTROLLER RULING: mpim fan-out", () => {
    it("Bendik's own mpim message fans out to one outbound row per other member, restoring reciprocity", async () => {
      const reader = makeFakeReader({
        conversations: [{ id: "G1", type: "mpim", members: [OWN, "U-A", "U-B", "U-C"] }],
        messagesByConversation: {
          G1: [msg("1700000002.000100", OWN), msg("1700000001.000100", "U-A")],
        },
        users: {
          "U-A": { id: "U-A", email: null, displayName: "A Person" },
          "U-B": { id: "U-B", email: null, displayName: "B Person" },
          "U-C": { id: "U-C", email: null, displayName: "C Person" },
        },
      });

      const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

      // 3 outbound rows (one per other member) for the own message + 1 inbound for U-A's message
      expect(summary.interactionRowsWritten).toBe(4);
      // but only 2 distinct SOURCE messages were processed — the fan-out must not inflate this count
      expect(summary.messagesProcessed).toBe(2);
      const outbound = db
        .prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack' AND direction='outbound'")
        .get() as { n: number };
      expect(outbound.n).toBe(3);

      // U-A now has BOTH an outbound (from the fan-out) and an inbound row — reciprocal
      const aContact = db.prepare("SELECT contact_id FROM identities WHERE kind='slack_user' AND value='U-A'").get() as {
        contact_id: number;
      };
      const aDirections = (
        db.prepare("SELECT direction FROM interactions WHERE channel='slack' AND contact_id=? ORDER BY direction").all(
          aContact.contact_id,
        ) as { direction: string }[]
      ).map((r) => r.direction);
      expect(aDirections).toEqual(["inbound", "outbound"]);
    });

    it("a message from a non-Bendik mpim member attaches only to its author, not fanned to everyone", async () => {
      const reader = makeFakeReader({
        conversations: [{ id: "G1", type: "mpim", members: [OWN, "U-A", "U-B", "U-C"] }],
        messagesByConversation: {
          G1: [msg("1700000001.000100", "U-A")],
        },
        users: { "U-A": { id: "U-A", email: null, displayName: "A Person" } },
      });

      const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

      expect(summary.interactionRowsWritten).toBe(1);
      const contactCount = db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number };
      expect(contactCount.n).toBe(1); // only U-A got resolved — B and C were never touched
    });
  });

  it("enumerates conversations across all four types", async () => {
    const conversations: SlackConversation[] = [
      { id: "C1", type: "public_channel" },
      { id: "C2", type: "private_channel" },
      { id: "D1", type: "im", counterpartyUserId: "U-OTHER" },
      { id: "G1", type: "mpim", members: [OWN, "U-X"] },
    ];
    const reader = makeFakeReader({ conversations, messagesByConversation: {}, users: {} });

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });
    expect(summary.conversations).toBe(4);
    expect(summary.errors).toEqual([]);
    // final review, Important 5: all four types present — no scope warning.
    expect(summary.conversationsByType).toEqual({ public_channel: 1, private_channel: 1, im: 1, mpim: 1 });
    expect(summary.scopeWarnings).toEqual([]);
  });

  it("warns when conversations.list comes back with zero of an expected type (final review, Important 5) — a possible missing scope, not an error", async () => {
    // Simulates a token missing im:read/mpim:read: conversations.list still succeeds, just
    // returns fewer types, with no Slack-side error at all.
    const conversations: SlackConversation[] = [
      { id: "C1", type: "public_channel" },
      { id: "C2", type: "private_channel" },
    ];
    const reader = makeFakeReader({ conversations, messagesByConversation: {}, users: {} });

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    expect(summary.errors).toEqual([]); // NOT an error — advisory only
    expect(summary.conversationsByType).toEqual({ public_channel: 1, private_channel: 1, im: 0, mpim: 0 });
    expect(summary.scopeWarnings).toHaveLength(2);
    expect(summary.scopeWarnings.some((w) => w.includes('"im"'))).toBe(true);
    expect(summary.scopeWarnings.some((w) => w.includes('"mpim"'))).toBe(true);
  });

  it("emits no scope warnings when listConversations() itself fails — the real error already covers it", async () => {
    const reader: SlackReader = {
      async listConversations() {
        throw new Error("invalid_auth");
      },
      async history() {
        return { messages: [], nextCursor: null };
      },
      async getUserInfo() {
        return null;
      },
    };

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    expect(summary.errors).toHaveLength(1);
    expect(summary.scopeWarnings).toEqual([]); // no spurious "0 im/mpim/…" noise on top of the real failure
  });

  it("throws a per-conversation error (not a type error) when a misbehaving reader hands back an im with no counterpartyUserId", async () => {
    const brokenIm = { id: "D1", type: "im" } as unknown as SlackConversation; // simulates a reader that forgot to map Slack's `user` field
    const reader = makeFakeReader({
      conversations: [brokenIm, { id: "D2", type: "im", counterpartyUserId: "U-B" }],
      messagesByConversation: {
        D1: [msg("1700000001.000100", "U-A")],
        D2: [msg("1700000001.000100", "U-B")],
      },
      users: {
        "U-A": { id: "U-A", email: null, displayName: "A Person" },
        "U-B": { id: "U-B", email: null, displayName: "B Person" },
      },
    });

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ conversationId: "D1" });
    expect(summary.errors[0]!.error).toMatch(/counterpartyUserId/);
    // D2 was NOT dropped by D1's failure — the run keeps going
    const total = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
    expect(total.n).toBe(1);
  });

  it("a rate limit from the reader stops the whole run immediately and is reported, not thrown", async () => {
    const reader = makeFakeReader({
      conversations: [
        { id: "D1", type: "im", counterpartyUserId: "U-A" },
        { id: "D2", type: "im", counterpartyUserId: "U-B" },
        { id: "D3", type: "im", counterpartyUserId: "U-C" },
      ],
      messagesByConversation: {
        D1: [msg("1700000001.000100", "U-A")],
        D2: [msg("1700000001.000100", "U-B")],
        D3: [msg("1700000001.000100", "U-C")],
      },
      users: {
        "U-A": { id: "U-A", email: null, displayName: "A" },
        "U-B": { id: "U-B", email: null, displayName: "B" },
        "U-C": { id: "U-C", email: null, displayName: "C" },
      },
      historyErrors: { D2: new SlackRateLimitError(30) },
    });

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    expect(summary.stoppedEarly).toEqual({ reason: "rate_limited" });
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.conversationId).toBe("D2");
    // D1 (swept before the rate limit) got its message; D3 (after) never got attempted
    const d3Calls = reader.historyCalls.filter((c) => c.conversationId === "D3");
    expect(d3Calls.length).toBe(0);
    const total = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
    expect(total.n).toBe(1);
  });

  it("an ordinary per-conversation error is recorded and the run continues to the next conversation", async () => {
    const reader = makeFakeReader({
      conversations: [
        { id: "D1", type: "im", counterpartyUserId: "U-A" },
        { id: "D2", type: "im", counterpartyUserId: "U-B" },
      ],
      messagesByConversation: {
        D1: [msg("1700000001.000100", "U-A")],
        D2: [msg("1700000001.000100", "U-B")],
      },
      users: {
        "U-A": { id: "U-A", email: null, displayName: "A" },
        "U-B": { id: "U-B", email: null, displayName: "B" },
      },
      historyErrors: { D1: new Error("boom") },
    });

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    expect(summary.errors).toEqual([{ conversationId: "D1", error: "boom" }]);
    expect(summary.stoppedEarly).toBeUndefined();
    // D2 still got processed despite D1's failure
    const total = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
    expect(total.n).toBe(1);
  });

  it("caps the total conversations.history + users.info requests per run", async () => {
    const reader = makeFakeReader({
      conversations: [
        { id: "D1", type: "im", counterpartyUserId: "U-A" },
        { id: "D2", type: "im", counterpartyUserId: "U-B" },
        { id: "D3", type: "im", counterpartyUserId: "U-C" },
      ],
      messagesByConversation: {
        D1: [msg("1700000002.000100", "U-A"), msg("1700000001.000100", "U-A")],
        D2: [msg("1700000001.000100", "U-B")],
        D3: [msg("1700000001.000100", "U-C")],
      },
      users: {
        "U-A": { id: "U-A", email: null, displayName: "A" },
        "U-B": { id: "U-B", email: null, displayName: "B" },
        "U-C": { id: "U-C", email: null, displayName: "C" },
      },
    });

    // 1 history() + 1 getUserInfo() for D1 exhausts a budget of 2; D2/D3 never get a request.
    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z"), maxRequestsPerRun: 2 });

    expect(summary.stoppedEarly).toEqual({ reason: "requests" });
    const d2Calls = reader.historyCalls.filter((c) => c.conversationId === "D2");
    const d3Calls = reader.historyCalls.filter((c) => c.conversationId === "D3");
    expect(d2Calls.length).toBe(0);
    expect(d3Calls.length).toBe(0);
    const total = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
    expect(total.n).toBe(2); // both of D1's messages, from the single completed history() call
  });

  it("caps conversations per run and sweeps least-recently-swept first (no starvation)", async () => {
    const reader = makeFakeReader({
      conversations: [
        { id: "D1", type: "im", counterpartyUserId: "U-A" },
        { id: "D2", type: "im", counterpartyUserId: "U-B" },
        { id: "D3", type: "im", counterpartyUserId: "U-C" },
      ],
      messagesByConversation: {
        D1: [msg("1700000001.000100", "U-A")],
        D2: [msg("1700000001.000100", "U-B")],
        D3: [msg("1700000001.000100", "U-C")],
      },
      users: {
        "U-A": { id: "U-A", email: null, displayName: "A" },
        "U-B": { id: "U-B", email: null, displayName: "B" },
        "U-C": { id: "U-C", email: null, displayName: "C" },
      },
    });

    // D1 was swept recently; D2 swept long ago; D3 has never been swept (no cursor row at all).
    db.prepare(
      "INSERT INTO slack_cursors (conversation_id, oldest, resume_cursor, pending_high_water, updated_at) VALUES ('D1', NULL, NULL, NULL, '2026-08-20T00:00:00Z')",
    ).run();
    db.prepare(
      "INSERT INTO slack_cursors (conversation_id, oldest, resume_cursor, pending_high_water, updated_at) VALUES ('D2', NULL, NULL, NULL, '2026-01-01T00:00:00Z')",
    ).run();

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z"), maxConversationsPerRun: 1 });

    expect(summary.stoppedEarly).toEqual({ reason: "conversations" });
    // D3 (never swept) jumps the queue ahead of D2 (stale) and D1 (recent)
    expect(reader.historyCalls.map((c) => c.conversationId)).toEqual(["D3"]);
  });

  it("ORB-149 T-firstrun: among never-swept conversations, im/mpim are swept before public/private channels", async () => {
    const conversations: SlackConversation[] = [
      { id: "C1", type: "public_channel" },
      { id: "D1", type: "im", counterpartyUserId: "U-A" },
      { id: "C2", type: "private_channel" },
      { id: "G1", type: "mpim", members: [OWN, "U-B"] },
    ];
    const reader = makeFakeReader({ conversations, messagesByConversation: {}, users: {} });

    // No cursor rows at all — every conversation is a first-run sweep.
    await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    // DMs (im, mpim) jump ahead of channels; relative order within each group is preserved.
    expect(reader.historyCalls.map((c) => c.conversationId)).toEqual(["D1", "G1", "C1", "C2"]);
  });

  it("ORB-149 T-firstrun: the DM-first priority does not persist once conversations have been swept before", async () => {
    const conversations: SlackConversation[] = [
      { id: "C1", type: "public_channel" },
      { id: "D1", type: "im", counterpartyUserId: "U-A" },
    ];
    const reader = makeFakeReader({ conversations, messagesByConversation: {}, users: {} });

    // Both have a cursor row already (neither is a first-run sweep): D1 was swept recently,
    // C1 was swept long ago. Despite D1 being a DM, C1 — being staler — must go first: the
    // first-run priority is scoped to never-swept conversations only.
    db.prepare(
      "INSERT INTO slack_cursors (conversation_id, oldest, resume_cursor, pending_high_water, updated_at) VALUES ('D1', NULL, NULL, NULL, '2026-08-24T00:00:00Z')",
    ).run();
    db.prepare(
      "INSERT INTO slack_cursors (conversation_id, oldest, resume_cursor, pending_high_water, updated_at) VALUES ('C1', NULL, NULL, NULL, '2026-01-01T00:00:00Z')",
    ).run();

    await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    expect(reader.historyCalls.map((c) => c.conversationId)).toEqual(["C1", "D1"]);
  });

  it("ORB-149 T-firstrun: a page of bot-only messages reports honest, mutually-consistent counters instead of a silent messagesProcessed: 0", async () => {
    const conversations: SlackConversation[] = [{ id: "C1", type: "public_channel" }];
    const reader = makeFakeReader({
      conversations,
      messagesByConversation: {
        C1: [
          msg("1700000003.000100", undefined, { botId: "B1" }),
          msg("1700000002.000100", undefined, { botId: "B1" }),
          msg("1700000001.000100", undefined, { botId: "B1" }),
        ],
      },
      users: {},
    });

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    expect(summary.messagesExamined).toBe(3);
    expect(summary.messagesSkippedNotAPerson).toBe(3);
    expect(summary.messagesProcessed).toBe(0);
    expect(summary.interactionRowsWritten).toBe(0);
    // The three counters must be mutually consistent: every examined message is accounted
    // for as either skipped-not-a-person or processed (no third silent bucket).
    expect(summary.messagesSkippedNotAPerson + summary.messagesProcessed).toBe(summary.messagesExamined);
  });

  it("ORB-149 gap-closing: recomputes Pulse at the end of the run and reports it in the summary", async () => {
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-OTHER" }],
      messagesByConversation: {
        // Two messages, one in each direction, a day before "now" below: recent enough to
        // land inside the scoring window (a 2023-dated fixture would decay to a zero score
        // regardless of whether the recompute ran), and reciprocal (im's own-direction reply
        // makes `isReciprocal` true — an inbound-only fixture always scores 0 by design,
        // which would mask the very bug this test exists to catch).
        D1: [msg("1787443200.000200", OWN), msg("1787443200.000100", "U-OTHER")],
      },
      users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
    });

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    // The recompute ran (not just that some object is present) — it scored at least the
    // contact this run just created, and found no cadence breaks / dormant-warm on a
    // same-day interaction.
    expect(summary.pulse).toBeDefined();
    expect(summary.pulse!.scored).toBeGreaterThanOrEqual(1);
    expect(summary.errors).toEqual([]);

    // And the numbers in the summary match what actually landed in `pulse` — this is the
    // defect the fix closes: before it, `interactions` gained a row but `pulse` stayed at
    // NO_CONNECTION/0 until some *other* command happened to run afterwards.
    const contact = db.prepare("SELECT id FROM contacts WHERE display_name = 'Other Person'").get() as { id: number };
    const row = db.prepare("SELECT band, score FROM pulse WHERE contact_id = ?").get(contact.id) as
      | { band: string; score: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.band).not.toBe("NO_CONNECTION");
    expect(row!.score).toBeGreaterThan(0);
  });

  it("ORB-149 gap-closing: a run with zero rows written still recomputes Pulse", async () => {
    const reader = makeFakeReader({ conversations: [], messagesByConversation: {}, users: {} });

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    expect(summary.interactionRowsWritten).toBe(0);
    expect(summary.pulse).toEqual({ scored: 0, dormantWarm: 0, cadenceBreaks: 0 });
  });

  it("ORB-149 gap-closing: a throwing recompute records an error but does not lose the rows already written", async () => {
    const reader = makeFakeReader({
      conversations: [{ id: "D1", type: "im", counterpartyUserId: "U-OTHER" }],
      messagesByConversation: {
        D1: [msg("1700000001.000100", "U-OTHER")],
      },
      users: { "U-OTHER": { id: "U-OTHER", email: null, displayName: "Other Person" } },
    });
    // Forces recomputePulse's own `db.prepare` (the `pulse` upsert) to throw, without
    // touching anything the importer itself depends on.
    db.exec("DROP TABLE pulse");

    const summary = await importSlack(db, reader, { ownUserId: OWN, now: () => new Date("2026-08-24T00:00:00Z") });

    expect(summary.interactionRowsWritten).toBe(1);
    expect(summary.pulse).toBeUndefined();
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].conversationId).toBe("pulse");
    expect(summary.errors[0].error).toMatch(/pulse/i);

    // The already-committed interaction row survives the recompute failure — it is not
    // rolled back just because the post-step blew up.
    const rows = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel='slack'").get() as { n: number };
    expect(rows.n).toBe(1);
  });
});
