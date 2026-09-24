/**
 * lib/current-trip.ts — the ONE shared "which trip is this conversation about?" resolver
 * (ORB-157).
 *
 * Before this file, every trip-aware tool carried its own copy of the same helper: read
 * `chat_id` off the session auth, `tripForChat()`, done. Correct in a linked group — and a
 * dead end everywhere else. The admin DM is deliberately never linked to a trip, so pasting
 * trip info there failed with "no trip linked to this chat" even when exactly one trip
 * existed in the whole system (2026-08-24, the NYC room description). Fourth incident in the
 * class "trip identity = the chat you're standing in" (ORB-123 schedules, ORB-111 first-turn
 * instructions, `info.ts`'s local slug patch); this resolver closes the class.
 *
 * The contract, matching `agent/tools/info.ts`'s established admin-DM pattern:
 *   - group/supergroup → the chat's own linked trip; an explicit `slug` is IGNORED (a group
 *     always has exactly one trip — letting a slug override it would let a group write into
 *     another group's trip).
 *   - admin DM (`chat_type === "private"` + `isAllowedAdmin`) → explicit `slug` wins;
 *     otherwise the single ACTIVE-OR-UPCOMING trip (`end >= today` in the fleet's home
 *     timezone); several candidates → a "which trip?" error NAMING the slugs, never a guess.
 *   - anything else (non-admin private chat, missing auth/chat) → fail closed with the same
 *     honest error a stranger would get, leaking nothing about what trips exist.
 *
 * Returns a discriminated result rather than throwing: every caller is a tool whose error
 * path is a returned `{ error }` the model can read aloud — matching each tool's existing
 * behavior, and keeping "no trip linked" reserved for when that is actually the situation.
 */
import type { SessionAuth } from "eve/context";

import { isAllowedAdmin } from "./principals.js";
import type { Trip, TripStore } from "./trip-store.js";

export type TripResolution = { ok: true; trip: Trip } | { ok: false; error: string };

/** Same day-boundary convention as `agent/instructions/trip-context.ts`'s FALLBACK_TZ: the
 *  admin DM belongs to no trip, so "today" is the fleet's home-timezone day. */
const FALLBACK_TZ = "Europe/Oslo";

function todayISOFor(tz: string, nowMs: number): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(nowMs),
  );
}

function caller(auth: SessionAuth | undefined) {
  return auth?.current ?? auth?.initiator ?? null;
}

const NO_TRIP = { ok: false, error: "no trip linked to this chat" } as const;

export function resolveCurrentTrip(
  store: TripStore,
  auth: SessionAuth | undefined,
  opts: { slug?: string; nowMs?: number } = {},
): TripResolution {
  const attrs = caller(auth)?.attributes;
  const chatId = attrs?.["chat_id"];
  const chatType = attrs?.["chat_type"];
  const userId = attrs?.["user_id"];
  if (typeof chatId !== "string" || chatId.length === 0) return NO_TRIP;

  if (chatType === "group" || chatType === "supergroup") {
    const trip = store.tripForChat(chatId);
    return trip ? { ok: true, trip } : NO_TRIP;
  }

  if (chatType !== "private" || typeof userId !== "string" || !isAllowedAdmin(userId)) return NO_TRIP;

  if (opts.slug) {
    const trip = store.trips().find((t) => t.slug === opts.slug);
    return trip ? { ok: true, trip } : { ok: false, error: `fant ingen tur med slug "${opts.slug}"` };
  }

  let homeTz: string;
  try {
    homeTz = store.homeTimezone();
  } catch {
    homeTz = FALLBACK_TZ;
  }
  const todayISO = todayISOFor(homeTz, opts.nowMs ?? Date.now());
  const candidates = store.trips().filter((t) => t.end >= todayISO);

  if (candidates.length === 1) return { ok: true, trip: candidates[0]! };
  if (candidates.length === 0) {
    return { ok: false, error: "ingen aktiv eller kommende tur — opprett en med nytur, eller oppgi slug" };
  }
  return {
    ok: false,
    error: `flere mulige turer — oppgi slug: ${candidates.map((t) => t.slug).join(", ")}`,
  };
}
