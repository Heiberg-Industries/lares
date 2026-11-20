// Standard MCP sign-in (OAuth 2.1 authorization code + PKCE) for an outside tool. Pure code: no
// storage, no environment, no module-scope work. Every network call goes through the `fetch` the caller
// passes in (the keeper passes one that rides its egress route), so this file decides WHAT is asked and
// checked, never WHERE it is sent from. Custody of the tokens is the caller's job.
//
// Spec: MCP authorization 2026-07-28; RFC 9728 (resource metadata), RFC 8414 / OpenID discovery,
// RFC 7591 (dynamic registration), RFC 7636 (PKCE S256), RFC 8707 (`resource` on authorize AND token
// calls), RFC 9207 (`iss` on the authorization response).
//
// Why hand-written: the AI SDK's MCP package does the same job but runs it as one provider-driven
// `auth()` call, accepts an authorization response with NO `iss` even when the server says it sends one,
// and offers no seam for our own checks or for keeping tokens out of its provider storage.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { checkOutsideUrl } from "./outside-tools.js";

export type McpOAuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type McpOAuthErrorKind =
  | "unsafe-url" // an address the flow would call is not allowed
  | "not-oauth" // the server did not answer 401 with sign-in metadata
  | "discovery-failed" // a metadata document could not be read
  | "metadata-invalid" // a metadata document is malformed or inconsistent
  | "resource-mismatch" // the metadata is for a different resource than the one being connected
  | "issuer-mismatch" // the issuer on a document or on the authorization response is not the expected one
  | "missing-issuer" // the server promises `iss` on the response and it is absent
  | "no-pkce" // the sign-in server does not offer S256
  | "no-registration" // no registration endpoint and no pasted client
  | "registration-failed"
  | "state-mismatch"
  | "expired-attempt"
  | "denied" // the person refused, or the server returned an error to the redirect
  | "exchange-failed"
  | "refresh-failed" // transient: try again later
  | "needs-sign-in" // the grant is dead (invalid_grant, no refresh token): the person must sign in again
  | "insufficient-scope";

export class McpOAuthError extends Error {
  constructor(readonly kind: McpOAuthErrorKind, message: string, readonly detail?: { scope?: string }) {
    super(message);
    this.name = "McpOAuthError";
  }
}

export interface McpOAuthOptions {
  fetch: McpOAuthFetch;
  /** Tests only: allow http and local addresses. Never set by production callers. */
  allowInsecure?: boolean;
  now?: () => number;
  timeoutMs?: number;
}

const MAX_BODY = 256 * 1024;
const PROTOCOL_VERSION = "2025-06-18";

// ---- small helpers ------------------------------------------------------------------------------

const b64url = (b: Buffer) => b.toString("base64url");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Resource identifiers compare without fragment and trailing slash. */
function canonical(value: string): string {
  const u = new URL(value);
  u.hash = "";
  return u.href.replace(/\/$/, "");
}

function checkUrl(value: string, what: string, o: McpOAuthOptions): URL {
  if (o.allowInsecure) {
    let u: URL;
    try { u = new URL(value); } catch { throw new McpOAuthError("unsafe-url", `${what} is not a valid address`); }
    if (u.username || u.password || u.hash || (u.protocol !== "https:" && u.protocol !== "http:")) {
      throw new McpOAuthError("unsafe-url", `${what} is not an allowed address`);
    }
    return u;
  }
  const c = checkOutsideUrl(value);
  if (!c.ok || c.scheme !== "https") {
    throw new McpOAuthError("unsafe-url", `${what} is not allowed: ${c.ok ? "it must use https" : c.reason}`);
  }
  return new URL(value);
}

async function send(url: string, init: RequestInit, o: McpOAuthOptions): Promise<{ res: Response; text: string }> {
  const res = await o.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
  if (res.status >= 300 && res.status < 400) throw new McpOAuthError("discovery-failed", "the server redirected; redirects are not followed");
  const reader = res.body?.getReader();
  let text = "";
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) { await reader.cancel(); throw new McpOAuthError("metadata-invalid", "the answer is too large"); }
      chunks.push(value);
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  return { res, text };
}

function json(text: string, what: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    if (isRecord(v)) return v;
  } catch { /* fall through */ }
  throw new McpOAuthError("metadata-invalid", `${what} is not a JSON object`);
}

