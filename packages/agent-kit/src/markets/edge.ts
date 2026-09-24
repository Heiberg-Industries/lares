// The `market-edge` CODE SKILL (ORB-189 Task 2): the card, and the policy the card must obey.
//
// A skill composes capabilities the agent already holds and adds policy it CANNOT widen. Here the
// capability is `markets` (the three read verbs in ./read.ts) and the policy is Tyche's own,
// moved out of a persona and into code, because a persona is a request and code is a rule:
//
//   * `caveat` is REQUIRED, non-empty, and SYNTHESISED HERE — never left to the model to write or
//     to forget. Every card names what could make it fake; a card with nothing else to say still
//     says the one thing that is always true (an edge is a hypothesis, not a fact).
//   * NO number is invented. `fair` and `ask` come from the feed or the stores or the card is not
//     emitted at all. An outcome with no honest de-vigged fair produces NO card — never a fair
//     back-computed from an edge, never an ask "about" anything.
//   * NO stake, anywhere. There is no field for one and nothing here computes one. The tool's
//     description carries the three hard limits so the model reads them at the point of use.
//   * Absent ≠ empty. A feed that could not be read comes back as `unavailable` naming what could
//     not be read; a search that genuinely matched nothing comes back as `cards: []` and nothing
//     else. The fleet has shipped the opposite mistake often enough to make it a rule.
//
// WHERE EACH CARD'S NUMBERS COME FROM — the honest reading of `edge`, which is NOT the same on
// every action and is the one thing a reader must get right:
//
//   find / state → a QUOTE. `ask` is always that venue's own raw ask. `fair` depends on whether
//                  BOTH venues priced the outcome, because a single venue's de-vigged fair is
//                  not an independent estimate of anything: proportional de-vig scales every
//                  ask by 1/Σ, so fair − ask on one venue's own book is normally the vig share
//                  and non-positive (review round 1 measured six such cards — all negative, and
//                  the genuinely cheap one looked the worst of them). So:
//                    PAIRED   — `fair` is the MEAN of the two venues' de-vigged fairs
//                               (`combineSources(…, "mean")`), and `edge = fair − ask` against
//                               THIS venue's ask. That is a real cross-venue edge: positive
//                               where this venue is cheap against the other.
//                    UNPAIRED — `fair` stays the single venue's own de-vig, and the card SAYS
//                               so in `method`, chosen from the SIGN of the computed edge: the
//                               usual case is the vig share, not an edge; a book whose asks sum
//                               under 100% (Σ < 1, a momentary arb — `engine.ts`'s
//                               `overround < 0`) makes the same subtraction positive, and the
//                               card must not call that impossible while printing it.
//                  Either way `edge` is COMPUTED here as fair − ask (4 dp), never an input.
//   best         → a RECORDED edge. `bestBets` ranks on what the survey loop measured and wrote
//                  to `tyche_alert_state`, which is a different quantity from fair − ask (a
//                  cross-venue gap, a momentum move, an overround anomaly — the row does not say
//                  which). So `edge` on a best card is that recorded number, carried through
//                  unchanged, with `asOf` = when it was RECORDED and a caveat naming the date.
//                  It is not re-quoted: re-quoting the whole ranking is the serial fetch storm
//                  `bestBets` exists to avoid. `fair`/`ask` on the card are the last stored
//                  snapshot the same read already had in hand — real numbers, not derived ones.
//
// `runMarketEdge(verbs, input)` takes the verbs as an ARGUMENT and returns a plain object: no
// pg, no fetch, no eve. `../../extension/tools/market_edge.ts` is the thin binding that gives it
// `makeMarkets(extension.config.markets)`, so every rule in this file is unit-testable without a
// database or a network, and the tool file has nothing in it worth hiding a bug in.
//
// NOTHING HERE POSTS ANYWHERE. `makeMarketsRead`'s optional `emitCard` dependency is deliberately
// never supplied (see ./index.ts): proactive output stays OFF until the proactivity contract
// (ORB-193) exists, so this skill answers when asked and is silent otherwise.

import { combineSources } from "./probability/engine.js";
import { prob, type NormalizedSource } from "./probability/types.js";

export type Venue = "polymarket" | "kalshi";

