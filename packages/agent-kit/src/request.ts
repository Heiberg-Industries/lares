// One shared request helper for every vendor client this fleet writes: a per-attempt timeout,
// bounded retry with jittered backoff, and Retry-After honoured on a 429. ADR-0019 rule 2's four
// error kinds ("down", "not_authorised", "rate_limited", "not_subscribed") live in
// ./request-error.ts; this file is what turns a live fetch into that taxonomy.
//
// THE DEFAULT FETCH IS THE SEALED PROXY, NEVER A NEW NETWORK STACK. `./telegram-fetch.ts`'s own
// header says it plainly: this is "the GENERIC sealed-egress proxy fetch — every agent's outbound
// call to a third-party host goes through the same squid ProxyAgent... New callers (the market
// venues, readability, Entur) should say createProxyFetch". This helper follows that instruction:
// `fetch` is an injectable dependency (tests inject a fake one), defaulting to `createProxyFetch()`
// built LAZILY inside the closure on first real use — never at module scope, so `eve build`
// (which evaluates every module with no environment present) constructs no `ProxyAgent` — and
// never by installing a global undici dispatcher the way `./slack-dispatcher.ts` does. That
// pattern exists only because eve gives Slack no per-call fetch seam; its own header says a
// blanket proxy would capture unrelated (gateway/model) traffic, which this helper must not risk
// either. This module never touches `setGlobalDispatcher`.
//
// RETRY SAFETY — A REQUEST IS RETRIED ONLY WHEN IT IS SAFE TO REPEAT.
// A lost response to a request that already succeeded server-side — the vendor received it, but
// the reply never arrived (a timeout, a dropped connection, a transient 503) — means a second
// attempt sends the SAME request again. For a GET that costs nothing; for a POST that creates or
// sends something, it means a duplicate email, a duplicate charge, a duplicate record. So GET and
// HEAD are retried by default (and so is a call with no method given at all, since `fetch` itself
// defaults to GET); POST, PUT, PATCH, DELETE and anything else default to NOT retried — one
// attempt, whatever the failure, including a 429 or a 5xx. A caller that knows a specific
// non-GET call is safe to repeat — because it carries its own idempotency key, say — opts in
// explicitly with `idempotent: true`; a caller that wants to forbid retries on an otherwise-safe
// GET can pass `idempotent: false`. Either way, the `RequestError` thrown still carries its
// `kind` and `retryAfterSeconds`, so the CALLER can decide what to do next — surface it, ask the
// owner, or retry itself once it has a fresh idempotency key.

import { createProxyFetch } from "./telegram-fetch.js";
import { RequestError, isRetryable, kindForStatus, retryAfterSeconds } from "./request-error.js";

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 8000;
/** How much of a response body `peekBody` reads, for the 403 plan-word split `kindForStatus`
 *  does. Never more, and never put in an error message — a vendor's error page can be
 *  arbitrarily large and this is classification input, not data. */
const PEEK_BODY_BYTES = 2048;

/** Methods safe to repeat by construction: GET and HEAD never create or send anything, and a
 *  call with no method given is a GET too (`fetch`'s own default). Everything else — POST, PUT,
 *  PATCH, DELETE, anything unrecognised — defaults to NOT idempotent. See the module header. */
const IDEMPOTENT_METHODS_BY_DEFAULT = new Set(["GET", "HEAD"]);

/** Shared by this module and by anyone else reasoning about whether a call is safe to retry. */
export function isIdempotentByDefault(method: string | undefined): boolean {
  if (method === undefined) return true;
  return IDEMPOTENT_METHODS_BY_DEFAULT.has(method.toUpperCase());
}

