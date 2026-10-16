// (B2b): can a tap on Telegram approve an outside-tool write?
//
// Proven here by running eve's own code, in two halves:
//   1. eve's approval coordinator (the code that decides whether a tap is accepted) REFUSES a tap
//      with no identity once a tool has a `response` policy, and ACCEPTS the same tap carrying the
//      owner's identity and runs our `outsideResponsePolicy`.
//   2. eve's Telegram channel makes exactly that identity-less tap (`respond(..., { auth: null })`),
//      and our wrapper (`withOwnerTapAuth`) swaps in the verified owner's identity for an allowed
//      tapper only.
// The live check on the real bot is still the owner's (the request policy refuses outside-tool
// approvals on Telegram until then).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { outsideResponsePolicy } from "@lares/agent-kit/outside-connections";

import { isAllowedPrincipal, principalFromAuth } from "../lib/principals.js";
import { ownerTapAuth, withOwnerTapAuth } from "../lib/telegram-tap-auth.js";

vi.mock("@lares/agent-kit/telegram-fetch", () => ({
  telegramFetch: async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { "content-type": "application/json" } }),
}));

const OWNER = "123456789";
const STRANGER = "999000111";
const SECRET = "hook-secret";

const tap = (fromId: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    update_id: 1,
    callback_query: {
      id: "cb1",
      from: { id: Number(fromId), is_bot: false, first_name: "X" },
      message: { message_id: 7, date: 1, chat: { id: Number(fromId), type: "private" }, text: "Approve?" },
      chat_instance: "ci",
      data: "eve:0",
      ...over,
    },
  });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "owner-tap-"));
  process.env["TELEGRAM_PRINCIPAL_ID"] = OWNER;
  writeFileSync(join(dir, "token"), "1:abc\n");
  writeFileSync(join(dir, "secret"), `${SECRET}\n`);
  process.env["TELEGRAM_BOT_TOKEN_FILE"] = join(dir, "token");
  process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE"] = join(dir, "secret");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ["TELEGRAM_PRINCIPAL_ID", "TELEGRAM_BOT_TOKEN_FILE", "TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE"]) delete process.env[k];
});

describe("ownerTapAuth", () => {
  it("gives an allowed approver's tap in a private chat that approver's identity", () => {
    const auth = ownerTapAuth(tap(OWNER))!;
    expect(auth).toMatchObject({ authenticator: "telegram-webhook", principalId: `telegram:${OWNER}`, principalType: "user" });
    // the engine's own allowlist reads it back as the owner
    const p = principalFromAuth(auth);
    expect(isAllowedPrincipal(p.authenticator, p.userId)).toBe(true);
  });

  it("gives nothing to a stranger, a bot, a group chat, a message, a proposal button or junk", () => {
    expect(ownerTapAuth(tap(STRANGER))).toBeNull();
    expect(ownerTapAuth(tap(OWNER, { from: { id: Number(OWNER), is_bot: true } }))).toBeNull();
    expect(ownerTapAuth(tap(OWNER, { message: { message_id: 7, chat: { id: -5, type: "group" } } }))).toBeNull();
    expect(ownerTapAuth(tap(OWNER, { data: "np:a:61" }))).toBeNull();
    expect(ownerTapAuth(JSON.stringify({ message: { text: "hei" } }))).toBeNull();
    expect(ownerTapAuth("not json")).toBeNull();
  });

  it("gives nothing when no approver is configured", () => {
    delete process.env["TELEGRAM_PRINCIPAL_ID"];
    expect(ownerTapAuth(tap(OWNER))).toBeNull();
  });
});

