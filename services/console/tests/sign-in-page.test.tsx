import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const mocks = vi.hoisted(() => ({ member: vi.fn(), current: vi.fn(), eligible: vi.fn(), receipt: vi.fn() }));
vi.mock("../lib/auth", () => ({ signedInMember: mocks.member, members: { currentMember: mocks.current, firstOwnerBootstrapEligible: mocks.eligible }, isConsoleOwner: (member: {id: string; role?: string; status?: string}) => member.id === process.env.AGENT_OWNER_USER_ID && (member.role === undefined || member.role === "owner") && (member.status === undefined || member.status === "active") }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "signed-receipt" }) }) }));
vi.mock("../lib/console-oidc", () => ({ consoleRedirect: () => "https://console.example.test/api/auth/callback" }));
vi.mock("../lib/owner-bootstrap-receipt", () => ({ OWNER_DISCOVERY_COOKIE: "lares_owner_discovery", openOwnerDiscoveryReceipt: mocks.receipt }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
beforeEach(() => {
  vi.stubEnv("AGENT_OWNER_USER_ID", "private-owner-record-id");
  mocks.member.mockReset().mockResolvedValue(null);
  mocks.current.mockReset().mockResolvedValue({ id: "private-owner-record-id", organisationId: "private-internal-org-id", role: "owner", status: "active" });
  mocks.eligible.mockReset().mockResolvedValue(true);
  mocks.receipt.mockReset().mockResolvedValue({ installationOrigin: "https://console.example.test", identity: { issuer: "https://accounts.google.com", subject: "verified-subject" }, digest: "d".repeat(64) });
});
afterEach(() => vi.unstubAllEnvs());
async function render(params: Record<string, string> = {}) {
  const SignIn = (await import("../app/sign-in/page")).default;
  return renderToStaticMarkup(await SignIn({ searchParams: Promise.resolve(params) }));
}
describe("sign-in page", () => {
  it("offers separate Google and Microsoft 365 work sign-in", async () => {
    const html = await render();
    expect(html).toMatch(/href="\/api\/auth\/login"/);
    expect(html).toContain("Continue with Google");
    expect(html).toContain("provider=microsoft");
    expect(html).toContain("Continue with Microsoft 365 work account");
    expect(html).toContain("Sign-in does not connect your mailbox or calendar.");
  });
  it("keeps a safe return path and refuses external or auth paths", async () => {
    expect(await render({ next: "/agents?tab=1" })).toContain("next=%2Fagents%3Ftab%3D1");
    for (const next of ["https://attacker.test", "//attacker.test", "/api/auth/logout", "/%09/attacker.test"]) {
      const html = await render({ next }); expect(html).not.toContain("next=https");
    }
  });
  it("says signed out or failed in plain language", async () => {
    expect(await render({ "signed-out": "1" })).toContain("You&#x27;re signed out.");
    expect(await render({ error: "failed" })).toContain("Sign-in did not finish");
  });
  it("rechecks Node admission before redirecting an existing member", async () => {
    mocks.member.mockResolvedValue({ id: "second" });
    await expect(render({ next: "/agents" })).rejects.toThrow("redirect:/membership");
    mocks.member.mockResolvedValue({ id: "private-owner-record-id", role: "owner", status: "active" });
    await expect(render({ next: "/agents" })).rejects.toThrow("redirect:/agents");
    await expect(render({ next: "https://attacker.test" })).rejects.toThrow("redirect:/");
  });
  it("shows only the verified tuple and public installation origin, never internal owner or organisation ids", async () => {
    const html = await render();
    expect(html).toContain("https://console.example.test");
    expect(html).toContain("verified-subject");
    expect(html).not.toContain("private-owner-record-id");
    expect(html).not.toContain("private-internal-org-id");
  });
});
