import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import {
  wrapGmailApi,
  googleClients, listEnrolledMailboxes,
  GoogleUnenrolledError,
  __setTestGmailApiFactory,
} from "../lib/google.js";
import { GoogleConfigError } from "@lares/agent-kit/google-auth";
import { getPool, closePool } from "@lares/agent-kit/db";

/**
 * Task 6 — the Google OAuth stack. Per the task brief:
 *   - an unenrolled principal → GoogleUnenrolledError, proven against a REAL Postgres
 *     (testcontainers, matching tests/db.test.ts's ORB-45-driven convention — a fake Pool
 *     that never executes SQL is exactly the defect class this house avoids)
 *   - wrapGmailApi marshals the googleapis params (userId/q/maxResults/format/raw/…) exactly,
 *     proven against a stub `google.gmail()`-shaped object — no network, no DB
 *
 * ORB-142 Step D: the `decryptSecret` and `readTokenEncKey` suites that used to open this file
 * moved to `packages/agent-kit/tests/google-auth.test.ts` along with the functions themselves
 * — they were duplicated verbatim in eve-marcel's suite too, and are now covered once. What
 * stays here is what stays SAGA'S: the two-org registry, the mailbox-selection policy (the
 * `GMAIL_PRIMARY_EMAIL` pin and the most-recently-updated fallback behind it), and the
 * capability adapter.
 */

/** Test-only mirror of services/box/lib/crypto.ts's `encryptSecret` — used ONLY to
 *  build the `oauth_tokens` fixtures the googleClients suite below decrypts. The kit's
 *  google-auth.ts deliberately has no encryptSecret of its own (this stack only ever reads
 *  existing tokens). */
