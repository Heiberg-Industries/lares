// ORB-105 — cancellations and modifications as ONE supersede mechanism.
//
// From two live cases on 2026-08-17. A cancelled Standard High Line reservation left the original
// stay filed in The Big Apple while the cancellation was discarded — a trip file confidently
// listing a dead hotel is worse than one missing it. And a changed-date dinner resolved correctly
// only by dedupe luck, because the pipeline had no concept of modification either.
//
// THE defect class these tests exist for is order-dependence: a sweep reads a year of mail in
// whatever order Gmail hands it over, so booking-then-cancellation and cancellation-then-booking
// must converge on the same answer — the reservation is not in the trip file.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { TripStore, type Trip } from "../lib/trip-store.js";
import { fileExtractionCache } from "../lib/extraction-cache.js";
import {
  BookingPipeline,
  isSameReservation,
  supersedeKey,
  type Booking,
  type ReiseMail,
} from "../lib/bookings.js";

const ADMIN = "123456789";
const NOW = 1_786_970_000;

let root: string;
let sent: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-supersede-"));
  sent = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function seedTrip(): { store: TripStore; trip: Trip } {
  const store = new TripStore(root);
  store.saveConfig({ adminId: ADMIN, killSwitch: false, dailyTokenBudget: 1_000_000, trips: [] });
  const trip = store.createTrip({
    slug: "the-big-apple",
    name: "The Big Apple",
    start: "2026-08-25",
    end: "2026-08-31",
    timezone: "America/New_York",
    destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 },
  });
  return { store, trip };
}

/** A pipeline whose extractor answers from a fixture map keyed by gmail id. */
function makePipeline(store: TripStore, extractions: Record<string, Booking | null>, withCache = true) {
  return new BookingPipeline({
    extract: async (mail) => {
      const found = extractions[mail.id];
      return found === undefined ? null : found;
    },
    store,
    tg: { send: async (_chat, text) => { sent.push(text); return "1"; } },
    adminId: ADMIN,
    now: () => NOW,
    ...(withCache ? { cache: fileExtractionCache(root) } : {}),
  });
}

const mail = (id: string, subject: string): ReiseMail => ({
  id,
  subject,
  from: "reservations@standardhotels.com",
  receivedAt: "2026-08-10T09:00:00Z",
  bodyText: subject,
});

const STAY: Booking = {
  id: "m-booking",
  kind: "stay",
  action: "book",
  provider: "The Standard High Line",
  ref: "SHL-88421",
  startISO: "2026-08-25",
  endISO: "2026-08-28",
  details: "QUEEN GREAT VIEW, The Standard High Line, 25.–28. aug",
};

const CANCEL: Booking = {
  ...STAY,
  id: "m-cancel",
  action: "cancel",
  details: "Avbestilt: QUEEN GREAT VIEW, The Standard High Line",
};

const bookingsFile = (store: TripStore, trip: Trip) => store.read(trip, "bookings.md");

// ── identity ─────────────────────────────────────────────────────────────────────────────

describe("what makes two mails the same reservation", () => {
  it("is the booking reference when there is one, however it is punctuated", () => {
    expect(supersedeKey({ kind: "stay", provider: "X", ref: "shl 88421", startISO: "2026-08-25" }))
      .toBe(supersedeKey({ kind: "stay", provider: "Y", ref: "#SHL-88421", startISO: "2026-09-01" }));
  });

  it("falls back to kind + provider + start date when no reference is given", () => {
    const a = { kind: "restaurant", provider: "Balthazar", startISO: "2026-08-26" };
    expect(isSameReservation(a, { ...a, provider: "balthazar!" })).toBe(true);
    expect(isSameReservation(a, { ...a, startISO: "2026-08-27" })).toBe(false);
    expect(isSameReservation(a, { ...a, kind: "stay" })).toBe(false);
  });

  it("never conflates two different references", () => {
    const a = { kind: "stay", provider: "X", ref: "AAA", startISO: "2026-08-25" };
    expect(isSameReservation(a, { ...a, ref: "BBB" })).toBe(false);
  });
});

