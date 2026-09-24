// Task 5, Step 8 — run `backfill` against realistic NYC-relevant fixture mails, in place of a
// real inbox (this agent has no access to Bendik's actual mail). Four raw-MIME fixtures,
// modeled on real travel-confirmation shapes:
//   1. Hotel confirmation — dual HTML+plaintext, the parts DISAGREE (the direct real-world
//      analog of the Avis bug: a stale plaintext confirmation coexists with a correct html
//      one), and the html carries HTML entities (&amp;/&nbsp;/&#39;) real confirmation
//      templates actually use.
//   2. Broadway show confirmation — html body plus BOTH an .ics calendar invite and a PDF
//      e-ticket attachment (only PDF-only or ICS-only was covered in bookings.test.ts).
//   3. Restaurant reservation confirmation — plaintext-ONLY (no html part at all), a shape
//      not otherwise exercised in bookings.test.ts's synthetic fixtures.
//   4. Flight confirmation to JFK — dual MIME (the parts AGREE, the ordinary case) plus a PDF
//      boarding-pass-style attachment, for kind diversity against the same trip window.
//
// The "extractor" below is NOT a real LLM call (none is available in this environment) — it's
// a small deterministic stand-in that parses the RENDERED text `renderMailText` produces,
// exactly the text a real `generateObject` call would receive. Its job is to prove the
// rendered text actually CONTAINS what an extractor needs (dates, confirmation codes, venue/
// provider names) and that BookingPipeline correctly files/dedupes/matches trip windows using
// it — not to model the LLM's own judgment.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TripStore, type Trip } from "../lib/trip-store.js";
import {
  BookingPipeline,
  renderMailText,
  toReiseMailHeaderFields,
  type Booking,
  type RawGmailMessage,
  type ReiseMail,
} from "../lib/bookings.js";

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

let root: string;
let store: TripStore;
let trip: Trip;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-fixtures-"));
  store = new TripStore(root);
  store.saveConfig({ adminId: "999", killSwitch: false, dailyTokenBudget: 1_000_000, trips: [] });
  trip = store.createTrip({
    slug: "nyc-2026",
    name: "New York",
    start: "2026-09-12",
    end: "2026-09-18",
    timezone: "America/New_York",
    destination: { name: "New York", lat: 40.7128, lon: -74.006 },
  });
});

function fakeTg() {
  const sent: { chatId: string; text: string }[] = [];
  return {
    sent,
    async send(chatId: string, text: string) {
      sent.push({ chatId, text });
      return String(sent.length);
    },
  };
}

// -----------------------------------------------------------------------------------------
// Fixture 1 — hotel confirmation. Real Gmail shape: multipart/alternative, text/plain +
// text/html. The plaintext is a STALE cached copy (wrong dates); the html is the current,
// correct confirmation and carries real-world HTML entities.
// -----------------------------------------------------------------------------------------

const HOTEL_RAW: RawGmailMessage = {
  id: "gmail-hotel-nyc-1",
  internalDate: String(Date.parse("2026-08-20T14:00:00Z")),
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "Subject", value: "Your reservation is confirmed — The Beekman" },
      { name: "From", value: "reservations@thebeekmanhotel.example" },
      { name: "Date", value: "Thu, 20 Aug 2026 14:00:00 +0000" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: {
          data: b64(
            "Reservation confirmation OLDCONF999 — The Beekman Hotel New York. " +
              "Check-in: 2026-08-01. Check-out: 2026-08-03. Room: Standard King. " +
              "(cached copy of an earlier confirmation)",
          ),
        },
      },
      {
        mimeType: "text/html",
        body: {
          data: b64(
            "<html><body>" +
              "<p>Reservation confirmed &mdash; The Beekman, a Thompson Hotel &amp; Spa</p>" +
              "<p>Confirmation #: BKM4471</p>" +
              "<p>Check-in: September 13, 2026 (3:00&nbsp;PM)</p>" +
              "<p>Check-out: September 16, 2026 (11:00&nbsp;AM)</p>" +
              "<p>It&#39;s located at 123 Nassau St, New York, NY</p>" +
              "</body></html>",
          ),
        },
      },
    ],
  },
};

// -----------------------------------------------------------------------------------------
// Fixture 2 — Broadway show confirmation. html body + an .ics calendar invite AND a PDF
// e-ticket attachment together (bookings.test.ts's synthetic fixtures only ever attach one
// attachment type at a time).
// -----------------------------------------------------------------------------------------

const SHOW_ICS =
  "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:Hamilton\n" +
  "DTSTART:20260914T200000\nLOCATION:Richard Rodgers Theatre\nEND:VEVENT\nEND:VCALENDAR";

