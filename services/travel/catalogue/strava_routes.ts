/**
 * agent/tools/strava_routes.ts — popular run/ride routes near the trip + Bendik's own recent
 * activities, ported from old Marcel's `tools.strava_routes`
 * (`services/marcel/lib/brain.ts:206-226`). Thin wrapper only: all Strava logic (including
 * the mandatory refresh-token rotation — see `lib/strava.ts`'s own top-of-file GOTCHA
 * comment) lives in `lib/strava.ts` (Task 6 port, unchanged).
 *
 * Boundary: the model must NEVER invent a route, distance, or pace — only what this tool
 * returns is real.
 *
 * Strava is OPTIONAL (`MARCEL_STRAVA_CLIENT_ID_FILE`/`MARCEL_STRAVA_CLIENT_SECRET_FILE`,
 * defaulting to the `marcel-strava-client-id`/`marcel-strava-client-secret` Docker secrets
 * mounted in `services/box/compose.yaml`) — absent credentials disable this tool
 * (`{ error: "strava not connected" }`), matching old Marcel's own optional-Strava posture
 * (`services/marcel/bin/marcel.ts:766-768`).
 *
 * Token persistence: no durable volume is wired for eve-marcel's trip data yet (see
 * `agent/tools/sveip.ts`'s doc comment) — tokens live at `<MARCEL_DATA_ROOT>/strava-token.json`,
 * the same accepted-gap convention `lib/trip-store.ts`'s root already uses. `loadTokens`
 * throws when no token file exists yet (the one-time `bin/strava-oauth.ts`-style bootstrap,
 * NOT ported in this task per the brief, must seed this file first); `saveTokens` persists
 * the ROTATED refresh token Strava returns on every single call, per `lib/strava.ts`'s own
 * `accessToken()` — losing that write loses Strava access permanently at the next restart.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";

import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { TripStore } from "../lib/trip-store.js";
import { makeStrava, type Strava, type StravaTokens } from "../lib/strava.js";
import { resolveCurrentTrip, type TripResolution } from "../lib/current-trip.js";
import { isAllowedAdmin } from "../lib/principals.js";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

function callerAuth(auth: SessionAuth | undefined) {
  return auth?.current ?? auth?.initiator ?? null;
}

/** Identical shape to `agent/tools/calendar_list_events.ts`'s own `assertAdminDm` — duplicated
 *  rather than shared, matching this codebase's per-tool-file self-containment convention.
 *  Fails closed on anything that isn't unambiguously "the admin, in a private chat": missing
 *  auth, a group/supergroup `chat_type`, or a user id `isAllowedAdmin` doesn't recognise.
 *
 *  Only guards the `mine=true` path (review fix, minor item 1): that's the one that returns
 *  Bendik's own personal Strava activity data (distance, pace, timestamps) — the trip-scoped
 *  segment lookup (`mine=false`) returns public route data about a place, not personal data
 *  about Bendik, so it stays open to the group the same way `nearby_places`/`weather_forecast`
 *  already are. Every OTHER personal-data tool in this codebase (`sveip`, `calendar_list_events`,
 *  `nytur`, `link_group`, `toggle_kill_switch`) already gates the same way. */
function assertAdminDm(auth: SessionAuth | undefined): void {
  const caller = callerAuth(auth);
  const chatType = caller?.attributes?.["chat_type"];
  const userId = caller?.attributes?.["user_id"];
  if (chatType !== "private" || typeof userId !== "string" || !isAllowedAdmin(userId)) {
    throw new Error("strava_routes: mine=true is admin-DM only");
  }
}

// ORB-157: shared resolver — see lib/current-trip.ts for the contract.
async function currentTrip(auth: SessionAuth | undefined, slug?: string): Promise<TripResolution> {
  return resolveCurrentTrip(new TripStore(dataRoot()), auth, { slug });
}

function optionalSecret(envVar: string, fallbackPath: string): string | undefined {
  const path = process.env[envVar] ?? fallbackPath;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function tokenPath(): string {
  return path.join(dataRoot(), "strava-token.json");
}

function loadTokens(): StravaTokens {
  const file = tokenPath();
  if (!existsSync(file)) {
    throw new Error(`strava: no token file at ${file} — run the strava-oauth bootstrap first`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as StravaTokens;
}

function saveTokens(t: StravaTokens): void {
  mkdirSync(dataRoot(), { recursive: true });
  writeFileSync(tokenPath(), JSON.stringify(t, null, 2));
}

let cachedStrava: Strava | null | undefined; // undefined = not yet resolved; null = confirmed unconfigured

function realStrava(): Strava | undefined {
  if (cachedStrava === undefined) {
    const clientId = optionalSecret("MARCEL_STRAVA_CLIENT_ID_FILE", "/run/secrets/marcel-strava-client-id");
    const clientSecret = optionalSecret("MARCEL_STRAVA_CLIENT_SECRET_FILE", "/run/secrets/marcel-strava-client-secret");
    cachedStrava =
      clientId && clientSecret
        ? makeStrava({
            clientId,
            clientSecret,
            loadTokens,
            saveTokens,
            now: () => Math.floor(Date.now() / 1000),
            fetch: telegramFetch,
          })
        : null;
  }
  return cachedStrava ?? undefined;
}

export interface StravaRoutesDeps {
  strava(): Strava | undefined;
  currentTrip(auth: SessionAuth | undefined, slug?: string): Promise<TripResolution>;
}

export const defaultStravaRoutesDeps: StravaRoutesDeps = {
  strava: realStrava,
  currentTrip,
};

const inputSchema = z.object({
  activity: z.enum(["running", "riding"]).default("running"),
  radiusKm: z.number().min(2).max(40).default(15),
  mine: z.boolean().default(false),
  slug: z
    .string()
    .optional()
    .describe(
      "trip slug — only meaningful in the admin DM, and only when several trips are active or " +
        "upcoming; a group always uses its own linked trip",
    ),
});

export function createStravaRoutesTool(deps: StravaRoutesDeps) {
  return defineTool({
    description:
      "Real popular running/riding routes near the trip, ranked by how much locals actually " +
      "use them (Strava segment-explore data — no web search can give this). Set mine=true " +
      "for Bendik's own recent activities (distance/pace) instead, so suggestions fit his real " +
      "form. The model must NEVER invent a route, distance, or pace — only what this tool " +
      "returns. Unavailable when Strava isn't connected, or (for non-mine calls) when no trip " +
      "is linked to this chat.",
    inputSchema,
    async execute({ activity, radiusKm, mine, slug }, ctx) {
      if (mine) assertAdminDm(ctx.session.auth);
      const strava = deps.strava();
      if (!strava) return { error: "strava not connected" };
      try {
        if (mine) return await strava.recentActivities(10);
        const res = await deps.currentTrip(ctx.session.auth, slug);
        if (!res.ok) return { error: res.error };
        const trip = res.trip;
        const segs = await strava.segmentsNear(trip.destination.lat, trip.destination.lon, radiusKm, activity);
        return segs.slice(0, 10);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}

export default createStravaRoutesTool(defaultStravaRoutesDeps);
