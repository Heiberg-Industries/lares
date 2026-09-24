/**
 * `market_edge` — the kit's TWELFTH contributed tool, and the ONE tool the `market-edge` code
 * skill is served by (ORB-189 Task 2). Tyche was an agent until 2026-09-01; she is this now.
 *
 * The file is deliberately thin. Every rule — the required caveat, the edge math, absent ≠ empty,
 * the cap over a known ordering — lives in `../../src/markets/edge.ts` as `runMarketEdge(verbs,
 * input)`, a pure function over the three read verbs. What is left here is the three things a
 * tool has to add: an input schema the model can fill in, a description that carries the hard
 * limits to the point of use, and the lazy binding to `makeMarkets(extension.config.markets)`.
 *
 * A RELATIVE import into `../../src/`, not the package specifier — see `transit_plan.ts`'s
 * header: eve's extension bundler refuses a self-referencing package import from within the
 * package's own extension source.
 *
 * BUILT ON FIRST CALL, NEVER AT MODULE SCOPE. `eve build` evaluates this file with no config
 * scope bound and no secrets present, so `extension.config` must not be read until a call is
 * actually in flight — the same reasoning `transit_plan.ts` and `../lib/orakel-client.ts`
 * record for their own lazy resolvers. Here it matters twice over: `cfg.pool` is a GETTER
 * (`() => getPool()`) precisely because `getPool()` throws without DATABASE_URL and would open
 * a database connection during a docker build. Calling it belongs here, on the first real call,
 * inside the try/catch that turns a wiring failure into an `unavailable` card.
 *
 * ABSENT CONFIG IS AN ANSWER, NOT A CRASH. An agent that mounts the kit without granting
 * `markets` never reaches this tool at all (the manifest resolves it to a disable sentinel at
 * the service's own override file). A mount that grants the skill but supplies no `markets`
 * config is a wiring mistake, and it comes back as `unavailable` in the tool's own vocabulary
 * rather than as an exception in a live turn.
 *
 * NOTHING HERE POSTS. `makeMarkets` never passes `emitCard`, no schedule references this tool,
 * and there is no alert path: proactive output is OFF until the proactivity contract (ORB-193).
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { makeMarkets } from "../../src/markets/index.js";
import { runMarketEdge, type MarketEdgeVerbs } from "../../src/markets/edge.js";
import extension from "../extension.js";

export interface MarketEdgeDeps {
  /** The three read verbs, or null when this agent has no markets config. */
  verbs(): MarketEdgeVerbs | null;
}

let cached: MarketEdgeVerbs | null | undefined;

function realVerbs(): MarketEdgeVerbs | null {
  if (cached === undefined) {
    const cfg = extension.config.markets;
    // `cfg.fetch` is `createTelegramFetch()` at the mount site, not Node's built-in fetch: both
    // agents that can grant `markets` are network-SEALED and reach Polymarket and Kalshi only
    // through the shared squid proxy, and Node's fetch ignores proxy environment variables
    // outright. Passing the wrong one compiles, passes the suite, and fails only on the box.
    //
    // `cfg.pool()` is the deferred half — the mount hands a getter, not a pool, so that
    // `eve build` can evaluate the mount file with no DATABASE_URL. This is the first and only
    // place it is called, and a throw here leaves `cached` unset (see the caller's try/catch).
    cached = cfg ? makeMarkets({ ...cfg, pool: cfg.pool() }) : null;
  }
  return cached;
}

export const defaultMarketEdgeDeps: MarketEdgeDeps = { verbs: realVerbs };

const inputSchema = z.object({
  action: z
    .enum(["find", "state", "best"])
    .describe(
      "find — search the watchlist by keyword and quote what matches (start here when a name " +
        "might not be watched); state — quote ONE market by id, re-read from the venues now; " +
        "best — the strongest edges the survey has RECORDED, ranked, not re-quoted.",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "find only: a name, phrase, or id fragment — every word of the query must appear in the " +
        "market's name or id (any order, punctuation ignored), so a longer phrase in your own " +
        "words works, not just one keyword.",
    ),
  marketId: z.string().optional().describe("state only: the market id (or its exact label) from a find result."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(8)
    .describe(
      "how many cards to return, best edge first (default 8). `find` quotes each matching " +
        "market, so a large limit there costs a live quote per market. `best` is capped at 12 " +
        "recorded edges by the feed itself, so a limit above that returns no more than 12.",
    ),
});

export function createMarketEdgeTool(deps: MarketEdgeDeps) {
  return defineTool({
    description:
      "Prediction-market prices and edges over Polymarket and Kalshi, for the markets on the " +
      "watchlist and no others. Returns compact cards: the market, the venue, the de-vigged " +
      "fair probability and how it was derived, the raw ask, the edge, an ISO `asOf`, and a " +
      "`caveat` that is always present and always worth repeating to the user. " +
      "THREE HARD LIMITS, and they are limits on YOU, not on this tool: never advise a stake " +
      "size or a bet size, in any units, even if asked directly; never place, book or simulate " +
      "placing a bet; never invent a price, a probability or an edge — if a number is not on a " +
      "card returned here, it does not exist and you say so. Surfacing the analysis is not " +
      "placing a bet; recommending how much to put on it is, and is refused. " +
      "An edge is a hypothesis about a price, never a fact and never a recommendation — say the " +
      "caveat with the number, not instead of it. " +
      "`edge` is always fair − ask on `find` and `state`, and what `fair` means there depends on " +
      "the card, which `method` states: where BOTH venues price the outcome, `fair` is the mean " +
      "of their two de-vigged probabilities and the edge is a real cross-venue one — positive " +
      "means this venue is cheap against the other. Where only ONE venue prices it, `fair` is " +
      "that venue's own de-vig, so the edge is NORMALLY just the vig share and non-positive — " +
      "read `method`, which says which of the two it is on that card, and never present a vig " +
      "share as an opportunity. The exception is a book whose asks sum under 100% (a momentary " +
      "arb): there a single-venue edge can be positive, `method` says so, and it is still one " +
      "venue's own book, not a cross-venue check. " +
      "On `best`, `edge` is instead the edge the survey RECORDED for that outcome at `asOf` — a " +
      "cross-venue or momentum gap — and is NOT the difference of the two numbers beside it, " +
      "which are the last stored quote, deliberately not re-quoted. " +
      "An `unavailable` string means something could NOT be read — a feed outage, a market that " +
      "is not on the watchlist, an outcome with no honest de-vigged fair. That is never the " +
      "same as 'no edges': `cards: []` with no `unavailable` is the real empty, and only then " +
      "may you say there is nothing. This tool is the only thing that knows what is watched: " +
      "if `find` returns nothing for a name, the market is not on the watchlist — which is not " +
      "the same as saying no such market exists anywhere.",
    inputSchema,
    async execute({ action, query, marketId, limit }) {
      let verbs: MarketEdgeVerbs | null;
      try {
        // Building the feed reads config and constructs clients and a pool wrapper; anything
        // that throws in there is a WIRING failure, and a wiring failure in a live turn must
        // arrive as this tool's own vocabulary rather than as an exception the model narrates
        // as "the markets are down". `realVerbs` leaves `cached` unset on a throw, so a
        // transient cause is retried on the next call instead of being memoised forever.
        verbs = deps.verbs();
      } catch (e) {
        return {
          cards: [],
          unavailable: `the markets feed could not be built — ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      if (!verbs) return { cards: [], unavailable: "the markets feed is not configured for this agent" };
      return runMarketEdge(verbs, { action, query, marketId, limit });
    },
  });
}

export default createMarketEdgeTool(defaultMarketEdgeDeps);
