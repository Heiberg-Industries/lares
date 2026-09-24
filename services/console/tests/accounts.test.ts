import { describe, it, expect, afterEach, vi } from "vitest";

// lib/accounts imports @lares/agent-box (native deps) + lib/db at module load — mock both so the
// pure helpers under test load hermetically.
vi.mock("@lares/agent-box/lib/oauth-tokens.js", () => ({ listTokens: async () => [] }));
vi.mock("../lib/db", () => ({ pool: {} }));

import { toGoogleAccountDTO, googleOrgClientConfig, googleOrgs, GOOGLE_SCOPES } from "../lib/accounts";
import { readSecret } from "../lib/secrets";

describe("accounts data layer", () => {
  const origEnv = { ...process.env };
  afterEach(() => { process.env = { ...origEnv }; });

  it("maps a StoredOAuthToken to a display DTO (no secret leaks)", () => {
    const dto = toGoogleAccountDTO({
      id: "tok1", principal: "U_bendik", provider: "google", orgId: "heiberg",
      emailAddress: "owner@owner.example", scopes: ["a", "b", "c"],
      createdAt: new Date("2026-06-29T10:00:00Z"), updatedAt: new Date("2026-06-29T10:00:00Z"),
    });
    expect(dto).toEqual({
      principal: "U_bendik", email: "owner@owner.example", org: "heiberg",
      scopeCount: 3, connectedAt: "2026-06-29",
    });
    expect(JSON.stringify(dto)).not.toContain("refresh");
  });

  it("resolves per-org client config from GOOGLE_CLIENT_ID_<ORG> env", () => {
    process.env.GOOGLE_CLIENT_ID_HEIBERG = "hid";
    process.env.GOOGLE_CLIENT_SECRET_HEIBERG = "hsecret";
    expect(googleOrgClientConfig("heiberg")).toEqual({ clientId: "hid", clientSecret: "hsecret" });
  });

  it("returns null for an unknown org or missing secret", () => {
    delete process.env.GOOGLE_CLIENT_ID_ZERO7;
    expect(googleOrgClientConfig("zero7")).toBeNull();
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

  // Minor D (final review): GOOGLE_CLIENT_ID_FILE / GOOGLE_CLIENT_SECRET_FILE is a real pair
  // (agent-box/compose.yaml:717, Marcel's client-id-from-file secret) — the discovery regex's
  // optional `(_FILE)?` group used to fall back to reading "FILE" itself as an org id.
  it("never surfaces the readSecret _FILE suffix as a phantom org", () => {
    process.env.GOOGLE_CLIENT_ID_FILE = "/run/secrets/google-client-id-heiberg";
    process.env.GOOGLE_CLIENT_SECRET_FILE = "/run/secrets/google-client-secret-heiberg";
    expect(googleOrgs().map((o) => o.id)).not.toContain("file");
  });

  // Regression: the console shipped WITHOUT calendar.events while oauth-enroll.ts granted it,
  // so any console-enrolled mailbox silently lost calendar writes (ACCESS_TOKEN_SCOPE_
  // INSUFFICIENT) and could only regain them by re-consenting. Caught 2026-08-05 during the
  // GCP project migration. An exact-set assertion, not toContain — toContain is what let the
  // omission through in the first place.
  it("grants EXACTLY the same scope set as agent-runtime/bin/oauth-enroll.ts", () => {
    expect([...GOOGLE_SCOPES].sort()).toEqual(
      [
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/drive.readonly", // ORB-286 batch 6: Saga opens Docs links
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
