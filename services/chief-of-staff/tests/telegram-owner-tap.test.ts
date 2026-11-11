// Who a tap on an approval card arrives as, and what may count as an answer.
//
// Until eve 1.0 the Telegram channel resumed a tap with no identity at all
// (`respond(..., { auth: null })`), and this service wrapped the channel's route to put the
// verified owner's identity back. eve 1.0.0-rc.9 passes the tapper on itself, so the wrapper is
// gone and this file pins what replaced it, by running the installed eve:
//
//   1. THE CHANNEL. A tap is resumed with the TAPPER's identity — the owner's for the owner, a
//      stranger's for a stranger, never one for the other — in the shape `lib/principals.ts`
//      reads. A request without Telegram's secret is resumed as nobody: it is rejected.
//   2. TYPED TEXT. A message the owner types while a card waits ("approve", "1") is dispatched
//      as a message. Nothing at this door turns it into an answer.
//   3. eve's RESPONDER CHECK. An approval takes only the Approve or Deny button's own answer;
//      text is refused, an answer from nobody is refused, and an answer from somebody who is not
//      the requester is refused.
//
// The refusal of a non-owner's tap BEFORE any of this is `tests/telegram-tap-gate.test.ts`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isAllowedPrincipal, principalFromAuth } from "../lib/principals.js";

vi.mock("@lares/agent-kit/telegram-fetch", () => ({
  telegramFetch: async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { "content-type": "application/json" } }),
}));
// The real door logs each message and looks for a carry-forward summary; neither needs a database here.
vi.mock("@lares/agent-kit/db", () => ({
  getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));

const OWNER = "123456789";
const STRANGER = "999000111";
const SECRET = "hook-secret";

/** eve's dist, for the internals its exports map does not expose. */
const EVE_DIST = pathToFileURL(fileURLToPath(new URL("../node_modules/eve/dist/src", import.meta.url))).href;

const tap = (fromId: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    update_id: 1,
    callback_query: {
      id: "cb1",
      from: { id: Number(fromId), is_bot: false, first_name: "X" },
      message: { message_id: 7, date: 1, chat: { id: Number(OWNER), type: "private" }, text: "Approve?" },
      chat_instance: "ci",
      data: "eve:0",
      ...over,
    },
  });

const typed = (text: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    update_id: 2,
    message: {
      message_id: 8,
      date: 2,
      from: { id: Number(OWNER), is_bot: false, first_name: "X" },
      chat: { id: Number(OWNER), type: "private" },
      text,
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
  vi.restoreAllMocks();
});

interface Captured {
  kind: "send" | "respond";
  payload: unknown;
  options: { auth?: unknown; state?: unknown; context?: unknown };
}
type RouteHandler = (request: Request, ctx: unknown) => Promise<Response>;

/** The chief of staff's real Telegram door, freshly imported. */
async function realDoor() {
  vi.resetModules();
  return (await import("../agent/channels/telegram.js")).default as unknown as {
    routes: Array<{ method: string; handler: RouteHandler }>;
    adapter: { deliver(input: unknown, ctx: unknown): unknown };
  };
}

/** POSTs one update to the door's own route and returns what it handed to the session. */
async function post(body: string, secret: string = SECRET) {
  const door = await realDoor();
  const captured: Captured[] = [];
  const pending: Promise<unknown>[] = [];
  const handle = {
    send: async (payload: unknown, options: Captured["options"]) => { captured.push({ kind: "send", payload, options }); },
    respond: async (payload: unknown, options: Captured["options"]) => { captured.push({ kind: "respond", payload, options }); },
  };
  const route = door.routes.find((r) => r.method === "POST")!;
  const res = await route.handler(
    new Request("http://x/inner", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret, "content-type": "application/json" }, body }),
    { from: () => handle, resolveSession: async () => undefined, waitUntil: (p: Promise<unknown>) => pending.push(p), attachSession: undefined },
  );
  await Promise.all(pending);
  return { res, captured, door };
}

