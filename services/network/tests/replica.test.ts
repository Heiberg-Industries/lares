import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, openDbReadOnly } from "../lib/db.js";
import { exportStrippedReplica } from "../lib/replica.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SECRET = "SECRET_MESSAGE_BODY_d3adb33f";
const NOW = new Date("2026-09-02T12:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function seed(path: string): void {
  const db = openDb(path);
  db.prepare("INSERT INTO contacts (id, display_name, source) VALUES (1, 'Ada Lovelace', 'imessage')").run();
  db.prepare(
    "INSERT INTO identities (contact_id, kind, value, source) VALUES (1, 'phone', '+4790000000', 'imessage')",
  ).run();
  // recent imessage — within the 90-day window, content survives
  db.prepare(
    "INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (1,'imessage','inbound',?,?, 'm1')",
  ).run(daysAgo(10), "recent imessage body");
  // old imessage — outside the window, content stripped
  db.prepare(
    "INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (1,'imessage','inbound',?,?, 'm2')",
  ).run(daysAgo(200), "old imessage body");
  // facebook, recent — Meta channel, always stripped regardless of age
  db.prepare(
    "INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (1,'facebook','inbound',?,?, 'm3')",
  ).run(daysAgo(5), "facebook body");
  // linkedin, recent — non-Meta, within window, content survives
  db.prepare(
    "INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (1,'linkedin','inbound',?,?, 'm4')",
  ).run(daysAgo(5), "linkedin body");
  db.prepare(
    "INSERT INTO pulse (contact_id, score, band, last_interaction_at, components) VALUES (1, 0.82, 'warm', '2026-05-02T09:00:00Z', '{}')",
  ).run();
  db.prepare(
    "INSERT INTO signals (contact_id, kind, at, evidence) VALUES (1,'cadence_break','2026-05-10T00:00:00Z','no reply in 30d')",
  ).run();
  db.close();
}

describe("exportStrippedReplica", () => {
  it("strips Meta channels always + non-Meta content older than 90 days; keeps the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "replica-test-"));
    dirs.push(dir);
    const src = join(dir, "network.db");
    const dest = join(dir, "replica.db");
    seed(src);

    const result = exportStrippedReplica(src, dest, NOW);
    expect(result.rowsStripped).toBe(2); // old imessage + facebook
    expect(result.rowsKept).toBe(2); // recent imessage + linkedin

    const rep = openDbReadOnly(dest);
    try {
      const kept = rep
        .prepare("SELECT content FROM interactions WHERE content IS NOT NULL ORDER BY content")
        .all() as { content: string }[];
      expect(kept.map((r) => r.content)).toEqual(["linkedin body", "recent imessage body"]);
      // metadata (row count) is preserved even for stripped rows
      expect((rep.prepare("SELECT COUNT(*) AS n FROM interactions").get() as { n: number }).n).toBe(4);
      // identities, pulse, signals survive (what agents on the box actually query)
      expect((rep.prepare("SELECT value FROM identities WHERE contact_id=1").get() as { value: string }).value).toBe(
        "+4790000000",
      );
      expect((rep.prepare("SELECT band FROM pulse WHERE contact_id=1").get() as { band: string }).band).toBe("warm");
      expect((rep.prepare("SELECT COUNT(*) AS n FROM signals").get() as { n: number }).n).toBe(1);
    } finally {
      rep.close();
    }
  });

  it("leaves NO trace of the raw content anywhere in the replica file bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "replica-bytes-"));
    dirs.push(dir);
    const src = join(dir, "network.db");
    const dest = join(dir, "replica.db");
    const db = openDb(src);
    db.prepare("INSERT INTO contacts (id, display_name, source) VALUES (1, 'Ada Lovelace', 'imessage')").run();
    // facebook: a Meta channel, so it is stripped regardless of `now` or age
    db.prepare(
      "INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (1,'facebook','inbound','2026-05-01T10:00:00Z',?, 'm1')",
    ).run(SECRET);
    db.prepare(
      "INSERT INTO interactions (contact_id, channel, direction, at, content, external_id) VALUES (1,'facebook','outbound','2026-05-01T10:01:00Z',?, 'm2')",
    ).run(SECRET + "-reply");
    db.close();

    // sanity: the secret IS present in the source file
    expect(readFileSync(src).includes(Buffer.from(SECRET))).toBe(true);

    exportStrippedReplica(src, dest);

    // privacy guarantee: the secret is NOT present anywhere in the replica file
    expect(readFileSync(dest).includes(Buffer.from(SECRET))).toBe(false);
  });

  it("throws a readable error when the source is missing", () => {
    expect(() => exportStrippedReplica("/nonexistent/foo.db", "/tmp/x.db")).toThrow(/not found/i);
  });
});
