// Tests for agent/instructions/trip-context.ts — the defineDynamic("turn.started") wiring
// around lib/trip-context.ts's pure buildTripContextMarkdown (Fix Wave B, Finding 1).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionAuth } from "eve/context";
import type { DynamicResolveContext } from "eve/instructions";

import { serializeEntry } from "@lares/taste";

import { TripStore, type Trip } from "../lib/trip-store.js";
import { ConversationLog } from "../lib/conversation-log.js";
import { resolveTripContextMarkdown } from "../agent/instructions/trip-context.js";
import tripContextInstructions from "../agent/instructions/trip-context.js";

const CHAT_ID = "-100123";

function auth(chatId: string | null): SessionAuth {
  const a = chatId
    ? ({
        authenticator: "telegram-webhook",
        principalId: `telegram:${chatId}:1`,
        principalType: "user",
        attributes: { chat_id: chatId, chat_type: "group", user_id: "1" },
      } as never)
    : null;
  return { current: a, initiator: a } as SessionAuth;
}

function resolveCtx(chatId: string | null): DynamicResolveContext {
  return {
    session: { id: "wrun_test", auth: auth(chatId) },
    channel: {},
    messages: [],
  } as unknown as DynamicResolveContext;
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-trip-context-"));
  process.env["MARCEL_DATA_ROOT"] = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env["MARCEL_DATA_ROOT"];
  delete process.env["TASTE_ROOT"];
});

function baseTrip(overrides: Partial<Omit<Trip, "dir" | "chatId">> = {}): Omit<Trip, "dir" | "chatId"> {
  return {
    slug: "paris-2026",
    name: "Paris",
    start: "2026-07-21",
    end: "2026-07-28",
    timezone: "Europe/Paris",
    destination: { name: "Paris", lat: 48.8566, lon: 2.3522 },
    ...overrides,
  };
}

function seedTripStore(): { store: TripStore; trip: Trip } {
  const store = new TripStore(root);
  store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1_000_000, trips: [] });
  const trip = store.createTrip(baseTrip());
  store.linkChat(trip.slug, CHAT_ID);
  return { store, trip: { ...trip, chatId: CHAT_ID } };
}

describe("resolveTripContextMarkdown", () => {
  it("pulls trip.md/itinerary/bookings/shopping/learned/taste from disk into the markdown", () => {
    const { store, trip } = seedTripStore();
    store.write(trip, "itinerary.md", "- 22/07: Louvre");
    store.write(trip, "bookings.md", "SK4705");
    store.write(trip, "shopping.md", "- solkrem");
    store.write(trip, "learned.md", "Pappa hater sopp.");

    const md = resolveTripContextMarkdown(store, trip, Date.parse("2026-07-22T10:00:00Z"));

    expect(md).toContain("## Tur: Paris");
    expect(md).toContain("Louvre");
    expect(md).toContain("SK4705");
    expect(md).toContain("## Handleliste\n- solkrem");
    expect(md).toContain("Pappa hater sopp.");
    expect(md).toContain("## I dag\n2026-07-22");
  });

  it("includes the reise-log and taste geo-hits when present", () => {
    const { store, trip } = seedTripStore();
    store.appendReiseLog("- 2026-07-21 12:06 «Snart starter din leie med Avis» → allerede registrert");
    // ORB-100: saved places come from the FLEET store (/srv/taste), not Marcel's own CSVs.
    const tasteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-taste-"));
    process.env["TASTE_ROOT"] = tasteRoot;
    fs.mkdirSync(path.join(tasteRoot, "places"), { recursive: true });
    fs.writeFileSync(
      path.join(tasteRoot, "places", "paris--chez-fonfon.md"),
      serializeEntry({ type: "place", name: "Chez Fonfon", lat: 48.86, lon: 2.35, sourceList: "Paris" }),
    );

    const md = resolveTripContextMarkdown(store, trip, Date.parse("2026-07-22T10:00:00Z"));

    expect(md).toContain("## Reise-e-poster nylig lest");
    expect(md).toContain("«Snart starter din leie med Avis»");
    expect(md).toContain("Chez Fonfon (Paris)");
  });

  it("includes the recent conversation transcript from the trip's own chatlog", () => {
    const { store, trip } = seedTripStore();
    // ConversationLog.recent()/.transcript() keys "today" off the REAL wall clock (no
    // injectable clock in lib/conversation-log.ts — out of this fix's scope), so the log entry
    // has to land under today's real date for the transcript read to find it; `nowMs` below
    // only controls the "## I dag" section's own printed date, a separate concern.
    new ConversationLog(path.join(trip.dir, "chatlog"), trip.timezone).append({
      ts: Math.floor(Date.now() / 1000),
      from: "1",
      name: "Bendik",
      text: "God morgen!",
    });

    const md = resolveTripContextMarkdown(store, trip, Date.now());

    expect(md).toContain("## Samtalen nylig");
    expect(md).toContain("Bendik: God morgen!");
  });
});

