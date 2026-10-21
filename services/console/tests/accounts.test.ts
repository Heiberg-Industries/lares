import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// lib/accounts imports @lares/agent-box (native deps) + lib/db at module load — mock both so the
// pure helpers under test load hermetically.
vi.mock("@lares/agent-box/lib/oauth-tokens.js", () => ({ listTokens: vi.fn().mockResolvedValue([]) }));
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../lib/db", () => ({ pool: db }));


import { listGoogleAccounts, toGoogleAccountDTO, googleOrgClientConfig, googleOrgs, GOOGLE_SCOPES } from "../lib/accounts";
import { readSecret } from "../lib/secrets";

describe("accounts data layer", () => {
  const origEnv = { ...process.env };
  beforeEach(() => { db.query.mockReset().mockResolvedValue({ rows: [] }); });

  it("distinguishes a successful empty account read from a failed read", async () => {
    expect(await listGoogleAccounts()).toEqual({ accounts: [], unavailable: false });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("NOT EXISTS"), ["owner-1"]);
    db.query.mockRejectedValue(new Error("private SQL and credentials"));
    expect(await listGoogleAccounts()).toEqual({ accounts: [], unavailable: true });
  });

  it("returns stored account facts without secrets on a successful read", async () => {
    db.query.mockResolvedValue({ rows: [{
      id: "token", principal: "owner", provider: "google", orgId: "acme",
      emailAddress: "owner@acme.example", scopes: ["read"],
      createdAt: new Date("2026-10-08T10:00:00Z"), updatedAt: new Date("2026-10-08T10:00:00Z"),
    }] });
    expect(await listGoogleAccounts()).toEqual({ unavailable: false, accounts: [{
      principal: "owner", email: "owner@acme.example", org: "acme",
      scopeCount: 1, connectedAt: "2026-10-08",
    }] });
  });
  afterEach(() => { process.env = { ...origEnv }; });

  it("maps a StoredOAuthToken to a display DTO (no secret leaks)", () => {
    const dto = toGoogleAccountDTO({
      id: "tok1", principal: "U_owner1", provider: "google", orgId: "acme",
      emailAddress: "owner@owner.example", scopes: ["a", "b", "c"],
      createdAt: new Date("2026-06-29T10:00:00Z"), updatedAt: new Date("2026-06-29T10:00:00Z"),
    });
    expect(dto).toEqual({
      principal: "U_owner1", email: "owner@owner.example", org: "acme",
      scopeCount: 3, connectedAt: "2026-06-29",
    });
    expect(JSON.stringify(dto)).not.toContain("refresh");
  });

  it("resolves per-org client config from GOOGLE_CLIENT_ID_<ORG> env", () => {
    process.env.GOOGLE_CLIENT_ID_ACME = "hid";
    process.env.GOOGLE_CLIENT_SECRET_ACME = "hsecret";
    expect(googleOrgClientConfig("acme")).toEqual({ clientId: "hid", clientSecret: "hsecret" });
  });

  it("returns null for an unknown org or missing secret", () => {
    delete process.env.GOOGLE_CLIENT_ID_BETA;
    expect(googleOrgClientConfig("beta")).toBeNull();
    expect(googleOrgClientConfig("nope")).toBeNull();
  });

  it("discovers orgs from whatever GOOGLE_CLIENT_ID_* clients the host has — none hardcoded", () => {
    process.env.GOOGLE_CLIENT_ID_ACME = "aid";
    process.env.GOOGLE_CLIENT_SECRET_ACME = "asecret";
    expect(googleOrgs().map((o) => o.id)).toContain("acme");
    expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/gmail.compose");
    expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/calendar.readonly");
  });

  it("never surfaces the console's own login client as a mailbox org", () => {
    process.env.GOOGLE_CLIENT_ID_CONSOLE = "console-id";
    process.env.GOOGLE_CLIENT_SECRET_CONSOLE = "console-secret";
    expect(googleOrgs().map((o) => o.id)).not.toContain("console");
  });

  // GOOGLE_CLIENT_ID_FILE / GOOGLE_CLIENT_SECRET_FILE is a real pair
  // (a compose file's client-id-from-file secret) — the discovery regex's
  // optional `(_FILE)?` group used to fall back to reading "FILE" itself as an org id.
  it("never surfaces the readSecret _FILE suffix as a phantom org", () => {
    process.env.GOOGLE_CLIENT_ID_FILE = "/run/secrets/google-client-id-acme";
    process.env.GOOGLE_CLIENT_SECRET_FILE = "/run/secrets/google-client-secret-acme";
    expect(googleOrgs().map((o) => o.id)).not.toContain("file");
  });

  // Regression: the console shipped WITHOUT calendar.events while oauth-enroll.ts granted it,
  // so any console-enrolled mailbox silently lost calendar writes (ACCESS_TOKEN_SCOPE_
  // INSUFFICIENT) and could only regain them by re-consenting. Caught during an OAuth project
  // migration. An exact-set assertion, not toContain — toContain is what let the
  // omission through in the first place.
  it("grants the data scope set plus OIDC identity consent", () => {
    expect([...GOOGLE_SCOPES].sort()).toEqual(
      [
        "openid",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/drive.readonly", // batch 6: the chief of staff opens Docs links
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.readonly",
      ].sort(),
    );
  });

  it("readSecret prefers <NAME>_FILE over <NAME>", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const f = join(mkdtempSync(join(tmpdir(), "sec-")), "k");
    writeFileSync(f, "from-file\n");
    process.env.MY_KEY = "from-env";
    process.env.MY_KEY_FILE = f;
    expect(readSecret("MY_KEY")).toBe("from-file");
    delete process.env.MY_KEY_FILE;
    expect(readSecret("MY_KEY")).toBe("from-env");
  });
});
