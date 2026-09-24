// lib/currency.ts — Frankfurter currency conversion (new, 2026-08-16 approved improvement,
// Tier 1 #2). Free, keyless, ECB-sourced reference rates — no rate limiting needed at
// Marcel's volume (a handful of conversions per trip, not a hot path).
//
// ORB-51 posture (never a silent wrong number, matching the Brain-search bug's own lesson —
// see MEMORY.md `project_saga_brain_search_bug`): any network/parse failure throws a typed
// `CurrencyUnavailableError` rather than returning NaN/undefined/a stale-looking number. The
// tool wrapper (catalogue/currency_convert.ts) lets this propagate as a tool error rather
// than swallowing it into a best-effort `{ error }` payload — a wrong exchange rate in a
// family group chat is a real-money mistake, not a garnish the model can shrug off. That
// posture is unchanged here: it is still never a silent wrong number, only the plumbing
// underneath moved.
//
// ON THE SHARED HELPER (`@lares/agent-kit/request`) — WAVE 3, THE PROOF SLICE. This is the
// first (and, this wave, the only) existing client moved onto the shared request/retry/backoff
// helper: it is keyless, has one endpoint and one call, already had an injected fetch seam, and
// already had a typed error the tool wrapper lets propagate — so the migration exercises
// timeout, retry, backoff and error mapping and nothing else (no pagination, no caching, no
// auth to get wrong). `CurrencyUnavailableError` still wraps every failure the model sees; the
// shared helper's `RequestError` now rides along as `.cause`, so a Repairs row (ADR-0019 rule 9)
// can later say WHICH of "the service is down" / "slow down" it was — never a stack trace, and
// never the request URL (the helper's own message rule).

import { makeRequester, type Requester } from "@lares/agent-kit/request";

export class CurrencyUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CurrencyUnavailableError";
  }
}

export interface CurrencyConversion {
  amount: number;
  from: string;
  to: string;
  rate: number;
  converted: number;
  date: string; // ECB reference date for the rate, as Frankfurter reports it
}

const BASE = "https://api.frankfurter.dev/v1";

interface FrankfurterResponse {
  amount?: number;
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}

export interface CurrencyDeps {
  fetch?: typeof globalThis.fetch;
  /** Total attempts including the first. Passed straight through to the shared helper so the
   *  tests can pin retry counts without a slow real backoff. Production leaves this at the
   *  helper's own default (3). */
  attempts?: number;
  /** Injected clock for the retry backoff, so the tests are fast and deterministic. */
  sleep?: (ms: number) => Promise<void>;
}

function makeRequest(deps: CurrencyDeps): Requester {
  return makeRequester({
    integration: "frankfurter",
    fetch: deps.fetch,
    timeoutMs: 8000, // unchanged from before the migration
    attempts: deps.attempts,
    sleep: deps.sleep,
  });
}

export function makeCurrency(deps: CurrencyDeps = {}) {
  const request = makeRequest(deps);

  return {
    /** Converts `amount` from `from` to `to` against Frankfurter's latest ECB reference
     *  rate. Currency codes are upper-cased before the request (Frankfurter is
     *  case-sensitive on `symbols`/`base`) — the tool wrapper does not need to normalize
     *  the model's input itself. */
    async convert(amount: number, from: string, to: string): Promise<CurrencyConversion> {
      const fromCode = from.trim().toUpperCase();
      const toCode = to.trim().toUpperCase();
      let data: FrankfurterResponse;
      try {
        data = await request.json<FrankfurterResponse>(
          `${BASE}/latest?base=${encodeURIComponent(fromCode)}&symbols=${encodeURIComponent(toCode)}`,
        );
      } catch (err) {
        throw new CurrencyUnavailableError(
          `currency: could not reach the exchange-rate service for ${fromCode}->${toCode}`,
          { cause: err },
        );
      }
      const rate = data.rates?.[toCode];
      if (typeof rate !== "number" || !Number.isFinite(rate) || !data.date) {
        throw new CurrencyUnavailableError(`currency: no rate for ${fromCode}->${toCode} in frankfurter response`);
      }
      return {
        amount,
        from: fromCode,
        to: toCode,
        rate,
        converted: Math.round(amount * rate * 100) / 100,
        date: data.date,
      };
    },
  };
}

export type Currency = ReturnType<typeof makeCurrency>;