// ── THE order-independence pair ──────────────────────────────────────────────────────────

describe("booking then cancellation", () => {
  it("removes the filed block, and says so", async () => {
    const { store, trip } = seedTrip();
    const p = makePipeline(store, { "m-booking": STAY, "m-cancel": CANCEL });

    expect(await p.processMail(mail("m-booking", "Reservation confirmed"))).toBe("filed");
    expect(bookingsFile(store, trip)).toContain("QUEEN GREAT VIEW");

    expect(await p.processMail(mail("m-cancel", "Reservation cancelled"))).toBe("cancelled");

    expect(bookingsFile(store, trip)).not.toContain("QUEEN GREAT VIEW");
    expect(sent.some((t) => t.startsWith("🗑 Avbestilt:"))).toBe(true);
  });

  it("logs the removal in the reise-log, so Marcel can explain it", async () => {
    const { store } = seedTrip();
    const p = makePipeline(store, { "m-booking": STAY, "m-cancel": CANCEL });
    await p.processMail(mail("m-booking", "Reservation confirmed"));
    await p.processMail(mail("m-cancel", "Reservation cancelled"));

    expect(store.reiseLog()).toContain("avbestilt");
  });

  it("does not let a later sweep replay the cached original back into the file", async () => {
    const { store, trip } = seedTrip();
    const p = makePipeline(store, { "m-booking": STAY, "m-cancel": CANCEL });
    await p.processMail(mail("m-booking", "Reservation confirmed"));
    await p.processMail(mail("m-cancel", "Reservation cancelled"));

    // second sweep over the same two mails, both now cached
    await p.processMail(mail("m-booking", "Reservation confirmed"));
    await p.processMail(mail("m-cancel", "Reservation cancelled"));

    expect(bookingsFile(store, trip)).not.toContain("QUEEN GREAT VIEW");
  });
});

describe("cancellation then booking", () => {
  it("never files the booking at all", async () => {
    const { store, trip } = seedTrip();
    const p = makePipeline(store, { "m-booking": STAY, "m-cancel": CANCEL });

    expect(await p.processMail(mail("m-cancel", "Reservation cancelled"))).toBe("cancelled");
    expect(await p.processMail(mail("m-booking", "Reservation confirmed"))).toBe("cancelled");

    expect(bookingsFile(store, trip)).not.toContain("QUEEN GREAT VIEW");
  });

  it("converges on the same answer as the other ordering", async () => {
    const forward = seedTrip();
    const p1 = makePipeline(forward.store, { "m-booking": STAY, "m-cancel": CANCEL });
    await p1.processMail(mail("m-booking", "b"));
    await p1.processMail(mail("m-cancel", "c"));

    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const backward = seedTrip();
    const p2 = makePipeline(backward.store, { "m-booking": STAY, "m-cancel": CANCEL });
    await p2.processMail(mail("m-cancel", "c"));
    await p2.processMail(mail("m-booking", "b"));

    expect(bookingsFile(backward.store, backward.trip)).not.toContain("QUEEN GREAT VIEW");
  });

  it("does not resurrect it via retro-match when a trip is created afterwards", async () => {
    const store = new TripStore(root);
    store.saveConfig({ adminId: ADMIN, killSwitch: false, dailyTokenBudget: 1_000_000, trips: [] });
    const p = makePipeline(store, { "m-booking": STAY, "m-cancel": CANCEL });

    // no trip yet: the booking is an orphan, the cancellation is recorded
    await p.processMail(mail("m-cancel", "c"));
    await p.processMail(mail("m-booking", "b"));

    const trip = store.createTrip({
      slug: "the-big-apple", name: "The Big Apple", start: "2026-08-25", end: "2026-08-31",
      timezone: "America/New_York", destination: { name: "New York, USA", lat: 40.7128, lon: -74.006 },
    });
    await p.retroMatch();

    expect(store.read(trip, "bookings.md")).not.toContain("QUEEN GREAT VIEW");
  });
});

