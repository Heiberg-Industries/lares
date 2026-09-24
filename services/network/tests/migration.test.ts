import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../lib/db.js";

const dirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mig-test-"));
  dirs.push(dir);
  return join(dir, "network.db");
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Build a v1 database the way Phase 1 left it: v1 DDL, user_version 0, live-ish data. */
function makeV1Db(path: string): void {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE contacts (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, company TEXT, title TEXT, source TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 1, notes TEXT);
    CREATE TABLE identities (id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('email','phone','linkedin_url')), value TEXT NOT NULL, source TEXT NOT NULL, UNIQUE (kind, value));
    CREATE INDEX idx_identities_contact ON identities(contact_id);
    CREATE TABLE interactions (id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, channel TEXT NOT NULL CHECK (channel IN ('linkedin','imessage','call')), direction TEXT CHECK (direction IN ('inbound','outbound')), at TEXT NOT NULL, content TEXT, external_id TEXT NOT NULL, UNIQUE (channel, external_id));
    CREATE INDEX idx_interactions_contact ON interactions(contact_id, at);
    CREATE TABLE positions (id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, company TEXT NOT NULL, title TEXT, observed_at TEXT NOT NULL, UNIQUE (contact_id, company, title));
    CREATE TABLE signals (id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('job_change','promotion','company_switch','cadence_break')), at TEXT NOT NULL, evidence TEXT NOT NULL);
    CREATE TABLE pulse (contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE, score REAL NOT NULL, band TEXT NOT NULL, dormant_warm INTEGER NOT NULL DEFAULT 0, last_interaction_at TEXT, components TEXT NOT NULL);
    CREATE TABLE import_runs (id INTEGER PRIMARY KEY, source TEXT NOT NULL, ran_at TEXT NOT NULL, file_hash TEXT, summary TEXT NOT NULL);
    CREATE TABLE identity_overrides (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('merge','detach')), from_contact INTEGER NOT NULL, into_contact INTEGER, detail TEXT, created_at TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO contacts (display_name, source) VALUES ('Test Person', 'test')").run();
  db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (1,'linkedin','inbound','2026-01-01T00:00:00Z',NULL,'inv-1')").run(); // an invitation
  db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (1,'linkedin','inbound','2026-01-02T00:00:00Z','hello','msg-1')").run();
  db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (1,'call','inbound','2026-01-03T00:00:00Z',NULL,'call-1')").run();
  db.close();
}

describe("v1 → v2 migration", () => {
  it("migrates a live v1 db: invite rechanneled, calls answered=1, new columns/kinds usable", () => {
    const path = tempDbPath();
    makeV1Db(path);
    const db = openDb(path);
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    expect(db.prepare("SELECT channel FROM interactions WHERE external_id='inv-1'").get()).toEqual({ channel: "linkedin_invite" });
    expect(db.prepare("SELECT channel, answered FROM interactions WHERE external_id='msg-1'").get()).toEqual({ channel: "linkedin", answered: null });
    expect(db.prepare("SELECT answered FROM interactions WHERE external_id='call-1'").get()).toEqual({ answered: 1 });
    db.prepare("INSERT INTO identities (contact_id, kind, value, source) VALUES (1,'twenty_id','abc-123','twenty')").run();
    db.prepare("INSERT INTO signals (contact_id, kind, at, evidence) VALUES (1,'call_unreturned','2026-06-10T00:00:00Z','{}')").run();
    db.prepare("INSERT INTO interactions (contact_id, channel, direction, at, content, external_id, answered) VALUES (1,'call','outbound','2026-06-01T00:00:00Z',NULL,'call-2',0)").run();
    db.prepare("UPDATE contacts SET twenty_strength='GOOD', twenty_last_contacted='2026-06-01T00:00:00Z', twenty_synced_at='2026-06-10T00:00:00Z', twenty_id_cache='abc-123' WHERE id=1").run();
    db.close();
  });

  it("data survives the rebuild (row counts + a spot value)", () => {
    const path = tempDbPath();
    makeV1Db(path);
    const db = openDb(path);
    expect((db.prepare("SELECT COUNT(*) AS n FROM interactions").get() as any).n).toBe(3);
    expect((db.prepare("SELECT display_name FROM contacts WHERE id=1").get() as any).display_name).toBe("Test Person");
    db.close();
  });

  it("fresh dbs are created at v4 directly and re-open is a no-op", () => {
    const path = tempDbPath();
    const db1 = openDb(path);
    expect(db1.pragma("user_version", { simple: true })).toBe(5);
    db1.prepare("INSERT INTO contacts (display_name, source) VALUES ('X','t')").run();
    db1.close();
    const db2 = openDb(path);
    expect((db2.prepare("SELECT COUNT(*) AS n FROM contacts").get() as any).n).toBe(1);
    db2.close();
  });
});

describe("v2 → v3 migration (digest_runs)", () => {
  it("adds digest_runs to an existing v2 db without touching data", () => {
    const path = tempDbPath();
    // Simulate a real v2 db: current schema minus digest_runs, stamped 2.
    const v2 = openDb(path);
    v2.prepare("INSERT INTO contacts (display_name, source) VALUES ('Keep Me','t')").run();
    v2.exec("DROP TABLE digest_runs");
    v2.pragma("user_version = 2");
    v2.close();

    const db = openDb(path);
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    db.prepare("INSERT INTO digest_runs (iso_week, posted_at, summary) VALUES ('2026-W24','2026-06-11T09:30:00Z','{}')").run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as any).n).toBe(1);
    db.close();
  });

  it("digest_runs.iso_week is unique", () => {
    const db = openDb(":memory:");
    const ins = db.prepare("INSERT INTO digest_runs (iso_week, posted_at, summary) VALUES (?,?,?)");
    ins.run("2026-W24", "2026-06-11T09:30:00Z", "{}");
    expect(() => ins.run("2026-W24", "2026-06-12T09:30:00Z", "{}")).toThrow();
    db.close();
  });
});

