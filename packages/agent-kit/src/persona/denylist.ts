// The installation's own deny-list, read at run time from outside the repository.
//
// A check that names the words it forbids is itself a leak, so the repository carries only
// generic rules (vocabulary.ts). An installation, or the CI of a fork, may point
// LARES_DENYLIST_FILE at a plain text file with one regular expression per line; every match is
// then reported by the lint as a `denied` finding. Blank lines and lines starting with `#` are
// ignored. Matching is case-insensitive and whole-word. With the variable unset, no deny-list
// is applied and only the generic rules run.
import { readFileSync, statSync } from "node:fs";

const WORD_START = "(?<![\\p{L}\\p{N}_])";
const WORD_END = "(?![\\p{L}\\p{N}_])";

/** One deny-list line as a whole-word, case-insensitive matcher. */
export function denyPattern(line: string): RegExp {
  return new RegExp(`${WORD_START}(?:${line})${WORD_END}`, "iu");
}

/** The matchers for the lines of a deny-list file's text. */
export function parseDenylist(text: string): RegExp[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map(denyPattern);
}

let cached: { key: string; patterns: RegExp[] } | undefined;

/** The deny-list from `LARES_DENYLIST_FILE`, or none when it is unset. A file that is named but
 *  cannot be read throws: a silent empty list would make the check look clean. */
export function loadDenyPatterns(env: Record<string, string | undefined> = process.env): RegExp[] {
  const path = env["LARES_DENYLIST_FILE"];
  if (!path) return [];
  const key = `${path}:${statSync(path).mtimeMs}`;
  if (cached?.key === key) return cached.patterns;
  const patterns = parseDenylist(readFileSync(path, "utf8"));
  cached = { key, patterns };
  return patterns;
}
