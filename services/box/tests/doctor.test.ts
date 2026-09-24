// services/box/tests/doctor.test.ts — W8A-s6: `lares doctor` never touches Docker; every branch
// is exercised through a fake `Queryable` that answers by matching a substring of the SQL text
// (`fakeDb`, the same shape `tests/migration-runner.test.ts`'s neighbours use for a dry read).
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runDoctor, doctorReport, doctorExitCode, type CheckResult } from "../lib/doctor.js";

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, "..", "sql");

function fakeDb(answers: Record<string, unknown[]>) {
  return {
    async query<R = unknown>(text: string) {
      for (const [needle, rows] of Object.entries(answers)) {
        if (text.includes(needle)) return { rows: rows as R[], rowCount: rows.length };
      }
      return { rows: [] as R[], rowCount: 0 };
    },
  };
}
const find = (rs: CheckResult[], id: string) => rs.find((r) => r.id === id)!;

describe("lares doctor", () => {
  it("says the database is unreachable, and how to look, without a stack trace", async () => {
    const rs = await runDoctor({ db: null, env: {}, sqlDir: SQL_DIR, now: new Date() });
    expect(find(rs, "database").state).toBe("fail");
    expect(find(rs, "database").fix).toContain("lares logs");
    expect(doctorExitCode(rs)).toBe(1);
    expect(doctorReport(rs)).not.toMatch(/at Object\.|node:internal/);
  });

  it("fails when the console would admit an address from another installation", async () => {
    const rs = await runDoctor({ db: null, env: { NODE_ENV: "production" }, sqlDir: SQL_DIR, now: new Date() });
    const settings = find(rs, "settings");
    expect(settings.state).toBe("fail");
    expect(settings.say).toContain("CONSOLE_ALLOWED_EMAILS");
  });

  it("fails when the installation has no owner in the register", async () => {
    const rs = await runDoctor({
      db: fakeDb({ "FROM users": [] }), env: {}, sqlDir: SQL_DIR, now: new Date(),
    });
    expect(find(rs, "owner").state).toBe("fail");
    expect(find(rs, "owner").fix).toContain("lares first-owner");
  });

  it("fails when the only member is the engine's own seed", async () => {
    // The doctor reads the seed row out of the migration file itself, so this test stands up a
    // throwaway sql directory with a NEUTRAL seed — it never has to spell a real person's name.
    const seedDir = mkdtempSync(join(tmpdir(), "doctor-seed-"));
    writeFileSync(
      join(seedDir, "014_identity.sql"),
      "INSERT INTO users (id, display_name, primary_email) VALUES ('fixture-seed', 'Fixture Seed', 'seed@example.invalid');\n",
    );
    const rs = await runDoctor({
      db: fakeDb({ "FROM users": [{ id: "fixture-seed", display_name: "Fixture Seed", primary_email: "seed@example.invalid" }] }),
      env: {}, sqlDir: seedDir, now: new Date(),
    });
    rmSync(seedDir, { recursive: true, force: true });
    expect(find(rs, "owner").state).toBe("fail");
    expect(find(rs, "owner").say).toMatch(/left over from the engine/i);
  });

  it("says how many migrations would run, and never applies one", async () => {
    const rs = await runDoctor({
      db: fakeDb({ "FROM schema_migrations": [], "information_schema.tables": [] }),
      env: {}, sqlDir: SQL_DIR, now: new Date(),
    });
    const m = find(rs, "migrations");
    expect(m.state).toBe("warn");
    expect(m.say).toMatch(/\d+ migration/);
    expect(m.fix).toBe("pnpm -C services/box migrate");
  });

  it("says the backup is unproven when nothing has ever recorded a verdict", async () => {
    const rs = await runDoctor({
      db: fakeDb({ "FROM backup_status": [{ check_name: "verify", ok: null, checked_at: null, last_pass_at: null, detail: null, target: null }] }),
      env: {}, sqlDir: SQL_DIR, now: new Date(),
    });
    expect(find(rs, "backup").state).toBe("warn");
    expect(find(rs, "backup").say).toMatch(/never/i);
  });

  it("reports every open repair as its own line, in the owner's words", async () => {
    const rs = await runDoctor({
      db: fakeDb({ "FROM repairs": [{ kind: "identity", ref: "owner-key", severity: "error", what: "Two names for one person.", how_to_fix: "Run lares doctor.", breaks_in: null }] }),
      env: {}, sqlDir: SQL_DIR, now: new Date(),
    });
    expect(find(rs, "repairs").state).toBe("fail");
    expect(find(rs, "repairs").say).toContain("Two names for one person.");
  });

  // Added beyond the plan's own snippet — the task's own bar for this slice: "Read-only ... A test
  // records every SQL statement and asserts only SELECTs." None of the cases above proves that on
  // their own (a fake `Queryable` cannot tell a SELECT from an UPDATE by refusing one), so this
  // case records the literal text of every statement the doctor sends and checks it by hand.
  it("only ever reads — every statement it sends is a SELECT", async () => {
    const seen: string[] = [];
    const inner = fakeDb({
      "FROM users": [{ id: "fixture-owner", display_name: "A Name", primary_email: "owner@example.invalid" }],
      "FROM schema_migrations": [],
      "information_schema.tables": [],
      "FROM backup_status": [
        { check_name: "verify", ok: true, checked_at: new Date().toISOString(), last_pass_at: new Date().toISOString(), detail: null, target: "restic" },
      ],
      "FROM repairs": [],
    });
    const recording = {
      async query<R = unknown>(text: string) {
        seen.push(text);
        return inner.query<R>(text);
      },
    };
    await runDoctor({ db: recording, env: {}, sqlDir: SQL_DIR, now: new Date() });
    expect(seen.length).toBeGreaterThan(0);
    for (const text of seen) {
      expect(text.trim().toUpperCase().startsWith("SELECT"), text).toBe(true);
    }
  });

  it("never prints a secret's value, only its name", async () => {
    const rs = await runDoctor({
      db: fakeDb({ "FROM users": [{ id: "fixture-owner", display_name: "A Name", primary_email: "owner@example.invalid" }] }),
      env: { CONSOLE_SESSION_SECRET: "disposable-fixture-only", CONSOLE_ALLOWED_EMAILS: "owner@example.invalid" },
      sqlDir: SQL_DIR, now: new Date(),
    });
    expect(doctorReport(rs)).not.toContain("disposable-fixture-only");
  });
});