const SHOW_RAW: RawGmailMessage = {
  id: "gmail-broadway-nyc-1",
  internalDate: String(Date.parse("2026-07-01T09:00:00Z")),
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "Subject", value: "Your Hamilton tickets — Sept 14" },
      { name: "From", value: "tickets@telecharge.example" },
      { name: "Date", value: "Wed, 1 Jul 2026 09:00:00 +0000" },
    ],
    parts: [
      {
        mimeType: "text/html",
        body: {
          data: b64(
            "<html><body><p>Your order is confirmed.</p>" +
              "<p>Hamilton &mdash; Richard Rodgers Theatre</p>" +
              "<p>September 14, 2026, 8:00 PM</p>" +
              "<p>Order #: HAM-90210</p></body></html>",
          ),
        },
      },
      // Real Gmail attachment parts carry an attachmentId and NO inline body.data — the
      // bytes are fetched separately via attachments.get, which fetchAttachment stands in
      // for below (keyed by attachmentId, not read from this part directly).
      { mimeType: "text/calendar", filename: "hamilton.ics", body: { attachmentId: "att-ics-1" } },
      { mimeType: "application/pdf", filename: "eticket.pdf", body: { attachmentId: "att-pdf-1" } },
    ],
  },
};

// -----------------------------------------------------------------------------------------
// Fixture 3 — restaurant reservation confirmation. Plaintext ONLY — no html part exists at
// all (a real, common shape old Marcel's own synthetic fixtures never separately covered).
// -----------------------------------------------------------------------------------------

const RESTAURANT_RAW: RawGmailMessage = {
  id: "gmail-restaurant-nyc-1",
  internalDate: String(Date.parse("2026-09-01T18:00:00Z")),
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "Subject", value: "Reservation confirmed at Carbone" },
      { name: "From", value: "noreply@resy.example" },
      { name: "Date", value: "Tue, 1 Sep 2026 18:00:00 +0000" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: {
          data: b64(
            "Your reservation at Carbone is confirmed. Party of 2. " +
              "Date: Monday, September 14, 2026 at 7:30 PM. " +
              "Address: 181 Thompson St, New York, NY. Confirmation code: RESY-88213.",
          ),
        },
      },
    ],
  },
};

// -----------------------------------------------------------------------------------------
// Fixture 4 — flight to JFK. Dual MIME where the parts AGREE (the ordinary case, unlike
// fixture 1), plus a PDF boarding-pass-style attachment.
// -----------------------------------------------------------------------------------------

const FLIGHT_RAW: RawGmailMessage = {
  id: "gmail-flight-jfk-1",
  internalDate: String(Date.parse("2026-06-01T08:00:00Z")),
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "Subject", value: "Your flight to New York (JFK) is confirmed" },
      { name: "From", value: "noreply@sas.no" },
      { name: "Date", value: "Mon, 1 Jun 2026 08:00:00 +0000" },
    ],
    parts: [
      { mimeType: "text/plain", body: { data: b64("SK123 OSL->JFK confirmed. 2026-09-12 departing 15:20. Ref: N7Q2K.") } },
      { mimeType: "text/html", body: { data: b64("<html><body><p>SK123 OSL&rarr;JFK confirmed.</p><p>2026-09-12 departing 15:20. Ref: N7Q2K.</p></body></html>") } },
      { mimeType: "application/pdf", filename: "boardingpass.pdf", body: { attachmentId: "att-pdf-2" } },
    ],
  },
};

// -----------------------------------------------------------------------------------------
// Rendering — turns each raw fixture into the ReiseMail the pipeline consumes, via the SAME
// renderMailText/toReiseMailHeaderFields path agent/tools/sveip.ts's real Gmail listing uses.
// -----------------------------------------------------------------------------------------

/** Stands in for the real `attachments.get`-backed fetch (`agent/tools/sveip.ts`'s real one),
 *  keyed by attachmentId — matching Gmail's actual attachment-fetch contract: an attachment
 *  part's `body.data` is empty and its bytes are fetched separately, exactly what
 *  `renderMailText` calls this function to do. */
async function fetchAttachment(_messageId: string, attachmentId: string): Promise<Buffer> {
  if (attachmentId === "att-ics-1") return Buffer.from(SHOW_ICS, "utf8");
  return Buffer.from("stand-in-bytes"); // PDF fixtures: pdfText() below ignores the bytes anyway
}

async function pdfText(): Promise<string> {
  return "SEAT 14C GATE B22";
}

async function renderFixture(raw: RawGmailMessage): Promise<ReiseMail> {
  return { ...toReiseMailHeaderFields(raw), bodyText: await renderMailText(raw, fetchAttachment, pdfText) };
}

