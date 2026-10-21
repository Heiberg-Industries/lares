import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ revokeSession: vi.fn() }));
vi.mock("../lib/auth", () => ({ members: { revokeSession: mocks.revokeSession }, SESSION_MAX_AGE: 604800 }));
import { POST, GET } from "../app/api/auth/[...route]/route";
const origin = "https://console.example.test";
const ctx = (...route: string[]) => ({ params: Promise.resolve({ route }) });
function req(path: string, method = "POST", from: string | null = origin) {
  return new NextRequest(`http://container:3000${path}`, { method, headers: { cookie: "lares_session=opaque", ...(from ? { origin: from } : {}) } });
}
beforeEach(() => { vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("CONSOLE_OAUTH_REDIRECT", `${origin}/api/auth/callback`); mocks.revokeSession.mockReset().mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllEnvs());
describe("revocable sign-out", () => {
  it("revokes the server session before clearing the browser cookie", async () => {
    const res = await POST(req("/api/auth/logout"), ctx("logout"));
    expect(mocks.revokeSession).toHaveBeenCalledWith("opaque");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${origin}/sign-in?signed-out=1`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toMatch(/lares_session=;[^]*Max-Age=0/);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/);
  });
  it.each([null, "https://attacker.test"])("refuses a direct cross-origin request %s", async from => {
    expect((await POST(req("/api/auth/logout", "POST", from), ctx("logout"))).status).toBe(403);
    expect(mocks.revokeSession).not.toHaveBeenCalled();
  });
  it("reports a store outage without pretending all sessions were revoked", async () => {
    mocks.revokeSession.mockRejectedValue(new Error("unavailable"));
    expect((await POST(req("/api/auth/logout"), ctx("logout"))).status).toBe(503);
  });
  it("refuses GET logout and any extra auth path segments", async () => {
    expect((await GET(req("/api/auth/logout", "GET"), ctx("logout"))).status).toBe(404);
    expect((await POST(req("/api/auth/logout/extra"), ctx("logout", "extra"))).status).toBe(404);
    expect(mocks.revokeSession).not.toHaveBeenCalled();
  });
});
