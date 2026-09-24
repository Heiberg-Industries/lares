/**
 * ORB-169 — `agent/instructions/travel-context.ts`'s per-turn injection.
 *
 * No Postgres here (unlike `tests/standing-facts.test.ts`) — `travel-store.ts` reads a plain
 * directory tree, so a real temp-directory fixture stands in for `TRAVEL_PATH`, mirroring
 * `tests/travel-store.test.ts`'s fixture shape. `currentTravel` is mocked (not the filesystem)
 * for the throwing/stalling cases, because `travel-store.ts` already guarantees those two
 * failure modes are unreachable through a real fixture — see its own header, point 4: every
 * failure except an unset `TRAVEL_PATH` is caught INSIDE the store and reported as
 * `unavailable`. Forcing them here is the only way to prove the resolver's own guard, not the
 * store's, is what is under test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DynamicResolveContext } from "eve/instructions";

vi.mock("../lib/travel-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/travel-store.js")>();
  return { ...actual, currentTravel: vi.fn(actual.currentTravel) };
});

import * as travelStore from "../lib/travel-store.js";
import travelContextInstructions, {
  TRAVEL_CONTEXT_TIMEOUT_MS,
} from "../agent/instructions/travel-context.js";

const resolveCtx = {
  session: { id: "wrun_test" },
  channel: {},
  messages: [],
} as unknown as DynamicResolveContext;

/** What eve calls every turn. Loosely typed, matching `standing-facts.test.ts`'s `injected()`:
 *  the point is the resolver's RUNTIME behaviour, not the framework's exact handler arity. */
async function injected(): Promise<string> {
  const handler = travelContextInstructions.events["turn.started"] as unknown as
    | ((event: unknown, ctx: unknown) => Promise<{ markdown: string }>)
    | undefined;
  if (!handler) throw new Error("turn.started handler missing");
  return (await handler(undefined, resolveCtx)).markdown;
}

/** `today` shifted by whole UTC days, formatted as `YYYY-MM-DD`. Trip windows below are
 *  anchored a day either side of "now" (rather than exactly on it) so the fixture tolerates
 *  the gap between the machine's UTC clock and the resolver's own Oslo clock without the test
 *  becoming flaky right around midnight. */
function shiftDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

let root: string | undefined;
const previousTravelPath = process.env.TRAVEL_PATH;

function buildFixture(bookingsMd: string, start: string, end: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-saga-travel-ctx-"));
  const config = {
    adminId: "1",
    killSwitch: false,
    dailyTokenBudget: 1,
    trips: [
      {
        slug: "the-big-apple",
        name: "The Big Apple",
        start,
        end,
        timezone: "America/New_York",
        destination: { name: "New York, USA" },
      },
    ],
  };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  const tripDir = path.join(dir, "trips", "the-big-apple");
  fs.mkdirSync(tripDir, { recursive: true });
  fs.writeFileSync(path.join(tripDir, "trip.md"), "# The Big Apple\n");
  fs.writeFileSync(path.join(tripDir, "itinerary.md"), "");
  fs.writeFileSync(path.join(tripDir, "bookings.md"), bookingsMd);
  return dir;
}

/** A store that IS readable-in-principle (`TRAVEL_PATH` points somewhere real) but whose
 *  `config.json` is not valid JSON — the same shape `travel-store.test.ts` uses to produce
 *  `unavailable` (its "config.json exists but is not JSON" case). This is deliberately NOT a
 *  `currentTravel` mock: the point of this fixture is to prove the resolver's OWN wiring of
 *  the real `unavailable` signal, not to re-assert that `loadTrips` can produce one (Task 5's
 *  suite already pins that). */
function buildBrokenFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-saga-travel-ctx-broken-"));
  fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
  return dir;
}

afterEach(() => {
  // `vi.clearAllMocks()`, not `restoreAllMocks()`: this mock was created with `vi.fn(impl)`,
  // not `vi.spyOn`, so `mockRestore` would wipe its base implementation down to "returns
  // undefined" rather than back to the real `currentTravel` — clearing only the call history
  // (and any per-test `mockImplementationOnce`) leaves the real fallback intact for the next
  // test, which every test but the two failure-mode ones below relies on.
  vi.clearAllMocks();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
  if (previousTravelPath === undefined) delete process.env.TRAVEL_PATH;
  else process.env.TRAVEL_PATH = previousTravelPath;
});

