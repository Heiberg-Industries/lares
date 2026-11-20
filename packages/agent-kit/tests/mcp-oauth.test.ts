import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  beginSignIn, challengeAction, completeSignIn, discoverSignIn, GrantRefresher, McpOAuthError, parseBearerChallenge,
  pastedClient, refreshGrant, registerClient, type McpOAuthOptions, type TokenGrant,
} from "../src/mcp-oauth.js";

// A fake sign-in server and a fake MCP server in one: it behaves as the spec says unless a test bends it.
interface Knobs {
  iss?: boolean; registration?: boolean; prmResource?: string; metaIssuer?: string; noS256?: boolean; challenge?: boolean;
  prmScopes?: string[]; refreshDelay?: number; refreshError?: string; rotate?: boolean; tokenAuth?: string[];
}
let server: Server | undefined;
let base = "";
const seen: { path: string; body: string; auth?: string }[] = [];
let refreshCalls = 0;

async function start(k: Knobs = {}): Promise<McpOAuthOptions> {
  refreshCalls = 0; seen.length = 0;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      seen.push({ path: req.url!, body, auth: req.headers.authorization });
      const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/mcp" && req.method === "POST") {
        return k.challenge === false ? send(200, {}) : send(401, {}, { "www-authenticate": `Bearer realm="OAuth", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read write"` });
      }
      if (req.url === "/.well-known/oauth-protected-resource/mcp") {
        return send(200, { resource: k.prmResource ?? `${base}/mcp`, authorization_servers: [base], ...(k.prmScopes ? { scopes_supported: k.prmScopes } : {}) });
      }
      if (req.url === "/.well-known/oauth-authorization-server") {
        return send(200, {
          issuer: k.metaIssuer ?? base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
          ...(k.registration === false ? {} : { registration_endpoint: `${base}/register` }),
          code_challenge_methods_supported: k.noS256 ? ["plain"] : ["S256"], authorization_response_iss_parameter_supported: k.iss === true,
          token_endpoint_auth_methods_supported: k.tokenAuth ?? ["none", "client_secret_post"],
        });
      }
      if (req.url === "/register") {
        const asked = JSON.parse(body);
        return send(201, { client_id: "client-1", redirect_uris: asked.redirect_uris, token_endpoint_auth_method: asked.token_endpoint_auth_method });
      }
      if (req.url === "/token") {
        const p = new URLSearchParams(body);
        if (p.get("grant_type") === "authorization_code") {
          return send(200, { access_token: "access-1", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1", scope: "read" });
        }
        refreshCalls++;
        if (k.refreshDelay) await new Promise((r) => setTimeout(r, k.refreshDelay));
        if (k.refreshError) return send(400, { error: k.refreshError });
        return send(200, { access_token: `access-${1 + refreshCalls}`, token_type: "bearer", expires_in: 3600, ...(k.rotate ? { refresh_token: `refresh-${1 + refreshCalls}` } : {}) });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { fetch: (u, i) => fetch(u, i), allowInsecure: true };
}
afterEach(async () => {
  if (server) await new Promise<void>((r) => { server!.close(() => r()); server!.closeAllConnections(); });
  server = undefined;
});

const REDIRECT = "https://console.example.test/integrations/connect-outside-tool/callback";
const kind = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof McpOAuthError ? e.kind : `other:${e}`));

describe("challenge parsing", () => {
  it("reads quoted and bare parameters", () => {
    expect(parseBearerChallenge('Bearer realm="OAuth", resource_metadata="https://x.example.test/m", scope="a b", error=insufficient_scope'))
      .toEqual({ resourceMetadata: "https://x.example.test/m", scope: "a b", error: "insufficient_scope" });
    expect(parseBearerChallenge("Basic realm=x")).toBeUndefined();
    expect(parseBearerChallenge(null)).toBeUndefined();
  });
  it("tells a scope problem from a dead token", () => {
    expect(challengeAction(403, 'Bearer error="insufficient_scope", scope="write"')).toEqual({ action: "reconsent", scope: "write" });
    expect(challengeAction(401, 'Bearer error="invalid_token"')).toEqual({ action: "sign-in-again" });
    expect(challengeAction(200, null)).toBeUndefined();
  });
});