describe("1. the channel resumes a tap as the person who tapped", () => {
  it("the owner's tap arrives with the owner's identity, in the shape the allowlist reads", async () => {
    const { res, captured } = await post(tap(OWNER));
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.kind).toBe("respond");
    // eve's own compact answer: the button's callback data, resolved to the real answer from the
    // session's state when it is delivered.
    expect(captured[0]!.payload).toEqual([{ interactionId: "telegram_callback:eve:0", optionId: "selected" }]);
    const auth = captured[0]!.options.auth;
    expect(auth).toMatchObject({
      authenticator: "telegram-webhook",
      issuer: "telegram",
      principalId: `telegram:${OWNER}`,
      principalType: "user",
      attributes: { chat_id: OWNER, chat_type: "private", user_id: OWNER },
    });
    const p = principalFromAuth(auth);
    expect(isAllowedPrincipal(p.authenticator, p.userId)).toBe(true);
  });

  it("a stranger's tap, were it to get past the front door, arrives as the stranger — never as the owner", async () => {
    const { captured } = await post(tap(STRANGER));
    expect(captured).toHaveLength(1);
    const auth = captured[0]!.options.auth;
    expect(auth).toMatchObject({ principalId: `telegram:${STRANGER}`, attributes: { user_id: STRANGER } });
    const p = principalFromAuth(auth);
    expect(isAllowedPrincipal(p.authenticator, p.userId)).toBe(false);
  });

  it("a bot's tap is not a user's, whatever id it carries", async () => {
    const { captured } = await post(tap(OWNER, { from: { id: Number(OWNER), is_bot: true } }));
    expect(captured[0]!.options.auth).toMatchObject({ principalType: "service" });
  });

  it("resumes nothing for an update whose secret is wrong", async () => {
    const { res, captured } = await post(tap(OWNER), "wrong");
    expect(res.status).toBe(401);
    expect(captured).toEqual([]);
  });

  it("the door is eve's own channel: its route is not wrapped", async () => {
    // The route handler used to be replaced by one that read the body and swapped the identity.
    const door = await realDoor();
    expect(String(door.routes[0]!.handler)).not.toMatch(/ownerTapAuth|clone\(\)/);
  });
});

describe("2. typed text is a message, never an answer", () => {
  it.each(["approve", "Approve", "1", "yes", "deny"])("the owner typing %j is dispatched with send(), not respond()", async (text) => {
    const { captured } = await post(typed(text));
    expect(captured.map((c) => c.kind)).toEqual(["send"]);
    expect(captured[0]!.payload).toBe(text);
  });

  it("a reply to the card itself is a message too, once the front door has cleared the marker", async () => {
    const { neutralizeBotReplyMarker } = await import("@lares/agent-kit/telegram-reply-fix");
    const reply = typed("approve", {
      reply_to_message: { message_id: 7, chat: { id: Number(OWNER), type: "private" }, from: { id: 42, is_bot: true, username: "example_bot" }, text: "Approve?" },
    });
    const { body, rewritten } = neutralizeBotReplyMarker(reply);
    expect(rewritten).toBe(true);
    const { captured } = await post(body);
    expect(captured.map((c) => c.kind)).toEqual(["send"]);
    // Nothing in what the channel hands on marks the text as addressed to the card.
    expect((captured[0]!.options.state as { replyToBotMessageId?: unknown }).replyToBotMessageId).toBeNull();
  });

  // With a card open, the channel's own state holds the button answers. The channel's deliver
  // hook is where a compact answer is resolved against it — and where text could, in principle,
  // be matched to a request.
  const openCard = () => ({
    hitlCallbacks: { "eve:0": { interactionId: "i1", optionId: "deny" }, "eve:1": { interactionId: "i1", optionId: "approve" } },
    hitlPrompts: { i1: { messageId: "7", text: "Approve?", options: [{ id: "deny", label: "Deny" }, { id: "approve", label: "Approve" }] } },
    pendingFreeformReplies: {},
  });
  const session = { auth: { current: null } };

  it("with a card open, typed text is delivered as the message, with no answer attached", async () => {
    const door = await realDoor();
    for (const text of ["approve", "1"]) {
      const out = door.adapter.deliver({ message: text, state: { replyToBotMessageId: null } }, { state: openCard(), session });
      expect(out).toMatchObject({ message: text });
      expect((out as { answers?: unknown }).answers).toBeUndefined();
    }
  });

  it("even a reply that still carried the marker finds no card to answer: cards are answered by taps only", async () => {
    const door = await realDoor();
    const out = door.adapter.deliver({ message: "approve", state: { replyToBotMessageId: "7" } }, { state: openCard(), session });
    expect(out).toMatchObject({ message: "approve" });
    expect((out as { answers?: unknown }).answers).toBeUndefined();
  });

  it("the tap, by contrast, resolves to the button's own answer", async () => {
    const door = await realDoor();
    const out = door.adapter.deliver(
      { answers: [{ interactionId: "telegram_callback:eve:1", optionId: "selected" }], state: {} },
      { state: openCard(), session },
    );
    expect((out as { answers: unknown }).answers).toEqual([{ interactionId: "i1", optionId: "approve" }]);
  });

  // END TO END — depends on the framework patch. What eve does with a MESSAGE that arrives while
  // an approval waits (rc.9 withdraws the card) is decided inside the framework and by the Lares
  // patch to it, not at this door. This door's part ends at "it is a message".
  it.todo("end to end: typing 'approve' with a card open approves nothing (depends on the framework patch)");
});

