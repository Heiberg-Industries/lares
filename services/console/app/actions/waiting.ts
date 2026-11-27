"use server";
/**
 * The Waiting on you page's one write: answer an item. Every decision lives in `lib/waiting.ts`;
 * this file only supplies the signed-in member. An unauthenticated caller throws, as every console
 * action does; anything else comes back as a `DecideResult` the page says out loud.
 */
import { revalidatePath } from "next/cache";
import { actingAddress } from "../../lib/auth";
import { checkWaiting, decideWaiting, type DecideResult } from "../../lib/waiting";
import { waitingDeps } from "../../lib/waiting-deps";

export async function decide(input: { id: string; actionId: string }): Promise<DecideResult> {
  const member = await actingAddress("admin");
  if (!member) throw new Error("unauthenticated");
  if (typeof input?.id !== "string" || typeof input?.actionId !== "string") {
    return { ok: false, reason: "gone", message: "That item could not be found." };
  }
  const result = await decideWaiting(member, input.id, input.actionId, waitingDeps);
  revalidatePath("/reviews");
  return result;
}

/** Reads again what came of an answer the agent had not confirmed yet. Sends nothing; the page asks every few
 *  seconds until the answer is confirmed or the action failed. */
export async function checkDecision(input: { id: string; callId?: string }): Promise<DecideResult> {
  const member = await actingAddress("admin");
  if (!member) throw new Error("unauthenticated");
  if (typeof input?.id !== "string") return { ok: false, reason: "gone", message: "That item could not be found." };
  return checkWaiting(member, input.id, waitingDeps, typeof input.callId === "string" ? { callId: input.callId } : {});
}
