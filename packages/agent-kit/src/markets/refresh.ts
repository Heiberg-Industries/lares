// The watchlist refresh — the ONE job in this package that writes, and it never posts.
//
// WHAT IT IS. Three things in one pass, per ORB-214 item 1:
//
//   1. DISCOVER — the top events by Polymarket liquidity, parsed, canonical-id deduped, and
//      upserted link-preservingly into `tyche_markets`.
//   2. RETIRE — drop a watched row that settled long ago and carries no Kalshi link.
//   3. RE-QUOTE — walk the open rows through the SHIPPED `marketState` live path, append one
//      snapshot per priced venue side, and record the edge each de-vigged fair implies.
//
// WHAT IT IS NOT, and this is the load-bearing half. It does not judge (the LLM match judge was
// retired with the survey loop; Kalshi links and outcome aliases stay manual — ORB-214 item 2).
// It does not alert: `alertState.record` is a measurement, and `alertedAtIso` is null on every
// single call. It does not post, and it cannot: `RefreshDeps` has no channel, no `send`, no
// `initiate` and — unlike the retired `discoverWatchlist` it descends from — no `announce`. A
// refresh is a JOB, not an initiation (the proactivity contract, §6); anything Saga has to SAY
// about markets goes through the gate, from a schedule, and never from here.
//
// PORTED FROM the retired survey loop (`services/agent-runtime/lib/workflows/market-survey/`,
// last present at 03404bc6^): `discover.ts`'s discoverWatchlist minus its `announce` calls and
// its `maxNewPerCycle` cap (which existed only to bound how much the loop said out loud). The
// quoting half is NOT ported — the survey had its own producer pipeline; this reads the state
// through the kit's shipped `marketState`, so the job and a conversational answer can never
// disagree about what a market is worth.
//
// THE KEY SPACE IS THE VENUE'S, NOT OURS. Both tables this job writes are keyed by the venue's
// OWN outcome id — a CLOB token id on Polymarket, a market ticker on Kalshi. `marketState` hands
// back outcomes keyed by the CANONICAL key instead (the alias-folded label, "spain"), because
// that is what makes both venues' quotes land on one outcome for a reader. A row written under
// that canonical key is a row nothing can ever read back: `read.ts`'s `recordedEdge` looks
// `tyche_alert_state` up by `alertOutcomeIds` (the venue ids), and `storedState` reads snapshots
// and re-aligns them from the venue's own label. So every write below goes through
// `outcome.venueOutcomes[venue]` — that venue's id and that venue's spelling — and the round trip
// is asserted against a real Postgres in tests/markets-refresh.test.ts, because no fake can show
// a key-space mismatch: a fake answers under whatever key the writer used.
//
// ONE DELIBERATE DIFFERENCE FROM THE RETIRED LOOP. `discover.ts` dropped EVERY watched row that
// fell out of the top set and had no Kalshi link. That is too eager now: ORB-214 item 6 taught
// the read path to answer "settled on <date>, and here is the venue's own settlement marker" for
// a finished market, and a row deleted the night it settled cannot answer anything. So retirement
// needs BOTH conditions — out of the top set AND settled more than `retireAfterDays` ago — and an
// open row that merely slipped down the liquidity ranking is kept.
import { canonicalMarketId } from "./canonical-id.js";
import { computeEdge, type MarketStateResult } from "./edge.js";
import { parseEvent, type GammaEvent } from "./polymarket-parse.js";
import type { MarketRow, RecordAlertInput, SnapshotInput, UpsertMarketInput } from "./types.js";

/**
 * The hard bound on how many markets one run re-quotes. Each quote is a live fetch per venue, so
 * an unbounded walk over a 150-row watchlist is a nightly fan-out of hundreds of serial requests.
 *
 * A cap needs a KNOWN ordering or it silently drops the valuable half, so this uses `bestBets`'
 * ordering exactly (`read.ts`'s BEST_BETS_SCAN_MAX, same number for the same reason):
 * soonest-closing first, then by id. An edge on a market closing next week is worth more than one
 * closing next year.
 */
export const REFRESH_QUOTE_MAX = 60;

/** How long a settled market stays on the watchlist before discovery may retire it. Thirty days
 *  is long enough that "who won the thing that just finished?" is still answerable from stored
 *  snapshots and the venue's settlement marker (ORB-214 item 6). */
