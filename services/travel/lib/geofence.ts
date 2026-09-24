/**
 * lib/geofence.ts — "du er 200 m fra Katz's — den lagret du i mars" (ORB-101).
 *
 * Pure decision logic: given a position, the saved places that have coordinates, and a ledger of
 * what has already been said today, decide what — if anything — to send. No fs, no Telegram, no
 * clock of its own. The schedule around it owns all of that.
 *
 * FOUR guards, and each exists because the failure it prevents is worse than silence:
 *
 *  1. RADIUS. 250 m is a walking radius — near enough that turning aside is a real option. Wider
 *     and every ping becomes "you are vaguely in Manhattan".
 *  2. ONE ALERT PER PLACE PER DAY. Live location updates every few seconds and the tick runs every
 *     minute; without this, sitting down to eat at a saved restaurant would ping continuously.
 *     Per DAY rather than per share, because the same walk past the same place tomorrow IS worth
 *     mentioning again.
 *  3. QUIET HOURS, in the TRIP's timezone. Marcel is a travel concierge; a phone buzzing at
 *     04:00 New York time about a bakery is a feature nobody asked for. The trip's own timezone,
 *     never the container's — the whole point of a trip is being somewhere else.
 *  4. NEAREST FIRST, capped. Walking through SoHo can put a dozen saved places inside 250 m. One
 *     message naming the closest few is useful; twelve messages is a reason to turn the feature
 *     off.
 *  5. COOLDOWN AND A DAILY CAP. Guards 2 and 4 bound how often ONE place is mentioned and how many
 *     places ONE message names — neither bounds how often the phone buzzes. Simulated against
 *     Bendik's real store, a 2.2 km evening walk through Grünerløkka produced SIXTEEN messages at
 *     the 250 m radius, and a 1.8 km SoHo→LES walk eleven: the tick runs every minute, and in a
 *     dense neighbourhood there is almost always a new place just ahead. That is the failure that
 *     paused Tyche's proactive messaging, arriving here by a different route.
 *
 *     Note that widening the radius does NOT help and slightly hurts: at 500 m the same walk gives
 *     eighteen messages, because saturation is set by the tick, not by the radius.
 */
import type { PlaceEntry } from "@lares/taste";

import { haversineKm } from "./taste.js";

/** Walking distance, not driving distance. */
export const PING_RADIUS_M = 250;

/** How many places one ping may name. */
export const MAX_PER_PING = 3;

/** Local hours (trip timezone) during which nothing is sent. */
export const QUIET_FROM_HOUR = 22;
export const QUIET_TO_HOUR = 8;

/** Minimum gap between two pings, whatever is near. Twenty minutes turns that Grünerløkka walk
 *  from sixteen messages into two, without narrowing what counts as "near" at all. */
export const PING_COOLDOWN_SEC = 20 * 60;

/** Ceiling for one local day. A day of walking should be able to surprise Bendik a handful of
 *  times; past that it is noise he will mute, and a muted feature helps nobody. */
export const MAX_PINGS_PER_DAY = 5;

export interface GeofenceCandidate {
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  /** Where it came from, for the message: "den lagret du i «NYC»". */
  readonly sourceList?: string;
  readonly note?: string;
  /** ORB-109 — set when this candidate is a BOOKED venue rather than a saved place. The two are
   *  different facts about the world and the message must not blur them: "du har lagret" is
   *  something Bendik chose once, "du har bord her" is an obligation with a time on it. */
  readonly booking?: { readonly kind: string; readonly startISO: string; readonly startTime?: string };
}

/**
 * Places that can be geofenced at all.
 *
 * Two exclusions, and the second is the subtle one. A saved place with no coordinates obviously
 * cannot be geofenced. A place flagged `approx` HAS coordinates — but they were decoded from the
 * saved link's own S2 cell rather than confirmed by a match (ORB-117), and that cell is stamped
 * when the feature is created and never moved afterwards: measured across the store, it sits over
 * a kilometre from the real pin for nearly half of them. Against a 250 m radius that is not a
 * near-miss, it is a different building — so an approximate pin would produce confident pings for
 * places Bendik is nowhere near, and stay silent outside ones he is walking past.
 *
 * An approximate pin is still worth storing: it answers "which city is this in" and puts a dot on
 * a map. It just must not be allowed to speak with a precision it does not have.
 */
