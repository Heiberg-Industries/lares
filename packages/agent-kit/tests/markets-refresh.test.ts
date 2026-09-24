// The watchlist refresh JOB (ORB-214 item 1, Task 6).
//
// The ORB-189 fold kept only the READ halves of the three markets stores; the survey loop that
// wrote them was retired whole — judge, alerting, posting and all. This file is the contract for
// what came back: ONE job that discovers by Polymarket liquidity, retires long-settled unlinked
// rows, re-quotes the open ones through the SHIPPED `marketState` live path, and records each
// priced outcome's edge. Nothing else. No judge, no alert, no post, no channel.
//
// Orchestration only — every dependency is a fake here on purpose. The SQL the fakes stand in for
// is proved against a real Postgres in markets-store.test.ts / markets-snapshots-store.test.ts /
// markets-edge-state.test.ts (the write-half describes at the bottom of each), because a fake
// pool can only ever re-confirm what we believe the SQL does.
import { describe, it, expect } from "vitest";
import {
  refreshWatchlist,
  REFRESH_QUOTE_MAX,
  RETIRE_AFTER_DAYS,
  type RefreshDeps,
  type RefreshReport,
} from "../src/markets/refresh.js";
import { computeEdge, type MarketStateResult } from "../src/markets/edge.js";
import type { GammaEvent } from "../src/markets/polymarket-parse.js";
import type { MarketRow, RecordAlertInput, SnapshotInput, UpsertMarketInput } from "../src/markets/types.js";

