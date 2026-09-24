import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import {
  GoogleConfigError,
  buildOAuth2Client,
  decryptSecret,
  getMostRecentRefreshToken,
  listDecryptedRefreshTokens,
  readSecretFile,
  readTokenEncKey,
} from "../src/google-auth.js";
import { getPool, closePool } from "../src/db.js";

/**
 * ORB-142 Step D — the Google auth PLUMBING, shared by eve-saga and eve-marcel.
 *
 * The `decryptSecret` and `readTokenEncKey` suites below are the coverage that previously
 * lived — identically — in BOTH `services/chief-of-staff/tests/google.test.ts` and
 * `services/travel/tests/google.test.ts`, moved here once rather than left duplicated.
 * The egress-proxy suite is eve-marcel's (eve-saga had none), now exercised through the real
 * `buildOAuth2Client` path rather than the `__applyEgressProxyForTest` seam it needed when the
 * function was module-private.
 *
 * What is deliberately NOT tested here, because it deliberately does not live here: which org
 * a token belongs to, which mailbox a caller should pick, and whether a token carries calendar
 * scope. Those are per-agent least-privilege policy and stay covered by each agent's own
 * suite.
 */

// -----------------------------------------------------------------------------------------
// decryptSecret — AES-256-GCM round trip against a locally-encrypted fixture
// -----------------------------------------------------------------------------------------

/** Test-only mirror of services/box/lib/crypto.ts's `encryptSecret` — used ONLY to
 *  build fixtures for decryptSecret to decrypt. google-auth.ts deliberately has no
 *  encryptSecret of its own (this stack only ever reads existing tokens). */
function encryptForTest(plaintext: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

describe("decryptSecret", () => {
  it("round-trips a refresh token against a fixture encrypted with the same algorithm", () => {
    const key = randomBytes(32).toString("hex");
    const encoded = encryptForTest("1//0gRefreshTokenFixtureValue", key);
    expect(decryptSecret(encoded, key)).toBe("1//0gRefreshTokenFixtureValue");
  });

  it("throws GoogleConfigError on a malformed key (not 64 hex chars)", () => {
    const encoded = encryptForTest("x", randomBytes(32).toString("hex"));
    expect(() => decryptSecret(encoded, "too-short")).toThrow(GoogleConfigError);
  });

  it("throws (auth tag mismatch) when decrypted with the WRONG key — never silently returns garbage", () => {
    const rightKey = randomBytes(32).toString("hex");
    const wrongKey = randomBytes(32).toString("hex");
    const encoded = encryptForTest("secret-value", rightKey);
    expect(() => decryptSecret(encoded, wrongKey)).toThrow();
  });
});

// -----------------------------------------------------------------------------------------
// readTokenEncKey — the TOKEN_ENC_KEY_FILE docker-secret convention, read lazily at CALL time
// -----------------------------------------------------------------------------------------

describe("readTokenEncKey", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "google-key-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env["TOKEN_ENC_KEY_FILE"];
  });

  it("throws GoogleConfigError when the file does not exist — a clear error, not a boot crash", () => {
    process.env["TOKEN_ENC_KEY_FILE"] = join(dir, "does-not-exist");
    expect(() => readTokenEncKey()).toThrow(GoogleConfigError);
  });

  it("throws GoogleConfigError when the file's contents aren't 64 hex chars", () => {
    const path = join(dir, "token-enc-key");
    writeFileSync(path, "not-a-valid-hex-key\n");
    process.env["TOKEN_ENC_KEY_FILE"] = path;
    expect(() => readTokenEncKey()).toThrow(GoogleConfigError);
  });

  it("reads and trims a valid key", () => {
    const key = randomBytes(32).toString("hex");
    const path = join(dir, "token-enc-key");
    writeFileSync(path, `${key}\n`);
    process.env["TOKEN_ENC_KEY_FILE"] = path;
    expect(readTokenEncKey()).toBe(key);
  });

  it("defaults to /run/secrets/token-enc-key when TOKEN_ENC_KEY_FILE is unset", () => {
    delete process.env["TOKEN_ENC_KEY_FILE"];
    // The default path won't exist in a test sandbox — proves the DEFAULT is exercised (not
    // that TOKEN_ENC_KEY_FILE silently fell back to something else) by asserting the failure
    // names that exact path.
    expect(() => readTokenEncKey()).toThrow(/\/run\/secrets\/token-enc-key/);
  });
});

// -----------------------------------------------------------------------------------------
// readSecretFile — the generic "env var names a file, else this default" secret read. It
// never knows what the secret IS: the caller supplies the env var, the default path, and the
// label that ends up in the error message. That is what keeps org identity out of the kit.
// -----------------------------------------------------------------------------------------