export function geofenceCandidates(places: readonly PlaceEntry[]): GeofenceCandidate[] {
  return places
    .filter((p): p is PlaceEntry & { lat: number; lon: number } =>
      p.lat !== undefined && p.lon !== undefined && !p.approx)
    .map((p) => ({
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      ...(p.sourceList === undefined ? {} : { sourceList: p.sourceList }),
      ...(p.note === undefined ? {} : { note: p.note }),
    }));
}

/**
 * ORB-109 — booked venues that carry coordinates, as geofence candidates.
 *
 * `decideGeofence` takes an injected candidate array, so booked venues simply append to the
 * saved ones; nothing about the radius, the once-per-day ledger or quiet hours changes. A block
 * whose venue could not be resolved at filing time has no `at:` in its header and is skipped
 * here — exactly as a saved place without coordinates is.
 *
 * The NAME is the block's own venue name, which is what the ledger keys on, so a place that is
 * both saved and booked would otherwise alert twice in one day. `dedupeCandidates` below folds
 * them, keeping the booking (the more specific, more useful fact).
 */
export function bookedVenueCandidates(
  headers: readonly {
    kind: string; start: string; time?: string; provider?: string; lat?: number; lon?: number;
  }[],
): GeofenceCandidate[] {
  return headers
    .filter((h): h is typeof h & { lat: number; lon: number; provider: string } =>
      h.lat !== undefined && h.lon !== undefined && h.provider !== undefined)
    .map((h) => ({
      name: h.provider,
      lat: h.lat,
      lon: h.lon,
      booking: { kind: h.kind, startISO: h.start, ...(h.time === undefined ? {} : { startTime: h.time }) },
    }));
}

/** One entry per place name: a venue that is both saved AND booked is one place, and the
 *  booking is the version worth saying out loud. Order is preserved otherwise. */
export function dedupeCandidates(candidates: readonly GeofenceCandidate[]): GeofenceCandidate[] {
  const byName = new Map<string, GeofenceCandidate>();
  for (const c of candidates) {
    const key = c.name.trim().toLowerCase();
    const existing = byName.get(key);
    if (existing === undefined || (c.booking !== undefined && existing.booking === undefined)) byName.set(key, c);
  }
  return [...byName.values()];
}

export interface NearbyHit extends GeofenceCandidate {
  readonly distanceM: number;
}

/** The closest candidate of all, whatever the distance — for saying WHY a tick stayed quiet. */
export function nearestCandidate(
  candidates: readonly GeofenceCandidate[],
  position: { lat: number; lon: number },
): NearbyHit | undefined {
  let best: NearbyHit | undefined;
  for (const c of candidates) {
    const distanceM = Math.round(haversineKm(position, { lat: c.lat, lon: c.lon }) * 1000);
    if (!best || distanceM < best.distanceM) best = { ...c, distanceM };
  }
  return best;
}

