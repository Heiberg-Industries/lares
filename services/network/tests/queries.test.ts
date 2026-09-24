import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../lib/db.js";
import { upsertContact } from "../lib/resolve.js";
import { recomputePulse } from "../lib/import-all.js";
import { whoAt, dormantQueue, personProfile, readOnlySql } from "../lib/queries.js";

let db: Db;
const NOW = new Date("2026-06-10T12:00:00Z");

beforeEach(() => {
  db = openDb(":memory:");
  const peter = upsertContact(db, { displayName: "Peter Karlsson", company: "Curamando", title: "Consultant", source: "test", identities: [{ kind: "phone", value: "+4798212345" }] });
  const ins = db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, external_id) VALUES (?, 'imessage', ?, ?, ?)");
  for (let i = 0; i < 6; i++) {
    ins.run(peter, i % 2 ? "inbound" : "outbound", new Date(NOW.getTime() - i * 2 * 86_400_000).toISOString(), `q-${i}`);
  }
  upsertContact(db, { displayName: "Cold Contact", company: "Curamando", source: "test", identities: [{ kind: "email", value: "cold@example.com" }] });
  recomputePulse(db, NOW);
});

describe("whoAt", () => {
  it("lists contacts at a company, warmest first", () => {
    const rows = whoAt(db, "curamando");
    expect(rows.length).toBe(2);
    expect(rows[0].displayName).toBe("Peter Karlsson");
    expect(rows[0].band).not.toBe("NO_CONNECTION");
  });

  it("surfaces the Twenty cache columns; null when never synced", () => {
    const peterId = (db.prepare("SELECT id FROM contacts WHERE display_name = 'Peter Karlsson'").get() as any).id;
    db.prepare("UPDATE contacts SET twenty_strength='GOOD', twenty_last_contacted='2026-06-01T00:00:00Z' WHERE id=?").run(peterId);
    const rows = whoAt(db, "curamando");
    expect(rows[0].twentyStrength).toBe("GOOD");
    expect(rows[0].twentyLastContacted).toBe("2026-06-01T00:00:00Z");
    expect(rows[1].twentyStrength).toBeNull();
    expect(rows[1].twentyLastContacted).toBeNull();
  });
});

describe("personProfile", () => {
  it("returns profile + recent interactions by fuzzy name", () => {
    const p = personProfile(db, "peter karlsson");
    expect(p?.contact.company).toBe("Curamando");
    expect(p?.interactions.length).toBe(6);
  });

  it("blends the Twenty cache columns into the contact; null when never synced", () => {
    const peterId = (db.prepare("SELECT id FROM contacts WHERE display_name = 'Peter Karlsson'").get() as any).id;
    db.prepare("UPDATE contacts SET twenty_strength='GOOD', twenty_last_contacted='2026-06-01T00:00:00Z' WHERE id=?").run(peterId);
    const p = personProfile(db, "peter karlsson");
    expect(p?.contact.twentyStrength).toBe("GOOD");
    expect(p?.contact.twentyLastContacted).toBe("2026-06-01T00:00:00Z");
    const cold = personProfile(db, "cold contact");
    expect(cold?.contact.twentyStrength).toBeNull();
    expect(cold?.contact.twentyLastContacted).toBeNull();
  });
});

describe("dormantQueue", () => {
  it("returns only dormant-warm contacts", () => {
    expect(dormantQueue(db).every((r) => r.dormantWarm)).toBe(true);
  });
});

describe("readOnlySql", () => {
  it("runs SELECTs", () => {
    const rows = readOnlySql(db, "SELECT COUNT(*) AS n FROM contacts");
    expect(rows).toEqual([{ n: 2 }]);
  });
  it("rejects writes", () => {
    expect(() => readOnlySql(db, "DELETE FROM contacts")).toThrow(/read-only/i);
  });
});

describe("readOnlySql hardening", () => {
  it("rejects CTE-wrapped writes that pass the prefix regex", () => {
    expect(() => readOnlySql(db, "WITH x AS (SELECT 1) DELETE FROM contacts RETURNING *")).toThrow(/read-only/i);
    expect((db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as any).n).toBe(2);
  });
});
