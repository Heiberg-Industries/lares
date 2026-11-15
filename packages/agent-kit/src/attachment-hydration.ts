/**
 * What the model sees for an attachment eve does not inline.
 *
 * eve 1.0 stages every inbound file in the sandbox and shows the model a label for each one:
 * `Attached file /workspace/.eve/attachments/<hash>/notes.txt (text/plain)`. The file's bytes
 * follow the label only for a PNG, JPEG, GIF or WebP image up to 3 MiB and 8000 pixels per side,
 * and a PDF up to 20 MiB (`internal/attachments/sandbox-refs.js`, `inlinesSandboxRefAsBytes`).
 * Everything else is the label alone, naming a path no agent can open, because every file tool
 * is disabled fleet-wide. Measured on an earlier eve: the chief of staff answered a .txt, a .md,
 * a .docx and an .xlsx with "I only got a path".
 *
 * `patches/eve.patch` (the attachment-staging hunk, in `hydrateMessageContent`) hands every staged
 * file eve does not inline to `globalThis.__laresHydrateSandboxRef`, which
 * `installAttachmentHydration` points at `hydrateSandboxRef` below. The contract: the model
 * either gets the file's content, or one plain sentence naming the file and why it can't have
 * it, never a bare path. When the hook is missing, throws, or returns no text, the patch keeps
 * eve's own label.
 *
 * The hook covers files a person attached to a message. A file a TOOL returned
 * (`hydrateToolOutput`) keeps eve's label: the sentences below speak about "the user" and what
 * they sent, which would be wrong for a tool's output.
 *
 * A document is somebody else's words, whoever forwarded it. Its text reaches the model inside
 * the same quoted envelope as a mail body (`quoteUntrusted`), so a line in it that reads like an
 * instruction is unmistakably quoted text.
 *
 * Hydration runs on every model call over the whole history, so the extracted text is capped:
 * a long document costs its tokens once per call while it stays in the session.
 */
import { basename } from "node:path";

import { quoteUntrusted, untrustedLine } from "./untrusted-text.js";

/** eve's sandbox reference, as `decodeSandboxRef` returns it. The image and PDF facts are set
 *  only when eve could read them from the bytes at staging. */
export interface SandboxRef {
  mediaType: string;
  path: string;
  size: number;
  width?: number;
  height?: number;
  pages?: number;
}

/**
 * Reads the staged file's bytes. The patch passes eve's own reader bound to this reference: it
 * answers null when the file is gone from the sandbox or its size or content hash no longer
 * match what was staged, and it throws when the session has no sandbox to read from.
 */
export type ReadSandboxRef = () => Promise<Uint8Array | null>;

export interface TextPart {
  type: "text";
  text: string;
}

/** ≈ 20 pages of prose. Kept in history, so it is re-sent on every later model call. */
export const MAX_ATTACHMENT_TEXT_CHARS = 60_000;

/** The image types the Anthropic API accepts. Everything else (heic, tiff, bmp, svg) it refuses. */
export const MODEL_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

/** eve's own inline ceilings (`inlinesSandboxRefAsBytes`), restated for the messages below. */
const INLINE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const INLINE_IMAGE_MAX_SIDE_PX = 8000;
const INLINE_PDF_MAX_BYTES = 20 * 1024 * 1024;

export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/** Office formats `extractAttachmentText` reads — for door upload policies. */
export const OFFICE_MEDIA_TYPES = [DOCX, XLSX, PPTX] as const;

function bareType(mediaType: string): string {
  return (mediaType.split(";", 1)[0] ?? "").trim().toLowerCase();
}

/**
 * A media type fit to print in a sentence the model reads. The type of a document is whatever the
 * sender's app declared, so anything that is not a plain `type/subtype` token is not repeated.
 */
function printableType(type: string): string {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,99}$/.test(type) ? type : "unknown type";
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isTextType(type: string): boolean {
  return type.startsWith("text/") || type === "application/json" || type === "application/xml";
}

/** Decodes the few XML entities OOXML text runs contain. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

type Zip = { file(name: string): { async(kind: "string"): Promise<string> } | null; files: Record<string, unknown> };

async function openZip(bytes: Uint8Array): Promise<Zip> {
  const JSZip = (await import("jszip")).default;
  return (await JSZip.loadAsync(bytes)) as unknown as Zip;
}

/** Slide/sheet files in their natural order: slide2 before slide10. */
function numbered(zip: Zip, re: RegExp): string[] {
  return Object.keys(zip.files)
    .filter((n) => re.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0));
}

async function pptxText(bytes: Uint8Array): Promise<string> {
  const zip = await openZip(bytes);
  const out: string[] = [];
  for (const [i, name] of numbered(zip, /^ppt\/slides\/slide\d+\.xml$/).entries()) {
    const xml = (await zip.file(name)?.async("string")) ?? "";
    const paras = [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
      .map((p) => [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => unescapeXml(t[1] ?? "")).join(""))
      .filter((p) => p.trim() !== "");
    out.push(`Slide ${i + 1}:\n${paras.join("\n")}`);
  }
  return out.join("\n\n");
}

async function xlsxText(bytes: Uint8Array): Promise<string> {
  const zip = await openZip(bytes);
  const sharedXml = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
    [...(si[1] ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1] ?? "")).join(""),
  );
  const out: string[] = [];
  for (const [i, name] of numbered(zip, /^xl\/worksheets\/sheet\d+\.xml$/).entries()) {
    const xml = (await zip.file(name)?.async("string")) ?? "";
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1] ?? "";
        const inner = c[2] ?? "";
        const type = attrs.match(/\bt="([^"]+)"/)?.[1];
        let value = "";
        if (type === "inlineStr") value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1] ?? "")).join("");
        else {
          const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
          value = type === "s" ? (shared[Number(v)] ?? "") : unescapeXml(v);
        }
        cells.push(value);
      }
      if (cells.some((c) => c !== "")) rows.push(cells.join("\t"));
    }
    out.push(`Sheet ${i + 1}:\n${rows.join("\n")}`);
  }
  return out.join("\n\n");
}