/** Tyche's compact card, the ONE shape every action returns. `caveat` is non-empty by
 *  construction — {@link rejectUncaveatedCards} is the last gate before it leaves. */
export interface MarketCard {
  /** "<market label> — <outcome label>", the human name of what is priced. */
  market: string;
  venue: Venue;
  /** The probability this card is priced against, 0..1, 4 dp: the cross-venue MEAN of both
   *  venues' de-vigged fairs where the outcome is paired, this venue's own de-vig where it is
   *  not (and `method` says which). */
  fair: number;
  /** How `fair` was derived, and from what — a quote or a recorded row. */
  method: string;
  /** The raw observed ask, 0..1, 4 dp. */
  ask: number;
  /** find/state: fair − ask, always. best: the edge the survey recorded. Never an input,
   *  never invented. */
  edge: number;
  /** Non-empty, always: what could make this card fake. */
  caveat: string;
  /** ISO instant the card's numbers are AS OF — now for a live quote, the recorded/observed
   *  instant otherwise. Never silently "now" for a number that is not from now. */
  asOf: string;
}

export interface MarketEdgeResult {
  cards: MarketCard[];
  /** ORB-214 (6) — matches that have already settled, named so the model can say "settled" instead
   *  of "no quotes". Never quoted: a closed market has markers, not a book. */
  settled?: string[];
  /** Present when something could NOT be read. Absent means the emptiness is real. */
  unavailable?: string;
}

export interface MarketEdgeInput {
  action: "find" | "state" | "best";
  query?: string;
  marketId?: string;
  /** Applied HERE, by slicing an ordered list — the verbs take no limit (Ruling 9). */
  limit: number;
}

// ── the seam: exactly what ./read.ts returns, structurally ───────────────────────────────────
// Declared here rather than imported so a test can build one by hand, and so this file states
// its own contract with the capability instead of inheriting whatever read.ts happens to infer.

export interface QuoteSide {
  ask: number;
  /** null when a de-vig would be dishonest (a mutually-exclusive book with <2 priced outcomes). */
  fair: number | null;
}

export interface StateOutcome {
  /** The CANONICAL key — the alias-folded label that made both venues land on one outcome. What
   *  a reader identifies an outcome by, and what a WRITER must not key a row on. */
  outcomeId: string;
  label: string | null;
  /** The venue's own outcome id and its own spelling, per venue that priced this outcome. Present
   *  on the paths `read.ts` produces; optional because a hand-built state (a test, a card fixture)
   *  need not carry it.
   *
   *  It exists for the ONE consumer that writes: `tyche_alert_state` and `tyche_market_snapshots`
   *  are keyed by the venue's own id — that is what `alignOutcomes`' `alertOutcomeIds` reads back
   *  and what `storedState` re-aligns from — so a row written under `outcomeId` above is a row
   *  nothing can ever read (ORB-214 item 1, refresh.ts). */
  venueOutcomes?: Partial<Record<Venue, { outcomeId: string; label: string | null }>>;
  polymarket: QuoteSide | null;
  kalshi: QuoteSide | null;
  lastEdge: number | null;
  lastBasis: number | null;
  recordedAtIso?: string | null;
  lastAlertedAtIso?: string | null;
}

export type MarketStateResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      source: "live" | "stored";
      /** The stored snapshot instant; null on the live path (the quote is from now). */
      asOfIso: string | null;
      /** Set when this market IS paired to Kalshi and Kalshi could not be read — the reason. A
       *  card must then say that, not "one venue only", which would be a false claim about our
       *  coverage of a two-venue market. null/absent when Kalshi answered or was never paired. */
      kalshiUnavailable?: string | null;
      market: { id: string; label: string; endDateIso: string | null };
      outcomes: StateOutcome[];
    };

// The ONE exception to declaring the seam locally: `bestBets`' entry is imported from the verb
// that produces it (a type-only import — nothing of read.ts is pulled in at runtime), because
// two hand-written copies of a thirteen-field row are a drift waiting to happen, and this one has
// no shape of its own to state.
export type { RankedEntry } from "./read.js";
import { STORED_BOOK_WINDOW } from "./read.js";
import type { RankedEntry } from "./read.js";

