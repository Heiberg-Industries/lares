// ORB-157 — the ONE shared "which trip?" resolver.
//
// Covers the contract the ticket names: group → the chat's own linked trip (slug ignored);
// admin DM → the single active-or-upcoming trip, explicit slug always winning, a clear
// "which trip?" error when several qualify; everything else fails closed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionAuth } from "eve/context";

import { resolveCurrentTrip } from "../lib/current-trip.js";
import { TripStore, type MarcelConfig, type Trip } from "../lib/trip-store.js";

const ADMIN_ID = "123456789";
const NOW = Date.parse("2026-08-24T12:00:00Z");

let root: string;
let store: TripStore;

function seed(trips: MarcelConfig["trips"]): void {
  store.saveConfig({ adminId: ADMIN_ID, killSwitch: false, dailyTokenBudget: 1000, trips });
}

function trip(slug: string, over: Partial<Omit<Trip, "dir">> = {}): MarcelConfig["trips"][number] {
  return {
    slug,
    name: slug,
    start: "2026-08-25",
    end: "2026-08-31",
    timezone: "America/New_York",
    destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 },
    ...over,
  };
}

function authFor(attrs: Record<string, string>): SessionAuth {
  return {
    current: { authenticator: "telegram-webhook", principalId: attrs["user_id"] ?? "u", attributes: attrs },
  } as never;
}

const groupAuth = (chatId: string) => authFor({ chat_id: chatId, chat_type: "group", user_id: "1" });
const adminDmAuth = () => authFor({ chat_id: ADMIN_ID, chat_type: "private", user_id: ADMIN_ID });
const strangerDmAuth = () => authFor({ chat_id: "999", chat_type: "private", user_id: "999" });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-current-trip-"));
  store = new TripStore(root);
  process.env["MARCEL_ADMIN_TELEGRAM_ID"] = ADMIN_ID;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env["MARCEL_ADMIN_TELEGRAM_ID"];
});

describe("resolveCurrentTrip", () => {
  it("group chat resolves its own linked trip, ignoring any slug", () => {
    seed([trip("nyc", { chatId: "-42" }), trip("paris", { chatId: "-43" })]);
    const res = resolveCurrentTrip(store, groupAuth("-42"), { slug: "paris", nowMs: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.trip.slug).toBe("nyc");
  });

  it("unlinked group chat keeps today's honest error", () => {
    seed([trip("nyc")]);
    const res = resolveCurrentTrip(store, groupAuth("-42"), { nowMs: NOW });
    expect(res).toEqual({ ok: false, error: "no trip linked to this chat" });
  });

  it("admin DM with exactly one active/upcoming trip resolves it without a slug", () => {
    seed([trip("nyc", { chatId: "-42" })]);
    const res = resolveCurrentTrip(store, adminDmAuth(), { nowMs: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.trip.slug).toBe("nyc");
  });

  it("admin DM ignores trips that already ended", () => {
    seed([trip("old", { start: "2026-07-01", end: "2026-07-10" }), trip("nyc")]);
    const res = resolveCurrentTrip(store, adminDmAuth(), { nowMs: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.trip.slug).toBe("nyc");
  });

  it("admin DM with several candidates asks for a slug, naming them", () => {
    seed([trip("nyc"), trip("paris", { start: "2026-09-10", end: "2026-09-14", timezone: "Europe/Paris" })]);
    const res = resolveCurrentTrip(store, adminDmAuth(), { nowMs: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("nyc");
      expect(res.error).toContain("paris");
    }
  });

  it("admin DM with an explicit slug always wins, even over the single-candidate rule", () => {
    seed([trip("nyc"), trip("old", { start: "2026-07-01", end: "2026-07-10" })]);
    const res = resolveCurrentTrip(store, adminDmAuth(), { slug: "old", nowMs: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.trip.slug).toBe("old");
  });

  it("admin DM with an unknown slug says so", () => {
    seed([trip("nyc")]);
    const res = resolveCurrentTrip(store, adminDmAuth(), { slug: "tokyo", nowMs: NOW });
    expect(res).toEqual({ ok: false, error: 'fant ingen tur med slug "tokyo"' });
  });

  it("admin DM with no active or upcoming trips says so", () => {
    seed([trip("old", { start: "2026-07-01", end: "2026-07-10" })]);
    const res = resolveCurrentTrip(store, adminDmAuth(), { nowMs: NOW });
    expect(res.ok).toBe(false);
  });

  it("a non-admin private chat fails closed", () => {
    seed([trip("nyc")]);
    const res = resolveCurrentTrip(store, strangerDmAuth(), { nowMs: NOW });
    expect(res).toEqual({ ok: false, error: "no trip linked to this chat" });
  });

  it("missing auth fails closed", () => {
    seed([trip("nyc")]);
    const res = resolveCurrentTrip(store, undefined, { nowMs: NOW });
    expect(res.ok).toBe(false);
  });
});
