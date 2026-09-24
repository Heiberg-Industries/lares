// ORB-101 — live-location proximity pings.
//
// The ticket's acceptance criteria are the spine of this file: inside-radius pings once, a repeat
// position does not re-ping, a stale position pings not at all, and entries without coordinates are
// skipped. Plus the two things that make it safe to leave running: admin-only intake, and quiet
// hours judged in the TRIP's timezone rather than the container's.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { PlaceEntry } from "@lares/taste";

import { clearPosition, currentPosition, readPosition, writePosition, POSITION_FILE } from "../lib/position.js";
import { parseLocationUpdate } from "../lib/location-update.js";
import {
  MAX_PER_PING,
  MAX_PINGS_PER_DAY,
  PING_COOLDOWN_SEC,
  PING_RADIUS_M,
  alertKey,
  composeProximityMessage,
  decideGeofence,
  geofenceCandidates,
  nearestCandidate,
  isQuietHour,
  withinRadius,
} from "../lib/geofence.js";
import {
  localDayAndHour,
  proximityTick,
  readLedger,
  readLedgerState,
  timezoneForNow,
  writeLedger,
  type ProximityDeps,
} from "../agent/schedules/proximity.js";
import { handleLocationUpdate, type LocationIntakeDeps } from "../agent/channels/telegram-webhook.js";
import type { Trip } from "../lib/trip-store.js";

const ADMIN = "123456789";
// Katz's Delicatessen, from Bendik's own resolved NYC list.
const KATZ = { lat: 40.7223, lon: -73.9874 };
const NOW_MS = Date.parse("2026-08-27T18:00:00Z"); // 14:00 in New York
const NOW_SEC = Math.floor(NOW_MS / 1000);

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-proximity-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const place = (over: Partial<PlaceEntry> & { name: string }): PlaceEntry => ({ type: "place", ...over });

// ── the position file ────────────────────────────────────────────────────────────────────

describe("the position file", () => {
  it("round-trips", () => {
    writePosition(root, { ...KATZ, at: NOW_SEC, expiresAt: NOW_SEC + 3600 });
    expect(readPosition(root)).toEqual({ ...KATZ, at: NOW_SEC, expiresAt: NOW_SEC + 3600 });
  });

  it("survives a restart, which is the whole reason it is a file", () => {
    writePosition(root, { ...KATZ, at: NOW_SEC, expiresAt: NOW_SEC + 3600 });
    expect(fs.existsSync(path.join(root, POSITION_FILE))).toBe(true);
    expect(currentPosition(root, NOW_SEC)).not.toBeNull();
  });

  it("reads as absent when nothing was ever shared", () => {
    expect(readPosition(root)).toBeNull();
    expect(currentPosition(root, NOW_SEC)).toBeNull();
  });

  it("reads as absent rather than throwing on a corrupt file", () => {
    fs.writeFileSync(path.join(root, POSITION_FILE), "{not json");
    expect(readPosition(root)).toBeNull();
  });

  it("refuses a position past its expiry — a stale position must never ping", () => {
    writePosition(root, { ...KATZ, at: NOW_SEC - 7200, expiresAt: NOW_SEC - 60 });
    expect(readPosition(root)).not.toBeNull();
    expect(currentPosition(root, NOW_SEC)).toBeNull();
  });

  it("clears", () => {
    writePosition(root, { ...KATZ, at: NOW_SEC, expiresAt: NOW_SEC + 3600 });
    clearPosition(root);
    expect(readPosition(root)).toBeNull();
  });

  it("never throws when the root cannot be written", () => {
    expect(() => writePosition("/proc/nope/nope", { ...KATZ, at: 1, expiresAt: 2 })).not.toThrow();
  });
});

// ── reading Telegram's update shapes ─────────────────────────────────────────────────────