/** The `ok: true` half of {@link MarketStateResult} — the only one that carries outcomes. */
export type QuotedState = Extract<MarketStateResult, { ok: true }>;

export interface MarketEdgeVerbs {
  findMarkets(query: string): Promise<{ matches: Array<{ id: string; label: string; hasKalshi: boolean; settled?: boolean; settledOn?: string }> }>;
  marketState(idOrLabel: string): Promise<MarketStateResult>;
  bestBets(): Promise<{ ranked: RankedEntry[]; scanned?: number; open?: number }>;
}

// ── the math ─────────────────────────────────────────────────────────────────────────────────

/** Probabilities to 4 dp — 0.01 of a percentage point, finer than any venue quotes and coarse
 *  enough that a card never shows float noise. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** THE edge computation, in one place: what buying at `ask` is worth against the de-vigged
 *  `fair`. Both sides are rounded first, so the card's own three numbers reconcile exactly to
 *  4 dp rather than merely nearly. */
export function computeEdge(fair: number, ask: number): number {
  return round4(round4(fair) - round4(ask));
}

/**
 * The fair a PAIRED outcome is priced against: the unweighted mean of the two venues' de-vigged
 * fairs, through the engine's own `combineSources` rather than an arithmetic mean written out
 * here, so the combination rule lives in one place for every consumer of this package.
 *
 * `raw` and `overround` are placeholders: `"mean"` mode reads `.fair` and nothing else. The
 * synthetic-NormalizedSource shape is copied from the survey loop's own use of
 * `computeDivergence` (`market-survey/detect.ts`), which does the same for the same reason.
 */
function crossVenueMeanFair(outcomeId: string, quotes: Array<[Venue, { ask: number; fair: number }]>): number {
  const sources: NormalizedSource[] = quotes.map(([venue, q]) => ({
    source: venue,
    fair: { [outcomeId]: prob(q.fair) },
    raw: { [outcomeId]: prob(q.ask) },
    overround: 0,
    mutuallyExclusive: true,
  }));
  return combineSources(sources, "mean")[outcomeId] as number;
}

/** The day part of an ISO instant, or null if there isn't one. Used only to NAME a date in a
 *  caveat — never to compute an age, because a wrong clock would then silently change what the
 *  card claims. */
function dayOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const day = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(day) ? day : null;
}

/** The caveat every card falls back to when it has nothing more specific to confess. Tyche's
 *  own first line of voice, kept as policy: an edge is a hypothesis about a price. */
const HYPOTHESIS = "an edge is a hypothesis, not a fact — single snapshot";

/** Join the caveat sources that apply; when none does, say the one thing that always does.
 *  The return is non-empty by construction — that is the whole point of routing every card
 *  through here rather than letting a call site assemble a string. */
function caveatFrom(parts: Array<string | null | false>): string {
  const kept = parts.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  return kept.length > 0 ? kept.join("; ") : HYPOTHESIS;
}

/** The last gate: a card with a blank caveat does not leave this module. Unreachable via
 *  {@link caveatFrom} today — which is exactly why it is enforced structurally rather than
 *  trusted, since the next card-building path added here would not have to remember. */
export function rejectUncaveatedCards(cards: MarketCard[]): MarketCard[] {
  return cards.filter((c) => c.caveat.trim() !== "");
}

/** A KNOWN ordering before any cap: best edge FIRST, by SIGNED value — a +2 pt edge outranks a
 *  −8 pt one, which is the whole question being asked. Ordering by |edge| put the worst cards on
 *  top and, on single-venue quotes where edge is proportional to ask, degenerated into ordering
 *  by ask (review round 1). Ties break on the more probable outcome, then the name, so the cap
 *  is never applied to an arbitrary order — an unordered slice drops the valuable half and looks
 *  like an empty result, a lesson this fleet has paid for twice. */