/** Everything inside the radius, nearest first. */
export function withinRadius(
  candidates: readonly GeofenceCandidate[],
  position: { lat: number; lon: number },
  radiusM: number = PING_RADIUS_M,
): NearbyHit[] {
  return candidates
    .map((c) => ({ ...c, distanceM: Math.round(haversineKm(position, { lat: c.lat, lon: c.lon }) * 1000) }))
    .filter((c) => c.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
}

/** Ledger key — a place is "already mentioned" per NAME per local day. Name rather than
 *  coordinates, so two outlets of one chain are two separate alerts (they are two places), while
 *  the same place re-pinged from three metres away is one. */
export function alertKey(dayISO: string, name: string): string {
  return `${dayISO}:${name.trim().toLowerCase()}`;
}

export function isQuietHour(localHour: number): boolean {
  return localHour >= QUIET_FROM_HOUR || localHour < QUIET_TO_HOUR;
}

export interface GeofenceDecision {
  /** Hits worth telling Bendik about right now, nearest first, already capped. */
  readonly alerts: NearbyHit[];
  /** Ledger keys to record once the message is actually sent. */
  readonly keys: string[];
  /** Why nothing is being sent, when nothing is — for the tick's own logging, never for Bendik. */
  readonly skipped?: "quiet-hours" | "nothing-near" | "already-told" | "cooling-down" | "daily-cap";
}

export interface GeofenceInput {
  readonly candidates: readonly GeofenceCandidate[];
  readonly position: { lat: number; lon: number };
  /** Local day in the trip's timezone, "YYYY-MM-DD". */
  readonly dayISO: string;
  /** Local hour in the trip's timezone, 0–23. */
  readonly localHour: number;
  /** Ledger keys already alerted (any day — keys carry their own day). */
  readonly alerted: ReadonlySet<string>;
  readonly radiusM?: number;
  /** Now, epoch seconds — for the cooldown only. Absent means "do not apply a cooldown", which is
   *  what every pure test of the older guards wants. */
  readonly nowSec?: number;
  /** When the last ping actually went out, epoch seconds. */
  readonly lastSentSec?: number;
  /** How many pings have gone out during `dayISO` already. */
  readonly sentToday?: number;
}

/** The whole decision, in one pure call. */
export function decideGeofence(input: GeofenceInput): GeofenceDecision {
  if (isQuietHour(input.localHour)) return { alerts: [], keys: [], skipped: "quiet-hours" };

  const near = withinRadius(input.candidates, input.position, input.radiusM ?? PING_RADIUS_M);
  if (near.length === 0) return { alerts: [], keys: [], skipped: "nothing-near" };

  const fresh = near.filter((hit) => !input.alerted.has(alertKey(input.dayISO, hit.name)));
  if (fresh.length === 0) return { alerts: [], keys: [], skipped: "already-told" };

  // Rate limits are applied LAST, so the skip reason always names the most specific truth. Asked
  // in any other order, a walk through an empty part of town would report "cooling-down" and hide
  // the fact that there was nothing to say anyway.
  if ((input.sentToday ?? 0) >= MAX_PINGS_PER_DAY) return { alerts: [], keys: [], skipped: "daily-cap" };
  if (
    input.nowSec !== undefined &&
    input.lastSentSec !== undefined &&
    input.nowSec - input.lastSentSec < PING_COOLDOWN_SEC
  ) {
    return { alerts: [], keys: [], skipped: "cooling-down" };
  }

  const alerts = fresh.slice(0, MAX_PER_PING);
  return { alerts, keys: alerts.map((a) => alertKey(input.dayISO, a.name)) };
}

/**
 * The message. Norwegian, short, and honest about provenance: these are places BENDIK saved, so
 * they are named as his ("du har lagret"), never as Marcel's own knowledge of the city. Nothing
 * here claims the place is open or good — that is a tool question, asked when he asks it.
 */
export function composeProximityMessage(alerts: readonly NearbyHit[]): string {
  if (alerts.length === 0) return "";
  const lines = alerts.map((a) => {
    // ORB-109: a booking is named as a booking. "du har lagret" and "du har bord her kl. 20:00"
    // are different facts, and the second one has a clock attached.
    if (a.booking) {
      const when = a.booking.startTime ? `${a.booking.startISO} kl. ${a.booking.startTime}` : a.booking.startISO;
      return `• ${a.name}, ${a.distanceM} m — du har booket her (${when})`;
    }
    const from = a.sourceList ? ` — lagret i «${a.sourceList}»` : " — lagret av deg";
    const note = a.note ? ` (${a.note.replace(/\s+/g, " ").trim()})` : "";
    return `• ${a.name}, ${a.distanceM} m${from}${note}`;
  });
  const anyBooking = alerts.some((a) => a.booking !== undefined);
  const head = alerts.length === 1
    ? (anyBooking ? "📍 Du er rett ved et sted fra turen din:" : "📍 Du er rett ved et sted du har lagret:")
    : (anyBooking ? "📍 Du er rett ved noen steder fra turen din:" : "📍 Du er rett ved noen steder du har lagret:");
  return [head, ...lines].join("\n");
}
