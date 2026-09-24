import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export interface Extracted {
  title: string;
  text: string;
  byline?: string;
  siteName?: string;
  excerpt?: string;
  /** Set for an image link (ORB-286): the picture itself, for the caller to show a vision model. */
  image?: { mediaType: string; base64: string };
}

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB hard cap
const MAX_PDF_BYTES = 20 * 1024 * 1024; // PDFs are bigger than pages; still bounded
const MAX_PDF_TEXT_CHARS = 200_000;     // the caller (read_url) sees at most this much
// An image link is handed back as the picture (ORB-286). Only the types the model accepts, and
// under eve's own 3 MiB warning — it is persisted in the session and re-sent on every call.
const MODEL_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000; // 10 s hard timeout (exported for tests)
const MAX_REDIRECTS = 5;                // bounded, re-validating redirect follow
const HTML_TYPES = ["text/html", "application/xhtml+xml"];

type Resolve = (host: string) => Promise<string[]>;
const defaultResolve: Resolve = async (h) => (await lookup(h, { all: true })).map((a) => a.address);

/**
 * Normalize an address for denylist testing.
 * IPv4-mapped IPv6 (e.g. "::ffff:10.0.0.1" or "::ffff:a00:1") collapses to the
 * embedded IPv4 so the IPv4 rules below catch it. Returns lowercase otherwise.
 */
function normalizeIp(ip: string): string {
  const m = /^::ffff:(.+)$/i.exec(ip);
  if (m) {
    const inner = m[1];
    if (isIP(inner) === 4) return inner;                 // ::ffff:10.0.0.1
    // hex form ::ffff:a00:1  -> a00:1 -> 10.0.0.1
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(inner);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return ip.toLowerCase();
}

/** Block private / loopback / link-local / unique-local / CGNAT / multicast / metadata ranges. */
function isPrivateIp(raw: string): boolean {
  const ip = normalizeIp(raw);

  // IPv4
  if (isIP(ip) === 4) {
    if (ip === "169.254.169.254") return true;                  // cloud metadata
    if (/^127\./.test(ip)) return true;                         // loopback
    if (/^10\./.test(ip)) return true;                          // RFC1918
    if (/^192\.168\./.test(ip)) return true;                    // RFC1918
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;    // RFC1918
    if (/^169\.254\./.test(ip)) return true;                    // link-local
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true; // CGNAT 100.64.0.0/10
    if (/^(22[4-9]|23\d)\./.test(ip)) return true;              // multicast 224.0.0.0/4
    if (/^(24\d|25[0-5])\./.test(ip)) return true;              // reserved/broadcast 240.0.0.0/4 + 255
    if (/^0\./.test(ip)) return true;                           // unspecified / "this" network 0.0.0.0/8
    return false;
  }

  // IPv6
  if (ip === "::1") return true;                                // loopback
  if (ip === "::" || ip === "0:0:0:0:0:0:0:0") return true;     // unspecified
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;              // ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;             // link-local fe80::/10
  if (/^ff[0-9a-f]{2}:/i.test(ip)) return true;                // multicast ff00::/8
  return false;
}

/** Validate a URL's scheme and resolved addresses. Returns the pre-validated IPs for connection pinning. */
export async function isSafeUrl(
  url: string,
  resolve: Resolve = defaultResolve,
): Promise<{ ok: true; ips: string[] } | { ok: false; reason: string }> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, reason: "invalid url" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "scheme not allowed" };
  const host = u.hostname;
  const ips = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (!ips.length) return { ok: false, reason: "unresolvable host" };
  if (ips.some(isPrivateIp)) return { ok: false, reason: "private/internal address" };
  return { ok: true, ips };
}

export function extract(html: string, url: string): Extracted {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  const title = article?.title?.trim() || dom.window.document.title?.trim() || "Untitled";
  const text = (article?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text, byline: article?.byline ?? undefined, siteName: article?.siteName ?? undefined, excerpt: article?.excerpt ?? undefined };
}

