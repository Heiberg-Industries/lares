import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("../lib/auth", () => ({ verify, sign: vi.fn(), allowed: vi.fn(), SESSION_MAX_AGE: 604800 }));
const origin = "https://console.example.test";

async function load() {
  vi.resetModules();
  vi.stubEnv("CONSOLE_OAUTH_REDIRECT", `${origin}/api/auth/callback`);
  vi.stubEnv("NODE_ENV", "production");
  verify.mockReset();
  return { route: await import("../app/api/auth/[...route]/route"), middleware: (await import("../middleware")).middleware };
}
const ctx = (...route: string[]) => ({ params: Promise.resolve({ route }) });
const req = (path: string, method: string, from: string | null = origin) =>
  new NextRequest(`http://container:3000${path}`, {
    method,
    headers: { cookie: "lares_session=synthetic", ...(from === null ? {} : { origin: from }) },
  });
afterEach(() => vi.unstubAllEnvs());

describe("sign out", () => {
  it("POST clears the session cookie with the flags it was set with and lands on the signed-out page", async () => {
    const { route } = await load();
    const res = await route.POST(req("/api/auth/logout", "POST"), ctx("logout"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${origin}/api/auth/signed-out`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^lares_session=;/);
    expect(cookie).toMatch(/Max-Age=0/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
  });
  it("GET to the sign-out route does not sign out", async () => {
    const { route } = await load();
    const res = await route.GET(req("/api/auth/logout", "GET", null), ctx("logout"));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("a cross-origin POST is refused before reaching the route", async () => {
    const { middleware } = await load();
    for (const from of ["https://attacker.test", null]) {
      const res = await middleware(req("/api/auth/logout", "POST", from));
      expect(res.status).toBe(403);
    }
    expect((await middleware(req("/api/auth/logout", "POST"))).headers.get("x-middleware-next")).toBe("1");
  });
  it("the signed-out page is public, says so, and offers sign in again", async () => {
    const { route, middleware } = await load();
    expect((await middleware(req("/api/auth/signed-out", "GET", null))).headers.get("x-middleware-next")).toBe("1");
    const res = await route.GET(req("/api/auth/signed-out", "GET", null), ctx("signed-out"));
    const html = await res.text();
    expect(html).toContain("You are signed out");
    expect(html).toContain('href="/api/auth/login"');
    expect(html).toContain("Sign in again");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("after sign-out a protected page redirects to sign-in", async () => {
    const { middleware } = await load();
    verify.mockResolvedValue(null);
    const res = await middleware(req("/agents", "GET", null));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${origin}/api/auth/login`);
  });
  it("signed-in pages are marked no-store so the back button cannot show them", async () => {
    const { middleware } = await load();
    verify.mockResolvedValue("owner@example.test");
    const res = await middleware(req("/agents", "GET", null));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