function byInterest(a: MarketCard, b: MarketCard): number {
  const byEdge = b.edge - a.edge;
  if (byEdge !== 0) return byEdge;
  const byFair = b.fair - a.fair;
  if (byFair !== 0) return byFair;
  return a.market.localeCompare(b.market);
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── quoted cards (find / state) ──────────────────────────────────────────────────────────────

/** Every card one `marketState` answer supports, plus a count of the outcomes it could NOT
 *  honestly quote — the caller reports that count rather than letting it vanish. `untimed` is
 *  the one whole-result refusal: see below. */
function cardsForState(
  state: QuotedState,
  nowIso: string,
): { cards: MarketCard[]; unquotable: number; untimed: boolean } {
  const live = state.source === "live";

  // A STORED state with no snapshot instant emits NOTHING. It cannot happen (an outcome only
  // reaches here because a snapshot priced it, and a snapshot has a `ts`), and the previous
  // fallback — `asOf = nowIso` — would have made a card claim prices from now that are not from
  // now, which is the exact dishonesty every other rule in this file exists to prevent. Refusing
  // is the only answer that stays true; the caller says so out loud (review round 1, minor).
  if (!live && state.asOfIso === null) return { cards: [], unquotable: 0, untimed: true };

  const observedDay = dayOf(state.asOfIso);
  const asOf = live ? nowIso : (state.asOfIso as string);

  const cards: MarketCard[] = [];
  let unquotable = 0;

  for (const o of state.outcomes) {
    // Only venues with an HONEST fair: a null fair is a book too degenerate to de-vig, and it
    // makes the outcome unpaired rather than merely unpriced on that side. `quotedHere` — not
    // "how many venues returned something" — is what "one venue only" has to mean, since a
    // venue that returned an ask with no usable fair contributes no cross-venue check either.
    // `Number.isFinite`, not just non-null: `ask` and `fair` arrive as `number` from a store that
    // coerces pg `numeric` strings with `Number()`, and `Number("")` is 0 while `Number("n/a")`
    // is NaN. A NaN reaching a card is the worst outcome available — `round4(NaN)` is NaN, it
    // serialises to JSON `null`, and the card would present a missing price as a price. A venue
    // whose numbers are not numbers has not quoted this outcome; treat it as unquoted.
    const quotedHere: Array<[Venue, { ask: number; fair: number }]> = [];
    for (const [venue, q] of [
      ["polymarket", o.polymarket],
      ["kalshi", o.kalshi],
    ] as Array<[Venue, QuoteSide | null]>) {
      if (q && q.fair !== null && Number.isFinite(q.ask) && Number.isFinite(q.fair)) {
        quotedHere.push([venue, { ask: q.ask, fair: q.fair }]);
      }
    }
    if (quotedHere.length === 0) {
      unquotable += 1;
      continue;
    }

    const paired = quotedHere.length === 2;
    // ONE fair for the outcome when it is paired — the cross-venue mean — compared against EACH
    // venue's own ask, so the two cards differ exactly by what the two venues charge.
    const fair = paired ? crossVenueMeanFair(o.outcomeId, quotedHere) : quotedHere[0][1].fair;
    // The combination step is the engine's, not this file's; if it ever hands back something
    // that is not a number, the outcome is unquotable rather than a card with a hole in it.
    if (!Number.isFinite(fair)) {
      unquotable += 1;
      continue;
    }

    for (const [venue, q] of quotedHere) {
      // Exact equality on the UNROUNDED pair: normalizeSource passes an independent book's ask
      // straight through as its fair, so this is "the de-vig moved nothing", measured rather
      // than inferred from a market-type flag this result does not carry. Only meaningful on an
      // unpaired card, where `fair` IS this venue's own de-vig.
      const undevigged = q.fair === q.ask;
      // MEASURED, not assumed. A single-venue de-vig is normally the vig share — proportional
      // de-vig scales every ask by 1/Σ, so with Σ > 1 the fair lands under the ask and the edge
      // is negative. But Σ CAN be under 1, and the two paths get there for DIFFERENT reasons:
      //
      //   live   — the venue's own book really does sum under 100%: a momentary arb
      //            (`probability/engine.ts` records it as `overround < 0`).
      //   stored — `read.ts`'s storedState de-vigs `recentByMarketVenue({ limit: STORED_BOOK_WINDOW })`
      //            (200 since ORB-214 item 3; was 40), still a TRUNCATED book on any venue with more
      //            outcomes than that at its newest instant (the live probe
      //            counts 60 sub-markets on `world-cup-winner` alone). A truncated book sums
      //            under 1 because outcomes are missing, not because anything is mispriced, so
      //            calling that an arb would be inventing an opportunity out of our own paging.
      //
      // The old wording said "cannot be positive" on the very card that had just printed a
      // positive number — the reader is then entitled to disbelieve the number or the sentence,
      // and both were ours. So the claim is made from `edge`, which is already computed, and
      // from which path produced it.
      const edge = computeEdge(fair, q.ask);
      cards.push({
        market: `${state.market.label} — ${o.label ?? o.outcomeId}`,
        venue,
        fair: round4(fair),
        method: paired
          ? `cross-venue mean fair (polymarket + kalshi), ${live ? "live venue books" : "stored snapshots"}`
          : edge > 0
            ? live
              ? "single-venue de-vig on a sub-100% book (a momentary arb) — live quotes"
              : `single-venue de-vig on the last ${STORED_BOOK_WINDOW} stored snapshots — not a cross-venue check`
            : `single-venue de-vig (${live ? "live venue book" : "stored snapshot"}) — ` +
              "this edge is the vig share and cannot be positive",
        ask: round4(q.ask),
        edge,
        caveat: caveatFrom([
          !live &&
            (observedDay
              ? `stale quote — prices last observed ${observedDay}`
              : "stale quote — the stored snapshot's timestamp is unreadable"),
          // An OUTAGE and a one-venue market are different facts. "one venue only" on a market we
          // do quote on two venues is a false statement about our own coverage, and it is the
          // one a reader would act on — so when the read failed, the card names the failure
          // instead. `method` still says single-venue, because that is what this number is, and
          // `unavailable` is NOT set: the Polymarket side answered, and this card is real.
          !paired &&
            (state.kalshiUnavailable
              ? `Kalshi could not be read (${state.kalshiUnavailable}) — no cross-venue check on a market that has one`
              : "one venue only — no cross-venue check"),
          !paired && undevigged && "the de-vig moved nothing here — the ask is the probability",
        ]),
        asOf,
      });
    }
  }

  return { cards, unquotable, untimed: false };
}

// ── the skill ────────────────────────────────────────────────────────────────────────────────

/**
 * One call of the `market_edge` tool, over the three verbs and nothing else.
 *
 * `now` is injectable because a card's `asOf` is a claim about time: eve injects no clock of its
 * own, and a test that cannot pin the clock cannot assert what a live card says it is as of.
 */
export async function runMarketEdge(
  verbs: MarketEdgeVerbs,
  input: MarketEdgeInput,
  now: () => Date = () => new Date(),
): Promise<MarketEdgeResult> {
  const nowIso = now().toISOString();
  // `limit` arrives through a zod schema that defaults and bounds it, but `runMarketEdge` is
  // callable without one — and `Math.floor(NaN)` is NaN, which makes `slice(0, NaN)` return
  // NOTHING. A silent empty answer from a malformed number is the worst possible failure here.
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.floor(input.limit)) : DEFAULT_LIMIT;

  if (input.action === "state") return stateAction(verbs, input, limit, nowIso);
  if (input.action === "find") return findAction(verbs, input, limit, nowIso, now);
  return bestAction(verbs, limit, nowIso);
}

