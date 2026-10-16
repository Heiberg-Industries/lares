"use server";
/**
 * The Waiting on you page's one write: answer an item. Every decision lives in `lib/waiting.ts`;
 * this file only supplies the signed-in member. An unauthenticated caller throws, as every console
 * action does; anything else comes back as a `DecideResult` the page says out loud.
 */
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { verify } from "../../lib/auth";
import { decideWaiting, type DecideResult } from "../../lib/waiting";
import { waitingDeps } from "../../lib/waiting-deps";

export async function decide(input: { id: string; actionId: string }): Promise<DecideResult> {
  const member = await verify((await cookies()).get("lares_session")?.value);
  if (!member) throw new Error("unauthenticated");
  if (typeof input?.id !== "string" || typeof input?.actionId !== "string") {
    return { ok: false, reason: "gone", message: "That item could not be found." };
  }
  const result = await decideWaiting(member, input.id, input.actionId, waitingDeps);
  revalidatePath("/waiting");
  return result;
}
