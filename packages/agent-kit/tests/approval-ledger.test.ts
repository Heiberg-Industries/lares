import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  answeredVia, approvalLedger, askForCall, payloadFingerprint, recordAnswer, recordAsk,
  recordCardOrigin, recordCardPosted, recordQuestion, recordQuestionEnd,
  resetApprovalLedgerWarningForTests,
} from "../src/approval-ledger.js";
import { readApprovalCounts } from "../src/approval-stats.js";
import { closePool } from "../src/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const SQL = join(here, "..", "..", "..", "services", "box", "sql", "001_baseline.sql");

let container: StartedPostgreSqlContainer;
let db: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  db = new Pool({ connectionString: container.getConnectionUri() });
  // A Pool with no 'error' listener turns a stopped container's
  // idle-client error into an uncaught exception that fails the run. Register both, the way
  // services/box/tests/helpers/three-spellings.ts's startThreeSpellingsDb does.
  db.on("error", () => undefined);
  db.on("connect", (client) => client.on("error", () => undefined));
  await db.query(readFileSync(SQL, "utf8"));
  await db.query(readFileSync(SQL.replace("001_baseline", "038_approval_card_record"), "utf8"));
  // `approvalLedger()` builds its own pool, lazily, off DATABASE_URL — point it at the same
  // disposable database so its `markUsed` can be exercised against real Postgres.
  process.env["DATABASE_URL"] = container.getConnectionUri();
}, 120_000);
afterAll(async () => {
  await closePool();
  delete process.env["DATABASE_URL"];
  await db.end();
  await container.stop();
});
beforeEach(async () => { await db.query("TRUNCATE approval_asks"); resetApprovalLedgerWarningForTests(); });

const ask = { requestId: "req-1", callId: "call-1", agent: "fixture-agent", tool: "gmail_send", payloadHash: "h" };

