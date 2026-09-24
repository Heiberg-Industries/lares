import { extname } from "node:path";
import { getDocumentProxy, extractText } from "unpdf";
import { taintTurn, type TurnKey } from "@lares/agent-kit/origin-taint";
// mammoth has no bundled types; use a dynamic import with explicit typing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MammothModule = { extractRawText(opts: { buffer: Buffer }): Promise<{ value: string }> };

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export type AttachmentKind = "pdf" | "doc" | "image" | "other";

export interface AttachmentResult {
  text: string;
  kind: AttachmentKind;
  /** Vault-relative path of the attachment file (from the `attachment:` frontmatter). */
  rel: string;
}

export interface ExtractAttachmentOpts {
  /** Raw body of the breadcrumb note (may include YAML frontmatter). */
  breadcrumbBody: string;
  /** Reads a vault-relative path and returns its bytes. */
  readFile(rel: string): Promise<Buffer>;
  /**
   * The turn this extraction runs in, when there is one. Optional because the digest pipeline
   * also runs from a schedule (`agent/schedules/digest.ts`), which has no turn at all — when
   * absent, extraction behaves exactly as before W3A-s5. When present, any non-null result
   * taints the turn (see `extractAttachment`'s own comment).
   */
  turn?: TurnKey;
}

/**
 * Parse the YAML frontmatter block at the top of a note body.
 * Returns a flat key→value map of string scalars only.
 * This is intentionally minimal — we only need the `attachment` and `url` fields.
 */
export function parseFrontmatter(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!body.startsWith("---")) return result;
  const end = body.indexOf("\n---", 3);
  if (end === -1) return result;
  const block = body.slice(3, end).trim();
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key && val) result[key] = val;
  }
  return result;
}

/**
 * Return the body text after stripping the YAML frontmatter block (if any).
 * If no frontmatter is found the original string is returned unchanged.
 */
export function stripFrontmatter(body: string): string {
  if (!body.startsWith("---")) return body;
  const end = body.indexOf("\n---", 3);
  if (end === -1) return body;
  // Skip the closing `---` line and the newline that follows it.
  return body.slice(end + 4).replace(/^\n/, "");
}

/**
 * Extract text content from an attachment described by a breadcrumb note body.
 *
 * Returns null when:
 * - the body has no `attachment` frontmatter field (not a breadcrumb)
 * - the file extension is not one we can handle (.xlsx, .zip, etc.)
 *
 * Returns { text: "", kind: "image" } for recognised image types (PNG/JPG/GIF/WEBP).
 *
 * W3A-s5 — every non-null return taints `opts.turn` (when there is one) at `third_party`: the
 * attachment was sent by whoever sent the breadcrumb, not written by Bendik
 * (docs/specs/2026-09-18-origin-model-design.md, "The in-turn taint rule"). The image branch
 * taints too even though its own text is empty — the model still learns an image arrived and
 * from where.
 */
export async function extractAttachment(opts: ExtractAttachmentOpts): Promise<AttachmentResult | null> {
  const fm = parseFrontmatter(opts.breadcrumbBody);
  const rel = fm["attachment"];
  if (!rel) return null;

  const ext = extname(rel).toLowerCase();

  if (IMAGE_EXTS.has(ext)) {
    // Call readFile to validate the path is accessible; bytes not needed for text extraction.
    await opts.readFile(rel);
    return taint({ text: "", kind: "image", rel }, opts.turn);
  }

  if (ext === ".pdf") {
    const bytes = await opts.readFile(rel);
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(doc, { mergePages: true });
    return taint({ text: text as string, kind: "pdf", rel }, opts.turn);
  }

  if (ext === ".docx") {
    const bytes = await opts.readFile(rel);
    // Dynamic import to avoid hard dependency on types
    const mammoth = (await import("mammoth")) as MammothModule;
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return taint({ text: value, kind: "doc", rel }, opts.turn);
  }

  return null;
}

/** Taints `turn` (when there is one) and returns `result` unchanged — the one seam every
 *  non-null return above goes through, so none of them can forget it. */
function taint(result: AttachmentResult, turn: TurnKey | undefined): AttachmentResult {
  if (turn) taintTurn(turn, "third_party");
  return result;
}

/**
 * Extract text from raw file bytes.
 *
 * Returns `{ text, kind, truncated }` where text is capped at `maxChars`
 * (default 30000) and `truncated` is set when the cap was applied.
 * Images return `{ text: "", kind: "image", truncated: false }`.
 * Unrecognised extensions return `{ text: "", kind: "other", truncated: false }`.
 */
export async function extractBytes(
  bytes: Buffer,
  filename: string,
  opts?: { maxChars?: number },
): Promise<{ text: string; kind: AttachmentKind; truncated: boolean }> {
  const ext = extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return { text: "", kind: "image", truncated: false };
  let text = "";
  let kind: AttachmentKind = "other";
  if (ext === ".pdf") {
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    const r = await extractText(doc, { mergePages: true });
    text = r.text as string;
    kind = "pdf";
  } else if (ext === ".docx") {
    const mammoth = (await import("mammoth")) as MammothModule;
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    text = value;
    kind = "doc";
  } else {
    return { text: "", kind: "other", truncated: false };
  }
  const max = opts?.maxChars ?? 30000;
  const truncated = text.length > max;
  return { text: truncated ? text.slice(0, max) : text, kind, truncated };
}