describe("eve's approval coordinator, run for real", () => {
  const coordinatorPath = fileURLToPath(new URL("../node_modules/eve/dist/src/harness/approval-delivery-coordinator.js", import.meta.url));
  const reqId = "req-1";
  const request = {
    requestId: reqId, kind: "tool-approval", prompt: "Approve?",
    options: [{ id: "approve", label: "Approve" }, { id: "cancel", label: "Cancel" }],
    action: { kind: "tool-call", callId: "call-1", toolName: "registry__create_note", input: { text: "hei" } },
  };
  const state = () => ({ "eve.runtime.pendingInputBatches": [{ requests: [request], responseMessages: [], responseAuthRequiredRequestIds: [reqId] }] });
  const policy = outsideResponsePolicy((responder) => {
    const p = principalFromAuth(responder);
    return isAllowedPrincipal(p.authenticator, p.userId);
  });
  const tools = new Map([["registry__create_note", { approval: { response: policy } }]]);
  const input = (auth: unknown, s: unknown) => ({
    session: { state: s },
    stepInput: { attributedInputResponses: [{ auth, response: { requestId: reqId, optionId: "approve" } }] },
    tools,
  });

  type Delivery = { kind: string; feedback: string[]; session: { state: unknown }; stepInput?: { inputResponses?: Array<{ requestId: string; optionId: string }> } };

  /** eve's coordinator, run inside the context eve's runtime would give it (the response policy asks
   *  for the session's identity). */
  async function coordinator() {
    const dist = pathToFileURL(coordinatorPath).href.replace("/harness/approval-delivery-coordinator.js", "");
    const mod = (await import(`${dist}/harness/approval-delivery-coordinator.js`)) as { coordinateApprovalDelivery: (i: unknown) => Promise<Delivery> };
    const { ContextContainer, contextStorage } = (await import(`${dist}/context/container.js`)) as {
      ContextContainer: new () => { set(key: { name: string }, value: unknown): void };
      contextStorage: { run<T>(store: unknown, fn: () => T): T };
    };
    const container = new ContextContainer();
    container.set({ name: "eve.session" }, { sessionId: "sess-1", auth: { current: null, initiator: null }, turn: { id: "t1", sequence: 0 } });
    return { coordinateApprovalDelivery: (i: unknown) => contextStorage.run(container, () => mod.coordinateApprovalDelivery(i)) };
  }

  it("refuses a tap with no identity (what eve's Telegram channel sends)", async () => {
    const { coordinateApprovalDelivery } = await coordinator();
    const r = await coordinateApprovalDelivery(input(null, state()));
    expect(r.feedback).toEqual(["Authentication is required to respond to this approval."]);
    expect(r.stepInput?.inputResponses ?? []).toEqual([]);
  });

  it("accepts the same tap carrying the verified owner's identity, through our response policy", async () => {
    const { coordinateApprovalDelivery } = await coordinator();
    const auth = ownerTapAuth(tap(OWNER))!;
    const first = await coordinateApprovalDelivery(input(auth, state()));
    expect(first.feedback).toEqual([]);
    // eve settles a candidate on the next pass: that is where the response policy runs
    const second = await coordinateApprovalDelivery({ session: first.session, stepInput: first.stepInput, tools });
    expect(second.stepInput?.inputResponses).toEqual([{ requestId: reqId, optionId: "approve" }]);
  });

  it("still refuses an identity that is not an allowed approver", async () => {
    const { coordinateApprovalDelivery } = await coordinator();
    const stranger = { authenticator: "telegram-webhook", principalId: `telegram:${STRANGER}`, principalType: "user", attributes: { user_id: STRANGER } };
    const first = await coordinateApprovalDelivery(input(stranger, state()));
    const second = await coordinateApprovalDelivery({ session: first.session, stepInput: first.stepInput, tools });
    expect(second.stepInput?.inputResponses ?? []).toEqual([]);
  });
});

describe("the Telegram channel, wrapped", () => {
  async function post(body: string, wrap: boolean) {
    vi.resetModules();
    const { telegramChannel } = await import("eve/channels/telegram");
    const base = telegramChannel({
      botUsername: "test_bot",
      credentials: { botToken: async () => "1:abc", webhookSecretToken: async () => SECRET },
    }) as unknown as { routes: Array<{ method: string; handler: (r: Request, c: unknown) => Promise<Response> }> };
    const channel = wrap ? withOwnerTapAuth(base) : base;
    const responds: Array<{ responses: unknown; options: unknown }> = [];
    const pending: Promise<unknown>[] = [];
    const handle = { respond: async (responses: unknown, options: unknown) => { responds.push({ responses, options }); } };
    const route = channel.routes.find((r) => r.method === "POST")!;
    const res = await route.handler(
      new Request("http://x/eve/v1/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET, "content-type": "application/json" }, body }),
      { from: () => handle, resolveSession: async () => undefined, waitUntil: (p: Promise<unknown>) => pending.push(p), attachSession: undefined },
    );
    await Promise.all(pending);
    return { res, responds };
  }

  it("reproduces the problem: eve's own channel resumes an owner's tap with auth null", async () => {
    const { responds } = await post(tap(OWNER), false);
    expect(responds).toHaveLength(1);
    expect(responds[0]!.options).toEqual({ auth: null });
  });

  it("resumes an allowed approver's tap with that approver's identity", async () => {
    const { res, responds } = await post(tap(OWNER), true);
    expect(res.status).toBe(200);
    expect(responds).toHaveLength(1);
    expect(responds[0]!.options).toMatchObject({ auth: { authenticator: "telegram-webhook", principalId: `telegram:${OWNER}` } });
  });

  it("leaves a stranger's tap exactly as eve makes it", async () => {
    const { responds } = await post(tap(STRANGER), true);
    expect(responds[0]!.options).toEqual({ auth: null });
  });

  it("does not use the identity for an update whose secret is wrong", async () => {
    vi.resetModules();
    const { telegramChannel } = await import("eve/channels/telegram");
    const base = telegramChannel({ botUsername: "b", credentials: { botToken: async () => "1:abc", webhookSecretToken: async () => SECRET } }) as unknown as { routes: Array<{ method: string; handler: (r: Request, c: unknown) => Promise<Response> }> };
    const channel = withOwnerTapAuth(base);
    const responds: unknown[] = [];
    const res = await channel.routes.find((r) => r.method === "POST")!.handler(
      new Request("http://x/eve/v1/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "wrong", "content-type": "application/json" }, body: tap(OWNER) }),
      { from: () => ({ respond: async (...a: unknown[]) => { responds.push(a); } }), resolveSession: async () => undefined, waitUntil: () => {}, attachSession: undefined },
    );
    expect(res.status).toBe(401);
    expect(responds).toEqual([]);
  });

  it("the chief of staff's real Telegram door is wrapped", async () => {
    vi.resetModules();
    const mod = await import("../agent/channels/telegram.js");
    const door = mod.default as unknown as { routes: Array<{ handler: unknown }> };
    // the wrapped handler is ours, not eve's: it reads the body before delegating
    expect(String(door.routes[0]!.handler)).toMatch(/ownerTapAuth|clone/);
  });
});