// ── matching paths ───────────────────────────────────────────────────────────────────────

describe("how a cancellation finds what it cancels", () => {
  it("by reference, even when the dates in the cancellation mail differ", async () => {
    const { store, trip } = seedTrip();
    const p = makePipeline(store, {
      "m-booking": STAY,
      "m-cancel": { ...CANCEL, startISO: "2026-08-26", endISO: "2026-08-29" },
    });
    await p.processMail(mail("m-booking", "b"));
    await p.processMail(mail("m-cancel", "c"));

    expect(bookingsFile(store, trip)).not.toContain("QUEEN GREAT VIEW");
  });

  it("by date window when there is no reference and no cache to consult", async () => {
    const { store, trip } = seedTrip();
    const noRef: Booking = { ...STAY, ref: undefined };
    const p = makePipeline(store, { "m-booking": noRef, "m-cancel": { ...noRef, id: "m-cancel", action: "cancel" } }, false);

    await p.processMail(mail("m-booking", "b"));
    expect(bookingsFile(store, trip)).toContain("QUEEN GREAT VIEW");

    await p.processMail(mail("m-cancel", "c"));
    expect(bookingsFile(store, trip)).not.toContain("QUEEN GREAT VIEW");
  });

  it("leaves an unrelated booking alone", async () => {
    const { store, trip } = seedTrip();
    const dinner: Booking = {
      id: "m-dinner", kind: "restaurant", action: "book", provider: "Balthazar", ref: "BAL-1",
      startISO: "2026-08-26", details: "Middag Balthazar 26. aug 20:00",
    };
    const p = makePipeline(store, { "m-booking": STAY, "m-dinner": dinner, "m-cancel": CANCEL });

    await p.processMail(mail("m-booking", "b"));
    await p.processMail(mail("m-dinner", "d"));
    await p.processMail(mail("m-cancel", "c"));

    const content = bookingsFile(store, trip);
    expect(content).not.toContain("QUEEN GREAT VIEW");
    expect(content).toContain("Balthazar");
  });

  it("a cancellation matching nothing is still understood, not an error", async () => {
    const { store, trip } = seedTrip();
    const p = makePipeline(store, { "m-cancel": CANCEL });

    expect(await p.processMail(mail("m-cancel", "c"))).toBe("cancelled");
    expect(bookingsFile(store, trip)).toBe("");
  });
});

// ── modification ─────────────────────────────────────────────────────────────────────────

describe("a changed reservation", () => {
  const dinner: Booking = {
    id: "m-dinner", kind: "restaurant", action: "book", provider: "Balthazar", ref: "BAL-1",
    startISO: "2026-08-26", startTime: "20:00", details: "Middag Balthazar 26. aug 20:00",
  };
  const moved: Booking = {
    ...dinner, id: "m-dinner-2", startISO: "2026-08-27", startTime: "19:30",
    details: "Middag Balthazar 27. aug 19:30",
  };

  it("REPLACES the old block rather than leaving both", async () => {
    const { store, trip } = seedTrip();
    const p = makePipeline(store, { "m-dinner": dinner, "m-dinner-2": moved });

    await p.processMail(mail("m-dinner", "Reservation confirmed"));
    expect(await p.processMail(mail("m-dinner-2", "Reservation changed"))).toBe("filed");

    const content = bookingsFile(store, trip);
    expect(content).toContain("27. aug 19:30");
    expect(content).not.toContain("26. aug 20:00");
  });

  it("tells Bendik what changed into what", async () => {
    const { store } = seedTrip();
    const p = makePipeline(store, { "m-dinner": dinner, "m-dinner-2": moved });
    await p.processMail(mail("m-dinner", "b"));
    await p.processMail(mail("m-dinner-2", "c"));

    expect(sent.some((t) => t.startsWith("✏️ Endret:") && t.includes("27. aug 19:30"))).toBe(true);
  });

  it("records the replacement in the reise-log", async () => {
    const { store } = seedTrip();
    const p = makePipeline(store, { "m-dinner": dinner, "m-dinner-2": moved });
    await p.processMail(mail("m-dinner", "b"));
    await p.processMail(mail("m-dinner-2", "c"));

    expect(store.reiseLog()).toContain("erstattet av");
  });

  it("is still a duplicate when nothing actually changed", async () => {
    const { store, trip } = seedTrip();
    const p = makePipeline(store, { "m-dinner": dinner, "m-dinner-again": { ...dinner, id: "m-dinner-again" } });

    await p.processMail(mail("m-dinner", "b"));
    expect(await p.processMail(mail("m-dinner-again", "receipt"))).toBe("duplicate");
    // Counted as BLOCKS, not as name occurrences: since ORB-129 one block mentions the venue
    // three times over (summary line, identity line, and the encoded name in its maps URL).
    expect(bookingsFile(store, trip).match(/<!-- booking /g)).toHaveLength(1);
    expect(bookingsFile(store, trip)).toContain("Balthazar");
  });
});

