// services/atlas/lib/frontmatter.ts
// Parse and edit Atlas frontmatter WITHOUT re-serialising it.
//
// Why not a YAML round-trip: re-serialising rewrites quoting, key order and comments on
// every write. That turns a no-op run into a diff, a diff into a commit, and a commit into
// a source change (notes are `atlas:` sources for each other) — the "correct for one tick,
// broken on the next" defect, arrived at by tidiness. The parse side is shallow; the WRITE
// side is line-surgical.

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
}

const FENCE = "---";

function frontmatterEnd(raw: string): number {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== FENCE) {
    throw new Error("atlas: note has no frontmatter block (first line must be `---`)");
  }
  const end = lines.indexOf(FENCE, 1);
  if (end === -1) {
    throw new Error("atlas: note has an unterminated frontmatter block (no closing `---`)");
  }
  return end;
}

/** Shallow scalar/inline-list parse — enough for every key SCHEMA.md defines, and no more. */
function parseScalar(text: string): unknown {
  const t = text.trim();
  if (t === "") return "";
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter((s) => s !== "");
  }
  return t.replace(/^["']|["']$/g, "");
}

export function parseNote(raw: string): ParsedNote {
  const end = frontmatterEnd(raw);
  const lines = raw.split("\n");
  const frontmatter: Record<string, unknown> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trimStart().startsWith("#") || line.startsWith(" ")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    frontmatter[line.slice(0, colon).trim()] = parseScalar(line.slice(colon + 1));
  }
  return { frontmatter, body: lines.slice(end + 1).join("\n"), raw };
}

/**
 * Rewrites ONLY the named keys. A key whose rendered line already reads exactly as we
 * would write it is left alone — that byte-identity is what makes an unchanged run produce
 * no diff, and therefore no commit. A missing key is INSERTED after `type:` when that
 * exists (OKF's required field stays first), else as the block's first line.
 */
export function setFrontmatterKeys(raw: string, updates: Record<string, string>): string {
  const end = frontmatterEnd(raw);
  const lines = raw.split("\n");
  let insertAt = 1;
  for (let i = 1; i < end; i++) {
    if (lines[i]!.startsWith("type:")) { insertAt = i + 1; break; }
  }

  const pending = new Map(Object.entries(updates));
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(":");
    if (colon <= 0 || line.startsWith(" ")) continue;
    const key = line.slice(0, colon).trim();
    const value = pending.get(key);
    if (value === undefined) continue;
    // Skip the write when the line's existing VALUE already matches — not just when the
    // rendered form happens to match. A line with non-canonical spacing (e.g.
    // `status:   exploration`) written with the same semantic value must be left exactly as
    // it was, not "normalised" to `status: exploration`: that's a byte diff for zero logical
    // change, and byte-preservation on a no-op is the property this whole function exists
    // for. The key still counts as handled either way (see `pending.delete` below) — a line
    // that was already correct must never be treated as missing and re-inserted at the top.
    if (line.slice(colon + 1).trim() !== value) lines[i] = `${key}: ${value}`;
    pending.delete(key);
  }

  const inserts = [...pending].map(([k, v]) => `${k}: ${v}`);
  if (inserts.length > 0) lines.splice(insertAt, 0, ...inserts);
  return lines.join("\n");
}
