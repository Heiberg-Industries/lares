"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { verify } from "../../lib/auth";
import { markInboxRead } from "../../lib/web-inbox";

const AGENT = /^[a-z][a-z0-9-]{0,40}$/;

/** Mark one message, or all of an agent's unread messages, as read. */
export async function markRead(input: { agent: string; id?: number }): Promise<{ ok: boolean }> {
  if (!(await verify((await cookies()).get("lares_session")?.value))) throw new Error("unauthenticated");
  if (!AGENT.test(input.agent)) return { ok: false };
  if (input.id !== undefined && !Number.isSafeInteger(input.id)) return { ok: false };
  await markInboxRead(input.agent, input.id);
  revalidatePath(`/chat/${input.agent}`);
  return { ok: true };
}
