/**
 * ORB-193 Task 4 — the WIRING proof: every NEW outbound message `trip-lifecycle` produces goes
 * through `@lares/agent-kit/proactivity`'s `gatedSend`, and an EDIT of a live card does not.
 *
 * The gate is MOCKED here, for the same reason eve-saga's `tests/proactivity-wiring.test.ts`
 * mocks it: under the default settings the real engine answers `send` for everything this fleet
 * sends (the plan's Global Constraints), so a test against the real engine cannot tell "gated"
 * from "not wired at all". A mocked `suppress` can, and it is also the only way to assert the
 * property that costs Marcel a message: `sent.json` must NOT record a post the gate held back —
 * a held item stays eligible for the next tick.
 *
 * Three send sites, two initiation classes:
 *   - the lifecycle post (`post` dep → an agent turn)                         → `scheduled`
 *   - the flight card's first appearance (`postFlightMessageWithId`)          → `event`
 *   - a delta/cancellation line (`postFlightMessage`)                         → `event`
 *   - the card's later updates (`editFlightMessage`)                          → NOT an initiation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { TripStore, type Trip } from "../lib/trip-store.js";

// ─── The mocked gate ────────────────────────────────────────────────────────────────────────

type Verdict =
  | { verdict: "send" }
  | { verdict: "suppress"; reason: string }
  | { verdict: "defer"; reason: string; until: string };

let verdict: Verdict = { verdict: "suppress", reason: "dnd" };

interface GateCall {
  req: {
    owner: string;
    agent: string;
    door: string;
    cls: string;
    itemKey: string;
    now: Date;
    tz: string;
    ownerSetTime?: boolean;
  };
}

const gatedSendMock = vi.fn(async (_db: unknown, req: unknown, send: () => Promise<void>) => {
  if (verdict.verdict === "send") await send();
  return verdict;
});

// PARTIAL mock: everything else in the module (the engine defaults, the clock helpers) is the
// real thing — only the one function the service calls is replaced.
vi.mock("@lares/agent-kit/proactivity", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gatedSend: gatedSendMock,
}));

/** A pool stand-in. The gate is mocked, so no SQL ever runs — but `initiate` must be able to
 *  BUILD a pool, or it takes its documented fail-open path and sends ungated, which is exactly
 *  what these tests must be able to distinguish from a real `send` verdict. */
vi.mock("@lares/agent-kit/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPool: () => ({ query: async () => ({ rows: [] }) }),
}));

/** The owner clock has its own tests (`tests/owner-clock.test.ts`); pinned to UTC here so the
 *  fixtures' UTC trip clock and the gate's tz are the same one. */
vi.mock("../lib/owner-clock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/owner-clock.js")>()),
  ownerTz: async () => "UTC",
}));

// ─── Telegram + flights, stubbed at eve's own seams ─────────────────────────────────────────

const sendTelegramMessageMock = vi.fn(async () => ({ id: "1001" }));
const callTelegramApiMock = vi.fn(async () => ({ ok: true, body: {} }));

// PARTIAL: `agent/channels/telegram.ts` (imported transitively) needs the real
// `telegramChannel` factory at module scope; only the two raw primitives are replaced.
vi.mock("eve/channels/telegram", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTelegramMessage: sendTelegramMessageMock,
  callTelegramApi: callTelegramApiMock,
}));

const flightStatusMock = vi.fn();

vi.mock("../catalogue/flight_status.js", () => ({
  defaultFlightStatusDeps: { flights: () => ({ status: flightStatusMock }) },
}));

// ─── Env + fixtures ─────────────────────────────────────────────────────────────────────────

// Every wrapper test imports `agent/schedules/trip-lifecycle.js` (and eve's whole Telegram graph)
// inside its own body, because `vi.resetModules()` is what makes the mocks above apply. That
// transform cost lands on the test's own clock, and on a machine running several vitest workers it
// has been measured at over ten seconds — the default 5 s would be a flake, not a finding. Set at
// module scope, not in `beforeEach`: a timeout is read when the test starts, and the FIRST test —
// the one that pays the transform — was still timing out when this was set from a hook.
vi.setConfig({ testTimeout: 30_000 });