describe("parsing a location out of an update", () => {
  const loc = (extra: Record<string, unknown> = {}) => ({
    chat: { id: "-100123", type: "private" },
    from: { id: ADMIN },
    location: { latitude: KATZ.lat, longitude: KATZ.lon, ...extra },
  });

  it("reads a live share's opening message", () => {
    const u = parseLocationUpdate({ message: loc({ live_period: 3600 }) });
    expect(u).toMatchObject({ lat: KATZ.lat, lon: KATZ.lon, livePeriod: 3600, stopped: false });
  });

  it("reads an edited_message — the update eve drops, and the whole point of this feature", () => {
    const u = parseLocationUpdate({ edited_message: loc({ live_period: 3600 }) });
    expect(u).toMatchObject({ lat: KATZ.lat, livePeriod: 3600, stopped: false });
  });

  it("recognises the end of a live share: an edit whose location lost its live period", () => {
    expect(parseLocationUpdate({ edited_message: loc() })).toMatchObject({ stopped: true });
  });

  it("treats a plain pin drop as a one-off, not a stop", () => {
    expect(parseLocationUpdate({ message: loc() })).toMatchObject({ stopped: false, livePeriod: undefined });
  });

  it("carries the sender, so the caller can insist on the admin", () => {
    expect(parseLocationUpdate({ message: loc() })?.userId).toBe(ADMIN);
  });

  it("answers null for every update with no location — the overwhelming majority", () => {
    expect(parseLocationUpdate({ message: { chat: { id: "1" }, text: "hei" } })).toBeNull();
    expect(parseLocationUpdate({ callback_query: { id: "1" } })).toBeNull();
    expect(parseLocationUpdate({})).toBeNull();
    expect(parseLocationUpdate(null)).toBeNull();
    expect(parseLocationUpdate("nonsense")).toBeNull();
  });

  it("answers null when coordinates are missing or unusable", () => {
    expect(parseLocationUpdate({ message: { chat: { id: "1" }, location: { latitude: "x", longitude: 1 } } })).toBeNull();
  });
});

// ── intake ───────────────────────────────────────────────────────────────────────────────

describe("intake", () => {
  function deps(over: Partial<LocationIntakeDeps> = {}): LocationIntakeDeps {
    return {
      root: () => root,
      now: () => NOW_MS,
      write: writePosition,
      clear: clearPosition,
      isAdmin: (id) => id === ADMIN,
      ...over,
    };
  }
  const update = (from: string, extra: Record<string, unknown> = {}) => ({
    edited_message: {
      chat: { id: "-100123", type: "private" },
      from: { id: from },
      location: { latitude: KATZ.lat, longitude: KATZ.lon, ...extra },
    },
  });

  it("stores the admin's position, expiring on Telegram's own live period", () => {
    expect(handleLocationUpdate(update(ADMIN, { live_period: 900 }), deps())).toBe("stored");
    expect(readPosition(root)).toEqual({ ...KATZ, at: NOW_SEC, expiresAt: NOW_SEC + 900 });
  });

  it("IGNORES anyone else — a group member must not decide where Bendik is", () => {
    expect(handleLocationUpdate(update("999999", { live_period: 900 }), deps())).toBe("ignored");
    expect(readPosition(root)).toBeNull();
  });

  it("clears on the stop signal", () => {
    handleLocationUpdate(update(ADMIN, { live_period: 900 }), deps());
    expect(handleLocationUpdate(update(ADMIN), deps())).toBe("cleared");
    expect(readPosition(root)).toBeNull();
  });

  it("bounds a one-off share rather than trusting it forever", () => {
    handleLocationUpdate({ message: { chat: { id: "1", type: "private" }, from: { id: ADMIN }, location: { latitude: 1, longitude: 2 } } }, deps());
    const stored = readPosition(root)!;
    expect(stored.expiresAt - stored.at).toBe(3600);
  });
});

// ── the geofence decision ────────────────────────────────────────────────────────────────

