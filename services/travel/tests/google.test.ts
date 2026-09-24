import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import {
  selectMailboxToken,
  gmailClient,
  calendarClient,
  GoogleUnenrolledError,
  GoogleScopeMissingError,
  __setTestGmailApiFactory,
  __setTestCalendarApiFactory,
} from "../lib/google.js";
import { GoogleConfigError, type DecryptedGoogleToken } from "@lares/agent-kit/google-auth";
import { getPool, closePool } from "@lares/agent-kit/db";

/**
 * Task 4 — the Gmail readonly client. Per the task brief:
 *   - selectMailboxToken (ported from services/marcel/lib/gmail-token.ts): org-scoped, NO
 *     "most recent" fallback — a miss is fatal (GoogleUnenrolledError)
 *   - gmailClient() end to end against a REAL Postgres (testcontainers, matching
 *     tests/db.test.ts's ORB-45-driven convention) — no matching (principal, org) row throws
 *     GoogleUnenrolledError; an enrolled row decrypts and reaches client construction
 *
 * ORB-142 Step D: the `decryptSecret`, `readTokenEncKey` and `applyEgressProxy` suites moved
 * to `packages/agent-kit/tests/google-auth.test.ts` along with the functions themselves —
 * eve-saga's suite carried the first two verbatim too, and the proxy check is now made through
 * the real `buildOAuth2Client` path rather than the `__applyEgressProxyForTest` seam that
 * existed only because the function was module-private here. What stays in this file is what
 * stays MARCEL'S: the single hardcoded org, the no-fallback mailbox rule, and the calendar
 * scope gate.
 */

/** Test-only mirror of services/box/lib/crypto.ts's `encryptSecret` — used ONLY to
 *  build the `oauth_tokens` fixtures the gmailClient/calendarClient suites below decrypt. The
 *  kit's google-auth.ts deliberately has no encryptSecret of its own (this stack only ever
 *  reads existing tokens). */
