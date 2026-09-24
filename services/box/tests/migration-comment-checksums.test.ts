import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { COMMENT_ONLY_MIGRATIONS } from "../lib/migration-comment-checksums.js";
import { checksumOf } from "../lib/migration-ledger.js";
import { planMigrations } from "../lib/migration-runner.js";

describe("existing installations across namespace comment cleanup", () => {
  for (const row of COMMENT_ONLY_MIGRATIONS) {
    it(`preserves the recorded migration and rejects further edits: ${row.path}`, () => {
      const path = resolve(import.meta.dirname, "../../..", row.path);
      const bytes = readFileSync(path, "utf8");
      expect(checksumOf(bytes)).toBe(row.after);
      const file = { filename: basename(path), number: Number(basename(path).slice(0,3)), path, bytes, checksum: checksumOf(bytes) };
      const applied = { filename: file.filename, number: file.number, checksum: row.before, appliedAt: new Date(), how: "applied" as const, tookMs: 0 };
      expect(planMigrations([file], [applied]).steps[0]?.action).toBe("skip");
      expect(planMigrations([{...file, checksum: checksumOf(bytes + "\nDROP TABLE users;")}], [applied]).steps[0]?.action).toBe("refuse");
      expect(planMigrations([file], [{...applied, checksum: "unreviewed-old-file"}]).steps[0]?.action).toBe("refuse");
      expect(planMigrations([file], []).steps[0]?.action).toBe("apply");
    });
  }
});
