// The installation's own deny-list, read at run time from outside the repository. Tests that
// check generated text or source for private names take their patterns from here, so the names
// themselves never appear in this repository. With LARES_DENYLIST_FILE unset the list is empty
// and those assertions are skipped. The file has one regular expression per line; blank lines
// and lines starting with `#` are ignored; matching is case-insensitive and whole-word.
import { readFileSync } from "node:fs";

export function denylistPatterns(): RegExp[] {
  const path = process.env["LARES_DENYLIST_FILE"];
  if (!path) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${l})(?![\\p{L}\\p{N}_])`, "iu"));
}