describe("v3 → v4 migration", () => {
  it("adds instagram/facebook channels, instagram/meta_name identity kinds, and the handles table", () => {
    const path = tempDbPath();
    // Build a v3 db by opening fresh on the CURRENT schema, then forcing version back to 3
    // is not possible (schema already v4). Instead build from a v1 db and let migrate() run.
    makeV1Db(path);
    const db = openDb(path);
    expect(db.pragma("user_version", { simple: true })).toBe(5);

    db.prepare(
      "INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (1,'instagram','inbound','2026-06-01T00:00:00Z','hi','ig-1')",
    ).run();
    db.prepare(
      "INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (1,'facebook','outbound','2026-06-02T00:00:00Z','yo','fb-1')",
    ).run();
    db.prepare("INSERT INTO identities (contact_id, kind, value, source) VALUES (1,'instagram','someuser','instagram')").run();
    db.prepare("INSERT INTO identities (contact_id, kind, value, source) VALUES (1,'meta_name','ola nordmann','facebook')").run();
    db.prepare(
      "INSERT INTO handles (platform, handle, display_name, relation, contact_id, observed_at) VALUES ('instagram','someuser','Some User','following',1,'2026-06-01T00:00:00Z')",
    ).run();
    const n = db.prepare("SELECT COUNT(*) AS n FROM handles").get() as { n: number };
    expect(n.n).toBe(1);
    db.close();
  });
});

describe("v4 → v5 migration (Slack)", () => {
  /** Simulate a real, already-installed v4 db: current schema minus the v5 widening, stamped 4. */
  function makeV4Db(path: string): void {
    const db = openDb(path);
    db.prepare("INSERT INTO contacts (display_name, source) VALUES ('Keep Me','t')").run();
    db.prepare(
      "INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (1,'imessage','inbound','2026-01-01T00:00:00Z','hi','msg-1')",
    ).run();
    db.exec(`
      DROP TABLE slack_cursors;
      CREATE TABLE interactions_v4 (
        id          INTEGER PRIMARY KEY,
        contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        channel     TEXT NOT NULL CHECK (channel IN ('linkedin','linkedin_invite','imessage','call','instagram','facebook')),
        direction   TEXT CHECK (direction IN ('inbound','outbound')),
        at          TEXT NOT NULL,
        content     TEXT,
        external_id TEXT NOT NULL,
        answered    INTEGER,
        UNIQUE (channel, external_id)
      );
      INSERT INTO interactions_v4 SELECT id, contact_id, channel, direction, at, content, external_id, answered FROM interactions;
      DROP TABLE interactions;
      ALTER TABLE interactions_v4 RENAME TO interactions;
      CREATE INDEX idx_interactions_contact ON interactions(contact_id, at);

      CREATE TABLE identities_v4 (
        id         INTEGER PRIMARY KEY,
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('email','phone','linkedin_url','twenty_id','instagram','meta_name')),
        value      TEXT NOT NULL,
        source     TEXT NOT NULL,
        UNIQUE (kind, value)
      );
      INSERT INTO identities_v4 SELECT id, contact_id, kind, value, source FROM identities;
      DROP TABLE identities;
      ALTER TABLE identities_v4 RENAME TO identities;
      CREATE INDEX idx_identities_contact ON identities(contact_id);
    `);
    db.pragma("user_version = 4");
    db.close();
  }

  it("a Slack row is rejected by an unmigrated v4 CHECK constraint (proves the widening is load-bearing)", () => {
    const path = tempDbPath();
    makeV4Db(path);
    const raw = new Database(path);
    expect(() =>
      raw
        .prepare(
          "INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (1,'slack','inbound','2026-08-24T00:00:00Z',NULL,'C1:1.1')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    raw.close();
  });

  it("openDb on an already-installed v4 db auto-migrates: widens channel/kind CHECKs, adds slack_cursors, keeps data", () => {
    const path = tempDbPath();
    makeV4Db(path);

    const db = openDb(path); // the mere act of opening the existing installed db upgrades it
    expect(db.pragma("user_version", { simple: true })).toBe(5);

    // prior data survived the rebuild
    expect((db.prepare("SELECT COUNT(*) AS n FROM contacts").get() as any).n).toBe(1);
    expect(db.prepare("SELECT channel FROM interactions WHERE external_id='msg-1'").get()).toEqual({ channel: "imessage" });

    // the widened CHECKs now admit 'slack' / 'slack_user'
    db.prepare(
      "INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (1,'slack','inbound','2026-08-24T00:00:00Z',NULL,'C1:1.1')",
    ).run();
    db.prepare("INSERT INTO identities (contact_id, kind, value, source) VALUES (1,'slack_user','U123','slack')").run();
    expect(db.prepare("SELECT channel FROM interactions WHERE external_id='C1:1.1'").get()).toEqual({ channel: "slack" });

    // slack_cursors exists and is usable
    db.prepare(
      "INSERT INTO slack_cursors (conversation_id, oldest, resume_cursor, pending_high_water, updated_at) VALUES ('C1','1.1',NULL,NULL,'2026-08-24T00:00:00Z')",
    ).run();
    expect(db.prepare("SELECT oldest FROM slack_cursors WHERE conversation_id='C1'").get()).toEqual({ oldest: "1.1" });
    db.close();
  });
});