/** Text of a PDF fetched from a link. The title is the PDF's own, else the file name in the URL. */
export async function extractPdf(bytes: Uint8Array | string, url: string): Promise<Extracted> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const { getDocumentProxy, extractText, getMeta } = await import("unpdf");
  let doc;
  try {
    doc = await getDocumentProxy(new Uint8Array(data));
  } catch (e) {
    throw err(502, `unreadable pdf: ${e}`);
  }
  const { text } = await extractText(doc, { mergePages: true });
  const meta = await getMeta(doc).catch(() => ({ info: {} as Record<string, unknown> }));
  const metaTitle = typeof (meta.info as Record<string, unknown>)["Title"] === "string" ? String((meta.info as Record<string, unknown>)["Title"]).trim() : "";
  const fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || "PDF";
  const clean = String(text).replace(/\n{3,}/g, "\n\n").trim();
  return { title: metaTitle || fileName, text: clean.slice(0, MAX_PDF_TEXT_CHARS) };
}

function err(status: number, msg: string): Error & { status: number } {
  return Object.assign(new Error(msg), { status });
}

/**
 * Build an undici dispatcher that PINS the connection to one of the pre-validated
 * IPs while preserving the original hostname for Host header / TLS SNI. This closes
 * the DNS-rebinding TOCTOU window: the OS will not re-resolve the host, so it cannot
 * connect to a different (now-private) address than the one isSafeUrl validated.
 */
function pinnedDispatcher(ip: string): Agent {
  return new Agent({
    connect: {
      lookup: (_hostname, _opts, cb) => {
        cb(null, [{ address: ip, family: isIP(ip) === 6 ? 6 : 4 }]);
      },
    },
  });
}

/**
 * Read a response body with a hard byte cap; bail as soon as the cap is exceeded.
 * The caller must pass the AbortSignal so that a timeout during the body read
 * (slow-drip) actually interrupts `reader.read()`.
 */
async function readCapped(res: Response, signal: AbortSignal): Promise<string> {
  const bytes = await readCappedBytes(res, signal, MAX_BODY_BYTES);
  return typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
}

/** The byte-level read behind `readCapped`, with a per-call cap (PDFs get a larger one). */
async function readCappedBytes(res: Response, signal: AbortSignal, cap: number): Promise<Uint8Array | string> {
  const MAX_BODY_BYTES = cap;
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw err(502, `body too large (content-length ${declared} > ${MAX_BODY_BYTES})`);
  }
  // Stream when a body is available so we can bail mid-flight on undeclared sizes.
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();

    // Abort the stream reader when the signal fires (covers slow-drip DoS).
    const onAbort = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", onAbort, { once: true });

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw err(502, "timeout reading body");
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_BODY_BYTES) {
            await reader.cancel().catch(() => {});
            throw err(502, `body too large (streamed > ${MAX_BODY_BYTES})`);
          }
          chunks.push(value);
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
  }
  // Fallback (e.g. injected mocks without a stream body): read then re-check size.
  if (typeof res.arrayBuffer === "function") {
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.byteLength > MAX_BODY_BYTES) throw err(502, `body too large (> ${MAX_BODY_BYTES})`);
    return b;
  }
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw err(502, `body too large (> ${MAX_BODY_BYTES})`);
  return text;
}

export interface ExtractDeps {
  fetchFn?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
  /** Override the per-hop timeout (ms). Defaults to FETCH_TIMEOUT_MS. Used in tests. */
  timeoutMs?: number;
}

/**
 * One guarded GET — the same SSRF guard, IP pin, re-validating redirect follow and timeout as
 * `fetchAndExtract`, returning the raw body. For callers that need bytes, not Readability.
 */
