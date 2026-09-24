// Tests for ORB-96 — the per-trip destination persona overlay.
//
// The two rules the ticket says make this safe are the two things pinned hardest here:
//   1. the core stays byte-stable (a trip with no overlay renders EXACTLY what it rendered
//      before this feature existed — asserted against a literal snapshot, not a substring);
//   2. character, never facts (the generation prompt carries the truthfulness clause, and the
//      rendered section restates it at the point of use).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionAuth } from "eve/context";

import { TripStore, type Trip } from "../lib/trip-store.js";
import { buildTripContextMarkdown, type TripContextArgs } from "../lib/trip-context.js";
import { resolveTripContextMarkdown } from "../agent/instructions/trip-context.js";
import {
  OVERLAY_FILE,
  OVERLAY_START,
  OVERLAY_END,
  TRUTHFULNESS_CLAUSE,
  extractOverlay,
  generateOverlay,
  overlayPrompt,
  wrapOverlay,
} from "../lib/persona-overlay.js";
import { createNyturTool, type NyturDeps } from "../catalogue/nytur.js";
import { createPersonaOverlayTool, type PersonaOverlayDeps } from "../catalogue/persona_overlay.js";

const ADMIN_ID = "123456789";
const CHAT_ID = "-100123";

const NYC = {
  name: "The Big Apple",
  destination: { name: "New York" },
  start: "2026-08-28",
  end: "2026-09-04",
};

const SAMPLE_OVERLAY =
  "Du tenker i nabolag, ikke adresser. Du vet at tjue kvartaler er et kvarter til fots, og at " +
  "det som er stille klokka sju er umulig klokka ni.\n\nDu kjenner Sal — pensjonert taxisjåfør " +
  "fra Bensonhurst, tålmodig med turister, utålmodig med kø.";

function auth(overrides: Partial<{ chatType: string; userId: string; chatId: string }> = {}): SessionAuth {
  const chatType = overrides.chatType ?? "private";
  const userId = overrides.userId ?? ADMIN_ID;
  const chatId = overrides.chatId ?? (chatType === "private" ? userId : CHAT_ID);
  const a = {
    authenticator: "telegram-webhook",
    principalId: chatType === "private" ? `telegram:${userId}` : `telegram:${chatId}:${userId}`,
    principalType: "user",
    attributes: { chat_id: chatId, chat_type: chatType, user_id: userId },
  } as never;
  return { current: a, initiator: a } as SessionAuth;
}

function ctx(a: SessionAuth | null) {
  return { session: { id: "wrun_test", auth: a } } as never;
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-persona-overlay-"));
  process.env["MARCEL_DATA_ROOT"] = root;
  process.env["MARCEL_ADMIN_TELEGRAM_ID"] = ADMIN_ID;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env["MARCEL_DATA_ROOT"];
  delete process.env["MARCEL_ADMIN_TELEGRAM_ID"];
});

function seedStore(): { store: TripStore; trip: Trip } {
  const store = new TripStore(root);
  store.saveConfig({ adminId: ADMIN_ID, killSwitch: false, dailyTokenBudget: 1_000_000, trips: [] });
  const trip = store.createTrip({
    slug: "the-big-apple",
    name: NYC.name,
    start: NYC.start,
    end: NYC.end,
    timezone: "America/New_York",
    destination: { name: "New York", lat: 40.7128, lon: -74.006 },
  });
  store.linkChat(trip.slug, CHAT_ID);
  return { store, trip: { ...trip, chatId: CHAT_ID } };
}

// ── rule 2: character, never facts ───────────────────────────────────────────────────────

describe("the generation prompt", () => {
  it("carries the truthfulness clause verbatim", () => {
    expect(overlayPrompt(NYC)).toContain(TRUTHFULNESS_CLAUSE);
  });

  it("spells out what may NOT be invented", () => {
    const clause = TRUTHFULNESS_CLAUSE;
    for (const forbidden of ["restauranter", "åpningstider", "priser", "adresser"]) {
      expect(clause).toContain(forbidden);
    }
  });

  it("asks for the chosen strength dial — instincts and framing PLUS one named local", () => {
    const p = overlayPrompt(NYC);
    expect(p).toContain("INSTINKTER");
    expect(p).toContain("INNRAMMING");
    expect(p).toContain("ÉN LOKAL KJENNING");
  });

  it("names the destination and the trip window so the overlay is about THIS trip", () => {
    const p = overlayPrompt(NYC);
    expect(p).toContain("New York");
    expect(p).toContain("The Big Apple");
    expect(p).toContain("2026-08-28–2026-09-04");
  });

  it("forbids restating capabilities, gates or safety rules — the core is not the overlay's job", () => {
    expect(overlayPrompt(NYC)).toContain("Ikke skriv noe om hva Marcel KAN gjøre");
  });
});