describe("agent/instructions/trip-context.ts default export — turn.started resolver", () => {
  function turnStarted() {
    const handler = tripContextInstructions.events["turn.started"];
    if (!handler) throw new Error("turn.started handler missing");
    return handler;
  }

  it("resolves the linked trip's full dynamic context on a turn", async () => {
    const { store, trip } = seedTripStore();
    store.write(trip, "itinerary.md", "- 22/07: Louvre");

    const result = (await turnStarted()(undefined, resolveCtx(CHAT_ID))) as { markdown: string };

    expect(result.markdown).toContain("## Tur: Paris");
    expect(result.markdown).toContain("Louvre");
    expect(result.markdown).toContain("## I dag");
  });

  it("degrades cleanly to a date-only fallback when no trip is linked to the chat", async () => {
    seedTripStore(); // a trip exists, but is linked to a DIFFERENT chat than the caller's
    const result = (await turnStarted()(undefined, resolveCtx("-999999"))) as { markdown: string };

    // ORB-107: the fallback is date + sweep status. It must still carry NO trip data.
    expect(result.markdown).toMatch(/^## I dag\n\d{4}-\d{2}-\d{2}\n\n## Reise-sveip\n/);
    expect(result.markdown).not.toContain("## Tur:");
  });

  it("degrades cleanly to the date-only fallback when the caller carries no chat id at all", async () => {
    const result = (await turnStarted()(undefined, resolveCtx(null))) as { markdown: string };

    // ORB-107: the fallback is date + sweep status. It must still carry NO trip data.
    expect(result.markdown).toMatch(/^## I dag\n\d{4}-\d{2}-\d{2}\n\n## Reise-sveip\n/);
  });

  it("never throws and never fabricates trip data when MARCEL_DATA_ROOT has no config.json yet", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true }); // fresh, unseeded data root

    const result = (await turnStarted()(undefined, resolveCtx(CHAT_ID))) as { markdown: string };

    // ORB-107: the fallback is date + sweep status. It must still carry NO trip data.
    expect(result.markdown).toMatch(/^## I dag\n\d{4}-\d{2}-\d{2}\n\n## Reise-sveip\n/);
  });

  // ORB-157 — the admin DM gets a trip registry so Marcel can SEE true link state instead of
  // confabulating it (2026-08-24: "gruppa er ikke linket ennå" about a linked group).
  describe("admin-DM trip registry (ORB-157)", () => {
    const ADMIN_ID = "123456789";

    function dmCtx(userId: string): DynamicResolveContext {
      const a = {
        authenticator: "telegram-webhook",
        principalId: `telegram:${userId}:${userId}`,
        principalType: "user",
        attributes: { chat_id: userId, chat_type: "private", user_id: userId },
      } as never;
      return {
        session: { id: "wrun_test", auth: { current: a, initiator: a } as SessionAuth },
        channel: {},
        messages: [],
      } as unknown as DynamicResolveContext;
    }

    beforeEach(() => {
      process.env["MARCEL_ADMIN_TELEGRAM_ID"] = ADMIN_ID;
    });

    afterEach(() => {
      delete process.env["MARCEL_ADMIN_TELEGRAM_ID"];
    });

    it("lists every trip with slug, dates, and its linked group's chat id", async () => {
      seedTripStore(); // paris-2026, linked to CHAT_ID
      const result = (await turnStarted()(undefined, dmCtx(ADMIN_ID))) as { markdown: string };

      expect(result.markdown).toContain("## Turer");
      expect(result.markdown).toContain("paris-2026");
      expect(result.markdown).toContain("2026-07-21");
      expect(result.markdown).toContain(CHAT_ID); // the true link state, verbatim
    });

    it("says a trip is unlinked when it has no group", async () => {
      const store = new TripStore(root);
      store.saveConfig({ adminId: ADMIN_ID, killSwitch: false, dailyTokenBudget: 1000, trips: [] });
      store.createTrip(baseTrip());
      const result = (await turnStarted()(undefined, dmCtx(ADMIN_ID))) as { markdown: string };

      expect(result.markdown).toContain("## Turer");
      expect(result.markdown).toContain("ikke linket");
    });

    it("gives a non-admin private chat NO registry", async () => {
      seedTripStore();
      const result = (await turnStarted()(undefined, dmCtx("999"))) as { markdown: string };

      expect(result.markdown).not.toContain("## Turer");
      expect(result.markdown).not.toContain("paris-2026");
    });

    it("stays on the plain fallback when the store is unseeded", async () => {
      const result = (await turnStarted()(undefined, dmCtx(ADMIN_ID))) as { markdown: string };

      expect(result.markdown).toMatch(/^## I dag\n\d{4}-\d{2}-\d{2}\n\n## Reise-sveip\n/);
      expect(result.markdown).not.toContain("## Turer");
    });
  });
});
