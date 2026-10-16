import {keeper} from '../../../../../lib/keeper-client';
/**
 * GET /api/accounts/google/callback — finish the add-Google-account flow.
 * Session-gated. Verifies the signed state, exchanges the code for tokens, reads the connected
 * mailbox from Google (gmail.users.getProfile — covered by gmail.readonly), and stores the
 * encrypted refresh token via @lares/agent-box (same TOKEN_ENC_KEY the runtime decrypts with).
 * Always redirects back to /integrations with ?added= or ?error=.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { google } from "googleapis";
import { storeToken } from "@lares/agent-box/lib/oauth-tokens.js";
import { pool } from "../../../../../lib/db";
import { verify } from "../../../../../lib/auth";
import { googleOrgClientConfig, tokenEncKeyHex } from "../../../../../lib/accounts";
import { verifyAccountState } from "../../../../../lib/account-oauth-state";
import { callbackRedirect, consoleOrigin } from "../../../../../lib/account-oauth";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = consoleOrigin(); // configured external origin (not req.url — proxy leaks container host)
  const fail = (msg: string) => NextResponse.redirect(callbackRedirect(origin, { error: msg }), { status: 303 });

  const sessionEmail = await verify((await cookies()).get("lares_session")?.value);
  if (!sessionEmail) return new Response("Not authorised.", { status: 401 });

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  if (oauthError) return fail(`Google returned: ${oauthError}`);
  if (!code || !state) return fail("Missing code or state.");

  const sc = verifyAccountState(state);
  if (!sc.ok) return fail(`Invalid or expired state (${sc.reason}).`);
  const { org, principal } = sc.data;
  // Bind the state to the session that started the flow — reject a state minted for another user.
  if (sc.data.email !== sessionEmail) return fail("State does not match this session.");

  if(sc.data.agent) {
    if(!process.env.CONSOLE_PRINCIPAL_ID||principal!==process.env.CONSOLE_PRINCIPAL_ID)return fail('Agent Google principal configuration changed.');
    const {rows}=await pool.query("SELECT 1 FROM agent_resources WHERE name=$1 AND ownership_token=$2::uuid AND runtime_control_token=ownership_token AND state='ready'",[sc.data.agent,sc.data.incarnation]);
    if(!rows.length)return fail('Agent changed during Google consent; start again.');
  }
  const cfg = googleOrgClientConfig(org);
  if (!cfg) return fail(`OAuth client not configured for org '${org}'.`);

  const redirectUri = `${origin}/api/accounts/google/callback`;
  const oauth = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, redirectUri);

  let refreshToken: string;
  let scopes: string[];
  let emailAddress: string;
  try {
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) {
      return fail("Google returned no refresh token — revoke prior access at myaccount.google.com/permissions and retry.");
    }
    refreshToken = tokens.refresh_token;
    scopes = (tokens.scope ?? "").split(" ").filter(Boolean);
    oauth.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth: oauth });
    const prof = await gmail.users.getProfile({ userId: "me" });
    emailAddress = prof.data.emailAddress ?? "";
    if (!emailAddress) return fail("Could not read the connected mailbox address from Google.");
  } catch (err) {
    return fail(`Token exchange failed: ${(err as Error).message}`);
  }

  if (sc.data.agent && emailAddress.toLowerCase() !== sc.data.mailbox?.toLowerCase()) {
    return fail('Google returned a different mailbox than the one selected for this agent. Start again with the selected mailbox.');
  }

  try {
    await storeToken(pool, tokenEncKeyHex(), {
      principal, provider: "google", orgId: org, emailAddress, scopes, refreshToken,
    });
  } catch (err) {
    return fail(`Could not store the account: ${(err as Error).message}`);
  }

  if(sc.data.agent) {
    try {await keeper('email.connect',{name:sc.data.agent,incarnation:sc.data.incarnation,principal,org,mailbox:emailAddress},sessionEmail);}
    catch {return fail('Google account saved, but agent connection may be pending or incomplete. Inspect the agent before retrying.');}
    return NextResponse.redirect(new URL(`/agents/${encodeURIComponent(sc.data.agent)}/edit?email=connected-pending-apply`,origin),{status:303});
  }
  return NextResponse.redirect(callbackRedirect(origin, { added: emailAddress }), { status: 303 });
}
