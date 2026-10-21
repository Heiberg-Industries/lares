/** Console sign-in only: no mailbox/calendar scopes, token persistence or account consent. */
import * as oidc from "openid-client";
import { SignJWT, jwtVerify } from "jose";
import { providerIdentitySchema } from "@lares/agent-kit/authority-contract";
import type { VerifiedProviderProof } from "@lares/agent-kit/member-store";
import { readSecret } from "./secrets";
import { safeNext } from "./safe-next";

export type SignInProvider = "google" | "microsoft";
export interface SignInFlow { provider: SignInProvider; state: string; nonce: string; verifier: string; next: string; invitation?: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function required(name: string): string {
  const value = readSecret(name)?.trim();
  if (!value) throw new Error("Console sign-in is not configured");
  return value;
}
export function consoleRedirect(): string {
  const value = process.env.CONSOLE_OAUTH_REDIRECT ?? (process.env.NODE_ENV !== "production" ? "http://localhost:3000/api/auth/callback" : undefined);
  if (!value) throw new Error("Console public origin is not configured");
  const url = new URL(value);
  if ((process.env.NODE_ENV === "production" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/api/auth/callback") throw new Error("Invalid console redirect");
  return url.href;
}
export function providerSettings(provider: SignInProvider) {
  if (provider === "google") return { issuer: "https://accounts.google.com", clientId: required("GOOGLE_CLIENT_ID_CONSOLE"), secret: required("GOOGLE_CLIENT_SECRET_CONSOLE") };
  const tenantId = required("MICROSOFT_TENANT_ID_CONSOLE").toLowerCase();
  // Fixed organisational tenant, never common/organizations/consumers or the consumer tenant.
  if (!UUID.test(tenantId) || tenantId === "9188040d-6c67-4c5b-b112-36a304b66dad") throw new Error("A Microsoft work tenant is required");
  return { issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`, clientId: required("MICROSOFT_CLIENT_ID_CONSOLE"), secret: required("MICROSOFT_CLIENT_SECRET_CONSOLE"), tenantId };
}
async function configuration(provider: SignInProvider) {
  const settings = providerSettings(provider);
  const config = await oidc.discovery(new URL(settings.issuer), settings.clientId, settings.secret);
  // Explicitly enable the maintained library's JWS verification, including key rotation.
  oidc.enableNonRepudiationChecks(config);
  return config;
}
function flowKey(): Uint8Array { return new TextEncoder().encode(required("CONSOLE_SESSION_SECRET")); }
export async function sealFlow(flow: SignInFlow): Promise<string> {
  return new SignJWT({ ...flow }).setProtectedHeader({ alg: "HS256" }).setIssuer("lares-console-sign-in").setAudience("lares-console-callback").setIssuedAt().setExpirationTime("10m").sign(flowKey());
}
export async function openFlow(value: string | undefined): Promise<SignInFlow | null> {
  if (!value) return null;
  try {
    const { payload: p } = await jwtVerify(value, flowKey(), { algorithms: ["HS256"], issuer: "lares-console-sign-in", audience: "lares-console-callback" });
    if ((p.provider !== "google" && p.provider !== "microsoft") || typeof p.state !== "string" || typeof p.nonce !== "string" || typeof p.verifier !== "string" || typeof p.next !== "string" || (p.invitation !== undefined && (typeof p.invitation !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(p.invitation)))) return null;
    return { provider: p.provider, state: p.state, nonce: p.nonce, verifier: p.verifier, next: safeNext(p.next), ...(typeof p.invitation === "string" ? { invitation: p.invitation } : {}) };
  } catch { return null; }
}
export async function startSignIn(provider: SignInProvider, next: string, invitation?: string) {
  const config = await configuration(provider);
  const flow: SignInFlow = { provider, state: oidc.randomState(), nonce: oidc.randomNonce(), verifier: oidc.randomPKCECodeVerifier(), next: safeNext(next), ...(invitation ? { invitation } : {}) };
  const url = oidc.buildAuthorizationUrl(config, { redirect_uri: consoleRedirect(), response_type: "code", scope: "openid email", state: flow.state, nonce: flow.nonce, code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier), code_challenge_method: "S256", prompt: "select_account" });
  return { url, cookie: await sealFlow(flow) };
}
/** Only call with claims already validated by the maintained OIDC client. Exported to test
 * exact issuer/subject/tenant mapping; parsing untrusted claims is not verification. */
export function proofFromValidatedClaims(provider: SignInProvider, claims: Record<string, unknown>): VerifiedProviderProof {
  const settings = providerSettings(provider);
  if (claims.iss !== settings.issuer || typeof claims.sub !== "string" || !claims.sub) throw new Error("Provider identity refused");
  if (provider === "microsoft" && claims.tid !== settings.tenantId) throw new Error("Microsoft tenant refused");
  return { identity: providerIdentitySchema.parse({ issuer: claims.iss, subject: claims.sub, ...(provider === "microsoft" ? { tenantId: settings.tenantId } : {}) }), verifiedAt: new Date() };
}
export async function finishSignIn(url: URL, flow: SignInFlow): Promise<VerifiedProviderProof> {
  const config = await configuration(flow.provider);
  const tokens = await oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims) throw new Error("Provider identity missing");
  return proofFromValidatedClaims(flow.provider, claims);
}
