// The one control file the seams eval writes between sessions: a JSON array of names. Read INSIDE
// every caller, never at module scope — eve evaluates these modules while compiling, where
// SEAM_GRANTS does not exist. Unreadable or absent ⇒ grant nothing, which is what board.eval.ts
// needs (an empty catalogue leaves the authored tools alone).
import { readFileSync } from "node:fs";

export function grantedNames(): string[] {
  const file = process.env["SEAM_GRANTS"];
  if (file === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}
