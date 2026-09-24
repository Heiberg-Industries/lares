import { describe, it, expect, beforeEach } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type Db } from "../lib/db.js";
import { runImport, recomputePulse } from "../lib/import-all.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "linkedin");
const META_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "meta");

let db: Db;
beforeEach(() => { db = openDb(":memory:"); });

describe("runImport", () => {
  it.each(["", "   "])("rejects blank LinkedIn identity before any source is read (%j)", (identity) => {
    expect(() => runImport(db, { linkedInDir: FIXTURES, ownLinkedInUrl: identity }))
      .toThrow("Set ownLinkedInUrl");
    expect(db.prepare("SELECT COUNT(*) AS n FROM contacts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM import_runs").get()).toEqual({ n: 0 });
  });

  it.each([undefined, "", "   "])("rejects missing Meta identity before LinkedIn or Apple imports (%j)", (identity) => {
    expect(() => runImport(db, {
      linkedInDir: FIXTURES, ownLinkedInUrl: "https://www.linkedin.com/in/example-owner",
      metaDir: META_FIXTURES, ownMetaName: identity,
    })).toThrow("Set ownMetaName");
    expect(db.prepare("SELECT COUNT(*) AS n FROM contacts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM import_runs").get()).toEqual({ n: 0 });
  });

  it("imports linkedin, recomputes pulse for every contact, records the run", () => {
    const report = runImport(db, {
      linkedInDir: FIXTURES,
      ownLinkedInUrl: "https://www.linkedin.com/in/bendikheiberg",
      sources: { contacts: false, imessage: false, calls: false }, // Apple dbs unavailable in CI/tests
    });
    expect(report.linkedin?.connections).toBe(2);
    expect(report.callSignals).toBe(0);
    const pulses = db.prepare("SELECT COUNT(*) AS n FROM pulse").get() as any;
    const contacts = db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as any;
    expect(pulses.n).toBe(contacts.n);
    const runs = db.prepare("SELECT source, summary FROM import_runs").all() as any[];
    expect(runs.length).toBe(1);
    expect(JSON.parse(runs[0].summary).linkedin.connections).toBe(2);
  });

  it("emits cadence_break when a previously-warm pulse turns dormant", () => {
    // seed: a contact warm in the past (old interactions), pulse row says GOOD
    const contactId = db
      .prepare("INSERT INTO contacts (display_name, source) VALUES ('Old Friend', 'test')")
      .run().lastInsertRowid as number;
    const ins = db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, external_id) VALUES (?, 'imessage', ?, ?, ?)");
    const old = new Date(Date.now() - 220 * 86_400_000);
    for (let i = 0; i < 8; i++) {
      const at = new Date(old.getTime() + i * 86_400_000).toISOString();
      ins.run(contactId, i % 2 ? "inbound" : "outbound", at, `seed-${i}`);
    }
    db.prepare("INSERT INTO pulse (contact_id, score, band, dormant_warm, last_interaction_at, components) VALUES (?, 5, 'GOOD', 0, ?, '{}')").run(
      contactId, old.toISOString(),
    );
    runImport(db, { ownLinkedInUrl: "https://www.linkedin.com/in/bendikheiberg", sources: { contacts: false, imessage: false, calls: false } });
    const sig = db.prepare("SELECT kind FROM signals WHERE contact_id = ?").all(contactId) as any[];
    expect(sig.map((s) => s.kind)).toContain("cadence_break");
    const p = db.prepare("SELECT dormant_warm FROM pulse WHERE contact_id = ?").get(contactId) as any;
    expect(p.dormant_warm).toBe(1);
  });

  it("ingests a meta export when metaDir is given", () => {
    const report = runImport(db, {
      ownLinkedInUrl: "https://www.linkedin.com/in/bendikheiberg",
      ownMetaName: "Bendik Heiberg",
      metaDir: META_FIXTURES,
      sources: { contacts: false, imessage: false, calls: false },
    });
    expect(report.meta).toBeTruthy();
    expect(report.meta!.instagram.messages).toBe(3);
    expect(report.meta!.facebook.messages).toBe(2);
  });

  it("invite-only + unanswered-call-only contact gets NO_CONNECTION band and score 0", () => {
    // A contact whose ONLY interactions are 1 outbound invite + 1 outbound unanswered call
    // should not score: an invite is excluded by channel, and 1 call alone is not reciprocal.
    // After Fix 1, the outbound call IS included in recency — but score/band still 0.
    const contactId = db
      .prepare("INSERT INTO contacts (display_name, source) VALUES ('Ghost Contact', 'test')")
      .run().lastInsertRowid as number;
    db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, answered, external_id) VALUES (?, 'linkedin_invite', 'outbound', '2026-06-01T10:00:00.000Z', NULL, 'ghost-invite')").run(contactId);
    db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, answered, external_id) VALUES (?, 'call', 'outbound', '2026-06-02T10:00:00.000Z', 0, 'ghost-call')").run(contactId);
    recomputePulse(db, new Date("2026-06-10T00:00:00Z"));
    const pulse = db.prepare("SELECT band, score FROM pulse WHERE contact_id = ?").get(contactId) as any;
    expect(pulse.band).toBe("NO_CONNECTION");
    expect(pulse.score).toBe(0);
  });

  it("outbound call (answered=0) counts for recency — prevents false dormant-warm flag", () => {
    // Fredrik case at the DB level: old reciprocal history qualifies for dormant-warm,
    // but Bendik placed an outbound call recently. macOS logs answered=0 for ALL outbound calls.
    // After Fix 1, the outbound call should be included in recomputePulse rows so
    // last_interaction_at reflects the call and dormant_warm = 0.
    const contactId = db
      .prepare("INSERT INTO contacts (display_name, source) VALUES ('Fredrik Pettersson', 'test')")
      .run().lastInsertRowid as number;
    const ins = db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, answered, external_id) VALUES (?, ?, ?, ?, ?, ?)");
    // Old reciprocal history (beyond silence window)
    const oldDate = new Date("2025-07-01T12:00:00Z");
    for (let i = 0; i < 6; i++) {
      const at = new Date(oldDate.getTime() + i * 86_400_000).toISOString();
      ins.run(contactId, "imessage", i % 2 ? "inbound" : "outbound", at, null, `old-${i}`);
    }
    // Recent outbound call with answered=0 (macOS limitation)
    ins.run(contactId, "call", "outbound", "2026-06-01T10:00:00Z", 0, "recent-call");
    const now = new Date("2026-06-22T00:00:00Z");
    recomputePulse(db, now);
    const pulse = db.prepare("SELECT dormant_warm, last_interaction_at FROM pulse WHERE contact_id = ?").get(contactId) as any;
    expect(pulse.dormant_warm).toBe(0);
    expect(pulse.last_interaction_at).toBe("2026-06-01T10:00:00.000Z");
  });

  it("twenty_last_contacted wires into pulse — prevents false dormant-warm when CRM shows recent contact", () => {
    // Fredrik case at the DB level with twenty_last_contacted set on the contact.
    // Old interactions only, but CRM says contacted recently.
    const contactId = db
      .prepare("INSERT INTO contacts (display_name, source, twenty_last_contacted) VALUES ('CRM Contact', 'test', '2026-06-11T00:00:00.000Z')")
      .run().lastInsertRowid as number;
    const ins = db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, answered, external_id) VALUES (?, ?, ?, ?, ?, ?)");
    const oldDate = new Date("2025-07-01T12:00:00Z");
    for (let i = 0; i < 6; i++) {
      const at = new Date(oldDate.getTime() + i * 86_400_000).toISOString();
      ins.run(contactId, "imessage", i % 2 ? "inbound" : "outbound", at, null, `old-${i}`);
    }
    const now = new Date("2026-06-22T00:00:00Z");
    recomputePulse(db, now);
    const pulse = db.prepare("SELECT dormant_warm, last_interaction_at FROM pulse WHERE contact_id = ?").get(contactId) as any;
    expect(pulse.dormant_warm).toBe(0);
    expect(pulse.last_interaction_at).toBe("2026-06-11T00:00:00.000Z");
  });
});
