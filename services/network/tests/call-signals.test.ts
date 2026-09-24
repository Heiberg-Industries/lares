import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../lib/db.js";
import { detectCallUnreturned } from "../lib/call-signals.js";

let db: Db;
const NOW = new Date("2026-06-10T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function contact(name: string): number {
  return Number(db.prepare("INSERT INTO contacts (display_name, source) VALUES (?, 'test')").run(name).lastInsertRowid);
}
function call(c: number, dir: string, at: string, answered: number, ext: string): void {
  db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, external_id, answered) VALUES (?, 'call', ?, ?, ?, ?)").run(c, dir, at, ext, answered);
}
beforeEach(() => { db = openDb(":memory:"); });

describe("detectCallUnreturned", () => {
  it("fires for 2+ recent unanswered outbound calls with nothing back", () => {
    const c = contact("Ghosting Gary");
    call(c, "outbound", days(20), 0, "u1");
    call(c, "outbound", days(10), 0, "u2");
    const n = detectCallUnreturned(db, NOW);
    expect(n).toBe(1);
    const sig = db.prepare("SELECT kind FROM signals WHERE contact_id = ?").get(c) as any;
    expect(sig.kind).toBe("call_unreturned");
  });

  it("does NOT fire when the call was returned (inbound after first unanswered)", () => {
    const c = contact("Peter Pattern");
    call(c, "outbound", days(20), 0, "u1");
    call(c, "inbound", days(19), 1, "back1"); // called back
    call(c, "outbound", days(5), 0, "u2");
    expect(detectCallUnreturned(db, NOW)).toBe(0);
  });

  it("does NOT fire on a single unanswered call", () => {
    const c = contact("One Try Tina");
    call(c, "outbound", days(3), 0, "u1");
    expect(detectCallUnreturned(db, NOW)).toBe(0);
  });

  it("ignores unanswered calls older than 90 days", () => {
    const c = contact("Ancient History");
    call(c, "outbound", days(120), 0, "u1");
    call(c, "outbound", days(100), 0, "u2");
    expect(detectCallUnreturned(db, NOW)).toBe(0);
  });

  it("dedupes: does not re-fire within 90 days", () => {
    const c = contact("Already Flagged");
    call(c, "outbound", days(20), 0, "u1");
    call(c, "outbound", days(10), 0, "u2");
    expect(detectCallUnreturned(db, NOW)).toBe(1);
    expect(detectCallUnreturned(db, NOW)).toBe(0);
  });

  it("an inbound MESSAGE after the calls also counts as 'returned'", () => {
    const c = contact("Texts Back Trude");
    call(c, "outbound", days(20), 0, "u1");
    call(c, "outbound", days(10), 0, "u2");
    db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, external_id) VALUES (?, 'imessage', 'inbound', ?, 'm1')").run(c, days(8));
    expect(detectCallUnreturned(db, NOW)).toBe(0);
  });
});