export const RETIRE_AFTER_DAYS = 30;

export interface RefreshDeps {
  now(): Date;
  /** The Gamma client's own method — top events by liquidity, descending. */
  listTopByLiquidity(limit: number): Promise<GammaEvent[]>;
  markets: {
    listMarkets(): Promise<MarketRow[]>;
    upsertPmFields(m: UpsertMarketInput): Promise<void>;
    deleteMarket(id: string): Promise<void>;
  };
  snapshots: { append(s: SnapshotInput): Promise<void> };
  alertState: { record(r: RecordAlertInput): Promise<void> };
  /** The SHIPPED read verb, live path. Same function a conversation calls. */
  marketState(id: string): Promise<MarketStateResult>;
  log?: (line: string) => void;
}

export interface RefreshOptions {
  /** How many top-by-liquidity events to pull. The console owns this knob. */
  watchlistMax: number;
  /** Defaults to {@link REFRESH_QUOTE_MAX}. */
  quoteMax?: number;
  /** Defaults to {@link RETIRE_AFTER_DAYS}. */
  retireAfterDays?: number;
}

export interface RefreshReport {
  /** Top events that parsed and survived canonical-id dedupe. */
  discovered: number;
  /** Canonical ids that were not already on the watchlist. */
  added: string[];
  /** Ids deleted from the watchlist. */
  retired: string[];
  /** Markets that were quoted LIVE (a market that priced no outcome still counts as quoted). */
  quoted: number;
  /** `alertState.record` calls — one per outcome per venue side that carried a de-vigged fair. */
  edgesRecorded: number;
  /** Markets that were candidates for a quote and did not produce one, with the reason. */
  skipped: Array<{ id: string; reason: string }>;
}

const DAY_MS = 86_400_000;

/** Whatever was thrown, as a line a report can carry. A `reason` reading "undefined" is worse
 *  than useless — it looks like a bug in us rather than a failure out there. */