// ── the regression fixture the ticket names ──────────────────────────────────────────────

describe("The Big Apple's four dinners stay clean", () => {
  const dinners: Booking[] = [26, 27, 28, 29].map((day, i) => ({
    id: `d${i}`,
    kind: "restaurant",
    action: "book",
    provider: `Sted ${i}`,
    ref: `R-${i}`,
    startISO: `2026-08-${day}`,
    details: `Middag ${day}. aug hos Sted ${i}`,
  }));

  it("files all four, and a re-sweep neither duplicates nor removes any", async () => {
    const { store, trip } = seedTrip();
    const extractions = Object.fromEntries(dinners.map((d) => [d.id, d]));
    const p = makePipeline(store, extractions);
    const mails = dinners.map((d) => mail(d.id, d.details));

    const first = await p.backfill(mails);
    expect(first).toMatchObject({ filed: 4, cancelled: 0 });

    const second = await p.backfill(mails);
    expect(second).toMatchObject({ filed: 0, cancelled: 0, duplicates: 4 });

    const content = bookingsFile(store, trip);
    for (const day of [26, 27, 28, 29]) expect(content).toContain(`${day}. aug`);
  });

  it("counts a cancellation in the sweep report", async () => {
    const { store } = seedTrip();
    const cancelFirst: Booking = { ...dinners[0]!, id: "d0-cancel", action: "cancel" };
    const p = makePipeline(store, {
      ...Object.fromEntries(dinners.map((d) => [d.id, d])),
      "d0-cancel": cancelFirst,
    });

    const result = await p.backfill([...dinners.map((d) => mail(d.id, d.details)), mail("d0-cancel", "cancelled")]);

    expect(result).toMatchObject({ filed: 4, cancelled: 1 });
  });
});

// ── The live Big Apple near-miss (2026-08-17) ────────────────────────────────────────────
//
// Found while verifying this ticket against the real store rather than the fixtures. Bendik
// cancelled The Standard, High Line and booked PUBLIC Hotel for the SAME four nights. Both are
// `kind:stay start:2026-08-26 end:2026-08-30`, and the block header recorded nothing else — so
// to every header-only matcher here they were one reservation. Two consequences, both live:
//
//   1. the Standard's booking mail was swallowed as a "semantic duplicate" of PUBLIC's block —
//      had it NOT been cancelled, the trip file would have been missing his actual hotel;
//   2. the Standard's cancellation, once the extractor finally understood it, would have found
//      exactly one window match — PUBLIC's block — and deleted a live booking two weeks out.
//
// `provider:` in the header is what tells them apart. An older block that has no provider
// recorded cannot prove identity, so the removal path refuses rather than guesses.

const PUBLIC_STAY: Booking = {
  id: "m-public",
  kind: "stay",
  action: "book",
  provider: "PUBLIC Hotel New York",
  ref: "6312B0972798",
  startISO: "2026-08-26",
  endISO: "2026-08-30",
  details: "Queen Great View room, PUBLIC Hotel, 26.–30. aug",
};

