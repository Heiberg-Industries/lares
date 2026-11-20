/**
 * tests/live/mcp-oauth.live.mts — LIVE probe of an MCP server's sign-in (discovery, optionally registration).
 *
 * NOT part of `pnpm test`: it calls a real server. Run it by hand whenever the sign-in client changes
 * or a vendor is added. The address comes from the environment only:
 *
 *     MCP_URL=https://… npx tsx packages/agent-kit/tests/live/mcp-oauth.live.mts
 *
 * By default it only DISCOVERS: an unauthenticated `initialize` (expects 401), the resource metadata and
 * the sign-in server's metadata, then prints what the client would do. It registers nothing and opens no
 * consent page. Dynamic registration creates a client on the vendor's side, so it runs only when asked:
 *
 *     MCP_OAUTH_REGISTER=1 MCP_OAUTH_REDIRECT=https://… MCP_URL=https://… npx tsx …
 *
 * A fixture is what we believe a server does; this is what it does (AGENTS.md).
 */
import { beginSignIn, discoverSignIn, pastedClient, registerClient } from "../../src/mcp-oauth.js";

const url = process.env.MCP_URL;
if (!url) { console.error("Set MCP_URL (and, only to register a client, MCP_OAUTH_REGISTER=1 and MCP_OAUTH_REDIRECT)."); process.exit(2); }

const o = { fetch: (u: string, i?: RequestInit) => fetch(u, i) };
const server = await discoverSignIn(url, o);
console.log("discovery ok:", JSON.stringify(server, null, 2));
console.log(`registration: ${server.registrationEndpoint ? "dynamic registration offered" : "NOT offered (a pasted client id is needed)"}`);
console.log(`issuer parameter promised on the return: ${server.issuerParameterSupported}`);

if (process.env.MCP_OAUTH_REGISTER === "1") {
  const redirectUri = process.env.MCP_OAUTH_REDIRECT;
  if (!redirectUri) { console.error("MCP_OAUTH_REGISTER=1 needs MCP_OAUTH_REDIRECT (the return address to register)."); process.exit(2); }
  const client = await registerClient(server, { redirectUri, clientName: "Lares sign-in probe" }, o);
  console.log("registered client id:", client.clientId, "auth method:", client.authMethod, "secret:", client.clientSecret ? "(issued, not printed)" : "none");
  const { url: authorize } = beginSignIn(server, client, { redirectUri });
  console.log("authorize address built (not opened):", new URL(authorize).origin + new URL(authorize).pathname);
} else {
  const { url: authorize } = beginSignIn(server, pastedClient(server, { clientId: "probe-not-registered" }), { redirectUri: "https://console.example.test/callback" });
  console.log("authorize address shape (dummy client, not opened):", Object.fromEntries(new URL(authorize).searchParams));
}
