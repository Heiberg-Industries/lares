// MOVED into @lares/agent-kit with the client itself (ORB-160) — eve-saga and eve-marcel
// carried identical copies of this test alongside identical copies of the code.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

import {
  readUrl,
  ReadabilityNoContentError,
  ReadabilityTargetError,
  ReadabilityUnavailableError,
} from "../src/readability-client.js";

const LONG_ARTICLE = "A".repeat(400); // > MIN_ARTICLE_CHARS (300)
const SHORT_STUB = "too short";

let server: Server | undefined;
let tokenDir: string;

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
  });
}

beforeEach(() => {
  tokenDir = mkdtempSync(join(tmpdir(), "readability-token-"));
  writeFileSync(join(tokenDir, "readability-token"), "test-token\n");
  process.env["READABILITY_TOKEN_FILE"] = join(tokenDir, "readability-token");
});

afterEach(async () => {
  delete process.env["READABILITY_URL"];
  delete process.env["READABILITY_TOKEN_FILE"];
  rmSync(tokenDir, { recursive: true, force: true });
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("readUrl", () => {
  it("POSTs {baseUrl}/extract with the x-readability-token header and the {url} body", async () => {
    let receivedMethod: string | undefined;
    let receivedPath: string | undefined;
    let receivedToken: string | undefined;
    let receivedBody = "";
    const port = await listen((req, res) => {
      receivedMethod = req.method;
      receivedPath = req.url;
      receivedToken = req.headers["x-readability-token"] as string | undefined;
      req.on("data", (chunk) => (receivedBody += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ title: "A real article", text: LONG_ARTICLE }));
      });
    });
    process.env["READABILITY_URL"] = `http://127.0.0.1:${port}`;

    const article = await readUrl("https://example.com/post");

    expect(receivedMethod).toBe("POST");
    expect(receivedPath).toBe("/extract");
    expect(receivedToken).toBe("test-token");
    expect(JSON.parse(receivedBody)).toEqual({ url: "https://example.com/post" });
    expect(article).toEqual({ title: "A real article", text: LONG_ARTICLE });
  });

  it("defaults the title to 'Untitled' when the worker omits it", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: LONG_ARTICLE }));
    });
    process.env["READABILITY_URL"] = `http://127.0.0.1:${port}`;

    const article = await readUrl("https://example.com/post");
    expect(article.title).toBe("Untitled");
  });

  it("throws ReadabilityNoContentError when the extracted text is too short to be an article", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ title: "Paywall", text: SHORT_STUB }));
    });
    process.env["READABILITY_URL"] = `http://127.0.0.1:${port}`;

    await expect(readUrl("https://example.com/paywalled")).rejects.toThrow(ReadabilityNoContentError);
  });

  it("throws ReadabilityNoContentError when the worker returns no text field at all", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });
    process.env["READABILITY_URL"] = `http://127.0.0.1:${port}`;

    await expect(readUrl("https://example.com/blank")).rejects.toThrow(ReadabilityNoContentError);
  });

  it("throws ReadabilityUnavailableError on a non-2xx response", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    process.env["READABILITY_URL"] = `http://127.0.0.1:${port}`;

    await expect(readUrl("https://example.com/post")).rejects.toThrow(ReadabilityUnavailableError);
  });

  it("throws ReadabilityTargetError when the worker is up but couldn't read that link (ORB-289)", async () => {
    // Verbatim shape, the worker, 2026-09-14: 502 {"error":"fetch failed: TypeError: fetch failed"}.
    const port = await listen((_req, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "fetch 403" }));
    });
    process.env["READABILITY_URL"] = `http://127.0.0.1:${port}`;

    const err = await readUrl("https://example.com/blocked").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadabilityTargetError);
    expect((err as Error).message).toMatch(/reader is working, but could not read https:\/\/example\.com\/blocked: fetch 403/);
  });

  it("still says unavailable for a 502 that is not the worker's own JSON (a proxy in front of a dead worker)", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html>Bad Gateway</html>");
    });
    process.env["READABILITY_URL"] = `http://127.0.0.1:${port}`;

    await expect(readUrl("https://example.com/post")).rejects.toThrow(ReadabilityUnavailableError);
  });

  it("returns the image when the link is a picture", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ title: "Example.jpg", text: "", image: { mediaType: "image/jpeg", base64: "/9j/4AAQ" } }));
    });
    process.env["READABILITY_URL"] = `http://127.0.0.1:${port}`;

    expect(await readUrl("https://example.com/Example.jpg")).toEqual({
      title: "Example.jpg",
      text: "",
      image: { mediaType: "image/jpeg", base64: "/9j/4AAQ" },
    });
  });

  it("throws ReadabilityUnavailableError when the connection is refused", async () => {
    const port = await listen((_req, res) => res.end());
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    process.env["READABILITY_URL"] = `http://127.0.0.1:${port}`;

    await expect(readUrl("https://example.com/post")).rejects.toThrow(ReadabilityUnavailableError);
  });

  it("throws ReadabilityUnavailableError when READABILITY_URL is unset", async () => {
    await expect(readUrl("https://example.com/post")).rejects.toThrow(ReadabilityUnavailableError);
  });
});
