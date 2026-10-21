import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { PgAccountStore } from "@lares/agent-kit/account-store";
import { withConsoleAdmission } from "../../../../../lib/admission-error";
import { sessionMember } from "../../../../../lib/auth";
import { pool } from "../../../../../lib/db";
import { googleOrgClientConfig, googleOrgs, orgDomains, resolveOrgForEmail } from "../../../../../lib/accounts";
import { ACCOUNT_FLOW_COOKIE, ACCOUNT_FLOW_MAX_AGE, sealAccountFlow } from "../../../../../lib/account-oauth-state";
import { startAccountConsent, callbackRedirect, consoleOrigin } from "../../../../../lib/account-oauth";
import { personalConsentPower } from "@lares/agent-kit/personal-consent";
export const runtime = "nodejs";
async function handlePOST(req: Request): Promise<Response> {
  const jar = await cookies();
  const session = jar.get("lares_session")?.value;
  const member = await sessionMember(session);
  if (!member || !session) return new Response("Not authorised.", { status: 401 });
  const origin = consoleOrigin();
  const fail = () => {
    const response = NextResponse.redirect(callbackRedirect(origin, { error: "Account consent could not start. Please try again." }), { status: 303 });
    response.cookies.set(ACCOUNT_FLOW_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: origin.startsWith("https:"), path: "/api/accounts/google", maxAge: 0 });
    return response;
  };
  try {
    const form = await req.formData();
    if (form.has("agent")) {
      const response = new Response("Agent mailbox connection requires the account-aware runtime adapter. Manage personal accounts on /membership.", { status: 409 });
      // Overwriting/clearing the sole flow cookie prevents an earlier flow surviving this start.
      response.headers.append("Set-Cookie", `${ACCOUNT_FLOW_COOKIE}=; Path=/api/accounts/google; HttpOnly; SameSite=Lax; Max-Age=0${origin.startsWith("https:") ? "; Secure" : ""}`);
      return response;
    }
    const intent = form.get("intent");
    if (intent !== "new" && intent !== "reconnect") return fail();
    const powers = form.getAll("power");
    if (powers.length > 1) return fail();
    const power = personalConsentPower(powers[0] ?? "read");
    let org: string;
    let update;
    const store = new PgAccountStore(pool);
    if (intent === "reconnect") {
      const id = form.get("accountId"), rawGeneration = form.get("generation");
      if (typeof id !== "string" || typeof rawGeneration !== "string" || !/^\d+$/.test(rawGeneration)) return fail();
      update = await store.beginUpdate(member.id, id, Number(rawGeneration));
      const account = await store.read(member.id, id);
      if (account.connectorId !== "google") return fail();
      // Read the configured client from this account's exact custody, never a request address.
      const result = await pool.query<{ org_id: string }>(`SELECT t.org_id FROM connected_account_credentials c
        JOIN oauth_tokens t ON t.id=c.oauth_token_id WHERE c.account_id=$1 AND c.owner_member_id=$2 AND c.connector_id='google'`, [id, member.id]);
      if (!result.rows[0]) return fail();
      org = result.rows[0].org_id;
    } else {
      const mailbox = form.get("email");
      if (typeof mailbox !== "string") return fail();
      const resolved = resolveOrgForEmail(mailbox, googleOrgs().map(value => value.id), orgDomains(), process.env.GOOGLE_DEFAULT_ORG);
      if ("error" in resolved) return fail();
      org = resolved.org;
    }
    if (!googleOrgClientConfig(org)) return fail();
    const { flow, url } = await startAccountConsent({ memberId: member.id, session, org, power, update,
      ...(intent === "new" ? { loginHint: String(form.get("email")).trim() } : {}) });
    const response = NextResponse.redirect(url, { status: 303 });
    response.cookies.set(ACCOUNT_FLOW_COOKIE, await sealAccountFlow(flow), { httpOnly: true, sameSite: "lax",
      secure: origin.startsWith("https:"), path: "/api/accounts/google", maxAge: ACCOUNT_FLOW_MAX_AGE });
    return response;
  } catch { return fail(); }
}
export const POST = withConsoleAdmission(handlePOST);