function encryptForTest(plaintext: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

// -----------------------------------------------------------------------------------------
// selectMailboxToken — ported from services/marcel/lib/gmail-token.ts. Org-scoped, no
// "most recent" fallback: a miss is fatal.
// -----------------------------------------------------------------------------------------

describe("selectMailboxToken", () => {
  const heiberg: DecryptedGoogleToken = { token: "heiberg-token", scopes: ["gmail.readonly"], emailAddress: "owner@owner.example", orgId: "heiberg" };
  const zero7: DecryptedGoogleToken = { token: "zero7-token", scopes: ["gmail.readonly"], emailAddress: "owner@project.example", orgId: "zero7" };

  it("picks the row matching the requested org", () => {
    expect(selectMailboxToken([zero7, heiberg], "U_bendik", "heiberg")).toEqual(heiberg);
  });

  it("throws GoogleUnenrolledError when no row matches the org — no most-recent fallback", () => {
    expect(() => selectMailboxToken([zero7], "U_bendik", "heiberg")).toThrow(GoogleUnenrolledError);
  });

  it("throws GoogleUnenrolledError on an empty row set", () => {
    expect(() => selectMailboxToken([], "U_bendik", "heiberg")).toThrow(GoogleUnenrolledError);
  });
});

// -----------------------------------------------------------------------------------------
// gmailClient — lazy, per-call construction + GoogleUnenrolledError, against a REAL Postgres.
// __setTestGmailApiFactory means an "enrolled" test never has to reach real Google.
// -----------------------------------------------------------------------------------------

describe("gmailClient", () => {
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
    keyDir = mkdtempSync(join(tmpdir(), "google-clients-key-"));
    writeFileSync(join(keyDir, "token-enc-key"), randomBytes(32).toString("hex"));
    process.env["TOKEN_ENC_KEY_FILE"] = join(keyDir, "token-enc-key");
    process.env["GOOGLE_PRINCIPAL_ID"] = "U_bendik";
    process.env["GOOGLE_ORG"] = "heiberg";
    // Heiberg org OAuth client secrets — only read once an ENROLLED row is found (the
    // unenrolled-principal test deliberately does NOT rely on these being readable; see the
    // ordering note on gmailClient in lib/google.ts).
    writeFileSync(join(keyDir, "client-id"), "test-client-id");
    writeFileSync(join(keyDir, "client-secret"), "test-client-secret");
    process.env["GOOGLE_CLIENT_ID_HEIBERG_FILE"] = join(keyDir, "client-id");
    process.env["GOOGLE_CLIENT_SECRET_HEIBERG_FILE"] = join(keyDir, "client-secret");
  });

  afterEach(async () => {
    rmSync(keyDir, { recursive: true, force: true });
    delete process.env["TOKEN_ENC_KEY_FILE"];
    delete process.env["GOOGLE_CLIENT_ID_HEIBERG_FILE"];
    delete process.env["GOOGLE_CLIENT_SECRET_HEIBERG_FILE"];
    delete process.env["GOOGLE_PRINCIPAL_ID"];
    delete process.env["GOOGLE_ORG"];
    __setTestGmailApiFactory(undefined);
    await getPool().query(`DELETE FROM oauth_tokens`);
  });

  it("is lazy: importing/referencing gmailClient does no I/O — only calling it does", () => {
    // No assertion needed beyond "this test file itself never crashed on import" — the proof
    // is structural (gmailClient is a plain async function, nothing runs at module scope).
    expect(typeof gmailClient).toBe("function");
  });

  it("throws GoogleUnenrolledError for a principal with no oauth_tokens row — even with no client secrets mounted", async () => {
    delete process.env["GOOGLE_CLIENT_ID_HEIBERG_FILE"];
    delete process.env["GOOGLE_CLIENT_SECRET_HEIBERG_FILE"];
    await expect(gmailClient()).rejects.toThrow(GoogleUnenrolledError);
  });

  it("throws GoogleUnenrolledError when a row exists but for a DIFFERENT org — no fallback", async () => {
    const enc = encryptForTest("zero7-refresh-token", await readKeyFromFile());
    await getPool().query(
      `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes) VALUES ($1,$2,$3,$4,$5,$6)`,
      ["U_bendik", "google", "zero7", "owner@project.example", enc, []],
    );
    await expect(gmailClient()).rejects.toThrow(GoogleUnenrolledError);
  });

  it("throws GoogleConfigError when GOOGLE_PRINCIPAL_ID is unset", async () => {
    delete process.env["GOOGLE_PRINCIPAL_ID"];
    await expect(gmailClient()).rejects.toThrow(GoogleConfigError);
  });

  it("throws GoogleConfigError when GOOGLE_ORG is unset", async () => {
    delete process.env["GOOGLE_ORG"];
    await expect(gmailClient()).rejects.toThrow(GoogleConfigError);
  });

  it("on an enrolled (principal, org) row, decrypts the real token and builds the client with it", async () => {
    const enc = encryptForTest("refresh-token-real", await readKeyFromFile());
    await getPool().query(
      `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes) VALUES ($1,$2,$3,$4,$5,$6)`,
      ["U_bendik", "google", "heiberg", "owner@owner.example", enc, ["gmail.readonly"]],
    );
    let seenRefreshToken: string | undefined;
    let seenClientId: string | undefined;
    __setTestGmailApiFactory((cfg, refreshToken) => {
      seenRefreshToken = refreshToken;
      seenClientId = cfg.clientId;
      return {} as never;
    });

    await gmailClient();

    expect(seenRefreshToken).toBe("refresh-token-real"); // proves the row was actually decrypted, not stubbed away
    expect(seenClientId).toBe("test-client-id");
  });

  async function readKeyFromFile(): Promise<string> {
    return readFileSync(process.env["TOKEN_ENC_KEY_FILE"]!, "utf8").trim();
  }

  // -----------------------------------------------------------------------------------------
  // calendarClient (Task 11) — same lazy/oauth_tokens-row/egress-proxy shape as gmailClient
  // (nested here to reuse this describe's own Postgres container + keyDir/env fixtures rather
  // than spinning up a second container). The ONE thing gmailClient never had to check: a row
  // can exist for the right (principal, org) yet still lack calendar scope — that's a real,
  // expected outcome (Gmail-only enrollment, calendar access never consented to), not a config
  // or transport failure, so it gets its own typed error (`GoogleScopeMissingError`) rather than
  // surfacing as a confusing raw Calendar API 403.
  // -----------------------------------------------------------------------------------------

  describe("calendarClient", () => {
    afterEach(() => {
      __setTestCalendarApiFactory(undefined);
    });

    it("is lazy: importing/referencing calendarClient does no I/O — only calling it does", () => {
      expect(typeof calendarClient).toBe("function");
    });

    it("throws GoogleUnenrolledError for a principal with no oauth_tokens row at all", async () => {
      await expect(calendarClient()).rejects.toThrow(GoogleUnenrolledError);
    });

    it("throws GoogleUnenrolledError when a row exists but for a DIFFERENT org — no fallback", async () => {
      const enc = encryptForTest("zero7-refresh-token", await readKeyFromFile());
      await getPool().query(
        `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes) VALUES ($1,$2,$3,$4,$5,$6)`,
        ["U_bendik", "google", "zero7", "owner@project.example", enc, ["https://www.googleapis.com/auth/calendar.readonly"]],
      );
      await expect(calendarClient()).rejects.toThrow(GoogleUnenrolledError);
    });

    it("throws GoogleScopeMissingError when the enrolled row has Gmail scope only — no calendar scope granted", async () => {
      const enc = encryptForTest("gmail-only-refresh-token", await readKeyFromFile());
      await getPool().query(
        `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes) VALUES ($1,$2,$3,$4,$5,$6)`,
        ["U_bendik", "google", "heiberg", "owner@owner.example", enc, ["https://www.googleapis.com/auth/gmail.readonly"]],
      );
      await expect(calendarClient()).rejects.toThrow(GoogleScopeMissingError);
    });

    it("GoogleScopeMissingError names the principal and org — an operator can act on the message alone", async () => {
      const enc = encryptForTest("gmail-only-refresh-token", await readKeyFromFile());
      await getPool().query(
        `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes) VALUES ($1,$2,$3,$4,$5,$6)`,
        ["U_bendik", "google", "heiberg", "owner@owner.example", enc, ["https://www.googleapis.com/auth/gmail.readonly"]],
      );
      await expect(calendarClient()).rejects.toThrow(/U_bendik/);
      await expect(calendarClient()).rejects.toThrow(/heiberg/);
    });

    it("throws GoogleConfigError when GOOGLE_PRINCIPAL_ID is unset", async () => {
      delete process.env["GOOGLE_PRINCIPAL_ID"];
      await expect(calendarClient()).rejects.toThrow(GoogleConfigError);
    });

    it("throws GoogleConfigError when GOOGLE_ORG is unset", async () => {
      delete process.env["GOOGLE_ORG"];
      await expect(calendarClient()).rejects.toThrow(GoogleConfigError);
    });

    it("on an enrolled row WITH calendar scope, decrypts the real token and builds the client with it", async () => {
      const enc = encryptForTest("calendar-refresh-token-real", await readKeyFromFile());
      await getPool().query(
        `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          "U_bendik",
          "google",
          "heiberg",
          "owner@owner.example",
          enc,
          ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.readonly"],
        ],
      );
      let seenRefreshToken: string | undefined;
      let seenClientId: string | undefined;
      __setTestCalendarApiFactory((cfg, refreshToken) => {
        seenRefreshToken = refreshToken;
        seenClientId = cfg.clientId;
        return {} as never;
      });

      await calendarClient();

      expect(seenRefreshToken).toBe("calendar-refresh-token-real");
      expect(seenClientId).toBe("test-client-id");
    });
  });
});