function encryptForTest(plaintext: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

// -----------------------------------------------------------------------------------------
// wrapGmailApi — marshals googleapis params exactly as the old adapter did. Stub api only;
// no network, no DB.
// -----------------------------------------------------------------------------------------

interface RecordedCall { method: string; params: unknown }

function stubGmailApi(responses: Partial<{
  list: unknown; get: unknown; send: unknown; createDraft: unknown; sendAs: unknown; threadsGet: unknown;
}> = {}) {
  const calls: RecordedCall[] = [];
  const api = {
    users: {
      messages: {
        list: async (params: unknown) => {
          calls.push({ method: "list", params });
          return responses.list ?? { data: { messages: [] } };
        },
        get: async (params: unknown) => {
          calls.push({ method: "get", params });
          return responses.get ?? { data: {} };
        },
        send: async (params: unknown) => {
          calls.push({ method: "send", params });
          return responses.send ?? { data: { id: "m1", threadId: "t1" } };
        },
      },
      drafts: {
        create: async (params: unknown) => {
          calls.push({ method: "createDraft", params });
          return responses.createDraft ?? { data: { id: "d1", message: { id: "m1", threadId: "t1" } } };
        },
      },
      threads: {
        get: async (params: unknown) => {
          calls.push({ method: "threadsGet", params });
          return responses.threadsGet ?? { data: { messages: [] } };
        },
      },
      settings: {
        sendAs: {
          get: async (params: unknown) => {
            calls.push({ method: "getSignature", params });
            return responses.sendAs ?? { data: { signature: "" } };
          },
        },
      },
    },
  };
  return { api: api as unknown as Parameters<typeof wrapGmailApi>[0], calls };
}

describe("wrapGmailApi", () => {
  it("list: userId 'me', q, maxResults — exactly, no pageToken/threadId leakage", async () => {
    const { api, calls } = stubGmailApi();
    await wrapGmailApi(api).list({ q: "in:inbox -from:me", maxResults: 25 });
    expect(calls).toEqual([{ method: "list", params: { userId: "me", q: "in:inbox -from:me", maxResults: 25 } }]);
  });

  it("get: userId 'me', id, format 'full'", async () => {
    const { api, calls } = stubGmailApi();
    await wrapGmailApi(api).get("msg123");
    expect(calls).toEqual([{ method: "get", params: { userId: "me", id: "msg123", format: "full" } }]);
  });

  it("send: userId 'me', requestBody { raw, threadId }", async () => {
    const { api, calls } = stubGmailApi();
    await wrapGmailApi(api).send("BASE64RAW", "thread1");
    expect(calls).toEqual([{ method: "send", params: { userId: "me", requestBody: { raw: "BASE64RAW", threadId: "thread1" } } }]);
  });

  // ORB-93 — outreach_track used to timestamp a send at TRACK time (a separate, later tool
  // call), so a very fast reply could arrive before that recorded time and never match the
  // reply-detection filter. send() now surfaces a `sentAt` the caller can pass straight
  // through to outreach_track.
  describe("send — sentAt", () => {
    it("uses Gmail's own internalDate when the response includes it", async () => {
      const { api } = stubGmailApi({ send: { data: { id: "m1", threadId: "t1", internalDate: "1755331200000" } } });
      const result = await wrapGmailApi(api).send("BASE64RAW", "thread1");
      expect(result.sentAt).toBe(new Date(1755331200000).toISOString());
    });

    it("falls back to the moment the call resolved when internalDate is absent", async () => {
      const { api } = stubGmailApi({ send: { data: { id: "m1", threadId: "t1" } } });
      const before = Date.now();
      const result = await wrapGmailApi(api).send("BASE64RAW", "thread1");
      const parsed = Date.parse(result.sentAt);
      expect(parsed).toBeGreaterThanOrEqual(before);
      expect(parsed).toBeLessThanOrEqual(Date.now());
    });
  });

  it("createDraft: userId 'me', requestBody { message: { raw, threadId } }", async () => {
    const { api, calls } = stubGmailApi();
    await wrapGmailApi(api).createDraft("BASE64RAW", "thread1");
    expect(calls).toEqual([{ method: "createDraft", params: { userId: "me", requestBody: { message: { raw: "BASE64RAW", threadId: "thread1" } } } }]);
  });

  it("getSignature: userId 'me', sendAsEmail", async () => {
    const { api, calls } = stubGmailApi({ sendAs: { data: { signature: "<p>Bendik</p>" } } });
    const sig = await wrapGmailApi(api).getSignature("owner@owner.example");
    expect(calls).toEqual([{ method: "getSignature", params: { userId: "me", sendAsEmail: "owner@owner.example" } }]);
    expect(sig).toBe("<p>Bendik</p>");
  });

  // ORB-92 — hasDraftForThread used to be one unpaginated drafts.list(maxResults: 100) page
  // checked for a matching threadId, so dedup silently broke past ~100 total mailbox drafts
  // regardless of relevance. Now scoped to THIS thread via threads.get + a DRAFT label check.
  describe("hasDraftForThread", () => {
    it("true when a message in the thread carries the DRAFT label", async () => {
      const { api, calls } = stubGmailApi({
        threadsGet: { data: { messages: [{ id: "m1", labelIds: ["SENT"] }, { id: "m2", labelIds: ["DRAFT"] }] } },
      });
      await expect(wrapGmailApi(api).hasDraftForThread("t1")).resolves.toBe(true);
      expect(calls).toEqual([{ method: "threadsGet", params: { userId: "me", id: "t1", format: "minimal" } }]);
    });

    it("false when no message in the thread carries the DRAFT label", async () => {
      const { api } = stubGmailApi({
        threadsGet: { data: { messages: [{ id: "m1", labelIds: ["INBOX"] }] } },
      });
      await expect(wrapGmailApi(api).hasDraftForThread("t1")).resolves.toBe(false);
    });

    it("false on a thread with no messages", async () => {
      const { api } = stubGmailApi({ threadsGet: { data: {} } });
      await expect(wrapGmailApi(api).hasDraftForThread("t1")).resolves.toBe(false);
    });

    // The regression this fixes: this exact behavior is INDEPENDENT of how many drafts
    // exist elsewhere in the mailbox — there is no pagination to exhaust, because the call
    // is scoped to the one thread being checked.
    it("is unaffected by how many other drafts exist in the mailbox — no pagination to exceed", async () => {
      const { api } = stubGmailApi({
        threadsGet: { data: { messages: [{ id: "m1", labelIds: ["DRAFT"] }] } },
      });
      await expect(wrapGmailApi(api).hasDraftForThread("t1")).resolves.toBe(true);
    });
  });
});

// -----------------------------------------------------------------------------------------
// googleClients — laziness + GoogleUnenrolledError, against a REAL Postgres. Nothing here
// touches Google: __setTestGmailApiFactory means an "enrolled" test never has to.
// -----------------------------------------------------------------------------------------

describe("googleClients", () => {
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
    // Heiberg org secrets — only needed once an ENROLLED principal's row is found (the
    // unenrolled-principal tests deliberately do NOT rely on these being readable; see the
    // ordering note on resolveGmailApi in lib/google.ts).
    writeFileSync(join(keyDir, "client-id"), "test-client-id");
    writeFileSync(join(keyDir, "client-secret"), "test-client-secret");
    process.env["GOOGLE_CLIENT_ID_HEIBERG_FILE"] = join(keyDir, "client-id");
    process.env["GOOGLE_CLIENT_SECRET_HEIBERG_FILE"] = join(keyDir, "client-secret");
    // Zero7 org secrets — ORB-75/76 (2026-08-16): both mailboxes are addressable now, caller
    // picks per-call. Mounted here so most tests exercise the normal (both-orgs-configured)
    // deployment; the "zero7 secrets not mounted" test below deletes these first.
    writeFileSync(join(keyDir, "zero7-client-id"), "test-zero7-client-id");
    writeFileSync(join(keyDir, "zero7-client-secret"), "test-zero7-client-secret");
    process.env["GOOGLE_CLIENT_ID_ZERO7_FILE"] = join(keyDir, "zero7-client-id");
    process.env["GOOGLE_CLIENT_SECRET_ZERO7_FILE"] = join(keyDir, "zero7-client-secret");
  });

  afterEach(async () => {
    rmSync(keyDir, { recursive: true, force: true });
    delete process.env["TOKEN_ENC_KEY_FILE"];
    delete process.env["GOOGLE_CLIENT_ID_HEIBERG_FILE"];
    delete process.env["GOOGLE_CLIENT_SECRET_HEIBERG_FILE"];
    delete process.env["GOOGLE_CLIENT_ID_ZERO7_FILE"];
    delete process.env["GOOGLE_CLIENT_SECRET_ZERO7_FILE"];
    delete process.env["GOOGLE_PRINCIPAL_ID"];
    __setTestGmailApiFactory(undefined);
    await getPool().query(`DELETE FROM oauth_tokens`);
  });

  it("is lazy: constructing the client does no I/O at all", () => {
    // No TOKEN_ENC_KEY_FILE, no DATABASE_URL row, nothing set up beyond the container —
    // calling googleClients() itself must not throw or touch anything.
    delete process.env["TOKEN_ENC_KEY_FILE"];
    expect(() => googleClients("nobody")).not.toThrow();
  });

  it("throws GoogleUnenrolledError for a principal with no oauth_tokens row — even with no client secrets mounted", async () => {
    // Deliberately no GOOGLE_CLIENT_ID_HEIBERG_FILE/GOOGLE_CLIENT_SECRET_HEIBERG_FILE set —
    // an unenrolled principal must surface AS unenrolled, not as a missing-secret config error.
    await expect(googleClients("nobody@nowhere").gmail()).rejects.toThrow(GoogleUnenrolledError);
  });

  it("GMAIL_PRIMARY_EMAIL pins the default mailbox over the updated_at lottery; explicit account still wins", async () => {
    // 2026-08-16: with two enrolled mailboxes, "most recently updated" is not a reliable
    // default — the env pin is the fix, and stays the fix now that BOTH orgs are configured
    // (an explicit account argument overriding the pin must reach the RIGHT org, not just
    // avoid throwing).
    const key = await readKeyFromFile();
    const enc1 = encryptForTest("heiberg-token", key);
    const enc2 = encryptForTest("zero7-token", key);
    await getPool().query(
      `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() - interval '1 day')`,
      ["U_bendik", "google", "heiberg", "owner@owner.example", enc1, []],
    );
    // The zero7 row is NEWER — the lottery would pick it without the pin.
    await getPool().query(
      `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())`,
      ["U_bendik", "google", "zero7", "owner@project.example", enc2, []],
    );
    const seen: Array<{ org: string; token: string }> = [];
    __setTestGmailApiFactory((org, token) => {
      seen.push({ org: org.orgId, token });
      return {} as never;
    });
    try {
      process.env["GMAIL_PRIMARY_EMAIL"] = "owner@owner.example";
      await googleClients("U_bendik").gmail();
      expect(seen).toEqual([{ org: "heiberg", token: "heiberg-token" }]);
      // An explicit account argument overrides the pin and now resolves to the zero7 org's
      // own client config (ORB-75/76: both mailboxes addressable, caller picks per-call).
      await googleClients("U_bendik").gmail("owner@project.example");
      expect(seen).toEqual([
        { org: "heiberg", token: "heiberg-token" },
        { org: "zero7", token: "zero7-token" },
      ]);
    } finally {
      delete process.env["GMAIL_PRIMARY_EMAIL"];
    }
  });

  it("surfaces a clear config error naming the org when that org's secrets aren't mounted", async () => {
    // The safety net for an incomplete deployment: an enrolled zero7 token with no zero7
    // OAuth client secrets mounted must fail loudly and specifically, not silently or with
    // an unrelated error.
    delete process.env["GOOGLE_CLIENT_ID_ZERO7_FILE"];
    delete process.env["GOOGLE_CLIENT_SECRET_ZERO7_FILE"];
    const enc = encryptForTest("zero7-token", await readKeyFromFile());
    await getPool().query(
      `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes) VALUES ($1,$2,$3,$4,$5,$6)`,
      ["U_bendik", "google", "zero7", "owner@project.example", enc, []],
    );
    await expect(googleClients("U_bendik").gmail("owner@project.example")).rejects.toThrow(GoogleConfigError);
  });

  it("throws GoogleUnenrolledError for a specific unenrolled `account` even when the principal has OTHER mailboxes", async () => {
    const enc = encryptForTest("refresh-token", await readKeyFromFile());
    await getPool().query(
      `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes) VALUES ($1,$2,$3,$4,$5,$6)`,
      ["U_bendik", "google", "heiberg", "owner@owner.example", enc, []],
    );
    await expect(googleClients("U_bendik").gmail("someone-else@owner.example")).rejects.toThrow(GoogleUnenrolledError);
  });

  it("uses GOOGLE_PRINCIPAL_ID as-is when no principal is passed — never canonicalised", async () => {
    process.env["GOOGLE_PRINCIPAL_ID"] = "U_bendik";
    await expect(googleClients().gmail()).rejects.toThrow(GoogleUnenrolledError);
    // Proves the lookup ran against "U_bendik" (the channel-address form), not "bendik".
  });

  it("on an enrolled principal, decrypts the real row and builds a working client end to end", async () => {
    const enc = encryptForTest("refresh-token-real", await readKeyFromFile());
    await getPool().query(
      `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes) VALUES ($1,$2,$3,$4,$5,$6)`,
      ["U_bendik", "google", "heiberg", "owner@owner.example", enc, ["gmail.readonly"]],
    );
    let seenRefreshToken: string | undefined;
    __setTestGmailApiFactory((_cfg, refreshToken) => {
      seenRefreshToken = refreshToken;
      const { api } = stubGmailApi({ list: { data: { messages: [{ id: "m1", threadId: "t1" }] } } });
      return api;
    });

    const ids = await (await googleClients("U_bendik").gmail()).search("in:inbox", 25);

    expect(seenRefreshToken).toBe("refresh-token-real"); // proves the row was actually decrypted, not stubbed away
    expect(ids).toEqual(["m1"]);
  });

  it("restricts managed clients and schedules to the selected mailbox and rejects stale authority",async()=>{
    const db=getPool(),inc='11111111-1111-4111-8111-111111111111',rev='22222222-2222-4222-8222-222222222222';
    await db.query(`CREATE TABLE agent_resources(name text,ownership_token uuid,runtime_control_token uuid,pending boolean,state text);
      CREATE TABLE agent_doors(agent text,kind text,enabled boolean);CREATE TABLE agent_definitions(name text,status text);
      CREATE TABLE agent_door_connections(agent text,incarnation uuid,kind text,principal text,org text,mailbox text,revision uuid,applied_revision uuid);
      INSERT INTO agent_resources VALUES('managed','${inc}','${inc}',false,'ready');INSERT INTO agent_doors VALUES('managed','email',true);
      INSERT INTO agent_definitions VALUES('managed','valid');INSERT INTO agent_door_connections VALUES('managed','${inc}','email','explicit-owner','tenant','selected@example.test','${rev}','${rev}')`);
    const vars={LARES_AGENT_NAME:'managed',LARES_AGENT_INCARNATION:inc,LARES_EMAIL_PRINCIPAL:'explicit-owner',LARES_EMAIL_ORG:'tenant',LARES_EMAIL_MAILBOX:'selected@example.test',LARES_EMAIL_CLAIM_REVISION:rev,LARES_GOOGLE_CLIENT_ID_FILE:join(keyDir,'client-id'),LARES_GOOGLE_CLIENT_SECRET_FILE:join(keyDir,'client-secret'),GOOGLE_PRINCIPAL_ID:'explicit-owner'};
    const prior=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));Object.assign(process.env,vars);
    try {
      const enc=encryptForTest('selected-token',await readKeyFromFile());
      await db.query(`INSERT INTO oauth_tokens(principal,provider,org_id,email_address,refresh_token_enc)VALUES('explicit-owner','google','tenant','selected@example.test',$1),('explicit-owner','google','other','other@example.test','deliberately-not-decryptable')`,[enc]);
      let observed='';__setTestGmailApiFactory((_cfg,token)=>{observed=token;return stubGmailApi().api;});
      expect(await listEnrolledMailboxes()).toEqual(['selected@example.test']);
      await googleClients().gmail();expect(observed).toBe('selected-token');
      await expect(googleClients().gmail('other@example.test')).rejects.toThrow('selected connection');
      await expect(googleClients('other-owner').calendar()).rejects.toThrow('selected connection');
      // Revoke ONLY runtime control: pending=false and the applied email connection stay intact.
      observed='';await db.query('UPDATE agent_resources SET runtime_control_token=NULL');
      await expect(listEnrolledMailboxes()).rejects.toThrow('Email connection is disabled');
      await expect(googleClients().gmail()).rejects.toThrow('Email connection is disabled');
      expect(observed).toBe('');
      // A poisoned selected credential distinguishes authority refusal from token decryption.
      await db.query("UPDATE oauth_tokens SET refresh_token_enc='not-decryptable' WHERE org_id='tenant'");
      await expect(googleClients().gmail()).rejects.toThrow('Email connection is disabled');
      await expect(googleClients().calendar()).rejects.toThrow('Email connection is disabled');
      expect(observed).toBe('');
      await db.query("UPDATE oauth_tokens SET refresh_token_enc=$1 WHERE org_id='tenant'",[enc]);
      await db.query('UPDATE agent_resources SET runtime_control_token=ownership_token');
      expect(await listEnrolledMailboxes()).toEqual(['selected@example.test']);
      await googleClients().gmail();expect(observed).toBe('selected-token');
      await db.query('UPDATE agent_resources SET pending=true');await expect(googleClients().gmail()).rejects.toThrow('awaiting application');
    }finally{for(const [k,v] of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await db.query('DROP TABLE agent_door_connections,agent_definitions,agent_doors,agent_resources');}
  });

  async function readKeyFromFile(): Promise<string> {
    const { readFileSync } = await import("node:fs");
    return readFileSync(process.env["TOKEN_ENC_KEY_FILE"]!, "utf8").trim();
  }
});