function reason(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

/** ISO → epoch ms, or null when the string is absent or unparseable. */
function endMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export async function refreshWatchlist(deps: RefreshDeps, opts: RefreshOptions): Promise<RefreshReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const quoteMax = opts.quoteMax ?? REFRESH_QUOTE_MAX;
  const retireAfterDays = opts.retireAfterDays ?? RETIRE_AFTER_DAYS;

  // ONE instant for the whole run. Every snapshot this pass writes carries it, so the read path
  // can group a venue's book by instant and de-vig it — which it cannot do if each write stamps
  // its own arrival time.
  const now = deps.now();
  const nowMs = now.getTime();
  const ts = now.toISOString();

  // ── 1. discover ────────────────────────────────────────────────────────────────────────────
  const topEvents = await deps.listTopByLiquidity(opts.watchlistMax);

  const seen = new Set<string>();
  const toUpsert: UpsertMarketInput[] = [];
  for (const event of topEvents) {
    let spec: ReturnType<typeof parseEvent>;
    let id: string;
    try {
      spec = parseEvent(event);
      // Inside the try on purpose: an event Gamma served without a slug reaches
      // canonicalMarketId as undefined and throws there, not in the parser.
      id = canonicalMarketId(event.slug);
    } catch (err) {
      // One malformed event is not a failed sweep. parseEvent is already best-effort per
      // sub-market; this catches the event-level failures (no `markets`, no title, no slug).
      log(`markets refresh: skipping event ${event?.slug ?? "(no slug)"} (${reason(err)})`);
      continue;
    }
    if (seen.has(id)) {
      log(`markets refresh: slug collision — "${event.slug}" collapses to "${id}" (already seen, skipping)`);
      continue;
    }
    seen.add(id);
    toUpsert.push({
      id,
      label: spec.question,
      pmMarketId: event.slug,
      marketType: spec.mutuallyExclusive ? "mutually_exclusive" : "independent",
      endDateIso: spec.endDateIso ?? null,
    });
  }

  const before = await deps.markets.listMarkets();
  const beforeIds = new Set(before.map((r) => r.id));
  const added = toUpsert.filter((m) => !beforeIds.has(m.id)).map((m) => m.id);

  for (const m of toUpsert) await deps.markets.upsertPmFields(m);

  // ── 2. retire ──────────────────────────────────────────────────────────────────────────────
  const topIds = new Set(toUpsert.map((m) => m.id));
  const retireBefore = nowMs - retireAfterDays * DAY_MS;
  const retired: string[] = [];
  for (const row of before) {
    if (topIds.has(row.id)) continue;                                  // still one of the biggest
    if (row.kalshiEventTicker && row.kalshiEventTicker.trim() !== "") continue; // hand-paired; not ours to drop
    const end = endMs(row.endDateIso);
    if (end === null || end >= retireBefore) continue;                 // open, undated, or freshly settled
    await deps.markets.deleteMarket(row.id);
    retired.push(row.id);
  }

  // ── 3. re-quote ────────────────────────────────────────────────────────────────────────────
  // Re-read rather than reconstruct: the watchlist after the upserts and deletes above is what
  // the DB says it is, and a second copy of that arithmetic here is a drift waiting to happen.
  const watchlist = await deps.markets.listMarkets();
  const open = watchlist.filter((m) => {
    const end = endMs(m.endDateIso);
    return end === null || end > nowMs;
  });
  // `bestBets`' ordering, for the reason stated on REFRESH_QUOTE_MAX. Undated rows sort last —
  // nothing says when they resolve.
  const sortKey = (m: MarketRow): number => endMs(m.endDateIso) ?? Number.POSITIVE_INFINITY;
  const toQuote = [...open].sort((a, b) => sortKey(a) - sortKey(b) || a.id.localeCompare(b.id)).slice(0, quoteMax);

  const report: RefreshReport = { discovered: toUpsert.length, added, retired, quoted: 0, edgesRecorded: 0, skipped: [] };

  for (const row of toQuote) {
    let state: MarketStateResult;
    try {
      state = await deps.marketState(row.id);
    } catch (err) {
      // One unreachable market must not end the pass halfway through, leaving a partial book
      // written and no report to say so.
      report.skipped.push({ id: row.id, reason: reason(err) });
      continue;
    }
    if (!state.ok) {
      report.skipped.push({ id: row.id, reason: state.reason });
      continue;
    }
    if (state.source !== "live") {
      // The stored path answered, which means the venues did not. Writing a snapshot from a
      // snapshot would manufacture an observation that never happened.
      report.skipped.push({ id: row.id, reason: "stored — venues unreachable" });
      continue;
    }

    for (const outcome of state.outcomes) {
      for (const [venue, side] of [
        ["polymarket", outcome.polymarket],
        ["kalshi", outcome.kalshi],
      ] as const) {
        if (!side) continue;
        // THE KEY SPACE IS THE VENUE'S, NOT OURS. See the header.
        const ref = outcome.venueOutcomes?.[venue];
        if (!ref) {
          // Cannot happen for a state `makeMarketsRead` produced — `alignOutcomes` fills the venue
          // id for every venue whose quote is present. A hand-built state can omit it, and filing
          // the row under the canonical key would make it unreadable, so say so rather than write
          // silently into a key space nothing reads.
          log(`markets refresh: ${row.id}/${outcome.outcomeId} carries a ${venue} quote with no ${venue} outcome id; writing under the canonical key, which the read path cannot look up`);
        }
        const outcomeId = ref?.outcomeId ?? outcome.outcomeId;
        await deps.snapshots.append({
          marketId: row.id,
          outcomeId,
          // The venue's OWN spelling, not the aligned display label: an aliased "Turkiye" stays
          // "Turkiye" on the Kalshi row, which is what `storedState` re-canonicalises from and
          // what makes the stored path pair the two venues again on the next read.
          label: ref ? ref.label : outcome.label,
          venue,
          ask: side.ask,
          bid: null,
          mid: null,
          liquidity: null,
          ts,
        });
        // `fair` is null wherever a de-vig would be dishonest, and an edge measured against no
        // fair is not a number. An outcome priced on BOTH venues therefore writes TWO rows, one
        // per venue id, which is what `recordedEdge` expects: it reads both and takes the newer.
        if (side.fair != null) {
          await deps.alertState.record({
            marketId: row.id,
            outcomeId,
            edge: computeEdge(side.fair, side.ask),
            basis: side.fair,
            alertedAtIso: null, // never advanced by this job — nothing here announces anything
          });
          report.edgesRecorded += 1;
        }
      }
    }
    report.quoted += 1;
  }

  return report;
}
