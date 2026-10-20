import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cancelApprovalRequest,
  makeApprovalSupersede,
  type NewAsk,
} from "../src/approval-supersede-hook.js";
import { assertApprovedCall, approvalLedger, ApprovalNotGivenError, payloadFingerprint } from "../src/approval-ledger.js";
import { recordAnswer } from "../src/approval-ledger.js";
import type { OpenAsk } from "../src/approval-supersede.js";

const mail = (to: string, extra: Record<string, unknown> = {}) => ({ to: [to], subject: "s", bodyText: "b", ...extra });
const card = (requestId: string, toolName: string, input: unknown, kind = "tool-approval") => ({
  kind,
  requestId,
  action: { kind: "tool-call", callId: `call-${requestId}`, toolName, input },
});
const event = (...requests: unknown[]) => ({ type: "input.requested", data: { requests } });
const ctx = (turn: number, id = "sess-1") => ({ agent: { name: "assistant" }, session: { id, turn: { sequence: turn } } });

describe("the approval-supersede hook, with injected storage", () => {
  function rig(open: OpenAsk[] = []) {
    const recorded: NewAsk[] = [];
    const settled: string[] = [];
    const cancelled: Array<[string, string]> = [];
    const asked: Array<[string, readonly string[]]> = [];
    const h = makeApprovalSupersede({
      record: async (a) => void recorded.push(a),
      openAsks: async (s, except) => {
        asked.push([s, except]);
        return open;
      },
      markRevised: async (id) => {
        settled.push(id);
        return true;
      },
      cancel: async (s, r) => void cancelled.push([s, r]),
    });
    return { h, recorded, settled, cancelled, asked };
  }
  const old = (over: Partial<OpenAsk> = {}): OpenAsk => ({ requestId: "old", tool: "gmail_send", turn: 1, targetHash: null, ...over });

  it("withdraws the older card for the same tool when a new one arrives in a later turn", async () => {
    const r = rig([old()]);
    await r.h["input.requested"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(r.settled).toEqual(["old"]);
    expect(r.cancelled).toEqual([["sess-1", "old"]]);
  });

  it("writes the new card down with its session, turn and a hashed target", async () => {
    const r = rig();
    await r.h["input.requested"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(4));
    expect(r.recorded).toHaveLength(1);
    expect(r.recorded[0]).toMatchObject({
      requestId: "new", callId: "call-new", agent: "assistant", tool: "gmail_send",
      sessionId: "sess-1", turn: 4, payloadHash: payloadFingerprint("gmail_send", mail("a@example.com")),
    });
    expect(r.recorded[0]!.targetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r.recorded[0])).not.toContain("a@example.com");
  });

  it("asks only for the session's other cards", async () => {
    const r = rig();
    await r.h["input.requested"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2, "sess-9"));
    expect(r.asked).toEqual([["sess-9", ["new"]]]);
  });

  it("keeps both cards raised in the same turn", async () => {
    const r = rig([old({ turn: 2 })]);
    await r.h["input.requested"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(r.settled).toEqual([]);
    expect(r.cancelled).toEqual([]);
  });

  it("keeps both when the tool differs", async () => {
    const r = rig([old({ tool: "gmail_draft" })]);
    await r.h["input.requested"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(r.cancelled).toEqual([]);
  });

  it("keeps both when the targets differ", async () => {
    const other = (await import("../src/approval-supersede.js")).targetFingerprint("gmail_send", mail("b@example.com"));
    const r = rig([old({ targetHash: other })]);
    await r.h["input.requested"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(r.cancelled).toEqual([]);
  });

  it("withdraws when the targets are the same", async () => {
    const same = (await import("../src/approval-supersede.js")).targetFingerprint("gmail_send", mail("a@example.com", { subject: "old words" }));
    const r = rig([old({ targetHash: same })]);
    await r.h["input.requested"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(r.cancelled).toEqual([["sess-1", "old"]]);
  });

  it("does nothing when no card is pending", async () => {
    const r = rig([]);
    await r.h["input.requested"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(r.settled).toEqual([]);
    expect(r.cancelled).toEqual([]);
  });

  it("ignores a question", async () => {
    const r = rig([old()]);
    await r.h["input.requested"](event(card("q", "ask_question", {}, "question")), ctx(2));
    expect(r.recorded).toEqual([]);
    expect(r.asked).toEqual([]);
    expect(r.cancelled).toEqual([]);
  });

  it("does not ask eve to cancel a card it did not settle itself (already answered)", async () => {
    const cancelled: unknown[] = [];
    const h = makeApprovalSupersede({
      record: async () => undefined,
      openAsks: async () => [old()],
      markRevised: async () => false,
      cancel: async (s, r) => void cancelled.push([s, r]),
    });
    await h["input.requested"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(cancelled).toEqual([]);
  });

  it("does nothing without a session id or a turn", async () => {
    const r = rig([old()]);
    await r.h["input.requested"](event(card("new", "gmail_send", mail("a@example.com"))), { agent: { name: "assistant" }, session: { id: "s" } });
    await r.h["input.requested"](event(card("new", "gmail_send", mail("a@example.com"))), {});
    expect(r.asked).toEqual([]);
    expect(r.cancelled).toEqual([]);
  });

  it("never throws, whatever fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const boom = async () => { throw new Error("boom"); };
    const h = makeApprovalSupersede({ record: boom, openAsks: boom, markRevised: boom, cancel: boom });
    await expect(h["input.requested"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2))).resolves.toBeUndefined();
    await expect(h["input.requested"]({}, {})).resolves.toBeUndefined();
    await expect(h["input.requested"](null, null)).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("a failing cancel call is logged, not thrown, and the card was already settled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settled: string[] = [];
    const h = makeApprovalSupersede({
      record: async () => undefined,
      openAsks: async () => [old()],
      markRevised: async (id) => { settled.push(id); return true; },
      cancel: async () => { throw new Error("eve said no"); },
    });
    await expect(h["input.requested"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2))).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toEqual(["old"]);
    warn.mockRestore();
  });
});

describe("cancelApprovalRequest", () => {
  it("posts a cancel answer to the agent's own session route with the route password", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    await cancelApprovalRequest("sess 1", "req-1", {
      baseUrl: "http://127.0.0.1:3999",
      passwordFile: "/secrets/pw",
      readFile: () => "pw-value\n",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3999/eve/v1/session/sess%201");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ inputResponses: [{ requestId: "req-1", optionId: "cancel" }] });
    const auth = (init.headers as Record<string, string>)["authorization"]!;
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe("eve:pw-value");
  });

  it("throws when eve refuses, and when there is no password", async () => {
    const refuse = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(
      cancelApprovalRequest("s", "r", { readFile: () => "pw", fetchImpl: refuse as unknown as typeof fetch }),
    ).rejects.toThrow(/401/);
    await expect(
      cancelApprovalRequest("s", "r", { readFile: () => "  \n", fetchImpl: refuse as unknown as typeof fetch }),
    ).rejects.toThrow(/empty/);
  });
});

describe("the approval-supersede hook, against a real database", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const SQL = join(here, "..", "..", "..", "services", "box", "sql");
  let container: StartedPostgreSqlContainer;
  let db: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    process.env["DATABASE_URL"] = container.getConnectionUri();
    db = new Pool({ connectionString: container.getConnectionUri() });
    db.on("error", () => undefined);
    db.on("connect", (client) => client.on("error", () => undefined));
    await db.query(readFileSync(join(SQL, "001_baseline.sql"), "utf8"));
    await db.query(readFileSync(join(SQL, "006_approval_session.sql"), "utf8"));
  }, 120_000);
  afterAll(async () => {
    const { getPool } = await import("../src/db.js");
    await getPool().end();
    await db.end();
    await container.stop();
  });
  beforeEach(async () => { await db.query("TRUNCATE approval_asks"); });

  const send = (to: string, subject: string) => mail(to, { subject, threadId: "t-1" });

  it("settles the older card as cancelled / revised, keeps the new one open, and the old call then refuses", async () => {
    const cancelled: Array<[string, string]> = [];
    const h = makeApprovalSupersede({ cancel: async (s, r) => void cancelled.push([s, r]) });
    await h["input.requested"](event(card("r-old", "gmail_send", send("a@example.com", "v1"))), ctx(1));
    await h["input.requested"](event(card("r-new", "gmail_send", send("a@example.com", "v2"))), ctx(2));

    const { rows } = await db.query("SELECT request_id, session_id, turn_sequence, outcome, answered_via, answered_at IS NOT NULL AS answered FROM approval_asks ORDER BY request_id");
    expect(rows).toEqual([
      { request_id: "r-new", session_id: "sess-1", turn_sequence: 2, outcome: null, answered_via: null, answered: false },
      { request_id: "r-old", session_id: "sess-1", turn_sequence: 1, outcome: "cancelled", answered_via: "revised", answered: true },
    ]);
    expect(cancelled).toEqual([["sess-1", "r-old"]]);

    // eve's own "denied" resolution arrives afterwards: first answer wins, 'revised' stays.
    await recordAnswer(await import("../src/db.js").then((m) => m.getPool()), { requestId: "r-old", outcome: "cancelled" });
    const after = await db.query("SELECT answered_via FROM approval_asks WHERE request_id = 'r-old'");
    expect(after.rows[0].answered_via).toBe("revised");

    // And if someone still approved the old card, the tool's own check refuses it.
    await expect(
      assertApprovedCall(approvalLedger(), { callId: "call-r-old", toolName: "gmail_send", input: send("a@example.com", "v1") }),
    ).rejects.toBeInstanceOf(ApprovalNotGivenError);
  });

  it("leaves cards of another session, another tool, the same turn, and answered cards alone", async () => {
    const cancelled: string[] = [];
    const h = makeApprovalSupersede({ cancel: async (_s, r) => void cancelled.push(r) });
    await h["input.requested"](event(card("other-session", "gmail_send", send("a@example.com", "x"))), ctx(1, "sess-2"));
    await h["input.requested"](event(card("other-tool", "gmail_draft", send("a@example.com", "x"))), ctx(1));
    await h["input.requested"](event(card("answered", "gmail_send", send("a@example.com", "x"))), ctx(1));
    await recordAnswer((await import("../src/db.js")).getPool(), { requestId: "answered", outcome: "approved" });
    await h["input.requested"](event(card("same-turn", "gmail_send", send("a@example.com", "x"))), ctx(2));
    await h["input.requested"](event(card("new", "gmail_send", send("a@example.com", "y"))), ctx(2));
    // only cards from an EARLIER turn of the same session, same tool, still open: none here
    expect(cancelled).toEqual([]);
    const { rows } = await db.query("SELECT request_id FROM approval_asks WHERE outcome IS NULL ORDER BY request_id");
    expect(rows.map((r: { request_id: string }) => r.request_id)).toEqual(["new", "other-session", "other-tool", "same-turn"]);
  });

  it("fills in the session on a row another recorder inserted first", async () => {
    await db.query("INSERT INTO approval_asks (request_id, call_id, agent, tool, payload_hash) VALUES ('r1', 'call-r1', 'assistant', 'gmail_send', 'h')");
    const h = makeApprovalSupersede({ cancel: async () => undefined });
    await h["input.requested"](event(card("r1", "gmail_send", send("a@example.com", "v1"))), ctx(3));
    const { rows } = await db.query("SELECT session_id, turn_sequence FROM approval_asks WHERE request_id = 'r1'");
    expect(rows).toEqual([{ session_id: "sess-1", turn_sequence: 3 }]);
  });
});
