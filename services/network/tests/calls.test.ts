import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../lib/db.js";
import { importCalls } from "../lib/importers/calls.js";
import { upsertContact } from "../lib/resolve.js";

let db: Db;
const dirs: string[] = [];
beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const APPLE = 978307200; // 2001-01-01 unix offset, seconds

function makeCallDbFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "calls-"));
  dirs.push(dir);
  const path = join(dir, "CallHistory.storedata");
  const calls = new Database(path);
  calls.exec("CREATE TABLE ZCALLRECORD (Z_PK INTEGER PRIMARY KEY, ZADDRESS TEXT, ZDATE REAL, ZDURATION REAL, ZORIGINATED INTEGER, ZANSWERED INTEGER)");
  const at = new Date("2026-06-02T09:00:00Z").getTime() / 1000 - APPLE;
  calls.prepare("INSERT INTO ZCALLRECORD VALUES (1, '+4798212345', ?, 320.5, 0, 1)").run(at);
  calls.prepare("INSERT INTO ZCALLRECORD VALUES (2, '+4798212345', ?, 0, 1, 0)").run(at + 3600); // unanswered outgoing
  calls.close();
  return path;
}

describe("importCalls", () => {
  it("imports answered calls and unanswered calls as separate rows", () => {
    const known = upsertContact(db, { displayName: "Peter Karlsson", source: "contacts", identities: [{ kind: "phone", value: "+4798212345" }] });
    const summary = importCalls(db, makeCallDbFixture());
    expect(summary.calls).toBe(1);
    expect(summary.unanswered).toBe(1);
    // answered row
    const answeredRow = db.prepare("SELECT channel, direction, answered FROM interactions WHERE contact_id = ? AND answered = 1").get(known) as any;
    expect(answeredRow).toMatchObject({ channel: "call", direction: "inbound", answered: 1 });
    // unanswered row
    const unansweredRow = db.prepare("SELECT channel, direction, answered FROM interactions WHERE contact_id = ? AND answered = 0").get(known) as any;
    expect(unansweredRow).toMatchObject({ channel: "call", direction: "outbound", answered: 0 });
  });

  it("is idempotent — re-import adds no new rows", () => {
    const fixture = makeCallDbFixture();
    importCalls(db, fixture);
    importCalls(db, fixture);
    expect((db.prepare("SELECT COUNT(*) AS n FROM interactions").get() as any).n).toBe(2);
  });

  it("re-import summary reports zero new calls and unanswered", () => {
    const fixture = makeCallDbFixture();
    importCalls(db, fixture);
    const second = importCalls(db, fixture);
    expect(second.calls).toBe(0);
    expect(second.unanswered).toBe(0);
  });
});