// ---- the 401 challenge --------------------------------------------------------------------------

export interface BearerChallenge { resourceMetadata?: string; scope?: string; error?: string }

/** Reads `WWW-Authenticate: Bearer k="v", …`. Also used on a tool call's 401/403 (`insufficient_scope`). */
export function parseBearerChallenge(header: string | null): BearerChallenge | undefined {
  if (!header) return undefined;
  const m = /^\s*Bearer\b(.*)$/is.exec(header);
  if (!m) return undefined;
  const out: BearerChallenge = {};
  for (const p of m[1]!.matchAll(/([a-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi)) {
    const value = (p[2] ?? p[3] ?? "").replace(/\\(.)/g, "$1");
    const key = p[1]!.toLowerCase();
    if (key === "resource_metadata") out.resourceMetadata = value;
    else if (key === "scope") out.scope = value;
    else if (key === "error") out.error = value;
  }
  return out;
}

/** What to do about a rejected tool call: ask for more scope, or sign in again. */
export function challengeAction(status: number, header: string | null): { action: "reconsent"; scope?: string } | { action: "sign-in-again" } | undefined {
  if (status !== 401 && status !== 403) return undefined;
  const c = parseBearerChallenge(header);
  if (c?.error === "insufficient_scope") return { action: "reconsent", ...(c.scope ? { scope: c.scope } : {}) };
  return status === 401 ? { action: "sign-in-again" } : undefined;
}

// ---- discovery ----------------------------------------------------------------------------------

export interface SignInServer {
  /** The MCP address being connected, as the person typed it. */
  mcpUrl: string;
  /** The identifier every authorize and token call carries as `resource`. */
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  /** The server sends `iss` on the authorization response, so its absence is an error. */
  issuerParameterSupported: boolean;
  tokenAuthMethods: string[];
  /** From the 401 challenge, else the resource's `scopes_supported`. */
  scope?: string;
}

async function firstDocument(urls: string[], o: McpOAuthOptions, what: string): Promise<Record<string, unknown>> {
  let last = `${what} could not be read`;
  for (const url of urls) {
    checkUrl(url, what, o);
    const { res, text } = await send(url, { method: "GET", headers: { accept: "application/json" } }, o);
    if (res.status === 200) return json(text, what);
    last = `${what} answered ${res.status}`;
  }
  throw new McpOAuthError("discovery-failed", last);
}

/** Unauthenticated `initialize` → 401 challenge → resource metadata → sign-in server metadata. */
export async function discoverSignIn(mcpUrl: string, o: McpOAuthOptions): Promise<SignInServer> {
  const server = checkUrl(mcpUrl, "the tool address", o);
  const probe = await send(server.href, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "lares-signin-probe", version: "1" } } }),
  }, o);
  if (probe.res.status !== 401) throw new McpOAuthError("not-oauth", `the server did not ask for sign-in (it answered ${probe.res.status})`);
  const challenge = parseBearerChallenge(probe.res.headers.get("www-authenticate"));
  if (!challenge) throw new McpOAuthError("not-oauth", "the server answered 401 without a sign-in challenge");

  // Resource metadata: the challenge's address, else the well-known address for this path (RFC 9728 §3).
  const path = server.pathname === "/" ? "" : server.pathname;
  const prmUrls = challenge.resourceMetadata
    ? [new URL(challenge.resourceMetadata, server).href]
    : [`${server.origin}/.well-known/oauth-protected-resource${path}`, `${server.origin}/.well-known/oauth-protected-resource`];
  const prm = await firstDocument(prmUrls, o, "the tool's sign-in metadata");
  const resource = str(prm.resource);
  if (!resource) throw new McpOAuthError("metadata-invalid", "the tool's sign-in metadata names no resource");
  let sameResource = false;
  try { sameResource = canonical(resource) === canonical(server.href); } catch { /* invalid */ }
  if (!sameResource) throw new McpOAuthError("resource-mismatch", "the tool's sign-in metadata is for a different resource");
  const servers = strList(prm.authorization_servers);
  const issuerUrl = servers?.[0];
  if (!issuerUrl) throw new McpOAuthError("metadata-invalid", "the tool names no sign-in server");
  const issuer = checkUrl(issuerUrl, "the sign-in server address", o);

  // Sign-in server metadata: RFC 8414, then both OpenID forms (the spec requires both to be tried).
  const ipath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  const asm = await firstDocument(ipath
    ? [`${issuer.origin}/.well-known/oauth-authorization-server${ipath}`, `${issuer.origin}/.well-known/openid-configuration${ipath}`, `${issuer.origin}${ipath}/.well-known/openid-configuration`]
    : [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`], o, "the sign-in server's metadata");
  const advertised = str(asm.issuer);
  if (!advertised || canonical(advertised) !== canonical(issuer.href)) {
    throw new McpOAuthError("issuer-mismatch", "the sign-in server's metadata names a different issuer than the one it was found for");
  }
  if (!strList(asm.code_challenge_methods_supported)?.includes("S256")) throw new McpOAuthError("no-pkce", "the sign-in server does not offer S256 code challenges");
  const endpoint = (key: string, required: boolean): string | undefined => {
    const v = str(asm[key]);
    if (!v) { if (required) throw new McpOAuthError("metadata-invalid", `the sign-in server's metadata has no ${key}`); return undefined; }
    checkUrl(v, key, o);
    return v;
  };
  const scope = challenge.scope ?? strList(prm.scopes_supported)?.join(" ");
  const registrationEndpoint = endpoint("registration_endpoint", false);
  const revocationEndpoint = endpoint("revocation_endpoint", false);
  return {
    mcpUrl: server.href, resource: canonical(resource), issuer: advertised,
    authorizationEndpoint: endpoint("authorization_endpoint", true)!, tokenEndpoint: endpoint("token_endpoint", true)!,
    ...(registrationEndpoint ? { registrationEndpoint } : {}), ...(revocationEndpoint ? { revocationEndpoint } : {}),
    issuerParameterSupported: asm.authorization_response_iss_parameter_supported === true,
    tokenAuthMethods: strList(asm.token_endpoint_auth_methods_supported) ?? ["client_secret_basic"],
    ...(scope ? { scope } : {}),
  };
}