/**
 * How long `find` may spend QUOTING its matches before it stops and says what it did not reach.
 *
 * `find` is the one action that can make many round trips in a single turn: one `marketState`
 * per match, each of which is up to four live venue requests, and `limit` may be 20. Each of
 * those requests now carries its own 8s abort signal (`../markets/*-client.ts`), but 80 requests
 * that each take 8s is still a turn that never answers, so the two bounds are different jobs:
 * the client's stops ONE hung socket, this one stops the LOOP — the shape `transit_plan.ts`'s
 * own budget exists to prevent, in the same package for the same reason.
 *
 * The bound is checked BETWEEN markets, not inside a request: it cannot abort a request in
 * flight (the verbs take no AbortSignal), and it does not need to — the client's own signal
 * does that. It stops the loop from multiplying one slow venue by twenty. What it does guarantee
 * is that the matches it did not reach are NAMED in `unavailable` rather than quietly missing
 * from a shorter list.
 */
const FIND_QUOTE_BUDGET_MS = 10_000;

/** What `limit` falls back to when it is not a finite number. Matches the tool schema's own
 *  default, which is the only value a real call ever arrives with. */
const DEFAULT_LIMIT = 8;

async function stateAction(
  verbs: MarketEdgeVerbs,
  input: MarketEdgeInput,
  limit: number,
  nowIso: string,
): Promise<MarketEdgeResult> {
  const id = input.marketId?.trim();
  // A returned message, never a throw: the model asked for something it can fix by asking again.
  if (!id) return { cards: [], unavailable: "state needs a marketId — use find first" };

  let state: MarketStateResult;
  try {
    state = await verbs.marketState(id);
  } catch (e) {
    return { cards: [], unavailable: `the markets feed could not be read — ${message(e)}` };
  }
  // Not on the watchlist is a fact about the watchlist, not "no edge here" — say which. The
  // reason is passed through WHOLE rather than suffixed: `marketState` has two `ok: false` cases
  // now (not on the watchlist at all, and on it but with nothing quotable on either venue or in
  // the snapshots), and the old "— nothing on the watchlist to quote" suffix is a false statement
  // about the second. Each reason names its own case; see `read.ts`'s NO_QUOTES_REASON.
  if (!state.ok) return { cards: [], unavailable: state.reason };

  const { cards, unquotable, untimed } = cardsForState(state, nowIso);
  if (untimed) {
    return {
      cards: [],
      unavailable: `the stored prices for ${state.market.label} carry no timestamp — a price with no time is not a quote`,
    };
  }
  return finish(cards.sort(byInterest), limit, unquotableNote(unquotable, "outcome"));
}

