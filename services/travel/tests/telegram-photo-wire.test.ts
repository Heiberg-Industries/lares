// tests/telegram-photo-wire.test.ts — Fix Wave B review fix (safety bug, bundled as Minor #1).
//
// tests/telegram-photo.test.ts verifies sendTelegramPhoto's STRUCTURAL shape against a mocked
// fetch (the mock receives the FormData object directly, never serialized bytes). This file
// goes one level deeper: a REAL local HTTP server, and a REAL fetch implementation actually
// serializing the request over the wire — the same class of "wire-level probe" the review used
// to find the underlying bug (lib/telegram-photo.ts's `fetch` param defaulted to plain global
// `fetch`, and a probe showed that with Node's global fetch, the exact same call silently
// serializes undici's `FormData` as the literal string "[object FormData]" with
// `content-type: text/plain` — no multipart, no thrown error, silent corruption Telegram would
// simply reject or mis-parse with no signal pointing back here).
//
// The fix made `fetch` a REQUIRED parameter (no default) so a future call site that forgets to
// pass `telegramFetch` fails at compile time. This file independently confirms WHY that matters
// by reproducing both halves against a real server: undici's own `fetch` (the correct pairing —
// `lib/telegram-photo.ts` imports `FormData` from the same `undici` package) produces a genuine
// multipart request; Node's global `fetch` does not, for the exact same call.
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { fetch as undiciFetch } from "undici";
import { sendTelegramPhoto } from "../lib/telegram-photo.js";

interface CapturedRequest {
  readonly contentType: string | undefined;
  readonly bodyText: string;
}

function startCapturingServer(): Promise<{ server: Server; url: string; captured: () => Promise<CapturedRequest> }> {
  return new Promise((resolve) => {
    let resolveCaptured: (r: CapturedRequest) => void;
    const capturedPromise = new Promise<CapturedRequest>((res) => {
      resolveCaptured = res;
    });

    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        resolveCaptured({
          contentType: req.headers["content-type"],
          bodyText: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, captured: () => capturedPromise });
    });
  });
}

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("sendTelegramPhoto — real wire-level multipart probe", () => {
  it("with undici's own fetch (the pairing lib/telegram-photo.ts actually uses), the server receives a REAL multipart/form-data request with a boundary, carrying the chat_id and photo bytes", async () => {
    const started = await startCapturingServer();
    server = started.server;

    await sendTelegramPhoto({
      chatId: "-100123",
      photo: new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]),
      filename: "photo.jpg",
      botToken: "wire-test-token",
      apiBaseUrl: started.url,
      fetch: undiciFetch as unknown as typeof fetch,
    });

    const req = await started.captured();
    expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/);
    // The boundary string that appears in the header must also delimit the body.
    const boundary = req.contentType!.split("boundary=")[1]!;
    expect(req.bodyText).toContain(boundary);
    expect(req.bodyText).toContain('name="chat_id"');
    expect(req.bodyText).toContain("-100123");
    expect(req.bodyText).toContain('name="photo"');
    expect(req.bodyText).toContain('filename="photo.jpg"');
    // Never the corrupted single-string serialization the review's own probe found.
    expect(req.bodyText).not.toContain("[object FormData]");
  });

  it("with Node's global fetch (a DIFFERENT undici realm than the FormData this file constructs), the same call silently corrupts — this is exactly why `fetch` is now a required parameter, not a default", async () => {
    const started = await startCapturingServer();
    server = started.server;

    await sendTelegramPhoto({
      chatId: "-100123",
      photo: new Uint8Array([1, 2, 3]),
      botToken: "wire-test-token",
      apiBaseUrl: started.url,
      fetch: globalThis.fetch, // the exact mistake the required-fetch change now prevents at compile time
    });

    const req = await started.captured();
    // Confirmed corruption, matching the review's own finding: no multipart, no thrown error.
    expect(req.contentType).not.toMatch(/^multipart\/form-data/);
    expect(req.bodyText).toContain("[object FormData]");
  });
});
