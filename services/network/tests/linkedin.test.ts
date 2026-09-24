import { describe, it, expect, beforeEach } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type Db } from "../lib/db.js";
import { importLinkedIn } from "../lib/importers/linkedin.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "linkedin");
const OWN = "https://www.linkedin.com/in/bendikheiberg";

let db: Db;
beforeEach(() => { db = openDb(":memory:"); });

describe("importLinkedIn", () => {
  it("imports connections as contacts with linkedin_url identities and positions", () => {
    const summary = importLinkedIn(db, FIXTURES, OWN);
    expect(summary.connections).toBe(2);
    const c = db.prepare("SELECT * FROM contacts WHERE display_name = 'Serhii Yelbaiev'").get() as any;
    expect(c.company).toBe("the0nlylink");
    const pos = db.prepare("SELECT company FROM positions WHERE contact_id = ?").all(c.id);
    expect(pos).toEqual([{ company: "the0nlylink" }]);
  });

  it("imports messages with direction relative to own profile", () => {
    importLinkedIn(db, FIXTURES, OWN);
    const rows = db
      .prepare("SELECT direction, content FROM interactions WHERE channel = 'linkedin' AND (content LIKE '%ringa%' OR content LIKE '%ringer%') ORDER BY at")
      .all() as any[];
    expect(rows.length).toBe(2);
    expect(rows[0].direction).toBe("inbound");
    expect(rows[1].direction).toBe("outbound");
  });

  it("attaches messages to the right contact via profile URL", () => {
    importLinkedIn(db, FIXTURES, OWN);
    const peter = db.prepare("SELECT id FROM contacts WHERE display_name = 'Peter Karlsson'").get() as any;
    const n = db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE contact_id = ?").get(peter.id) as any;
    expect(n.n).toBeGreaterThanOrEqual(2);
  });

  it("is idempotent — re-import adds nothing", () => {
    importLinkedIn(db, FIXTURES, OWN);
    const before = db.prepare("SELECT COUNT(*) AS n FROM interactions").get() as any;
    importLinkedIn(db, FIXTURES, OWN);
    const after = db.prepare("SELECT COUNT(*) AS n FROM interactions").get() as any;
    expect(after.n).toBe(before.n);
  });

  it("re-import summary reports zero new messages and invitations", () => {
    importLinkedIn(db, FIXTURES, OWN);
    const second = importLinkedIn(db, FIXTURES, OWN);
    expect(second.messages).toBe(0);
    expect(second.invitations).toBe(0);
    // connections is per-card processed (job-change detection semantics) — not asserted here
  });

  it("invitation rows get channel linkedin_invite, message rows keep channel linkedin", () => {
    importLinkedIn(db, FIXTURES, OWN);
    const invite = db.prepare("SELECT channel, direction FROM interactions WHERE channel = 'linkedin_invite'").get() as any;
    expect(invite).toBeTruthy();
    expect(invite.direction).toBe("outbound"); // Serhii invite was OUTGOING
    const messageCount = (db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE channel = 'linkedin'").get() as any).n;
    expect(messageCount).toBeGreaterThan(0);
  });

  it("emits job_change signal when a re-import shows a new company", () => {
    importLinkedIn(db, FIXTURES, OWN);
    db.prepare("UPDATE contacts SET company = 'OldCo' WHERE display_name = 'Serhii Yelbaiev'").run();
    importLinkedIn(db, FIXTURES, OWN);
    const sig = db.prepare("SELECT kind FROM signals").all() as any[];
    expect(sig.map((s) => s.kind)).toContain("job_change");
  });
});

describe("legacy invite cleanup", () => {
  it("removes a Phase-1 'linkedin'-channel twin of an invitation on re-import", () => {
    importLinkedIn(db, FIXTURES, OWN);
    const invite = db.prepare("SELECT external_id, contact_id FROM interactions WHERE channel = 'linkedin_invite'").get() as any;
    // simulate the pre-migration state: same invitation stored under 'linkedin'
    db.prepare("DELETE FROM interactions WHERE channel = 'linkedin_invite'").run();
    db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (?, 'linkedin', 'outbound', '2026-06-03T10:52:00Z', 'hei!', ?)").run(invite.contact_id, invite.external_id);
    importLinkedIn(db, FIXTURES, OWN);
    const rows = db.prepare("SELECT channel FROM interactions WHERE external_id = ?").all(invite.external_id) as any[];
    expect(rows).toEqual([{ channel: "linkedin_invite" }]);
  });
});
