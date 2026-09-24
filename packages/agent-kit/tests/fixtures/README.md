# Fixture provenance

Per the root `CLAUDE.md`'s Third-party APIs rule: "a fixture is what we believe an API does;
only a live call is what it does." The five fixtures below were copied over from Tyche's
original prototype during the ORB-189 port (Tasks 1-3) with no provenance note attached — this
file is the record, written after running `tests/live/markets.live.mts` (2026-09-03; round 1
after code review added `--kalshi-event`/`--pm-slug` so the specific ticker/slug comparisons
below are reproducible through the committed script, not just an ad hoc session). None of the
original recording dates are known; "verified" below means checked against a live call on
2026-09-03, not necessarily when the fixture was first written.

None of the five needed re-recording: every fixture's **shape** (field names, types, JSON-string
vs array encoding) matches what the live APIs return today. Where a fixture's specific *values*
are placeholders rather than a real capture, that's noted as "shaped" — it doesn't affect any
test's correctness, since the parsers under test only care about shape.

## `kalshi/market-binary.json`

- **Source:** Kalshi trade API, `GET /trade-api/v2/markets?event_ticker=KXNEWPOPE-70` (single
  market: `KXNEWPOPE-70-PPAR`).
- **Reproduce:** `pnpm exec tsx packages/agent-kit/tests/live/markets.live.mts --kalshi-event KXNEWPOPE-70`
  (Sweep 1's "real client path" — `getEvent`+`listMarketsForEvent`+`parseKalshiEvent` — runs
  against this exact ticker and prints the fixture beside the live shape).
- **Verdict: VERBATIM (trimmed to the fields the parser reads), values now stale but real.**
  The exact ticker exists live today. `close_time` (`2070-01-01T15:00:00Z`), `status`
  (`"active"`), `market_type` (`"binary"`), `title`, and `yes_sub_title`/`no_sub_title`
  (`"Pietro Parolin"`) all match the live response exactly (checked 2026-09-03). The price
  fields have moved since capture — same-day comparison: `yes_ask_dollars="0.0500"` (fixture
  `"0.0510"`), `yes_bid_dollars="0.0420"` (fixture `"0.0400"`), `volume_fp="24068.00"` (fixture
  `"22613.48"`) — ordinary market drift, not a shape problem. `liquidity_dollars="0.0000"`
  matched exactly. The fixture keeps only the fields `kalshi-parse.ts` reads; the live object
  carries ~35 more (`price_ranges`, `rules_primary`, `open_interest_fp`, etc.) that no code
  here touches. Re-running the reproduce command will show further-drifted prices each time —
  expected, not a regression.

## `kalshi/event-worldcup.json`

- **Source:** claimed as Kalshi `GET /trade-api/v2/events/KXWORLDCUP-26` +
  `GET /markets?event_ticker=KXWORLDCUP-26`, three candidate markets (Spain/Brazil/New Zealand).
- **Reproduce:** `pnpm exec tsx packages/agent-kit/tests/live/markets.live.mts --kalshi-event KXWORLDCUP-26`
  — expect `[FAIL] real client path (getEvent+listMarketsForEvent+parseKalshiEvent) for
  KXWORLDCUP-26 threw: kalshi /events/KXWORLDCUP-26 → 404`. (A 404 is an *answer* from Kalshi, so
  the probe reports it through `report(false, …)`, not through `blocked()`, which is reserved for
  a venue it could not reach at all — both exit non-zero.) That failure IS the reproduction of the
  verdict below, not a bug in the probe.
