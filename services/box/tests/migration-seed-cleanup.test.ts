import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DOMAIN_SEED_CLEANUP } from "../lib/migration-seed-cleanup.js";
import { checksumOf } from "../lib/migration-ledger.js";
import { planMigrations } from "../lib/migration-runner.js";

const path = resolve(import.meta.dirname, "../sql/032_org_domains.sql");
const bytes = readFileSync(path, "utf8");
const file = { filename: DOMAIN_SEED_CLEANUP.filename, number: 32, path, bytes, checksum: checksumOf(bytes) };
const row = (checksum: string) => ({ filename: file.filename, number: 32, checksum, appliedAt: new Date(0), how: "applied" as const, tookMs: 0 });

describe("retired installation domain seed", () => {
  it("pins the exact replacement and applies it only when not already recorded", () => {
    expect(file.checksum).toBe(DOMAIN_SEED_CLEANUP.after);
    expect(planMigrations([file], []).steps[0]?.action).toBe("apply");
  });
  it.each(DOMAIN_SEED_CLEANUP.before)("skips known historical hash %s without altering its ledger row", hash => {
    const applied = Object.freeze(row(hash));
    expect(planMigrations([file], [applied]).steps[0]?.action).toBe("skip");
    expect(applied.checksum).toBe(hash);
  });
  it("refuses unknown history, edited replacement and mismatched filename", () => {
    expect(planMigrations([file], [row("unknown")]).steps[0]?.action).toBe("refuse");
    expect(planMigrations([{ ...file, checksum: checksumOf(bytes + "SELECT 1;") }], [row(DOMAIN_SEED_CLEANUP.before[0])]).steps[0]?.action).toBe("refuse");
    expect(planMigrations([{ ...file, filename: "033_other.sql" }], [{ ...row(DOMAIN_SEED_CLEANUP.before[0]), filename: "033_other.sql" }]).steps[0]?.action).toBe("refuse");
  });
});

import { IDENTITY_SEED_CLEANUP } from "../lib/migration-seed-cleanup.js";
for (const replacement of IDENTITY_SEED_CLEANUP) {
  it(`preserves existing identity data by skipping ${replacement.filename}`, () => {
    const path = resolve(import.meta.dirname, "../sql", replacement.filename);
    const bytes = readFileSync(path, "utf8");
    const file = { filename: replacement.filename, number: Number(replacement.filename.slice(0,3)), path, bytes, checksum: checksumOf(bytes) };
    expect(file.checksum).toBe(replacement.after);
    for (const hash of replacement.before) {
      const historical = { ...row(hash), filename: file.filename, number: file.number };
      expect(planMigrations([file], [historical]).steps[0]?.action).toBe("skip");
      expect(planMigrations([{ ...file, checksum: checksumOf(bytes + "SELECT 1;") }], [historical]).steps[0]?.action).toBe("refuse");
      expect(planMigrations([file], [{ ...historical, checksum: "unknown" }]).steps[0]?.action).toBe("refuse");
    }
    expect(planMigrations([file], []).steps[0]?.action).toBe("apply");
  });
}

import { OWNER_DEFAULT_CLEANUP } from "../lib/migration-seed-cleanup.js";
for (const replacement of OWNER_DEFAULT_CLEANUP) {
  it(`preserves historical rows while replacing owner default in ${replacement.path}`, () => {
    const path = resolve(import.meta.dirname, "../../..", replacement.path);
    const bytes = readFileSync(path, "utf8");
    const file = { filename: replacement.filename, number: Number(replacement.filename.slice(0,3)), path, bytes, checksum: checksumOf(bytes) };
    expect(file.checksum).toBe(replacement.after);
    const historical = { ...row(replacement.before[0]), filename: file.filename, number: file.number };
    expect(planMigrations([file], [historical]).steps[0]?.action).toBe("skip");
    expect(planMigrations([{...file, checksum: "modified"}], [historical]).steps[0]?.action).toBe("refuse");
    expect(planMigrations([file], [{...historical, checksum: "unknown"}]).steps[0]?.action).toBe("refuse");
  });
}
