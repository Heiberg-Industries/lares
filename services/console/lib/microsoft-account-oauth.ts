/** Work-account DATA consent only; never a console sign-in proof or a runtime client cache. */
import * as oidc from "openid-client";
import { Client, AuthenticationHandler, HTTPMessageHandler, GraphError } from "@microsoft/microsoft-graph-client";
import type { User, Calendar, MailFolder } from "@microsoft/microsoft-graph-types";
import type { AccountUpdate, TrustedAccountAdapter } from "@lares/agent-kit/account-store";
import { readSecret } from "./secrets";
import { consoleOrigin } from "./account-oauth";
import { accountSessionHash, type AccountFlow } from "./account-oauth-state";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
/** One server-owned client alias in this bounded slice. It is never a member organisation. */
export const MICROSOFT_DATA_ORG = "microsoft";
export const MICROSOFT_DATA_SCOPES = ["openid", "offline_access", "User.Read", "Mail.Read", "Calendars.Read"] as const;
export class MicrosoftConsentReadError extends Error {
  constructor(readonly kind: "timeout" | "denied" | "rate-limited" | "unavailable") { super(`Microsoft consent resource verification ${kind}`); }
}
const DATA_SCOPES = ["User.Read", "Mail.Read", "Calendars.Read"] as const;
export function microsoftDataSettings() {
  const tenantId = readSecret("MICROSOFT_TENANT_ID_DATA")?.trim().toLowerCase();
  const clientId = readSecret("MICROSOFT_CLIENT_ID_DATA")?.trim();
  const clientSecret = readSecret("MICROSOFT_CLIENT_SECRET_DATA")?.trim();
  if (!tenantId || !UUID.test(tenantId) || tenantId === CONSUMER_TENANT || !clientId || !clientSecret) throw new Error("Microsoft work data consent is not configured");
  return { tenantId, clientId, clientSecret, issuer: `https://login.microsoftonline.com/${tenantId}/v2.0` };
}
export function microsoftAccountRedirect(): string { return new URL("/api/accounts/microsoft/callback", consoleOrigin()).href; }
async function configuration(flow?: AccountFlow) {
  const settings = microsoftDataSettings();
  if (flow && (flow.provider !== "microsoft" || flow.tenantId !== settings.tenantId || flow.clientId !== settings.clientId || flow.org !== MICROSOFT_DATA_ORG)) throw new Error("Consent configuration changed");
  const config = await oidc.discovery(new URL(settings.issuer), settings.clientId, settings.clientSecret);
  oidc.enableNonRepudiationChecks(config);
  return { config, settings };
}
export async function startMicrosoftAccountConsent(args: { memberId: string; session: string; update?: AccountUpdate }) {
  const { config, settings } = await configuration();
  const common = { provider: "microsoft" as const, tenantId: settings.tenantId, org: MICROSOFT_DATA_ORG,
    memberId: args.memberId, sessionHash: accountSessionHash(args.session), clientId: settings.clientId,
    state: oidc.randomState(), nonce: oidc.randomNonce(), verifier: oidc.randomPKCECodeVerifier() };
  const flow: AccountFlow = args.update ? { ...common, intent: "reconnect", update: { ...args.update } } : { ...common, intent: "new" };
  const url = oidc.buildAuthorizationUrl(config, { redirect_uri: microsoftAccountRedirect(), response_type: "code",
    scope: MICROSOFT_DATA_SCOPES.join(" "), prompt: "consent", state: flow.state, nonce: flow.nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier), code_challenge_method: "S256" });
  return { flow, url };
}
/** All three fixed /me paths use one delegated access token. No owner email proves ownership. */
export async function finishMicrosoftAccountConsent(url: URL, flow: AccountFlow) {
  const { config, settings } = await configuration(flow);
  const tokens = await oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: flow.verifier,
    expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims || claims.iss !== settings.issuer || claims.tid !== settings.tenantId || typeof claims.oid !== "string" || !UUID.test(claims.oid)
    || claims.idp === "live.com" || claims.idp === `https://sts.windows.net/${CONSUMER_TENANT}/`) throw new Error("Microsoft work identity refused");
  if (!tokens.refresh_token || !tokens.access_token || typeof tokens.scope !== "string") throw new Error("Consent incomplete");
  const scopes = tokens.scope.split(/\s+/).filter(Boolean);
  const granted = scopes.map(scope => scope.replace(/^https:\/\/graph\.microsoft\.com\//, ""));
  if (DATA_SCOPES.some(scope => !granted.includes(scope)) || granted.some(scope => ![...MICROSOFT_DATA_SCOPES, "profile", "email"].includes(scope))) throw new Error("Consent scopes incomplete");
  const accessToken = tokens.access_token;
  // Keep the official SDK's authentication and transport, excluding telemetry, retries and
  // redirect middleware. Consent verification is bounded and never follows a provider redirect.
  const client = Client.initWithMiddleware({ middleware: [new AuthenticationHandler({ getAccessToken: async () => accessToken }), new HTTPMessageHandler()] });
  const signal = AbortSignal.timeout(15_000);
  async function own<T>(path: "/me" | "/me/mailFolders/inbox" | "/me/calendar", select: string): Promise<T> {
    try { return await client.api(path).option("signal", signal).option("redirect", "error").select(select).get() as T; }
    catch (error) {
      const status = error instanceof GraphError ? error.statusCode : undefined;
      throw new MicrosoftConsentReadError(signal.aborted ? "timeout" : status === 401 || status === 403 ? "denied" : status === 429 ? "rate-limited" : "unavailable");
    }
  }
  const me = await own<User>("/me", "id,mail,userPrincipalName,userType");
  if (me.id !== claims.oid || me.userType !== "Member") throw new Error("Microsoft own work account refused");
  const mailbox = await own<MailFolder>("/me/mailFolders/inbox", "id");
  const calendar = await own<Calendar>("/me/calendar", "id,name,isDefaultCalendar");
  if (typeof mailbox.id !== "string" || !mailbox.id || typeof calendar.id !== "string" || !calendar.id || calendar.isDefaultCalendar !== true) throw new Error("Own resources could not be verified");
  const label = me.mail || me.userPrincipalName || "Microsoft work account";
  if (typeof label !== "string" || !label.trim()) throw new Error("Account label unavailable");
  const identity = Object.freeze({ issuer: settings.issuer, tenantId: settings.tenantId, subject: claims.oid, label });
  const resources = Object.freeze([
    Object.freeze({ resourceKind: "mailbox", externalId: claims.oid, providerLabel: label }),
    Object.freeze({ resourceKind: "calendar", externalId: calendar.id, providerLabel: calendar.name || "Primary calendar" }),
  ]);
  const adapter: TrustedAccountAdapter = { connectorId: "microsoft", verifyAccount: async () => identity,
    verifyResource: async (_account, index) => {
      if (index !== 0 && index !== 1) throw new Error("Resource evidence refused");
      return resources[index];
    } };
  return { adapter, material: Object.freeze({ orgId: MICROSOFT_DATA_ORG, emailAddress: label,
    scopes: Object.freeze([...scopes]), refreshToken: tokens.refresh_token }) };
}
