import { describe, it, expect, vi } from "vitest";
import { makeRequester, backoffFor, isIdempotentByDefault, paginate, collect } from "../src/request.js";
import { isRequestError, RequestError } from "../src/request-error.js";

const slept: number[] = [];
const base = {
  integration: "probe",
  random: () => 0.5,
  sleep: async (ms: number) => {
    slept.push(ms);
  },
};
const ok = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { status: 200, ...init });

describe("backoffFor", () => {
  it("doubles per attempt and jitters within ±25%", () => {
    const cfg = { backoffMs: 250, maxBackoffMs: 8000, random: () => 0.5 };
    expect(backoffFor(1, cfg)).toBe(250);
    expect(backoffFor(2, cfg)).toBe(500);
    expect(backoffFor(3, cfg)).toBe(1000);
    expect(backoffFor(1, { ...cfg, random: () => 0 })).toBe(188);
    expect(backoffFor(1, { ...cfg, random: () => 1 })).toBe(312);
  });

  it("never exceeds the ceiling", () => {
    expect(backoffFor(20, { backoffMs: 250, maxBackoffMs: 8000, random: () => 1 })).toBe(8000);
  });
});

describe("isIdempotentByDefault", () => {
  it("is true with no method, and true for GET and HEAD (any case)", () => {
    expect(isIdempotentByDefault(undefined)).toBe(true);
    expect(isIdempotentByDefault("GET")).toBe(true);
    expect(isIdempotentByDefault("get")).toBe(true);
    expect(isIdempotentByDefault("HEAD")).toBe(true);
  });

  it("is false for every method that can create or send something", () => {
    expect(isIdempotentByDefault("POST")).toBe(false);
    expect(isIdempotentByDefault("PUT")).toBe(false);
    expect(isIdempotentByDefault("PATCH")).toBe(false);
    expect(isIdempotentByDefault("DELETE")).toBe(false);
  });
});

describe("the requester", () => {
  it("returns parsed JSON on the happy path and makes exactly one call", async () => {
    const fetch = vi.fn(async () => ok({ rate: 11.6 }));
    const r = makeRequester({ ...base, fetch: fetch as never });
    expect(await r.json<{ rate: number }>("https://x.test/a")).toEqual({ rate: 11.6 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 and succeeds", async () => {
    slept.length = 0;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(ok({ ok: true }));
    const r = makeRequester({ ...base, fetch: fetch as never });
    expect(await r.json("https://x.test/a")).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([250]);
  });

  it("gives up after the configured attempts and throws a down", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 500 }));
    const r = makeRequester({ ...base, fetch: fetch as never, attempts: 3 });
    await expect(r.json("https://x.test/a")).rejects.toMatchObject({ kind: "down", integration: "probe", status: 500 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("never retries a 401", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 401 }));
    const r = makeRequester({ ...base, fetch: fetch as never });
    await expect(r.json("https://x.test/a")).rejects.toMatchObject({ kind: "not_authorised" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never retries a 402", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 402 }));
    const r = makeRequester({ ...base, fetch: fetch as never });
    await expect(r.json("https://x.test/a")).rejects.toMatchObject({ kind: "not_subscribed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honours Retry-After on a 429 instead of its own backoff", async () => {
    slept.length = 0;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(ok({ ok: true }));
    const r = makeRequester({ ...base, fetch: fetch as never });
    await r.json("https://x.test/a");
    expect(slept).toEqual([2000]);
  });

  it("turns a network failure into a down and retries it", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok({ ok: true }));
    const r = makeRequester({ ...base, fetch: fetch as never });
    expect(await r.json("https://x.test/a")).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("turns an unparseable body into a down, and does not retry it", async () => {
    const fetch = vi.fn(async () => new Response("not json", { status: 200 }));
    const r = makeRequester({ ...base, fetch: fetch as never });
    await expect(r.json("https://x.test/a")).rejects.toMatchObject({ kind: "down" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("passes an expected status straight through", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ found: false }), { status: 404 }));
    const r = makeRequester({ ...base, fetch: fetch as never });
    expect(await r.json("https://x.test/a", { expect: [404] })).toEqual({ found: false });
  });

  it("leaves an unmapped 4xx as a down with its status, rather than inventing a kind", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 422 }));
    const r = makeRequester({ ...base, fetch: fetch as never, attempts: 1 });
    await expect(r.json("https://x.test/a")).rejects.toMatchObject({ kind: "down", status: 422 });
  });

  it("stops immediately when the caller's own signal aborts", async () => {
    const ac = new AbortController();
    ac.abort();
    const fetch = vi.fn(async () => ok({}));
    const r = makeRequester({ ...base, fetch: fetch as never });
    await expect(r.json("https://x.test/a", { signal: ac.signal })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never puts a URL or a header value in the error message", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 500 }));
    const r = makeRequester({ ...base, fetch: fetch as never, attempts: 1 });
    await r.json("https://x.test/a?key=SECRET", { headers: { Authorization: "Bearer SECRET" } }).catch((e) => {
      expect(isRequestError(e)).toBe(true);
      expect(String(e.message)).not.toContain("SECRET");
    });
  });
});