async function fetchGuarded(
  url: string,
  deps: ExtractDeps,
  cap: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; contentType: string; bytes: Uint8Array | string; finalUrl: string }> {
  const f = deps.fetchFn ?? (undiciFetch as unknown as typeof fetch);
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safe = await isSafeUrl(current, deps.resolve);
    if (!safe.ok) throw err(400, `unsafe url: ${safe.reason}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit & { dispatcher?: Agent } = {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "lares-readability/1.0", ...headers },
      };
      if (!deps.fetchFn) init.dispatcher = pinnedDispatcher(safe.ips[0]);
      const res = await f(current, init);
      const status = res.status ?? 200;
      if (status >= 300 && status < 400 && res.headers?.get) {
        const loc = res.headers.get("location");
        if (!loc) throw err(502, `redirect ${status} without location`);
        current = new URL(loc, current).toString();
        continue;
      }
      const contentType = (res.headers?.get?.("content-type") ?? "").split(";")[0].trim().toLowerCase();
      return { status, contentType, bytes: await readCappedBytes(res, controller.signal, cap), finalUrl: current };
    } catch (e) {
      if ((e as { status?: number }).status) throw e;
      if (controller.signal.aborted) throw err(502, "timeout (headers or body)");
      throw err(502, `fetch failed: ${e}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw err(502, "too many redirects");
}

const asText = (b: Uint8Array | string): string => (typeof b === "string" ? b : new TextDecoder().decode(b));

/** The video id of a YouTube link, or null. youtube.com/watch?v=, /shorts/, /live/, youtu.be/. */
export function youtubeVideoId(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  const id = host === "youtu.be"
    ? u.pathname.slice(1).split("/")[0]
    : host === "youtube.com"
      ? (u.searchParams.get("v") ?? u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)?.[1] ?? "")
      : "";
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
}

/**
 * What a server can learn about a YouTube video (ORB-286 batch 6). Measured from ops-1, 2026-09-14:
 * the oEmbed endpoint answered title + channel for 3/3 videos; the watch page answered "Sign in to
 * confirm you're not a bot" for 2/3; and caption tracks came back EMPTY (0 bytes) from both ops-1
 * and a home connection, because YouTube now gates them behind a browser-only token. So: title and
 * channel always, the description when the watch page lets us through, and a plain note that the
 * spoken content is not available. tests/live/readability.live.mts carries the video sweep.
 */
export async function extractYouTube(id: string, deps: ExtractDeps = {}): Promise<Extracted> {
  const watch = `https://www.youtube.com/watch?v=${id}`;
  let title = "";
  let author = "";
  let oembedStatus = 0;
  try {
    const o = await fetchGuarded(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, deps, 256 * 1024);
    oembedStatus = o.status;
    if (o.status === 200) {
      const j = JSON.parse(asText(o.bytes)) as { title?: unknown; author_name?: unknown };
      title = typeof j.title === "string" ? j.title : "";
      author = typeof j.author_name === "string" ? j.author_name : "";
    }
  } catch {
    // Fall through to the watch page; the verdict below says what was missing.
  }

  let description = "";
  try {
    const page = await fetchGuarded(`${watch}&hl=en`, deps, MAX_BODY_BYTES, {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "accept-language": "en-US,en;q=0.8",
      cookie: "CONSENT=YES+cb; SOCS=CAI",
    });
    const m = asText(page.bytes).match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:var|<\/script>)/s);
    const pr = m ? (JSON.parse(m[1]) as { playabilityStatus?: { status?: string }; videoDetails?: { title?: string; author?: string; shortDescription?: string } }) : null;
    if (pr?.playabilityStatus?.status === "OK") {
      description = pr.videoDetails?.shortDescription ?? "";
      title ||= pr.videoDetails?.title ?? "";
      author ||= pr.videoDetails?.author ?? "";
    }
  } catch {
    // Best effort: the watch page is often bot-walled for servers. Title + channel still stand.
  }

  if (!title) {
    throw err(
      502,
      [401, 403, 404].includes(oembedStatus)
        ? `YouTube says this video is private, removed or not embeddable (oEmbed ${oembedStatus})`
        : "YouTube gave no details for this video",
    );
  }
  const parts = [`YouTube video: "${title}"${author ? ` by ${author}` : ""}.`];
  parts.push(description.trim() ? `Description:\n${description.trim()}` : "(No description was available to the reader.)");
  parts.push(
    "[What was NOT available: the video's spoken content. YouTube does not give transcripts or " +
      "audio to servers, so only the title, channel and (when shown) description above are known. " +
      "Say so plainly if the question needs what is said in the video.]",
  );
  return { title: `${title}${author ? ` — ${author}` : ""} (YouTube)`, text: parts.join("\n\n") };
}

