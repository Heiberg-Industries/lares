/**
 * Conformance (ORB-286): a Telegram file must reach the model under the type Telegram DECLARED
 * in the message — not the generic header Telegram's file server sends with every download.
 *
 * Verbatim, Telegram, 2026-09-14: a photo Bendik sent Saga failed with `Telegram file rejected —
 * photo.jpg has media type "application/octet-stream" which is not allowed by this route`. The
 * file server answers every `/file/bot…` download with `Content-Type: application/octet-stream`,
 * and eve 0.32's `createTelegramFetchFile` preferred that header over the type it had already
 * parsed (`photo` → image/jpeg, `document.mime_type`). Every Telegram attachment on Saga and
 * Marcel failed until `patches/eve.patch` added `laresTelegramMediaType`.
 *
 * This runs the INSTALLED (patched) eve, so an eve bump that drops the hunk fails here, not in a
 * chat. Both directions: a declared type wins over the generic header, a real header is kept,
 * and a file with no declared type and a generic header is still refused by the policy.
 */
import { describe, it, expect } from "vitest";
import { createTelegramFetchFile, createTelegramFileUrl } from "eve/channels/telegram";

/** The upload policy both Telegram doors use (eve-saga telegram.ts, eve-marcel telegram.ts). */
const POLICY = { allowedMediaTypes: ["image/*", "application/pdf", "text/*"], maxBytes: 10 * 1024 * 1024 };

/** A stand-in for api.telegram.org: getFile answers a file_path, the download answers `header`. */
function telegramStub(header: string | null): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/file_1.jpg" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), header === null ? {} : { headers: { "content-type": header } });
  }) as typeof fetch;
}

function fetchFileWith(header: string | null) {
  return createTelegramFetchFile({
    api: { fetch: telegramStub(header) },
    credentials: { botToken: "123:test" },
    policy: POLICY,
  } as never) as (url: string) => Promise<{ mediaType?: string } | null>;
}

describe("Telegram file media type (ORB-286 eve patch)", () => {
  it("uses the declared type when the file server says application/octet-stream", async () => {
    const url = createTelegramFileUrl({ fileId: "F", filename: "photo.jpg", mediaType: "image/jpeg" }).href;
    const out = await fetchFileWith("application/octet-stream")(url);
    expect(out?.mediaType).toBe("image/jpeg");
  });

  it("uses the declared type for a PDF document too", async () => {
    const url = createTelegramFileUrl({ fileId: "F", filename: "report.pdf", mediaType: "application/pdf" }).href;
    const out = await fetchFileWith("application/octet-stream")(url);
    expect(out?.mediaType).toBe("application/pdf");
  });

  it("keeps a specific header when the file server sends one", async () => {
    const url = createTelegramFileUrl({ fileId: "F", filename: "image.png", mediaType: "image/jpeg" }).href;
    const out = await fetchFileWith("image/png")(url);
    expect(out?.mediaType).toBe("image/png");
  });

  it("still refuses a file with no declared type and a generic header", async () => {
    const url = createTelegramFileUrl({ fileId: "F", filename: "mystery.bin" }).href;
    await expect(fetchFileWith("application/octet-stream")(url)).rejects.toThrow(/not allowed by this route/);
  });
});