describe("3. eve's own check of who answered, run for real", () => {
  interface Check {
    admit: string[];
    refused: Array<{ responseId?: string; reason: string }>;
    weigh: Record<string, { responder: unknown }>;
  }
  async function checkResponders(step: Record<string, unknown>, answer: Record<string, unknown>): Promise<Check> {
    const { checkResponders: check } = (await import(`${EVE_DIST}/harness/hitl/responders.js`)) as {
      checkResponders(view: unknown, delivery: unknown, now: number): Check;
    };
    // The slice of the harness's view the check reads: the step that asked, and no earlier answers.
    const view = {
      projection: { view: { responses: {} } },
      turn: { suspended: [{ requests: [{ interactionId: "i1" }], ...step }] },
    };
    return check(view, { answers: [{ interactionId: "i1", responseId: "r1", ...answer }] }, Date.now());
  }
  const identity = (userId: string) => ({
    attributes: { user_id: userId },
    authenticator: "telegram-webhook",
    issuer: "telegram",
    principalId: `telegram:${userId}`,
    principalType: "user",
  });
  const owner = identity(OWNER);

  it("the requester's Approve stands, and so does their Deny", async () => {
    expect(await checkResponders({ requester: owner }, { optionId: "approve", responder: owner })).toMatchObject({ admit: ["r1"], refused: [] });
    expect(await checkResponders({ requester: owner }, { optionId: "deny", responder: owner })).toMatchObject({ admit: ["r1"], refused: [] });
  });

  it("the identity the channel gave the owner's tap is that requester", async () => {
    const { captured } = await post(tap(OWNER));
    const responder = captured[0]!.options.auth;
    expect(await checkResponders({ requester: owner }, { optionId: "approve", responder })).toMatchObject({ admit: ["r1"], refused: [] });
  });

  it("text is never a decision: 'approve' typed as an answer is refused", async () => {
    for (const answer of [{ text: "approve" }, { text: "1" }, { optionId: "selected" }, { optionId: "cancel" }, { optionId: "Approve" }]) {
      const check = await checkResponders({ requester: owner }, { ...answer, responder: owner });
      expect(check.admit, JSON.stringify(answer)).toEqual([]);
      expect(check.refused).toEqual([{ responseId: "r1", reason: "Respond to this approval with Approve or Cancel." }]);
    }
  });

  it("an answer from nobody is refused", async () => {
    const check = await checkResponders({ requester: owner }, { optionId: "approve", responder: null });
    expect(check.admit).toEqual([]);
    expect(check.refused).toEqual([{ responseId: "r1", reason: "Authentication is required to respond to this approval." }]);
  });

  it("an answer from somebody who is not the requester is refused", async () => {
    const check = await checkResponders({ requester: owner }, { optionId: "approve", responder: identity(STRANGER) });
    expect(check.admit).toEqual([]);
    expect(check.refused).toEqual([{ responseId: "r1", reason: "Only the person who requested this action can respond to this approval." }]);
  });

  it("a tool with a response policy: nobody is refused outright, a named responder is weighed by the policy", async () => {
    const step = { requester: owner, responseAuthRequiredRequestIds: ["i1"] };
    const nobody = await checkResponders(step, { optionId: "approve", responder: null });
    expect(nobody.admit).toEqual([]);
    expect(nobody.refused).toEqual([{ responseId: "r1", reason: "Authentication is required to respond to this approval." }]);

    const stranger = await checkResponders(step, { optionId: "approve", responder: identity(STRANGER) });
    // Not admitted here: handed to the tool's own response policy, with who answered.
    expect(stranger.admit).toEqual([]);
    expect(stranger.weigh["r1"]?.responder).toMatchObject({ principalId: `telegram:${STRANGER}` });
  });
});