describe("readSecretFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "google-secret-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env["SOME_CLIENT_ID_FILE"];
  });

  it("reads and trims the file named by the env var", () => {
    const path = join(dir, "client-id");
    writeFileSync(path, "  the-client-id\n");
    process.env["SOME_CLIENT_ID_FILE"] = path;
    expect(readSecretFile("SOME_CLIENT_ID_FILE", "/run/secrets/unused", "label")).toBe("the-client-id");
  });

  it("falls back to the default path when the env var is unset, and names it in the error", () => {
    delete process.env["SOME_CLIENT_ID_FILE"];
    expect(() => readSecretFile("SOME_CLIENT_ID_FILE", join(dir, "absent"), "Google client id (someorg)")).toThrow(
      /Google client id \(someorg\) not readable/,
    );
  });

  it("throws GoogleConfigError on an EMPTY file — a mounted-but-blank secret is not a valid secret", () => {
    const path = join(dir, "client-secret");
    writeFileSync(path, "   \n");
    process.env["SOME_CLIENT_ID_FILE"] = path;
    expect(() => readSecretFile("SOME_CLIENT_ID_FILE", "/run/secrets/unused", "Google client secret (someorg)")).toThrow(
      /file is empty/,
    );
  });
});

// -----------------------------------------------------------------------------------------
// buildOAuth2Client — the authenticated client factory. Proven against a REAL
// `google.auth.OAuth2` instance (not a hand-shaped stub), so a shape drift in
// google-auth-library's own transporter fails this test rather than passing silently while
// every sealed-egress call is dropped by the firewall in production.
// -----------------------------------------------------------------------------------------

interface ProxyProbe { transporter: { defaults: { proxy?: string } } }

describe("buildOAuth2Client", () => {
  afterEach(() => {
    delete process.env["EGRESS_PROXY_URL"];
  });

  it("sets the refresh token on the returned client's credentials", () => {
    const auth = buildOAuth2Client({ clientId: "id", clientSecret: "secret" }, "1//0gRefresh");
    expect(auth.credentials.refresh_token).toBe("1//0gRefresh");
  });

  it("pins transporter.defaults.proxy when EGRESS_PROXY_URL is set", () => {
    process.env["EGRESS_PROXY_URL"] = "http://slack-proxy:8888";
    const auth = buildOAuth2Client({ clientId: "id", clientSecret: "secret" }, "rt");
    expect((auth as unknown as ProxyProbe).transporter.defaults.proxy).toBe("http://slack-proxy:8888");
  });

  it("leaves the transporter untouched when EGRESS_PROXY_URL is unset", () => {
    delete process.env["EGRESS_PROXY_URL"];
    const auth = buildOAuth2Client({ clientId: "id", clientSecret: "secret" }, "rt");
    expect((auth as unknown as ProxyProbe).transporter.defaults.proxy).toBeUndefined();
  });

  it("carries an explicit redirectUri through (eve-saga's shape) and omits it otherwise (eve-marcel's)", () => {
    const withUri = buildOAuth2Client({ clientId: "id", clientSecret: "secret", redirectUri: "https://example/cb" }, "rt");
    expect((withUri as unknown as { redirectUri?: string }).redirectUri).toBe("https://example/cb");
    const withoutUri = buildOAuth2Client({ clientId: "id", clientSecret: "secret" }, "rt");
    expect((withoutUri as unknown as { redirectUri?: string }).redirectUri).toBeUndefined();
  });

  it("returns only an OAuth2Client — never a Gmail or Calendar API object", () => {
    // The structural half of this module's least-privilege ceiling: turning this into a live
    // API surface takes an agent-local `google.gmail(...)`/`google.calendar(...)` call that
    // this package does not make. If a future change adds one, this assertion fails.
    const auth = buildOAuth2Client({ clientId: "id", clientSecret: "secret" }, "rt") as unknown as Record<string, unknown>;
    expect(auth["users"]).toBeUndefined();
    expect(auth["events"]).toBeUndefined();
    expect(typeof auth["setCredentials"]).toBe("function");
  });
});

// -----------------------------------------------------------------------------------------
// The oauth_tokens reads, against a REAL Postgres (testcontainers, matching db.test.ts's
// ORB-45-driven convention — a fake Pool that never executes SQL is exactly the
// "built+tested+non-functional" defect class this house avoids).
// -----------------------------------------------------------------------------------------