const NOW = "2026-09-08T12:00:00.000Z";
const nowMs = Date.parse(NOW);
const daysAgo = (n: number) => new Date(nowMs - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(nowMs + n * 86_400_000).toISOString();

// ── the fakes ────────────────────────────────────────────────────────────────────────────────

/** A watched row, with the fields the job actually reads. */
const watched = (over: Partial<MarketRow> & { id: string }): MarketRow => ({
  label: over.id,
  pmMarketId: over.id,
  kalshiEventTicker: null,
  outcomeAliases: {},
  endDateIso: null,
  marketType: "mutually_exclusive",
  ...over,
});

/**
 * In-memory stands-in for the three stores. `upsertPmFields` mirrors the real SQL's
 * link-preservation (never nulls `kalshi_event_ticker`, never touches `outcome_aliases`) — which
 * is an ASSUMPTION here and a proof in markets-store.test.ts's real-pg write-half describe.
 */
function fakeStores(seed: MarketRow[] = []) {
  const rows = new Map<string, MarketRow>(seed.map((r) => [r.id, r]));
  const upserts: UpsertMarketInput[] = [];
  const deleted: string[] = [];
  const appended: SnapshotInput[] = [];
  const recorded: RecordAlertInput[] = [];

  return {
    rows,
    upserts,
    deleted,
    appended,
    recorded,
    markets: {
      async listMarkets(): Promise<MarketRow[]> {
        return [...rows.values()];
      },
      async upsertPmFields(m: UpsertMarketInput): Promise<void> {
        upserts.push(m);
        const prev = rows.get(m.id);
        rows.set(m.id, {
          id: m.id,
          label: m.label,
          pmMarketId: m.pmMarketId ?? null,
          kalshiEventTicker: prev?.kalshiEventTicker ?? null,
          outcomeAliases: prev?.outcomeAliases ?? {},
          endDateIso: m.endDateIso ?? null,
          marketType: m.marketType ?? "mutually_exclusive",
        });
      },
      async deleteMarket(id: string): Promise<void> {
        deleted.push(id);
        rows.delete(id);
      },
    },
    snapshots: { async append(s: SnapshotInput): Promise<void> { appended.push(s); } },
    alertState: { async record(r: RecordAlertInput): Promise<void> { recorded.push(r); } },
  };
}

/** A parser-valid Gamma event: one negRisk sub-market per outcome. */
function gammaEvent(slug: string, title: string, endDate: string, outcomes: Array<[string, string]>): GammaEvent {
  return {
    slug,
    title,
    negRisk: true,
    endDate,
    markets: outcomes.map(([label, price], i) => ({
      question: `Will ${label} win ${title}?`,
      slug: `${slug}-${i}`,
      conditionId: `0xc0ffee${i}`,
      groupItemTitle: label,
      outcomes: '["Yes", "No"]',
      outcomePrices: `["${price}", "0.50"]`,
      clobTokenIds: `["tok-${slug}-${i}", "tok-${slug}-${i}-no"]`,
      liquidityNum: 1000,
      active: true,
      closed: false,
    })),
  };
}

/** One venue's side of an outcome. `id` and `label` are what THAT venue published — the key space
 *  both written tables actually use; they default to a venue-prefixed id so a test that does not
 *  care still exercises the real (canonical key ≠ written key) shape. */
type Side = { ask: number; fair: number | null; id?: string; label?: string | null };

/** A state shaped exactly like `makeMarketsRead`'s live path: outcomes keyed by the CANONICAL key
 *  with each venue's own id and spelling carried alongside in `venueOutcomes`. */
const liveState = (
  id: string,
  outcomes: Array<{ outcomeId: string; label: string | null; polymarket?: Side; kalshi?: Side }>,
): MarketStateResult => ({
  ok: true,
  source: "live",
  asOfIso: null,
  market: { id, label: id, endDateIso: null },
  outcomes: outcomes.map((o) => ({
    outcomeId: o.outcomeId,
    label: o.label,
    venueOutcomes: {
      ...(o.polymarket ? { polymarket: { outcomeId: o.polymarket.id ?? `pm-${o.outcomeId}`, label: o.polymarket.label ?? o.label } } : {}),
      ...(o.kalshi ? { kalshi: { outcomeId: o.kalshi.id ?? `kx-${o.outcomeId}`, label: o.kalshi.label ?? o.label } } : {}),
    },
    polymarket: o.polymarket ? { ask: o.polymarket.ask, fair: o.polymarket.fair } : null,
    kalshi: o.kalshi ? { ask: o.kalshi.ask, fair: o.kalshi.fair } : null,
    lastEdge: null,
    lastBasis: null,
  })),
});

function makeDeps(over: Partial<RefreshDeps> & { markets?: RefreshDeps["markets"] } = {}): {
  deps: RefreshDeps;
  logs: string[];
} {
  const logs: string[] = [];
  const empty = fakeStores();
  return {
    logs,
    deps: {
      now: () => new Date(NOW),
      listTopByLiquidity: async () => [],
      markets: empty.markets,
      snapshots: empty.snapshots,
      alertState: empty.alertState,
      marketState: async () => ({ ok: false as const, reason: "no fake state wired" }),
      log: (line: string) => logs.push(line),
      ...over,
    },
  };
}

// ── discovery ────────────────────────────────────────────────────────────────────────────────

describe("refreshWatchlist — discovery", () => {
  it("upserts every parsed top event and counts as `added` only the ids not already watched", async () => {
    const s = fakeStores([watched({ id: "wc26-nba-champion", label: "NBA Champion (old label)" })]);
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      listTopByLiquidity: async () => [
        gammaEvent("nba-champion", "NBA Champion", daysAhead(200), [["Celtics", "0.30"], ["Nuggets", "0.20"]]),
        gammaEvent("uk-election", "Next UK PM", daysAhead(400), [["Starmer", "0.60"]]),
      ],
    });

    const report = await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(report.discovered).toBe(2);
    expect(report.added).toEqual(["wc26-uk-election"]);
    expect(s.upserts.map((u) => u.id).sort()).toEqual(["wc26-nba-champion", "wc26-uk-election"]);
    // the label of the already-watched row is refreshed from Gamma
    expect(s.rows.get("wc26-nba-champion")!.label).toBe("NBA Champion");
  });

  it("the upsert input carries ONLY the Polymarket fields — no kalshi ticker, no aliases", async () => {
    const s = fakeStores();
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      listTopByLiquidity: async () => [gammaEvent("uk-election", "Next UK PM", daysAhead(400), [["Starmer", "0.60"]])],
    });

    await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(Object.keys(s.upserts[0]).sort()).toEqual(["endDateIso", "id", "label", "marketType", "pmMarketId"]);
    expect(s.upserts[0]).toMatchObject({
      id: "wc26-uk-election",
      label: "Next UK PM",
      pmMarketId: "uk-election",
      marketType: "mutually_exclusive",
      endDateIso: daysAhead(400),
    });
  });

  it("a link already on the row survives the upsert — discovery never unlinks a paired market", async () => {
    const s = fakeStores([watched({ id: "wc26-uk-election", kalshiEventTicker: "KXPM", outcomeAliases: { Starmer: ["Sir Keir"] } })]);
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      listTopByLiquidity: async () => [gammaEvent("uk-election", "Next UK PM", daysAhead(400), [["Starmer", "0.60"]])],
    });

    await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(s.rows.get("wc26-uk-election")!.kalshiEventTicker).toBe("KXPM");
    expect(s.rows.get("wc26-uk-election")!.outcomeAliases).toEqual({ Starmer: ["Sir Keir"] });
  });

  it("an event whose parse throws is logged and skipped, and the rest of the sweep continues", async () => {
    const s = fakeStores();
    const broken = { slug: "broken-event", title: "Broken" } as unknown as GammaEvent; // no `markets` → parseEvent throws
    const { deps, logs } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      listTopByLiquidity: async () => [broken, gammaEvent("uk-election", "Next UK PM", daysAhead(400), [["Starmer", "0.60"]])],
    });

    const report = await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(report.discovered).toBe(1);
    expect(report.added).toEqual(["wc26-uk-election"]);
    expect(logs.join("\n")).toContain("broken-event");
  });

  it("two slugs that collapse to one canonical id are deduped, first seen wins", async () => {
    const s = fakeStores();
    const { deps, logs } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      listTopByLiquidity: async () => [
        gammaEvent("which-continent-will-win", "Which continent wins", daysAhead(100), [["Europe", "0.60"]]),
        gammaEvent("which-continent-will-win-the-world-cup", "Which continent wins (dup)", daysAhead(100), [["Europe", "0.60"]]),
      ],
    });

    const report = await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(report.discovered).toBe(1);
    expect(s.upserts).toHaveLength(1);
    expect(s.upserts[0].pmMarketId).toBe("which-continent-will-win"); // first seen
    expect(logs.join("\n")).toContain("which-continent-will-win-the-world-cup");
  });
});

