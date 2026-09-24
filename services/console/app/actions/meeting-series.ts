"use server";
import { cookies } from "next/headers";
// Same @lares/agent-kit import path `app/actions/autonomy.ts` already uses.
import { PgRatchet } from "@lares/agent-kit/ratchet-store";
import { pool } from "../../lib/db";
import { verify } from "../../lib/auth";

/** Revoking is setting the series back to `gated` — the same audited write as granting it. */
export async function revokeSeries(seriesKey: string): Promise<void> {
  const email = await verify((await cookies()).get("lares_session")?.value);
  if (!email) throw new Error("unauthenticated");
  await new PgRatchet(pool).setLevel("saga", "meeting_followup", "gated", seriesKey, email);
}
