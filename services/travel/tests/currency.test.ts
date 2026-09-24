import { describe, it, expect, vi } from "vitest";
import { makeCurrency, CurrencyUnavailableError } from "../lib/currency.js";
import { isRequestError } from "@lares/agent-kit/request-error";

const body = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const good = { amount: 1, base: "EUR", date: "2026-09-17", rates: { NOK: 11.6 } };

describe("currency conversion — behaviour that must not change", () => {
  it("converts, upper-cases the codes and rounds to two places", async () => {
    const fetch = vi.fn(async () => body(good));
    const c = makeCurrency({ fetch: fetch as never });
    expect(await c.convert(10, "eur", "nok")).toEqual({ amount: 10, from: "EUR", to: "NOK", rate: 11.6, converted: 116, date: "2026-09-17" });
    expect(String(fetch.mock.calls[0]![0])).toContain("base=EUR&symbols=NOK");
  });

  it("throws CurrencyUnavailableError, never a NaN, when the rate is missing", async () => {
    const c = makeCurrency({ fetch: (async () => body({ amount: 1, date: "2026-09-17", rates: {} })) as never });
    await expect(c.convert(10, "EUR", "NOK")).rejects.toBeInstanceOf(CurrencyUnavailableError);
  });

  it("throws on an unparsable body", async () => {
    const c = makeCurrency({ fetch: (async () => new Response("not json")) as never });
    await expect(c.convert(10, "EUR", "NOK")).rejects.toBeInstanceOf(CurrencyUnavailableError);
  });
});

describe("currency conversion — what the shared helper adds", () => {
  it("retries a 503 instead of failing the first time", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(body({}, 503)).mockResolvedValueOnce(body(good));
    const c = makeCurrency({ fetch: fetch as never, sleep: async () => {} });
    expect((await c.convert(1, "EUR", "NOK")).rate).toBe(11.6);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401", async () => {
    const fetch = vi.fn(async () => body({}, 401));
    const c = makeCurrency({ fetch: fetch as never, sleep: async () => {} });
    await expect(c.convert(1, "EUR", "NOK")).rejects.toBeInstanceOf(CurrencyUnavailableError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("carries the typed kind on the cause, so a Repairs row can name what broke", async () => {
    const c = makeCurrency({ fetch: (async () => body({}, 429)) as never, sleep: async () => {}, attempts: 1 });
    const err = await c.convert(1, "EUR", "NOK").catch((e) => e);
    expect(err).toBeInstanceOf(CurrencyUnavailableError);
    expect(isRequestError(err.cause)).toBe(true);
    expect(err.cause.kind).toBe("rate_limited");
    expect(err.cause.integration).toBe("frankfurter");
  });

  it("says nothing about the URL in the message the model sees", async () => {
    const c = makeCurrency({ fetch: (async () => body({}, 500)) as never, sleep: async () => {}, attempts: 1 });
    const err = await c.convert(1, "EUR", "NOK").catch((e) => e);
    expect(String(err.message)).not.toContain("frankfurter.dev");
  });
});