describe("candidates", () => {
  it("skips saved places with no coordinates — they cannot be geofenced", () => {
    const candidates = geofenceCandidates([
      place({ name: "Katz's", lat: KATZ.lat, lon: KATZ.lon }),
      place({ name: "Uten koordinater", city: "New York" }),
    ]);
    expect(candidates.map((c) => c.name)).toEqual(["Katz's"]);
  });

  it("skips APPROXIMATE pins — they have coordinates, just not to 250 m (ORB-117)", () => {
    // Decoded from the saved link's own cell rather than confirmed by a match. Good enough for
    // "which city", nowhere near good enough to say "du er 200 m unna": the cell sits over a
    // kilometre from the real pin for nearly half the store.
    const candidates = geofenceCandidates([
      place({ name: "Katz's", lat: KATZ.lat, lon: KATZ.lon }),
      place({ name: "Omtrentlig", lat: KATZ.lat, lon: KATZ.lon, approx: true }),
    ]);
    expect(candidates.map((c) => c.name)).toEqual(["Katz's"]);
  });
});

describe("nearestCandidate", () => {
  it("names the closest candidate however far away it is — the diagnosis for a quiet tick", () => {
    const far = place({ name: "Langt unna", lat: 40.7105, lon: -73.9874 });
    const further = place({ name: "Enda lenger", lat: 41.0, lon: -73.9874 });
    const hit = nearestCandidate(geofenceCandidates([further, far]), KATZ)!;
    expect(hit.name).toBe("Langt unna");
    expect(hit.distanceM).toBeGreaterThan(1000);
  });

  it("has no answer when there is nothing to be near", () => {
    expect(nearestCandidate([], KATZ)).toBeUndefined();
  });
});

describe("withinRadius", () => {
  const near = place({ name: "Katz's", lat: KATZ.lat, lon: KATZ.lon, sourceList: "NYC" });
  // ~1.3 km south — well outside a walking radius
  const far = place({ name: "Langt unna", lat: 40.7105, lon: -73.9874 });

  it("takes what is inside and leaves what is outside", () => {
    const hits = withinRadius(geofenceCandidates([near, far]), KATZ);
    expect(hits.map((h) => h.name)).toEqual(["Katz's"]);
    expect(hits[0]!.distanceM).toBeLessThan(20);
  });

  it("sorts nearest first", () => {
    const mid = place({ name: "Midt imellom", lat: 40.7218, lon: -73.9874 });
    const hits = withinRadius(geofenceCandidates([mid, near]), KATZ, 1000);
    expect(hits.map((h) => h.name)).toEqual(["Katz's", "Midt imellom"]);
  });

  it("uses a walking radius", () => {
    expect(PING_RADIUS_M).toBe(250);
  });
});