async function findAction(
  verbs: MarketEdgeVerbs,
  input: MarketEdgeInput,
  limit: number,
  nowIso: string,
  now: () => Date,
): Promise<MarketEdgeResult> {
  const query = input.query?.trim();
  if (!query) return { cards: [], unavailable: "find needs a query — every word of it must appear in the market's name" };

  let matches: Array<{ id: string; label: string; hasKalshi: boolean; settled?: boolean; settledOn?: string }>;
  try {
    matches = (await verbs.findMarkets(query)).matches;
  } catch (e) {
    return { cards: [], unavailable: `the markets watchlist could not be read — ${message(e)}` };
  }
  // A REAL empty: the watchlist was read and holds nothing matching. No `unavailable`, because
  // nothing was unavailable — this is the answer, and the model may say so.
  if (matches.length === 0) return { cards: [] };

  // Each match costs one quote, so the cap has to bite BEFORE the network, which means the order
  // matters here as much as it does on the cards: paired markets first (they are the ones a
  // cross-venue check can say anything about — the same reason bestBets ranks them first), then
  // by name so the choice is stable rather than "whatever was updated last", which is the order
  // the store returns and is meaningless to a reader.
  const ordered = [...matches].sort((a, b) =>
    a.hasKalshi === b.hasKalshi ? a.label.localeCompare(b.label) : a.hasKalshi ? -1 : 1,
  );

  const cards: MarketCard[] = [];
  let unquotable = 0;
  const failures: string[] = [];
  const settledMatches: string[] = [];
  const chosen = ordered.slice(0, limit);
  const startedMs = now().getTime();
  for (const [i, m] of chosen.entries()) {
    if (m.settled) {
      settledMatches.push(`${m.label} (settled ${m.settledOn ?? "— date not recorded"})`);
      continue;
    }
    if (i > 0 && now().getTime() - startedMs >= FIND_QUOTE_BUDGET_MS) {
      failures.push(
        `${chosen.length - i} further match${chosen.length - i === 1 ? "" : "es"} not quoted — ` +
          `the ${FIND_QUOTE_BUDGET_MS / 1000}s budget for one call ran out`,
      );
      break;
    }
    try {
      const state = await verbs.marketState(m.id);
      if (!state.ok) {
        failures.push(`${m.label}: ${state.reason}`);
        continue;
      }
      const got = cardsForState(state, nowIso);
      if (got.untimed) {
        failures.push(`${m.label}: the stored prices carry no timestamp`);
        continue;
      }
      cards.push(...got.cards);
      unquotable += got.unquotable;
    } catch (e) {
      failures.push(`${m.label}: ${message(e)}`);
    }
  }

  const result = finish(cards.sort(byInterest), limit, unquotableNote(unquotable, "outcome"));
  const settled = settledMatches.length > 0 ? { settled: settledMatches } : {};
  if (failures.length === 0) return { ...result, ...settled };
  return {
    cards: result.cards,
    ...settled,
    unavailable: [result.unavailable, `could not read: ${failures.join("; ")}`].filter(Boolean).join("; "),
  };
}