// -----------------------------------------------------------------------------------------
// The stand-in extractor. Deterministic, regex-based — NOT a model of LLM judgment, just
// proof the rendered text carries enough signal. One deliberate policy choice mirrors what a
// competent LLM extractor would actually do: when the rendered text contains BOTH a plain and
// an html rendering (joined by extractBody's own "[HTML-versjonen av e-posten]" marker), it
// reads dates from the text AFTER that marker — i.e. it prefers the html half when the two
// disagree, exactly the contract this task's self-review checklist requires.
// -----------------------------------------------------------------------------------------

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

function isoFromLongDate(text: string): string | undefined {
  const m = text.match(/([A-Za-z]+) (\d{1,2}),? (\d{4})/);
  if (!m) return undefined;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return undefined;
  return `${m[3]}-${month}-${m[2].padStart(2, "0")}`;
}

function preferHtmlHalf(bodyText: string): string {
  const marker = "[HTML-versjonen av e-posten]";
  const idx = bodyText.indexOf(marker);
  return idx === -1 ? bodyText : bodyText.slice(idx + marker.length);
}

function extractHotel(mail: ReiseMail): Booking | null {
  const authoritative = preferHtmlHalf(mail.bodyText);
  const ref = authoritative.match(/Confirmation #: (\S+)/)?.[1];
  const dates = [...authoritative.matchAll(/([A-Za-z]+ \d{1,2},? \d{4})/g)].map((m) => isoFromLongDate(m[1])).filter((d): d is string => Boolean(d));
  if (!ref || dates.length < 2) return null;
  return {
    id: mail.id,
    kind: "stay",
    provider: "The Beekman",
    ref,
    startISO: dates[0],
    endISO: dates[1],
    details: `🏨 The Beekman ${dates[0]} → ${dates[1]} (ref ${ref})`,
  };
}

function extractShow(mail: ReiseMail): Booking | null {
  const ref = mail.bodyText.match(/Order #: (\S+)/)?.[1];
  const startISO = mail.bodyText.match(/DTSTART:(\d{4})(\d{2})(\d{2})T/);
  if (!ref || !startISO) return null;
  const [, y, mo, d] = startISO;
  return {
    id: mail.id,
    kind: "other",
    provider: "Telecharge",
    ref,
    startISO: `${y}-${mo}-${d}`,
    startTime: "20:00",
    details: `🎭 Hamilton — Richard Rodgers Theatre, ${y}-${mo}-${d} 20:00 (ref ${ref})`,
  };
}

function extractRestaurant(mail: ReiseMail): Booking | null {
  const ref = mail.bodyText.match(/Confirmation code: (\S+)/)?.[1];
  const startISO = isoFromLongDate(mail.bodyText);
  if (!ref || !startISO) return null;
  return {
    id: mail.id,
    kind: "restaurant",
    provider: "Carbone",
    ref,
    startISO,
    startTime: "19:30",
    details: `🍝 Carbone ${startISO} 19:30 (ref ${ref})`,
  };
}

function extractFlight(mail: ReiseMail): Booking | null {
  const ref = mail.bodyText.match(/Ref: (\S+)/)?.[1]?.replace(/\.$/, "");
  const startISO = mail.bodyText.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!ref || !startISO) return null;
  return {
    id: mail.id,
    kind: "flight",
    provider: "SAS",
    ref,
    startISO,
    startTime: "15:20",
    details: `✈️ SK123 OSL→JFK ${startISO} 15:20 (ref ${ref})`,
  };
}

const EXTRACTORS: Record<string, (mail: ReiseMail) => Booking | null> = {
  "gmail-hotel-nyc-1": extractHotel,
  "gmail-broadway-nyc-1": extractShow,
  "gmail-restaurant-nyc-1": extractRestaurant,
  "gmail-flight-jfk-1": extractFlight,
};

describe("Task 5 Step 8 — backfill against realistic NYC fixture mails", () => {
  it("renders all four raw fixtures to non-empty ReiseMail bodyText", async () => {
    for (const raw of [HOTEL_RAW, SHOW_RAW, RESTAURANT_RAW, FLIGHT_RAW]) {
      const mail = await renderFixture(raw);
      expect(mail.bodyText.length).toBeGreaterThan(0);
      expect(mail.id).toBe(raw.id);
    }
  });

  it("hotel fixture: decodes HTML entities so the confirmation text reads cleanly (real templates use &amp;/&nbsp;/&#39;)", async () => {
    const mail = await renderFixture(HOTEL_RAW);
    // These are the LITERAL entity strings — if present, the html branch failed to decode
    // them and an LLM extractor would see raw markup noise instead of real characters.
    expect(mail.bodyText).not.toContain("&amp;");
    expect(mail.bodyText).not.toContain("&nbsp;");
    expect(mail.bodyText).not.toContain("&#39;");
    expect(mail.bodyText).toContain("Thompson Hotel & Spa");
    expect(mail.bodyText).toContain("It's located at 123 Nassau St");
  });

  it("hotel fixture: BOTH the stale plaintext and the correct html dates are present in the rendered text", async () => {
    const mail = await renderFixture(HOTEL_RAW);
    expect(mail.bodyText).toContain("2026-08-01"); // stale plaintext, still readable
    expect(mail.bodyText).toContain("September 13, 2026"); // correct html
  });

  it("show fixture: the .ics attachment's structured fields AND the PDF e-ticket text both survive into bodyText", async () => {
    const mail = await renderFixture(SHOW_RAW);
    expect(mail.bodyText).toContain("SUMMARY:Hamilton");
    expect(mail.bodyText).toContain("DTSTART:20260914T200000");
    expect(mail.bodyText).toContain("[Vedlegg: eticket.pdf]");
    expect(mail.bodyText).toContain("SEAT 14C GATE B22");
  });

  it("restaurant fixture: plain-only mail (no html part) still renders its full body", async () => {
    const mail = await renderFixture(RESTAURANT_RAW);
    expect(mail.bodyText).toContain("Carbone");
    expect(mail.bodyText).toContain("RESY-88213");
    expect(mail.bodyText).not.toContain("[HTML-versjonen av e-posten]"); // no html part existed
  });

  it("flight fixture: the boarding-pass PDF text is appended alongside the agreeing dual-MIME body", async () => {
    const mail = await renderFixture(FLIGHT_RAW);
    expect(mail.bodyText).toContain("SK123");
    expect(mail.bodyText).toContain("[Vedlegg: boardingpass.pdf]");
    expect(mail.bodyText).toContain("GATE B22");
  });

  it("backfill files all four into the NYC trip using the html-preferring stand-in extractor, with full accounting", async () => {
    const tg = fakeTg();
    const mails = await Promise.all([HOTEL_RAW, SHOW_RAW, RESTAURANT_RAW, FLIGHT_RAW].map(renderFixture));
    const pipeline = new BookingPipeline({
      extract: async (mail) => EXTRACTORS[mail.id]?.(mail) ?? null,
      store,
      tg,
      adminId: "999",
      now: () => Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000),
    });

    const result = await pipeline.backfill(mails);

    // `read` is ORB-105's follow-up: the sweep now reports how many mails it actually read.
    expect(result).toEqual({ filed: 4, cancelled: 0, duplicates: 0, noTrip: 0, notBooking: 0, unclearSubjects: [], read: 4 });

    const bookings = store.read(trip, "bookings.md");
    // The hotel booking used the HTML dates (Sept 13→16), never the stale plaintext ones
    // (Aug 1→3) — the Avis-bug contract, proven end to end through the real pipeline.
    expect(bookings).toContain("id:gmail-hotel-nyc-1 kind:stay start:2026-09-13 end:2026-09-16");
    expect(bookings).not.toContain("start:2026-08-01");
    expect(bookings).toContain("id:gmail-broadway-nyc-1 kind:other start:2026-09-14");
    expect(bookings).toContain("id:gmail-restaurant-nyc-1 kind:restaurant start:2026-09-14");
    expect(bookings).toContain("id:gmail-flight-jfk-1 kind:flight start:2026-09-12");

    // One veto-button admin DM per filed booking — 4 filed, 4 DMs.
    expect(tg.sent).toHaveLength(4);
  });

  it("a vetoed fixture booking is never refiled by a second backfill pass over the same mails", async () => {
    const tg = fakeTg();
    const mails = await Promise.all([HOTEL_RAW, SHOW_RAW, RESTAURANT_RAW, FLIGHT_RAW].map(renderFixture));
    const pipeline = new BookingPipeline({
      extract: async (mail) => EXTRACTORS[mail.id]?.(mail) ?? null,
      store,
      tg,
      adminId: "999",
      now: () => Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000),
    });

    await pipeline.backfill(mails);
    await pipeline.veto("gmail-broadway-nyc-1");

    const second = await pipeline.backfill(mails);

    expect(second).toEqual({ filed: 0, cancelled: 0, duplicates: 4, noTrip: 0, notBooking: 0, unclearSubjects: [], read: 4 });
    expect(store.read(trip, "bookings.md")).not.toContain("gmail-broadway-nyc-1");
  });
});