// ---- registration -------------------------------------------------------------------------------

export type ClientAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

/** The OAuth client this install uses with one sign-in server. `clientSecret` goes to custody, never the browser. */
export interface SignInClient { clientId: string; clientSecret?: string; authMethod: ClientAuthMethod }

/** A client id (and secret) the owner pasted for a vendor without dynamic registration. */
export function pastedClient(server: SignInServer, input: { clientId: string; clientSecret?: string }): SignInClient {
  const clientId = input.clientId.trim(), clientSecret = input.clientSecret?.trim() || undefined;
  if (!clientId) throw new McpOAuthError("no-registration", "the client id is empty");
  const methods = server.tokenAuthMethods;
  const authMethod: ClientAuthMethod = !clientSecret ? "none"
    : methods.includes("client_secret_basic") || !methods.includes("client_secret_post") ? "client_secret_basic" : "client_secret_post";
  return { clientId, ...(clientSecret ? { clientSecret } : {}), authMethod };
}

/** Dynamic client registration (RFC 7591): this install registers itself, directly with the vendor. */
export async function registerClient(server: SignInServer, input: { redirectUri: string; clientName: string }, o: McpOAuthOptions): Promise<SignInClient> {
  if (!server.registrationEndpoint) throw new McpOAuthError("no-registration", "the sign-in server does not allow clients to register themselves; paste a client id instead");
  checkUrl(input.redirectUri, "the return address", o);
  const method: ClientAuthMethod = server.tokenAuthMethods.includes("none") ? "none"
    : server.tokenAuthMethods.includes("client_secret_post") ? "client_secret_post" : "client_secret_basic";
  const { res, text } = await send(server.registrationEndpoint, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_name: input.clientName, redirect_uris: [input.redirectUri], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: method }),
  }, o);
  if (res.status !== 200 && res.status !== 201) throw new McpOAuthError("registration-failed", `the sign-in server refused registration (${res.status})`);
  const doc = json(text, "the registration answer");
  const clientId = str(doc.client_id);
  if (!clientId) throw new McpOAuthError("registration-failed", "the registration answer has no client id");
  const uris = strList(doc.redirect_uris);
  if (uris && !uris.includes(input.redirectUri)) throw new McpOAuthError("registration-failed", "the server registered a different return address");
  const clientSecret = str(doc.client_secret);
  const chosen = str(doc.token_endpoint_auth_method);
  const authMethod: ClientAuthMethod = chosen === "none" || chosen === "client_secret_post" || chosen === "client_secret_basic" ? chosen : clientSecret ? "client_secret_basic" : "none";
  return { clientId, ...(clientSecret ? { clientSecret } : {}), authMethod };
}