describe("the approval ledger", () => {
  it("hashes the call, not the words — the same input hashes the same whatever the key order", () => {
    const a = payloadFingerprint("gmail_send", { to: ["a@x.example"], subject: "Q3" });
    const b = payloadFingerprint("gmail_send", { subject: "Q3", to: ["a@x.example"] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadFingerprint("gmail_send", { to: ["b@x.example"], subject: "Q3" })).not.toBe(a);
    expect(a).not.toContain("Q3");
  });

  it("writes the card down, and reads it back by call id", async () => {
    await recordAsk(db, ask);
    const row = await askForCall(db, "call-1");
    expect(row?.tool).toBe("gmail_send");
    expect(row?.outcome).toBeNull();
    expect(row?.askedAt).toBeInstanceOf(Date);
  });

  it("keeps the first asked_at when the same call is asked again", async () => {
    await recordAsk(db, ask);
    const first = (await askForCall(db, "call-1"))!.askedAt;
    await recordAsk(db, { ...ask, requestId: "req-2" });
    expect((await askForCall(db, "call-1"))!.askedAt).toEqual(first);
  });

  it("records the answer once, and refuses an outcome it does not know", async () => {
    await recordAsk(db, ask);
    await recordAnswer(db, { requestId: "req-1", outcome: "approved", answeredVia: "telegram" });
    const row = await askForCall(db, "call-1");
    expect(row?.outcome).toBe("approved");
    expect(row?.answeredVia).toBe("telegram");
    await expect(
      db.query("UPDATE approval_asks SET outcome = 'maybe' WHERE request_id = 'req-1'"),
    ).rejects.toThrow(/approval_asks_outcome_check/);
  });

  it("answeredVia reads how a card was answered, and is null for no row or no answer", async () => {
    expect(await answeredVia("req-1")).toBeNull();
    await recordAsk(db, ask);
    expect(await answeredVia("req-1")).toBeNull();
    await recordAnswer(db, { requestId: "req-1", outcome: "cancelled", answeredVia: "revised" });
    expect(await answeredVia("req-1")).toBe("revised");
  });

  it("never throws, and never costs the turn, when the table is missing", async () => {
    await db.query("ALTER TABLE approval_asks RENAME TO approval_asks_off");
    await expect(recordAsk(db, ask)).resolves.toBeUndefined();
    await expect(recordAnswer(db, { requestId: "req-1", outcome: "ignored" })).resolves.toBeUndefined();
    await expect(askForCall(db, "call-1")).resolves.toBeNull();
    await db.query("ALTER TABLE approval_asks_off RENAME TO approval_asks");
  });
});

describe("used_at / use_count — counted, never enforced", () => {
  it("a fresh ask has never been used", async () => {
    await recordAsk(db, ask);
    const row = await askForCall(db, "call-1");
    expect(row?.useCount).toBe(0);
    expect(row?.usedAt).toBeNull();
  });

  it("markUsed is one atomic statement: first pass sets useCount 1 and usedAt", async () => {
    await recordAsk(db, ask);
    const ledger = approvalLedger();
    const result = await ledger.markUsed("req-1");
    expect(result?.useCount).toBe(1);
    const row = await askForCall(db, "call-1");
    expect(row?.useCount).toBe(1);
    expect(row?.usedAt).toBeInstanceOf(Date);
  });

  it("a second pass still resolves — useCount 2, usedAt unchanged (first use wins)", async () => {
    await recordAsk(db, ask);
    const ledger = approvalLedger();
    await ledger.markUsed("req-1");
    const usedAtFirst = (await askForCall(db, "call-1"))!.usedAt;

    const second = await ledger.markUsed("req-1");
    expect(second?.useCount).toBe(2);
    const row = await askForCall(db, "call-1");
    expect(row?.useCount).toBe(2);
    expect(row?.usedAt).toEqual(usedAtFirst);
  });

  it("a refused call (expired / payload-changed / not-given) leaves use_count at 0", async () => {
    await recordAsk(db, ask);
    for (const outcome of ["expired", "payload-changed", "cancelled"] as const) {
      await db.query("UPDATE approval_asks SET outcome = NULL, answered_at = NULL WHERE request_id = $1", [
        ask.requestId,
      ]);
      await recordAnswer(db, { requestId: "req-1", outcome });
      const row = await askForCall(db, "call-1");
      expect(row?.useCount, outcome).toBe(0);
      expect(row?.usedAt, outcome).toBeNull();
    }
  });

  it("markUsed on a request id that no longer exists answers null, never throws", async () => {
    const ledger = approvalLedger();
    await expect(ledger.markUsed("no-such-request")).resolves.toBeNull();
  });

  it("two concurrent markUsed calls on the same row are atomic — both land, ending at 2", async () => {
    await recordAsk(db, ask);
    const ledger = approvalLedger();
    const [a, b] = await Promise.all([ledger.markUsed("req-1"), ledger.markUsed("req-1")]);
    expect([a?.useCount, b?.useCount].sort()).toEqual([1, 2]);
    const row = await askForCall(db, "call-1");
    expect(row?.useCount).toBe(2);
  });

  it("readApprovalCounts is unchanged by the new columns", async () => {
    await recordAsk(db, ask);
    await recordAnswer(db, { requestId: "req-1", outcome: "approved", answeredVia: "telegram" });
    const ledger = approvalLedger();
    await ledger.markUsed("req-1");
    await ledger.markUsed("req-1");
    const counts = await readApprovalCounts(db);
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({
      agent: "fixture-agent", tool: "gmail_send", asked: 1, approved: 1, cancelled: 0,
      neverAnswered: 0,
    });
  });
});

describe("the card record: door, address, person and question cards", () => {
  const read = async (id: string) =>
    (await db.query("SELECT kind, door, put_to, card_address, shown_whole, outcome, tool FROM approval_asks WHERE request_id = $1", [id])).rows[0];

  it("an approval gets its door and person when it opens and its address when the door has posted it; the first address wins", async () => {
    await recordAsk(db, ask);
    await recordCardOrigin(db, { requestId: "req-1", door: "slack", putTo: "U1" });
    await recordCardPosted(db, { requestId: "req-1", door: "slack", address: { channel: "C1", message: "1.2" }, shownWhole: false });
    await recordCardPosted(db, { requestId: "req-1", door: "slack", address: { channel: "C9", message: "9.9" }, shownWhole: true });
    expect(await read("req-1")).toEqual({
      kind: "approval", door: "slack", put_to: "U1", card_address: { channel: "C1", message: "1.2" }, shown_whole: false, outcome: null, tool: "gmail_send",
    });
  });

  it("a question is a row of its own kind, settles as answered or ignored, and is not an approval", async () => {
    await recordQuestion(db, { requestId: "q-1", agent: "fixture-agent", prompt: "Which one?", door: "telegram", putTo: "42" });
    await recordQuestion(db, { requestId: "q-2", agent: "fixture-agent", prompt: "Which one?" });
    await recordQuestionEnd(db, { requestId: "q-1", answered: true });
    await recordQuestionEnd(db, { requestId: "q-2", answered: false });
    await recordQuestionEnd(db, { requestId: "q-1", answered: false }); // the first end wins
    expect(await read("q-1")).toMatchObject({ kind: "question", door: "telegram", put_to: "42", outcome: "answered", tool: "question" });
    expect(await read("q-2")).toMatchObject({ kind: "question", door: null, outcome: "ignored" });
    expect(await readApprovalCounts(db)).toEqual([]);
  });

  it("recording a card whose row does not exist yet changes nothing and does not throw", async () => {
    await expect(recordCardPosted(db, { requestId: "nope", door: "slack", address: { channel: "C", message: "1" }, shownWhole: true })).resolves.toBeUndefined();
    expect(await read("nope")).toBeUndefined();
  });
});
