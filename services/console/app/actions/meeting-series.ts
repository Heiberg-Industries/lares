"use server";
// Same @lares/agent-kit import path `app/actions/autonomy.ts` already uses.
import { PgRatchet } from "@lares/agent-kit/ratchet-store";
import { pool } from "../../lib/db";
import { actingAddress } from "../../lib/auth";

/** Revoking is setting the series back to `gated` — the same audited write as granting it. */
export async function revokeSeries(agent: string, seriesKey: string): Promise<void> {
  const email = await actingAddress("admin");
  if (!email) throw new Error("unauthenticated");
  await new PgRatchet(pool).setLevel(agent, "meeting_followup", "gated", seriesKey, email);
}