const ENV_KEYS = [
  "EVE_SCHEDULES_LIVE",
  "MARCEL_DATA_ROOT",
  "MARCEL_ADMIN_TELEGRAM_ID",
  "MARCEL_CONNECTION_BUFFER_MIN",
  "AGENT_OWNER_USER_ID",
  "DATABASE_URL",
];
let saved: Record<string, string | undefined>;
let root: string;
let store: TripStore;

function ts(dateISO: string, time: string): number {
  const [y, mo, d] = dateISO.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Math.floor(Date.UTC(y!, mo! - 1, d!, h!, mi!) / 1000);
}

function makeTrip(): Trip {
  const trip = store.createTrip({
    slug: "paris-2026",
    name: "Paris",
    start: "2026-07-21",
    end: "2026-07-25",
    timezone: "UTC",
    destination: { name: "Paris", lat: 48.8566, lon: 2.3522 },
  });
  store.linkChat(trip.slug, "555");
  return { ...trip, chatId: "555" };
}

function bookingBlock(id: string, kind: string, startISO: string, time: string): string {
  return `<!-- booking id:${id} kind:${kind} start:${startISO} end:${startISO} time:${time} -->\n- test booking\n<!-- /booking -->\n`;
}

function flightBookingBlock(id: string, startISO: string, time: string, flightNo: string): string {
  return `<!-- booking id:${id} kind:flight start:${startISO} end:${startISO} time:${time} -->\n- ${flightNo} avgang\n<!-- /booking -->\n`;
}

function sentLedger(trip: Trip): Record<string, boolean> {
  const file = path.join(trip.dir, "sent.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, boolean>;
}

function gateCalls(prefix = ""): GateCall["req"][] {
  return gatedSendMock.mock.calls
    .map((c) => c[1] as GateCall["req"])
    .filter((req) => req.itemKey.startsWith(prefix));
}

/** One tick of the real schedule, with eve's `to`/`waitUntil`/`appAuth` stubbed. */
async function schedule(): Promise<{
  run: () => Promise<void>;
  turns: { chatId: string; message: string }[];
}> {
  const turns: { chatId: string; message: string }[] = [];
  const to = (_channel: unknown, target: { chatId: string }) => ({
    send: async (message: string) => {
      turns.push({ chatId: target.chatId, message });
    },
  });
  const mod = await import("../agent/schedules/trip-lifecycle.js");
  const appAuth = { attributes: {}, authenticator: "app", principalId: "eve:app", principalType: "runtime" };
  return {
    turns,
    run: () => mod.default.run!({ to: to as never, waitUntil: () => {}, appAuth: appAuth as never }),
  };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AGENT_OWNER_USER_ID = "bendik"; // explicit legacy fixture identity
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-proactivity-"));
  store = new TripStore(root);
  store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1000, homeTimezone: "UTC", trips: [] });
  process.env["EVE_SCHEDULES_LIVE"] = "1";
  process.env["MARCEL_DATA_ROOT"] = root;
  verdict = { verdict: "suppress", reason: "dnd" };
  gatedSendMock.mockClear();
  sendTelegramMessageMock.mockClear();
  callTelegramApiMock.mockClear();
  flightStatusMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

// ─── The ledger keys ────────────────────────────────────────────────────────────────────────

describe("lib/principals.ts — the ledger's two identity keys", () => {
  it("ownerId is the canonical id unless AGENT_OWNER_USER_ID says otherwise", async () => {
    const { ownerId, doorId } = await import("../lib/principals.js");
    expect(() => ownerId({})).toThrow("Owner identity is not configured");
    expect(ownerId({ AGENT_OWNER_USER_ID: " alice " })).toBe("alice");
    expect(() => ownerId({ AGENT_OWNER_USER_ID: "  " })).toThrow("Owner identity is not configured");
    expect(doorId("telegram", "-5405035031")).toBe("telegram:-5405035031");
  });
});

