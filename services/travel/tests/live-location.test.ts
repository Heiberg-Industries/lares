// Tests for lib/live-location.ts (Task 11) — the ephemeral, in-memory-only per-chat location
// store. Pure module, no I/O: every test controls `nowMs` explicitly rather than relying on
// real wall-clock time, so TTL-expiry assertions are deterministic.
import { describe, it, expect, beforeEach } from "vitest";
import {
  setLiveLocation,
  clearLiveLocation,
  getLiveLocation,
  hasLiveLocation,
  __resetLiveLocationStoreForTest,
  ONE_OFF_LOCATION_TTL_SEC,
} from "../lib/live-location.js";

const CHAT_A = "111";
const CHAT_B = "222";
const T0 = 1_700_000_000_000; // fixed epoch ms

beforeEach(() => {
  __resetLiveLocationStoreForTest();
});

describe("setLiveLocation / getLiveLocation", () => {
  it("returns null when nothing has ever been set for a chat", () => {
    expect(getLiveLocation(CHAT_A)).toBeNull();
  });

  it("returns the location just set, within its TTL", () => {
    setLiveLocation(CHAT_A, 48.8566, 2.3522, 900, T0);
    expect(getLiveLocation(CHAT_A, T0 + 500_000)).toEqual({ lat: 48.8566, lon: 2.3522 });
  });

  it("expires exactly at expiresAt — TTL boundary is exclusive of validity", () => {
    setLiveLocation(CHAT_A, 48.8566, 2.3522, 900, T0);
    expect(getLiveLocation(CHAT_A, T0 + 900_000)).toBeNull();
  });

  it("is still valid one second before expiry", () => {
    setLiveLocation(CHAT_A, 48.8566, 2.3522, 900, T0);
    expect(getLiveLocation(CHAT_A, T0 + 899_000)).not.toBeNull();
  });

  it("keeps each chat's location independent", () => {
    setLiveLocation(CHAT_A, 48.8566, 2.3522, 900, T0);
    setLiveLocation(CHAT_B, 43.296, 5.37, 900, T0);
    expect(getLiveLocation(CHAT_A, T0)).toEqual({ lat: 48.8566, lon: 2.3522 });
    expect(getLiveLocation(CHAT_B, T0)).toEqual({ lat: 43.296, lon: 5.37 });
  });

  it("a later setLiveLocation call for the same chat overwrites the previous one", () => {
    setLiveLocation(CHAT_A, 48.8566, 2.3522, 900, T0);
    setLiveLocation(CHAT_A, 45.764, 4.8357, 900, T0);
    expect(getLiveLocation(CHAT_A, T0)).toEqual({ lat: 45.764, lon: 4.8357 });
  });
});

describe("clearLiveLocation", () => {
  it("clears a tracked location — getLiveLocation returns null afterward", () => {
    setLiveLocation(CHAT_A, 48.8566, 2.3522, 900, T0);
    clearLiveLocation(CHAT_A);
    expect(getLiveLocation(CHAT_A, T0)).toBeNull();
  });

  it("clearing a chat with nothing tracked is a harmless no-op", () => {
    expect(() => clearLiveLocation(CHAT_A)).not.toThrow();
  });

  it("clearing one chat never affects another", () => {
    setLiveLocation(CHAT_A, 48.8566, 2.3522, 900, T0);
    setLiveLocation(CHAT_B, 43.296, 5.37, 900, T0);
    clearLiveLocation(CHAT_A);
    expect(getLiveLocation(CHAT_A, T0)).toBeNull();
    expect(getLiveLocation(CHAT_B, T0)).toEqual({ lat: 43.296, lon: 5.37 });
  });
});

describe("hasLiveLocation", () => {
  it("is false with nothing tracked", () => {
    expect(hasLiveLocation(CHAT_A, T0)).toBe(false);
  });

  it("is true within TTL, false once expired", () => {
    setLiveLocation(CHAT_A, 48.8566, 2.3522, 900, T0);
    expect(hasLiveLocation(CHAT_A, T0 + 100_000)).toBe(true);
    expect(hasLiveLocation(CHAT_A, T0 + 900_000)).toBe(false);
  });
});

describe("ONE_OFF_LOCATION_TTL_SEC", () => {
  it("is a positive, bounded TTL (never treated as permanent)", () => {
    expect(ONE_OFF_LOCATION_TTL_SEC).toBeGreaterThan(0);
    expect(Number.isFinite(ONE_OFF_LOCATION_TTL_SEC)).toBe(true);
  });
});