async function bestAction(verbs: MarketEdgeVerbs, limit: number, nowIso: string): Promise<MarketEdgeResult> {
  let ranked: RankedEntry[];
  let coverage: string | false = false;
  try {
    const best = await verbs.bestBets();
    ranked = best.ranked;
    // ORB-214 (3): the scan is bounded and ordered (soonest-closing first); when it did not cover
    // every open market the card says so, on every card, so a "best" is never read as "of all".
    if (best.scanned !== undefined && best.open !== undefined && best.open > best.scanned) {
      coverage = `ranked over the ${best.scanned} soonest-closing of ${best.open} open markets`;
    }
  } catch (e) {
    return { cards: [], unavailable: `the markets feed could not be read — ${message(e)}` };
  }
  // Nothing recorded is a real answer — "no active edges right now", not an outage.
  if (ranked.length === 0) return { cards: [] };

  // bestBets already ordered this (paired markets first, then strongest |recorded edge|), so the
  // slice keeps that ordering rather than imposing a second one over the same numbers.
  const cards: MarketCard[] = [];
  let unquotable = 0;
  for (const e of ranked.slice(0, limit)) {
    if (e.venue === null || e.ask === null || e.fair === null) {
      unquotable += 1;
      continue;
    }
    const recordedDay = dayOf(e.recordedAtIso);
    // TWO instants, one `asOf`. `asOf` is when the EDGE was recorded, which is what Ruling 10
    // asks for; `fair`/`ask` come from the newest stored snapshot, which is a different moment.
    // When they fall on different days the card says so rather than letting one date stand for
    // both (review round 1).
    const quotedDay = dayOf(e.quotedAtIso);
    cards.push({
      market: `${e.marketLabel} — ${e.outcomeLabel ?? e.outcomeId}`,
      venue: e.venue,
      fair: round4(e.fair),
      // Says plainly that this card's edge is not the difference of the two numbers beside it.
      method: "recorded edge (survey); fair de-vigged from the last stored snapshot",
      ask: round4(e.ask),
      edge: round4(e.lastEdge),
      caveat: caveatFrom([
        recordedDay
          ? `recorded ${recordedDay}, not re-quoted`
          : "recorded with no timestamp, not re-quoted",
        quotedDay !== null && quotedDay !== recordedDay && `prices from ${quotedDay}`,
        !e.referenced && "one venue only — no cross-venue check",
        coverage,
      ]),
      // The recorded instant, not now: the whole point of saying "not re-quoted".
      asOf: e.recordedAtIso ?? e.quotedAtIso ?? nowIso,
    });
  }

  // NOT re-sorted: bestBets' ranking is the answer to "best bets", and |edge| alone would throw
  // away its paired-markets-first grouping.
  return finish(cards, limit, unquotableNote(unquotable, "recorded edge"));
}

/** What to say about entries that produced no card. Never nothing: a shorter list that explains
 *  itself is the difference between "there is no edge here" and "I could not read this". */
function unquotableNote(unquotable: number, noun: "outcome" | "recorded edge"): string | undefined {
  if (unquotable === 0) return undefined;
  const what = `${unquotable} ${noun}${unquotable === 1 ? "" : "s"} could not be quoted`;
  return noun === "recorded edge"
    ? `${what} — no stored quote with an honest de-vigged fair`
    : `${what} — no de-vigged fair in the book (fewer than two priced outcomes, or a price that is not a number)`;
}

/** Enforce the caveat rule and cap to `limit`. Callers hand in cards in the order they mean to
 *  keep: the cap is applied to THAT order, because an unordered slice drops the valuable half
 *  and looks like an empty result. */
function finish(cards: MarketCard[], limit: number, problem?: string): MarketEdgeResult {
  const kept = rejectUncaveatedCards(cards).slice(0, limit);
  return problem === undefined ? { cards: kept } : { cards: kept, unavailable: problem };
}
