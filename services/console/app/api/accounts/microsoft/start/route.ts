import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { PgAccountStore } from "@lares/agent-kit/account-store";
import { withConsoleAdmission } from "../../../../../lib/admission-error";
import { sessionMember } from "../../../../../lib/auth";
import { pool } from "../../../../../lib/db";
import { ACCOUNT_FLOW_COOKIE, ACCOUNT_FLOW_MAX_AGE, sealAccountFlow } from "../../../../../lib/account-oauth-state";
import { callbackRedirect, consoleOrigin } from "../../../../../lib/account-oauth";
import { microsoftDataSettings, startMicrosoftAccountConsent } from "../../../../../lib/microsoft-account-oauth";
import { personalConsentPower } from "@lares/agent-kit/personal-consent";
export const runtime = "nodejs";
async function handlePOST(req: Request): Promise<Response> {
  const jar = await cookies(), session = jar.get("lares_session")?.value;
  const member = await sessionMember(session);
  if (!member || !session) return new Response("Not authorised.", { status: 401 });
  const origin = consoleOrigin();
  const fail = () => {
    const response = NextResponse.redirect(callbackRedirect(origin, { error: "Microsoft consent could not start. Check the work data client and tenant consent requirements." }), { status: 303 });
    response.cookies.set(ACCOUNT_FLOW_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: origin.startsWith("https:"), path: "/api/accounts/microsoft", maxAge: 0 });
    return response;
  };
  try {
    const form = await req.formData(), intent = form.get("intent");
    if (form.has("agent") || (intent !== "new" && intent !== "reconnect")) return fail();
    const powers = form.getAll("power");
    if (powers.length > 1) return fail();
    const power = personalConsentPower(powers[0] ?? "read");
    let update;
    if (intent === "reconnect") {
      const id = form.get("accountId"), rawGeneration = form.get("generation");
      if (typeof id !== "string" || typeof rawGeneration !== "string" || !/^\d+$/.test(rawGeneration)) return fail();
      const store = new PgAccountStore(pool);
      update = await store.beginUpdate(member.id, id, Number(rawGeneration));
      const account = await store.read(member.id, id), settings = microsoftDataSettings();
      if (account.connectorId !== "microsoft" || account.providerAccount.issuer !== settings.issuer || account.providerAccount.tenantId !== settings.tenantId) return fail();
    }
    const { flow, url } = await startMicrosoftAccountConsent({ memberId: member.id, session, power, update });
    const response = NextResponse.redirect(url, { status: 303 });
    response.cookies.set(ACCOUNT_FLOW_COOKIE, await sealAccountFlow(flow), { httpOnly: true, sameSite: "lax",
      secure: origin.startsWith("https:"), path: "/api/accounts/microsoft", maxAge: ACCOUNT_FLOW_MAX_AGE });
    return response;
  } catch { return fail(); }
}
export const POST = withConsoleAdmission(handlePOST);
