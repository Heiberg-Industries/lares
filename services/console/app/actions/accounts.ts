"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { deleteToken } from "@lares/agent-box/lib/oauth-tokens.js";
import { pool } from "../../lib/db";
import { verify } from "../../lib/auth";
import { consolePrincipal } from "../../lib/accounts";

export interface RemoveAccountInput {
  email: string;
}

export async function removeAccount(input: RemoveAccountInput): Promise<void> {
  const sessionEmail = await verify((await cookies()).get("lares_session")?.value);
  if (!sessionEmail) throw new Error("unauthenticated");
  // Bind the principal server-side — never trust a client-supplied principal (avoids an IDOR where
  // one user could delete another principal's account). v1 is single-principal; when real
  // multi-user lands, resolve the principal from the authenticated session here.
  await deleteToken(pool, consolePrincipal(), "google", input.email);
  revalidatePath("/integrations");
}
