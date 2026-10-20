// The readability client is shared by every role service, so its test lives here with it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

import {
  pageReadUrlResult,
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

  it("throws ReadabilityTargetError when the worker is up but couldn't read that link", async () => {
    // Verbatim shape from the worker: 502 {"error":"fetch failed: TypeError: fetch failed"}.
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

describe("readUrl: a document the reader cut", () => {
  const serve = (body: unknown) =>
    listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });

  it("carries the full length when the reader says it stopped early", async () => {
    const port = await serve({ title: "Big PDF", text: "B".repeat(500), truncated: true, totalChars: 900_000 });
    process.env["READABILITY_URL"] = `http://127.0.0.1:${port}`;
    expect(await readUrl("https://example.com/big.pdf")).toEqual({
      title: "Big PDF",
      text: "B".repeat(500),
      sourceCut: { totalChars: 900_000 },
    });
  });

  it("accepts a response without the new fields (an older reader)", async () => {
    const port = await serve({ title: "Old", text: LONG_ARTICLE });
    process.env["READABILITY_URL"] = `http://127.0.0.1:${port}`;
    expect(await readUrl("https://example.com/a")).toEqual({ title: "Old", text: LONG_ARTICLE });
  });
});

describe("pageReadUrlResult", () => {
  const long = "x".repeat(30_000);

  it("leaves a short page exactly as it was read", () => {
    expect(pageReadUrlResult({ title: "T", text: LONG_ARTICLE })).toEqual({ title: "T", text: LONG_ARTICLE });
  });

  it("returns the first page with a note and the next offset", () => {
    const out = pageReadUrlResult({ title: "T", text: long }) as Record<string, unknown>;
    expect((out["text"] as string).length).toBe(12_000);
    expect(out).toMatchObject({ title: "T", truncated: true, totalChars: 30_000, nextOffset: 12_000 });
    expect(out["pagingNote"]).toContain("offset=12000");
  });

  it("returns the page at an offset, and the last page is not truncated", () => {
    const out = pageReadUrlResult({ title: "T", text: long }, 24_000) as Record<string, unknown>;
    expect((out["text"] as string).length).toBe(6_000);
    expect(out["truncated"]).toBeUndefined();
    expect(out["nextOffset"]).toBeUndefined();
    expect(out["totalChars"]).toBe(30_000);
  });

  it("says so when the offset is past the end", () => {
    const out = pageReadUrlResult({ title: "T", text: long }, 99_000) as Record<string, unknown>;
    expect(out["text"]).toBe("");
    expect(out["pagingNote"]).toContain("past the end");
  });

  it("leaves an image untouched", () => {
    const image = { mediaType: "image/png", base64: "AAAA" };
    expect(pageReadUrlResult({ title: "Pic", text: "", image }, 5)).toEqual({ title: "Pic", text: "", image });
  });

  it("adds a plain note, apart from the paging note, when the reader cut the document", () => {
    const out = pageReadUrlResult({ title: "T", text: long, sourceCut: { totalChars: 900_000 } }) as Record<string, unknown>;
    expect(out["sourceNote"]).toBe(
      "The reader stopped at 30,000 of 900,000 characters of this document; the rest cannot be read through this tool.",
    );
    expect(out["pagingNote"]).toContain("offset=12000");
    expect(out).not.toHaveProperty("sourceCut");
  });

  it("gives no source note for a document the reader did not cut", () => {
    expect(pageReadUrlResult({ title: "T", text: long })).not.toHaveProperty("sourceNote");
  });
});
