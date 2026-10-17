import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("../lib/auth", () => ({ verify, sign: vi.fn(), allowed: vi.fn(), SESSION_MAX_AGE: 604800 }));
const origin = "https://console.example.test";
afterEach(() => vi.unstubAllEnvs());

async function render(params: Record<string, string> = {}) {
  const SignIn = (await import("../app/sign-in/page")).default;
  return renderToStaticMarkup(await SignIn({ searchParams: Promise.resolve(params) }));
}
async function middleware() {
  vi.resetModules();
  vi.stubEnv("CONSOLE_OAUTH_REDIRECT", `${origin}/api/auth/callback`);
  vi.stubEnv("NODE_ENV", "production");
  return (await import("../middleware")).middleware;
}
const get = (path: string) => new NextRequest(`http://container:3000${path}`, { headers: { cookie: "lares_session=synthetic" } });

describe("sign-in page", () => {
  it("offers Google as a link into the existing login flow", async () => {
    const html = await render();
    expect(html).toContain("Sign in to Lares");
    expect(html).toMatch(/<a [^>]*href="\/api\/auth\/login"[^>]*>.*Continue with Google/);
  });
  it("carries the page the person was heading to into the login link", async () => {
    expect(await render({ next: "/agents?tab=1" })).toContain('href="/api/auth/login?next=%2Fagents%3Ftab%3D1"');
  });
  it.each(["https://attacker.test", "//attacker.test", "/\\attacker.test", "/api/auth/logout"])("ignores an unsafe return path: %s", async next => {
    expect(await render({ next })).toContain('href="/api/auth/login"');
  });
  it("says You're signed out after sign-out, and not otherwise", async () => {
    expect(await render({ "signed-out": "1" })).toContain("You&#x27;re signed out.");
    expect(await render()).not.toContain("signed out");
  });
  it("explains a sign-in error in plain words", async () => {
    expect(await render({ error: "denied" })).toContain("not allowed to use this console");
    expect(await render({ error: "unknown-code" })).toContain("Sign-in did not finish");
  });
  it("shows the other ways to sign in as disabled, with the coming-soon text for screen readers", async () => {
    const html = await render();
    for (const label of ["Continue with Microsoft", "Sign in</button>", "Email me a sign-in link"]) {
      expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*aria-disabled="true"[^>]*>[^]*?${label}`));
    }
    expect(html).toMatch(/<input[^>]*type="email"[^>]*disabled=""[^>]*aria-disabled="true"/);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*disabled=""[^>]*aria-disabled="true"/);
    expect(html).toContain("Coming soon");
    expect(html).toContain('id="sign-in-soon"');
  });
});

describe("sign-in routing", () => {
  it("sends a visitor without a session to the sign-in page, not to Google", async () => {
    const mw = await middleware();
    verify.mockReset().mockResolvedValue(null);
    const res = await mw(get("/"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${origin}/sign-in`);
  });
  it("remembers where the visitor was going", async () => {
    const mw = await middleware();
    verify.mockReset().mockResolvedValue(null);
    expect((await mw(get("/agents?x=1"))).headers.get("location")).toBe(`${origin}/sign-in?next=%2Fagents%3Fx%3D1`);
  });
  it("shows the sign-in page without a session, and sends a signed-in person on", async () => {
    const mw = await middleware();
    verify.mockReset().mockResolvedValue(null);
    expect((await mw(get("/sign-in"))).headers.get("x-middleware-next")).toBe("1");
    verify.mockResolvedValue("owner@example.test");
    const res = await mw(get("/sign-in?next=%2Fagents"));
    expect(res.headers.get("location")).toBe(`${origin}/agents`);
  });
});

describe("sign-in flow", () => {
  async function route() {
    vi.resetModules();
    vi.stubEnv("CONSOLE_OAUTH_REDIRECT", `${origin}/api/auth/callback`);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GOOGLE_CLIENT_ID_CONSOLE", "client-id.example");
    vi.stubEnv("GOOGLE_CLIENT_SECRET_CONSOLE", "secret.example");
    return import("../app/api/auth/[...route]/route");
  }
  const ctx = (...r: string[]) => ({ params: Promise.resolve({ route: r }) });
  it("login keeps a safe return path in a cookie and drops an unsafe one", async () => {
    const { GET } = await route();
    const ok = await GET(get("/api/auth/login?next=%2Fagents"), ctx("login"));
    expect(ok.headers.get("set-cookie")).toContain("oauth_next=%2Fagents");
    const bad = await GET(get("/api/auth/login?next=https%3A%2F%2Fattacker.test"), ctx("login"));
    expect(bad.headers.get("set-cookie")).not.toContain("oauth_next");
  });
  it("a failed callback lands on the sign-in page with an error", async () => {
    const { GET } = await route();
    const res = await GET(get("/api/auth/callback?state=a"), ctx("callback"));
    expect(res.headers.get("location")).toBe(`${origin}/sign-in?error=failed`);
  });
});

describe("return path cannot leave the console", () => {
  // Raw query-string forms; the decoded forms are checked too.
  const hostile = ["/%09/attacker.test", "/%0a/attacker.test", "/%0d/attacker.test", "/%5Cattacker.test", "//attacker.test", "/%2F%2Fattacker.test", "https://attacker.test"];
  it.each(hostile)("safeNext falls back to home for %s", async raw => {
    const { safeNext } = await import("../lib/safe-next");
    expect(safeNext(decodeURIComponent(raw))).toBe("/");
  });
  it.each(hostile)("a signed-in visit to /sign-in?next=%s stays on the console", async raw => {
    const mw = await middleware();
    verify.mockReset().mockResolvedValue("owner@example.test");
    const res = await mw(get(`/sign-in?next=${raw}`));
    expect(new URL(res.headers.get("location")!).origin).toBe(origin);
  });
  it.each(hostile)("the sign-in redirect never goes off the console for a stored path %s", async raw => {
    const { safeNext, sameOriginTarget } = await import("../lib/safe-next");
    expect(sameOriginTarget(safeNext(decodeURIComponent(raw)), origin).origin).toBe(origin);
  });
  it("keeps an ordinary path, query and hash", async () => {
    const { safeNext } = await import("../lib/safe-next");
    expect(safeNext("/agents?tab=1#x")).toBe("/agents?tab=1#x");
  });
});