const STANDARD_STAY: Booking = {
  id: "m-standard",
  kind: "stay",
  action: "book",
  provider: "The Standard, High Line",
  ref: "17181403",
  startISO: "2026-08-26",
  endISO: "2026-08-30",
  details: "Standard King, The Standard High Line, 26.–30. aug",
};

describe("two different hotels on the same nights", () => {
  it("both get filed — the second is a different reservation, not a duplicate of the first", async () => {
    const { store, trip } = seedTrip();
    const pipeline = makePipeline(store, { "m-public": PUBLIC_STAY, "m-standard": STANDARD_STAY });

    expect(await pipeline.processMail(mail("m-public", "PUBLIC Confirmation"))).toBe("filed");
    expect(await pipeline.processMail(mail("m-standard", "Your reservation at The Standard"))).toBe("filed");

    const content = bookingsFile(store, trip);
    expect(content).toContain("PUBLIC Hotel");
    expect(content).toContain("The Standard High Line");
  });

  it("still dedupes the SAME hotel arriving twice, even when the mails name it slightly differently", async () => {
    const { store, trip } = seedTrip();
    const secondMail: Booking = { ...PUBLIC_STAY, id: "m-public-2", provider: "PUBLIC Hotel", ref: undefined };
    const pipeline = makePipeline(store, { "m-public": PUBLIC_STAY, "m-public-2": secondMail });

    expect(await pipeline.processMail(mail("m-public", "PUBLIC Confirmation"))).toBe("filed");
    expect(await pipeline.processMail(mail("m-public-2", "Your PUBLIC check-in guide"))).toBe("duplicate");

    expect(bookingsFile(store, trip).match(/<!-- booking id:/g)).toHaveLength(1);
  });

  it("a cancellation for one hotel never removes the other one's block", async () => {
    const { store, trip } = seedTrip();
    const cancelStandard: Booking = {
      ...STANDARD_STAY,
      id: "m-standard-cancel",
      action: "cancel",
      details: "Avbestilt: The Standard High Line",
    };
    const pipeline = makePipeline(store, {
      "m-public": PUBLIC_STAY,
      "m-standard-cancel": cancelStandard,
    });

    await pipeline.processMail(mail("m-public", "PUBLIC Confirmation"));
    expect(await pipeline.processMail(mail("m-standard-cancel", "Your Stay Has Been Cancelled"))).toBe("cancelled");

    // The live booking survives untouched — this is the assertion the whole change exists for.
    expect(bookingsFile(store, trip)).toContain("PUBLIC Hotel");
  });

  it("and that cancellation still suppresses its OWN booking mail, whichever order they arrive in", async () => {
    const { store, trip } = seedTrip();
    const cancelStandard: Booking = {
      ...STANDARD_STAY, id: "m-standard-cancel", action: "cancel", details: "Avbestilt: The Standard High Line",
    };
    const pipeline = makePipeline(store, {
      "m-standard-cancel": cancelStandard,
      "m-standard": STANDARD_STAY,
    });

    await pipeline.processMail(mail("m-standard-cancel", "Your Stay Has Been Cancelled"));
    expect(await pipeline.processMail(mail("m-standard", "Your reservation at The Standard"))).toBe("cancelled");

    expect(bookingsFile(store, trip)).not.toContain("The Standard");
  });
});

// ── The cache must not outlive the extractor that filled it ──────────────────────────────
//
// The reason this ticket's fix did nothing on the live store: the cancellation mail had been
// cached as `not-booking` by the PRE-fix prompt at 11:45Z, and a cached non-booking is a
// terminal skip. The fix shipped and could never reach the one mail it was written for.

