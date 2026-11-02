import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));
import InvitationPage from "../app/invite/page";

const render = async (token?: string) =>
  renderToStaticMarkup(await InvitationPage({ searchParams: Promise.resolve({ token }) }));

describe("invitation page", () => {
  it("uses the signed-out layout and offers both sign-in routes for a well-formed link", async () => {
    const html = await render("a".repeat(43));
    expect(html).toContain('id="main-content"');
    expect(html).toContain('aria-label="About Lares"');
    expect(html).toContain(`provider=google&amp;invite=${"a".repeat(43)}`);
    expect(html).toContain(`provider=microsoft&amp;invite=${"a".repeat(43)}`);
  });

  it("offers no sign-in for a malformed link", async () => {
    const html = await render("short");
    expect(html).toContain("This invitation link is not valid");
    expect(html).not.toContain("/api/auth/login");
  });
});
