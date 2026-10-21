import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const origin = "https://console.example.test";

async function guard(configured: string | undefined = `${origin}/api/auth/callback`, production = true) {
  vi.resetModules();
  vi.stubEnv("CONSOLE_OAUTH_REDIRECT", configured);
  vi.stubEnv("NODE_ENV", production ? "production" : "development");
  return (await import("../middleware")).middleware;
}
function request(path: string, method = "POST", from: string | null = origin, headers: Record<string, string> = {}) {
  return new NextRequest(`http://container:3000${path}`, {
    method,
    headers: { cookie: `lares_session=${"x".repeat(43)}`, ...(from === null ? {} : { origin: from }), ...headers },
  });
}
afterEach(() => vi.unstubAllEnvs());

describe("console mutation origin boundary", () => {
  it.each(["/api/notion-proposals", "/api/credentials/notion", "/api/accounts/google/start", "/api/chat/example/eve/v1/session/one", "/agents/example/edit"])("allows authenticated public-origin requests behind the proxy: %s", async path => {
    const middleware = await guard();
    expect((await middleware(request(path))).headers.get("x-middleware-next")).toBe("1");

  });
  it.each([null, "null", "https://other.example.test", "https://attacker.test", `${origin}:444`, "http://console.example.test", `${origin}/path`, `${origin}, https://attacker.test`])("refuses absent or nonmatching Origin %s before authentication or mutation", async from => {
    const middleware = await guard();
    const response = await middleware(request("/api/notion-proposals", "POST", from, { "content-type": "text/plain" }));
    expect(response.status).toBe(403);

  });
  it.each(["PUT", "PATCH", "DELETE"])("protects %s too", async method => {
    const middleware = await guard();
    expect((await middleware(request("/settings", method, null))).status).toBe(403);
  });
  it("does not let forwarded headers choose the trusted origin", async () => {
    const middleware = await guard();
    expect((await middleware(request("/api/notion-proposals", "POST", "https://attacker.test", {
      "x-forwarded-host": "attacker.test", "x-forwarded-proto": "https", host: "attacker.test",
    }))).status).toBe(403);
  });
  it("requires opaque cookie syntax as a navigation hint after the origin check", async () => {
    const middleware = await guard();
    const response = await middleware(request("/api/notion-proposals", "POST", origin, { cookie: "" }));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${origin}/sign-in?next=%2Fapi%2Fnotion-proposals`);
  });
  it.each(["/api/auth/login", "/api/auth/callback?code=synthetic", "/api/accounts/google/callback?code=synthetic"])("preserves GET navigation/callback: %s", async path => {
    const middleware = await guard();
    expect((await middleware(request(path, "GET", null))).headers.get("x-middleware-next")).toBe("1");
  });
  it.each(["slack", "telegram"])("leaves exact %s webhook authentication to its relay", async kind => {
    const middleware = await guard();
    expect((await middleware(request(`/api/doors/example/${kind}/events`, "POST", null))).headers.get("x-middleware-next")).toBe("1");

  });
  it.each(["/api/doors/example/slack/events/extra", "/api/doors/example/other/events", "/api/auth/callback"])("does not exempt other mutation paths: %s", async path => {
    const middleware = await guard();
    expect((await middleware(request(path, "POST", null))).status).toBe(403);
  });
  it("fails closed without the public origin in production", async () => {
    const middleware = await guard("");
    expect((await middleware(request("/api/notion-proposals", "POST", "http://container:3000"))).status).toBe(503);

  });
  it("allows local development against the request origin only", async () => {
    const middleware = await guard("", false);
    expect((await middleware(request("/api/notion-proposals", "POST", "http://container:3000"))).headers.get("x-middleware-next")).toBe("1");
    expect((await middleware(request("/api/notion-proposals", "POST", "http://container:3001"))).status).toBe(403);
  });
});

it("cannot authorise from cookie presence: Edge has no Node database or verifier import", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/from ["'].*(?:auth|db|member-store)["']/);
  const middleware = await guard();
  // A well-shaped but forged cookie may pass navigation; Node guards must deny it.
  expect((await middleware(request("/agents", "GET", null))).headers.get("x-middleware-next")).toBe("1");
});

it.each(["/api/authentication", "/api/auth/login/extra", "/api/auth/callback/extra"])("does not exempt auth-looking path %s", async path => {
  const middleware = await guard();
  const response = await middleware(request(path, "GET", null, { cookie: "" }));
  expect(response.status).toBe(307);
});