describe("travel context injection (ORB-169)", () => {
  it("TRAVEL_PATH unset → empty and silent (current production state, ahead of Deploy B2)", async () => {
    delete process.env.TRAVEL_PATH;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await injected()).toBe("");
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("no trip → empty markdown", async () => {
    root = buildFixture("", shiftDate(-100), shiftDate(-90)); // long finished, outside the horizon
    process.env.TRAVEL_PATH = root;
    expect(await injected()).toBe("");
  });

  it("a trip today → lodging, transport, and an unclassified item are all present, and the unclassified one is never presented as a departure", async () => {
    const bookings = [
      // The motivating bug, reproduced: a hotel booked the night BEFORE the trip's own start.
      `<!-- booking id:h1 kind:stay start:${shiftDate(-1)} end:${shiftDate(0)} time:15:00 provider:scandic -->`,
      "- Scandic Oslo Airport, 1 natt, innsjekk 15:00",
      "<!-- /booking -->",
      `<!-- booking id:f1 kind:flight start:${shiftDate(0)} end:- time:09:00 provider:sas -->`,
      "- SK4705 OSL → EWR 09:00",
      "<!-- /booking -->",
      // Marcel's extractor enum has no `train`, so a Vy booking is filed as `other`.
      `<!-- booking id:t1 kind:other start:${shiftDate(1)} end:- time:08:00 provider:vy -->`,
      "- Vy 601 Oslo S → Bergen 08:00, plass 42",
      "<!-- /booking -->",
    ].join("\n");
    root = buildFixture(bookings, shiftDate(-2), shiftDate(5));
    process.env.TRAVEL_PATH = root;

    const markdown = await injected();
    expect(markdown).toContain("## Travel");
    expect(markdown).toContain("Scandic Oslo Airport");
    expect(markdown).toContain("SK4705 OSL");
    expect(markdown).toContain("Vy 601 Oslo S");

    // The `other` line names the Vy booking and marks it unclassified / not a departure —
    // the exact regression ORB-169 exists to prevent one layer up from travel-store.ts.
    const vyLine = markdown.split("\n").find((l) => l.includes("Vy 601"));
    expect(vyLine).toBeDefined();
    expect(vyLine).toMatch(/unclassified/i);
    // It may use the word "departure" only to DENY it — never to assert one.
    expect(vyLine).toMatch(/not a confirmed departure/i);
    expect(vyLine).not.toMatch(/^- moves/);

    const flightLine = markdown.split("\n").find((l) => l.includes("SK4705"));
    expect(flightLine).toBeDefined();
    expect(flightLine).not.toMatch(/unclassified/i);
  });

  it("a store that read but came back `unavailable` → empty markdown AND a distinct logged message, never rendered as 'no travel'", async () => {
    root = buildBrokenFixture();
    process.env.TRAVEL_PATH = root;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await injected()).toBe("");
    expect(errSpy).toHaveBeenCalled();
    // Not just ANY error — the resolver's own message naming the failure as an outage, so a
    // reader of the logs can tell this apart from `loadTrips`'s internal log and from the two
    // other failure branches (throw / stall) below.
    const messages = errSpy.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => /travel-context resolver.*unavailable this turn/i.test(m))).toBe(
      true,
    );
  });

  it("a throwing store → empty markdown AND a logged error, no rejection", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(travelStore.currentTravel).mockImplementationOnce(() => {
      throw new Error("boom: store exploded");
    });
    await expect(injected()).resolves.toBe("");
    expect(errSpy).toHaveBeenCalled();
  });

  it("a stalling store → the timeout fires and yields empty, not a hang", async () => {
    vi.mocked(travelStore.currentTravel).mockImplementationOnce(
      () => new Promise(() => {}) as never,
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const startedAt = Date.now();
    await expect(injected()).resolves.toBe("");
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(TRAVEL_CONTEXT_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(TRAVEL_CONTEXT_TIMEOUT_MS + 2_000);
    expect(errSpy).toHaveBeenCalled();
  }, 10_000);
});
