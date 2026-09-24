/**
 * ORB-214 review fix — `/markets` degrades per section instead of 500ing wholesale.
 *
 * `getMarketsView` used to `Promise.all` five reads, three of which touch `tyche_*` tables the
 * MARKET ENGINE owns and that need not exist on a box where the refresh was never installed. One
 * missing relation therefore took down the whole page — including the refresh switch and the
 * watchlist-size control, which are exactly what an owner reaches for when the engine is in a bad
 * state. The `getProactivityView` pattern (`lib/proactivity.ts`) applies: catch each read by name,
 * fall back, and put the failure on the page as text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/db", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../lib/db";
import { getMarketsView } from "../lib/markets";

const mockedQuery = vi.mocked(pool.query);

/** The real error a missing table gives back — pg's own 42P01 message text, verbatim in shape. */
const MISSING_TABLE = 'relation "tyche_markets" does not exist';

/**
 * Answers each query by the table it names. `absent` lists the tables that throw as if they had
 * never been created.
 */
function withTables(absent: readonly string[]) {
  mockedQuery.mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    for (const t of absent) {
      if (text.includes(t)) throw new Error(`relation "${t}" does not exist`);
    }
    if (text.includes("markets_settings")) {
      return { rows: [{ refresh_enabled: true, watchlist_max: 120 }], rowCount: 1 };
    }
    if (text.includes("tyche_markets") && text.includes("count(*)")) {
      return { rows: [{ open: 4, settled: 1, with_kalshi_link: 2 }], rowCount: 1 };
    }
    if (text.includes("heartbeat")) {
      return { rows: [{ updated_at: new Date("2026-09-08T04:00:00Z") }], rowCount: 1 };
    }
    if (text.includes("tyche_market_snapshots")) {
      return { rows: [{ last_ts: new Date("2026-09-08T03:00:00Z") }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  mockedQuery.mockReset();
  vi.resetModules();
});

describe("getMarketsView", () => {
  it("reports no errors when every table is there", async () => {
    withTables([]);
    const view = await getMarketsView();
    expect(view.errors).toEqual([]);
    expect(view.settings).toEqual({ refreshEnabled: true, watchlistMax: 120 });
    expect(view.counts).toEqual({ open: 4, settled: 1, withKalshiLink: 2 });
  });

  it("a missing tyche_markets still returns the settings — the switch survives", async () => {
    withTables(["tyche_markets"]);
    const view = await getMarketsView();
    // The switch and the watchlist-size control are what the page needs above all else.
    expect(view.settings).toEqual({ refreshEnabled: true, watchlistMax: 120 });
    expect(view.errors.some((e) => e.startsWith("watchlist unavailable: "))).toBe(true);
    expect(view.errors.join("\n")).toContain(MISSING_TABLE);
    // The section falls back to zeroes rather than disappearing, and the FAILURE is what is
    // printed — a silent 0/0/0 would read as an empty watchlist, which is a different fact.
    expect(view.counts).toEqual({ open: 0, settled: 0, withKalshiLink: 0 });
  });

  it("a missing snapshots table costs only the last-observation line", async () => {
    withTables(["tyche_market_snapshots"]);
    const view = await getMarketsView();
    expect(view.lastObservation).toBeNull();
    expect(view.counts.open).toBe(4);
    expect(view.errors).toEqual([expect.stringMatching(/^last observation unavailable: /u)]);
  });

  it("every tyche table missing at once names every section, and still renders the settings", async () => {
    withTables(["tyche_markets", "tyche_market_snapshots", "tyche_alert_state"]);
    const view = await getMarketsView();
    expect(view.settings.refreshEnabled).toBe(true);
    expect(view.recentAlerts).toEqual([]);
    expect(view.errors).toHaveLength(3);
    expect(view.errors.map((e) => e.split(" unavailable")[0]).sort()).toEqual([
      "last observation",
      "recorded edges",
      "watchlist",
    ]);
  });

  it("the settings read is NOT swallowed — a console with no controls must fail loudly", async () => {
    // `markets_settings` ships in the same migration as the page's own switch. Falling back to
    // "off" there would render a switch that is lying about production.
    withTables(["markets_settings"]);
    await expect(getMarketsView()).rejects.toThrow(/markets_settings/u);
  });
});

describe("/markets renders the errors", () => {
  it("puts each failed section's line in the markup, above the controls", async () => {
    withTables(["tyche_markets"]);
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: MarketsPage } = await import("../app/markets/page");
    const html = renderToStaticMarkup(await MarketsPage());

    expect(html).toContain("watchlist unavailable: ");
    // React escapes the quotes pg puts round the relation name, so the message is matched by its
    // unquoted tail — the point is that the REAL error reaches the page, not a generic apology.
    expect(html).toContain("does not exist");
    expect(html).toContain("tyche_markets");
    // The controls are still on the page — that is the whole point of degrading per section.
    expect(html).toContain("Refresh");
    expect(html).toContain("Watchlist size");
    expect(html.indexOf("watchlist unavailable")).toBeLessThan(html.indexOf("Watchlist size"));
  });

  it("renders no error card at all on a healthy page", async () => {
    withTables([]);
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: MarketsPage } = await import("../app/markets/page");
    const html = renderToStaticMarkup(await MarketsPage());
    expect(html).not.toContain("unavailable: ");
  });
});