async function docxText(bytes: Uint8Array): Promise<string> {
  const mammoth = (await import("mammoth")) as unknown as {
    extractRawText(opts: { buffer: Buffer }): Promise<{ value: string }>;
  };
  return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
}

/**
 * The readable text of a file, or null for a format we cannot read. Throws only on a file that
 * claims a supported format but is corrupt — the caller turns that into a plain sentence.
 */
export async function extractAttachmentText(bytes: Uint8Array, mediaType: string): Promise<string | null> {
  const type = bareType(mediaType);
  if (isTextType(type)) return new TextDecoder("utf-8").decode(bytes);
  if (type === DOCX) return docxText(bytes);
  if (type === XLSX) return xlsxText(bytes);
  if (type === PPTX) return pptxText(bytes);
  return null;
}

/**
 * The text part that replaces a non-inlined sandbox reference. Always returns a part: either the
 * file's text, quoted as somebody else's words, or one sentence naming the file and why the model
 * cannot have its content.
 */
export async function hydrateSandboxRef(ref: SandboxRef, read: ReadSandboxRef): Promise<TextPart> {
  const name = untrustedLine(basename(ref.path));
  const mediaType = bareType(ref.mediaType);
  const type = printableType(mediaType);
  const say = (text: string): TextPart => ({ type: "text", text });

  if (mediaType.startsWith("image/")) {
    if (!(MODEL_IMAGE_TYPES as readonly string[]).includes(mediaType)) {
      return say(
        `[Attached image ${name} (${type}) — received, but this image format cannot be viewed. ` +
          `Tell the user plainly and ask for a JPEG or PNG; on an iPhone, sending it as a photo instead of as a file does that.]`,
      );
    }
    if (ref.size > INLINE_IMAGE_MAX_BYTES) {
      return say(
        `[Attached image ${name} (${mb(ref.size)}) — received, but it is larger than the ${mb(INLINE_IMAGE_MAX_BYTES)} that can be viewed. ` +
          `Tell the user plainly and ask for a smaller copy; sending it as a photo instead of as a file compresses it.]`,
      );
    }
    if ((ref.width ?? 0) > INLINE_IMAGE_MAX_SIDE_PX || (ref.height ?? 0) > INLINE_IMAGE_MAX_SIDE_PX) {
      return say(
        `[Attached image ${name} (${type}) — received, but it is wider or taller than the ${INLINE_IMAGE_MAX_SIDE_PX.toLocaleString("en")} pixels that can be viewed. ` +
          `Tell the user plainly and ask for a smaller copy; sending it as a photo instead of as a file resizes it.]`,
      );
    }
    // eve inlines every other image itself, so none reaches this point; an image is never read as text.
    return say(`[Attached image ${name} (${type}) — received, but it cannot be viewed. Tell the user plainly and ask them to send it again.]`);
  }
  if (mediaType === "application/pdf" && ref.size > INLINE_PDF_MAX_BYTES) {
    return say(
      `[Attached PDF ${name} (${mb(ref.size)}) — received, but it is larger than the ${mb(INLINE_PDF_MAX_BYTES)} that can be read. ` +
        `Tell the user plainly and ask for a shorter file or the pages that matter.]`,
    );
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await read();
  } catch (err) {
    console.warn(`attachment-hydration: could not open ${name} (${type}) —`, err);
    return say(`[Attached file ${name} (${type}) — received, but it could not be opened just now. Tell the user plainly and ask them to send it again.]`);
  }
  if (bytes === null) {
    return say(`[Attached file ${name} (${type}) — it is no longer available to read. Ask the user to send it again.]`);
  }

  let text: string | null;
  try {
    text = await extractAttachmentText(bytes, mediaType);
  } catch (err) {
    console.warn(`attachment-hydration: could not read ${name} (${type}) —`, err);
    return say(`[Attached file ${name} (${type}) — received, but it could not be read (it may be damaged or password-protected). Tell the user plainly.]`);
  }
  if (text === null) {
    return say(
      `[Attached file ${name} (${type}) — received, but this format cannot be read. ` +
        `Tell the user plainly; they can paste the text or send it as PDF, Word, Excel, PowerPoint or plain text.]`,
    );
  }
  if (text.trim() === "") {
    return say(`[Attached file ${name} (${type}) — received and read, but it contains no text.]`);
  }
  const cut = text.length > MAX_ATTACHMENT_TEXT_CHARS;
  const body = cut ? text.slice(0, MAX_ATTACHMENT_TEXT_CHARS) : text;
  const tail = cut
    ? `\n\n[… only the first ${MAX_ATTACHMENT_TEXT_CHARS.toLocaleString("en")} of ${text.length.toLocaleString("en")} characters are shown. Say so if the answer may be in the rest.]`
    : "";
  // The document's own words go inside the envelope; everything outside it is ours.
  return say(`[Attached file ${name} (${type}) — its text follows, quoted.]\n${quoteUntrusted(body, { kind: "attached file" })}${tail}`);
}

declare global {
  // Read by the attachment-staging hunk in patches/eve.patch.
  // eslint-disable-next-line no-var
  var __laresHydrateSandboxRef: typeof hydrateSandboxRef | undefined;
}

/** Point eve's patched hydration at `hydrateSandboxRef`. Call once from an agent's startup hook. */
export function installAttachmentHydration(): void {
  globalThis.__laresHydrateSandboxRef = hydrateSandboxRef;
}