describe("discovery", () => {
  it("follows the 401 to the sign-in server and takes the scope from the challenge", async () => {
    const o = await start({ prmScopes: ["other"] });
    const s = await discoverSignIn(`${base}/mcp`, o);
    expect(s).toMatchObject({ resource: `${base}/mcp`, issuer: base, tokenEndpoint: `${base}/token`, registrationEndpoint: `${base}/register`, scope: "read write" });
  });
  it("does not send a credential while probing", async () => {
    const o = await start();
    await discoverSignIn(`${base}/mcp`, o);
    expect(seen.every((r) => r.auth === undefined)).toBe(true);
  });
  it("refuses a server that does not ask for sign-in", async () => {
    const o = await start({ challenge: false });
    expect(await kind(discoverSignIn(`${base}/mcp`, o))).toBe("not-oauth");
  });
  it("refuses metadata for a different resource", async () => {
    const o = await start({ prmResource: "https://other.example.test/mcp" });
    expect(await kind(discoverSignIn(`${base}/mcp`, o))).toBe("resource-mismatch");
  });
  it("refuses metadata that names no resource", async () => {
    const o = await start({ prmResource: "" });
    expect(await kind(discoverSignIn(`${base}/mcp`, o))).toBe("metadata-invalid");
  });
  it("refuses a sign-in server whose metadata names another issuer", async () => {
    const o = await start({ metaIssuer: "https://evil.example.test" });
    expect(await kind(discoverSignIn(`${base}/mcp`, o))).toBe("issuer-mismatch");
  });
  it("refuses a server without S256", async () => {
    const o = await start({ noS256: true });
    expect(await kind(discoverSignIn(`${base}/mcp`, o))).toBe("no-pkce");
  });
  it("refuses plain http and private addresses in production mode", async () => {
    const o: McpOAuthOptions = { fetch: async () => { throw new Error("must not be called"); } };
    expect(await kind(discoverSignIn("http://tools.example.org/mcp", o))).toBe("unsafe-url");
    expect(await kind(discoverSignIn("https://10.0.0.1/mcp", o))).toBe("unsafe-url");
    expect(await kind(discoverSignIn("https://box.internal/mcp", o))).toBe("unsafe-url");
  });
  it("does not follow redirects", async () => {
    const o: McpOAuthOptions = { fetch: async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }), allowInsecure: true };
    expect(await kind(discoverSignIn("http://127.0.0.1:9/mcp", o))).toBe("discovery-failed");
  });
});

