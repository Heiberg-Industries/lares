/**
 * What the model sees for an attachment eve does not inline (ORB-286).
 *
 * eve 0.32 stages every inbound file in the sandbox, then shows the model only two kinds inline:
 * model-viewable images ≤ 3 MB and PDFs ≤ 20 MB (`harness/attachment-staging.js`,
 * `shouldInlineSandboxRefAsBytes`). Everything else became one line — `Attached file
 * /workspace/attachments/<hash>/notes.txt (text/plain)` — naming a path no agent can open, because
 * every file tool is disabled fleet-wide (ORB-52). Measured 2026-09-14: Saga answered a .txt, a .md, a
 * .docx and an .xlsx with "I only got a path". And a HEIC photo was inlined as `image/heic`, which the
 * Anthropic API refuses, ending the whole session.
 *
 * `patches/eve.patch` (the attachment-staging hunk) inlines only jpeg/png/gif/webp images and hands
 * every other staged file to `globalThis.__laresHydrateSandboxRef`, which `installAttachmentHydration`
 * points at `hydrateSandboxRef` below. The contract (ORB-286): the model either gets the file's
 * content, or one plain sentence naming the file and why it can't have it — never a bare path.
 *
 * Hydration runs on every model call over the whole history, so the extracted text is capped:
 * a long document costs its tokens once per call while it stays in the session.
 */
import { basename } from "node:path";

/** eve's sandbox reference, as `decodeSandboxRef` returns it. */
export interface SandboxRef {
  mediaType: string;
  path: string;
  size: number;
}

export interface TextPart {
  type: "text";
  text: string;
}

/** ≈ 20 pages of prose. Kept in history, so it is re-sent on every later model call. */
export const MAX_ATTACHMENT_TEXT_CHARS = 60_000;

/** The image types the Anthropic API accepts. Everything else (heic, tiff, bmp, svg) it refuses. */
export const MODEL_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

/** eve's own inline ceilings (`shouldInlineSandboxRefAsBytes`), restated for the messages below. */
const INLINE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const INLINE_PDF_MAX_BYTES = 20 * 1024 * 1024;

export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/** Office formats `extractAttachmentText` reads — for door upload policies. */
export const OFFICE_MEDIA_TYPES = [DOCX, XLSX, PPTX] as const;

function bareType(mediaType: string): string {
  return (mediaType.split(";", 1)[0] ?? "").trim().toLowerCase();
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
 * file's text, or one sentence naming the file and why the model cannot have its content.
 */
export async function hydrateSandboxRef(
  ref: SandboxRef,
  read: () => Promise<Uint8Array | null>,
): Promise<TextPart> {
  const name = basename(ref.path);
  const type = bareType(ref.mediaType);
  const say = (text: string): TextPart => ({ type: "text", text });

  if (type.startsWith("image/")) {
    if (!(MODEL_IMAGE_TYPES as readonly string[]).includes(type)) {
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
  }
  if (type === "application/pdf" && ref.size > INLINE_PDF_MAX_BYTES) {
    return say(
      `[Attached PDF ${name} (${mb(ref.size)}) — received, but it is larger than the ${mb(INLINE_PDF_MAX_BYTES)} that can be read. ` +
        `Tell the user plainly and ask for a shorter file or the pages that matter.]`,
    );
  }

  let text: string | null;
  try {
    const bytes = await read();
    if (bytes === null) {
      return say(`[Attached file ${name} (${type}) — it is no longer available to read (it arrived before a restart). Ask the user to send it again.]`);
    }
    text = await extractAttachmentText(bytes, type);
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
  return say(`[Attached file ${name} (${type}) — its text follows.]\n\n${body}${tail}`);
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