export interface RequestConfig {
  /** The integration id that goes on every RequestError. */
  integration: string;
  /** Defaults to the sealed-proxy fetch, built lazily on first use. Injected in tests. */
  fetch?: typeof globalThis.fetch;
  /** Per-attempt, not per-call. Default 8000 — the value currency.ts and entur-client.ts both chose. */
  timeoutMs?: number;
  /** Total attempts including the first. Default 3. `1` disables retrying. */
  attempts?: number;
  /** First backoff, doubled per attempt, then jittered. Default 250. */
  backoffMs?: number;
  /** Ceiling on one backoff. Default 8000. */
  maxBackoffMs?: number;
  /** Injected for the test. Defaults to Math.random and a real timer. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Composed with the per-attempt timeout via AbortSignal.any, as entur-client.ts:487 does. */
  signal?: AbortSignal;
  /** Statuses this call treats as a normal answer rather than an error (e.g. 404 for a lookup). */
  expect?: readonly number[];
  /** Whether THIS call is safe to retry. Defaults to `isIdempotentByDefault(method)` — see the
   *  module header's retry-safety rule. Pass `true` on a non-GET call known to be safe to repeat
   *  (it carries its own idempotency key); pass `false` to forbid retries on an otherwise-safe
   *  GET. */
  idempotent?: boolean;
}

export interface Requester {
  /** Throws RequestError; returns the parsed JSON otherwise. */
  json<T>(url: string, opts?: RequestOptions): Promise<T>;
  /** The raw Response, for callers that need headers or a non-JSON body. Same error rules. */
  raw(url: string, opts?: RequestOptions): Promise<Response>;
}

/** Standard `Math.round` breaks an exact tie upward (0.5 → 1), which biases a symmetric ±25%
 *  jitter band away from center at the exact midpoint. Rounding the tie to the nearest EVEN
 *  integer instead keeps the schedule honestly centred — this is what `backoffFor`'s own test
 *  pins (`random() → 0` gives 188, `random() → 1` gives 312, not 187/313). */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Exported for the test and for anyone reasoning about the schedule. Pure. Doubles per attempt,
 *  jitters within ±25%, then clamps to the ceiling a SECOND time — the jitter multiplier can
 *  push a value that was already at the ceiling above it. */
export function backoffFor(
  attempt: number,
  cfg: { backoffMs: number; maxBackoffMs: number; random: () => number },
): number {
  const base = Math.min(cfg.backoffMs * 2 ** (attempt - 1), cfg.maxBackoffMs);
  const jittered = base * (0.75 + cfg.random() * 0.5);
  return Math.min(roundHalfEven(jittered), cfg.maxBackoffMs);
}

/** Reads at most PEEK_BODY_BYTES of the response body, for the 403 plan-word split only. Never
 *  throws — a body-read failure must never become the error the caller sees. */
async function peekBody(res: Response): Promise<string | undefined> {
  try {
    const text = await res.clone().text();
    return text.slice(0, PEEK_BODY_BYTES);
  } catch {
    return undefined;
  }
}