describe("oauth_tokens reads", () => {
  let container: StartedPostgreSqlContainer;
  let keyDir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    process.env["DATABASE_URL"] = container.getConnectionUri();
    await getPool().query(`
      CREATE TABLE oauth_tokens (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        principal          text        NOT NULL,
        provider           text        NOT NULL,
        org_id             text        NOT NULL,
        email_address      text        NOT NULL,
        refresh_token_enc  text        NOT NULL,
        scopes             text[]      NOT NULL DEFAULT '{}',
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT oauth_tokens_principal_provider_email_uk UNIQUE (principal, provider, email_address)
      )
    `);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  beforeEach(() => {
    keyDir = mkdtempSync(join(tmpdir(), "google-auth-key-"));
    writeFileSync(join(keyDir, "token-enc-key"), randomBytes(32).toString("hex"));
    process.env["TOKEN_ENC_KEY_FILE"] = join(keyDir, "token-enc-key");
  });

  afterEach(async () => {
    rmSync(keyDir, { recursive: true, force: true });
    delete process.env["TOKEN_ENC_KEY_FILE"];
    await getPool().query(`DELETE FROM oauth_tokens`);
  });

  function key(): string {
    return readFileSync(process.env["TOKEN_ENC_KEY_FILE"]!, "utf8").trim();
  }

  async function insert(opts: { org: string; email: string; token: string; provider?: string; updatedAt?: string; scopes?: string[] }): Promise<void> {
    await getPool().query(
      `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, ${opts.updatedAt ?? "now()"})`,
      ["U_bendik", opts.provider ?? "google", opts.org, opts.email, encryptForTest(opts.token, key()), opts.scopes ?? []],
    );
  }

  describe("listDecryptedRefreshTokens", () => {
    it("returns every enrolled mailbox, decrypted, ordered by email address", async () => {
      await insert({ org: "zero7", email: "owner@project.example", token: "zero7-token" });
      await insert({ org: "heiberg", email: "owner@owner.example", token: "heiberg-token" });
      const rows = await listDecryptedRefreshTokens("U_bendik", "google");
      expect(rows).toEqual([
        { token: "heiberg-token", scopes: [], emailAddress: "owner@owner.example", orgId: "heiberg" },
        { token: "zero7-token", scopes: [], emailAddress: "owner@project.example", orgId: "zero7" },
      ]);
    });

    it("carries the scopes column through untouched — the caller decides what a scope means", async () => {
      await insert({ org: "heiberg", email: "owner@owner.example", token: "t", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] });
      const rows = await listDecryptedRefreshTokens("U_bendik", "google");
      expect(rows[0]?.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    });

    it("is scoped by PROVIDER, which is a parameter — never pinned to one agent's provider string", async () => {
      await insert({ org: "heiberg", email: "owner@owner.example", token: "google-token", provider: "google" });
      await insert({ org: "heiberg", email: "owner@owner.example", token: "other-token", provider: "someother" });
      await expect(listDecryptedRefreshTokens("U_bendik", "google")).resolves.toEqual([
        { token: "google-token", scopes: [], emailAddress: "owner@owner.example", orgId: "heiberg" },
      ]);
      await expect(listDecryptedRefreshTokens("U_bendik", "someother")).resolves.toEqual([
        { token: "other-token", scopes: [], emailAddress: "owner@owner.example", orgId: "heiberg" },
      ]);
    });

    it("returns an empty array for an unenrolled principal — never throws", async () => {
      await expect(listDecryptedRefreshTokens("nobody", "google")).resolves.toEqual([]);
    });
  });

  describe("getMostRecentRefreshToken", () => {
    it("returns the most-recently-updated row", async () => {
      await insert({ org: "heiberg", email: "owner@owner.example", token: "older", updatedAt: "now() - interval '1 day'" });
      await insert({ org: "zero7", email: "owner@project.example", token: "newer", updatedAt: "now()" });
      const row = await getMostRecentRefreshToken("U_bendik", "google");
      expect(row?.token).toBe("newer");
      expect(row?.orgId).toBe("zero7");
    });

    it("returns null (not an error) when the principal has no row — turning that into an error is the CALLER's policy", async () => {
      await expect(getMostRecentRefreshToken("nobody", "google")).resolves.toBeNull();
    });
  });

  it("reads the token-enc-key at CALL time, not module load — a bad key fails the query, not the import", async () => {
    await insert({ org: "heiberg", email: "owner@owner.example", token: "t" });
    process.env["TOKEN_ENC_KEY_FILE"] = join(keyDir, "nope");
    await expect(listDecryptedRefreshTokens("U_bendik", "google")).rejects.toThrow(GoogleConfigError);
  });
});