describe("the requester — retry safety on non-idempotent requests", () => {
  it("a POST that gets a 503 is attempted exactly once and throws down", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 503 }));
    const r = makeRequester({ ...base, fetch: fetch as never });
    await expect(r.json("https://x.test/a", { method: "POST", body: "{}" })).rejects.toMatchObject({ kind: "down" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a POST that times out is attempted exactly once", async () => {
    const fetch = vi.fn(async () => {
      throw new DOMException("the operation timed out", "TimeoutError");
    });
    const r = makeRequester({ ...base, fetch: fetch as never });
    await expect(r.json("https://x.test/a", { method: "POST", body: "{}" })).rejects.toMatchObject({ kind: "down" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a POST with idempotent: true retries like a GET", async () => {
    slept.length = 0;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(ok({ ok: true }));
    const r = makeRequester({ ...base, fetch: fetch as never });
    expect(await r.json("https://x.test/a", { method: "POST", body: "{}", idempotent: true })).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a GET with idempotent: false is attempted exactly once", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 503 }));
    const r = makeRequester({ ...base, fetch: fetch as never });
    await expect(r.json("https://x.test/a", { method: "GET", idempotent: false })).rejects.toMatchObject({ kind: "down" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a 429 on a POST throws rate_limited with retryAfterSeconds populated and no retry", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 429, headers: { "Retry-After": "5" } }));
    const r = makeRequester({ ...base, fetch: fetch as never });
    await expect(r.json("https://x.test/a", { method: "POST", body: "{}" })).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterSeconds: 5,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("paginate", () => {
  const pages = [{ items: [1, 2], cursor: "b" }, { items: [3], cursor: "c" }, { items: [4], cursor: null }];
  const spec = (maxPages?: number) => ({
    first: async () => pages[0]!,
    next: (p: (typeof pages)[number]) => (p.cursor ? async () => pages[pages.indexOf(p) + 1]! : undefined),
    items: (p: (typeof pages)[number]) => p.items,
    ...(maxPages === undefined ? {} : { maxPages }),
  });

  it("walks every page in order", async () => {
    expect(await collect(spec())).toEqual([1, 2, 3, 4]);
  });

  it("yields lazily — a consumer that stops early makes no further request", async () => {
    let calls = 0;
    const counted = { ...spec(), first: async () => { calls++; return pages[0]!; } };
    for await (const item of paginate(counted)) { if (item === 1) break; }
    expect(calls).toBe(1);
  });

  it("stops at the ceiling rather than looping forever", async () => {
    const endless = { first: async () => ({ items: [1] }), next: () => async () => ({ items: [1] }), items: (p: { items: number[] }) => p.items, maxPages: 3 };
    expect(await collect(endless)).toEqual([1, 1, 1]);
  });

  it("an empty first page yields nothing and asks for no second", async () => {
    expect(await collect({ first: async () => ({ items: [] as number[] }), next: () => undefined, items: (p: { items: number[] }) => p.items })).toEqual([]);
  });

  it("lets a RequestError from a later page out unchanged", async () => {
    const boom = { first: async () => pages[0]!, next: () => async () => { throw new RequestError("rate_limited", "x", { integration: "p" }); }, items: (p: (typeof pages)[number]) => p.items };
    await expect(collect(boom)).rejects.toMatchObject({ kind: "rate_limited" });
  });
});
