// ORB-157 follow-up #2 — the trip_status lookup tool.
//
// Exists because a static `## Turer` registry in the turn context, even marked FASIT, loses
// to Marcel's own "never assert without a tool result" discipline (observed live twice on
// 2026-08-24). This is the tool-backed answer; these tests pin its contract: fresh
// config.json truth, admin-DM only, link state verbatim.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionAuth } from "eve/context";

import { createTripStatusTool, type TripStatusDeps } from "../catalogue/trip_status.js";
import { TripStore } from "../lib/trip-store.js";

const ADMIN_ID = "123456789";

let root: string;
let store: TripStore;

function deps(): TripStatusDeps {
  return { store: () => store };
}

function ctxFor(attrs: Record<string, string>): never {
  const a = { authenticator: "telegram-webhook", principalId: "p", attributes: attrs } as never;
  return { session: { id: "wrun_test", auth: { current: a } as SessionAuth } } as never;
}

const adminDm = () => ctxFor({ chat_id: ADMIN_ID, chat_type: "private", user_id: ADMIN_ID });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-trip-status-"));
  store = new TripStore(root);
  store.saveConfig({ adminId: ADMIN_ID, killSwitch: false, dailyTokenBudget: 1000, trips: [] });
  process.env["MARCEL_ADMIN_TELEGRAM_ID"] = ADMIN_ID;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env["MARCEL_ADMIN_TELEGRAM_ID"];
});

describe("trip_status", () => {
  it("returns every trip with its true link state, fresh from config", async () => {
    const trip = store.createTrip({
      slug: "the-big-apple",
      name: "The Big Apple",
      start: "2026-08-25",
      end: "2026-08-31",
      timezone: "America/New_York",
      destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 },
    });
    store.linkChat(trip.slug, "-5405035031");

    const tool = createTripStatusTool(deps());
    const result = (await tool.execute({}, adminDm())) as { trips: { slug: string; linked: boolean; groupChatId: string | null }[] };

    expect(result.trips).toHaveLength(1);
    expect(result.trips[0]).toMatchObject({ slug: "the-big-apple", linked: true, groupChatId: "-5405035031" });
  });

  it("reports an unlinked trip as linked: false with a null group id", async () => {
    store.createTrip({
      slug: "solo",
      name: "Solo",
      start: "2026-09-01",
      end: "2026-09-03",
      timezone: "Europe/Oslo",
      destination: { name: "Oslo", lat: 59.9, lon: 10.7 },
    });

    const tool = createTripStatusTool(deps());
    const result = (await tool.execute({}, adminDm())) as { trips: { linked: boolean; groupChatId: string | null }[] };

    expect(result.trips[0]).toMatchObject({ linked: false, groupChatId: null });
  });

  it("refuses a group chat", async () => {
    const tool = createTripStatusTool(deps());
    await expect(tool.execute({}, ctxFor({ chat_id: "-42", chat_type: "group", user_id: "1" }))).rejects.toThrow(
      "admin-DM only",
    );
  });

  it("refuses a non-admin private chat", async () => {
    const tool = createTripStatusTool(deps());
    await expect(tool.execute({}, ctxFor({ chat_id: "999", chat_type: "private", user_id: "999" }))).rejects.toThrow(
      "admin-DM only",
    );
  });
});
