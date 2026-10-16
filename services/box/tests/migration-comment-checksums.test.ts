import { describe, it, expect } from "vitest";
import { COMMENT_ONLY_MIGRATIONS, isCommentOnlyMigration } from "../lib/migration-comment-checksums.js";

describe("reviewed comment-only edits", () => {
  it("holds none since the baseline replaced the pre-release history", () => {
    expect(COMMENT_ONLY_MIGRATIONS).toEqual([]);
    expect(isCommentOnlyMigration("001_baseline.sql", "a", "b")).toBe(false);
  });
});