// ── retirement ───────────────────────────────────────────────────────────────────────────────

describe("refreshWatchlist — retirement (both directions)", () => {
  const retireCase = async (rows: MarketRow[], opts: { retireAfterDays?: number } = {}) => {
    const s = fakeStores(rows);
    const { deps } = makeDeps({ markets: s.markets, snapshots: s.snapshots, alertState: s.alertState });
    const report = await refreshWatchlist(deps, { watchlistMax: 20, ...opts });
    return { report, s };
  };

  it("a row settled longer ago than the window, not in the top set and with no Kalshi link, is retired", async () => {
    const { report, s } = await retireCase([watched({ id: "old", endDateIso: daysAgo(45) })]);
    expect(report.retired).toEqual(["old"]);
    expect(s.deleted).toEqual(["old"]);
  });

  it("a row settled that long ago but WITH a Kalshi link is kept — a manual pairing is not discovery's to drop", async () => {
    const { report, s } = await retireCase([watched({ id: "old", endDateIso: daysAgo(45), kalshiEventTicker: "KXOLD" })]);
    expect(report.retired).toEqual([]);
    expect(s.deleted).toEqual([]);
  });

  it("a row settled 10 days ago is kept — a recently settled market still answers \"settled, X won\"", async () => {
    const { report } = await retireCase([watched({ id: "recent", endDateIso: daysAgo(10) })]);
    expect(report.retired).toEqual([]);
  });

  it("an OPEN row that fell out of the top set is kept — this is not the retired loop's \"drop every stale unlinked row\"", async () => {
    const { report } = await retireCase([watched({ id: "open", endDateIso: daysAhead(30) })]);
    expect(report.retired).toEqual([]);
  });

  it("a row with no end date is kept — nothing says it settled", async () => {
    const { report } = await retireCase([watched({ id: "undated", endDateIso: null })]);
    expect(report.retired).toEqual([]);
  });

  it("the window is an option, defaulting to RETIRE_AFTER_DAYS", async () => {
    expect(RETIRE_AFTER_DAYS).toBe(30);
    const { report } = await retireCase([watched({ id: "old", endDateIso: daysAgo(20) })], { retireAfterDays: 5 });
    expect(report.retired).toEqual(["old"]);
  });

  it("a row still in the top set is never retired, however old its stored end date", async () => {
    const s = fakeStores([watched({ id: "wc26-uk-election", endDateIso: daysAgo(400) })]);
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      listTopByLiquidity: async () => [gammaEvent("uk-election", "Next UK PM", daysAhead(400), [["Starmer", "0.60"]])],
    });
    const report = await refreshWatchlist(deps, { watchlistMax: 20 });
    expect(report.retired).toEqual([]);
    expect(s.deleted).toEqual([]);
  });
});