describe("decideGeofence", () => {
  const candidates = geofenceCandidates([
    place({ name: "Katz's", lat: KATZ.lat, lon: KATZ.lon, sourceList: "NYC" }),
    place({ name: "Russ & Daughters", lat: 40.7223, lon: -73.9878, sourceList: "NYC" }),
  ]);
  const base = { candidates, position: KATZ, dayISO: "2026-08-27", localHour: 14, alerted: new Set<string>() };

  it("pings once when inside the radius", () => {
    const decision = decideGeofence(base);
    expect(decision.alerts.map((a) => a.name)).toContain("Katz's");
    expect(decision.keys).toContain(alertKey("2026-08-27", "Katz's"));
  });

  it("does NOT re-ping a place already mentioned today", () => {
    const alerted = new Set(candidates.map((c) => alertKey("2026-08-27", c.name)));
    expect(decideGeofence({ ...base, alerted })).toMatchObject({ alerts: [], skipped: "already-told" });
  });

  it("pings again the next day — the same walk tomorrow is worth mentioning", () => {
    const alerted = new Set(candidates.map((c) => alertKey("2026-08-27", c.name)));
    expect(decideGeofence({ ...base, dayISO: "2026-08-28", alerted }).alerts.length).toBeGreaterThan(0);
  });

  it("says nothing during quiet hours", () => {
    expect(decideGeofence({ ...base, localHour: 3 })).toMatchObject({ alerts: [], skipped: "quiet-hours" });
    expect(decideGeofence({ ...base, localHour: 23 })).toMatchObject({ alerts: [], skipped: "quiet-hours" });
    expect(isQuietHour(8)).toBe(false);
    expect(isQuietHour(21)).toBe(false);
  });

  it("says nothing when nothing is near", () => {
    expect(decideGeofence({ ...base, position: { lat: 59.91, lon: 10.75 } }))
      .toMatchObject({ alerts: [], skipped: "nothing-near" });
  });

  it("holds its tongue during the cooldown, however much is near", () => {
    // The failure this exists for: simulated on Bendik's real store, a 2.2 km walk through
    // Grünerløkka produced SIXTEEN messages at 250 m, because the tick runs every minute and a
    // dense neighbourhood always has one more saved place just ahead.
    const now = 1_800_000_000;
    expect(decideGeofence({ ...base, nowSec: now, lastSentSec: now - 60 }))
      .toMatchObject({ alerts: [], skipped: "cooling-down" });
    expect(decideGeofence({ ...base, nowSec: now, lastSentSec: now - PING_COOLDOWN_SEC + 1 }))
      .toMatchObject({ alerts: [], skipped: "cooling-down" });
  });

  it("speaks again once the cooldown is over", () => {
    const now = 1_800_000_000;
    expect(decideGeofence({ ...base, nowSec: now, lastSentSec: now - PING_COOLDOWN_SEC }).alerts.length)
      .toBeGreaterThan(0);
  });

  it("stops for the day at the cap", () => {
    expect(decideGeofence({ ...base, sentToday: MAX_PINGS_PER_DAY }))
      .toMatchObject({ alerts: [], skipped: "daily-cap" });
    expect(decideGeofence({ ...base, sentToday: MAX_PINGS_PER_DAY - 1 }).alerts.length).toBeGreaterThan(0);
  });

  it("applies the rate limits LAST, so the skip reason is the most specific truth", () => {
    // Somewhere with nothing saved nearby, while also cooling down: the useful answer is that
    // there was nothing to say, not that it was too soon to say it.
    const now = 1_800_000_000;
    expect(decideGeofence({
      ...base, position: { lat: 59.91, lon: 10.75 }, nowSec: now, lastSentSec: now - 60,
    })).toMatchObject({ skipped: "nothing-near" });
    // And quiet hours still outrank everything.
    expect(decideGeofence({ ...base, localHour: 3, sentToday: MAX_PINGS_PER_DAY }))
      .toMatchObject({ skipped: "quiet-hours" });
  });

  it("has no cooldown when the caller keeps no clock — the older guards stand alone", () => {
    expect(decideGeofence({ ...base, lastSentSec: 1 }).alerts.length).toBeGreaterThan(0);
  });

  it("caps one ping at a few places rather than sending a dozen", () => {
    const many = geofenceCandidates(
      Array.from({ length: 9 }, (_, i) => place({ name: `Sted ${i}`, lat: KATZ.lat + i * 0.0001, lon: KATZ.lon })),
    );
    expect(decideGeofence({ ...base, candidates: many }).alerts).toHaveLength(MAX_PER_PING);
  });
});

describe("the message", () => {
  it("names the places as Bendik's own saved data, with the distance", () => {
    const msg = composeProximityMessage([
      { name: "Katz's", lat: 0, lon: 0, distanceM: 180, sourceList: "NYC", note: "pastrami" },
    ]);
    expect(msg).toContain("Katz's, 180 m");
    expect(msg).toContain("lagret i «NYC»");
    expect(msg).toContain("pastrami");
    expect(msg).toContain("du har lagret");
  });

  it("claims nothing about whether the place is open", () => {
    const msg = composeProximityMessage([{ name: "X", lat: 0, lon: 0, distanceM: 10 }]);
    expect(msg).not.toMatch(/åpen|åpent|anbefal/i);
  });

  it("is empty for no alerts, so nothing is ever sent", () => {
    expect(composeProximityMessage([])).toBe("");
  });
});