describe("lib/initiation.ts — the item-key shapes", () => {
  it("a lifecycle post is `trip/<slug>/<kind>/<dateISO>`", async () => {
    const { tripItemKey } = await import("../lib/initiation.js");
    expect(tripItemKey("paris-2026", "evening", { dateISO: "2026-07-22" })).toBe(
      "trip/paris-2026/evening/2026-07-22",
    );
  });

  it("a reminder appends the booking id — a day can hold several", async () => {
    const { tripItemKey } = await import("../lib/initiation.js");
    expect(tripItemKey("paris-2026", "reminder", { dateISO: "2026-07-22", itemId: "bk1" })).toBe(
      "trip/paris-2026/reminder/2026-07-22/bk1",
    );
  });

  it("a flight card is `flight/<slug>/<flightRef>/<state fingerprint>`", async () => {
    const { flightItemKey } = await import("../lib/initiation.js");
    expect(
      flightItemKey({ slug: "paris-2026", flightRef: "SK4705:2026-07-22", fingerprint: "14:40+-+-+ok" }),
    ).toBe("flight/paris-2026/SK4705:2026-07-22/14:40+-+-+ok");
  });

  it("the fingerprint is the material state, not the card's text", async () => {
    const { flightStateFingerprint } = await import("../lib/trip-schedule.js");
    expect(flightStateFingerprint({ estimated: "14:40", gate: "A10" })).toBe("14:40+A10+-+ok");
    expect(flightStateFingerprint({ cancelled: true })).toBe("-+-+-+cancelled");
  });
});

// ─── The lifecycle post ─────────────────────────────────────────────────────────────────────