// ── quoting ──────────────────────────────────────────────────────────────────────────────────

describe("refreshWatchlist — quoting", () => {
  it("quotes open rows soonest-closing first, then by id, and stops at quoteMax", async () => {
    const s = fakeStores([
      watched({ id: "d", endDateIso: daysAhead(40) }),
      watched({ id: "b", endDateIso: daysAhead(10) }),
      watched({ id: "a", endDateIso: daysAhead(10) }),
      watched({ id: "z", endDateIso: null }), // no end date sorts last
      watched({ id: "c", endDateIso: daysAhead(20) }),
    ]);
    const asked: string[] = [];
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      marketState: async (id: string) => {
        asked.push(id);
        return { ok: false as const, reason: "not quoted in this test" };
      },
    });

    await refreshWatchlist(deps, { watchlistMax: 20, quoteMax: 3 });

    expect(asked).toEqual(["a", "b", "c"]);
  });

  it("a settled row is not a quote candidate at all — neither quoted nor skipped", async () => {
    const s = fakeStores([watched({ id: "settled", endDateIso: daysAgo(5) })]);
    const asked: string[] = [];
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      marketState: async (id: string) => {
        asked.push(id);
        return { ok: false as const, reason: "x" };
      },
    });

    const report = await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(asked).toEqual([]);
    expect(report.quoted).toBe(0);
    expect(report.skipped).toEqual([]);
  });

  it("quoteMax defaults to REFRESH_QUOTE_MAX", async () => {
    expect(REFRESH_QUOTE_MAX).toBe(60);
    const s = fakeStores(Array.from({ length: 70 }, (_, i) => watched({ id: `m${String(i).padStart(3, "0")}`, endDateIso: daysAhead(i + 1) })));
    const asked: string[] = [];
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      marketState: async (id: string) => {
        asked.push(id);
        return { ok: false as const, reason: "x" };
      },
    });

    await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(asked).toHaveLength(REFRESH_QUOTE_MAX);
    expect(asked[0]).toBe("m000");
  });

  it("an `ok: false` state is skipped WITH its reason and writes nothing", async () => {
    const s = fakeStores([watched({ id: "m1", endDateIso: daysAhead(5) })]);
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      marketState: async () => ({ ok: false as const, reason: "settled — this market closed on 2026-07-19" }),
    });

    const report = await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(report.skipped).toEqual([{ id: "m1", reason: "settled — this market closed on 2026-07-19" }]);
    expect(report.quoted).toBe(0);
    expect(s.appended).toEqual([]);
    expect(s.recorded).toEqual([]);
  });

  it("a STORED state writes nothing — a re-quote that fell back to storage is not an observation", async () => {
    const s = fakeStores([watched({ id: "m1", endDateIso: daysAhead(5) })]);
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      marketState: async () => ({
        ok: true as const,
        source: "stored" as const,
        asOfIso: "2026-09-01T00:00:00.000Z",
        market: { id: "m1", label: "m1", endDateIso: null },
        outcomes: [{ outcomeId: "o1", label: "Yes", polymarket: { ask: 0.4, fair: 0.42 }, kalshi: null, lastEdge: null, lastBasis: null }],
      }),
    });

    const report = await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(report.quoted).toBe(0);
    expect(report.skipped).toEqual([{ id: "m1", reason: "stored — venues unreachable" }]);
    expect(s.appended).toEqual([]);
    expect(s.recorded).toEqual([]);
  });

  it("a live state writes one snapshot per outcome per venue side, and one edge record per priced fair", async () => {
    const s = fakeStores([watched({ id: "m1", endDateIso: daysAhead(5) })]);
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      marketState: async () =>
        liveState("m1", [
          { outcomeId: "spain", label: "Spain", polymarket: { ask: 0.3, fair: 0.32 }, kalshi: { ask: 0.31, fair: null } },
          { outcomeId: "brazil", label: "Brazil", polymarket: { ask: 0.55, fair: 0.58 }, kalshi: { ask: 0.56, fair: null } },
        ]),
    });

    const report = await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(report.quoted).toBe(1);
    expect(report.edgesRecorded).toBe(2);
    expect(s.appended).toHaveLength(4); // 2 outcomes × 2 venue sides
    expect(s.appended.filter((a) => a.venue === "polymarket")).toHaveLength(2);
    expect(s.appended.filter((a) => a.venue === "kalshi")).toHaveLength(2);
    expect(s.appended[0]).toMatchObject({
      marketId: "m1",
      outcomeId: "pm-spain",   // the VENUE's id, never the canonical key
      label: "Spain",
      venue: "polymarket",
      ask: 0.3,
      bid: null,
      mid: null,
      liquidity: null,
      ts: NOW,
    });
    // only the sides carrying a de-vigged fair produce a recorded edge
    expect(s.recorded).toEqual([
      { marketId: "m1", outcomeId: "pm-spain", edge: computeEdge(0.32, 0.3), basis: 0.32, alertedAtIso: null },
      { marketId: "m1", outcomeId: "pm-brazil", edge: computeEdge(0.58, 0.55), basis: 0.58, alertedAtIso: null },
    ]);
  });

  it("each venue's rows are keyed by THAT venue's id and carry THAT venue's spelling", async () => {
    // The alias case, which is where a canonical key and a venue key visibly differ: the row says
    // "Turkiye" means "Turkey", so both venues align onto "turkey" for a READER — and both tables
    // still have to be written under the ids and spellings the venues themselves published.
    const s = fakeStores([watched({ id: "m1", endDateIso: daysAhead(5), kalshiEventTicker: "KXWC" })]);
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      marketState: async () =>
        liveState("m1", [
          {
            outcomeId: "turkey", // the canonical key
            label: "Turkey",
            polymarket: { ask: 0.2, fair: 0.22, id: "8571029384756102938", label: "Turkey" },
            kalshi: { ask: 0.21, fair: 0.23, id: "KXWC-TUR", label: "Turkiye" },
          },
        ]),
    });

    await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(s.appended.map((a) => [a.venue, a.outcomeId, a.label])).toEqual([
      ["polymarket", "8571029384756102938", "Turkey"],
      ["kalshi", "KXWC-TUR", "Turkiye"],
    ]);
    // TWO rows, one per venue id — not one row written twice. `recordedEdge` reads both and takes
    // the newer; a single canonical row would be read by neither.
    expect(s.recorded.map((r) => [r.outcomeId, r.basis])).toEqual([
      ["8571029384756102938", 0.22],
      ["KXWC-TUR", 0.23],
    ]);
  });

  it("a state carrying NO venue ids falls back to the canonical key and says so out loud", async () => {
    const s = fakeStores([watched({ id: "m1", endDateIso: daysAhead(5) })]);
    const { deps, logs } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      // A hand-built state, the way an older caller or a fixture might shape one.
      marketState: async () => ({
        ok: true as const,
        source: "live" as const,
        asOfIso: null,
        market: { id: "m1", label: "m1", endDateIso: null },
        outcomes: [{ outcomeId: "spain", label: "Spain", polymarket: { ask: 0.3, fair: 0.32 }, kalshi: null, lastEdge: null, lastBasis: null }],
      }),
    });

    await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(s.appended[0].outcomeId).toBe("spain");
    expect(logs.join("\n")).toContain("the read path cannot look up");
  });

  it("every snapshot of one run shares ONE instant — prob-history groups by it", async () => {
    const s = fakeStores([
      watched({ id: "m1", endDateIso: daysAhead(5) }),
      watched({ id: "m2", endDateIso: daysAhead(6) }),
    ]);
    let ticks = 0;
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      // a clock that MOVES between calls: the job must read it once per run, not once per write
      now: () => new Date(nowMs + ticks++ * 1000),
      marketState: async (id: string) =>
        liveState(id, [
          { outcomeId: "a", label: "A", polymarket: { ask: 0.4, fair: 0.45 } },
          { outcomeId: "b", label: "B", polymarket: { ask: 0.6, fair: 0.55 } },
        ]),
    });

    await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(s.appended).toHaveLength(4);
    expect(new Set(s.appended.map((a) => a.ts)).size).toBe(1);
  });

  it("an outcome with no venue side at all writes nothing for that outcome", async () => {
    const s = fakeStores([watched({ id: "m1", endDateIso: daysAhead(5) })]);
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      marketState: async () => liveState("m1", [{ outcomeId: "ghost", label: "Ghost" }]),
    });

    const report = await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(s.appended).toEqual([]);
    expect(s.recorded).toEqual([]);
    expect(report.quoted).toBe(1); // the market WAS quoted live; it simply priced nothing
  });

  it("newly discovered open markets are quoted in the same run", async () => {
    const s = fakeStores();
    const asked: string[] = [];
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      listTopByLiquidity: async () => [gammaEvent("uk-election", "Next UK PM", daysAhead(400), [["Starmer", "0.60"]])],
      marketState: async (id: string) => {
        asked.push(id);
        return liveState(id, [{ outcomeId: "starmer", label: "Starmer", polymarket: { ask: 0.6, fair: 0.62 } }]);
      },
    });

    const report = await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(asked).toEqual(["wc26-uk-election"]);
    expect(report.quoted).toBe(1);
    expect(report.edgesRecorded).toBe(1);
  });

  it("a retired row is not quoted afterwards", async () => {
    const s = fakeStores([watched({ id: "old", endDateIso: daysAgo(45) }), watched({ id: "live", endDateIso: daysAhead(3) })]);
    const asked: string[] = [];
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      marketState: async (id: string) => {
        asked.push(id);
        return liveState(id, []);
      },
    });

    await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(asked).toEqual(["live"]);
  });

  it("a marketState that THROWS is skipped with the error, and the run continues", async () => {
    const s = fakeStores([
      watched({ id: "a", endDateIso: daysAhead(1) }),
      watched({ id: "b", endDateIso: daysAhead(2) }),
    ]);
    const { deps } = makeDeps({
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      marketState: async (id: string) => {
        if (id === "a") throw new Error("connection terminated unexpectedly");
        return liveState(id, [{ outcomeId: "o", label: "O", polymarket: { ask: 0.5, fair: 0.5 } }]);
      },
    });

    const report = await refreshWatchlist(deps, { watchlistMax: 20 });

    expect(report.skipped).toEqual([{ id: "a", reason: "connection terminated unexpectedly" }]);
    expect(report.quoted).toBe(1);
  });
});

