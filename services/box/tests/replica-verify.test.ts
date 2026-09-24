import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReplicaContentPolicy, verifyNoRawContent } from "../lib/replica-verify.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-09-02T12:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function makeDb(rows: { channel: string; at: string; content: string | null }[]): string {
  dir = mkdtempSync(join(tmpdir(), "replica-verify-"));
  const path = join(dir, "network.db");
  const db = new Database(path);
  db.exec(
    `CREATE TABLE interactions (id INTEGER PRIMARY KEY, contact_id INTEGER, channel TEXT, at TEXT, content TEXT, external_id TEXT);`,
  );
  rows.forEach((r, i) => {
    db.prepare("INSERT INTO interactions (contact_id, channel, at, content, external_id) VALUES (?,?,?,?,?)").run(
      1,
      r.channel,
      r.at,
      r.content,
      `x${i}`,
    );
  });
  db.close();
  return path;
}

describe("verifyReplicaContentPolicy", () => {
  it("passes a replica that obeys the policy (Meta stripped, rest within 90 days)", () => {
    const path = makeDb([
      { channel: "imessage", at: daysAgo(10), content: "hello" },
      { channel: "facebook", at: daysAgo(5), content: null },
      { channel: "linkedin", at: daysAgo(200), content: null },
    ]);
    const r = verifyReplicaContentPolicy(path, NOW);
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("FAILS if a Meta-channel row carries content", () => {
    const path = makeDb([{ channel: "facebook", at: daysAgo(1), content: "secret dm" }]);
    const r = verifyReplicaContentPolicy(path, NOW);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/facebook/);
  });

  it("FAILS if a non-Meta row older than 90 days carries content", () => {
    const path = makeDb([{ channel: "imessage", at: daysAgo(200), content: "old text" }]);
    const r = verifyReplicaContentPolicy(path, NOW);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/older than/);
  });

  it("keeps the verifyNoRawContent alias working (the push script's name)", () => {
    expect(verifyNoRawContent).toBe(verifyReplicaContentPolicy);
  });
});
