import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  denyApprovalRequest,
  makeApprovalSupersede,
  type NewAsk,
} from "../src/approval-supersede-hook.js";
import { assertApprovedCall, approvalLedger, ApprovalNotGivenError, payloadFingerprint } from "../src/approval-ledger.js";
import { recordAnswer } from "../src/approval-ledger.js";
import type { OpenAsk } from "../src/approval-supersede.js";
import { eveSession } from "./helpers/eve-session.js";

const mail = (to: string, extra: Record<string, unknown> = {}) => ({ to: [to], subject: "s", bodyText: "b", ...extra });
// One real eve session view per test: `event(card(...))` puts the call and the card into it, and
// `ctx(...)` hands the view to the hook the way eve does.
let sess = eveSession();
beforeEach(() => { sess = eveSession(); });
const card = (requestId: string, toolName: string, input: unknown, kind = "approval") => ({ requestId, toolName, input, kind });
const event = (c: ReturnType<typeof card>) => {
  sess.call(`call-${c.requestId}`, c.toolName, c.input);
  return sess.open(c.requestId, `call-${c.requestId}`, c.kind);
};
const ctx = (turn: number, id = "sess-1") => ({ agent: { name: "assistant" }, session: { id, turn: { sequence: turn } }, view: sess.view });

describe("the approval-supersede hook, with injected storage", () => {
  function rig(open: OpenAsk[] = []) {
    const recorded: NewAsk[] = [];
    const settled: string[] = [];
    const denied: Array<[string, string]> = [];
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
      deny: async (s, r) => void denied.push([s, r]),
      isOpen: () => true,
    });
    return { h, recorded, settled, denied, asked };
  }
  const old = (over: Partial<OpenAsk> = {}): OpenAsk => ({ requestId: "old", tool: "gmail_send", turn: 1, targetHash: null, ...over });

  it("withdraws the older card for the same tool when a new one arrives in a later turn", async () => {
    const r = rig([old()]);
    await r.h["interaction.opened"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(r.settled).toEqual(["old"]);
    expect(r.denied).toEqual([["sess-1", "old"]]);
  });

  it("writes the new card down with its session, turn and a hashed target", async () => {
    const r = rig();
    await r.h["interaction.opened"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(4));
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
    await r.h["interaction.opened"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2, "sess-9"));
    expect(r.asked).toEqual([["sess-9", ["new"]]]);
  });

  it("keeps both cards raised in the same turn", async () => {
    const r = rig([old({ turn: 2 })]);
    await r.h["interaction.opened"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(r.settled).toEqual([]);
    expect(r.denied).toEqual([]);
  });

  it("keeps both when the tool differs", async () => {
    const r = rig([old({ tool: "gmail_draft" })]);
    await r.h["interaction.opened"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(r.denied).toEqual([]);
  });

  it("keeps both when the targets differ", async () => {
    const other = (await import("../src/approval-supersede.js")).targetFingerprint("gmail_send", mail("b@example.com"));
    const r = rig([old({ targetHash: other })]);
    await r.h["interaction.opened"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(r.denied).toEqual([]);
  });

  it("withdraws when the targets are the same", async () => {
    const same = (await import("../src/approval-supersede.js")).targetFingerprint("gmail_send", mail("a@example.com", { subject: "old words" }));
    const r = rig([old({ targetHash: same })]);
    await r.h["interaction.opened"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(r.denied).toEqual([["sess-1", "old"]]);
  });

  it("does nothing when no card is pending", async () => {
    const r = rig([]);
    await r.h["interaction.opened"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(r.settled).toEqual([]);
    expect(r.denied).toEqual([]);
  });

  it("ignores a question", async () => {
    const r = rig([old()]);
    await r.h["interaction.opened"](event(card("q", "ask_question", {}, "question")), ctx(2));
    expect(r.recorded).toEqual([]);
    expect(r.asked).toEqual([]);
    expect(r.denied).toEqual([]);
  });

  it("does not ask eve to deny a card it did not settle itself (already answered)", async () => {
    const denied: unknown[] = [];
    const h = makeApprovalSupersede({
      record: async () => undefined,
      openAsks: async () => [old()],
      markRevised: async () => false,
      deny: async (s, r) => void denied.push([s, r]),
      isOpen: () => true,
    });
    await h["interaction.opened"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(denied).toEqual([]);
  });

  it("does nothing without a session id or a turn", async () => {
    const r = rig([old()]);
    await r.h["interaction.opened"](event(card("new", "gmail_send", mail("a@example.com"))), { agent: { name: "assistant" }, session: { id: "s" } });
    await r.h["interaction.opened"](event(card("new", "gmail_send", mail("a@example.com"))), {});
    expect(r.asked).toEqual([]);
    expect(r.denied).toEqual([]);
  });

  it("never throws, whatever fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const boom = async () => { throw new Error("boom"); };
    const h = makeApprovalSupersede({ record: boom, openAsks: boom, markRevised: boom, deny: boom, isOpen: () => true });
    await expect(h["interaction.opened"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2))).resolves.toBeUndefined();
    await expect(h["interaction.opened"]({}, {})).resolves.toBeUndefined();
    await expect(h["interaction.opened"](null, null)).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("a failing deny call is logged, not thrown, and the card was already settled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settled: string[] = [];
    const h = makeApprovalSupersede({
      record: async () => undefined,
      openAsks: async () => [old()],
      markRevised: async (id) => { settled.push(id); return true; },
      deny: async () => { throw new Error("eve said no"); },
      isOpen: () => true,
    });
    await expect(h["interaction.opened"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2))).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toEqual(["old"]);
    warn.mockRestore();
  });
});

describe("asking eve to deny, only while eve still shows the card open", () => {
  const rigWith = (isOpen: (c: unknown, id: string) => boolean) => {
    const denied: Array<[string, string]> = [];
    const settled: string[] = [];
    const h = makeApprovalSupersede({
      record: async () => undefined,
      openAsks: async () => [{ requestId: "old", tool: "gmail_send", turn: 1, targetHash: null }],
      markRevised: async (id) => { settled.push(id); return true; },
      deny: async (s, r) => void denied.push([s, r]),
      isOpen,
    });
    return { h, denied, settled };
  };

  it("does not answer a card eve has already ended (eve would deliver the late answer to the model)", async () => {
    const r = rigWith(() => false);
    await r.h["interaction.opened"](event(card("new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(r.settled).toEqual(["old"]); // the ledger still refuses the old call
    expect(r.denied).toEqual([]);
  });

  it("reads 'open' from eve's own view of the session, and treats a card the view does not know as not open", async () => {
    // The default check: a real view in which the old card is open, then one in which it was withdrawn.
    const denied: string[] = [];
    const make = () => makeApprovalSupersede({
      record: async () => undefined,
      openAsks: async () => [{ requestId: "r-old", tool: "gmail_send", turn: 1, targetHash: null }],
      markRevised: async () => true,
      deny: async (_s, r) => void denied.push(r),
    });
    sess.call("call-r-old", "gmail_send", mail("a@example.com"));
    sess.open("r-old", "call-r-old");
    await make()["interaction.opened"](event(card("r-new", "gmail_send", mail("a@example.com"))), ctx(2));
    expect(denied).toEqual(["r-old"]);

    denied.length = 0;
    sess.settle("r-old", "withdrawn");
    await make()["interaction.opened"](event(card("r-newer", "gmail_send", mail("a@example.com"))), ctx(3));
    expect(denied).toEqual([]);

    await make()["interaction.opened"](event(card("r-newest", "gmail_send", mail("a@example.com"))), { ...ctx(4), view: undefined });
    expect(denied).toEqual([]);
  });
});

describe("denyApprovalRequest", () => {
  it("posts a deny answer to the agent's own session route with the route password", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    await denyApprovalRequest("sess 1", "req-1", {
      baseUrl: "http://127.0.0.1:3999",
      passwordFile: "/secrets/pw",
      readFile: () => "pw-value\n",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3999/eve/v1/session/sess%201");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ answers: [{ interactionId: "req-1", optionId: "deny" }] });
    const auth = (init.headers as Record<string, string>)["authorization"]!;
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe("eve:pw-value");
  });

  it("throws when eve refuses, and when there is no password", async () => {
    const refuse = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(
      denyApprovalRequest("s", "r", { readFile: () => "pw", fetchImpl: refuse as unknown as typeof fetch }),
    ).rejects.toThrow(/401/);
    await expect(
      denyApprovalRequest("s", "r", { readFile: () => "  \n", fetchImpl: refuse as unknown as typeof fetch }),
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

  it("settles the older card as denied / revised, keeps the new one open, and the old call then refuses", async () => {
    const denied: Array<[string, string]> = [];
    const h = makeApprovalSupersede({ deny: async (s, r) => void denied.push([s, r]), isOpen: () => true });
    await h["interaction.opened"](event(card("r-old", "gmail_send", send("a@example.com", "v1"))), ctx(1));
    await h["interaction.opened"](event(card("r-new", "gmail_send", send("a@example.com", "v2"))), ctx(2));

    const { rows } = await db.query("SELECT request_id, session_id, turn_sequence, outcome, answered_via, answered_at IS NOT NULL AS answered FROM approval_asks ORDER BY request_id");
    expect(rows).toEqual([
      { request_id: "r-new", session_id: "sess-1", turn_sequence: 2, outcome: null, answered_via: null, answered: false },
      { request_id: "r-old", session_id: "sess-1", turn_sequence: 1, outcome: "cancelled", answered_via: "revised", answered: true },
    ]);
    expect(denied).toEqual([["sess-1", "r-old"]]);

    // eve's own settlement of the card arrives afterwards: first answer wins, 'revised' stays.
    await recordAnswer(await import("../src/db.js").then((m) => m.getPool()), { requestId: "r-old", outcome: "cancelled" });
    const after = await db.query("SELECT answered_via FROM approval_asks WHERE request_id = 'r-old'");
    expect(after.rows[0].answered_via).toBe("revised");

    // And if someone still approved the old card, the tool's own check refuses it.
    await expect(
      assertApprovedCall(approvalLedger(), { callId: "call-r-old", toolName: "gmail_send", input: send("a@example.com", "v1") }),
    ).rejects.toBeInstanceOf(ApprovalNotGivenError);
  });

  it("leaves cards of another session, another tool, the same turn, and answered cards alone", async () => {
    const denied: string[] = [];
    const h = makeApprovalSupersede({ deny: async (_s, r) => void denied.push(r), isOpen: () => true });
    await h["interaction.opened"](event(card("other-session", "gmail_send", send("a@example.com", "x"))), ctx(1, "sess-2"));
    await h["interaction.opened"](event(card("other-tool", "gmail_draft", send("a@example.com", "x"))), ctx(1));
    await h["interaction.opened"](event(card("answered", "gmail_send", send("a@example.com", "x"))), ctx(1));
    await recordAnswer((await import("../src/db.js")).getPool(), { requestId: "answered", outcome: "approved" });
    await h["interaction.opened"](event(card("same-turn", "gmail_send", send("a@example.com", "x"))), ctx(2));
    await h["interaction.opened"](event(card("new", "gmail_send", send("a@example.com", "y"))), ctx(2));
    // only cards from an EARLIER turn of the same session, same tool, still open: none here
    expect(denied).toEqual([]);
    const { rows } = await db.query("SELECT request_id FROM approval_asks WHERE outcome IS NULL ORDER BY request_id");
    expect(rows.map((r: { request_id: string }) => r.request_id)).toEqual(["new", "other-session", "other-tool", "same-turn"]);
  });

  it("fills in the session on a row another recorder inserted first", async () => {
    await db.query("INSERT INTO approval_asks (request_id, call_id, agent, tool, payload_hash) VALUES ('r1', 'call-r1', 'assistant', 'gmail_send', 'h')");
    const h = makeApprovalSupersede({ deny: async () => undefined, isOpen: () => true });
    await h["interaction.opened"](event(card("r1", "gmail_send", send("a@example.com", "v1"))), ctx(3));
    const { rows } = await db.query("SELECT session_id, turn_sequence FROM approval_asks WHERE request_id = 'r1'");
    expect(rows).toEqual([{ session_id: "sess-1", turn_sequence: 3 }]);
  });
});