// ── the shape of the job itself ──────────────────────────────────────────────────────────────

describe("refreshWatchlist is a JOB, not an initiation", () => {
  it("the dep type carries nothing that could post, think or judge — and refuses one", () => {
    const s = fakeStores();
    const deps: RefreshDeps = {
      now: () => new Date(NOW),
      listTopByLiquidity: async () => [],
      markets: s.markets,
      snapshots: s.snapshots,
      alertState: s.alertState,
      marketState: async () => ({ ok: false as const, reason: "x" }),
      log: () => {},
    };

    // Every member the type ALLOWS is present above, so this is the whole surface.
    for (const key of Object.keys(deps)) {
      expect(/send|post|think|emit|announce|say|channel|initiate|card|judge/i.test(key)).toBe(false);
    }
    for (const nested of [deps.markets, deps.snapshots, deps.alertState]) {
      for (const key of Object.keys(nested)) {
        expect(/send|post|think|emit|announce|say|channel|initiate|card|judge/i.test(key)).toBe(false);
      }
    }
    // `alertState` is named for the TABLE (`tyche_alert_state`), and the one thing it can do is
    // record a measurement. There is no verb here that could make an alert happen.
    expect(Object.keys(deps.alertState)).toEqual(["record"]);

    // The retired survey's `discoverWatchlist` took an `announce`. The TYPE is what refuses it now.
    const withAnnounce: RefreshDeps = {
      now: deps.now,
      listTopByLiquidity: deps.listTopByLiquidity,
      markets: deps.markets,
      snapshots: deps.snapshots,
      alertState: deps.alertState,
      marketState: deps.marketState,
      // @ts-expect-error — RefreshDeps has no `announce`: no post originates in this job.
      announce: async (_msg: string) => {},
    };
    expect(withAnnounce).toBeTruthy();
  });

  it("the report is six counts and nothing that says anything was delivered", async () => {
    const { deps } = makeDeps();
    const report: RefreshReport = await refreshWatchlist(deps, { watchlistMax: 20 });
    expect(Object.keys(report).sort()).toEqual(["added", "discovered", "edgesRecorded", "quoted", "retired", "skipped"]);
  });
});

