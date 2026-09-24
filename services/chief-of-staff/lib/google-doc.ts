/**
 * Read a Google Docs / Sheets / Slides / Drive link Bendik sends (ORB-286 batch 6).
 *
 * Measured 2026-09-14: a private Doc link went to the readability worker, which got Google's
 * sign-in shell and nothing else. Saga answered honestly ("needs a sign-in") but a user expects
 * their own document to open. So Google links go through the Drive API with Bendik's own enrolled
 * accounts, read-only (`drive.readonly`, his decision 2026-09-14).
 *
 * Export formats — documented Drive v3 behaviour, not measured here: Docs → text/plain,
 * Sheets → text/csv (the FIRST sheet only; the text says so), Slides → text/plain. A PDF or text
 * file stored in Drive is downloaded; anything else gets a plain sentence. The live check for this
 * path is a deploy step (it needs the re-consented token): tests/live/google-doc.live.mts.
 */
import type { DriveApi } from "./google-drive.js";

const MAX_TEXT_CHARS = 200_000;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class GoogleDocUnavailableError extends Error {
  constructor(url: string, reason: string) {
    super(`Google document not readable: ${reason}. Link: ${url}`);
    this.name = "GoogleDocUnavailableError";
  }
}

export type GoogleDocKind = "document" | "spreadsheets" | "presentation" | "file";

/** The file id and kind of a Google Docs/Sheets/Slides/Drive link, or null. */
export function googleDocFromUrl(url: string): { id: string; kind: GoogleDocKind } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host === "docs.google.com") {
    const m = u.pathname.match(/^\/(document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/);
    return m ? { id: m[2]!, kind: m[1] as GoogleDocKind } : null;
  }
  if (host === "drive.google.com") {
    const m = u.pathname.match(/^\/file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/);
    const id = m?.[1] ?? u.searchParams.get("id") ?? "";
    return /^[A-Za-z0-9_-]{10,}$/.test(id) ? { id, kind: "file" } : null;
  }
  return null;
}

const EXPORT_AS: Record<string, { mimeType: string; note?: string }> = {
  "application/vnd.google-apps.document": { mimeType: "text/plain" },
  "application/vnd.google-apps.spreadsheet": { mimeType: "text/csv", note: "[Spreadsheet: only the first sheet is included, as CSV.]" },
  "application/vnd.google-apps.presentation": { mimeType: "text/plain" },
};

function statusOf(e: unknown): number {
  const x = e as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const n = Number(x.response?.status ?? x.status ?? x.code);
  return Number.isFinite(n) ? n : 0;
}

/** Google's 403 for a token without the needed scope, as opposed to "no access to this file". */
function isScopeError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? "").toLowerCase();
  return statusOf(e) === 403 && (msg.includes("scope") || msg.includes("insufficient"));
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: true });
  return String(text);
}

export interface GoogleDocDeps {
  /** Every enrolled account's Drive client, primary first (`driveApisFor` in lib/google-drive.ts). */
  apis: () => Promise<Array<{ account: string; api: DriveApi }>>;
}

/** The document's name and text, read through the first enrolled account that can see it. */
export async function readGoogleDoc(url: string, deps: GoogleDocDeps): Promise<{ title: string; text: string }> {
  const ref = googleDocFromUrl(url);
  if (!ref) throw new GoogleDocUnavailableError(url, "not a Google Docs/Sheets/Slides/Drive link");

  const apis = await deps.apis();
  let scopeMissing = false;
  for (const { api } of apis) {
    let meta: { name?: string | null; mimeType?: string | null; size?: string | null };
    try {
      meta = (await api.files.get({ fileId: ref.id, fields: "name,mimeType,size", supportsAllDrives: true })).data;
    } catch (e) {
      if (isScopeError(e)) {
        scopeMissing = true;
        continue;
      }
      if (statusOf(e) === 404 || statusOf(e) === 403) continue; // this account can't see it; try the next
      throw e;
    }
    const mime = meta.mimeType ?? "";
    const title = meta.name ?? "Google document";
    let text: string;
    const exp = EXPORT_AS[mime];
    if (exp) {
      const r = await api.files.export({ fileId: ref.id, mimeType: exp.mimeType }, { responseType: "text" });
      text = `${exp.note ? `${exp.note}\n\n` : ""}${String(r.data ?? "")}`;
    } else if (mime === "application/pdf" || mime.startsWith("text/")) {
      if (Number(meta.size ?? 0) > MAX_DOWNLOAD_BYTES) {
        throw new GoogleDocUnavailableError(url, `the file is larger than ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB`);
      }
      const r = await api.files.get({ fileId: ref.id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
      const bytes = new Uint8Array(r.data as ArrayBuffer);
      text = mime === "application/pdf" ? await pdfText(bytes) : new TextDecoder().decode(bytes);
    } else {
      throw new GoogleDocUnavailableError(url, `"${title}" is a ${mime || "unknown"} file, a format that can't be read`);
    }
    return { title, text: text.trim().slice(0, MAX_TEXT_CHARS) };
  }

  if (scopeMissing) {
    throw new GoogleDocUnavailableError(
      url,
      "Saga is not yet allowed to read Google Drive — Bendik re-connects his Google account once in the Lares console to grant read-only Drive access",
    );
  }
  const accounts = apis.map((a) => a.account).join(", ") || "none";
  throw new GoogleDocUnavailableError(url, `it was not found in, or is not shared with, the connected Google accounts (${accounts})`);
}
