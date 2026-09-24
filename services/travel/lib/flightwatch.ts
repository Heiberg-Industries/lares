// lib/flightwatch.ts — pure change detection for the travel-day flight watcher. Ported from
// services/marcel/lib/flightwatch.ts (Task 6 dependency, Task 7 consumer) — same diff logic,
// unchanged, plus two additions:
//
//   - `messageId` is `string`, not `number` — matching eve-marcel's own id convention
//     (lib/trip-store.ts's doc comment: chatId/adminId are string, not old Marcel's numeric
//     Telegram SDK ids; eve's own `TelegramMessageResult.id` is also a string).
//   - Tier 1 #3 (international-leg resilience, approved 2026-08-16): renderFlightStatus's
//     "card" gains a fixed connection-buffer/customs-timing line whenever the leg crosses the
//     Norway/abroad boundary. See isInternationalLeg's own doc comment for exactly how that
//     boundary is derived and its one deliberate limitation. This is a pure text addition to
//     the existing card — no new WatchState field, no new alert type in diffFlightState's
//     `messages`, no new trigger condition.
//
// All persistence/quiet-hour policy lives in lib/trip-schedule.ts; this module stays a pure
// function pair for testability, exactly like the file it was ported from.
import { NORWEGIAN_AIRPORTS, type FlightStatus } from "./flights.js";

export interface WatchState {
  [flightKey: string]: {
    estimated?: string;
    gate?: string;
    checkIn?: string;
    cancelled?: boolean;
    alertedEstimated?: string;
    messageId?: string;
  };
}

const MATERIAL_SHIFT_MIN = 10;

/** Default declared-connection threshold (minutes) below which the international-leg card
 *  shows the customs/connection-buffer line. Configurable via renderFlightStatus's `opts`
 *  (agent/schedules/trip-lifecycle.ts wires it from MARCEL_CONNECTION_BUFFER_MIN) — never
 *  hardcoded inline inside the render function itself. */
export const DEFAULT_CONNECTION_BUFFER_MIN = 90;

function minutesBetween(a: string, b: string): number {
  const [ah, am] = a.split(":").map(Number);
  const [bh, bm] = b.split(":").map(Number);
  const aMin = ah! * 60 + am!;
  const bMin = bh! * 60 + bm!;
  const d = Math.abs(bMin - aMin);
  return Math.min(d, 1440 - d); // circular distance: midnight wraps at 1440 min
}

function credit(st: FlightStatus): string {
  return st.source === "aerodatabox" ? "" : " (Flydata fra Avinor)";
}

/**
 * True when a leg's departure and arrival airports fall on opposite sides of the Norway/
 * abroad boundary. `NORWEGIAN_AIRPORTS` (lib/flights.ts) is the only "country" signal
 * flights-io.ts's response carries, so "international" here means "exactly one endpoint is a
 * Norwegian airport" — a foreign-to-foreign leg (neither endpoint Norwegian) is NOT flagged,
 * and a leg with either endpoint missing is NOT flagged either.
 *
 * That is a deliberate, documented simplification, not a general customs-border oracle:
 * Marcel only ever watches a Norway-based family's own itinerary, which always touches Norway
 * on one end, so this signal is sufficient for every real case this app sees.
 */
export function isInternationalLeg(from: string | undefined, to: string | undefined): boolean {
  if (!from || !to) return false;
  return NORWEGIAN_AIRPORTS.has(from) !== NORWEGIAN_AIRPORTS.has(to);
}

export function diffFlightState(prev: WatchState, st: FlightStatus, opts: { quiet: boolean }): { messages: string[]; next: WatchState } {
  const key = `${st.flightNo}:${st.dateISO}`;
  const p = prev[key];
  // Never overwrite defined values with undefined (hiccup guard)
  const cur = {
    estimated: st.estimated ?? p?.estimated,
    gate: st.gate ?? p?.gate,
    checkIn: st.checkIn ?? p?.checkIn,
    cancelled: st.cancelled,
    alertedEstimated: p?.alertedEstimated,
    messageId: p?.messageId,
  };
  const next: WatchState = { ...prev, [key]: cur };
  const messages: string[] = [];
  const route = st.from && st.to ? ` ${st.from}–${st.to}` : "";

  if (!p) return { messages, next }; // first sighting = baseline, never a post

  if (st.cancelled && !p.cancelled) {
    messages.push(`🔴 ${st.flightNo}${route} er KANSELLERT.${credit(st)} Sjekk ombooking med flyselskapet.`);
    return { messages, next }; // cancellation trumps the rest — and bypasses quiet hours upstream
  }
  if (opts.quiet) return { messages: [], next };

  // Delay detection: compare against alertedEstimated (not raw estimated)
  // This prevents creeping drifts from accumulating without alert.
  if (st.estimated && st.estimated !== p.estimated) {
    const base = p.alertedEstimated ?? st.scheduled;
    if (!base || minutesBetween(base, st.estimated) >= MATERIAL_SHIFT_MIN) {
      const delta = st.scheduled ? ` (planlagt ${st.scheduled})` : "";
      messages.push(`⏱ ${st.flightNo}${route}: ny tid ${st.estimated}${delta}.${credit(st)}`);
      // Advance alertedEstimated only when we POST the message (not when suppressed by quiet)
      next[key]!.alertedEstimated = st.estimated;
    }
  }
  if (st.gate && st.gate !== p.gate) {
    messages.push(p.gate
      ? `🚪 ${st.flightNo}: gate endret ${p.gate} → ${st.gate}.${credit(st)}`
      : `🚪 ${st.flightNo}: gate ${st.gate}.${credit(st)}`);
  }
  if (st.checkIn && st.checkIn !== p.checkIn && !p.checkIn) {
    messages.push(`🧳 ${st.flightNo}: innsjekk ${st.checkIn}.${credit(st)}`);
  }
  return { messages, next };
}

/** Full current-status card for the ONE live travel-day message per flight. The scheduler
 *  posts it on the first material change and EDITS it thereafter — the group sees a single
 *  message that is always current instead of a stream of deltas. Markdown: the raw-send path
 *  (agent/schedules/trip-lifecycle.ts) converts **bold** / _italic_ to Telegram HTML. */
export function renderFlightStatus(
  st: FlightStatus,
  updatedHhmm: string,
  opts?: { connectionBufferMinutes?: number },
): string {
  const route = st.from && st.to ? ` ${st.from}–${st.to}` : "";
  const lines = [`✈️ **${st.flightNo}**${route}`];
  lines.push(
    st.estimated && st.scheduled && st.estimated !== st.scheduled
      ? `Avgang: ny tid **${st.estimated}** (planlagt ${st.scheduled})`
      : `Avgang: ${st.estimated ?? st.scheduled ?? "ukjent"}`,
  );
  if (st.gate) lines.push(`Gate: ${st.gate}`);
  if (st.checkIn) lines.push(`Innsjekk: ${st.checkIn}`);
  if (isInternationalLeg(st.from, st.to)) {
    const buffer = opts?.connectionBufferMinutes ?? DEFAULT_CONNECTION_BUFFER_MIN;
    lines.push(`🛂 Internasjonal strekning — sett av minst ${buffer} min til pass-/tollkontroll ved videre forbindelse.`);
  }
  lines.push(`_Oppdatert ${updatedHhmm}${st.source === "aerodatabox" ? "" : " · Flydata fra Avinor"}_`);
  return lines.join("\n");
}