// ── the acceptance property, against a REAL Postgres ─────────────────────────────────────────
//
// WHAT A FAKE CANNOT SHOW. Every test above hands the job a fake store that answers under
// whatever key the job wrote, so a job writing into a key space NOTHING READS passes all of them.
// That is exactly the defect this file exists to keep out: `marketState` keys its outcomes by the
// canonical alias-folded label, while `tyche_alert_state` and `tyche_market_snapshots` are keyed
// by the venue's own outcome id — write the former into the latter and the whole third phase of
// the nightly job is a silent no-op for every reader.
//
// So the assertion is a ROUND TRIP over real tables: refresh writes, and the SAME `marketState`
// (and `bestBets`) reads the numbers back. Real stores, real SQL, one fake — the live venue quote,
// because the point is the key space, not the network.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeMarketsStore } from "../src/markets/markets-store.js";
import { makeSnapshotsStore } from "../src/markets/snapshots-store.js";
import { makeEdgeStateStore } from "../src/markets/edge-state.js";
import { makeMarketsRead } from "../src/markets/read.js";
import { prob } from "../src/markets/probability/types.js";
import type { QuotedMarket } from "../src/markets/venue-quotes.js";

// The agent box's DDL — `sql/037_tyche.sql` (LAR-32), applied verbatim from disk.
const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, "..", "..", "..", "services", "box", "sql");
const sql = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

