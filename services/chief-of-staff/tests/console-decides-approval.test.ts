// An approval asked on Telegram or Slack can be decided from the console's Waiting on you page.
//
// The console does it through the agent's own HTTP door, the same way web chat answers its own
// cards: `POST /eve/v1/session/<sessionId>` with `{ answers: [{ interactionId, optionId }] }`,
// HTTP Basic with the route password, and `x-lares-member` naming the signed-in owner. eve's door
// hands that to `attachSession(sessionId).respond(...)`, which is pinned to the durable session id
// whatever channel opened it — so the request that a Telegram card is waiting on is answered.
//
// Two halves, run for real where they are ours:
//   1. the door turns the console's request into the `lares-console` identity of that member;
//   2. the tool's approver check accepts the owner and refuses anyone else, exactly as it does for an
//      answer from web chat — for an Approve and, since eve 1.0 asks the same question of a Deny, for a Deny.
// (A third half used to run eve 0.60's approval coordinator on a pending request. eve 1.0 has no such
// entry point; what it does with an answer is eve's own, and the rules that are ours are above.)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { approverFrom, assertApprover, UnauthorizedApproverError } from "../lib/approvals.js";

const OWNER = "owner@example.com";
const INTERACTION_ID = "req-telegram-1";
const managed = { LARES_AGENT_INCARNATION: "11111111-1111-4111-8111-111111111111", LARES_CONSOLE_PRINCIPAL: OWNER };

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
    body: JSON.stringify({ answers: [{ interactionId: INTERACTION_ID, optionId: "approve" }] }),
  });
}

async function doorAuth(member: string) {
  vi.resetModules();
  const { basicFromSecretFile } = await import("../agent/channels/eve.js");
  return basicFromSecretFile(consoleRequest(member));
}

describe("the console decides an approval that a Telegram session is waiting on", () => {
  it("1. the door gives the console's request the owner's console identity", async () => {
    const auth = await doorAuth(OWNER);
    expect(auth).toMatchObject({ authenticator: "lares-console", principalId: OWNER, attributes: { user_id: OWNER } });
  });

  it("2. the tool's approver check accepts the owner, and refuses another member — the same check answers a Deny", async () => {
    const owner = await doorAuth(OWNER);
    expect(() => assertApprover(approverFrom({ current: owner, initiator: null }, managed), managed)).not.toThrow();

    const other = await doorAuth("someone-else@example.com");
    expect(() => assertApprover(approverFrom({ current: other, initiator: null }, managed), managed)).toThrow(UnauthorizedApproverError);
  });
});
