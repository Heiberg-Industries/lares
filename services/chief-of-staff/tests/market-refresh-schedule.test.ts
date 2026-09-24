import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  HEARTBEAT_KEY,
  makeMarketRefreshTick,
  type MarketRefreshDeps,
} from "../agent/schedules/market-refresh.js";
import type { RefreshReport } from "@lares/agent-kit/markets";

/**
 * ORB-214 item 1, Task 7 — the nightly refresh job, offline. No pool, no venue, no Telegram: the
 * tick factory takes `settings` and `refresh` as deps, same shape as `deadlines.ts`'s
 * `makeDeadlineLadderTick`.
 */

const REPORT: RefreshReport = {
  discovered: 12,
  added: ["a", "b"],
  retired: ["c"],
  quoted: 8,
  edgesRecorded: 5,
  skipped: [{ id: "d", reason: "no venue link" }],
};

describe("HEARTBEAT_KEY", () => {
  it("is the row sql/036 seeds and input-freshness.sh reads", () => {
    expect(HEARTBEAT_KEY).toBe("saga/market-refresh");
  });
});

describe("this schedule is a job, never an initiation — source-level", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "agent", "schedules", "market-refresh.ts"), "utf8");

  it("imports none of ../channels/, eve/channels/, or lib/initiation — no post originates here", () => {
    expect(src).not.toMatch(/from ["']\.\.\/channels\//);
    expect(src).not.toMatch(/from ["'](\.\.\/)*eve\/channels\//);
    expect(src).not.toMatch(/from ["'](\.\.\/)*lib\/initiation/);
  });
});

function harness(opts: {
  settings?: MarketRefreshDeps["settings"];
  refresh?: MarketRefreshDeps["refresh"];
} = {}) {
  const calls: Array<{ watchlistMax: number }> = [];
  const logged: string[] = [];
  const deps: MarketRefreshDeps = {
    settings: opts.settings ?? (async () => ({ refreshEnabled: true, watchlistMax: 100 })),
    refresh:
      opts.refresh ??
      (async (o) => {
        calls.push(o);
        return REPORT;
      }),
    log: (line) => logged.push(line),
  };
  return { deps, calls, logged };
}

describe("the refresh switch is fail-CLOSED", () => {
  it("OFF: refresh is never called, the tick reports skipped: \"off\"", async () => {
    const h = harness({ settings: async () => ({ refreshEnabled: false, watchlistMax: 100 }) });
    const result = await makeMarketRefreshTick(h.deps).tick();
    expect(result).toEqual({ ran: false, report: null, skipped: "off" });
    expect(h.calls).toEqual([]);
    expect(h.logged.some((l) => l.startsWith("market-refresh: OFF"))).toBe(true);
  });

  it("a THROWING settings read is OFF — a switch we could not read is not a licence to run", async () => {
    const h = harness({
      settings: async () => {
        throw new Error("no such table: markets_settings");
      },
    });
    const result = await makeMarketRefreshTick(h.deps).tick();
    expect(result).toEqual({ ran: false, report: null, skipped: "off" });
    expect(h.calls).toEqual([]);
    expect(h.logged.some((l) => l.startsWith("market-refresh: OFF"))).toBe(true);
  });
});

describe("ON: refresh is called with the watchlistMax settings named", () => {
  it("calls refresh with { watchlistMax } from settings and logs the one-line summary", async () => {
    const h = harness({ settings: async () => ({ refreshEnabled: true, watchlistMax: 42 }) });
    const result = await makeMarketRefreshTick(h.deps).tick();

    expect(h.calls).toEqual([{ watchlistMax: 42 }]);
    expect(result).toEqual({ ran: true, report: REPORT, skipped: null });
    expect(h.logged).toEqual([
      "market-refresh: discovered 12, added 2, retired 1, quoted 8, edges 5, skipped 1",
    ]);
  });

  it("a throwing refresh propagates — the live wiring's outer catch owns it", async () => {
    const h = harness({
      refresh: async () => {
        throw new Error("gamma is unreachable");
      },
    });
    await expect(makeMarketRefreshTick(h.deps).tick()).rejects.toThrow("gamma is unreachable");
  });
});