describe("markers", () => {
  it("wraps generated text so the generated half is always identifiable", () => {
    const wrapped = wrapOverlay(SAMPLE_OVERLAY);
    expect(wrapped.startsWith(OVERLAY_START)).toBe(true);
    expect(wrapped.trimEnd().endsWith(OVERLAY_END)).toBe(true);
    expect(extractOverlay(wrapped)).toBe(SAMPLE_OVERLAY);
  });

  it("does not double-wrap on regeneration from its own output", () => {
    expect(wrapOverlay(wrapOverlay(SAMPLE_OVERLAY))).toBe(wrapOverlay(SAMPLE_OVERLAY));
  });

  it("takes a hand-edited file that lost its markers whole, rather than dropping it", () => {
    expect(extractOverlay("Bendik skrev denne selv.\n")).toBe("Bendik skrev denne selv.");
  });

  it("treats an empty model answer as no overlay at all", async () => {
    expect(await generateOverlay({ distill: async () => "   " }, NYC)).toBe("");
    expect(wrapOverlay("")).toBe("");
  });

  it("passes the prompt to the model exactly once", async () => {
    const distill = vi.fn(async () => SAMPLE_OVERLAY);
    await generateOverlay({ distill }, NYC);
    expect(distill).toHaveBeenCalledTimes(1);
  });
});

// ── rule 1: the core stays byte-stable ───────────────────────────────────────────────────

function baseArgs(overrides: Partial<TripContextArgs> = {}): TripContextArgs {
  return {
    trip: { name: NYC.name, start: NYC.start, end: NYC.end, destination: { name: "New York" } },
    tripMd: "",
    itinerary: "- 29/08: Highline",
    bookings: "",
    shopping: "",
    learned: "",
    tasteProfile: "",
    tasteGeoHits: "",
    todayISO: "2026-08-29",
    ...overrides,
  };
}

describe("injection", () => {
  it("renders nothing at all when the trip has no overlay — byte-identical to before ORB-96", () => {
    const without = buildTripContextMarkdown(baseArgs());
    expect(without).toBe(
      [
        "## Tur: The Big Apple",
        "2026-08-28 – 2026-09-04 · New York",
        "",
        "## Reiseplan",
        "- 29/08: Highline",
        "",
        "## I dag",
        "2026-08-29",
      ].join("\n"),
    );
    // and the same holds for the two ways "no overlay" can arrive
    expect(buildTripContextMarkdown(baseArgs({ personaOverlay: "" }))).toBe(without);
    expect(buildTripContextMarkdown(baseArgs({ personaOverlay: "  \n " }))).toBe(without);
  });

  it("renders the overlay under its own heading, above the rest of the trip context", () => {
    const md = buildTripContextMarkdown(baseArgs({ personaOverlay: wrapOverlay(SAMPLE_OVERLAY) }));
    expect(md).toContain("## Lokal farge (denne turen)");
    expect(md).toContain("Sal");
    expect(md.indexOf("## Lokal farge")).toBeGreaterThan(md.indexOf("## Tur:"));
    expect(md.indexOf("## Lokal farge")).toBeLessThan(md.indexOf("## Reiseplan"));
  });

  it("restates the truthfulness rule at the point of use, so a hand-edited overlay still carries it", () => {
    const md = buildTripContextMarkdown(baseArgs({ personaOverlay: "Bendik skrev denne selv." }));
    expect(md).toContain("Dette er STIL, ikke fakta");
    expect(md).toContain("henter du fortsatt med verktøy");
    expect(md).toContain("Bendik skrev denne selv.");
  });

  it("reaches the assembled context from the trip's own file on disk", () => {
    const { store, trip } = seedStore();
    store.write(trip, OVERLAY_FILE, wrapOverlay(SAMPLE_OVERLAY));

    const md = resolveTripContextMarkdown(store, trip, Date.parse("2026-08-29T12:00:00Z"));

    expect(md).toContain("## Lokal farge (denne turen)");
    expect(md).toContain("Bensonhurst");
  });

  it("belongs to ONE trip — a second trip's context never sees the first trip's overlay", () => {
    const { store, trip } = seedStore();
    store.write(trip, OVERLAY_FILE, wrapOverlay(SAMPLE_OVERLAY));
    const other = store.createTrip({
      slug: "paris-2026",
      name: "Paris",
      start: "2026-10-01",
      end: "2026-10-05",
      timezone: "Europe/Paris",
      destination: { name: "Paris", lat: 48.8566, lon: 2.3522 },
    });

    const md = resolveTripContextMarkdown(store, other, Date.parse("2026-10-02T12:00:00Z"));

    expect(md).not.toContain("## Lokal farge");
    expect(md).not.toContain("Sal");
  });
});

