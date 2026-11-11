/**
 * Conformance: a Telegram file reaches the model under the type Telegram DECLARED in the
 * message, and an image or a PDF is checked again from its bytes.
 *
 * The history. Telegram's file server answers every `/file/bot…` download with
 * `Content-Type: application/octet-stream`. eve 0.32 preferred that header over the type it had
 * already parsed from the message (`photo` → image/jpeg, `document.mime_type`), so every
 * attachment was refused with `photo.jpg has media type "application/octet-stream" which is not
 * allowed by this route`. Lares carried a framework patch for it.
 *
 * eve 1.0.0-rc.9 does this itself, so the patch is gone and this file pins what replaced it:
 *
 *   - `createTelegramFetchFile` (`dist/src/public/channels/telegram/attachments.js`) uses
 *     `declared ?? header ?? "application/octet-stream"`. The declared type wins over ANY header,
 *     a specific one included — the opposite of the old patch, on purpose: the header is the file
 *     server's, the declared type is the message's.
 *   - `verifyMediaType` (`dist/src/internal/attachments/media-metadata.js`) then re-reads the
 *     bytes when the file is staged: an image or a PDF carries the format its bytes prove, and a
 *     declared image or PDF the bytes do not confirm becomes `application/octet-stream`.
 *
 * Both functions are internal (eve 1.0 no longer exports the Telegram file helpers), so they are
 * loaded from the INSTALLED eve by file path. An eve bump that changes either fails here, not in
 * a chat.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";

const EVE_DIST = pathToFileURL(fileURLToPath(new URL("../node_modules/eve/dist/src", import.meta.url))).href;

interface FetchedFile {
  bytes: Uint8Array;
  filename?: string;
  mediaType?: string;
}
interface TelegramAttachments {
  createTelegramFetchFile(input: unknown): (url: string) => Promise<FetchedFile | null>;
  createTelegramFileUrl(input: { fileId: string; filename?: string; mediaType?: string }): URL;
}
interface MediaMetadata {
  verifyMediaType(bytes: Uint8Array, declared: string): string;
}

const attachments = async () =>
  (await import(`${EVE_DIST}/public/channels/telegram/attachments.js`)) as TelegramAttachments;
const media = async () => (await import(`${EVE_DIST}/internal/attachments/media-metadata.js`)) as MediaMetadata;

/** The upload policy the Telegram door uses, without the office types (not needed here). */
const POLICY = { allowedMediaTypes: ["image/*", "application/pdf", "text/*"], maxBytes: 10 * 1024 * 1024 };

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = new TextEncoder().encode("%PDF-1.7\n");
const TEXT = new TextEncoder().encode("just some words");

/** A stand-in for api.telegram.org: getFile answers a file_path, the download answers `header`. */
function telegramStub(header: string | null, bytes: Uint8Array = JPEG): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/file_1.jpg" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(Buffer.from(bytes), header === null ? {} : { headers: { "content-type": header } });
  }) as typeof fetch;
}

async function fetchFileWith(header: string | null, bytes?: Uint8Array) {
  const { createTelegramFetchFile } = await attachments();
  return createTelegramFetchFile({
    api: { fetch: telegramStub(header, bytes) },
    credentials: { botToken: "123:test" },
    policy: POLICY,
  });
}

async function fileUrl(input: { fileId: string; filename?: string; mediaType?: string }): Promise<string> {
  return (await attachments()).createTelegramFileUrl(input).href;
}

describe("a Telegram download carries the type the message declared", () => {
  it("uses the declared type when the file server says application/octet-stream", async () => {
    const url = await fileUrl({ fileId: "F", filename: "photo.jpg", mediaType: "image/jpeg" });
    const out = await (await fetchFileWith("application/octet-stream"))(url);
    expect(out?.mediaType).toBe("image/jpeg");
    expect(out?.filename).toBe("photo.jpg");
  });

  it("uses the declared type for a PDF document too", async () => {
    const url = await fileUrl({ fileId: "F", filename: "report.pdf", mediaType: "application/pdf" });
    const out = await (await fetchFileWith("application/octet-stream", PDF))(url);
    expect(out?.mediaType).toBe("application/pdf");
  });

  it("the declared type wins over a specific header as well — the header is never preferred", async () => {
    const url = await fileUrl({ fileId: "F", filename: "image.jpg", mediaType: "image/jpeg" });
    const out = await (await fetchFileWith("image/png"))(url);
    expect(out?.mediaType).toBe("image/jpeg");
  });

  it("falls back to the header only when the message declared nothing", async () => {
    const url = await fileUrl({ fileId: "F", filename: "notes.txt" });
    const out = await (await fetchFileWith("text/plain", TEXT))(url);
    expect(out?.mediaType).toBe("text/plain");
  });

  it("still refuses a file with no declared type and a generic header", async () => {
    const url = await fileUrl({ fileId: "F", filename: "mystery.bin" });
    await expect((await fetchFileWith("application/octet-stream"))(url)).rejects.toThrow(/not allowed by this route/);
  });

  it("refuses a declared type the policy does not allow, whatever the header claims", async () => {
    const url = await fileUrl({ fileId: "F", filename: "voice.ogg", mediaType: "audio/ogg" });
    await expect((await fetchFileWith("image/jpeg"))(url)).rejects.toThrow(/not allowed by this route/);
  });
});

describe("an image or a PDF is checked again from its bytes", () => {
  it("keeps a declared type the bytes confirm", async () => {
    const { verifyMediaType } = await media();
    expect(verifyMediaType(JPEG, "image/jpeg")).toBe("image/jpeg");
    expect(verifyMediaType(PDF, "application/pdf")).toBe("application/pdf");
  });

  it("corrects a declared image type to the format the bytes prove", async () => {
    const { verifyMediaType } = await media();
    expect(verifyMediaType(PNG, "image/jpeg")).toBe("image/png");
  });

  it("names the format of an untyped file from its bytes", async () => {
    const { verifyMediaType } = await media();
    expect(verifyMediaType(PNG, "application/octet-stream")).toBe("image/png");
    expect(verifyMediaType(PDF, "application/octet-stream")).toBe("application/pdf");
  });

  it("a declared image or PDF the bytes do not confirm becomes application/octet-stream", async () => {
    const { verifyMediaType } = await media();
    expect(verifyMediaType(TEXT, "image/jpeg")).toBe("application/octet-stream");
    expect(verifyMediaType(TEXT, "application/pdf")).toBe("application/octet-stream");
  });

  it("leaves every other declared type alone — text and office files are not sniffed", async () => {
    const { verifyMediaType } = await media();
    expect(verifyMediaType(TEXT, "text/plain")).toBe("text/plain");
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(verifyMediaType(TEXT, docx)).toBe(docx);
  });
});
