import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import gmailSearch from "../catalogue/gmail_search.js";
import gmailRead from "../catalogue/gmail_read.js";
import gmailSignature from "../catalogue/gmail_signature.js";
import gmailDraft from "../catalogue/gmail_draft.js";
import gmailSend from "../catalogue/gmail_send.js";
import gmailDraftRecipients from "../catalogue/gmail_draft_recipients.js";
import { readFileSync } from "node:fs";
import { __setTestGmailApiFactory, wrapGmailApi } from "../lib/google.js";
import { UnauthorizedApproverError } from "../lib/approvals.js";
import { getPool, closePool } from "@lares/agent-kit/db";
import { payloadFingerprint } from "@lares/agent-kit/approval-ledger";

/**
 * Task 6 — the five Gmail tools, end to end against a REAL Postgres (oauth_tokens, matching
 * tests/google.test.ts's convention) with a STUBBED googleapis client
 * (`__setTestGmailApiFactory`) standing in for Google itself. Proves:
 *   - draft/send refuse without a valid approver, BEFORE any DB lookup or googleapis call
 *     (same rigor as tests/tools-twenty.test.ts's write tools: zero calls on refusal)
 *   - search/read/signature marshal the exact googleapis request shape (via wrapGmailApi,
 *     already unit-proven in tests/google.test.ts) end to end through the tool + adapter
 *   - draft/send, once approved, build the MIME envelope and issue the right call
 */

const BENDIK = "U_EXAMPLE_OWNER";
const SOMEONE_ELSE = "U0BADBADBAD";

function slackAuth(userId: string) {
  return {
    attributes: { user_id: userId, channel_id: "D123", thread_ts: "1.0" },
    authenticator: "slack-webhook",
    principalId: `slack:T1:${userId}`,
    principalType: "user",
  };
}

