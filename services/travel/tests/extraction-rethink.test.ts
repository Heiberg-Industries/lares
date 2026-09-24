/**
 * The 2026-08-17 sweep rethink ("The Big Apple" incident), pinned end to end:
 *   1. extraction results are CACHED — a re-sweep never re-bills a message it understood;
 *   2. a cached no-trip booking REPLAYS against current trip windows on re-sweep — creating
 *      the missing trip turns yesterday's orphans into filings, LLM-free;
 *   3. /nytur retro-files matching orphans the moment the trip is created;
 *   4. orphans clustering in a shared window surface as a "Mulig ny tur" proposal in the
 *      completion report instead of dying inside the no-trip counter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileExtractionCache } from "../lib/extraction-cache.js";
import {
  BookingPipeline,
  orphanClusters,
  type Booking,
  type ReiseMail,
} from "../lib/bookings.js";
import { composeCompletionReport } from "../catalogue/sveip.js";
import { TripStore } from "../lib/trip-store.js";

let root: string;

function newStore(): TripStore {
  const store = new TripStore(join(root, "store"));
  store.saveConfig({ adminId: "123456789", killSwitch: false, dailyTokenBudget: 100000, trips: [] } as never);
  return store;
}

function mail(id: string, subject = `mail-${id}`): ReiseMail {
  return { id, subject, from: "SAS <noreply@sas.no>", bodyText: "…", receivedAt: "2026-08-17T10:00:00Z" };
}

function nycBooking(id: string, startISO: string, endISO?: string): Booking {
  return { id, kind: "flight", provider: "SAS", startISO, endISO, details: `SAS til New York (${startISO})` };
}

function pipelineWith(store: TripStore, extract: (m: ReiseMail) => Promise<Booking | null>) {
  const sent: string[] = [];
  const cache = fileExtractionCache(join(root, "store"));
  const pipeline = new BookingPipeline({
    extract,
    store,
    tg: { send: async (_c, text) => { sent.push(text); return "mid"; } },
    adminId: "123456789",
    now: () => 1_760_000_000,
    cache,
  });
  return { pipeline, cache, sent };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "marcel-rethink-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("extraction cache", () => {
  it("a re-sweep never re-extracts: second backfill over the same mail makes ZERO LLM calls", async () => {
    const store = newStore();
    const extract = vi.fn(async (m: ReiseMail) => nycBooking(m.id, "2026-09-12", "2026-09-18"));
    const { pipeline } = pipelineWith(store, extract);

    const first = await pipeline.backfill([mail("m1"), mail("m2")]);
    expect(first.noTrip).toBe(2); // no trip window exists — orphaned, but CACHED
    expect(extract).toHaveBeenCalledTimes(2);

    const second = await pipeline.backfill([mail("m1"), mail("m2")]);
    expect(second.noTrip).toBe(2);
    expect(extract).toHaveBeenCalledTimes(2); // ← the whole point
  });

  it("not-a-booking outcomes are cached too — newsletters cost exactly one LLM call ever", async () => {
    const store = newStore();
    const extract = vi.fn(async () => null);
    const { pipeline } = pipelineWith(store, extract);
    await pipeline.backfill([mail("n1")]);
    await pipeline.backfill([mail("n1")]);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("cache survives process restart (file-backed): a fresh pipeline reads the old results", async () => {
    const store = newStore();
    const extract1 = vi.fn(async (m: ReiseMail) => nycBooking(m.id, "2026-09-12"));
    const { pipeline: p1 } = pipelineWith(store, extract1);
    await p1.backfill([mail("m1")]);

    const extract2 = vi.fn(async () => null);
    const { pipeline: p2 } = pipelineWith(store, extract2); // fresh cache instance, same dir
    await p2.backfill([mail("m1")]);
    expect(extract2).not.toHaveBeenCalled();
  });

  it("creating the trip and re-sweeping FILES the cached orphans, still LLM-free", async () => {
    const store = newStore();
    const extract = vi.fn(async (m: ReiseMail) => nycBooking(m.id, "2026-09-12", "2026-09-18"));
    const { pipeline } = pipelineWith(store, extract);
    await pipeline.backfill([mail("m1")]); // orphaned
    expect(extract).toHaveBeenCalledTimes(1);

    store.createTrip({ slug: "the-big-apple", name: "The Big Apple", start: "2026-09-10", end: "2026-09-20", timezone: "America/New_York", destination: { name: "New York", lat: 40.7, lon: -74 } });

    const after = await pipeline.backfill([mail("m1")]);
    expect(after.filed).toBe(1);
    expect(extract).toHaveBeenCalledTimes(1); // replay from cache, no second extraction
  });
});

describe("retroMatch — /nytur files the orphans immediately", () => {
  it("files cached no-trip bookings whose dates fall in the new window, updates their outcome", async () => {
    const store = newStore();
    const extract = vi.fn(async (m: ReiseMail) => {
      if (m.id === "far") return nycBooking(m.id, "2026-12-01");
      if (m.id === "b")
        return { id: m.id, kind: "stay", provider: "Marriott", startISO: "2026-09-13", endISO: "2026-09-17", details: "Marriott Downtown, 13.–17. sep" };
      return nycBooking(m.id, "2026-09-12", "2026-09-18");
    });
    const { pipeline, cache, sent } = pipelineWith(store, extract);
    await pipeline.backfill([mail("a"), mail("b"), mail("far")]); // all orphaned

    store.createTrip({ slug: "the-big-apple", name: "The Big Apple", start: "2026-09-10", end: "2026-09-20", timezone: "America/New_York", destination: { name: "New York", lat: 40.7, lon: -74 } });

    const filed = await pipeline.retroMatch();
    expect(filed).toBe(2); // a + b in window; "far" (December) stays an orphan
    expect(cache.get("a")?.outcome).toBe("filed");
    expect(cache.get("far")?.outcome).toBe("no-trip");
    // Each retro-filing keeps the normal per-booking DM with its veto button.
    expect(sent.filter((t) => t.includes("Fant i Reise (retro)"))).toHaveLength(2);
  });

  it("retroMatch is idempotent — a second run files nothing new", async () => {
    const store = newStore();
    const { pipeline } = pipelineWith(store, async (m) => nycBooking(m.id, "2026-09-13"));
    await pipeline.backfill([mail("a")]);
    store.createTrip({ slug: "t", name: "T", start: "2026-09-10", end: "2026-09-20", timezone: "UTC", destination: { name: "NY", lat: 40.7, lon: -74 } });
    expect(await pipeline.retroMatch()).toBe(1);
    expect(await pipeline.retroMatch()).toBe(0);
  });
});

describe("orphanClusters — trip discovery", () => {
  it("groups overlapping/adjacent orphan windows; singletons are dropped", () => {
    const entries: Array<[string, { outcome: "no-trip"; booking: Booking; subject: string; extractedAt: string }]> = [
      ["a", { outcome: "no-trip", booking: nycBooking("a", "2026-09-12", "2026-09-18"), subject: "s", extractedAt: "x" }],
      ["b", { outcome: "no-trip", booking: nycBooking("b", "2026-09-13"), subject: "s", extractedAt: "x" }],
      ["c", { outcome: "no-trip", booking: nycBooking("c", "2026-09-19"), subject: "s", extractedAt: "x" }], // within 2-day gap
      ["lone", { outcome: "no-trip", booking: nycBooking("lone", "2026-12-24"), subject: "s", extractedAt: "x" }],
    ];
    const clusters = orphanClusters(entries);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ start: "2026-09-12", end: "2026-09-19", count: 3 });
  });

  it("the completion report surfaces a cluster as 'Mulig ny tur' with /nytur guidance", () => {
    const report = composeCompletionReport(
      { filed: 0, duplicates: 0, noTrip: 5, notBooking: 14, unclearSubjects: [] },
      [{ start: "2026-09-12", end: "2026-09-19", count: 5, samples: ["SAS til New York (2026-09-12)"] }],
    );
    expect(report).toContain("Mulig ny tur: 2026-09-12 – 2026-09-19 — 5 bookinger");
    expect(report).toContain("/nytur");
    expect(report).toContain("SAS til New York");
  });
});
