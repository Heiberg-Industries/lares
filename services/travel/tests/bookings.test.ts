// Ported from services/marcel/tests/bookings.test.ts (Task 5), plus new MIME-level coverage
// for the dual-body-read/attachment-extraction pipeline that lived in old Marcel's gmail.ts
// (lines 41-113) — that pipeline has no separate eve-marcel lib file (Task 5's brief lists
// only trip-store.ts and bookings.ts), so it lives in lib/bookings.ts here and is tested here.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MockLanguageModelV4 } from "ai/test";
import { TripStore, type Trip } from "../lib/trip-store.js";
import { Budget } from "../lib/budget.js";
import {
  BookingPipeline,
  bookingBlock,
  extractBody,
  makeExtractBooking,
  readableAttachments,
  renderMailText,
  toReiseMailHeaderFields,
  walkParts,
  extractionDateContext,
  type Booking,
  type RawGmailMessage,
} from "../lib/bookings.js";
import type { ReiseMail } from "../lib/bookings.js";

let root: string;
let store: TripStore;
let trip: Trip;

function mail(overrides: Partial<ReiseMail> = {}): ReiseMail {
  return {
    id: "gmail-abc123",
    subject: "Din reise til Nice er bekreftet",
    from: "noreply@sas.no",
    bodyText: "SK4711 OSL->NCE 21 jul 06:35",
    receivedAt: "2026-07-15T10:00:00.000Z",
    ...overrides,
  };
}

function flightBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: "gmail-abc123",
    kind: "flight",
    provider: "SAS",
    ref: "X4B2K",
    startISO: "2026-07-21",
    startTime: "06:35",
    details: "✈️ SK4711 OSL→NCE 2026-07-21 06:35 (ref X4B2K)",
    ...overrides,
  };
}

function fakeTg() {
  const sent: { chatId: string; text: string; opts?: { buttons?: { text: string; data: string }[] } }[] = [];
  return {
    sent,
    async send(chatId: string, text: string, opts?: { buttons?: { text: string; data: string }[] }) {
      sent.push({ chatId, text, opts });
      return String(sent.length);
    },
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-bookings-"));
  store = new TripStore(root);
  store.saveConfig({ adminId: "999", killSwitch: false, dailyTokenBudget: 1000, trips: [] });
  trip = store.createTrip({
    slug: "nice-2026",
    name: "Nice",
    start: "2026-07-21",
    end: "2026-07-28",
    timezone: "Europe/Paris",
    destination: { name: "Nice", lat: 43.7102, lon: 7.262 },
  });
});

