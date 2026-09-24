import { describe, it, expect } from "vitest";
import { isSafeUrl, extract, fetchAndExtract } from "../lib/extract.js";

const ARTICLE = `<html><head><title>Hello World</title></head><body>
  <article><h1>Hello World</h1><p>${"This is the body of a real article. ".repeat(20)}</p></article>
</body></html>`;

/** Build a minimal Response-shaped mock for the injected fetchFn. */
function mockResponse(opts: {
  status?: number;
  ok?: boolean;
  headers?: Record<string, string>;
  body?: string;
}): Response {
  const status = opts.status ?? 200;
  const headers = new Headers({ "content-type": "text/html", ...(opts.headers ?? {}) });
  const body = opts.body ?? ARTICLE;
  return {
    ok: opts.ok ?? (status >= 200 && status < 300),
    status,
    headers,
    text: async () => body,
    // a real ReadableStream so the streaming size-cap path is exercised
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  } as unknown as Response;
}

describe("isSafeUrl", () => {
  it("accepts a normal public https url", async () => {
    const r = await isSafeUrl("https://example.com/post", async () => ["93.184.216.34"]);
    expect(r.ok).toBe(true);
  });
  it("rejects non-http schemes", async () => {
    const r = await isSafeUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
  });
  it("rejects a host resolving to a private IP (SSRF)", async () => {
    const r = await isSafeUrl("https://internal.local", async () => ["10.0.0.5"]);
    expect(r.ok).toBe(false);
  });
  it("rejects the cloud metadata IP", async () => {
    const r = await isSafeUrl("https://x.test", async () => ["169.254.169.254"]);
    expect(r.ok).toBe(false);
  });
  it("rejects an IPv4-mapped IPv6 private address (::ffff:10.0.0.1)", async () => {
    const r = await isSafeUrl("https://mapped.test", async () => ["::ffff:10.0.0.1"]);
    expect(r.ok).toBe(false);
  });
  it("rejects CGNAT 100.64.0.0/10", async () => {
    const r = await isSafeUrl("https://cgnat.test", async () => ["100.64.1.1"]);
    expect(r.ok).toBe(false);
  });
  it("rejects the unspecified address 0.0.0.0", async () => {
    const r = await isSafeUrl("https://zero.test", async () => ["0.0.0.0"]);
    expect(r.ok).toBe(false);
  });
  it("rejects IPv4 multicast 224.0.0.1", async () => {
    const r = await isSafeUrl("https://mcast.test", async () => ["224.0.0.1"]);
    expect(r.ok).toBe(false);
  });
});

describe("extract", () => {
  it("pulls title + readable text from article HTML", () => {
    const out = extract(ARTICLE, "https://example.com/post");
    expect(out.title).toContain("Hello World");
    expect(out.text).toContain("body of a real article");
  });
});

describe("fetchAndExtract", () => {
  it("guards, fetches, extracts", async () => {
    const fetchFn = (async () => ({ ok: true, text: async () => ARTICLE }) as any) as unknown as typeof fetch;
    const out = await fetchAndExtract("https://example.com/post", { fetchFn, resolve: async () => ["93.184.216.34"] });
    expect(out.title).toContain("Hello World");
  });
  it("throws a 400-shaped error on an unsafe url", async () => {
    await expect(fetchAndExtract("https://x", { resolve: async () => ["127.0.0.1"] }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("rejects a redirect to a private IP (SSRF via 3xx)", async () => {
    // First request: public host returns a redirect to an internal address.
    // The redirect target must be re-validated and rejected.
    const fetchFn = (async () =>
      mockResponse({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })) as unknown as typeof fetch;
    const resolve = async (host: string) => (host === "example.com" ? ["93.184.216.34"] : ["169.254.169.254"]);
    await expect(fetchAndExtract("https://example.com/post", { fetchFn, resolve }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("rejects a body over the size cap (declared content-length)", async () => {
    const fetchFn = (async () =>
      mockResponse({ headers: { "content-length": String(50 * 1024 * 1024) } })) as unknown as typeof fetch;
    await expect(fetchAndExtract("https://example.com/post", { fetchFn, resolve: async () => ["93.184.216.34"] }))
      .rejects.toMatchObject({ status: 502 });
  });

  it("rejects a body that streams over the size cap (no content-length)", async () => {
    const huge = "a".repeat(6 * 1024 * 1024); // 6 MB > 5 MB cap
    const fetchFn = (async () => mockResponse({ body: huge })) as unknown as typeof fetch;
    await expect(fetchAndExtract("https://example.com/post", { fetchFn, resolve: async () => ["93.184.216.34"] }))
      .rejects.toMatchObject({ status: 502 });
  });

  it("rejects a non-html content-type", async () => {
    const fetchFn = (async () =>
      mockResponse({ headers: { "content-type": "application/zip" }, body: "PK" })) as unknown as typeof fetch;
    await expect(fetchAndExtract("https://example.com/post", { fetchFn, resolve: async () => ["93.184.216.34"] }))
      .rejects.toMatchObject({ status: 502 });
  });

  it("rejects a slow-drip body that never completes within the timeout", async () => {
    // A response whose body stream never resolves (simulates slow-drip / stalled server).
    // The body read must be interrupted by the per-hop AbortController; without the fix
    // the timer would have been cleared after headers arrived and this would hang forever.
    const neverResolvingBody = new ReadableStream<Uint8Array>({
      start() {
        // intentionally never calls controller.enqueue() or controller.close()
      },
      cancel() {}, // allows reader.cancel() to resolve cleanly
    });
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      body: neverResolvingBody,
      text: async () => { throw new Error("should not reach .text()"); },
    })) as unknown as typeof fetch;

    // Use a short 50 ms timeout so the test completes fast.
    await expect(
      fetchAndExtract("https://example.com/post", {
        fetchFn,
        resolve: async () => ["93.184.216.34"],
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("youtubeVideoId (ORB-286 batch 6)", () => {
  it("reads the id from every YouTube link shape", async () => {
    const { youtubeVideoId } = await import("../lib/extract.js");
    expect(youtubeVideoId("https://www.youtube.com/watch?v=jNQXAC9IVRw")).toBe("jNQXAC9IVRw");
    expect(youtubeVideoId("https://m.youtube.com/watch?v=jNQXAC9IVRw&t=3")).toBe("jNQXAC9IVRw");
    expect(youtubeVideoId("https://youtu.be/jNQXAC9IVRw?si=abc")).toBe("jNQXAC9IVRw");
    expect(youtubeVideoId("https://www.youtube.com/shorts/jNQXAC9IVRw")).toBe("jNQXAC9IVRw");
    expect(youtubeVideoId("https://music.youtube.com/watch?v=jNQXAC9IVRw")).toBe("jNQXAC9IVRw");
  });

  it("is null for anything else", async () => {
    const { youtubeVideoId } = await import("../lib/extract.js");
    expect(youtubeVideoId("https://www.youtube.com/@TED")).toBeNull();
    expect(youtubeVideoId("https://notyoutube.com/watch?v=jNQXAC9IVRw")).toBeNull();
    expect(youtubeVideoId("https://example.com/")).toBeNull();
  });
});
