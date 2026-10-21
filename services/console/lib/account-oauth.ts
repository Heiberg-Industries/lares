/** Google data consent is separate from console sign-in, with its own callback and client. */
import * as oidc from "openid-client";
import { google } from "googleapis";
import { GOOGLE_SCOPES, googleOrgClientConfig } from "./accounts";
import { consoleRedirect } from "./console-oidc";
import { accountSessionHash, type AccountFlow } from "./account-oauth-state";
import type { AccountUpdate, TrustedAccountAdapter } from "@lares/agent-kit/account-store";

const ISSUER = "https://accounts.google.com";
export function consoleOrigin(): string { return new URL(consoleRedirect()).origin; }
export function accountRedirect(): string { return new URL("/api/accounts/google/callback", consoleOrigin()).href; }
export function callbackRedirect(origin: string, result: { added?: string; error?: string }): string {
  const url = new URL("/membership", origin);
  if (result.added) url.searchParams.set("added", result.added);
  if (result.error) url.searchParams.set("error", result.error);
  return url.href;
}
async function configuration(org: string, expectedClientId?: string) {
  const settings = googleOrgClientConfig(org);
  if (!settings || (expectedClientId && settings.clientId !== expectedClientId)) throw new Error("Consent configuration changed");
  const config = await oidc.discovery(new URL(ISSUER), settings.clientId, settings.clientSecret);
  oidc.enableNonRepudiationChecks(config);
  return { config, settings };
}
export async function startAccountConsent(args: { memberId: string; session: string; org: string; loginHint?: string; update?: AccountUpdate }) {
  const { config, settings } = await configuration(args.org);
  const common = { provider: "google" as const, memberId: args.memberId, sessionHash: accountSessionHash(args.session), org: args.org,
    clientId: settings.clientId, state: oidc.randomState(), nonce: oidc.randomNonce(), verifier: oidc.randomPKCECodeVerifier() };
  const flow: AccountFlow = args.update ? { ...common, intent: "reconnect", update: { ...args.update } } : { ...common, intent: "new" };
  const url = oidc.buildAuthorizationUrl(config, { redirect_uri: accountRedirect(), response_type: "code",
    scope: GOOGLE_SCOPES.join(" "), access_type: "offline", prompt: "consent", state: flow.state, nonce: flow.nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier), code_challenge_method: "S256",
    ...(args.loginHint ? { login_hint: args.loginHint } : {}) });
  return { flow, url };
}
/** All resources are read through the same verified grant. No provider email links a member. */
export async function finishAccountConsent(url: URL, flow: AccountFlow) {
  if (flow.provider !== "google") throw new Error("Consent provider refused");
  const { config, settings } = await configuration(flow.org, flow.clientId);
  const tokens = await oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: flow.verifier,
    expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims || claims.iss !== ISSUER || typeof claims.sub !== "string" || !claims.sub) throw new Error("Provider identity refused");
  if (!tokens.refresh_token || !tokens.access_token || typeof tokens.scope !== "string") throw new Error("Consent incomplete");
  const scopes = tokens.scope.split(/\s+/).filter(Boolean);
  if (GOOGLE_SCOPES.some(scope => !scopes.includes(scope))) throw new Error("Consent scopes incomplete");
  const auth = new google.auth.OAuth2(settings.clientId, settings.clientSecret, accountRedirect());
  auth.setCredentials({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
  const mailbox = await google.gmail({ version: "v1", auth }).users.getProfile({ userId: "me" });
  const calendar = await google.calendar({ version: "v3", auth }).calendarList.get({ calendarId: "primary" });
  const emailAddress = mailbox.data.emailAddress;
  if (!emailAddress || !calendar.data.id || calendar.data.primary !== true || calendar.data.accessRole !== "owner")
    throw new Error("Own resources could not be verified");
  const identity = Object.freeze({ issuer: ISSUER, subject: claims.sub, label: emailAddress });
  const resources = Object.freeze([
    Object.freeze({ resourceKind: "mailbox", externalId: claims.sub, providerLabel: emailAddress }),
    Object.freeze({ resourceKind: "calendar", externalId: calendar.data.id, providerLabel: calendar.data.summary || "Primary calendar" }),
  ]);
  // This adapter closes over provider-verified snapshots, never request/model-shaped evidence.
  const adapter: TrustedAccountAdapter = { connectorId: "google", verifyAccount: async () => identity,
    verifyResource: async (_account, index) => {
      if (index !== 0 && index !== 1) throw new Error("Resource evidence refused");
      return resources[index];
    } };
  return { adapter, material: Object.freeze({ orgId: flow.org, emailAddress, scopes: Object.freeze([...scopes]), refreshToken: tokens.refresh_token }) };
}