// ── the creation and regeneration paths ──────────────────────────────────────────────────

function nyturDeps(overrides: Partial<NyturDeps> = {}): NyturDeps {
  const store = new TripStore(root);
  store.saveConfig({ adminId: ADMIN_ID, killSwitch: false, dailyTokenBudget: 1_000_000, trips: [] });
  return { store: () => store, ...overrides };
}

const NYTUR_INPUT = {
  name: "The Big Apple",
  destinationName: "New York",
  lat: 40.7128,
  lon: -74.006,
  startISO: "2026-08-28",
  endISO: "2026-09-04",
  timezone: "America/New_York",
};

describe("/nytur generates it once", () => {
  it("writes persona-overlay.md for the new trip", async () => {
    const personaOverlay = vi.fn(async (store: TripStore, trip: Trip) => {
      store.write(trip, OVERLAY_FILE, wrapOverlay(SAMPLE_OVERLAY));
      return true;
    });
    const tool = createNyturTool(nyturDeps({ personaOverlay }));

    const result = await tool.execute!(NYTUR_INPUT, ctx(auth()));

    expect(result).toMatchObject({ ok: true, slug: "the-big-apple", personaOverlay: true });
    expect(personaOverlay).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(root, "trips", "the-big-apple", OVERLAY_FILE), "utf8")).toContain("Sal");
  });

  it("still creates the trip when generation throws — the overlay is best-effort", async () => {
    const tool = createNyturTool(
      nyturDeps({
        personaOverlay: async () => {
          throw new Error("gateway 500");
        },
      }),
    );

    const result = await tool.execute!(NYTUR_INPUT, ctx(auth()));

    expect(result).toMatchObject({ ok: true, slug: "the-big-apple", personaOverlay: false });
    expect(new TripStore(root).trips().map((t) => t.slug)).toEqual(["the-big-apple"]);
    // empty file, so the trip simply speaks in base Marcel's voice
    expect(fs.readFileSync(path.join(root, "trips", "the-big-apple", OVERLAY_FILE), "utf8")).toBe("");
  });

  it("creates the file empty, so every trip has the same shape on disk", async () => {
    const tool = createNyturTool(nyturDeps());
    await tool.execute!(NYTUR_INPUT, ctx(auth()));
    expect(fs.existsSync(path.join(root, "trips", "the-big-apple", OVERLAY_FILE))).toBe(true);
  });
});

describe("persona_overlay regenerates it", () => {
  function deps(generate: PersonaOverlayDeps["generate"]): PersonaOverlayDeps {
    const { store } = seedStore();
    return { store: () => store, generate };
  }

  it("overwrites the trip's overlay via the same generator /nytur used", async () => {
    const generate = vi.fn(async (store: TripStore, trip: Trip) => {
      store.write(trip, OVERLAY_FILE, wrapOverlay("Ny farge."));
      return true;
    });
    const tool = createPersonaOverlayTool(deps(generate));

    const result = await tool.execute!({ slug: "the-big-apple" }, ctx(auth()));

    expect(result).toMatchObject({ ok: true, trip: "The Big Apple", destination: "New York" });
    expect(fs.readFileSync(path.join(root, "trips", "the-big-apple", OVERLAY_FILE), "utf8")).toContain("Ny farge.");
  });

  it("reports plainly when the model came back empty rather than claiming success", async () => {
    const tool = createPersonaOverlayTool(deps(async () => false));
    expect(await tool.execute!({ slug: "the-big-apple" }, ctx(auth()))).toMatchObject({
      error: expect.stringContaining("tomt"),
    });
  });

  it("says so when the slug does not exist", async () => {
    const tool = createPersonaOverlayTool(deps(async () => true));
    expect(await tool.execute!({ slug: "ingen-slik-tur" }, ctx(auth()))).toMatchObject({
      error: expect.stringContaining("ingen tur"),
    });
  });

  it("is admin-DM only — a group turn cannot regenerate the persona", async () => {
    const generate = vi.fn(async () => true);
    const tool = createPersonaOverlayTool(deps(generate));
    await expect(tool.execute!({ slug: "the-big-apple" }, ctx(auth({ chatType: "group" })))).rejects.toThrow(
      /admin-DM only/,
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("is admin-DM only — a non-admin DM cannot either", async () => {
    const generate = vi.fn(async () => true);
    const tool = createPersonaOverlayTool(deps(generate));
    await expect(tool.execute!({ slug: "the-big-apple" }, ctx(auth({ userId: "999" })))).rejects.toThrow(
      /admin-DM only/,
    );
    expect(generate).not.toHaveBeenCalled();
  });
});
