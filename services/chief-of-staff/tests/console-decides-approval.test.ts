// An approval asked on Telegram or Slack can be decided from the console's Waiting on you page.
//
// The console does it through the agent's own HTTP door, the same way web chat answers its own
// cards: `POST /eve/v1/session/<sessionId>` with `{ inputResponses: [{ requestId, optionId }] }`,
// HTTP Basic with the route password, and `x-lares-member` naming the signed-in owner. eve's door
// hands that to `attachSession(sessionId).respond(...)`, which is pinned to the durable session id
// whatever channel opened it — so the request that a Telegram card is waiting on is answered.
//
// Three halves, run for real where they are ours or eve's:
//   1. the door turns the console's request into the `lares-console` identity of that member;
//   2. eve's own approval coordinator settles a pending request with that identity (the
//      settlement eve turns into `approval.settled`, which also edits the Telegram card);
//   3. the tool's approver check accepts the owner and refuses anyone else, exactly as it does
//      for an answer from web chat.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { approverFrom, assertApprover, UnauthorizedApproverError } from "../lib/approvals.js";

const OWNER = "owner@example.com";
const REQUEST_ID = "req-telegram-1";
const managed = { LARES_AGENT_INCARNATION: "11111111-1111-4111-8111-111111111111", LARES_CONSOLE_PRINCIPAL: OWNER };

/** A Telegram session's pending card: the same shape eve stores in session state. */
const approvalRequest = {
  requestId: REQUEST_ID,
  kind: "tool-approval",
  prompt: "Send the reply to the supplier",
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  action: { kind: "tool-call", callId: "call-1", toolName: "deadline_dismiss", input: { id: 42 } },
};

const EVE_DIST = pathToFileURL(fileURLToPath(new URL("../node_modules/eve/dist/src", import.meta.url))).href;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "console-decides-"));
  writeFileSync(join(dir, "route-password"), "route-pw\n");
  process.env["EVE_ROUTE_PASSWORD_FILE"] = join(dir, "route-password");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["EVE_ROUTE_PASSWORD_FILE"];
});

/** What the console sends: the route password, and the signed-in member it vouches for. */
function consoleRequest(member: string): Request {
  return new Request("http://10.0.0.5:3000/eve/v1/session/wrun_telegram", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from("eve:route-pw").toString("base64")}`,
      "x-lares-member": member,
      "content-type": "application/json",
    },
    body: JSON.stringify({ inputResponses: [{ requestId: REQUEST_ID, optionId: "approve" }] }),
  });
}

async function doorAuth(member: string) {
  vi.resetModules();
  const { basicFromSecretFile } = await import("../agent/channels/eve.js");
  return basicFromSecretFile(consoleRequest(member));
}

async function settle(auth: unknown, optionId: "approve" | "cancel") {
  const { ContextContainer, contextStorage } = (await import(`${EVE_DIST}/context/container.js`)) as {
    ContextContainer: new () => { set(key: { name: string }, value: unknown): void };
    contextStorage: { run<R>(store: unknown, fn: () => R): R };
  };
  const { coordinateApprovalDelivery } = (await import(`${EVE_DIST}/harness/approval-delivery-coordinator.js`)) as {
    coordinateApprovalDelivery: (i: unknown) => Promise<{ session: { state: unknown }; feedback: string[] }>;
  };
  const { getApprovalAuditState } = (await import(`${EVE_DIST}/harness/approval-candidates.js`)) as {
    getApprovalAuditState: (s: unknown) => { settlements: Array<{ requestId: string; outcome: string }> };
  };
  const container = new ContextContainer();
  // The session was opened on Telegram by the owner's chat; the console's answer is a later resume.
  container.set({ name: "eve.session" }, { sessionId: "wrun_telegram", auth: { current: null, initiator: null }, turn: { id: "t1", sequence: 0 } });
  const state = { "eve.runtime.pendingInputBatches": [{ requests: [approvalRequest], responseMessages: [] }] };
  const result = await contextStorage.run(container, () =>
    coordinateApprovalDelivery({
      session: { state },
      stepInput: { attributedInputResponses: [{ auth, response: { requestId: REQUEST_ID, optionId } }] },
      tools: new Map([["deadline_dismiss", { approval: {} }]]),
    }),
  );
  return { settlements: getApprovalAuditState(result.session.state).settlements, feedback: result.feedback };
}

describe("the console decides an approval that a Telegram session is waiting on", () => {
  it("1. the door gives the console's request the owner's console identity", async () => {
    const auth = await doorAuth(OWNER);
    expect(auth).toMatchObject({ authenticator: "lares-console", principalId: OWNER, attributes: { user_id: OWNER } });
  });

  it("2. eve's coordinator settles the request with that identity: Approve → allowed", async () => {
    const { settlements, feedback } = await settle(await doorAuth(OWNER), "approve");
    expect(feedback).toEqual([]);
    expect(settlements).toMatchObject([{ requestId: REQUEST_ID, outcome: "allowed" }]);
  });

  it("2. … and Cancel → cancelled", async () => {
    const { settlements } = await settle(await doorAuth(OWNER), "cancel");
    expect(settlements).toMatchObject([{ requestId: REQUEST_ID, outcome: "cancelled" }]);
  });

  it("3. the tool's approver check accepts the owner, and refuses another member", async () => {
    const owner = await doorAuth(OWNER);
    expect(() => assertApprover(approverFrom({ current: owner, initiator: null }, managed), managed)).not.toThrow();

    const other = await doorAuth("someone-else@example.com");
    expect(() => assertApprover(approverFrom({ current: other, initiator: null }, managed), managed)).toThrow(UnauthorizedApproverError);
  });
});