// Real id shapes, so the canonical key ("turkey") and the written keys cannot be confused for one
// another: a Polymarket outcome id is a ~76-digit CLOB token, a Kalshi one is a market ticker.
const TOK_TURKEY = "4394372887385518214471608448209527405727552777602031099972143344338178308080";
const TOK_SPAIN = "8571029384756102938475610293847561029384756102938475610293847561029384756102";

/** A two-venue live quote for the seeded market. Kalshi spells Turkey "Turkiye"; the row's alias
 *  is what pairs them, which is precisely when a canonical key and a venue key differ. */
const quotedMarket = (): QuotedMarket => ({
  row: { id: "wc26-winner", pmMarketId: "wc-pm", kalshiEventTicker: "KXWC", endDateIso: null },
  pmSpec: {
    marketId: "wc-pm", kind: "event", question: "World Cup Winner", mutuallyExclusive: true,
    outcomes: [
      { outcomeId: TOK_TURKEY, label: "Turkey", tokenId: TOK_TURKEY, laggedPrice: 0.2 },
      { outcomeId: TOK_SPAIN, label: "Spain", tokenId: TOK_SPAIN, laggedPrice: 0.3 },
    ],
  },
  pmEstimate: {
    source: "polymarket",
    raw: { [TOK_TURKEY]: prob(0.2), [TOK_SPAIN]: prob(0.3) },
    meta: { mutuallyExclusive: true },
  },
  kalshiSpec: {
    marketId: "KXWC", kind: "event", question: "World Cup Winner", mutuallyExclusive: true,
    outcomes: [
      { outcomeId: "KXWC-TUR", label: "Turkiye", tokenId: "KXWC-TUR", laggedPrice: 0.21 },
      { outcomeId: "KXWC-ESP", label: "Spain", tokenId: "KXWC-ESP", laggedPrice: 0.31 },
    ],
  },
  kalshiEstimate: {
    source: "kalshi",
    raw: { "KXWC-TUR": prob(0.21), "KXWC-ESP": prob(0.31) },
    meta: { mutuallyExclusive: true },
  },
  kalshiUnavailable: null,
  liquidityByOutcome: {},
});

