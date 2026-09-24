import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { storeToken, getDecryptedRefreshToken, listDecryptedRefreshTokens, listTokens, deleteToken } from "../lib/oauth-tokens.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";

const KEY = "0".repeat(64);
let tdb: TestDb; let db: Pool;
beforeAll(async () => { tdb = await startTestDb(); db = tdb.pool; }, 120_000);
afterAll(async () => { await tdb?.stop(); });

describe("oauth-tokens", () => {
  it("stores an encrypted token and reads it back decrypted", async () => {
    await storeToken(db, KEY, { principal: "U_bendik", provider: "google", orgId: "heiberg", emailAddress: "owner@owner.example", scopes: ["gmail.send"], refreshToken: "rt-123" });
    const got = await getDecryptedRefreshToken(db, KEY, "U_bendik", "google");
    expect(got?.token).toBe("rt-123");
    expect(got?.emailAddress).toBe("owner@owner.example");
    expect(got?.scopes).toEqual(["gmail.send"]);
  });
  it("never stores the plaintext token", async () => {
    await storeToken(db, KEY, { principal: "U_x", provider: "google", orgId: "heiberg", emailAddress: "x@h.co", scopes: [], refreshToken: "PLAINTEXT-SECRET" });
    const { rows } = await db.query<{ refresh_token_enc: string }>("SELECT refresh_token_enc FROM oauth_tokens WHERE principal='U_x'");
    expect(rows[0].refresh_token_enc).not.toContain("PLAINTEXT-SECRET");
  });
  it("upserts on (principal, provider, email_address)", async () => {
    await storeToken(db, KEY, { principal: "U_up", provider: "google", orgId: "heiberg", emailAddress: "a@h.co", scopes: [], refreshToken: "old" });
    await storeToken(db, KEY, { principal: "U_up", provider: "google", orgId: "heiberg", emailAddress: "a@h.co", scopes: [], refreshToken: "new" });
    expect((await getDecryptedRefreshToken(db, KEY, "U_up", "google"))?.token).toBe("new");
    expect((await listTokens(db, "google")).filter((t) => t.principal === "U_up")).toHaveLength(1);
  });

  it("holds multiple accounts per principal, keyed by email", async () => {
    await storeToken(db, KEY, { principal: "U_multi", provider: "google", orgId: "heiberg", emailAddress: "owner@owner.example", scopes: [], refreshToken: "rt-h" });
    await storeToken(db, KEY, { principal: "U_multi", provider: "google", orgId: "zero7",  emailAddress: "owner@project.example",  scopes: [], refreshToken: "rt-z" });
    const all = await listDecryptedRefreshTokens(db, KEY, "U_multi", "google");
    expect(all.map((t) => t.emailAddress)).toEqual(["owner@owner.example", "owner@project.example"]);
    expect(all.find((t) => t.orgId === "zero7")?.token).toBe("rt-z");
  });

  it("re-enrolling the SAME email upserts (no duplicate row)", async () => {
    await storeToken(db, KEY, { principal: "U_re", provider: "google", orgId: "heiberg", emailAddress: "a@h.co", scopes: [], refreshToken: "old" });
    await storeToken(db, KEY, { principal: "U_re", provider: "google", orgId: "heiberg", emailAddress: "a@h.co", scopes: [], refreshToken: "new" });
    const all = await listDecryptedRefreshTokens(db, KEY, "U_re", "google");
    expect(all).toHaveLength(1);
    expect(all[0].token).toBe("new");
  });
  it("listTokens returns no secret material", async () => {
    const list = await listTokens(db, "google");
    expect(JSON.stringify(list)).not.toContain("rt-123");
  });
  it("returns null for an unknown principal and deletes", async () => {
    expect(await getDecryptedRefreshToken(db, KEY, "nobody", "google")).toBeNull();
    await deleteToken(db, "U_x", "google");
    expect(await getDecryptedRefreshToken(db, KEY, "U_x", "google")).toBeNull();
  });
});
