import { describe, it, expect, vi } from "vitest";

// lib/account-oauth → lib/accounts imports @lares/agent-box + lib/db at module load; mock both.
vi.mock("@lares/agent-box/lib/oauth-tokens.js", () => ({ listTokens: async () => [] }));
vi.mock("../lib/db", () => ({ pool: {} }));

import { buildConsentUrl, callbackRedirect } from "../lib/account-oauth";

describe("account oauth helpers", () => {
  it("builds a Google consent URL with offline access, the state, and the compose scope", () => {
    const url = buildConsentUrl({
      clientId: "cid", clientSecret: "secret",
      redirectUri: "https://console.example/api/accounts/google/callback",
      state: "STATE123",
    });
    const u = new URL(url);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("state")).toBe("STATE123");
    expect(decodeURIComponent(u.searchParams.get("scope") ?? "")).toContain("gmail.compose");
    expect(u.searchParams.get("redirect_uri")).toBe("https://console.example/api/accounts/google/callback");
  });

  it("passes the mailbox address through as a login hint when given", () => {
    const url = buildConsentUrl({
      clientId: "cid", clientSecret: "secret",
      redirectUri: "https://console.example/api/accounts/google/callback",
      state: "STATE123",
      loginHint: "owner@project.example",
    });
    expect(new URL(url).searchParams.get("login_hint")).toBe("owner@project.example");
  });

  it("omits login_hint entirely when none is given", () => {
    const url = buildConsentUrl({
      clientId: "cid", clientSecret: "secret",
      redirectUri: "https://console.example/api/accounts/google/callback",
      state: "STATE123",
    });
    expect(new URL(url).searchParams.has("login_hint")).toBe(false);
  });

  it("builds the success redirect back to /integrations with the added email", () => {
    expect(callbackRedirect("https://console.example", { added: "owner@project.example" }))
      .toBe("https://console.example/integrations?added=owner%40project.example");
  });

  it("builds the error redirect back to /integrations with the message", () => {
    expect(callbackRedirect("https://console.example", { error: "no refresh token" }))
      .toBe("https://console.example/integrations?error=no+refresh+token");
  });
});