describe("refreshWatchlist round-trips through real Postgres — what it writes, marketState reads", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(sql("037_tyche.sql"));
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE tyche_markets, tyche_market_snapshots, tyche_alert_state");
    await pool.query(
      `INSERT INTO tyche_markets (id, label, pm_market_id, kalshi_event_ticker, outcome_aliases, end_date, market_type)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      ["wc26-winner", "World Cup Winner", "wc-pm", "KXWC", JSON.stringify({ Turkey: ["Turkiye"] }), daysAhead(60), "mutually_exclusive"],
    );
  });

  const stores = () => ({
    markets: makeMarketsStore(pool),
    snapshots: makeSnapshotsStore(pool),
    alertState: makeEdgeStateStore(pool),
  });

  /** The read surface the job quotes through: real stores, one fake live quote. */
  const liveRead = () =>
    makeMarketsRead({ ...stores(), liveQuotes: { get: async () => quotedMarket() }, now: () => new Date(NOW) });

  const runRefresh = async () => {
    const st = stores();
    const read = liveRead();
    return refreshWatchlist(
      {
        now: () => new Date(NOW),
        listTopByLiquidity: async () => [],
        markets: st.markets,
        snapshots: { append: async (s) => { await st.snapshots.append(s); } },
        alertState: st.alertState,
        marketState: (id) => read.marketState(id),
        log: () => {},
      },
      { watchlistMax: 10 },
    );
  };

  it("the edge it records is readable back through the SAME marketState", async () => {
    const report = await runRefresh();
    expect(report.quoted).toBe(1);
    expect(report.edgesRecorded).toBe(4); // 2 outcomes × 2 venues, every side de-vigged

    const state = await liveRead().marketState("wc26-winner");
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("unreachable");
    const turkey = state.outcomes.find((o) => o.outcomeId === "turkey")!;
    // THE ACCEPTANCE PROPERTY: written by the job one call earlier, read back by the reader.
    expect(turkey.lastEdge).not.toBeNull();
    expect(turkey.lastBasis).not.toBeNull();
    expect(turkey.recordedAtIso).not.toBeNull();
    // Both venues priced it, so both rows exist under their own ids.
    const ids = (await pool.query(`SELECT outcome_id FROM tyche_alert_state ORDER BY outcome_id`)).rows.map((r) => r.outcome_id);
    expect(ids).toEqual(["KXWC-ESP", "KXWC-TUR", TOK_SPAIN, TOK_TURKEY].sort());
    expect(ids).not.toContain("turkey"); // never the canonical key
  });

  it("bestBets ranks the outcome the job just measured", async () => {
    await runRefresh();
    const best = await makeMarketsRead({ ...stores(), now: () => new Date(NOW) }).bestBets();
    expect(best.ranked.length).toBeGreaterThan(0);
    for (const entry of best.ranked) expect(entry.lastEdge).not.toBeNull();
    expect(best.ranked.map((e) => e.outcomeId).sort()).toEqual(["spain", "turkey"]);
  });

  it("the snapshots it writes are re-aligned by the STORED path — both venues pair again", async () => {
    await runRefresh();
    // No liveQuotes dep at all: this is the stored path over the rows the job just wrote.
    const stored = await makeMarketsRead({ ...stores(), now: () => new Date(NOW) }).marketState("wc26-winner");
    expect(stored.ok).toBe(true);
    if (!stored.ok) throw new Error("unreachable");
    expect(stored.source).toBe("stored");
    const turkey = stored.outcomes.find((o) => o.outcomeId === "turkey")!;
    expect(turkey.polymarket!.ask).toBeCloseTo(0.2, 6);
    expect(turkey.kalshi!.ask).toBeCloseTo(0.21, 6);   // "Turkiye" folded back onto "Turkey"
    expect(turkey.lastEdge).not.toBeNull();
    expect(stored.asOfIso).toBe(NOW);                  // one instant for the whole run

    // And the rows underneath say what each VENUE published, which is what makes the re-alignment
    // above real rather than a coincidence of two rows we happened to write under one key.
    const rows = (await pool.query(
      `SELECT venue, outcome_id, label FROM tyche_market_snapshots WHERE label IN ('Turkey','Turkiye') ORDER BY venue`,
    )).rows;
    expect(rows).toEqual([
      { venue: "kalshi", outcome_id: "KXWC-TUR", label: "Turkiye" },
      { venue: "polymarket", outcome_id: TOK_TURKEY, label: "Turkey" },
    ]);
  });
});
