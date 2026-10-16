/**
 * Unit coverage for ../src/gateway-key-info.ts. No live network runs in this suite — `fetch`
 * is a hand-rolled fake injected exactly the way `readOwnKeyInfo({ gatewayUrl, key, fetch })`
 * requires. Every fixture below is what we BELIEVE the gateway returns (see that file's header
 * for exactly which part is documented and which is belief); `tests/live/litellm-key-info.live.mts`
 * is what settles the belief against the real gateway — this suite only re-confirms the shapes
 * it's been given.
 */
import { describe, it, expect, vi } from "vitest";

import { readOwnKeyInfo } from "../src/gateway-key-info.js";

const GATEWAY_URL = "https://gw.example.test";
const KEY = "sk-test-agent-key";

function fakeFetch(res: Response): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue(res) as unknown as typeof globalThis.fetch;
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

/** A full key, fully budgeted — the documented `/key/info?key=` envelope shape. */
const FULL_KEY_BODY = {
  key: KEY,
  info: {
    key_name: "sk-...redacted",
    spend: 12.3456,
    max_budget: 100,
    budget_duration: "30d",
    budget_reset_at: "2026-10-01T00:00:00.000Z",
    key_alias: "chief-of-staff",
  },
};

/** A key with no cap set — every optional field genuinely absent/null, not just zero. */
const NO_BUDGET_KEY_BODY = {
  key: KEY,
  info: {
    spend: 0.5,
    max_budget: null,
    budget_duration: null,
    budget_reset_at: null,
    key_alias: null,
  },
};

describe("readOwnKeyInfo", () => {
  it("parses a full, budgeted key", async () => {
    const fetch = fakeFetch(new Response(JSON.stringify(FULL_KEY_BODY), { status: 200 }));
    const result = await readOwnKeyInfo({ gatewayUrl: GATEWAY_URL, key: KEY, fetch });
    expect(result).toEqual({
      spend: 12.3456,
      maxBudget: 100,
      budgetDuration: "30d",
      budgetResetAt: "2026-10-01T00:00:00.000Z",
      keyAlias: "chief-of-staff",
    });
  });

  it("parses a no-budget key, with every absent field null rather than 0 or throwing", async () => {
    const fetch = fakeFetch(new Response(JSON.stringify(NO_BUDGET_KEY_BODY), { status: 200 }));
    const result = await readOwnKeyInfo({ gatewayUrl: GATEWAY_URL, key: KEY, fetch });
    expect(result).toEqual({
      spend: 0.5,
      maxBudget: null,
      budgetDuration: null,
      budgetResetAt: null,
      keyAlias: null,
    });
  });

  it("returns null on a 401 (a forbidden key, or the no-parameter form not being allowed)", async () => {
    const fetch = fakeFetch(
      new Response(JSON.stringify({ error: { message: "Invalid API Key", type: "auth_error" } }), { status: 401 }),
    );
    const result = await readOwnKeyInfo({ gatewayUrl: GATEWAY_URL, key: KEY, fetch });
    expect(result).toBeNull();
  });

  it("returns null on a 403", async () => {
    const fetch = fakeFetch(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }));
    const result = await readOwnKeyInfo({ gatewayUrl: GATEWAY_URL, key: KEY, fetch });
    expect(result).toBeNull();
  });

  it("returns null on an HTML error page — a non-JSON body from a proxy in front of the gateway", async () => {
    const fetch = fakeFetch(
      new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    const result = await readOwnKeyInfo({ gatewayUrl: GATEWAY_URL, key: KEY, fetch });
    expect(result).toBeNull();
  });

  it("returns null when the body is 200 but not JSON at all (malformed body, both directions of the parse check)", async () => {
    const fetch = fakeFetch(new Response("not json", { status: 200 }));
    const result = await readOwnKeyInfo({ gatewayUrl: GATEWAY_URL, key: KEY, fetch });
    expect(result).toBeNull();
  });

  it("returns null when info is missing entirely", async () => {
    const fetch = fakeFetch(new Response(JSON.stringify({ key: KEY }), { status: 200 }));
    const result = await readOwnKeyInfo({ gatewayUrl: GATEWAY_URL, key: KEY, fetch });
    expect(result).toBeNull();
  });

  it("returns null when spend is missing", async () => {
    const body = { key: KEY, info: { max_budget: 100 } };
    const fetch = fakeFetch(new Response(JSON.stringify(body), { status: 200 }));
    const result = await readOwnKeyInfo({ gatewayUrl: GATEWAY_URL, key: KEY, fetch });
    expect(result).toBeNull();
  });

  it("returns null when spend is a non-numeric string, not the documented numeric type", async () => {
    const body = { key: KEY, info: { spend: "12.34" } };
    const fetch = fakeFetch(new Response(JSON.stringify(body), { status: 200 }));
    const result = await readOwnKeyInfo({ gatewayUrl: GATEWAY_URL, key: KEY, fetch });
    expect(result).toBeNull();
  });

  it("returns null on a network error, never throwing", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("fetch failed")) as unknown as typeof globalThis.fetch;
    const result = await readOwnKeyInfo({ gatewayUrl: GATEWAY_URL, key: KEY, fetch });
    expect(result).toBeNull();
  });

  it("sends Authorization: Bearer <key> and the identity-encoding header, never the key anywhere else", async () => {
    const seen: Array<Headers> = [];
    const fetch = vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(new Response(JSON.stringify(FULL_KEY_BODY), { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    await readOwnKeyInfo({ gatewayUrl: GATEWAY_URL, key: KEY, fetch });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.get("accept-encoding")).toBe("identity");
  });

  it("calls GET <gatewayUrl>/key/info with no query parameter — the self-read form this client believes in", async () => {
    const seen: string[] = [];
    const fetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      seen.push(String(input));
      return Promise.resolve(new Response(JSON.stringify(FULL_KEY_BODY), { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    await readOwnKeyInfo({ gatewayUrl: GATEWAY_URL, key: KEY, fetch });
    expect(seen).toEqual([`${GATEWAY_URL}/key/info`]);
  });

  it("strips a trailing slash on gatewayUrl before appending /key/info", async () => {
    const seen: string[] = [];
    const fetch = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      seen.push(String(input));
      return Promise.resolve(new Response(JSON.stringify(FULL_KEY_BODY), { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    await readOwnKeyInfo({ gatewayUrl: `${GATEWAY_URL}/`, key: KEY, fetch });
    expect(seen).toEqual([`${GATEWAY_URL}/key/info`]);
  });

  it("never throws, and the returned/errored value never contains the key", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error(`request failed for key ${KEY}`)) as unknown as typeof globalThis.fetch;
    let threw = false;
    let result: Awaited<ReturnType<typeof readOwnKeyInfo>> = null;
    try {
      result = await readOwnKeyInfo({ gatewayUrl: GATEWAY_URL, key: KEY, fetch });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBeNull();
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});
