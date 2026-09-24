/**
 * tests/live/markets.live.mts — the LIVE sweep for Tyche's three market-feed venue clients
 * (ORB-189 Task 4): kalshi-client.ts, polymarket-gamma-client.ts, polymarket-clob-client.ts.
 *
 * NOT part of `pnpm test`, and deliberately so — it calls three real third-party APIs (all
 * public, no auth, per each client's own header comment). Run it by hand from the repo root
 * whenever a market client's parsing changes what it assumes a response looks like:
 *
 *     pnpm exec tsx packages/agent-kit/tests/live/markets.live.mts
 *     pnpm exec tsx packages/agent-kit/tests/live/markets.live.mts --kalshi-event KXNEWPOPE-70 --pm-slug world-cup-winner --big-events 3
 *     pnpm exec tsx packages/agent-kit/tests/live/markets.live.mts --refresh-dry-run 20
 *
 * Both `--kalshi-event <ticker>` and `--pm-slug <slug>` are optional (also settable via
 * MARKETS_LIVE_KALSHI_EVENT / MARKETS_LIVE_PM_SLUG). Omitted, each venue falls back to a
 * live-discovered sample (Kalshi: the newest market off a bare listing; Polymarket: the
 * highest-24h-volume active event). Given, the SAME field checks run against that exact
 * ticker/slug instead, and the matching fixture(s) under tests/fixtures/ are printed beside the
 * live shape — this is how the specific comparisons behind tests/fixtures/README.md's verdicts
 * are reproduced, rather than living only in an ad hoc, uncommitted session.
 *
 * WHY THIS FILE EXISTS. The five fixtures under tests/fixtures/{kalshi,polymarket}/*.json
 * carried no provenance note — nobody who ported Tyche's engine into the kit (Tasks 1-3) had
 * confirmed, against the live APIs, that those fixtures still describe what Kalshi and
 * Polymarket actually return. Per the root CLAUDE.md's Third-party APIs rule: "a fixture is
 * what we believe an API does; only a live call is what it does." The vitest suite can only
 * ever re-confirm the shapes the fixtures were given; this file is what actually asks the
 * three APIs.
 *
 * WHAT THIS CHECKS, and why a fixture can't. Each parser (kalshi-parse.ts, polymarket-parse.ts)
 * encodes a belief about field NAMES and TYPES it never got to test against a live response:
 *   - Kalshi: prices ride as DOLLAR-STRINGS in 0..1 under a `_dollars` suffix (yes_ask_dollars,
 *     yes_bid_dollars, last_price_dollars, liquidity_dollars) — kalshi-parse.ts's own comment
 *     states this plainly ("Number() them, no /100"). Kalshi's API has also served plain
 *     integer-cents fields (yes_ask, yes_bid, 0..100) for the same concept; if the live API
 *     stopped sending the `_dollars` fields, `ask ?? last ?? 0` would silently price a market
 *     at zero rather than throwing.
 *   - Polymarket Gamma: `outcomePrices` and `clobTokenIds` are JSON-STRINGS to be JSON.parse()'d,
 *     not already-parsed arrays (polymarket-parse.ts's own comment). `GammaEvent.endDate` and
 *     `GammaMarket.endDateIso` are two DIFFERENT, both-real fields on two different object
 *     shapes — confirmed live, not assumed (see Sweep 2's header note for why this sweep tests
 *     the EVENT shape specifically, since that is the one the shipped code reads).
 *   - Polymarket CLOB: polymarket-clob-client.ts calls `POST /prices` with a batched
 *     `[{token_id, side}]` body and reads back `{ [token_id]: { SELL, BUY } }`. This task's own
 *     brief describes a DIFFERENT endpoint — `GET /book?token_id=<id>` with `asks[0].price` /
 *     `bids` fields — which is Polymarket's order-book endpoint, not the one the shipped Task 1
 *     client calls. tests/fixtures/polymarket/clob-prices-sell.json is shaped exactly like a
 *     `/prices` response (`{tok-id: {SELL: "0.14"}}`), confirming the fixture and the shipped
 *     client agree with each other and diverge from the brief. Sweep 3 below tests `/prices` —
 *     the endpoint the kit actually depends on — not `/book`, which nothing in the kit calls.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHECK. `polymarket-gamma-client.ts` also exposes
 * `listMarkets()`/`listTopByLiquidity()`, and `polymarket-parse.ts` exports `parseBinaryMarket`
 * for a standalone (non-event) Gamma market. Grepped 2026-09-03: neither has a caller anywhere
 * in this package's shipped wiring — `index.ts`'s `makeMarkets()` only ever builds
 * `getPmEvent: (slug) => gamma.getEvent(slug)` (venue-quotes.ts:31,44), feeding `parseEvent`,
 * never `parseBinaryMarket`. `listMarkets`/`parseBinaryMarket` are only exercised by this
 * package's own unit tests and by the RETIRED `services/agent-runtime/bin/tyche.ts` binary
 * (index.ts's own header: "the agent is retired; the engine is a capability Saga carries"). An
 * earlier version of this sweep tested that pair; it was dropped rather than kept, because
 * validating an endpoint+parser combination nothing in the shipped path calls would have given
 * false confidence about the wrong contract — exactly what CLAUDE.md's fixture rule warns
 * against. If `listMarkets`/`parseBinaryMarket` ever gain a real caller, add a sweep for them
 * then, against whatever query that caller actually uses.
 *
 * BOTH DIRECTIONS, per CLAUDE.md. For every field a parser reads: (a) the field is PRESENT with
 * the type/shape the parser expects — a silent absence or a silently-tolerated wrong type (e.g.
 * a legacy cents integer where a 0..1 dollar-string is expected) is the leak, because nothing
 * throws, a price just quietly becomes wrong; (b) an unexpected EXTRA shape (a field the code
 * doesn't know about, a wrapper the parser doesn't unwrap) is printed, never hidden — every
 * sample response's full key list and a trimmed dump are logged even where every check passes.
 *
 * Exit code is 0 only when every venue answered 2xx and every field a parser reads was present
 * with the expected type. Any non-2xx, any missing/mis-shaped required field, or an unreachable
 * venue is a non-zero exit — network failures print BLOCKED, never a faked pass. Pointing
 * `--kalshi-event`/`--pm-slug` at a ticker/slug that no longer exists is EXPECTED to print
 * BLOCKED (a 404 or empty result) — that is itself the reproduction of a "gone" fixture verdict,
 * not a bug in the probe.
 *
 * Uses the injected-fetch style the kit's clients require (kalshi-client.ts's header comment
 * explains why `fetch` has no default: Node's built-in fetch ignores proxy env vars, so an
 * un-injected client can silently hang on the box's sealed egress). `globalThis.fetch` is the
 * correct injected value from the Mac; on the box it would be the egress-proxy fetch instead.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeKalshiClient } from "../../src/markets/kalshi-client.js";
import { parseKalshiEvent } from "../../src/markets/kalshi-parse.js";
import { makeGammaClient } from "../../src/markets/polymarket-gamma-client.js";
import { makeClobClient } from "../../src/markets/polymarket-clob-client.js";
import { parseEvent, type GammaEvent } from "../../src/markets/polymarket-parse.js";
import { makePolymarketProducer } from "../../src/markets/polymarket-producer.js";
import { normalizeSource } from "../../src/markets/probability/engine.js";
import type { RefreshReport } from "../../src/markets/refresh.js";
import type { Pool } from "pg";

const doFetch = globalThis.fetch;
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

let failed = false;

function report(ok: boolean, label: string): void {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}`);
  if (!ok) failed = true;
}

function info(label: string): void {
  console.log(`  [info] ${label}`);
}

function blocked(label: string): void {
  console.log(`  [BLOCKED] ${label}`);
  failed = true;
}

/** `--flag value` if present in argv, else the named env var, else undefined. */
function argOrEnv(flag: string, envVar: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const fromEnv = process.env[envVar];
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/** Prints any fixture under tests/fixtures/<subdir>/ whose raw text mentions `needle` (a ticker
 *  or slug) — the "beside the fixture's" comparison the committed script can reproduce, instead
 *  of an ad hoc read done once outside it. */
function printMatchingFixtures(subdir: string, needle: string): void {
  const dir = join(FIXTURES_DIR, subdir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch (e) {
    info(`could not list fixtures/${subdir}/: ${(e as Error).message}`);
    return;
  }
  const matches = names.filter((n) => {
    try {
      return readFileSync(join(dir, n), "utf8").includes(needle);
    } catch {
      return false;
    }
  });
  if (matches.length === 0) {
    info(`no fixture under fixtures/${subdir}/ mentions "${needle}" — nothing to print beside it`);
    return;
  }
  for (const n of matches) {
    console.log(`  --- fixtures/${subdir}/${n} (matches "${needle}") ---`);
    for (const line of readFileSync(join(dir, n), "utf8").trimEnd().split("\n")) console.log(`  ${line}`);
  }
}

/**
 * A Kalshi price field: REQUIRED fields (yes_ask_dollars, per the KalshiMarket type) fail hard
 * if absent; optional siblings (yes_bid_dollars, last_price_dollars, liquidity_dollars) only
 * fail if PRESENT with the wrong shape — absence alone is not a defect for those, since
 * kalshi-parse.ts falls back past them (`ask ?? last ?? 0`). Every present field is checked for
 * being a dollar-string that parses to a finite number in 0..1 — the "both directions" catch
 * for a legacy cents-integer value (e.g. "51" instead of "0.51") sliding through unnoticed.
 */
function checkKalshiDollarField(v: unknown, name: string, required: boolean): void {
  if (v === undefined) {
    if (required) report(false, `${name} is present (required by the KalshiMarket type)`);
    else info(`${name} absent on this sample (optional in the type — not a failure on its own)`);
    return;
  }
  if (typeof v !== "string") {
    report(false, `${name} is a dollar-STRING (got ${typeof v}: ${JSON.stringify(v)})`);
    return;
  }
  const n = Number(v);
  report(Number.isFinite(n), `${name}="${v}" parses to a finite number`);
  if (Number.isFinite(n)) {
    report(n >= 0 && n <= 1, `${name}=${v} → ${n} is in the 0..1 dollar range kalshi-parse.ts assumes (not 0..100 cents)`);
  }
}

/**
 * Sweep 1 — Kalshi GET /trade-api/v2/markets?limit=1, then the real client path.
 *
 * kalshi-client.ts exposes listEvents/listEventsPage/listMarketsForEvent/getEvent — none hit
 * the bare, un-scoped /markets listing this sweep needs for a first sample, so that first call
 * is raw, against the SAME base URL kalshi-client.ts defaults to (grepped 2026-09-03:
 * `https://api.elections.kalshi.com/trade-api/v2` — kept in sync by hand with that file's
 * `baseUrl` default).
 *
 * `eventTickerArg` (from --kalshi-event / MARKETS_LIVE_KALSHI_EVENT) overrides which ticker the
 * real production path — getEvent + listMarketsForEvent + parseKalshiEvent, exactly what
 * venue-quotes.ts calls — is exercised against. Unset, it uses whatever ticker the bare sample
 * above happened to surface (which in practice tends to be a brand-new, zero-priced
 * multi-variate combinator market — see tests/fixtures/README.md's note on this).
 */
async function sweepKalshi(eventTickerArg?: string): Promise<void> {
  const base = "https://api.elections.kalshi.com/trade-api/v2";
  const url = `${base}/markets?limit=1`;
  console.log(`  GET ${url}`);
  let harvestedTicker: string | undefined;
  let res: Awaited<ReturnType<typeof doFetch>>;
  try {
    res = await doFetch(url);
  } catch (err) {
    blocked(`network error reaching Kalshi: ${(err as Error).message}`);
    res = undefined as unknown as Awaited<ReturnType<typeof doFetch>>;
  }
  if (res) {
    console.log(`  status=${res.status}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      blocked(`non-2xx: ${res.status} ${res.statusText} — body: ${body.slice(0, 500)}`);
    } else {
      const json = (await res.json()) as unknown;
      const topKeys = json && typeof json === "object" ? Object.keys(json as object) : [];
      console.log(`  top-level keys: [${topKeys.join(", ")}]`);

      const asObj = json as Record<string, unknown>;
      const markets = Array.isArray(asObj?.markets) ? (asObj.markets as Record<string, unknown>[]) : Array.isArray(json) ? (json as Record<string, unknown>[]) : null;
      report(markets !== null, "response has a markets array (either {markets:[...]} or a bare array)");
      const m = markets?.[0];
      if (!m) {
        report(false, "at least one market returned");
      } else {
        console.log(`  sample market keys: [${Object.keys(m).join(", ")}]`);
        console.log(`  sample market (trimmed): ${JSON.stringify(m).slice(0, 800)}`);

        report(typeof m.ticker === "string" && m.ticker.length > 0, "ticker is a non-empty string");
        report(typeof m.event_ticker === "string" && (m.event_ticker as string).length > 0, "event_ticker is a non-empty string");
        report(typeof m.title === "string" && (m.title as string).length > 0, "title is a non-empty string");

        if (m.yes_sub_title !== undefined) {
          report(typeof m.yes_sub_title === "string", `yes_sub_title is a string when present (kalshi-parse.ts's fallback calls .trim() on it with no type guard) — got ${typeof m.yes_sub_title}: ${JSON.stringify(m.yes_sub_title).slice(0, 100)}`);
        } else {
          info("yes_sub_title absent — parseKalshiEvent falls back to title.trim(), not a failure on its own");
        }

        checkKalshiDollarField(m.yes_ask_dollars, "yes_ask_dollars", true);
        checkKalshiDollarField(m.yes_bid_dollars, "yes_bid_dollars", false);
        checkKalshiDollarField(m.last_price_dollars, "last_price_dollars", false);
        checkKalshiDollarField(m.liquidity_dollars, "liquidity_dollars", false);
        report(typeof m.close_time === "string" && !Number.isNaN(Date.parse(m.close_time as string)), "close_time is a parseable date string");

        // Both directions: a legacy integer-cents field would be the OTHER shape this sweep
        // exists to catch — report it plainly whether or not the _dollars field is also present.
        if (typeof m.yes_ask === "number") {
          info(`legacy integer-cents field yes_ask ALSO present: ${m.yes_ask} (kalshi-parse.ts does not read this — only the _dollars field)`);
        }

        harvestedTicker = typeof m.event_ticker === "string" ? m.event_ticker : undefined;
      }
    }
  }

  const eventTicker = eventTickerArg ?? harvestedTicker;
  console.log(
    eventTickerArg
      ? `  using explicit --kalshi-event ${eventTickerArg} (harvested ticker from the sample above was ${harvestedTicker ?? "none"})`
      : `  no --kalshi-event given; using the harvested ticker ${harvestedTicker ?? "none"}`,
  );
  if (!eventTicker) {
    blocked("no event ticker available (neither --kalshi-event nor the sample above) — cannot exercise getEvent/listMarketsForEvent/parseKalshiEvent");
    return;
  }
  try {
    const kalshi = makeKalshiClient({ fetch: doFetch });
    const event = await kalshi.getEvent(eventTicker);
    const eventMarkets = await kalshi.listMarketsForEvent(eventTicker);
    const spec = parseKalshiEvent(event, eventMarkets);
    report(spec.outcomes.length > 0, `real client path (getEvent + listMarketsForEvent + parseKalshiEvent for ${eventTicker}) produces >=1 outcome`);
    info(`parsed MarketSpec: question="${spec.question}" outcomes=${spec.outcomes.length} liquidity=${spec.liquidity}`);
  } catch (err) {
    report(false, `real client path (getEvent+listMarketsForEvent+parseKalshiEvent) for ${eventTicker} threw: ${(err as Error).message}`);
  }
  printMatchingFixtures("kalshi", eventTicker);
}

/**
 * Sweep 2 — Polymarket Gamma GET /events?slug=<slug> → parseEvent. THIS is the shipped path:
 * venue-quotes.ts's `getPmEvent: (slug) => gamma.getEvent(slug)` feeds `parseEvent(events[0])`
 * directly (index.ts wires it this way; read.ts's marketState calls it through liveQuotes.get).
 * A prior version of this sweep tested `listMarkets()` + `parseBinaryMarket()` instead — that
 * pair has no caller anywhere in the shipped `makeMarkets()` wiring, only in this package's own
 * tests and the RETIRED `services/agent-runtime/bin/tyche.ts` binary (grepped 2026-09-03) — so
 * it validated a contract nothing here depends on and was dropped rather than kept; see the
 * file header for the full reasoning.
 *
 * `slugArg` (from --pm-slug / MARKETS_LIVE_PM_SLUG) overrides which event getEvent+parseEvent
 * runs against. Unset, one is discovered via `listEvents` — the SAME `/events` resource, just
 * queried differently (also the resource `discoverCandidateEvents` in polymarket-producer.ts
 * would use, even though that helper has no caller yet either) — filtered to the
 * highest-24h-volume active event, so the CLOB sweep below gets a token with real liquidity
 * rather than a fresh/dead one.
 *
 * Checks the bare-array-vs-wrapper question for /events, every event-level field parseEvent
 * reads (title, slug, markets[], negRisk, endDate), and — aggregated across every sub-market,
 * since parseEvent tolerates some sub-markets failing — every sub-market field it reads
 * (question, groupItemTitle, outcomePrices, clobTokenIds, liquidityNum).
 *
 * Returns EVERY outcome's token id, harvested from parseEvent's OWN parsed output
 * (spec.outcomes.map(o => o.tokenId)) — the exact same source and shape
 * polymarket-producer.ts's estimate() batches into one fetchAsks(...) call, not a hand-rolled
 * re-parse of the raw JSON, and not just the first one (a single pick turned out to be flaky —
 * see sweepClob's header note on why the CLOB check is a batch, not a single token).
 */
async function sweepGamma(slugArg?: string): Promise<string[]> {
  const gamma = makeGammaClient({ fetch: doFetch });

  let slug = slugArg;
  if (!slug) {
    const discoveryQuery = "closed=false&active=true&limit=1&order=volume24hr&ascending=false";
    console.log(`  no --pm-slug given; discovering one via GET https://gamma-api.polymarket.com/events?${discoveryQuery}`);
    let discovered: GammaEvent[];
    try {
      discovered = await gamma.listEvents(discoveryQuery);
    } catch (err) {
      blocked(`gamma /events discovery failed: ${(err as Error).message}`);
      return [];
    }
    slug = discovered[0]?.slug;
    if (!slug) {
      blocked("discovery returned no active events to pick a slug from");
      return [];
    }
    info(`discovered slug: ${slug}`);
  } else {
    console.log(`  using explicit --pm-slug ${slug}`);
  }

  console.log(`  GET https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
  let events: GammaEvent[];
  try {
    events = await gamma.getEvent(slug);
  } catch (err) {
    blocked(`gamma getEvent(${slug}) failed: ${(err as Error).message}`);
    return [];
  }

  report(Array.isArray(events), "getEvent(...) response is a bare JSON array (GammaEvent[]) — no {events:[...]} wrapper");
  const e = Array.isArray(events) ? events[0] : undefined;
  if (!e) {
    report(false, `at least one event returned for slug "${slug}"`);
    printMatchingFixtures("polymarket", slug);
    return [];
  }

  const eObj = e as unknown as Record<string, unknown>;
  console.log(`  event top-level keys: [${Object.keys(eObj).join(", ")}]`);
  console.log(`  event (trimmed, markets omitted): ${JSON.stringify({ ...eObj, markets: `[${Array.isArray(eObj.markets) ? (eObj.markets as unknown[]).length : 0} sub-markets]` }).slice(0, 600)}`);

  report(typeof eObj.title === "string" && (eObj.title as string).length > 0, "title is a non-empty string (parseEvent calls .trim() on it)");
  report(typeof eObj.slug === "string" && (eObj.slug as string).length > 0, "slug is a non-empty string (used as marketId)");

  if (eObj.negRisk !== undefined) report(typeof eObj.negRisk === "boolean", `negRisk is a boolean when present (got ${typeof eObj.negRisk})`);
  else info("negRisk absent on this event — parseEvent treats absent as mutuallyExclusive:false (=== true comparison)");

  if (eObj.endDate !== undefined) report(typeof eObj.endDate === "string", `endDate is a string when present (got ${typeof eObj.endDate})`);
  else info("endDate absent on this event — parseEvent's endDateIso becomes undefined, not a failure on its own");

  const subMarkets = Array.isArray(eObj.markets) ? (eObj.markets as Record<string, unknown>[]) : [];
  report(subMarkets.length > 0, `markets[] is a non-empty array (got ${subMarkets.length} sub-markets)`);

  let questionOk = 0, groupItemTitleOk = 0, outcomePricesOk = 0, clobTokenIdsOk = 0, liquidityNumPresent = 0;
  let sampleWithTokens: Record<string, unknown> | undefined;
  for (const sm of subMarkets) {
    if (typeof sm.question === "string") questionOk++;
    if (typeof sm.groupItemTitle === "string") groupItemTitleOk++;
    if (typeof sm.liquidityNum === "number") liquidityNumPresent++;
    if (typeof sm.outcomePrices === "string") {
      try {
        if (Array.isArray(JSON.parse(sm.outcomePrices))) outcomePricesOk++;
      } catch { /* counted as not-ok below via the aggregate */ }
    }
    if (typeof sm.clobTokenIds === "string") {
      try {
        const t = JSON.parse(sm.clobTokenIds);
        if (Array.isArray(t) && t.length > 0 && typeof t[0] === "string") {
          clobTokenIdsOk++;
          if (!sampleWithTokens) sampleWithTokens = sm;
        }
      } catch { /* counted as not-ok below via the aggregate */ }
    }
  }
  console.log(`  field coverage across ${subMarkets.length} sub-markets: question=${questionOk} groupItemTitle=${groupItemTitleOk} outcomePrices(JSON-array)=${outcomePricesOk} clobTokenIds(JSON-array)=${clobTokenIdsOk} liquidityNum=${liquidityNumPresent}`);
  report(questionOk > 0, `question is a string on >=1 sub-market (parseEvent's groupItemTitle-absent fallback calls .trim() on it)`);
  report(outcomePricesOk > 0, "outcomePrices is a JSON-string array on >=1 sub-market");
  report(clobTokenIdsOk > 0, "clobTokenIds is a non-empty JSON-string array on >=1 sub-market");
  if (groupItemTitleOk < subMarkets.length) info(`groupItemTitle absent (or non-string) on ${subMarkets.length - groupItemTitleOk} sub-market(s) — optional, those fall back to question`);
  if (liquidityNumPresent < subMarkets.length) info(`liquidityNum absent on ${subMarkets.length - liquidityNumPresent} sub-market(s) — optional, parseEvent sums it treating absent as 0`);

  if (sampleWithTokens) {
    console.log(`  sample sub-market keys: [${Object.keys(sampleWithTokens).join(", ")}]`);
    console.log(`  sample sub-market (trimmed): ${JSON.stringify(sampleWithTokens).slice(0, 600)}`);
    const realConditionId = sampleWithTokens.conditionId;
    const realTokens = typeof sampleWithTokens.clobTokenIds === "string" ? JSON.parse(sampleWithTokens.clobTokenIds) : null;
    info(`concrete example of a real id shape — conditionId=${JSON.stringify(realConditionId)} clobTokenIds[0]=${JSON.stringify(realTokens?.[0])}`);
  }

  let harvestedTokenIds: string[] = [];
  try {
    const spec = parseEvent(e);
    report(spec.outcomes.length > 0, "parseEvent(...) — the shipped venue-quotes.ts path — produces >=1 outcome on the live event");
    info(`parsed MarketSpec: question="${spec.question}" outcomes=${spec.outcomes.length} liquidity=${spec.liquidity} mutuallyExclusive=${spec.mutuallyExclusive}`);
    harvestedTokenIds = spec.outcomes.map((o) => o.tokenId);
  } catch (err) {
    report(false, `parseEvent(...) threw on the live event: ${(err as Error).message}`);
  }

  printMatchingFixtures("polymarket", slug);
  return harvestedTokenIds;
}

/**
 * Sweep 3 — Polymarket CLOB. See the header note above: this task's brief describes
 * `GET /book?token_id=<id>` (`asks[0].price`/`bids`), but polymarket-clob-client.ts calls
 * `POST /prices` with a batched `[{token_id, side:"sell"}]` body and reads back
 * `{ [token_id]: { SELL, BUY } }` (fetchAsks reads only .SELL). This sweep tests /prices — the
 * endpoint the shipped client and its fixture actually depend on.
 *
 * Batched over EVERY token id Sweep 2 harvested, not just one — matching how
 * polymarket-producer.ts's estimate() actually calls fetchAsks(spec.outcomes.map(o =>
 * o.tokenId)). A first version of this sweep tested a single token (spec.outcomes[0]) and
 * turned out flaky: on a large bundled event (e.g. a multi-game esports series) the first
 * sub-market can easily be one whose endDate has already passed, so CLOB legitimately has no
 * live quote for it — fetchAsks's own doc comment calls this "best-effort... never throw on a
 * partial venue failure", i.e. the shipped code already expects some tokens in a batch to come
 * back empty. Asserting on ONE token treated that expected, normal case as a hard failure. This
 * sweep instead hard-fails only if NONE of the batch returns a usable price — a real contract
 * break — and reports partial coverage as informational, mirroring fetchAsks's own tolerance.
 */
async function sweepClob(tokenIds: string[]): Promise<void> {
  if (tokenIds.length === 0) {
    blocked("no token ids available from the Gamma sweep — cannot exercise CLOB");
    return;
  }
  const base = "https://clob.polymarket.com";
  const sampleIds = tokenIds.slice(0, 20); // keep the illustrative raw request modest in size
  console.log(`  POST ${base}/prices  body=[{token_id, side:"sell"}, ...] for ${sampleIds.length} of ${tokenIds.length} harvested token ids`);

  let res: Awaited<ReturnType<typeof doFetch>>;
  try {
    res = await doFetch(`${base}/prices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleIds.map((id) => ({ token_id: id, side: "sell" }))),
    });
  } catch (err) {
    blocked(`network error reaching Polymarket CLOB: ${(err as Error).message}`);
    return;
  }
  console.log(`  status=${res.status}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    blocked(`non-2xx: ${res.status} ${res.statusText} — body: ${body.slice(0, 500)}`);
    return;
  }

  const json = (await res.json()) as Record<string, unknown>;
  console.log(`  ${Object.keys(json).length} of ${sampleIds.length} requested ids appear as keys in the response`);
  console.log(`  response (trimmed): ${JSON.stringify(json).slice(0, 500)}`);

  let sellOk = 0;
  let buyAlsoPresent = 0;
  for (const id of sampleIds) {
    const sides = json[id] as { SELL?: unknown; BUY?: unknown } | undefined;
    if (!sides) continue;
    if (typeof sides.SELL === "string" && Number.isFinite(Number(sides.SELL))) sellOk++;
    if (sides.BUY !== undefined) buyAlsoPresent++;
  }
  report(sellOk > 0, `>=1 of ${sampleIds.length} requested token ids has a numeric-string SELL price — the only field fetchAsks reads (${sellOk}/${sampleIds.length} did)`);
  if (sellOk < sampleIds.length) {
    info(`${sampleIds.length - sellOk} of ${sampleIds.length} token ids returned no entry or a non-numeric SELL — expected for sub-markets not currently live-quoted (e.g. already concluded), not necessarily a defect`);
  }
  info(`BUY also present alongside SELL on ${buyAlsoPresent}/${sampleIds.length} (declared in PricesResponse, not read by fetchAsks either way)`);

  // Exercise the real production code path too, over ALL harvested ids (fetchAsks chunks
  // internally at its own default chunkSize=50) — it swallows failures silently (logs and
  // skips rather than throwing), so this is the only check that would catch a client-side
  // parse regression rather than just a raw-shape one.
  const clob = makeClobClient({ fetch: doFetch });
  const asks = await clob.fetchAsks(tokenIds);
  report(asks.size > 0, `makeClobClient(...).fetchAsks([...${tokenIds.length} ids]) — the real client — returns >=1 parsed price (${asks.size}/${tokenIds.length})`);
  if (asks.size > 0) {
    const sample = [...asks.entries()].slice(0, 3).map(([k, v]) => `${k.slice(0, 12)}…=${v}`).join(", ");
    info(`fetchAsks parsed ${asks.size}/${tokenIds.length} asks; sample: ${sample}`);
  }
}

/**
 * Sweep 4 (ORB-214 item 8) — the COUNTER-direction probe from the ORB-189 acceptance rounds,
 * committed so it outlives the session that wrote it (root CLAUDE.md, Third-party APIs rule 1).
 *
 * The round-4 fear was a "60-outcome collapse": that a big negRisk event would parse into many
 * outcomes but price only a handful, and the de-vig would then sum to nonsense. The diagnosis
 * that ruled it out — three open 128-sub-market events priced 43/51/52 outcomes, de-vigging
 * to 1.0000 — ran from a scratch script. This is that script: walk the N largest currently-OPEN
 * negRisk events (≥20 sub-markets, top-60 by liquidity), run the SHIPPED producer over each,
 * and report parsed-outcome count, priced-outcome count and the de-vig sum. Both directions:
 * a collapse shows as priced ≪ parsed; a broken de-vig shows as a sum far from 1.
 *
 * Opt-in (`--big-events <n>` / `MARKETS_LIVE_BIG_EVENTS`), because it costs one CLOB price
 * batch per event on top of the three sweeps above.
 */
async function sweepBigOpenEvents(n: number): Promise<void> {
  const gamma = makeGammaClient({ fetch: doFetch });
  const clob = makeClobClient({ fetch: doFetch });
  const producer = makePolymarketProducer({ clob });
  let top: GammaEvent[];
  try {
    top = (await gamma.listTopByLiquidity(60)) as GammaEvent[];
  } catch (err) {
    report(false, `listTopByLiquidity(60) threw: ${(err as Error).message}`);
    return;
  }
  const big = top
    .filter((e) => (e as { negRisk?: boolean }).negRisk === true && !(e as { closed?: boolean }).closed && (e.markets?.length ?? 0) >= 20)
    .sort((a, b) => (b.markets?.length ?? 0) - (a.markets?.length ?? 0));
  info(`open negRisk events with >=20 sub-markets among the top-60 by liquidity: ${big.length}`);
  if (big.length === 0) {
    report(false, "no open negRisk event with >=20 sub-markets among the top-60 — nothing to measure (not a code failure; re-run another day)");
    return;
  }
  for (const e of big.slice(0, n)) {
    const spec = parseEvent(e);
    const est = await producer.estimate(spec);
    const priced = Object.keys(est.raw).length;
    const norm = priced >= 2 ? normalizeSource(est) : null;
    const sumRaw = Object.values(est.raw).reduce((a: number, b) => a + Number(b), 0);
    const sumFair = norm ? Object.values(norm.fair).reduce((a: number, b) => a + Number(b), 0) : NaN;
    info(
      `${(e as { slug?: string }).slug ?? "(no slug)"}: submarkets=${e.markets?.length ?? 0} parsed=${spec.outcomes.length} ` +
        `unpricedAtParse=${spec.outcomes.filter((o) => o.unpriced).length} priced=${priced} ` +
        `sum(raw)=${sumRaw.toFixed(4)} sum(fair)=${Number.isNaN(sumFair) ? "n/a" : sumFair.toFixed(4)}`,
    );
    report(spec.outcomes.length >= 20, "parseEvent keeps every sub-market as an outcome on a big event (no parse-time collapse)");
    report(priced * 2 >= spec.outcomes.length, `the shipped producer prices at least half of the parsed outcomes (${priced}/${spec.outcomes.length}) — no 60-outcome collapse`);
    report(!Number.isNaN(sumFair) && Math.abs(sumFair - 1) < 0.01, `the de-vig over the priced book sums to 1 (${Number.isNaN(sumFair) ? "n/a" : sumFair.toFixed(4)})`);
  }
}

/**
 * Sweep 5 (opt-in): the SHIPPED watchlist refresh job (src/markets/refresh.ts, ORB-214 item 1)
 * against the live venues, with a FAKE store that only counts writes and never touches a
 * database. Discovery is a real `listTopByLiquidity(n)`; quoting is the real `marketState` live
 * path through the real Gamma/CLOB/Kalshi clients. Every write lands in memory.
 *
 * WHY IT IS A FAKE POOL rather than fake stores: it runs `makeMarketsRefresh(cfg)` itself, so
 * what is measured is the wiring that actually ships, not a hand-rolled copy of it in a probe.
 * The pool understands exactly the statements the three stores issue and THROWS on anything else
 * — a store whose SQL changed shape must fail this sweep loudly, never quietly return nothing.
 *
 * BOTH DIRECTIONS, per CLAUDE.md. The leak: discovery finds nothing, or the quoting loop skips
 * everything, and a nightly job silently writes zero rows for weeks. The over-rejection: a
 * market that IS quotable falls into `skipped` — so every skip reason is printed, not just
 * counted.
 */
async function sweepRefreshDryRun(n: number): Promise<void> {
  const { makeMarketsRefresh } = await import("../../src/markets/index.js");

  interface FakeRow { id: string; label: string; pm_market_id: string | null; market_type: string; end_date: string | null }
  const rows = new Map<string, FakeRow>();
  const writes = { upserts: 0, deletes: 0, snapshots: 0, edges: 0 };
  const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

  const fakePool = {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
      const q = norm(sql);
      if (q.startsWith("SELECT") && q.includes("FROM tyche_markets")) {
        return { rows: [...rows.values()] };
      }
      if (q.startsWith("INSERT INTO tyche_markets")) {
        const [id, label, pm, type, end] = params as [string, string, string | null, string, string | null];
        rows.set(id, { id, label, pm_market_id: pm, market_type: type, end_date: end });
        writes.upserts += 1;
        return { rows: [] };
      }
      if (q.startsWith("DELETE FROM tyche_markets")) {
        rows.delete(params[0] as string);
        writes.deletes += 1;
        return { rows: [] };
      }
      if (q.startsWith("INSERT INTO tyche_market_snapshots")) {
        writes.snapshots += 1;
        return { rows: [{ id: writes.snapshots }] };
      }
      if (q.startsWith("INSERT INTO tyche_alert_state")) {
        writes.edges += 1;
        return { rows: [] };
      }
      // The read halves the quoting path touches: no history exists in a dry run.
      if (q.startsWith("SELECT") && (q.includes("FROM tyche_market_snapshots") || q.includes("FROM tyche_alert_state"))) {
        return { rows: [] };
      }
      throw new Error(`refresh dry run: the fake pool does not know this statement — ${q.slice(0, 120)}`);
    },
  };

  const refresher = makeMarketsRefresh({ fetch: doFetch, pool: fakePool as unknown as Pool });
  let result: RefreshReport;
  try {
    result = await refresher.refresh({ watchlistMax: n, quoteMax: n });
  } catch (err) {
    blocked(`refreshWatchlist threw against the live venues: ${(err as Error).message}`);
    return;
  }

  info(
    `discovered=${result.discovered} added=${result.added.length} retired=${result.retired.length} ` +
      `quoted=${result.quoted} edges=${result.edgesRecorded} skipped=${result.skipped.length}`,
  );
  info(`writes counted in memory: upserts=${writes.upserts} deletes=${writes.deletes} snapshots=${writes.snapshots} edgeRecords=${writes.edges}`);
  for (const s of result.skipped) info(`skipped ${s.id}: ${s.reason}`);
  for (const id of result.added.slice(0, 10)) info(`added ${id}`);

  report(result.discovered >= 1, `discovery found at least one live event (${result.discovered})`);
  report(result.quoted > 0, `at least one open market quoted LIVE (${result.quoted})`);
  report(writes.snapshots > 0, `the job wrote snapshots (${writes.snapshots}) — a refresh that observes nothing is not a refresh`);
  report(writes.upserts === result.discovered, `one upsert per discovered event (${writes.upserts}/${result.discovered})`);
}

const kalshiEventArg = argOrEnv("--kalshi-event", "MARKETS_LIVE_KALSHI_EVENT");
const pmSlugArg = argOrEnv("--pm-slug", "MARKETS_LIVE_PM_SLUG");
const bigEventsArg = argOrEnv("--big-events", "MARKETS_LIVE_BIG_EVENTS");
const refreshDryRunArg = argOrEnv("--refresh-dry-run", "MARKETS_LIVE_REFRESH_DRY_RUN");

console.log("=== Sweep 1: Kalshi GET /markets?limit=1 → getEvent+listMarketsForEvent+parseKalshiEvent ===");
await sweepKalshi(kalshiEventArg);

console.log("\n=== Sweep 2: Polymarket Gamma GET /events?slug=... → parseEvent (the shipped venue-quotes.ts path) ===");
const tokenIds = await sweepGamma(pmSlugArg);

console.log("\n=== Sweep 3: Polymarket CLOB (POST /prices, batched — see header note on /book vs /prices) ===");
await sweepClob(tokenIds);

if (refreshDryRunArg !== undefined) {
  const n = Math.max(1, Number.parseInt(refreshDryRunArg, 10) || 1);
  console.log(`\n=== Sweep 5 (opt-in): the SHIPPED refresh job over the top ${n} live events, FAKE store, no DB — ORB-214 item 1 ===`);
  await sweepRefreshDryRun(n);
}

if (bigEventsArg !== undefined) {
  console.log(`\n=== Sweep 4 (opt-in): the ${bigEventsArg} largest open negRisk events through the shipped producer — counter-direction, ORB-214 item 8 ===`);
  await sweepBigOpenEvents(Math.max(1, Number.parseInt(bigEventsArg, 10) || 1));
}

console.log(`\n=== ${failed ? "FAIL" : "PASS"} ===`);
process.exit(failed ? 1 : 0);
