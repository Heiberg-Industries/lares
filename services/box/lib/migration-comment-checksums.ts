// Reviewed comment-only edits to an applied migration. A pair here lets the runner treat an edited
// file as unchanged: it skips the file when the ledger holds `before` and the file hashes to `after`.
// Exact hash pairs only. Never add a pair for changed SQL statements, and never normalise
// arbitrary SQL at runtime.
//
// Empty since the migration baseline (001_baseline.sql) replaced the pre-release history: every
// pair that lived here pointed at a file that history carried.
export const COMMENT_ONLY_MIGRATIONS: ReadonlyArray<{
  path: string;
  filename: string;
  before: string;
  after: string;
}> = [];

export function isCommentOnlyMigration(filename: string, before: string, after: string): boolean {
  return COMMENT_ONLY_MIGRATIONS.some(row => row.filename === filename && row.before === before && row.after === after);
}