describe("trip-lifecycle — the lifecycle post passes the gate", () => {
  it("a suppressed post is never sent, and — being scheduled — is dropped for good", async () => {
    // Plan Ruling 3: a scheduled slot inside quiet hours or under DND is dropped, not queued. The
    // `sent.json` mark therefore STAYS, which is what stops this schedule re-offering the post
    // every minute for the rest of its window (and the ledger taking one suppression row a minute).
    const trip = makeTrip();
    vi.spyOn(Date, "now").mockReturnValue(ts("2026-07-22", "20:00") * 1000);

    const { run, turns } = await schedule();
    await run();

    // The gate was consulted for the due slots…
    expect(gateCalls("trip/").length).toBeGreaterThan(0);
    // …and not one agent turn was started.
    expect(turns).toHaveLength(0);
    expect(sentLedger(trip)["2026-07-22:evening"]).toBe(true);

    // …and a second tick does not ask again.
    const asked = gatedSendMock.mock.calls.length;
    await run();
    expect(gatedSendMock.mock.calls.length).toBe(asked);
  });

  it("names the owner, the agent, the door, the class and the item key", async () => {
    makeTrip();
    vi.spyOn(Date, "now").mockReturnValue(ts("2026-07-22", "20:00") * 1000);

    const { run } = await schedule();
    await run();

    const evening = gateCalls("trip/").find((r) => r.itemKey.includes("/evening/"));
    expect(evening).toBeDefined();
    expect(evening!.owner).toBe("bendik");
    expect(evening!.agent).toBe("marcel");
    expect(evening!.door).toBe("telegram:555");
    expect(evening!.cls).toBe("scheduled");
    expect(evening!.itemKey).toBe("trip/paris-2026/evening/2026-07-22");
    expect(evening!.tz).toBe("UTC");
    expect(evening!.now).toBeInstanceOf(Date);
  });

  it("a send verdict posts exactly as before and marks sent.json", async () => {
    const trip = makeTrip();
    verdict = { verdict: "send" };
    vi.spyOn(Date, "now").mockReturnValue(ts("2026-07-22", "20:00") * 1000);

    const { run, turns } = await schedule();
    await run();

    expect(turns.map((t) => t.chatId)).toContain("555");
    expect(turns.length).toBe(gateCalls("trip/").length);
    expect(sentLedger(trip)["2026-07-22:evening"]).toBe(true);
  });

  it("a deferred post also stays eligible — the next tick offers it again", async () => {
    const trip = makeTrip();
    verdict = { verdict: "defer", reason: "quiet-hours", until: "2026-07-23T05:00:00.000Z" };
    vi.spyOn(Date, "now").mockReturnValue(ts("2026-07-22", "20:00") * 1000);

    const { run, turns } = await schedule();
    await run();
    const first = gateCalls("trip/").length;
    await run();

    expect(turns).toHaveLength(0);
    expect(sentLedger(trip)).toEqual({});
    expect(gateCalls("trip/").length).toBe(first * 2); // re-offered, not silently dropped
  });

  it("fails OPEN: with no reachable ledger the post still goes out, ungated and warned", async () => {
    // The one posture ORB-179 bought: a missed suppression is an annoyance, a silent stop is ten
    // dead days. `getPool` throwing (no DATABASE_URL on the box) must not cost Marcel a post.
    const trip = makeTrip();
    const db = await import("@lares/agent-kit/db");
    vi.spyOn(db, "getPool").mockImplementation(() => {
      throw new Error("DATABASE_URL is not set");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(ts("2026-07-22", "20:00") * 1000);

    const { run, turns } = await schedule();
    await run();

    expect(gatedSendMock).not.toHaveBeenCalled();
    expect(turns.length).toBeGreaterThan(0);
    expect(sentLedger(trip)["2026-07-22:evening"]).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("sending UNGATED"))).toBe(true);
  });

  it("a reminder's key carries the booking id, so two bookings on one day are two items", async () => {
    const trip = makeTrip();
    store.write(
      trip,
      "bookings.md",
      bookingBlock("bk1", "restaurant", "2026-07-22", "12:00") +
        bookingBlock("bk2", "museum", "2026-07-22", "15:00"),
    );
    verdict = { verdict: "send" };
    vi.spyOn(Date, "now").mockReturnValue(ts("2026-07-22", "15:00") * 1000);

    const { run } = await schedule();
    await run();

    const reminders = gateCalls("trip/paris-2026/reminder/");
    expect(reminders.map((r) => r.itemKey)).toEqual([
      "trip/paris-2026/reminder/2026-07-22/bk1",
      "trip/paris-2026/reminder/2026-07-22/bk2",
    ]);
    // Plan Ruling 3 — the owner's own booking chose the hour, so quiet hours do not apply. Without
    // this a 21:30 reminder was suppressed for good: `reminderFireTime` only rolls forward from
    // 22:00, while the gate's quiet window opens at 21:00.
    for (const r of reminders) expect(r.ownerSetTime).toBe(true);
  });

  it("only reminders are quiet-hours exempt — a weatherwarn or an evening post is not", async () => {
    makeTrip();
    verdict = { verdict: "send" };
    vi.spyOn(Date, "now").mockReturnValue(ts("2026-07-22", "20:00") * 1000);

    const { run } = await schedule();
    await run();

    for (const r of gateCalls("trip/")) expect(r.ownerSetTime).toBe(false);
  });
});

// ─── The flight card ────────────────────────────────────────────────────────────────────────