describe("stale cached verdicts", () => {
  it("re-extracts a not-booking cached by an older extractor, and files what the new one sees", async () => {
    const { store, trip } = seedTrip();
    const cache = fileExtractionCache(root);
    cache.put("m-standard-cancel", {
      outcome: "not-booking",
      booking: null,
      subject: "Your Stay at The Standard, High Line Has Been Cancelled",
      extractedAt: "2026-08-17T11:45:35.000Z",
      // no extractorVersion — exactly what the live cache holds
    });

    let extractCalls = 0;
    const pipeline = new BookingPipeline({
      extract: async () => {
        extractCalls++;
        return { ...STANDARD_STAY, id: "m-standard-cancel", action: "cancel", details: "Avbestilt: The Standard" };
      },
      store,
      tg: { send: async (_c, t) => { sent.push(t); return "1"; } },
      adminId: ADMIN,
      now: () => NOW,
      cache,
    });

    expect(await pipeline.processMail(mail("m-standard-cancel", "Cancelled"))).toBe("cancelled");
    expect(extractCalls).toBe(1);
    expect(bookingsFile(store, trip)).not.toContain("The Standard");
  });

  it("does NOT re-extract a stale entry that already carries a booking — that would re-bill a whole sweep for data we have", async () => {
    const { store } = seedTrip();
    const cache = fileExtractionCache(root);
    cache.put("m-old", {
      outcome: "no-trip",
      booking: { ...STANDARD_STAY, id: "m-old", startISO: "2020-01-01", endISO: "2020-01-02" },
      subject: "An old booking",
      extractedAt: "2026-08-17T11:45:35.000Z",
    });

    let extractCalls = 0;
    const pipeline = new BookingPipeline({
      extract: async () => { extractCalls++; return null; },
      store,
      tg: { send: async () => "1" },
      adminId: ADMIN,
      now: () => NOW,
      cache,
    });

    expect(await pipeline.processMail(mail("m-old", "An old booking"))).toBe("no-trip");
    expect(extractCalls).toBe(0);
  });
});

// ── Coverage must be stated, never assumed (ORB-105 follow-up) ────────────────────────────
//
// The sweep read one page of 100 and called itself finished. That is the ORB-45 defect
// verbatim — "the cap truncated silently and reported complete" — and it is the most likely
// reason a cancellation sitting in the label went unread by two consecutive sweeps.
describe("the sweep report tells the truth about what it read", () => {
  it("says so when the read cap truncated the label", async () => {
    const { composeCompletionReport } = await import("../lib/sveip-run.js");

    const msg = composeCompletionReport({
      filed: 2, cancelled: 0, duplicates: 0, noTrip: 0, notBooking: 0, unclearSubjects: [],
      listed: 412, read: 400,
    });

    expect(msg).toContain("400");
    expect(msg).toContain("412");
    expect(msg).toContain("⚠️");
  });

  it("says plainly that it read everything when it did", async () => {
    const { composeCompletionReport } = await import("../lib/sveip-run.js");

    const msg = composeCompletionReport({
      filed: 1, cancelled: 0, duplicates: 0, noTrip: 0, notBooking: 0, unclearSubjects: [],
      listed: 106, read: 106,
    });

    expect(msg).toContain("leste alle 106");
    expect(msg).not.toContain("⚠️");
  });

  it("leads with the budget stop, because the rest of the inbox was never read", async () => {
    const { composeCompletionReport } = await import("../lib/sveip-run.js");

    const msg = composeCompletionReport({
      filed: 3, cancelled: 0, duplicates: 0, noTrip: 0, notBooking: 0, unclearSubjects: [],
      listed: 300, read: 120, budgetStopped: true,
    });

    expect(msg).toContain("token-budsjett");
    expect(msg).toContain("120");
    expect(msg).toContain("300");
  });

  it("stops reading the moment the budget is gone, and reports how far it got", async () => {
    const { store } = seedTrip();
    let extracted = 0;
    let spent = 0;
    const pipeline = new BookingPipeline({
      extract: async () => { extracted++; spent++; return null; },
      store,
      tg: { send: async () => "1" },
      adminId: ADMIN,
      now: () => NOW,
    });

    const mails = Array.from({ length: 10 }, (_, i) => mail(`m-${i}`, `Mail ${i}`));
    const result = await pipeline.backfill(mails, { listed: 10, budgetExceeded: () => spent >= 3 });

    expect(result.budgetStopped).toBe(true);
    expect(extracted).toBe(3);
    expect(result.read).toBe(3);
  });
});