// ---- authorize + code exchange ------------------------------------------------------------------

/** Everything the callback needs, kept by the caller (never in the URL). */
export interface PendingSignIn {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  startedAt: number;
  server: SignInServer;
  client: SignInClient;
  scope?: string;
}

export function beginSignIn(server: SignInServer, client: SignInClient, input: { redirectUri: string; scope?: string }, o: Pick<McpOAuthOptions, "now"> = {}): { url: string; pending: PendingSignIn } {
  const state = b64url(randomBytes(32));
  const codeVerifier = b64url(randomBytes(48));
  const scope = input.scope ?? server.scope;
  const u = new URL(server.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", client.clientId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("code_challenge", b64url(createHash("sha256").update(codeVerifier).digest()));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("resource", server.resource);
  if (scope) u.searchParams.set("scope", scope);
  return { url: u.href, pending: { state, codeVerifier, redirectUri: input.redirectUri, startedAt: (o.now ?? Date.now)(), server, client, ...(scope ? { scope } : {}) } };
}

/** What the browser brought back on the return address. */
export interface SignInCallback { code?: string; state?: string; iss?: string; error?: string; errorDescription?: string }

export interface TokenGrant {
  issuer: string;
  resource: string;
  tokenEndpoint: string;
  client: SignInClient;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; `undefined` when the server gave no lifetime. */
  expiresAt?: number;
  scope?: string;
}

export const SIGN_IN_ATTEMPT_MS = 10 * 60_000;

function clientAuth(client: SignInClient, params: URLSearchParams, headers: Record<string, string>): void {
  if (client.authMethod === "client_secret_basic" && client.clientSecret !== undefined) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`;
  } else {
    params.set("client_id", client.clientId);
    if (client.authMethod === "client_secret_post" && client.clientSecret !== undefined) params.set("client_secret", client.clientSecret);
  }
}

async function tokenCall(tokenEndpoint: string, params: URLSearchParams, client: SignInClient, o: McpOAuthOptions): Promise<{ status: number; doc: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  clientAuth(client, params, headers);
  const { res, text } = await send(tokenEndpoint, { method: "POST", headers, body: params.toString() }, o);
  let doc: Record<string, unknown> = {};
  try { doc = json(text, "the token answer"); } catch { if (res.ok) throw new McpOAuthError("exchange-failed", "the token answer is not valid"); }
  return { status: res.status, doc };
}

function grantFrom(doc: Record<string, unknown>, base: { issuer: string; resource: string; tokenEndpoint: string; client: SignInClient }, previous: TokenGrant | undefined, o: McpOAuthOptions, fail: McpOAuthErrorKind): TokenGrant {
  const accessToken = str(doc.access_token);
  if (!accessToken) throw new McpOAuthError(fail, "the token answer has no access token");
  const type = str(doc.token_type);
  if (type && type.toLowerCase() !== "bearer") throw new McpOAuthError(fail, "the token answer is not a bearer token");
  const expires = typeof doc.expires_in === "number" && Number.isFinite(doc.expires_in) && doc.expires_in > 0 ? doc.expires_in : undefined;
  const refreshToken = str(doc.refresh_token) ?? previous?.refreshToken;
  const scope = str(doc.scope) ?? previous?.scope;
  return { ...base, accessToken, ...(refreshToken ? { refreshToken } : {}), ...(expires ? { expiresAt: (o.now ?? Date.now)() + expires * 1000 } : {}), ...(scope ? { scope } : {}) };
}

/** Checks the redirect (state, attempt age, error, issuer), then trades the code for tokens. */
export async function completeSignIn(pending: PendingSignIn, callback: SignInCallback, o: McpOAuthOptions): Promise<TokenGrant> {
  const now = (o.now ?? Date.now)();
  if (!callback.state || !safeEqual(callback.state, pending.state)) throw new McpOAuthError("state-mismatch", "the sign-in return does not belong to this attempt");
  if (now - pending.startedAt > SIGN_IN_ATTEMPT_MS || now < pending.startedAt) throw new McpOAuthError("expired-attempt", "the sign-in took too long; start again");
  // RFC 9207: an `iss` that is present must match; one the server promised must be present. Checked
  // before the error branch so a hostile redirect cannot pass for the real server's refusal.
  if (callback.iss !== undefined) {
    if (canonicalSafe(callback.iss) !== canonicalSafe(pending.server.issuer)) throw new McpOAuthError("issuer-mismatch", "the sign-in return came from a different server than the one asked");
  } else if (pending.server.issuerParameterSupported) {
    throw new McpOAuthError("missing-issuer", "the sign-in server did not say who it is on the return");
  }
  if (callback.error) throw new McpOAuthError("denied", callback.error === "access_denied" ? "sign-in was refused" : `the sign-in server returned an error: ${callback.error}`);
  if (!callback.code) throw new McpOAuthError("exchange-failed", "the sign-in return has no code");
  const params = new URLSearchParams({ grant_type: "authorization_code", code: callback.code, redirect_uri: pending.redirectUri, code_verifier: pending.codeVerifier, resource: pending.server.resource });
  const { status, doc } = await tokenCall(pending.server.tokenEndpoint, params, pending.client, o);
  if (status !== 200) throw new McpOAuthError("exchange-failed", `the sign-in server refused the code (${status}${str(doc.error) ? `, ${str(doc.error)}` : ""})`);
  return grantFrom(doc, { issuer: pending.server.issuer, resource: pending.server.resource, tokenEndpoint: pending.server.tokenEndpoint, client: pending.client }, undefined, o, "exchange-failed");
}

function canonicalSafe(v: string): string { try { return canonical(v); } catch { return v; } }

// ---- refresh ------------------------------------------------------------------------------------

/** One refresh. A dead grant (`invalid_grant`, no refresh token) is `needs-sign-in`; anything else is retryable. */
export async function refreshGrant(grant: TokenGrant, o: McpOAuthOptions): Promise<TokenGrant> {
  if (!grant.refreshToken) throw new McpOAuthError("needs-sign-in", "there is no refresh token; sign in again");
  const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: grant.refreshToken, resource: grant.resource });
  let result: { status: number; doc: Record<string, unknown> };
  try { result = await tokenCall(grant.tokenEndpoint, params, grant.client, o); }
  catch (e) { throw e instanceof McpOAuthError ? new McpOAuthError("refresh-failed", e.message) : new McpOAuthError("refresh-failed", "the sign-in server could not be reached"); }
  const { status, doc } = result;
  if (status === 200) return grantFrom(doc, grant, grant, o, "refresh-failed");
  if (str(doc.error) === "invalid_grant" || str(doc.error) === "invalid_client" || status === 401) throw new McpOAuthError("needs-sign-in", "the sign-in is no longer valid; sign in again");
  throw new McpOAuthError("refresh-failed", `the sign-in server could not refresh (${status})`);
}

export interface FreshenOptions extends McpOAuthOptions {
  /** Refresh when the token has less than this left. Default 60 s. */
  skewMs?: number;
}

/** Keeps one grant fresh. Concurrent callers for the same key share ONE refresh (single flight), which
 *  matters because vendors rotate refresh tokens: a second parallel refresh would kill the first one's result. */
export class GrantRefresher {
  readonly #inflight = new Map<string, Promise<TokenGrant>>();
  constructor(private readonly o: FreshenOptions) {}

  /** `load` and `save` are the caller's custody; `save` runs before anyone sees the new token. */
  fresh(key: string, load: () => Promise<TokenGrant>, save: (g: TokenGrant) => Promise<void>): Promise<TokenGrant> {
    const running = this.#inflight.get(key);
    if (running) return running;
    const work = (async () => {
      const current = await load();
      const skew = this.o.skewMs ?? 60_000;
      if (current.expiresAt === undefined || current.expiresAt - (this.o.now ?? Date.now)() > skew) return current;
      const next = await refreshGrant(current, this.o);
      await save(next);
      return next;
    })();
    this.#inflight.set(key, work);
    const clear = () => { if (this.#inflight.get(key) === work) this.#inflight.delete(key); };
    work.then(clear, clear);
    return work;
  }
}