describe("trip-lifecycle — the flight card passes the gate, its edits do not", () => {
  function scriptFlight(): void {
    let calls = 0;
    flightStatusMock.mockImplementation(async (ref: { flightNo: string; dateISO: string }) => {
      calls++;
      const base = { flightNo: ref.flightNo, dateISO: ref.dateISO, scheduled: "14:15", cancelled: false, source: "avinor" };
      if (calls === 1) return base; // baseline sighting — never a post
      if (calls === 2) return { ...base, estimated: "14:40" }; // +25 min — the first material change
      return { ...base, estimated: "14:40", gate: "A10" }; // second change — an EDIT of the live card
    });
  }

  it("the card's first appearance is an `event` initiation keyed by the material state", async () => {
    const trip = makeTrip();
    store.write(trip, "bookings.md", flightBookingBlock("f1", "2026-07-22", "14:15", "SK4705"));
    scriptFlight();
    verdict = { verdict: "send" };

    const nowSpy = vi.spyOn(Date, "now");
    const { run } = await schedule();

    nowSpy.mockReturnValue(ts("2026-07-22", "10:00") * 1000);
    await run(); // baseline poll
    expect(gateCalls("flight/")).toHaveLength(0);

    nowSpy.mockReturnValue(ts("2026-07-22", "10:06") * 1000);
    await run(); // first material change — the card is posted

    const card = gateCalls("flight/");
    expect(card).toHaveLength(1);
    expect(card[0]!.cls).toBe("event");
    expect(card[0]!.door).toBe("telegram:555");
    expect(card[0]!.itemKey).toBe("flight/paris-2026/SK4705:2026-07-22/14:40+-+-+ok");
    expect(sendTelegramMessageMock).toHaveBeenCalled();
  });

  it("an EDIT of the live card is not an initiation — the gate is never asked", async () => {
    const trip = makeTrip();
    store.write(trip, "bookings.md", flightBookingBlock("f1", "2026-07-22", "14:15", "SK4705"));
    scriptFlight();
    verdict = { verdict: "send" };

    const nowSpy = vi.spyOn(Date, "now");
    const { run } = await schedule();

    nowSpy.mockReturnValue(ts("2026-07-22", "10:00") * 1000);
    await run();
    nowSpy.mockReturnValue(ts("2026-07-22", "10:06") * 1000);
    await run(); // posts the card, id 1001
    const afterPost = gateCalls("flight/").length;
    expect(afterPost).toBe(1); // the card itself was gated…

    nowSpy.mockReturnValue(ts("2026-07-22", "10:12") * 1000);
    await run(); // gate A10 — an edit of message 1001

    expect(callTelegramApiMock).toHaveBeenCalled();
    expect(callTelegramApiMock.mock.calls.some((c) => (c[0] as { method: string }).method === "editMessageText")).toBe(true);
    expect(gateCalls("flight/").length).toBe(afterPost); // no second initiation
  });

  it("a CANCELLATION at 23:00 trip time is quiet-hours exempt at the gate", async () => {
    // The state advances before the send (`diffFlightState` writes `cancelled: true`), so the alert
    // is never generated a second time: a quiet-hours deferral would lose it, not delay it. Hence
    // `ownerSetTime` — this fleet's "an owner set this time, OR this is safety-critical" flag.
    const trip = makeTrip();
    store.write(trip, "bookings.md", flightBookingBlock("f9", "2026-07-22", "23:30", "SK4705"));
    let calls = 0;
    flightStatusMock.mockImplementation(async (ref: { flightNo: string; dateISO: string }) => {
      calls++;
      return {
        flightNo: ref.flightNo,
        dateISO: ref.dateISO,
        scheduled: "23:30",
        cancelled: calls > 1, // poll 1 = baseline, poll 2 = cancelled
        source: "avinor",
      };
    });
    verdict = { verdict: "send" };

    const nowSpy = vi.spyOn(Date, "now");
    const { run } = await schedule();

    nowSpy.mockReturnValue(ts("2026-07-22", "22:00") * 1000);
    await run(); // baseline, inside the T-6h window
    expect(gateCalls("flight/")).toHaveLength(0);

    // The owner is in DND: the alert is offered, held back, and nothing crashes.
    verdict = { verdict: "suppress", reason: "dnd" };
    nowSpy.mockReturnValue(ts("2026-07-22", "23:00") * 1000);
    await expect(run()).resolves.toBeUndefined();

    const alert = gateCalls("flight/");
    expect(alert).toHaveLength(1);
    expect(alert[0]!.cls).toBe("event");
    expect(alert[0]!.ownerSetTime).toBe(true);
    expect(alert[0]!.itemKey).toBe("flight/paris-2026/SK4705:2026-07-22/-+-+-+cancelled");
    expect(sendTelegramMessageMock).not.toHaveBeenCalled(); // DND is terminal, by design
  });

  it("a card update is NOT quiet-hours exempt — only a cancellation is", async () => {
    const trip = makeTrip();
    store.write(trip, "bookings.md", flightBookingBlock("f1", "2026-07-22", "14:15", "SK4705"));
    scriptFlight();
    verdict = { verdict: "send" };

    const nowSpy = vi.spyOn(Date, "now");
    const { run } = await schedule();
    nowSpy.mockReturnValue(ts("2026-07-22", "10:00") * 1000);
    await run();
    nowSpy.mockReturnValue(ts("2026-07-22", "10:06") * 1000);
    await run();

    expect(gateCalls("flight/")[0]!.ownerSetTime).toBeFalsy();
  });

  it("a suppressed card is not sent and no message id is recorded — the next change starts fresh", async () => {
    const trip = makeTrip();
    store.write(trip, "bookings.md", flightBookingBlock("f1", "2026-07-22", "14:15", "SK4705"));
    scriptFlight();

    const nowSpy = vi.spyOn(Date, "now");
    const { run } = await schedule();

    verdict = { verdict: "send" };
    nowSpy.mockReturnValue(ts("2026-07-22", "10:00") * 1000);
    await run(); // baseline

    verdict = { verdict: "suppress", reason: "dnd" };
    nowSpy.mockReturnValue(ts("2026-07-22", "10:06") * 1000);
    await run(); // first material change, held back

    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
    const state = JSON.parse(fs.readFileSync(path.join(trip.dir, "flight-state.json"), "utf8")) as Record<
      string,
      { messageId?: string }
    >;
    expect(state["SK4705:2026-07-22"]!.messageId).toBeUndefined();
  });
});

