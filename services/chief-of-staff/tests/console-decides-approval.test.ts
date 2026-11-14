// An approval asked on Telegram or Slack can be decided from the console's Waiting on you page.
//
// The console does it through the agent's own HTTP door, the same way web chat answers its own
// cards: `POST /eve/v1/session/<sessionId>` with `{ answers: [{ interactionId, optionId }] }`,
// HTTP Basic with the route password, and `x-lares-member` naming the signed-in owner. eve's door
// hands that to `attachSession(sessionId).respond(...)`, which is pinned to the durable session id
// whatever channel opened it — so the request that a Telegram card is waiting on is answered.
//
// Three halves, run for real:
//   1. the door turns the console's request into the `lares-console` identity of that member;
//   2. eve 1.0's REAL answer check (`checkResponders` + `weighResponders`, driven by `helpers/answer-check.ts`)
//      admits that identity's Approve and Deny on a card a Telegram session raised, when it is the agent's
//      owner, and refuses anyone else and a card with no requester;
//   3. the tool's approver check, at execution, reads the answerer from `ctx.approval.responder` (eve 1.0:
//      `session.auth.current` is the person who asked, on Telegram) and accepts the owner, refuses others.
// NOT DRIVEN: eve's own session route turning the HTTP request into an answer (`attachSession(...).respond`),
// which needs a running agent; and the console-side proxy that sends it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { approverFrom, assertApprover, assertApproval, UnauthorizedApproverError } from "../lib/approvals.js";
import { driveAnswer } from "./helpers/answer-check.js";
import { eveDynamicFor } from "./helpers/catalogue-tool.js";

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

  describe("2. eve's real answer check, on a card the Telegram session raised", () => {
    const telegram = { authenticator: "telegram-webhook", issuer: "telegram", principalId: "100", principalType: "user", attributes: { user_id: "100" } };
    const verdict = async (responder: unknown, optionId: string, requester: unknown = telegram) =>
      driveAnswer({ tool: (await eveDynamicFor("echo_note"))["echo_note"], toolName: "echo_note", input: { note: "hello" }, requester, responder, optionId });
    beforeEach(() => {
      // The unclaimed-door lists: the console's owner address and the Telegram owner id.
      vi.stubEnv("LARES_AGENT_INCARNATION", "");
      // The owner is the FIRST id on each list; the second console member and the second Telegram person are allowed but not the owner.
      vi.stubEnv("CONSOLE_ALLOWED_EMAILS", `${OWNER},second@example.com`);
      vi.stubEnv("TELEGRAM_PRINCIPAL_ID", "100,200");
    });
    afterEach(() => vi.unstubAllEnvs());

    it.each(["approve", "deny"])("the owner's console %s is admitted", async (optionId) => {
      const r = await verdict(await doorAuth(OWNER), optionId);
      expect(r, JSON.stringify(r)).toMatchObject({ stage: "admitted" });
    });
    const app = { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: {} };
    it.each(["approve", "deny"])("the owner's console %s is admitted on a card a SCHEDULED turn raised (requester = the app) and on one with no requester", async (optionId) => {
      for (const requester of [app, null]) expect((await verdict(await doorAuth(OWNER), optionId, requester)).stage).toBe("admitted");
    });
    it.each(["approve", "deny"])("a second ALLOWED console member's %s is refused too, on a person's card, a scheduled card and one with no requester", async (optionId) => {
      for (const requester of [telegram, app, null]) expect((await verdict(await doorAuth("second@example.com"), optionId, requester)).stage).not.toBe("admitted");
    });
    it.each(["approve", "deny"])("another member's console %s is refused, on a person's card, a scheduled card and one with no requester", async (optionId) => {
      for (const requester of [telegram, app, null]) expect((await verdict(await doorAuth("someone-else@example.com"), optionId, requester)).stage).not.toBe("admitted");
    });
  });

  it("3. at execution the answerer is ctx.approval.responder: the owner's console answer passes, another member's or none is refused", async () => {
    vi.stubEnv("LARES_AGENT_INCARNATION", "");
    vi.stubEnv("CONSOLE_ALLOWED_EMAILS", `${OWNER},second@example.com`);
    vi.stubEnv("TELEGRAM_PRINCIPAL_ID", "100,200");
    const telegram = { authenticator: "telegram-webhook", principalId: "100", principalType: "user", attributes: { user_id: "100" } };
    const run = (responder?: unknown) => ({ callId: "call-1", session: { auth: { current: telegram, initiator: telegram } }, ...(responder === undefined ? {} : { approval: { responder } }) });
    // The assertApproval path itself reads the process env, hence the stubs above; it needs the ledger, which passes when no row exists.
    await expect(assertApproval(run(await doorAuth(OWNER)) as never, "echo_note", { note: "hello" })).resolves.toBeUndefined();
    await expect(assertApproval(run(await doorAuth("someone-else@example.com")) as never, "echo_note", { note: "hello" })).rejects.toThrow(UnauthorizedApproverError);
    // An ALLOWED second console member, or an allowed second Telegram person, is not the owner: refused at execution too.
    await expect(assertApproval(run(await doorAuth("second@example.com")) as never, "echo_note", { note: "hello" })).rejects.toThrow(UnauthorizedApproverError);
    await expect(assertApproval(run({ authenticator: "telegram-webhook", principalId: "200", principalType: "user", attributes: { user_id: "200" } }) as never, "echo_note", { note: "hello" })).rejects.toThrow(UnauthorizedApproverError);
    await expect(assertApproval(run({}) as never, "echo_note", { note: "hello" })).rejects.toThrow(UnauthorizedApproverError);
    vi.unstubAllEnvs();
  });
});
