/**
 * ORB-169 — the two travel tools are thin wrappers, and these tests hold them to that:
 * the allowlist and the containment check belong to lib/travel-store.ts (pinned in
 * tests/travel-store.test.ts), so what is asserted HERE is the wiring and the words —
 * that the descriptions say whose records these are, that they are read-only, and that
 * they must not be copied into the Brain.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import travelCurrent from "../catalogue/travel_current.js";
import { osloDate } from "../lib/recurrence.js";
import travelRead from "../catalogue/travel_read.js";

const tool = (t: unknown) =>
  t as {
    description: string;
    inputSchema: { parse(v: unknown): unknown };
    execute(input: unknown, ctx?: unknown): Promise<unknown>;
  };

let root: string;
const previous = process.env.TRAVEL_PATH;

const BOOKINGS_MD = [
  "<!-- booking id:h1 kind:stay start:2026-08-24 end:2026-08-25 time:15:00 provider:scandic-oslo-airport -->",
  "- Scandic Oslo Airport, 1 natt, innsjekk 15:00",
  "<!-- /booking -->",
  "<!-- booking id:f1 kind:flight start:2026-08-26 end:- time:09:00 provider:sas -->",
  "- SK4705 OSL → EWR 09:00",
  "<!-- /booking -->",
].join("\n");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-saga-travel-tools-"));
  // OSLO's date, not UTC's. `travel_current` resolves "today" on the Oslo clock (it must — that
  // is what keeps Saga and Marcel agreeing about which day it is), so anchoring the fixture on
  // `toISOString()` made this file fail for the two hours a night when the two disagree: between
  // Oslo midnight and 02:00 the UTC date is still yesterday's, the trip was written with
  // yesterday's dates, and the tool correctly found no trip covering today.
  const today = osloDate(new Date());
  fs.writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({
      adminId: "1",
      killSwitch: false,
      dailyTokenBudget: 1,
      // Anchored on the real clock: travel_current takes no arguments and asks for TODAY,
      // which is the point of it having no arguments.
      trips: [
        {
          slug: "the-big-apple",
          name: "The Big Apple",
          start: today,
          end: today,
          timezone: "America/New_York",
          destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 },
        },
      ],
    }),
  );
  const dir = path.join(root, "trips", "the-big-apple");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "trip.md"), "# The Big Apple\n");
  fs.writeFileSync(path.join(dir, "itinerary.md"), "");
  fs.writeFileSync(path.join(dir, "bookings.md"), BOOKINGS_MD);
  fs.writeFileSync(path.join(dir, "learned.md"), "familie-private notater\n");
  process.env.TRAVEL_PATH = root;
});

afterEach(() => {
  if (previous === undefined) delete process.env.TRAVEL_PATH;
  else process.env.TRAVEL_PATH = previous;
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("travel_current", () => {
  it("takes no arguments and answers for today", async () => {
    const result = (await tool(travelCurrent).execute({})) as {
      trips: { trip: { slug: string }; lodging: unknown[]; transport: unknown[] }[];
      unavailable?: string;
    };
    expect(result.unavailable).toBeUndefined();
    expect(result.trips).toHaveLength(1);
    expect(result.trips[0]!.trip.slug).toBe("the-big-apple");
    expect(result.trips[0]!.lodging).toHaveLength(1);
    expect(result.trips[0]!.transport).toHaveLength(1);
  });

  it("says the store is unavailable rather than reporting no travel", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fs.rmSync(path.join(root, "config.json"));
    const result = (await tool(travelCurrent).execute({})) as { trips: unknown[]; unavailable?: string };
    expect(result.trips).toEqual([]);
    expect(result.unavailable).toBeTruthy();
  });

  it("sees TONIGHT's hotel on the night before the trip starts — the motivating bug", () => {
    // 2026-08-24: a Scandic Oslo Airport stay belonging to a trip that starts on the 25th.
    // travel_current must reach past today, or the brief says nothing about the bed Bendik is
    // actually sleeping in and ORB-169 reopens green. This asserts the CALLER passes a horizon,
    // not just that the store supports one.
    // OSLO's clock again, and here the consequence is quieter than a red test — UTC is never
    // AHEAD of Oslo, so this cannot fail. Between Oslo midnight and 02:00 the UTC "tomorrow" IS
    // Oslo's today, the fixture becomes a trip starting TODAY, and the test silently stops
    // exercising the horizon it exists to prove.
    const tomorrow = osloDate(new Date(Date.now() + 86_400_000));
    const dayAfter = osloDate(new Date(Date.now() + 2 * 86_400_000));
    fs.writeFileSync(
      path.join(root, "config.json"),
      JSON.stringify({
        adminId: "1",
        killSwitch: false,
        dailyTokenBudget: 1,
        trips: [
          {
            slug: "the-big-apple",
            name: "The Big Apple",
            start: tomorrow,
            end: dayAfter,
            timezone: "America/New_York",
            destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 },
          },
        ],
      }),
    );

    return tool(travelCurrent)
      .execute({})
      .then((r) => {
        const result = r as { trips: { lodging: { summary: string }[] }[] };
        expect(result.trips).toHaveLength(1);
        expect(result.trips[0]!.lodging.map((b) => b.summary).join()).toContain(
          "Scandic Oslo Airport",
        );
      });
  });

  it("hands the model a train it must not mistake for a confirmed leg", () => {
    // Marcel can only file a Vy booking as kind:other. travel_current must still surface it —
    // a Bergen hotel with `transport: []` and no mention of the train is the bug in new clothes.
    fs.appendFileSync(
      path.join(root, "trips", "the-big-apple", "bookings.md"),
      "\n<!-- booking id:t1 kind:other start:2026-08-30 end:- time:08:00 provider:vy -->\n" +
        "- Vy 601 Oslo S → Bergen 08:00\n<!-- /booking -->",
    );
    return tool(travelCurrent)
      .execute({})
      .then((r) => {
        const result = r as { trips: { transport: unknown[]; other: { provider?: string }[] }[] };
        expect(result.trips[0]!.other.map((b) => b.provider)).toContain("vy");
        expect(JSON.stringify(result.trips[0]!.transport)).not.toContain("vy");
      });
  });

  it("tells the model what the `other` bucket is, so an empty `transport` is not read as 'not moving'", () => {
    const d = tool(travelCurrent).description;
    expect(d).toMatch(/`other`/u);
    expect(d).toMatch(/train/iu);
    expect(d).toMatch(/never as a confirmed journey/u);
  });

  it("carries no approval — reading Marcel's itinerary changes nothing", () => {
    expect((travelCurrent as { approval?: unknown }).approval).toBeUndefined();
  });

  it("names Marcel, says read-only, and forbids copying into the Brain", () => {
    const d = tool(travelCurrent).description;
    expect(d).toMatch(/MARCEL/u);
    expect(d).toMatch(/READ-ONLY/u);
    expect(d).toMatch(/Brain/u);
  });
});

describe("travel_read", () => {
  it("returns an allowlisted file verbatim", async () => {
    const result = (await tool(travelRead).execute({ slug: "the-big-apple", file: "bookings.md" })) as {
      content: string;
      lines: number;
    };
    expect(result.content).toContain("SK4705");
    expect(result.lines).toBeGreaterThan(0);
  });

  it("reads an EMPTY itinerary.md as empty, not as a failure", async () => {
    const result = (await tool(travelRead).execute({ slug: "the-big-apple", file: "itinerary.md" })) as {
      content: string;
    };
    expect(result.content).toBe("");
  });

  it("cannot be asked for a family-private file — the schema itself refuses", () => {
    for (const file of ["learned.md", "shopping.md", "persona-overlay.md", "../../reise-log.md"]) {
      expect(() => tool(travelRead).inputSchema.parse({ slug: "the-big-apple", file })).toThrow();
    }
  });

  it("refuses a non-allowlisted file at RUNTIME too, not only in the schema", async () => {
    // The schema is eve's guard; the store is the real one. A caller that bypasses the schema
    // (a future internal caller, a loosened enum) must still be refused.
    await expect(tool(travelRead).execute({ slug: "the-big-apple", file: "learned.md" })).rejects.toThrow(
      /not a readable trip file/u,
    );
  });

  it("names Marcel, says read-only, and forbids copying into the Brain", () => {
    const d = tool(travelRead).description;
    expect(d).toMatch(/MARCEL/u);
    expect(d).toMatch(/READ-ONLY/u);
    expect(d).toMatch(/Brain/u);
  });

  it("carries no approval — it is a read", () => {
    expect((travelRead as { approval?: unknown }).approval).toBeUndefined();
  });
});
