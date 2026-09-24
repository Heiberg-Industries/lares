/**
 * tests/live/frankfurter.live.mts — the LIVE probe for `../../lib/currency.ts` (W3C-s6).
 *
 * NOT part of `pnpm test`, and NOT run by whoever built this slice — the repo rule (root
 * CLAUDE.md): "A fixture is what we believe an API does. Only a live call is what it does. Any
 * branch on a third-party response ships with a committed live probe, run by hand." Run it by
 * hand, from the box (or anywhere the sealed squid proxy this probe goes through is reachable),
 * whenever `FrankfurterResponse`'s shape is next in doubt or `lib/currency.ts` changes:
 *
 *     npx tsx services/travel/tests/live/frankfurter.live.mts
 *
 * No key, no environment variable, no cost — Frankfurter is free and keyless.
 *
 * WHY THIS FILE EXISTS. `lib/currency.ts` moved onto the shared request helper
 * (`@lares/agent-kit/request`) in W3C-s6 — the first (and, this wave, the only) existing client
 * to do so. Every other test of that migration uses a stubbed `fetch`, which proves the RETRY /
 * TIMEOUT / ERROR-MAPPING plumbing but proves nothing about the vendor itself. This script is
 * what actually asks two things a fixture cannot answer:
 *   1. Is `FrankfurterResponse` (`amount`, `base`, `date`, `rates: Record<string, number>`)
 *      still what `GET /v1/latest?base=EUR&symbols=NOK` returns?
 *   2. Does the shared helper's DEFAULT fetch — `createProxyFetch()`, the sealed squid egress
 *      every agent's outbound call is meant to converge on — actually reach the outside world?
 *      No `fetch` is injected below; that is the point.
 *
 * Exit code is 0 only when the response is HTTP 200, `rates.NOK` is a finite number, and `date`
 * parses as a real date. Anything else — a network failure, a shape change, a non-200 — is a
 * failure, printed plainly, never papered over.
 *
 * LAST RUN: not yet run. This header will carry the date, the HTTP status, the observed
 * `rates.NOK` value and elapsed time the first time someone runs this by hand — do not fill
 * this in from a guess.
 */
import { createProxyFetch } from "@lares/agent-kit/telegram-fetch";

const ENDPOINT = "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=NOK";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

console.log(`=== GET ${ENDPOINT} (through the sealed proxy fetch, no key) ===`);

const fetchFn = createProxyFetch();
const startedAt = Date.now();

let res: Response;
try {
  res = await fetchFn(ENDPOINT);
} catch (err) {
  fail(`network error reaching Frankfurter through the proxy: ${(err as Error).message}`);
}

const elapsedMs = Date.now() - startedAt;
console.log(`  status=${res.status} elapsed=${elapsedMs}ms`);

if (res.status !== 200) {
  fail(`expected HTTP 200, got ${res.status}`);
}

let body: unknown;
try {
  body = await res.json();
} catch (err) {
  fail(`response body was not valid JSON: ${(err as Error).message}`);
}

console.log(`  body: ${JSON.stringify(body)}`);

if (typeof body !== "object" || body === null) {
  fail("response body was not a JSON object");
}

const rec = body as Record<string, unknown>;
const rates = rec["rates"];
const date = rec["date"];

if (typeof rates !== "object" || rates === null) {
  fail(`expected a "rates" object, got ${JSON.stringify(rates)}`);
}
const rateNok = (rates as Record<string, unknown>)["NOK"];
if (typeof rateNok !== "number" || !Number.isFinite(rateNok)) {
  fail(`expected a finite "rates.NOK" number, got ${JSON.stringify(rateNok)}`);
}

if (typeof date !== "string" || Number.isNaN(new Date(date).getTime())) {
  fail(`expected an ISO "date" string, got ${JSON.stringify(date)}`);
}

console.log(`  rates.NOK=${rateNok} date=${date}`);
console.log("\n=== PASS ===");
console.log(
  "Update this file's header LAST RUN line with today's date, the status above, the observed " +
    "rates.NOK value and the elapsed time.",
);
process.exit(0);
