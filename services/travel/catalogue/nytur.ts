/**
 * agent/tools/nytur.ts — creates a new trip, admin-DM-only. Ported from old Marcel's `/nytur`
 * wizard (`services/marcel/bin/marcel.ts:254-257,278-349`) — a genuine simplification, not a
 * line-for-line port: old Marcel hand-rolled a per-admin in-memory step state machine
 * (`NyturState`/`nyturSessions`, keyed by admin chat id) because its own daemon had no
 * multi-turn memory of its own. eve's session already carries the conversation across turns,
 * so the model itself can ask the same sequence of questions old Marcel's wizard asked (name,
 * destination, dates, timezone, house info) one at a time, and call this ONE tool once it has
 * every field — there is no hand-rolled step state to port here at all.
 *
 * Admin-DM-only: same tool-local gate as every other admin tool in this file set
 * (`agent/tools/sveip.ts`'s own doc comment explains why a channel-level allowlist alone isn't
 * enough — a group turn can reach any tool via the Gatekeeper's "speak" decision).
 */
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";

import { TripStore, type Trip } from "../lib/trip-store.js";
import { BookingPipeline } from "../lib/bookings.js";
import { fileExtractionCache } from "../lib/extraction-cache.js";
import { adminChatId, tgSend } from "./sveip.js";
import { isAllowedAdmin } from "../lib/principals.js";
import { OVERLAY_FILE, generateOverlay } from "../lib/persona-overlay.js";
import { distillBrain } from "../lib/distill.js";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

function callerAuth(auth: SessionAuth | undefined) {
  return auth?.current ?? auth?.initiator ?? null;
}

function assertAdminDm(auth: SessionAuth | undefined): void {
  const caller = callerAuth(auth);
  const chatType = caller?.attributes?.["chat_type"];
  const userId = caller?.attributes?.["user_id"];
  if (chatType !== "private" || typeof userId !== "string" || !isAllowedAdmin(userId)) {
    throw new Error("nytur: admin-DM only");
  }
}

/** Ported verbatim from old Marcel's `slugify` (`bin/marcel.ts:58-64`). */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const TRIP_MD = "trip.md";

export interface NyturDeps {
  store(): TripStore;
  /** 2026-08-17 rethink: files cached no-trip bookings into the freshly-created trip —
   *  returns how many were filed. Injected so tests need no Telegram/gmail wiring. */
  retroMatch?(store: TripStore): Promise<number>;
  /** ORB-96: ONE billed model call that writes the trip's destination persona overlay.
   *  Injected for the same reason retroMatch is — tests must not reach the gateway. */
  personaOverlay?(store: TripStore, trip: Trip): Promise<boolean>;
}

/** Live retro-match: a pipeline with a no-op extract (the cache already holds the
 *  bookings — retroMatch never extracts) over the shared store/cache/DM wiring. */
async function realRetroMatch(store: TripStore): Promise<number> {
  const pipeline = new BookingPipeline({
    extract: async () => null,
    store,
    tg: { send: tgSend },
    adminId: adminChatId(),
    now: () => Math.floor(Date.now() / 1000),
    cache: fileExtractionCache(dataRoot()),
  });
  return pipeline.retroMatch();
}

/** Live overlay generation (ORB-96): one call to the brain model, written into the trip dir.
 *  Exported so the `persona_overlay` regenerate tool runs the exact same path — one generator,
 *  not two that can drift apart. Returns whether anything was written. */
export async function realPersonaOverlay(store: TripStore, trip: Trip): Promise<boolean> {
  const overlay = await generateOverlay({ distill: (p) => distillBrain(p) }, trip);
  if (overlay.trim() === "") return false;
  store.write(trip, OVERLAY_FILE, overlay);
  return true;
}

export const defaultNyturDeps: NyturDeps = {
  store: () => new TripStore(dataRoot()),
  retroMatch: realRetroMatch,
  personaOverlay: realPersonaOverlay,
};

const inputSchema = z.object({
  name: z.string().min(1).describe("trip name, e.g. 'NYC 2026'"),
  destinationName: z.string().min(1),
  lat: z.number(),
  lon: z.number(),
  startISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1).describe("IANA timezone, e.g. 'America/New_York'"),
  houseInfo: z
    .string()
    .optional()
    .describe("free-text house/apartment info (wifi, door code, address) — omit for none"),
});

export function createNyturTool(deps: NyturDeps) {
  return defineTool({
    description:
      "Create a brand new trip — admin-DM only. Ask the admin for the trip name, destination " +
      "(name + coordinates), dates, timezone, and any house/apartment info FIRST, one question " +
      "at a time like old Marcel's /nytur wizard, then call this ONCE with every field. Fails " +
      "if a trip with the same (slugified) name already exists.",
    inputSchema,
    async execute({ name, destinationName, lat, lon, startISO, endISO, timezone, houseInfo }, ctx) {
      assertAdminDm(ctx.session.auth);

      const store = deps.store();
      const slug = slugify(name);
      if (store.trips().some((t) => t.slug === slug)) {
        return { error: `en tur med slug "${slug}" finnes allerede` };
      }

      const trip = store.createTrip({
        slug,
        name,
        start: startISO,
        end: endISO,
        timezone,
        destination: { name: destinationName, lat, lon },
      });

      const house = houseInfo?.trim();
      if (house && house !== "-") {
        store.write(trip, TRIP_MD, house + "\n");
      }

      // Retro-file cached orphan bookings into the new window (2026-08-17 rethink) — the
      // sveip that ran BEFORE this trip existed already paid for their extraction; creating
      // the trip is all that was missing. Best-effort: a retro failure must not fail /nytur.
      let retroFiled = 0;
      try {
        retroFiled = (await deps.retroMatch?.(store)) ?? 0;
      } catch (err) {
        console.error("nytur: retro-match failed (trip itself was created fine)", err);
      }

      // ORB-96: one billed call, cached as a file for the life of the trip — the destination
      // persona overlay. Same best-effort posture as retro-match above: a trip whose overlay
      // failed to generate is a perfectly good trip that simply speaks in base Marcel's voice.
      let personaOverlay = false;
      try {
        personaOverlay = (await deps.personaOverlay?.(store, trip)) ?? false;
      } catch (err) {
        console.error("nytur: persona-overlay generation failed (trip itself was created fine)", err);
      }

      return { ok: true, slug, name: trip.name, retroFiled, personaOverlay };
    },
  });
}

export default createNyturTool(defaultNyturDeps);
