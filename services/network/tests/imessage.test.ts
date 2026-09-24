import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../lib/db.js";
import { importIMessage, APPLE_EPOCH_OFFSET_S } from "../lib/importers/imessage.js";
import { upsertContact } from "../lib/resolve.js";

let db: Db;
const dirs: string[] = [];
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** iMessage stores dates as nanoseconds since 2001-01-01: (unix_s − offset) × 1e9 */
function appleNs(iso: string): number {
  return (new Date(iso).getTime() / 1000 - APPLE_EPOCH_OFFSET_S) * 1e9;
}

/** Build a blob matching the attributedBody format used by Task A1's blobFor */
const MARK = Buffer.from("NSString");
const SKIP = Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]);
function blobFor(text: string, opts: { twoByte?: boolean } = {}): Buffer {
  const body = Buffer.from(text, "utf8");
  const len = opts.twoByte || body.length >= 0x80
    ? Buffer.from([0x81, body.length & 0xff, (body.length >> 8) & 0xff])
    : Buffer.from([body.length]);
  return Buffer.concat([Buffer.from("streamtyped\x00\x84\x01"), MARK, SKIP, len, body, Buffer.from("\x86\x84\x02iI\x01\x0b")]);
}

function makeChatDbFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "chatdb-"));
  dirs.push(dir);
  const path = join(dir, "chat.db");
  const chat = new Database(path);
  chat.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, is_from_me INTEGER, text TEXT, attributedBody BLOB, handle_id INTEGER);
  `);
  chat.prepare("INSERT INTO handle VALUES (1, '+4798212345')").run();
  chat.prepare("INSERT INTO message VALUES (1, 'g-1', ?, 0, 'hei!', NULL, 1)").run(appleNs("2026-06-01T10:00:00Z"));
  chat.prepare("INSERT INTO message VALUES (2, 'g-2', ?, 1, 'hei hei', NULL, 1)").run(appleNs("2026-06-01T10:05:00Z"));
  chat.prepare("INSERT INTO message VALUES (3, 'g-3', ?, 0, NULL, ?, 1)").run(appleNs("2026-06-01T10:06:00Z"), blobFor("dette lå i attributedBody"));
  chat.prepare("INSERT INTO message VALUES (4, 'g-4', ?, 0, 'vinner', ?, 1)").run(appleNs("2026-06-01T10:07:00Z"), blobFor("taper"));
  chat.close();
  return path;
}

describe("importIMessage", () => {
  it("attaches messages to a known contact by phone identity", () => {
    const known = upsertContact(db, { displayName: "Peter Karlsson", source: "contacts", identities: [{ kind: "phone", value: "+4798212345" }] });
    const summary = importIMessage(db, makeChatDbFixture());
    expect(summary.messages).toBe(4);
    const rows = db.prepare("SELECT direction, content, at FROM interactions WHERE contact_id = ? ORDER BY at").all(known) as any[];
    expect(rows.length).toBe(4);
    expect(rows[0]).toMatchObject({ direction: "inbound", content: "hei!" });
    expect(rows[1].direction).toBe("outbound");
    expect(rows[2].content).toBe("dette lå i attributedBody");
    expect(rows[3].content).toBe("vinner");
    expect(rows[0].at).toBe("2026-06-01T10:00:00.000Z");
  });

  it("decodes attributedBody when text is NULL, and text wins when both exist", () => {
    const known = upsertContact(db, { displayName: "Peter Karlsson", source: "contacts", identities: [{ kind: "phone", value: "+4798212345" }] });
    importIMessage(db, makeChatDbFixture());
    const rows = db.prepare("SELECT content FROM interactions WHERE contact_id = ? ORDER BY at").all(known) as { content: string | null }[];
    expect(rows.map((r) => r.content)).toEqual(["hei!", "hei hei", "dette lå i attributedBody", "vinner"]);
  });

  it("backfills a row imported earlier with NULL content, and never overwrites existing content", () => {
    const fixture = makeChatDbFixture();
    importIMessage(db, fixture);
    db.prepare("UPDATE interactions SET content = NULL WHERE external_id = 'g-3'").run();      // the pre-fix state
    db.prepare("UPDATE interactions SET content = 'hand-edited' WHERE external_id = 'g-1'").run();
    const second = importIMessage(db, fixture);
    expect(second.messages).toBe(0);
    expect(second.backfilled).toBe(1);
    const byId = Object.fromEntries((db.prepare("SELECT external_id, content FROM interactions").all() as any[]).map((r) => [r.external_id, r.content]));
    expect(byId["g-3"]).toBe("dette lå i attributedBody");
    expect(byId["g-1"]).toBe("hand-edited");
  });

  it("creates an unresolved contact for unknown handles", () => {
    importIMessage(db, makeChatDbFixture());
    const c = db.prepare("SELECT display_name, resolved FROM contacts").get() as any;
    expect(c.display_name).toBe("+4798212345");
    expect(c.resolved).toBe(0);
  });

  it("is idempotent on message guid", () => {
    const fixture = makeChatDbFixture();
    importIMessage(db, fixture);
    importIMessage(db, fixture);
    expect((db.prepare("SELECT COUNT(*) AS n FROM interactions").get() as any).n).toBe(4);
  });

  it("re-import summary reports zero new messages and handles", () => {
    const fixture = makeChatDbFixture();
    importIMessage(db, fixture);
    const second = importIMessage(db, fixture);
    expect(second.messages).toBe(0);
    expect(second.newHandles).toBe(0);
  });
});