// ── local time ───────────────────────────────────────────────────────────────────────────

describe("local time comes from the trip", () => {
  const nycTrip = {
    slug: "the-big-apple", name: "The Big Apple", start: "2026-08-25", end: "2026-08-31",
    timezone: "America/New_York", destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 }, dir: "/x",
  } as Trip;

  it("judges the hour in the trip's timezone, not the container's", () => {
    // 03:00 UTC on a NYC trip is 23:00 local the previous evening — quiet either way, but a
    // DIFFERENT day, which is what the ledger keys on.
    const utc3 = Date.parse("2026-08-28T03:00:00Z");
    expect(localDayAndHour("America/New_York", utc3)).toEqual({ dayISO: "2026-08-27", hour: 23 });
    expect(localDayAndHour("Europe/Oslo", utc3)).toEqual({ dayISO: "2026-08-28", hour: 5 });
  });

  it("picks the active trip's timezone", () => {
    expect(timezoneForNow([nycTrip], NOW_MS)).toBe("America/New_York");
  });

  it("falls back to Oslo with no active trip", () => {
    expect(timezoneForNow([], NOW_MS)).toBe("Europe/Oslo");
    expect(timezoneForNow([{ ...nycTrip, start: "2026-01-01", end: "2026-01-05" }], NOW_MS)).toBe("Europe/Oslo");
  });
});

// ── the ledger ───────────────────────────────────────────────────────────────────────────

describe("the alert ledger", () => {
  it("records keys and reads them back", () => {
    writeLedger(root, ["2026-08-27:katz's"], "2026-08-27");
    expect(readLedger(root)).toEqual(["2026-08-27:katz's"]);
  });

  it("drops yesterday's keys, which is all the housekeeping it needs", () => {
    writeLedger(root, ["2026-08-26:gammelt"], "2026-08-26");
    writeLedger(root, ["2026-08-27:nytt"], "2026-08-27");
    expect(readLedger(root)).toEqual(["2026-08-27:nytt"]);
  });

  it("reads as empty when absent or corrupt", () => {
    expect(readLedger(root)).toEqual([]);
    fs.writeFileSync(path.join(root, "proximity-alerts.json"), "{not json");
    expect(readLedger(root)).toEqual([]);
  });

  it("remembers when it last spoke, and how often today", () => {
    writeLedger(root, ["2026-08-27:katz's"], "2026-08-27", 1_800_000_000);
    expect(readLedgerState(root)).toMatchObject({ lastSentSec: 1_800_000_000, sentToday: 1 });

    writeLedger(root, ["2026-08-27:russ"], "2026-08-27", 1_800_002_000);
    expect(readLedgerState(root)).toMatchObject({ lastSentSec: 1_800_002_000, sentToday: 2 });
  });

  it("gives each local day a fresh budget", () => {
    writeLedger(root, ["2026-08-27:a"], "2026-08-27", 1_800_000_000);
    writeLedger(root, ["2026-08-27:b"], "2026-08-27", 1_800_002_000);
    expect(readLedgerState(root).sentToday).toBe(2);

    writeLedger(root, ["2026-08-28:c"], "2026-08-28", 1_800_090_000);
    expect(readLedgerState(root)).toMatchObject({ keys: ["2026-08-28:c"], sentToday: 1 });
  });

  it("READS THE OLD BARE-ARRAY FILE a running box already has on disk", () => {
    // The upgrade hazard: this file used to be a `string[]`. Discarding one on read would forget
    // what had already been said today and re-ping every place on the next tick — the exact spam
    // the cooldown was added to prevent, caused by the change that prevents it.
    fs.writeFileSync(path.join(root, "proximity-alerts.json"), JSON.stringify(["2026-08-27:katz's"]));

    expect(readLedgerState(root)).toEqual({ keys: ["2026-08-27:katz's"], sentToday: 0 });
    expect(readLedger(root)).toEqual(["2026-08-27:katz's"]);
  });
});