export async function fetchAndExtract(
  url: string,
  deps: ExtractDeps = {},
): Promise<Extracted> {
  const yt = youtubeVideoId(url);
  if (yt) return extractYouTube(yt, deps);
  // undici's OWN fetch, never Node's built-in one: the pinned `Agent` below comes from the npm
  // undici package, and Node 22's bundled fetch rejects an undici-8 dispatcher outright
  // (UND_ERR_INVALID_ARG → "fetch failed" on every URL). That pairing broke all link reading
  // from the 2026-09-01 undici ^7 → ^8 bump until 2026-09-14 (ORB-286), unseen because every
  // unit test injects fetchFn. tests/live/readability.live.mts is the check that makes real calls.
  const f = deps.fetchFn ?? (undiciFetch as unknown as typeof fetch);
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  // When a fetchFn is injected (tests), skip the real network dispatcher so the
  // suite stays fully offline; the redirect/validation logic still runs.
  const injected = !!deps.fetchFn;

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safe = await isSafeUrl(current, deps.resolve);
    if (!safe.ok) throw err(400, `unsafe url: ${safe.reason}`);

    // One AbortController per hop — the deadline covers BOTH headers AND body read.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      const init: RequestInit & { dispatcher?: Agent } = {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "lares-readability/1.0" },
      };
      // Pin the connection to the first pre-validated IP (rebinding defence).
      if (!injected) init.dispatcher = pinnedDispatcher(safe.ips[0]);
      res = await f(current, init);

      const status = res.status ?? 200;

      // Re-validating bounded redirect follow (manual): never follow blindly.
      if (status >= 300 && status < 400 && res.headers?.get) {
        const loc = res.headers.get("location");
        if (!loc) throw err(502, `redirect ${status} without location`);
        if (hop === MAX_REDIRECTS) throw err(502, "too many redirects");
        current = new URL(loc, current).toString(); // loop re-validates + re-pins
        continue; // clearTimeout happens in finally before the next hop creates a new one
      }

      if (status !== 200 && !(res.ok ?? (status >= 200 && status < 300))) {
        throw err(502, `fetch ${status}`);
      }

      // HTML goes through Readability; a PDF through unpdf (ORB-286: a link to a PDF used to
      // answer "unsupported content-type" and the agent fell back to guessing from elsewhere).
      const ct = res.headers?.get?.("content-type") ?? "text/html";
      const mime = ct.split(";")[0].trim().toLowerCase();
      if (mime === "application/pdf") {
        return await extractPdf(await readCappedBytes(res, controller.signal, MAX_PDF_BYTES), current);
      }
      if (MODEL_IMAGE_TYPES.includes(mime)) {
        const b = await readCappedBytes(res, controller.signal, MAX_IMAGE_BYTES);
        const bytes = typeof b === "string" ? new TextEncoder().encode(b) : b;
        const name = decodeURIComponent(new URL(current).pathname.split("/").pop() ?? "") || "image";
        return { title: name, text: "", image: { mediaType: mime, base64: Buffer.from(bytes).toString("base64") } };
      }
      if (mime.startsWith("image/")) {
        throw err(502, `the image format ${mime} can't be viewed (only JPEG, PNG, GIF or WebP)`);
      }
      if (!HTML_TYPES.includes(mime)) throw err(502, `unsupported content-type: ${mime || "(none)"}`);

      // Pass the signal so a timeout during slow body-read interrupts reader.read().
      return extract(await readCapped(res, controller.signal), current);
    } catch (e) {
      if ((e as { status?: number }).status) throw e;
      if (controller.signal.aborted) throw err(502, "timeout (headers or body)");
      throw err(502, `fetch failed: ${e}`);
    } finally {
      // Timer is cleared AFTER readCapped returns (or throws), not after headers arrive.
      clearTimeout(timer);
    }
  }
  throw err(502, "too many redirects");
}
