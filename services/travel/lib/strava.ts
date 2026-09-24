// lib/strava.ts — Strava read-only client: popularity-ranked segments near the trip
// (where locals ACTUALLY run/ride — data no web search can give) + the athlete's own
// recent activities (so suggestions fit Bendik's real distance/pace).
// Ported verbatim from services/marcel/lib/strava.ts (Task 6) — no logic changes.
//
// GOTCHA: Strava ROTATES the refresh token on every refresh — the new one must be
// persisted or access is lost at the next restart. `saveTokens` is not optional.

export interface StravaSegment {
  id: number;
  name: string;
  distanceKm: number;
  avgGradePct: number;
  elevationGainM: number;
  climbCategory: number;
  lat: number;
  lon: number;
  stravaUrl: string;
}

export interface StravaActivity {
  name: string;
  type: string;
  distanceKm: number;
  movingMinutes: number;
  paceMinPerKm?: number;
  startDate: string;
}

export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix seconds
}

export interface StravaDeps {
  clientId: string;
  clientSecret: string;
  loadTokens(): StravaTokens;
  saveTokens(t: StravaTokens): void;
  now(): number; // unix seconds
  fetch?: typeof globalThis.fetch;
}

const API = "https://www.strava.com/api/v3";
const TOKEN_URL = "https://www.strava.com/oauth/token";

/** A bounding box around a centre point — Strava's explore endpoint takes SW/NE corners. */
export function boundsAround(lat: number, lon: number, radiusKm: number): string {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((n) => n.toFixed(4)).join(",");
}

export function makeStrava(deps: StravaDeps) {
  const fetchFn = deps.fetch ?? globalThis.fetch;

  async function accessToken(): Promise<string> {
    const tokens = deps.loadTokens();
    if (tokens.expiresAt > deps.now() + 60) return tokens.accessToken;

    const res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      }),
    });
    if (!res.ok) throw new Error(`strava token refresh failed: ${res.status}`);
    const data = (await res.json()) as { access_token: string; refresh_token: string; expires_at: number };
    const next: StravaTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token, // ROTATED — persist or lose access
      expiresAt: data.expires_at,
    };
    deps.saveTokens(next);
    return next.accessToken;
  }

  async function get<T>(path: string): Promise<T> {
    const token = await accessToken();
    const res = await fetchFn(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`strava ${path}: ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    /** Popular running/riding segments near a point, best-known first (Strava's own ranking). */
    async segmentsNear(lat: number, lon: number, radiusKm: number, activityType: "running" | "riding"): Promise<StravaSegment[]> {
      const raw = await get<{
        segments?: Array<{
          id: number;
          name: string;
          distance: number;
          avg_grade: number;
          elev_difference: number;
          climb_category: number;
          start_latlng: [number, number];
        }>;
      }>(`/segments/explore?bounds=${boundsAround(lat, lon, radiusKm)}&activity_type=${activityType}`);

      return (raw.segments ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        distanceKm: Math.round((s.distance / 1000) * 10) / 10,
        avgGradePct: Math.round(s.avg_grade * 10) / 10,
        elevationGainM: Math.round(s.elev_difference),
        climbCategory: s.climb_category,
        lat: s.start_latlng?.[0] ?? lat,
        lon: s.start_latlng?.[1] ?? lon,
        stravaUrl: `https://www.strava.com/segments/${s.id}`,
      }));
    },

    /** The athlete's own recent activities — the taste signal ("what does Bendik actually run?"). */
    async recentActivities(count: number): Promise<StravaActivity[]> {
      const raw = await get<
        Array<{ name: string; type: string; distance: number; moving_time: number; start_date_local: string }>
      >(`/athlete/activities?per_page=${Math.min(count, 30)}`);

      return raw.map((a) => {
        const distanceKm = Math.round((a.distance / 1000) * 10) / 10;
        const movingMinutes = Math.round(a.moving_time / 60);
        return {
          name: a.name,
          type: a.type,
          distanceKm,
          movingMinutes,
          paceMinPerKm: distanceKm > 0 ? Math.round((movingMinutes / distanceKm) * 10) / 10 : undefined,
          startDate: a.start_date_local?.slice(0, 10) ?? "",
        };
      });
    },
  };
}

export type Strava = ReturnType<typeof makeStrava>;