// ── the tick, end to end ─────────────────────────────────────────────────────────────────

describe("the tick", () => {
  const nycTrip = {
    slug: "the-big-apple", name: "The Big Apple", start: "2026-08-25", end: "2026-08-31",
    timezone: "America/New_York", destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 }, dir: "/x",
  } as Trip;

  function deps(over: Partial<ProximityDeps> = {}): { deps: ProximityDeps; sent: string[] } {
    const sent: string[] = [];
    return {
      sent,
      deps: {
        root: () => root,
        position: currentPosition,
        places: () => [place({ name: "Katz's", lat: KATZ.lat, lon: KATZ.lon, sourceList: "NYC" })],
        trips: () => [nycTrip],
        send: async (text) => { sent.push(text); },
        now: () => NOW_MS,
        ...over,
      },
    };
  }

  it("pings once when the admin walks past a saved place", async () => {
    writePosition(root, { ...KATZ, at: NOW_SEC, expiresAt: NOW_SEC + 900 });
    const { deps: d, sent } = deps();

    expect(await proximityTick(d)).toBe("sent");
    expect(sent[0]).toContain("Katz's");
  });

  it("does not ping a second time from the same spot", async () => {
    writePosition(root, { ...KATZ, at: NOW_SEC, expiresAt: NOW_SEC + 900 });
    const { deps: d, sent } = deps();

    await proximityTick(d);
    expect(await proximityTick(d)).toBe("nothing");
    expect(sent).toHaveLength(1);
  });

  it("does nothing at all with no position — the common case, every minute of the year", async () => {
    const { deps: d, sent } = deps();
    expect(await proximityTick(d)).toBe("nothing");
    expect(sent).toEqual([]);
  });

  it("does nothing with a STALE position", async () => {
    writePosition(root, { ...KATZ, at: NOW_SEC - 7200, expiresAt: NOW_SEC - 1 });
    const { deps: d, sent } = deps();
    expect(await proximityTick(d)).toBe("nothing");
    expect(sent).toEqual([]);
  });

  it("skips saved places that have no coordinates", async () => {
    writePosition(root, { ...KATZ, at: NOW_SEC, expiresAt: NOW_SEC + 900 });
    const { deps: d, sent } = deps({ places: () => [place({ name: "Uten koordinater", city: "New York" })] });
    expect(await proximityTick(d)).toBe("nothing");
    expect(sent).toEqual([]);
  });

  it("stays quiet at 03:00 New York time", async () => {
    const at3am = Date.parse("2026-08-28T07:00:00Z"); // 03:00 EDT
    writePosition(root, { ...KATZ, at: Math.floor(at3am / 1000), expiresAt: Math.floor(at3am / 1000) + 900 });
    const { deps: d, sent } = deps({ now: () => at3am });
    expect(await proximityTick(d)).toBe("nothing");
    expect(sent).toEqual([]);
  });

  it("records the ledger BEFORE sending, so a failed send cannot become a ping loop", async () => {
    writePosition(root, { ...KATZ, at: NOW_SEC, expiresAt: NOW_SEC + 900 });
    const { deps: d } = deps({ send: async () => { throw new Error("telegram down"); } });

    await expect(proximityTick(d)).rejects.toThrow("telegram down");
    expect(readLedger(root).length).toBeGreaterThan(0);

    const { deps: d2, sent } = deps();
    expect(await proximityTick(d2)).toBe("nothing");
    expect(sent).toEqual([]);
  });

  it("survives an unseeded trip store", async () => {
    writePosition(root, { ...KATZ, at: NOW_SEC, expiresAt: NOW_SEC + 900 });
    const { deps: d } = deps({ trips: () => [] });
    expect(await proximityTick(d)).toBe("sent");
  });
});