export function makeRequester(config: RequestConfig): Requester {
  const integration = config.integration;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = config.attempts ?? DEFAULT_ATTEMPTS;
  const backoffMs = config.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxBackoffMs = config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const random = config.random ?? Math.random;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Built lazily, on first real use, never at module scope — see the header.
  let lazyDefaultFetch: typeof globalThis.fetch | undefined;
  function fetchFn(): typeof globalThis.fetch {
    if (config.fetch) return config.fetch;
    lazyDefaultFetch ??= createProxyFetch();
    return lazyDefaultFetch;
  }

  async function raw(url: string, opts?: RequestOptions): Promise<Response> {
    const idempotent = opts?.idempotent ?? isIdempotentByDefault(opts?.method);

    for (let attempt = 1; ; attempt++) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = opts?.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;

      let res: Response;
      try {
        res = await fetchFn()(url, {
          method: opts?.method,
          headers: opts?.headers,
          body: opts?.body,
          signal,
        });
      } catch (err) {
        // The caller's own cancellation is never reported as a vendor outage, and it is never
        // retried — the caller asked to stop.
        if (opts?.signal?.aborted) throw err;
        const canRetry = idempotent && attempt < attempts;
        if (canRetry) {
          await sleep(backoffFor(attempt, { backoffMs, maxBackoffMs, random }));
          continue;
        }
        // A TypeError (network failure) or a timeout AbortError, neither with a response to
        // classify — both are "down".
        throw new RequestError("down", `${integration}: request failed`, { integration, cause: err });
      }

      // A test's fake fetch can ignore the signal it was handed; a real one would already have
      // rejected above. Either way, a caller that cancelled must never see a false success.
      if (opts?.signal?.aborted) {
        throw opts.signal.reason ?? new DOMException("the caller's request was aborted", "AbortError");
      }

      if (opts?.expect?.includes(res.status)) return res;

      const body = await peekBody(res);
      const kind = kindForStatus(res.status, body);

      if (kind === undefined) {
        if (res.status >= 400) {
          // An unmapped 4xx is the caller's mistake, not a transient fault — never retried,
          // whatever `idempotent` says.
          throw new RequestError("down", `${integration}: request failed`, { integration, status: res.status });
        }
        return res;
      }

      const retryAfter =
        kind === "rate_limited" ? retryAfterSeconds(res.headers.get("Retry-After"), new Date()) : undefined;
      const err = new RequestError(kind, `${integration}: request failed`, {
        integration,
        status: res.status,
        retryAfterSeconds: retryAfter,
      });

      const canRetry = isRetryable(err) && idempotent && attempt < attempts;
      if (canRetry) {
        const waitMs =
          retryAfter !== undefined ? retryAfter * 1000 : backoffFor(attempt, { backoffMs, maxBackoffMs, random });
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }

  async function json<T>(url: string, opts?: RequestOptions): Promise<T> {
    const res = await raw(url, opts);
    try {
      return (await res.json()) as T;
    } catch (err) {
      // Not retried: a vendor that returns HTML for a JSON endpoint will do it again.
      throw new RequestError("down", `${integration}: response was not valid JSON`, {
        integration,
        status: res.status,
        cause: err,
      });
    }
  }

  return { json, raw };
}

// PAGINATION. A bounded generator over pages. Each page is fetched through the requester
// above; retries happen only if the method is GET (the default for `first()` and `next()`
// — pagination is querying a list, not mutating). A guard against a cursor that never
// changes stops infinite loops that would otherwise burn the owner's quota.

export interface PageSpec<TPage, TItem> {
  /** The first request. */
  first: () => Promise<TPage>;
  /** The next request, or undefined when the page says there is no next one. */
  next: (page: TPage) => (() => Promise<TPage>) | undefined;
  items: (page: TPage) => readonly TItem[];
  /** Hard ceiling, so a vendor whose cursor never terminates cannot loop forever. Default 50. */
  maxPages?: number;
}

/** Yields items lazily, page by page. Throws `RequestError` from whatever `first`/`next` throw. */
export async function* paginate<TPage, TItem>(spec: PageSpec<TPage, TItem>): AsyncGenerator<TItem> {
  const maxPages = spec.maxPages ?? 50;
  let page = await spec.first();
  let pageCount = 1;

  // Guard against a cursor that never changes: if the page has a cursor field and it doesn't
  // advance, a vendor bug could loop forever. Track the last cursor to detect this.
  let lastCursor: unknown = (page as Record<string, unknown>).cursor;

  while (true) {
    yield* spec.items(page);

    if (pageCount >= maxPages) {
      console.warn(`paginate: reached page limit of ${maxPages}`);
      break;
    }

    const nextFn = spec.next(page);
    if (!nextFn) break;

    page = await nextFn();
    pageCount++;

    // Guard: detect when the cursor hasn't changed, which would loop forever.
    const cursor = (page as Record<string, unknown>).cursor;
    if (cursor !== undefined && cursor === lastCursor) {
      console.warn(`paginate: the vendor's cursor did not advance — stopping after ${pageCount} page(s)`);
      break;
    }
    lastCursor = cursor;
  }
}

/** The whole thing as an array, with the same ceiling. For callers that want it all. */
export async function collect<TPage, TItem>(spec: PageSpec<TPage, TItem>): Promise<TItem[]> {
  const out: TItem[] = [];
  for await (const x of paginate(spec)) out.push(x);
  return out;
}