// ─── The proximity ping ─────────────────────────────────────────────────────────────────────

describe("proximity — an unsolicited geofence ping passes the gate", () => {
  const NOW_MS = ts("2026-07-22", "14:00") * 1000; // inside the trip window, outside quiet hours
  const SPOT = { lat: 48.8566, lon: 2.3522 };

  async function tickWith(verdictOf: "send" | "suppress" | "defer") {
    const trip = makeTrip();
    const items: { itemKey: string }[] = [];
    const { proximityTick, readLedgerState } = await import("../agent/schedules/proximity.js");
    const outcome = await proximityTick({
      root: () => root,
      position: () => ({ ...SPOT, at: NOW_MS / 1000, expiresAt: NOW_MS / 1000 + 900 }),
      places: () => [{ type: "place", name: "Le Baratin", ...SPOT } as never],
      trips: () => [trip],
      send: async (_text, item) => {
        items.push(item);
        return verdictOf;
      },
      now: () => NOW_MS,
    });
    return { outcome, items, ledger: readLedgerState(root) };
  }

  it("keys the ping `proximity/<tripSlug>/<place>/<localDay>`", async () => {
    const { outcome, items } = await tickWith("send");
    expect(outcome).toBe("sent");
    expect(items.map((i) => i.itemKey)).toEqual(["proximity/paris-2026/le-baratin/2026-07-22"]);
  });

  it("a held-back ping spends neither the cooldown nor the daily cap", async () => {
    const { outcome, ledger } = await tickWith("suppress");
    expect(outcome).toBe("nothing");
    // Nothing recorded: the place is still eligible, `lastSentSec` is unset and the day's budget is
    // untouched. A ping nobody received must not silence the next real one.
    expect(ledger).toEqual({ keys: [], sentToday: 0 });
  });

  it("a delivered ping records the place, the moment and one against the cap, exactly as before", async () => {
    const { ledger } = await tickWith("send");
    expect(ledger.keys).toEqual(["2026-07-22:le baratin"]);
    expect(ledger.sentToday).toBe(1);
    expect(ledger.lastSentSec).toBe(NOW_MS / 1000);
  });

  it("the live send dep is a gated `event` on the admin's Telegram door", async () => {
    process.env["MARCEL_ADMIN_TELEGRAM_ID"] = "123456789";
    const { defaultProximityDeps } = await import("../agent/schedules/proximity.js");

    const verdictReturned = await defaultProximityDeps.send("du går forbi Le Baratin", {
      itemKey: "proximity/paris-2026/le-baratin/2026-07-22",
    });

    expect(verdictReturned).toBe("suppress"); // the mocked gate's verdict, straight through
    const req = gateCalls("proximity/")[0];
    expect(req).toBeDefined();
    expect(req!.cls).toBe("event");
    expect(req!.agent).toBe("marcel");
    expect(req!.door).toBe("telegram:123456789");
    expect(req!.itemKey).toBe("proximity/paris-2026/le-baratin/2026-07-22");
    // The gate suppressed, so the raw Telegram send was never reached — no network, no crash.
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });
});