function ctx(auth: unknown) {
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

const READ_CTX = {} as never;

interface RecordedCall { method: string; params: unknown }

function stubGmailApi(responses: Partial<{
  list: unknown; get: unknown; send: unknown; createDraft: unknown; sendAs: unknown; getDraft: unknown; updateDraft: unknown;
}> = {}) {
  const calls: RecordedCall[] = [];
  const api = {
    users: {
      messages: {
        list: async (params: unknown) => { calls.push({ method: "list", params }); return responses.list ?? { data: { messages: [] } }; },
        get: async (params: unknown) => { calls.push({ method: "get", params }); return responses.get ?? { data: {} }; },
        send: async (params: unknown) => { calls.push({ method: "send", params }); return responses.send ?? { data: { id: "m1", threadId: "t1" } }; },
      },
      drafts: {
        create: async (params: unknown) => { calls.push({ method: "createDraft", params }); return responses.createDraft ?? { data: { id: "d1", message: { id: "m1", threadId: "t1" } } }; },
        get: async (params: unknown) => { calls.push({ method: "getDraft", params }); return responses.getDraft ?? { data: { id: "d1", message: { id: "m1", threadId: "t1", raw: "" } } }; },
        update: async (params: unknown) => { calls.push({ method: "updateDraft", params }); return responses.updateDraft ?? { data: { id: "d1", message: { id: "m2", threadId: "t1" } } }; },
      },
      settings: {
        sendAs: {
          get: async (params: unknown) => { calls.push({ method: "getSignature", params }); return responses.sendAs ?? { data: { signature: "" } }; },
        },
      },
    },
  };
  return { api: api as unknown as Parameters<typeof wrapGmailApi>[0], calls };
}

function encryptForTest(plaintext: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

let container: StartedPostgreSqlContainer;
let keyDir: string;
let testKeyHex: string;

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
  await getPool().query(readFileSync(join(import.meta.dirname, "../../box/sql/008_ratchet.sql"), "utf8"));
  await getPool().query(readFileSync(join(import.meta.dirname, "../../box/sql/038_permissions_board.sql"), "utf8"));
  await getPool().query(readFileSync(join(import.meta.dirname, "../../box/sql/086_approval_asks.sql"), "utf8"));
}, 120_000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

beforeEach(async () => {
  keyDir = mkdtempSync(join(tmpdir(), "gmail-tools-key-"));
  testKeyHex = randomBytes(32).toString("hex");
  writeFileSync(join(keyDir, "token-enc-key"), testKeyHex);
  writeFileSync(join(keyDir, "client-id"), "test-client-id");
  writeFileSync(join(keyDir, "client-secret"), "test-client-secret");
  process.env["TOKEN_ENC_KEY_FILE"] = join(keyDir, "token-enc-key");
  process.env["GOOGLE_CLIENT_ID_HEIBERG_FILE"] = join(keyDir, "client-id");
  process.env["GOOGLE_CLIENT_SECRET_HEIBERG_FILE"] = join(keyDir, "client-secret");
  process.env["GOOGLE_PRINCIPAL_ID"] = "U_bendik";
  process.env["SLACK_ALLOWED_USER_IDS"] = BENDIK;
});

afterEach(async () => {
  rmSync(keyDir, { recursive: true, force: true });
  delete process.env["TOKEN_ENC_KEY_FILE"];
  delete process.env["GOOGLE_CLIENT_ID_HEIBERG_FILE"];
  delete process.env["GOOGLE_CLIENT_SECRET_HEIBERG_FILE"];
  delete process.env["GOOGLE_PRINCIPAL_ID"];
  delete process.env["SLACK_ALLOWED_USER_IDS"];
  __setTestGmailApiFactory(undefined);
  await getPool().query(`DELETE FROM oauth_tokens`);
  await getPool().query(`DELETE FROM approval_asks`);
});

/** Seeds one enrolled mailbox for U_bendik and installs a stub googleapis factory. Returns
 *  the recorded calls array so a test can assert on it. */
async function enroll(responses: Parameters<typeof stubGmailApi>[0] = {}): Promise<RecordedCall[]> {
  const enc = encryptForTest("refresh-token-real", testKeyHex);
  await getPool().query(
    `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes) VALUES ($1,$2,$3,$4,$5,$6)`,
    ["U_bendik", "google", "heiberg", "owner@owner.example", enc, ["gmail.readonly", "gmail.send"]],
  );
  const { api, calls } = stubGmailApi(responses);
  __setTestGmailApiFactory(() => api);
  return calls;
}

// -----------------------------------------------------------------------------------------
// Reads — free, no approval required
// -----------------------------------------------------------------------------------------

describe("gmail_search", () => {
  it("marshals query/max to a single list() call and returns message ids", async () => {
    const calls = await enroll({ list: { data: { messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t1" }] } } });
    const result = await gmailSearch.execute({ query: "in:inbox -from:me", max: 10 }, READ_CTX);
    expect(result).toEqual(["m1", "m2"]);
    expect(calls).toEqual([{ method: "list", params: { userId: "me", q: "in:inbox -from:me", maxResults: 10 } }]);
  });

  it("defaults max to 25 when omitted", async () => {
    const calls = await enroll();
    await gmailSearch.execute({ query: "in:inbox" }, READ_CTX);
    expect((calls[0]!.params as { maxResults: number }).maxResults).toBe(25);
  });
});

describe("gmail_read", () => {
  const RAW = {
    id: "m1", threadId: "t1",
    payload: {
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "owner@owner.example" },
        { name: "Subject", value: "Hello" },
        { name: "Date", value: "Thu, 1 Jan 2026 00:00:00 +0000" },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from("Body text").toString("base64url") },
    },
  };

  it("reads a message and returns from/to/subject/body — the body comes back quoted (W7D-s1, owner decision D2)", async () => {
    const calls = await enroll({ get: { data: RAW } });
    const result = await gmailRead.execute({ id: "m1" }, READ_CTX);
    expect(result).toMatchObject({ id: "m1", threadId: "t1", from: "sender@example.com", subject: "Hello" });
    // Wrapped, not raw — the model is told this is somebody else's words, not an instruction —
    // but every character of the original body still arrives, untouched.
    expect((result as { bodyText: string }).bodyText).not.toBe("Body text");
    expect((result as { bodyText: string }).bodyText).toContain("Body text");
    expect((result as { note: string }).note).toMatch(/somebody else's words/);
    // W7D-s2: the envelope also says whether the sender is someone the owner has written to
    // (owner decision D3) — one extra, bounded lookup on the SAME first-contact check
    // board-approval.ts already uses for sends (`isKnownRecipient`), which searches sent mail
    // for the sender's address once the (here, unreachable in-test) network leg is unavailable.
    expect(calls).toEqual([
      { method: "get", params: { userId: "me", id: "m1", format: "full" } },
      {
        method: "list",
        params: {
          userId: "me",
          q: "in:sent (to:sender@example.com OR cc:sender@example.com OR bcc:sender@example.com)",
          maxResults: 10,
        },
      },
    ]);
  });

  it("returns a typed not-found note for a message with no id, rather than throwing", async () => {
    await enroll({ get: { data: {} } });
    const result = await gmailRead.execute({ id: "nope" }, READ_CTX);
    expect(result).toEqual({ ok: false, reason: "message not found" });
  });
});

describe("gmail_signature", () => {
  it("resolves the mailbox by account and returns its signature", async () => {
    const calls = await enroll({ sendAs: { data: { signature: "<p>— Bendik</p>" } } });
    const result = await gmailSignature.execute({ account: "owner@owner.example" }, READ_CTX);
    expect(result).toEqual({ signatureHtml: "<p>— Bendik</p>" });
    expect(calls).toEqual([{ method: "getSignature", params: { userId: "me", sendAsEmail: "owner@owner.example" } }]);
  });
});

// -----------------------------------------------------------------------------------------
// Draft writes are autonomous by default; sends remain gated.
// -----------------------------------------------------------------------------------------

describe("gmail_draft", () => {
  const INPUT = { from: "owner@owner.example", to: ["someone@example.com"], subject: "Re: hi", bodyText: "Thanks!" };

  it("defaults its draft action to autonomous (no approval card)", async () => {
    expect(gmailDraft.approval).toBeTypeOf("function");
    await expect(gmailDraft.approval!({ toolInput: INPUT } as never)).resolves.toBe("not-applicable");
  });

  it("on a valid approver, builds the MIME envelope and creates the draft", async () => {
    const calls = await enroll({ createDraft: { data: { id: "d1", message: { id: "m1", threadId: "t1" } } } });
    const result = await gmailDraft.execute(INPUT, READ_CTX);
    expect(result).toEqual({ gmailDraftId: "d1", gmailMessageId: "m1", gmailThreadId: "t1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("createDraft");
    const body = (calls[0]!.params as { requestBody: { message: { raw: string } } }).requestBody.message.raw;
    const mime = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(mime).toContain("Subject: Re: hi");
    expect(mime).toContain("Thanks!");
  });
});

describe("gmail_send", () => {
  const INPUT = { from: "owner@owner.example", to: ["someone@example.com"], subject: "Hi", bodyText: "Body" };

  it("declares approval: always()", () => {
    expect(gmailSend.approval).toBeTypeOf("function");
  });

  it("refuses a present-but-unidentified approver context, before any DB lookup or googleapis call", async () => {
    const calls = await enroll();
    await expect(gmailSend.execute(INPUT, ctx({}))).rejects.toThrow(UnauthorizedApproverError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a wrong/cross-channel approver, before any googleapis call", async () => {
    const calls = await enroll();
    await expect(gmailSend.execute(INPUT, ctx(slackAuth(SOMEONE_ELSE)))).rejects.toThrow(UnauthorizedApproverError);
    expect(calls).toHaveLength(0);
  });

  it("on a valid approver, sends the message", async () => {
    const calls = await enroll({ send: { data: { id: "m9", threadId: "t9" } } });
    const result = await gmailSend.execute(INPUT, ctx(slackAuth(BENDIK)));
    expect(result).toEqual({ gmailMessageId: "m9", gmailThreadId: "t9", sentAt: expect.any(String) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("send");
  });

  // ORB-93 — sentAt is what outreach_track anchors reply-detection to; must reflect the
  // actual send (Gmail's internalDate when available), not just "some timestamp."
  it("returns Gmail's own internalDate as sentAt when the response includes it", async () => {
    await enroll({ send: { data: { id: "m9", threadId: "t9", internalDate: "1755331200000" } } });
    const result = await gmailSend.execute(INPUT, ctx(slackAuth(BENDIK)));
    expect(result.sentAt).toBe(new Date(1755331200000).toISOString());
  });

  // W7A-s6 — the approver check and the card check, IN ORDER, against the real ledger table
  // (086, applied in beforeAll above) rather than a fake: `ctxWithCall` gives execute() the
  // toolCallId a real eve run would, so `assertApproval` reaches `assertApprovedCall` for real.
  describe("and checks which card it was shown, after the approver and before any send", () => {
    function ctxWithCall(auth: unknown, toolCallId: string) {
      return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } }, toolCallId } as never;
    }

    // Whoever `beforeEach` above put on the allowlist — read back rather than named again, so
    // this describe's own text carries no fixture identity beyond what the file already set up.
    const allowedApprover = () => process.env["SLACK_ALLOWED_USER_IDS"]!;

    it("the approver check still runs FIRST — an unauthorised approver refuses before the card is even looked up", async () => {
      const calls = await enroll();
      // No approval_asks row exists for this call id at all, so if the card check ran first it
      // would pass silently (no row); the refusal below can only be the approver check.
      await expect(
        gmailSend.execute(INPUT, ctxWithCall(slackAuth(SOMEONE_ELSE), "call-order-1")),
      ).rejects.toThrow(UnauthorizedApproverError);
      expect(calls).toHaveLength(0);
    });

    it("a stale card refuses the send, even for the real allowlisted approver, and sends nothing", async () => {
      const calls = await enroll({ send: { data: { id: "m9", threadId: "t9" } } });
      await getPool().query(
        `INSERT INTO approval_asks (request_id, call_id, agent, tool, payload_hash, asked_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval '25 hours')`,
        ["req-order-2", "call-order-2", "chief-of-staff", "gmail_send", payloadFingerprint("gmail_send", INPUT)],
      );
      await expect(
        gmailSend.execute(INPUT, ctxWithCall(slackAuth(allowedApprover()), "call-order-2")),
      ).rejects.toThrow(/gone stale/);
      expect(calls).toHaveLength(0);
    });

    it("arguments that differ from what the card showed refuse the send too, before any googleapis call", async () => {
      const calls = await enroll({ send: { data: { id: "m9", threadId: "t9" } } });
      await getPool().query(
        `INSERT INTO approval_asks (request_id, call_id, agent, tool, payload_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        ["req-order-3", "call-order-3", "chief-of-staff", "gmail_send", payloadFingerprint("gmail_send", { ...INPUT, subject: "A different subject" })],
      );
      await expect(
        gmailSend.execute(INPUT, ctxWithCall(slackAuth(allowedApprover()), "call-order-3")),
      ).rejects.toThrow(/not what the card showed/);
      expect(calls).toHaveLength(0);
    });

    it("a fresh, matching card still sends — the check is additive, not a new obstacle", async () => {
      const calls = await enroll({ send: { data: { id: "m9", threadId: "t9" } } });
      await getPool().query(
        `INSERT INTO approval_asks (request_id, call_id, agent, tool, payload_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        ["req-order-4", "call-order-4", "chief-of-staff", "gmail_send", payloadFingerprint("gmail_send", INPUT)],
      );
      const result = await gmailSend.execute(INPUT, ctxWithCall(slackAuth(allowedApprover()), "call-order-4"));
      expect(result.gmailMessageId).toBe("m9");
      expect(calls).toHaveLength(1);
    });
  });
});

// -----------------------------------------------------------------------------------------
// gmail_draft_recipients — change who an EXISTING unsent draft goes to
// -----------------------------------------------------------------------------------------

describe("gmail_draft_recipients", () => {
  const RAW =
    "From: owner@owner.example\r\nTo: Stefan <stefan@example.com>\r\nCc: eli@example.no\r\nSubject: Re: Folkepuls\r\n" +
    'MIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\nHei alle,\r\n\r\nTakk for i dag.\r\n';
  const rawB64 = Buffer.from(RAW, "utf8").toString("base64url");
  const getDraft = { data: { id: "d1", message: { id: "m1", threadId: "t1", raw: rawB64 } } };

  beforeAll(async () => {
    // The store the tool resolves a thread through (sql/022 + 034), in this harness's Postgres.
    for (const f of ["../../box/sql/022_email_triage.sql", "../../box/sql/034_email_triage_draft_id.sql"]) {
      await getPool().query(readFileSync(join(import.meta.dirname, f), "utf8"));
    }
  });

  it("defaults its draft-edit action to autonomous (no approval card)", async () => {
    expect(gmailDraftRecipients.approval).toBeTypeOf("function");
    await expect(gmailDraftRecipients.approval!({ toolInput: { draftId: "d1" } } as never)).resolves.toBe("not-applicable");
  });

  it("by draft id: reads the raw draft, rewrites only To/Cc, updates the same draft, keeps the body byte for byte", async () => {
    const calls = await enroll({ getDraft });
    const result = await gmailDraftRecipients.execute(
      { account: "owner@owner.example", draftId: "d1", add: ["Kjetil <kjetil@example.com>"], remove: ["eli@example.no"] },
      READ_CTX,
    );
    expect(result).toEqual({ draftId: "d1", to: ["Stefan <stefan@example.com>", "Kjetil <kjetil@example.com>"], cc: [] });
    const update = calls.find((c) => c.method === "updateDraft")!;
    const body = (update.params as { requestBody: { message: { raw: string; threadId?: string } }; id: string });
    expect(body.id).toBe("d1");
    expect(body.requestBody.message.threadId).toBe("t1");
    const sent = Buffer.from(body.requestBody.message.raw, "base64url").toString("utf8");
    expect(sent).toContain("To: Stefan <stefan@example.com>, Kjetil <kjetil@example.com>");
    expect(sent).not.toMatch(/^Cc:/m);
    expect(sent.split("\r\n\r\n").slice(1).join("\r\n\r\n")).toBe(RAW.split("\r\n\r\n").slice(1).join("\r\n\r\n"));
  });

  it("by thread: resolves the draft the triage remembered for that thread (sql/034)", async () => {
    const calls = await enroll({ getDraft });
    await getPool().query(
      `INSERT INTO email_triage_processed (principal, mailbox, gmail_message_id, outcome, draft_id, thread_id) VALUES ('fixture-owner', $1,$2,'drafted',$3,$4)
       ON CONFLICT (mailbox, gmail_message_id) DO UPDATE SET draft_id = EXCLUDED.draft_id, thread_id = EXCLUDED.thread_id`,
      ["owner@owner.example", "m-orig", "d1", "t1"],
    );
    const result = await gmailDraftRecipients.execute({ account: "owner@owner.example", threadId: "t1", add: ["k@x.no"] }, READ_CTX);
    expect(result.draftId).toBe("d1");
    expect(calls.map((c) => c.method)).toEqual(["getDraft", "updateDraft"]);
  });

  it("says so when no draft is known for the thread, and calls Gmail not at all", async () => {
    const calls = await enroll({ getDraft });
    await expect(gmailDraftRecipients.execute({ account: "owner@owner.example", threadId: "t-unknown", add: ["k@x.no"] }, ctx(slackAuth(BENDIK))))
      .rejects.toThrow(/no draft/i);
    expect(calls).toHaveLength(0);
  });
});