- **Verdict: SHAPED (synthetic) — the event ticker does not exist live.** `GET
  /trade-api/v2/events/KXWORLDCUP-26` returned `404` on 2026-09-03. The field *names* are
  correct (confirmed separately against real live Kalshi market samples — `event_ticker`,
  `title`, `sub_title`, `mutually_exclusive`, and the same `_dollars`-suffixed price fields, all
  printed by every run of Sweep 1's bare-sample check), and the round numbers
  (`liquidity_dollars: "120000.00"`, `volume_fp: "50000.00"`) read as invented rather than
  captured. Not a defect: `market_type` is correctly `"binary"` shaped like every other Kalshi
  market, and `markets-kalshi-parse.test.ts`/`markets-kalshi-producer.test.ts` only exercise
  `parseKalshiEvent`'s shape handling, which this fixture models correctly even though its
  content is invented. No test depends on `KXWORLDCUP-26` actually existing.

## `polymarket/market-binary.json`

- **Source:** claimed as Polymarket Gamma, market slug `ecb-cut-july-2026`.
- **Reproduce: not reproducible through the committed script's normal args.** This fixture is
  shaped like a standalone `GammaMarket` (parsed by `parseBinaryMarket`), but
  `tests/live/markets.live.mts` no longer exercises `listMarkets()`/`parseBinaryMarket()` at
  all — code review (round 1) found that pairing has no caller anywhere in the shipped
  `makeMarkets()` wiring (see the probe's header comment), so testing it would validate a
  contract nothing here depends on. The check below is **ad hoc, 2026-09-03**, via a one-off
  `gamma.listMarkets("slug=ecb-cut-july-2026")` call made outside the committed script and not
  preserved as a reusable command.
- **Verdict: SHAPED (synthetic) — this slug returned zero results.** `GET
  /markets?slug=ecb-cut-july-2026` returned zero results on 2026-09-03. `conditionId: "0xecb"`
  is a giveaway placeholder — real Polymarket condition ids are `0x` + 64 hex chars (a real
  example, reproducible via the `polymarket/event-worldcup.json` command below:
  `0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892`).
  `clobTokenIds: ["tok-ecb-yes","tok-ecb-no"]` is likewise a placeholder — real CLOB token ids
  are ~75-digit numeric strings (same reproducible example:
  `4394372887385518214471608448209527405727552777602031099972143344338178308080`). The *field
  names and encoding* are correct — `outcomes`/`outcomePrices`/`clobTokenIds` as JSON-strings,
  `endDateIso` as a real, separate field from `GammaEvent.endDate` (both confirmed present
  simultaneously on live Gamma market objects, printed by every run of Sweep 2) — only the
  specific values are invented.

## `polymarket/event-worldcup.json`

- **Source:** Polymarket Gamma, event slug `world-cup-winner` (3 of its markets:
  Spain/Brazil/New Zealand).
- **Reproduce:** `pnpm exec tsx packages/agent-kit/tests/live/markets.live.mts --pm-slug world-cup-winner`
  (Sweep 2 calls `getEvent("world-cup-winner")` + `parseEvent(...)` — the shipped
  `venue-quotes.ts` path — and prints the fixture beside the live shape).
- **Verdict: VERBATIM STRUCTURE, SHAPED ids.** The slug is real and live today — `GET
  /events?slug=world-cup-winner` returns a real event with 60 sub-markets (the fixture keeps
  3), matching field-for-field on `question`, `slug`, `outcomes`, `outcomePrices`,
  `clobTokenIds`, `groupItemTitle`, `active`, `closed`, and the event-level `endDate` (not
  `endDateIso` — correctly distinct, matching `GammaEvent`'s own type, confirmed present
  simultaneously with `GammaMarket.endDateIso` on the sub-market objects). The specific ids are
  still placeholders: `conditionId: "0xspain"` / `clobTokenIds: ["tok-spain-yes", ...]` are not
  real hex/numeric ids — a real sub-market from this same event, reproducible via the command
  above: `conditionId="0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892"`,
  `clobTokenIds[0]="4394372887385518214471608448209527405727552777602031099972143344338178308080"`.
  Whether Spain/Brazil/New Zealand are still among the live 60 sub-markets was not individually
  re-confirmed — not needed for shape validation, and the odds would have moved regardless (the
  2026 World Cup's `endDate` of 2026-07-20 has already passed as of this writing, so most of
  this event's sub-markets have resolved — see the CLOB verdict below).

## `polymarket/clob-prices-sell.json`

- **Source:** claimed as Polymarket CLOB, `POST /prices` (batched `[{token_id, side:"sell"}]`)
  for the three World Cup tokens above.
- **Reproduce:** same command as `polymarket/event-worldcup.json` above (Sweep 3 runs
  automatically, batching every token id Sweep 2 harvested from `world-cup-winner`).
- **Verdict: VERBATIM SHAPE, SHAPED ids/values.** This is the fixture that most directly
  matters, because `tests/live/markets.live.mts` sweep 3 calls the exact same endpoint the
  shipped `polymarket-clob-client.ts` calls (not the `GET /book` endpoint this task's brief
  describes — see that file's header comment for why). Live response shape, 2026-09-03 (via the
  reproduce command above): `{"604474...506057": {"SELL": "1"}}` — object keyed by token id,
  `SELL` as a numeric string, `BUY` absent (declared optional, unused by `fetchAsks` either
  way). The fixture's shape — `{tok-id: {"SELL": "0.140"}}` — matches exactly. The token ids
  (`tok-spain-yes` etc.) are the same placeholders as `event-worldcup.json` above, not real CLOB
  ids, and the SELL values are invented round-ish numbers rather than captured prices. Because
  the 2026 World Cup has already concluded, only 1 of `world-cup-winner`'s 60 tokens still
  carries a live SELL price today (the resolved winner, at `"1"`) — the other 59 return no
  entry at all, which `fetchAsks`'s own best-effort design already tolerates (see the probe's
  Sweep 3 header note). A market with more live legs — e.g. the default no-args run, which
  discovers the highest-24h-volume active event — shows broader coverage (in one run: 15/20
  sampled tokens priced).