describe("BookingPipeline.processMail — filed", () => {
  it("appends the exact bookings.md block and DMs the admin with a veto button", async () => {
    const tg = fakeTg();
    const booking = flightBooking();
    const pipeline = new BookingPipeline({
      extract: async () => booking,
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    const result = await pipeline.processMail(mail());

    expect(result).toBe("filed");

    const content = store.read(trip, "bookings.md");
    expect(content).toBe(
      "<!-- booking id:gmail-abc123 kind:flight start:2026-07-21 end:- time:06:35 provider:sas -->\n" +
        "- ✈️ SK4711 OSL→NCE 2026-07-21 06:35 (ref X4B2K)\n" +
        "<!-- /booking -->\n"
    );

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].chatId).toBe("999");
    expect(tg.sent[0].text).toBe("📩 Fant i Reise: ✈️ SK4711 OSL→NCE 2026-07-21 06:35 (ref X4B2K)");
    expect(tg.sent[0].opts?.buttons).toEqual([{ text: "Ikke denne turen", data: "veto:gmail-abc123" }]);
  });

  it("uses endISO when provided, and startTime '-' when absent", async () => {
    const tg = fakeTg();
    const booking = flightBooking({
      kind: "stay",
      startISO: "2026-07-21",
      endISO: "2026-07-25",
      startTime: undefined,
      details: "🏠 Leilighet i gamlebyen 2026-07-21 → 2026-07-25",
    });
    const pipeline = new BookingPipeline({
      extract: async () => booking,
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    await pipeline.processMail(mail());

    const content = store.read(trip, "bookings.md");
    expect(content).toBe(
      "<!-- booking id:gmail-abc123 kind:stay start:2026-07-21 end:2026-07-25 time:- provider:sas -->\n" +
        "- 🏠 Leilighet i gamlebyen 2026-07-21 → 2026-07-25\n" +
        "<!-- /booking -->\n"
    );
  });
});

describe("BookingPipeline.processMail — duplicate", () => {
  it("returns 'duplicate' and does not write again or DM again for the same gmail id", async () => {
    const tg = fakeTg();
    const booking = flightBooking();
    const pipeline = new BookingPipeline({
      extract: async () => booking,
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    const first = await pipeline.processMail(mail());
    const before = store.read(trip, "bookings.md");
    const second = await pipeline.processMail(mail());
    const after = store.read(trip, "bookings.md");

    expect(first).toBe("filed");
    expect(second).toBe("duplicate");
    expect(after).toBe(before);
    expect(tg.sent).toHaveLength(1);
  });
});

describe("BookingPipeline.processMail — no-trip", () => {
  it("returns 'no-trip' silently when the booking window doesn't intersect any trip", async () => {
    const tg = fakeTg();
    const booking = flightBooking({ startISO: "2026-01-05", endISO: "2026-01-10" });
    const pipeline = new BookingPipeline({
      extract: async () => booking,
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    const result = await pipeline.processMail(mail());

    expect(result).toBe("no-trip");
    expect(store.read(trip, "bookings.md")).toBe("");
    expect(tg.sent).toHaveLength(0);
  });
});

describe("BookingPipeline.processMail — not-booking vs unclear", () => {
  it("returns 'not-booking' SILENTLY when extract returns null (model says not a booking)", async () => {
    const tg = fakeTg();
    const pipeline = new BookingPipeline({
      extract: async () => null,
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    const result = await pipeline.processMail(mail({ subject: "Nyhetsbrev uke 29" }));

    expect(result).toBe("not-booking");
    expect(tg.sent).toHaveLength(0);
  });

  it("returns 'unclear' and DMs the admin mentioning the subject when extract throws", async () => {
    const tg = fakeTg();
    const pipeline = new BookingPipeline({
      extract: async () => {
        throw new Error("model timeout");
      },
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    const result = await pipeline.processMail(mail({ subject: "Din togbillett" }));

    expect(result).toBe("unclear");
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toContain("Din togbillett");
  });

  it("suppresses the unclear DM under quietUnclear (backfill mode)", async () => {
    const tg = fakeTg();
    const pipeline = new BookingPipeline({
      extract: async () => {
        throw new Error("model timeout");
      },
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    const result = await pipeline.processMail(mail({ subject: "Din togbillett" }), { quietUnclear: true });

    expect(result).toBe("unclear");
    expect(tg.sent).toHaveLength(0);
  });
});

describe("BookingPipeline.file (screenshot path)", () => {
  it("files with the caller's id, custom source label in the veto DM, and dedupes on refile", async () => {
    const tg = fakeTg();
    const pipeline = new BookingPipeline({ extract: async () => null, store, tg, adminId: "999", now: () => 1752570000 });
    const booking = flightBooking({ id: "img-1-40" });

    expect(await pipeline.file(booking, "skjermbilde")).toBe("filed");
    expect(tg.sent[0].text).toContain("Fant i skjermbilde");
    expect(tg.sent[0].opts?.buttons?.[0].data).toBe("veto:img-1-40");
    expect(await pipeline.file(booking, "skjermbilde")).toBe("duplicate");
  });

  it("returns no-trip when dates miss every window", async () => {
    const tg = fakeTg();
    const pipeline = new BookingPipeline({ extract: async () => null, store, tg, adminId: "999", now: () => 1752570000 });
    const result = await pipeline.file(flightBooking({ id: "img-2", startISO: "2030-01-01", endISO: "2030-01-02" }), "skjermbilde");
    expect(result).toBe("no-trip");
    expect(tg.sent).toHaveLength(0);
  });
});

describe("BookingPipeline — semantic duplicates", () => {
  it("collapses per-passenger e-tickets: same flight, same date+time, different mail ids", async () => {
    const tg = fakeTg();
    const pipeline = new BookingPipeline({ extract: async () => null, store, tg, adminId: "999", now: () => 1752570000 });

    expect(await pipeline.file(flightBooking({ id: "t-1" }), "Reise")).toBe("filed");
    expect(await pipeline.file(flightBooking({ id: "t-2" }), "Reise")).toBe("duplicate");
    expect(tg.sent).toHaveLength(1); // one veto DM, not two
  });

  it("collapses the same stay even when check-in times differ (confirmation vs receipt)", async () => {
    const tg = fakeTg();
    const pipeline = new BookingPipeline({ extract: async () => null, store, tg, adminId: "999", now: () => 1752570000 });
    const stayA = { ...flightBooking({ id: "s-1" }), kind: "stay", startISO: "2026-07-22", endISO: "2026-07-29", startTime: undefined };
    const stayB = { ...stayA, id: "s-2", startTime: "17:00" };

    expect(await pipeline.file(stayA, "Reise")).toBe("filed");
    expect(await pipeline.file(stayB, "Reise")).toBe("duplicate");
  });

  it("keeps different bookings with the same dates but different times (rental vs parking)", async () => {
    const tg = fakeTg();
    const pipeline = new BookingPipeline({ extract: async () => null, store, tg, adminId: "999", now: () => 1752570000 });
    const rental = { ...flightBooking({ id: "c-1" }), kind: "car", startISO: "2026-07-22", endISO: "2026-07-29", startTime: "18:00" };
    const parking = { ...rental, id: "c-2", startTime: "12:00" };

    expect(await pipeline.file(rental, "Reise")).toBe("filed");
    expect(await pipeline.file(parking, "Reise")).toBe("filed");
  });
});

describe("BookingPipeline.veto", () => {
  it("removes exactly the block for the given id when multiple blocks are present", async () => {
    const tg = fakeTg();
    let call = 0;
    const bookings = [
      flightBooking({ id: "gmail-abc123", details: "✈️ SK4711 OSL→NCE 2026-07-21 06:35 (ref X4B2K)" }),
      flightBooking({ id: "gmail-def456", details: "✈️ SK9002 NCE→OSL 2026-07-28 20:10 (ref Y7C3L)", startISO: "2026-07-28" }),
    ];
    const mails = [mail({ id: "gmail-abc123" }), mail({ id: "gmail-def456" })];
    const pipeline = new BookingPipeline({
      extract: async () => bookings[call++],
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    await pipeline.processMail(mails[0]);
    await pipeline.processMail(mails[1]);

    const before = store.read(trip, "bookings.md");
    expect(before).toContain("id:gmail-abc123");
    expect(before).toContain("id:gmail-def456");

    await pipeline.veto("gmail-abc123");

    const after = store.read(trip, "bookings.md");
    expect(after).not.toContain("id:gmail-abc123");
    expect(after).not.toContain("SK4711");
    expect(after).toContain("id:gmail-def456");
    expect(after).toContain("SK9002");
    expect(after).toBe(
      "<!-- booking id:gmail-def456 kind:flight start:2026-07-28 end:- time:06:35 provider:sas -->\n" +
        "- ✈️ SK9002 NCE→OSL 2026-07-28 20:10 (ref Y7C3L)\n" +
        "<!-- /booking -->\n"
    );
  });
});

describe("BookingPipeline.processMail — stay merge", () => {
  it("merges stay facts into trip.md under '## Hus (fra e-post)' with Norwegian labels", async () => {
    const tg = fakeTg();
    const booking = flightBooking({
      kind: "stay",
      details: "🏠 Leilighet i gamlebyen",
      stay: {
        wifi: "GamlebyenWifi / passord123",
        doorCode: "4471",
        checkIn: "15:00",
        checkOut: "11:00",
        rules: ["Ingen sko innendørs", "Søppel i blå kasse"],
        leavingTasks: ["Vask opp", "Lås døren"],
      },
    });
    const pipeline = new BookingPipeline({
      extract: async () => booking,
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    await pipeline.processMail(mail());

    const tripMd = store.read(trip, "trip.md");
    expect(tripMd).toContain("## Hus (fra e-post)");
    expect(tripMd).toContain("- Wifi: GamlebyenWifi / passord123");
    expect(tripMd).toContain("- Dørkode: 4471");
    expect(tripMd).toContain("- Innsjekk: 15:00");
    expect(tripMd).toContain("- Utsjekk: 11:00");
    expect(tripMd).toContain("- Husregler: Ingen sko innendørs; Søppel i blå kasse");
    expect(tripMd).toContain("- Før avreise: Vask opp; Lås døren");
  });

  it("accumulates stay fields across different bookings (A's wifi survives B's door code)", async () => {
    const tg = fakeTg();
    const byId: Record<string, Booking> = {
      "gmail-A": flightBooking({ id: "gmail-A", kind: "stay", details: "🏠 Innsjekk-guide", stay: { wifi: "Maison2026" } }),
      "gmail-B": flightBooking({ id: "gmail-B", kind: "stay", details: "🏠 Melding fra vert", stay: { doorCode: "4711", leavingTasks: ["søppel ut"] } }),
    };
    const pipeline = new BookingPipeline({
      extract: async (m) => byId[m.id],
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    await pipeline.processMail(mail({ id: "gmail-A" }));
    await pipeline.processMail(mail({ id: "gmail-B" }));

    const tripMd = store.read(trip, "trip.md");
    expect(tripMd).toContain("- Wifi: Maison2026");
    expect(tripMd).toContain("- Dørkode: 4711");
    expect(tripMd).toContain("- Før avreise: søppel ut");
    expect(tripMd.split("## Hus (fra e-post)").length - 1).toBe(1);
  });

  it("does not duplicate list entries when the same stay facts arrive again from a new booking", async () => {
    const tg = fakeTg();
    const byId: Record<string, Booking> = {
      "gmail-B": flightBooking({ id: "gmail-B", kind: "stay", details: "🏠 Melding fra vert", stay: { doorCode: "4711", leavingTasks: ["søppel ut"] } }),
      "gmail-C": flightBooking({ id: "gmail-C", kind: "stay", details: "🏠 Påminnelse fra vert", stay: { doorCode: "4711", leavingTasks: ["søppel ut"] } }),
    };
    const pipeline = new BookingPipeline({
      extract: async (m) => byId[m.id],
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    await pipeline.processMail(mail({ id: "gmail-B" }));
    await pipeline.processMail(mail({ id: "gmail-C" }));

    const tripMd = store.read(trip, "trip.md");
    expect(tripMd).toContain("- Før avreise: søppel ut");
    expect(tripMd.match(/søppel ut/g)).toHaveLength(1);
    expect(tripMd.match(/- Dørkode: 4711/g)).toHaveLength(1);
  });

  it("is idempotent when the same mail is reprocessed (no duplicated section)", async () => {
    const tg = fakeTg();
    const booking = flightBooking({
      kind: "stay",
      details: "🏠 Leilighet i gamlebyen",
      stay: { wifi: "GamlebyenWifi", doorCode: "4471" },
    });
    const pipeline = new BookingPipeline({
      extract: async () => booking,
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    await pipeline.processMail(mail());
    await pipeline.processMail(mail()); // duplicate — should be a no-op

    const tripMd = store.read(trip, "trip.md");
    const occurrences = tripMd.split("## Hus (fra e-post)").length - 1;
    expect(occurrences).toBe(1);
    expect(tripMd.match(/- Wifi: GamlebyenWifi/g)).toHaveLength(1);
  });
});

describe("BookingPipeline.veto — tombstones vetoed ids", () => {
  it("persists the vetoed id to vetoed.json under the trip's dir", async () => {
    const tg = fakeTg();
    const booking = flightBooking();
    const pipeline = new BookingPipeline({ extract: async () => booking, store, tg, adminId: "999", now: () => 1752570000 });
    await pipeline.processMail(mail());

    await pipeline.veto("gmail-abc123");

    const vetoed = JSON.parse(fs.readFileSync(path.join(trip.dir, "vetoed.json"), "utf8"));
    expect(vetoed["gmail-abc123"]).toBe(true);
  });

  it("processMail on a previously-vetoed id returns 'duplicate' and writes nothing (re-polls/backfills can't refile it) — veto check runs BEFORE extract", async () => {
    const tg = fakeTg();
    const booking = flightBooking();
    let calls = 0;
    const pipeline = new BookingPipeline({
      extract: async () => {
        calls++;
        return booking;
      },
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    await pipeline.processMail(mail());
    await pipeline.veto("gmail-abc123");
    expect(store.read(trip, "bookings.md")).toBe("");

    const callsBeforeRepoll = calls;
    const result = await pipeline.processMail(mail());

    expect(result).toBe("duplicate");
    expect(store.read(trip, "bookings.md")).toBe("");
    // extract() must not even be called for a vetoed id — the check happens before extract.
    expect(calls).toBe(callsBeforeRepoll);
  });

  it("DMs the admin with a hus-info warning when the vetoed booking's trip has merged stay facts", async () => {
    const tg = fakeTg();
    const booking = flightBooking({
      kind: "stay",
      details: "🏠 Leilighet i gamlebyen",
      stay: { wifi: "GamlebyenWifi" },
    });
    const pipeline = new BookingPipeline({ extract: async () => booking, store, tg, adminId: "999", now: () => 1752570000 });
    await pipeline.processMail(mail());
    expect(store.read(trip, "trip.md")).toContain("## Hus (fra e-post)");

    await pipeline.veto("gmail-abc123");

    const warnings = tg.sent.filter((s) => s.text.includes("hus-info"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].chatId).toBe("999");
    expect(warnings[0].text).toContain("Leilighet i gamlebyen");
    expect(warnings[0].text).toContain("## Hus (fra e-post)");
  });

  it("does not DM a hus-info warning when the trip has no merged stay facts", async () => {
    const tg = fakeTg();
    const booking = flightBooking();
    const pipeline = new BookingPipeline({ extract: async () => booking, store, tg, adminId: "999", now: () => 1752570000 });
    await pipeline.processMail(mail());

    await pipeline.veto("gmail-abc123");

    expect(tg.sent.some((s) => s.text.includes("hus-info"))).toBe(false);
  });
});

describe("bookingBlock — header field sanitization (belt-and-braces against a malformed BOOKING_RE-breaking value)", () => {
  it("replaces whitespace in kind with '-'", () => {
    const block = bookingBlock("id1", "flight delayed", "2026-07-21", undefined, "06:35", "detail");
    expect(block).toContain("kind:flight-delayed");
  });

  it("falls back a malformed startISO to '-'", () => {
    const block = bookingBlock("id1", "flight", "21 juli 2026", undefined, "06:35", "detail");
    expect(block).toContain("start:-");
  });

  it("falls back a malformed endISO to '-'", () => {
    const block = bookingBlock("id1", "flight", "2026-07-21", "not a date", "06:35", "detail");
    expect(block).toContain("end:-");
  });

  it("falls back a malformed startTime to '-'", () => {
    const block = bookingBlock("id1", "flight", "2026-07-21", undefined, "6.35 pm", "detail");
    expect(block).toContain("time:-");
  });

  it("keeps well-formed values untouched", () => {
    const block = bookingBlock("id1", "flight", "2026-07-21", "2026-07-25", "06:35", "detail");
    expect(block).toContain("kind:flight start:2026-07-21 end:2026-07-25 time:06:35");
  });

  it("a block with every field malformed still parses cleanly via BOOKING_RE", () => {
    const block = bookingBlock("id1", "flight delayed", "21 juli 2026", "not a date", "6.35 pm", "detail");
    const BOOKING_RE = /<!-- booking id:(\S+) kind:(\S+) start:(\S+) end:(\S+) time:(\S+)(?: provider:(\S+))? -->/g;
    const matches = [...block.matchAll(BOOKING_RE)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("id1");
    expect(matches[0][2]).toBe("flight-delayed");
    expect(matches[0][3]).toBe("-");
    expect(matches[0][4]).toBe("-");
    expect(matches[0][5]).toBe("-");
  });
});

describe("BookingPipeline.processMail — sanitizes a malformed kind end-to-end", () => {
  it("a kind containing whitespace from the extractor still produces a parseable bookings.md block", async () => {
    const tg = fakeTg();
    const booking = flightBooking({ kind: "flight delayed", details: "✈️ noe" });
    const pipeline = new BookingPipeline({ extract: async () => booking, store, tg, adminId: "999", now: () => 1752570000 });

    await pipeline.processMail(mail());

    const content = store.read(trip, "bookings.md");
    expect(content).toContain("kind:flight-delayed");
  });
});

describe("BookingPipeline.processMail — reise-log", () => {
  it("logs every processed mail with its outcome, including silent skips", async () => {
    const tg = fakeTg();
    let call = 0;
    const outcomes: (Booking | null)[] = [
      flightBooking({ id: "g-1" }), // filed
      flightBooking({ id: "g-2", startISO: "2026-01-01", endISO: "2026-01-02" }), // no-trip
      null, // not-booking
    ];
    const pipeline = new BookingPipeline({
      extract: async () => outcomes[call++],
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    await pipeline.processMail(mail({ id: "g-1", subject: "Din reise er bekreftet", receivedAt: "2026-07-21T12:06:54.000Z" }));
    await pipeline.processMail(mail({ id: "g-2", subject: "Gammel booking" }));
    await pipeline.processMail(mail({ id: "g-3", subject: "Nyhetsbrev fra Avis" }));

    const log = store.reiseLog();
    expect(log).toContain("2026-07-21 12:06 «Din reise er bekreftet» (noreply@sas.no) → arkivert");
    expect(log).toContain("«Gammel booking» (noreply@sas.no) → traff ingen turdatoer");
    expect(log).toContain("«Nyhetsbrev fra Avis» (noreply@sas.no) → ikke en booking");
  });
});

describe("BookingPipeline.veto — reise-log", () => {
  it("logs the removal so Marcel can explain a vetoed booking later", async () => {
    const tg = fakeTg();
    const pipeline = new BookingPipeline({
      extract: async () => flightBooking(),
      store,
      tg,
      adminId: "999",
      now: () => 1784641920, // 2026-07-21T13:52:00Z
    });
    await pipeline.processMail(mail({ subject: "Din reise til Nice er bekreftet" }));

    await pipeline.veto("gmail-abc123");

    const log = store.reiseLog();
    expect(log).toContain("→ fjernet av Bendik («Ikke denne turen»)");
    expect(log).toContain("✈️ SK4711 OSL→NCE");
  });
});

describe("BookingPipeline.backfill", () => {
  it("returns full accounting: filed, duplicates, noTrip, notBooking", async () => {
    const tg = fakeTg();
    let call = 0;
    const outcomes: (Booking | null)[] = [
      flightBooking({ id: "g-1" }), // filed
      flightBooking({ id: "g-1" }), // duplicate (same id)
      flightBooking({ id: "g-2", startISO: "2026-01-01", endISO: "2026-01-02" }), // no-trip
      null, // not-booking
    ];
    const pipeline = new BookingPipeline({
      extract: async () => outcomes[call++],
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    const result = await pipeline.backfill([
      mail({ id: "g-1" }),
      mail({ id: "g-1" }),
      mail({ id: "g-2" }),
      mail({ id: "g-3" }),
    ]);

    expect(result.filed).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.noTrip).toBe(1);
    expect(result.notBooking).toBe(1);
  });

  it("processes mails sequentially and returns the count filed", async () => {
    const tg = fakeTg();
    let call = 0;
    const bookings = [
      flightBooking({ id: "gmail-1" }),
      flightBooking({ id: "gmail-1" }), // duplicate of the first
      flightBooking({ id: "gmail-2", startISO: "2026-01-01", endISO: "2026-01-02" }), // no-trip
      flightBooking({ id: "gmail-3", ref: "Z9Q1M", startTime: "09:15" }), // different time → distinct booking (not a semantic dup of gmail-1)
    ];
    const mails = [
      mail({ id: "gmail-1" }),
      mail({ id: "gmail-1" }),
      mail({ id: "gmail-2" }),
      mail({ id: "gmail-3" }),
    ];
    const pipeline = new BookingPipeline({
      extract: async () => bookings[call++],
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    const { filed } = await pipeline.backfill(mails);

    expect(filed).toBe(2);
  });

  it("aggregates unclear subjects instead of DMing per mail", async () => {
    const tg = fakeTg();
    let call = 0;
    const pipeline = new BookingPipeline({
      extract: async () => {
        call++;
        if (call === 1) throw new Error("boom");
        return null; // not a booking
      },
      store,
      tg,
      adminId: "999",
      now: () => 1752570000,
    });

    const { filed, unclearSubjects } = await pipeline.backfill([
      mail({ id: "g-1", subject: "Rar kvittering" }),
      mail({ id: "g-2", subject: "Nyhetsbrev" }),
    ]);

    expect(filed).toBe(0);
    expect(unclearSubjects).toEqual(["Rar kvittering"]); // not-booking stays silent, no per-mail DM
    expect(tg.sent).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------------------
// New for the eve-marcel port: MIME-level coverage for the dual-body-read/attachment pipeline
// that lived in old Marcel's gmail.ts (ported into lib/bookings.ts here — see the brief's
// reference-source #2). base64url-encodes inline fixture strings the way Gmail's API does.
// -----------------------------------------------------------------------------------------

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function textPart(mimeType: string, text: string): RawGmailMessage["payload"] {
  return { mimeType, body: { data: b64(text) } };
}

describe("walkParts", () => {
  it("walks a nested multipart/mixed → multipart/related → text/html tree depth-first", () => {
    const payload: RawGmailMessage["payload"] = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/related",
          parts: [textPart("text/plain", "plain"), textPart("text/html", "<p>html</p>")],
        },
      ],
    };
    const parts = walkParts(payload);
    expect(parts.map((p) => p.mimeType)).toEqual([
      "multipart/mixed",
      "multipart/related",
      "text/plain",
      "text/html",
    ]);
  });
});

describe("extractBody — the Avis stale-plaintext-vs-html case (round-1 bug, 2026-07-21)", () => {
  it("reads BOTH parts and prefers neither blindly — html content survives even when plaintext disagrees", () => {
    // A real shape seen live: the plaintext template lags (wrong car/dates), the html body is
    // the actual current confirmation. Plaintext-only extraction filed nothing and silently
    // dropped the real booking. Both bodies must be present in the rendered text so the LLM
    // extractor (which reads todaysBodyText, not this function directly) can resolve the
    // disagreement using the html.
    const payload: RawGmailMessage["payload"] = {
      mimeType: "multipart/alternative",
      parts: [
        textPart("text/plain", "Din leiebil: Toyota Yaris, 2026-05-01 til 2026-05-03 (FEIL — gammel mal)"),
        textPart("text/html", "<html><body><p>Din leiebil: Volkswagen Golf, 2026-07-22 til 2026-07-29</p></body></html>"),
      ],
    };
    const body = extractBody(payload);
    expect(body).toContain("Toyota Yaris");
    expect(body).toContain("Volkswagen Golf");
    expect(body).toContain("2026-07-22");
    // html tags stripped, whitespace collapsed
    expect(body).not.toMatch(/<[a-z]/i);
  });

  it("falls back to plain-only when no html part exists", () => {
    const payload: RawGmailMessage["payload"] = { mimeType: "multipart/mixed", parts: [textPart("text/plain", "only plain")] };
    expect(extractBody(payload)).toBe("only plain");
  });

  it("falls back to html-only (tag-stripped) when no plain part exists", () => {
    const payload: RawGmailMessage["payload"] = {
      mimeType: "multipart/mixed",
      parts: [textPart("text/html", "<div>only <b>html</b></div>")],
    };
    expect(extractBody(payload)).toBe("only html");
  });

  it("falls back to the top-level body when there are no typed parts at all", () => {
    const payload: RawGmailMessage["payload"] = { mimeType: "text/plain", body: { data: b64("flat body") } };
    expect(extractBody(payload)).toBe("flat body");
  });

  // Found via Task 5 Step 8's realistic hotel-confirmation fixture: real confirmation
  // templates use named/numeric HTML entities that plain tag-stripping leaves untouched,
  // handing the extraction model literal "&amp;"/"&#39;" noise instead of the real
  // characters. General fix (every provider's html goes through the same decode), not a
  // vendor-specific branch.
  it("decodes common named and numeric HTML entities in the html branch", () => {
    const payload: RawGmailMessage["payload"] = {
      mimeType: "multipart/mixed",
      parts: [textPart("text/html", "<p>Smith &amp; Sons&nbsp;&mdash; it&#39;s &quot;confirmed&quot; &#8594; today</p>")],
    };
    expect(extractBody(payload)).toBe('Smith & Sons — it\'s "confirmed" → today');
  });
});

describe("readableAttachments", () => {
  it("keeps PDF and .ics parts and drops everything else", () => {
    const payload: RawGmailMessage["payload"] = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "application/pdf", filename: "eticket.pdf", body: { attachmentId: "att-1" } },
        { mimeType: "text/calendar", filename: "invite.ics", body: { attachmentId: "att-2" } },
        { mimeType: "image/png", filename: "logo.png", body: { attachmentId: "att-3" } },
        { mimeType: "application/pdf", filename: "no-id.pdf" }, // no attachmentId — must be dropped
      ],
    };
    const kept = readableAttachments(payload).map((p) => p.filename);
    expect(kept).toEqual(["eticket.pdf", "invite.ics"]);
  });
});

describe("renderMailText", () => {
  it("appends attachment text under a labeled section, capped at 8000 chars", async () => {
    const raw: RawGmailMessage = {
      id: "m-1",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          textPart("text/plain", "body text"),
          { mimeType: "application/pdf", filename: "eticket.pdf", body: { attachmentId: "att-1" } },
        ],
      },
    };
    const longText = "X".repeat(9000);
    const fetchAttachment = async () => Buffer.from("pdf-bytes");
    const pdfText = async () => longText;

    const out = await renderMailText(raw, fetchAttachment, pdfText);

    expect(out).toContain("body text");
    expect(out).toContain("[Vedlegg: eticket.pdf]");
    const appended = out.slice(out.indexOf("[Vedlegg: eticket.pdf]") + "[Vedlegg: eticket.pdf]\n".length);
    expect(appended.length).toBe(8000);
  });

  it("degrades to a note instead of throwing when an attachment fetch fails", async () => {
    const raw: RawGmailMessage = {
      id: "m-2",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          textPart("text/plain", "body text"),
          { mimeType: "application/pdf", filename: "broken.pdf", body: { attachmentId: "att-x" } },
        ],
      },
    };
    const fetchAttachment = async () => {
      throw new Error("network down");
    };

    const out = await renderMailText(raw, fetchAttachment);

    expect(out).toContain("body text");
    expect(out).toContain("[Vedlegg: broken.pdf — kunne ikke leses]");
  });

  it("reads a non-PDF (.ics) attachment as plain utf8 text, no pdfText call", async () => {
    const raw: RawGmailMessage = {
      id: "m-3",
      payload: {
        mimeType: "multipart/mixed",
        parts: [{ mimeType: "text/calendar", filename: "invite.ics", body: { attachmentId: "att-ics" } }],
      },
    };
    const fetchAttachment = async () => Buffer.from("BEGIN:VCALENDAR\nEND:VCALENDAR", "utf8");
    const pdfText = async () => {
      throw new Error("must not be called for .ics");
    };

    const out = await renderMailText(raw, fetchAttachment, pdfText);
    expect(out).toContain("BEGIN:VCALENDAR");
  });
});

describe("toReiseMailHeaderFields", () => {
  it("prefers the Date header, falling back to internalDate", () => {
    const withDateHeader: RawGmailMessage = {
      id: "h-1",
      payload: { headers: [{ name: "Subject", value: "Hei" }, { name: "From", value: "a@b.no" }, { name: "Date", value: "Wed, 15 Jul 2026 10:00:00 +0000" }] },
    };
    expect(toReiseMailHeaderFields(withDateHeader)).toEqual({
      id: "h-1",
      subject: "Hei",
      from: "a@b.no",
      receivedAt: "2026-07-15T10:00:00.000Z",
    });

    const withoutDateHeader: RawGmailMessage = { id: "h-2", internalDate: "1752570000000", payload: {} };
    expect(toReiseMailHeaderFields(withoutDateHeader).receivedAt).toBe(new Date(1752570000000).toISOString());
  });
});

describe("makeExtractBooking — budget wiring (review finding 8)", () => {
  // Old Marcel's makeExtractBooking(model, budget, dateContext) called budget.add(usage) after
  // every extraction call (services/marcel/bin/marcel.ts:852) — eve-marcel's port dropped the
  // budget parameter entirely, so /sveip's up-to-100-call extraction loop tracked zero spend.
  // This test proves the port now matches: an injected Budget accumulates real usage tokens
  // across extraction calls, the same pattern lib/gatekeeper.ts's makeGateDecide already used.
  function mail(overrides: Partial<ReiseMail> = {}): ReiseMail {
    return { id: "m-1", subject: "Booking", from: "a@b.no", receivedAt: "2026-07-01T00:00:00.000Z", bodyText: "…", ...overrides };
  }

  it("adds the call's total tokens to the injected budget after every extraction — accumulates across calls, exactly like makeGateDecide", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: '{"isBooking":false}' }],
        finishReason: "stop",
        warnings: [],
        usage: {
          inputTokens: { total: 500, noCache: 500, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
      }),
    });
    // 520 tokens/call, cap 1000: the 1st call must stay under, the 2nd must trip it — proves
    // add() is actually called and accumulates, not a one-shot or no-op wiring.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marcel-extract-budget-cap-"));
    const capped = new Budget(path.join(dir, "budget.json"), 1000, "UTC");
    const extract = makeExtractBooking(model as never, () => "I dag er 2026-07-01.", capped);

    expect(capped.exceeded()).toBe(false);
    await extract(mail());
    expect(capped.exceeded()).toBe(false); // 520 < 1000
    await extract(mail({ id: "m-2" }));
    expect(capped.exceeded()).toBe(true); // 1040 >= 1000
  });

  it("still works with no budget injected (backward-compatible optional param)", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: '{"isBooking":false}' }],
        finishReason: "stop",
        warnings: [],
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 2, text: 2, reasoning: undefined } },
      }),
    });
    const extract = makeExtractBooking(model as never, () => "I dag er 2026-07-01.");
    await expect(extract(mail())).resolves.toBeNull();
  });
});

describe("extractionDateContext", () => {
  it("anchors the model to today and lists known trip windows", () => {
    const ctx = extractionDateContext("2026-07-15", [{ name: "Nice", start: "2026-07-21", end: "2026-07-28" }]);
    expect(ctx).toContain("I dag er 2026-07-15.");
    expect(ctx).toContain("Nice: 2026-07-21..2026-07-28");
  });

  it("omits the 'Kjente turer' clause when there are no trips yet", () => {
    const ctx = extractionDateContext("2026-07-15", []);
    expect(ctx).not.toContain("Kjente turer");
  });
});
