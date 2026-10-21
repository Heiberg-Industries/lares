"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { PgAccountStore } from "@lares/agent-kit/account-store";
import { deleteToken } from "@lares/agent-box/lib/oauth-tokens.js";
import { pool } from "../../lib/db";
import { sessionMember, isConsoleOwner } from "../../lib/auth";
import { consolePrincipal } from "../../lib/accounts";
export type RemoveAccountInput = { accountId: string; generation: number } | { email: string };
export async function removeAccount(input: RemoveAccountInput): Promise<void> {
  const member = await sessionMember((await cookies()).get("lares_session")?.value);
  if (!member) throw new Error("unauthenticated");
  try {
    if ("accountId" in input) {
      if (Object.keys(input).sort().join(",") !== "accountId,generation" || typeof input.accountId !== "string"
        || !Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error();
      const store = new PgAccountStore(pool);
      const ticket = await store.beginUpdate(member.id, input.accountId, input.generation);
      await store.setStatus(member.id, ticket, "revoked");
    } else {
      if (!isConsoleOwner(member) || Object.keys(input).join(",") !== "email" || typeof input.email !== "string" || !input.email) throw new Error();
      await deleteToken(pool, consolePrincipal(), "google", input.email);
    }
  } catch { throw new Error("Account could not be disconnected. Refresh the page and try again."); }
  revalidatePath("/membership");
  revalidatePath("/integrations");
}