describe("registration", () => {
  it("registers directly with the server, asking for the quietest client type", async () => {
    const o = await start();
    const s = await discoverSignIn(`${base}/mcp`, o);
    const c = await registerClient(s, { redirectUri: REDIRECT, clientName: "Lares" }, o);
    expect(c).toEqual({ clientId: "client-1", authMethod: "none" });
    const asked = JSON.parse(seen.find((r) => r.path === "/register")!.body);
    expect(asked).toMatchObject({ redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" });
  });
  it("points to a pasted client when there is no registration endpoint", async () => {
    const o = await start({ registration: false });
    const s = await discoverSignIn(`${base}/mcp`, o);
    expect(await kind(registerClient(s, { redirectUri: REDIRECT, clientName: "Lares" }, o))).toBe("no-registration");
    expect(pastedClient(s, { clientId: " id ", clientSecret: " s " })).toEqual({ clientId: "id", clientSecret: "s", authMethod: "client_secret_post" });
    expect(pastedClient(s, { clientId: "id" })).toEqual({ clientId: "id", authMethod: "none" });
  });
});

describe("authorize and exchange", () => {
  async function setup(k: Knobs = {}) {
    const o = await start(k);
    const s = await discoverSignIn(`${base}/mcp`, o);
    const c = pastedClient(s, { clientId: "client-1" });
    return { o, s, c, ...beginSignIn(s, c, { redirectUri: REDIRECT }) };
  }
  it("builds an authorize address with PKCE S256, state, scope and resource", async () => {
    const { url, pending } = await setup();
    const q = new URL(url).searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe(createHash("sha256").update(pending.codeVerifier).digest("base64url"));
    expect(q.get("state")).toBe(pending.state);
    expect(q.get("resource")).toBe(`${base}/mcp`);
    expect(q.get("scope")).toBe("read write");
    expect(pending.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });
  it("exchanges the code with verifier and resource, and returns a grant", async () => {
    const { o, pending } = await setup({ iss: true });
    const g = await completeSignIn(pending, { code: "c1", state: pending.state, iss: base }, o);
    expect(g).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", issuer: base, resource: `${base}/mcp`, scope: "read" });
    expect(g.expiresAt).toBeGreaterThan(Date.now());
    const p = new URLSearchParams(seen.find((r) => r.path === "/token")!.body);
    expect(p.get("code_verifier")).toBe(pending.codeVerifier);
    expect(p.get("resource")).toBe(`${base}/mcp`);
    expect(p.get("redirect_uri")).toBe(REDIRECT);
  });
  it("refuses a wrong or missing state", async () => {
    const { o, pending } = await setup();
    expect(await kind(completeSignIn(pending, { code: "c", state: "nope" }, o))).toBe("state-mismatch");
    expect(await kind(completeSignIn(pending, { code: "c" }, o))).toBe("state-mismatch");
    expect(seen.some((r) => r.path === "/token")).toBe(false);
  });
  it("refuses the wrong issuer, and a missing one when the server promises it", async () => {
    const a = await setup({ iss: true });
    expect(await kind(completeSignIn(a.pending, { code: "c", state: a.pending.state, iss: "https://evil.example.test" }, a.o))).toBe("issuer-mismatch");
    expect(await kind(completeSignIn(a.pending, { code: "c", state: a.pending.state }, a.o))).toBe("missing-issuer");
    expect(seen.some((r) => r.path === "/token")).toBe(false);
  });
  it("accepts a missing issuer when the server never promised one", async () => {
    const b = await setup({ iss: false });
    expect(await kind(completeSignIn(b.pending, { code: "c", state: b.pending.state }, b.o))).toBe("ok");
  });
  it("refuses an old attempt and reports a refusal by the person", async () => {
    const { o, pending } = await setup();
    expect(await kind(completeSignIn(pending, { code: "c", state: pending.state }, { ...o, now: () => pending.startedAt + 11 * 60_000 }))).toBe("expired-attempt");
    expect(await kind(completeSignIn(pending, { error: "access_denied", state: pending.state }, o))).toBe("denied");
  });
});

describe("refresh", () => {
  const grant = (b: string, over: Partial<TokenGrant> = {}): TokenGrant => ({
    issuer: b, resource: `${b}/mcp`, tokenEndpoint: `${b}/token`, client: { clientId: "client-1", authMethod: "none" },
    accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 10, ...over,
  });
  it("sends the resource and keeps the old refresh token when none is rotated in", async () => {
    const o = await start();
    const g = await refreshGrant(grant(base), o);
    expect(g).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-1" });
    expect(new URLSearchParams(seen.at(-1)!.body).get("resource")).toBe(`${base}/mcp`);
  });
  it("takes a rotated refresh token", async () => {
    const o = await start({ rotate: true });
    expect((await refreshGrant(grant(base), o)).refreshToken).toBe("refresh-2");
  });
  it("a dead grant needs a new sign-in; an unreachable server is only retryable", async () => {
    const o = await start({ refreshError: "invalid_grant" });
    expect(await kind(refreshGrant(grant(base), o))).toBe("needs-sign-in");
    expect(await kind(refreshGrant(grant(base, { refreshToken: undefined }), o))).toBe("needs-sign-in");
    expect(await kind(refreshGrant(grant("http://127.0.0.1:1"), o))).toBe("refresh-failed");
  });
  it("two callers at once cause one refresh and both get the new token", async () => {
    const o = await start({ refreshDelay: 50, rotate: true });
    let stored = grant(base);
    const saves: string[] = [];
    const r = new GrantRefresher(o);
    const load = async () => stored;
    const save = async (g: TokenGrant) => { saves.push(g.accessToken); stored = g; };
    const [a, b, c] = await Promise.all([r.fresh("k", load, save), r.fresh("k", load, save), r.fresh("k", load, save)]);
    expect(refreshCalls).toBe(1);
    expect([a.accessToken, b.accessToken, c.accessToken]).toEqual(["access-2", "access-2", "access-2"]);
    expect(saves).toEqual(["access-2"]);
    stored = { ...stored, expiresAt: Date.now() + 3_600_000 };
    await r.fresh("k", load, save);
    expect(refreshCalls).toBe(1);
  });
  it("a failed refresh reaches every waiter, saves nothing, and the next call tries again", async () => {
    const o = await start({ refreshError: "invalid_grant", refreshDelay: 20 });
    const r = new GrantRefresher(o);
    const saves: unknown[] = [];
    const go = () => kind(r.fresh("k", async () => grant(base), async (g) => void saves.push(g)));
    expect(await Promise.all([go(), go()])).toEqual(["needs-sign-in", "needs-sign-in"]);
    expect(refreshCalls).toBe(1);
    expect(saves).toEqual([]);
    expect(await go()).toBe("needs-sign-in");
    expect(refreshCalls).toBe(2);
  });
});
