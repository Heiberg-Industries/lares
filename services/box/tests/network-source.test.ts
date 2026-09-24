/**
 * TDD for makeNetworkQuery — the real network data-source backed by the
 * read-only replica. Fixture is a minimal temp SQLite db built from raw DDL
 * (no @lares/network runtime helpers) so tests run without side effects.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNetworkQuery } from "../lib/network-source.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let dbPath: string;
let missingPath: string;

/** Minimal schema: only the tables/columns touched by whoAt/dormantQueue/personProfile. */
const MINIMAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id                    INTEGER PRIMARY KEY,
  display_name          TEXT NOT NULL,
  company               TEXT,
  title                 TEXT,
  source                TEXT NOT NULL DEFAULT 'test',
  resolved              INTEGER NOT NULL DEFAULT 1,
  notes                 TEXT,
  twenty_id_cache       TEXT,
  twenty_strength       TEXT,
  twenty_last_contacted TEXT,
  twenty_synced_at      TEXT
);
CREATE TABLE IF NOT EXISTS identities (
  id         INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL,
  source     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interactions (
  id          INTEGER PRIMARY KEY,
  contact_id  INTEGER NOT NULL,
  channel     TEXT NOT NULL,
  direction   TEXT,
  at          TEXT NOT NULL,
  content     TEXT,
  external_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pulse (
  contact_id          INTEGER PRIMARY KEY,
  score               REAL NOT NULL,
  band                TEXT NOT NULL,
  dormant_warm        INTEGER NOT NULL DEFAULT 0,
  last_interaction_at TEXT,
  components          TEXT NOT NULL DEFAULT '{}'
);
`;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lares-network-source-test-"));
  dbPath = join(tmpDir, "network.db");
  missingPath = join(tmpDir, "does-not-exist.db");

  // Build the fixture db with better-sqlite3 (read-write for seeding)
  const db = new Database(dbPath);
  db.exec(MINIMAL_SCHEMA);

  // Seed: one contact at Acme Corp with a pulse and a dormant-warm flag
  db.prepare(`
    INSERT INTO contacts (id, display_name, company, title, source)
    VALUES (1, 'Alice Danner', 'Acme Corp', 'CTO', 'test')
  `).run();

  db.prepare(`
    INSERT INTO pulse (contact_id, score, band, dormant_warm, last_interaction_at, components)
    VALUES (1, 72.0, 'WARM', 1, '2026-04-01T10:00:00Z', '{}')
  `).run();

  // Interactions with content = NULL to mirror the stripped replica
  db.prepare(`
    INSERT INTO interactions (contact_id, channel, direction, at, content, external_id)
    VALUES (1, 'linkedin', 'inbound', '2026-04-01T10:00:00Z', NULL, 'ext-1')
  `).run();
  db.prepare(`
    INSERT INTO interactions (contact_id, channel, direction, at, content, external_id)
    VALUES (1, 'imessage', 'outbound', '2026-03-15T09:00:00Z', NULL, 'ext-2')
  `).run();

  // Second contact with NO pulse — tests graceful LEFT JOIN
  db.prepare(`
    INSERT INTO contacts (id, display_name, company, title, source)
    VALUES (2, 'Bob Nilsen', 'Acme Corp', 'Engineer', 'test')
  `).run();

  db.close();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeNetworkQuery", () => {
  describe("who-at", () => {
    it("returns contacts at the seeded company", async () => {
      const query = makeNetworkQuery(dbPath);
      const rows = await query("who-at", { company: "Acme" }) as any[];
      expect(rows.length).toBe(2);
      const alice = rows.find((r: any) => r.displayName === "Alice Danner");
      expect(alice).toBeDefined();
      expect(alice.band).toBe("WARM");
    });

    it("returns empty array for an unknown company", async () => {
      const query = makeNetworkQuery(dbPath);
      const rows = await query("who-at", { company: "Nonexistent Inc" }) as any[];
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(0);
    });
  });

  describe("dormant", () => {
    it("returns an array (proves dispatch + open/close cycle)", async () => {
      const query = makeNetworkQuery(dbPath);
      const rows = await query("dormant", {}) as any[];
      expect(Array.isArray(rows)).toBe(true);
    });

    it("returns the dormant-warm seeded contact", async () => {
      const query = makeNetworkQuery(dbPath);
      const rows = await query("dormant", { limit: 10 }) as any[];
      expect(rows.some((r: any) => r.displayName === "Alice Danner")).toBe(true);
    });
  });

  describe("person", () => {
    it("returns the seeded person profile", async () => {
      const query = makeNetworkQuery(dbPath);
      const result = await query("person", { name: "Alice Danner" }) as any;
      expect(result).not.toBeNull();
      expect(result.contact.displayName).toBe("Alice Danner");
      expect(result.contact.company).toBe("Acme Corp");
    });

    it("all interactions have content === null (stripping is visible)", async () => {
      const query = makeNetworkQuery(dbPath);
      const result = await query("person", { name: "Alice Danner" }) as any;
      expect(result.interactions.length).toBeGreaterThan(0);
      for (const interaction of result.interactions) {
        expect(interaction.content).toBeNull();
      }
    });

    it("returns null for unknown person", async () => {
      const query = makeNetworkQuery(dbPath);
      const result = await query("person", { name: "Nobody Known" });
      expect(result).toBeNull();
    });
  });

  describe("unknown verb", () => {
    it("rejects with 'unknown network verb'", async () => {
      const query = makeNetworkQuery(dbPath);
      await expect(query("bogus", {})).rejects.toThrow(/unknown network verb/i);
    });
  });

  describe("missing db path", () => {
    it("throws when the file does not exist (fileMustExist)", async () => {
      const query = makeNetworkQuery(missingPath);
      await expect(query("who-at", { company: "x" })).rejects.toThrow();
    });
  });
});
