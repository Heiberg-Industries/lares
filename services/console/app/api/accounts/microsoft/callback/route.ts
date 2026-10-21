import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { currentSession } from "@lares/agent-kit/member-store";
import { PgAccountStore } from "@lares/agent-kit/account-store";
import { writeVerifiedAccountToken } from "@lares/agent-box/lib/oauth-tokens.js";
import { ConsoleAdmissionUnavailableError, withConsoleAdmission } from "../../../../../lib/admission-error";
import { pool } from "../../../../../lib/db";
import { sessionMember } from "../../../../../lib/auth";
import { tokenEncKeyHex } from "../../../../../lib/accounts";
import { ACCOUNT_FLOW_COOKIE, accountSessionHash, openAccountFlow } from "../../../../../lib/account-oauth-state";
import { callbackRedirect, consoleOrigin } from "../../../../../lib/account-oauth";
import { microsoftDataSettings, MICROSOFT_DATA_ORG, microsoftAccountRedirect, finishMicrosoftAccountConsent } from "../../../../../lib/microsoft-account-oauth";
export const runtime = "nodejs";
async function handleGET(req: Request): Promise<Response> {
  const jar = await cookies(), origin = consoleOrigin();
  const terminal = (result: { added?: string; error?: string }) => {
    const response = NextResponse.redirect(callbackRedirect(origin, result), { status: 303 });
    response.cookies.set(ACCOUNT_FLOW_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: origin.startsWith("https:"), path: "/api/accounts/microsoft", maxAge: 0 });
    return response;
  };
  const fail = () => terminal({ error: "Microsoft consent could not be saved. Start again from Your membership." });
  // Clear terminally even when admission is refused or its backing store is unavailable.
  try {
    const session = jar.get("lares_session")?.value;
    const member = await sessionMember(session);
    const flow = await openAccountFlow(jar.get(ACCOUNT_FLOW_COOKIE)?.value);
    const supplied = new URL(req.url);
    if (!session || !member || !flow || flow.provider !== "microsoft" || flow.memberId !== member.id || flow.sessionHash !== accountSessionHash(session)
      || supplied.searchParams.has("error") || !supplied.searchParams.get("code") || supplied.searchParams.get("state") !== flow.state
      || flow.org !== MICROSOFT_DATA_ORG || microsoftDataSettings().clientId !== flow.clientId || microsoftDataSettings().tenantId !== flow.tenantId) return fail();
    const store = new PgAccountStore(pool);
    if (flow.intent === "reconnect") {
      const current = await store.beginUpdate(member.id, flow.update.accountId, flow.update.generation);
      if (current.lifecycleRevision !== flow.update.lifecycleRevision) return fail();
    }
    const callback = new URL(microsoftAccountRedirect());
    callback.search = supplied.search;
    const verified = await finishMicrosoftAccountConsent(callback, flow);
    const adapter = store.forTrustedAdapter(verified.adapter);
    const key = tokenEncKeyHex();
    const credential = { persist: async (db: Parameters<typeof writeVerifiedAccountToken>[0], context: Parameters<typeof writeVerifiedAccountToken>[1]) => {
      // Recheck this exact console session in the account/token transaction after provider work.
      // Holding its shared lock through commit serializes the save with concurrent logout.
      if (!await currentSession(db, session, member.id, { lock: "share" })) throw new Error("Consent session unavailable");
      return writeVerifiedAccountToken(db, context, key, { ...verified.material, scopes: [...verified.material.scopes] });
    } };
    if (flow.intent === "reconnect") await adapter.renew(member.id, flow.update, null, credential, [0, 1]);
    else await adapter.createPersonalAccount(member.id, null, credential, [0, 1]);
    return terminal({ added: "Microsoft consent saved. Agent use is pending integration." });
  } catch (error) {
    if (error instanceof ConsoleAdmissionUnavailableError) {
      const response = NextResponse.json({ error: "admission-unavailable", message: error.message }, { status: 503, headers: { "cache-control": "no-store" } });
      response.cookies.set(ACCOUNT_FLOW_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: origin.startsWith("https:"), path: "/api/accounts/microsoft", maxAge: 0 });
      return response;
    }
    return fail();
  }
}
export const GET = withConsoleAdmission(handleGET);
