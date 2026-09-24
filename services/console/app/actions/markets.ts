"use server";
/**
 * ORB-214 — the two knobs `market-refresh` reads: the refresh switch and the watchlist ceiling.
 *
 * `saveWatchlistMax` may only set a value between 10 (the schema's floor) and
 * `MARKETS_ENGINE.watchlistMax` (150, mirroring `services/chief-of-staff/lib/markets-settings-store.ts`
 * — see that file's own header for why the console does not import it). A value above the max is
 * refused by name rather than stored and silently clamped on read, the same asymmetry
 * `lib/proactivity.ts`'s header documents for the ceilings.
 */
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { pool } from "../../lib/db";
import { verify } from "../../lib/auth";
import { ownerId } from "../../lib/proactivity";
import { MARKETS_ENGINE } from "../../lib/markets";

export type ActionResult = { ok: true } | { ok: false; message: string };

async function requireUser(): Promise<string> {
  const email = await verify((await cookies()).get("lares_session")?.value);
  if (!email) throw new Error("unauthenticated");
  return email;
}

export async function saveRefreshEnabled(input: { enabled: boolean }): Promise<ActionResult> {
  const email = await requireUser();
  if (typeof input.enabled !== "boolean") return { ok: false, message: "Refresh must be on or off." };
  const owner = ownerId();
  await pool.query(
    `INSERT INTO markets_settings (owner, refresh_enabled, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (owner) DO UPDATE SET refresh_enabled = EXCLUDED.refresh_enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [owner, input.enabled, email],
  );
  revalidatePath("/markets");
  return { ok: true };
}

export async function saveWatchlistMax(input: { value: number }): Promise<ActionResult> {
  const email = await requireUser();
  if (!Number.isInteger(input.value)) return { ok: false, message: "Watchlist size must be a whole number." };
  if (input.value > MARKETS_ENGINE.watchlistMax) {
    return { ok: false, message: `Watchlist size cannot be raised above the engine maximum of ${MARKETS_ENGINE.watchlistMax}.` };
  }
  if (input.value < 10) return { ok: false, message: "Watchlist size must be at least 10." };
  const owner = ownerId();
  await pool.query(
    `INSERT INTO markets_settings (owner, watchlist_max, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (owner) DO UPDATE SET watchlist_max = EXCLUDED.watchlist_max, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [owner, input.value, email],
  );
  revalidatePath("/markets");
  return { ok: true };
}
