import {pool} from '../../../../../lib/db';
/**
 * POST /api/accounts/google/start — begin the add-Google-account flow.
 * Session-gated (lares_session). Reads the mailbox `email` from the form, resolves which
 * discovered Google client owns its domain, signs a short-lived state, and 303-redirects to
 * that org's OAuth consent screen with the address as a login hint.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verify } from "../../../../../lib/auth";
import { googleOrgClientConfig, googleOrgs, orgDomains, resolveOrgForEmail, consolePrincipal } from "../../../../../lib/accounts";
import { signAccountState } from "../../../../../lib/account-oauth-state";
import { buildConsentUrl, callbackRedirect, consoleOrigin } from "../../../../../lib/account-oauth";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const origin = consoleOrigin();
  const email = await verify((await cookies()).get("lares_session")?.value);
  if (!email) return new Response("Not authorised.", { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.redirect(callbackRedirect(origin, { error: "Invalid form." }), { status: 303 });
  }
  const mailbox = (form.get("email") ?? "").toString().trim();
  const resolved = resolveOrgForEmail(
    mailbox,
    googleOrgs().map((o) => o.id),
    orgDomains(),
    process.env.GOOGLE_DEFAULT_ORG,
  );
  if ("error" in resolved) {
    return NextResponse.redirect(callbackRedirect(origin, { error: resolved.error }), { status: 303 });
  }
  const org = resolved.org;
  const cfg = googleOrgClientConfig(org);
  if (!cfg) {
    return NextResponse.redirect(
      callbackRedirect(origin, { error: `OAuth client not configured for org '${org}'.` }),
      { status: 303 },
    );
  }

  const redirectUri = `${origin}/api/accounts/google/callback`;
  // Bind the authenticated owner separately from the mailbox selected for a managed agent.
  const agent=form.get('agent')?.toString();
  let binding:{agent:string;incarnation:string;mailbox:string}|undefined;
  let principal=consolePrincipal();
  if(agent) {
    if(!/^[a-z][a-z0-9-]{1,30}$/.test(agent)||!process.env.CONSOLE_PRINCIPAL_ID) return new Response('Configure the explicit Google principal before connecting an agent mailbox.',{status:400});
    const {rows}=await pool.query(`SELECT r.ownership_token FROM agent_resources r JOIN agent_definitions d ON d.name=r.name WHERE r.name=$1 AND r.runtime_control_token=r.ownership_token AND r.state='ready' AND d.status='valid' AND d.definition->>'role'='chief-of-staff'`,[agent]);
    if(!rows[0])return new Response('Agent mailbox setup is unavailable.',{status:400});
    binding={agent,incarnation:rows[0].ownership_token,mailbox};principal=process.env.CONSOLE_PRINCIPAL_ID;
  }
  const state = signAccountState({ org, principal, email,...binding });
  const consentUrl = buildConsentUrl({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri,
    state,
    loginHint: mailbox,
  });
  return NextResponse.redirect(consentUrl, { status: 303 });
}
