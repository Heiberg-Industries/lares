// The origin model's vocabulary — docs/specs/2026-09-18-origin-model-design.md.
//
// THE ORDERING. The spec's own paragraph (:151-155) contradicts itself: it opens by saying
// `system < synced < agent < third_party` "is not the ordering", then gives
// `owner → agent → synced → system → third_party`. The second is the one every worked example
// and hard rule in that document depends on (a scheduled brief is more trusted than an inbound
// email), so it is the one pinned here and in tests/origin.test.ts.
//
// NO MODEL-FACING TOOL EVER TAKES AN ORIGIN. Everything in this module is for surrounding code.

export const ORIGIN_CLASSES = ["owner", "agent", "synced", "third_party", "system"] as const;
export type Origin = (typeof ORIGIN_CLASSES)[number];

export const ORIGIN_TRUST_ORDER = ["owner", "agent", "synced", "system", "third_party"] as const satisfies readonly Origin[];

export function isOrigin(value: unknown): value is Origin {
  return typeof value === "string" && (ORIGIN_CLASSES as readonly string[]).includes(value);
}

export function narrowest(origins: readonly Origin[]): Origin {
  if (origins.length === 0) {
    throw new Error("origin: narrowest() was given no origins — a write with no inputs has no class to compute");
  }
  let worst = origins[0]!;
  for (const o of origins) {
    if (ORIGIN_TRUST_ORDER.indexOf(o) > ORIGIN_TRUST_ORDER.indexOf(worst)) worst = o;
  }
  return worst;
}

export const ORIGIN_FRONTMATTER_KEY = "lares_origin" as const;

export function originFrontmatterLine(origin: Origin): string {
  return `${ORIGIN_FRONTMATTER_KEY}: ${origin}`;
}

/** The origin a file should carry after content from `incoming` has been written into it: the
 *  existing stamp when there is one, otherwise `incoming`. It NEVER returns a class more trusted
 *  than what is already there — a pull whose body came from a sync may not turn a note the owner
 *  wrote into a synced one, and may not turn a synced note into an owner one either. An existing
 *  stamp always wins outright: "keep or narrow, never widen" means the result's trust can never
 *  exceed the existing stamp's, and the only value that never exceeds it is the stamp itself. */
export function originAfterWrite(existing: Origin | undefined, incoming: Origin): Origin {
  return existing === undefined ? incoming : existing;
}

/** Returns `raw` with `lares_origin` set to `origin`, byte-preserving everywhere else:
 *   - a block with the key    → that ONE line is replaced, in place
 *   - a block without the key → the line is inserted after `type:` if present, else as the
 *                               first line of the block
 *   - NO block at all         → a new `---` block containing only this key is created at the
 *                               top, followed by a blank line and the original text. This is
 *                               the case services/atlas/lib/frontmatter.ts's setFrontmatterKeys
 *                               throws on, and the case that silently loses stamps today.
 *  CRLF in, CRLF out: the file's own line ending is detected from the first break and used for
 *  anything inserted, so a Windows-saved note is not rewritten wholesale. */
export function upsertOriginFrontmatter(raw: string, origin: Origin): string {
  const breakIdx = raw.indexOf("\n");
  const eol = breakIdx > 0 && raw[breakIdx - 1] === "\r" ? "\r\n" : "\n";
  const text = raw.replace(/\r\n/g, "\n");

  // Block detection repeats readOriginFrontmatter's rule exactly (below) — starts with `---\n`,
  // a later line starting with `---` closes it — so a file the reader treats as unblocked is
  // treated as unblocked here too, and the two can never disagree.
  const lines = text.split("\n");
  let closeIdx = -1;
  if (lines[0] === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.startsWith("---")) {
        closeIdx = i;
        break;
      }
    }
  }

  const newLine = originFrontmatterLine(origin);
  let result: string;
  if (closeIdx === -1) {
    // No block at all (or an unterminated one) — wrap the untouched original text in a new one.
    result = `---\n${newLine}\n---\n\n${text}`;
  } else {
    let keyIdx = -1;
    let typeIdx = -1;
    for (let i = 1; i < closeIdx; i++) {
      const line = lines[i]!;
      if (line.startsWith(`${ORIGIN_FRONTMATTER_KEY}:`)) keyIdx = i;
      else if (line.startsWith("type:")) typeIdx = i;
    }
    if (keyIdx !== -1) {
      lines[keyIdx] = newLine;
    } else {
      lines.splice(typeIdx !== -1 ? typeIdx + 1 : 1, 0, newLine);
    }
    result = lines.join("\n");
  }

  return eol === "\r\n" ? result.replace(/\n/g, "\r\n") : result;
}

export function readOriginFrontmatter(raw: string): Origin | undefined {
  // CRLF-normalised first, for the same reason notes-store.ts's noteScope is: a Windows-saved
  // note that silently loses its stamp is worse than one that has none.
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return undefined;
  const m = text.slice(4, end).match(new RegExp(`^${ORIGIN_FRONTMATTER_KEY}:\\s*(.+)$`, "m"));
  const value = m?.[1]?.trim();
  return isOrigin(value) ? value : undefined;
}
