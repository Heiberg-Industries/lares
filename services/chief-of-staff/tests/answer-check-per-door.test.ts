/**
 * Who may answer an approval card, at each door, driven through eve 1.0's REAL answer check.
 *
 * eve decides in two steps (`harness/hitl/responders.js`):
 *   1. `checkResponders`: an answer needs an option eve knows. If the tool has NO response policy, the
 *      answer is admitted when the card has no requester at all (anyone may answer) or the answerer is the
 *      requester; a policy-less card with a different answerer is refused. If the tool HAS a response policy
 *      the answer must carry an identity and is held for step 2.
 *   2. `weighResponders`: the tool's response policy decides, for Approve AND for Deny.
 * Lares attaches a response policy to every gated tool, so a card with no requester or an answerer who is not
 * the agent's owner is refused at each door. The cards here are built by eve's own `askApprovals`, the tool is
 * the one the real catalogue resolver emits, and the verdict is eve's (`response.admitted` / `response.settled`).
 *
 * NOT DRIVEN here: eve actually running the approved call afterwards (needs a compiled agent), and the doors'
 * own code that turns a tap into an answer (Slack and Telegram channels). For Telegram, eve 1.0's own channel
 * resumes a tap with the tapper's identity (`defaultTelegramAuth` shape, read in the installed source) and the
 * webhook front door (`lib/telegram-tap-gate.ts`) turns away a stranger's tap before eve; this file takes that
 * identity, or none, as the answerer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { driveAnswer } from "./helpers/answer-check.js";
import { eveDynamicFor } from "./helpers/catalogue-tool.js";

const slack = (id: string) => ({ authenticator: "slack-webhook", issuer: "slack", principalId: id, principalType: "user", attributes: { user_id: id } });
// The identity eve 1.0's Telegram channel gives a tap (`defaultTelegramAuth` shape); `null` stands for a tap with no identity.
const telegram = (id: string) => ({ authenticator: "telegram-webhook", issuer: "telegram", principalId: id, principalType: "user", attributes: { user_id: id } });
// A web chat answer by a console member whose admission is not the conversation's own.
const consoleStranger = { authenticator: "lares-console", principalId: "member-x", principalType: "user", attributes: { user_id: "member-x" } };

beforeEach(() => {
  // TWO allowed people on each door: the first id is the owner, the second may talk to the agent but not approve for the owner.
  vi.stubEnv("SLACK_ALLOWED_USER_IDS", "U_OWNER,U_SECOND");
  vi.stubEnv("TELEGRAM_PRINCIPAL_ID", "100,200");
  vi.stubEnv("LARES_AGENT_INCARNATION", "");
});
afterEach(() => vi.unstubAllEnvs());

const answer = async (o: { requester: unknown; responder: unknown; optionId: string; withPolicy?: boolean }) =>
  driveAnswer({ tool: (await eveDynamicFor("echo_note"))["echo_note"], toolName: "echo_note", input: { note: "hello" }, ...o });

const refused = (r: { stage: string }) => r.stage !== "admitted" && r.stage !== "admitted-without-policy";

// The requester of a card raised by a SCHEDULED turn (a brief, a meeting follow-up, track routing) is the app principal.
const app = { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: {} };

describe.each([["approve"], ["deny"]])("%s, at each door", (optionId) => {
  describe("Slack", () => {
    it("the owner's answer on a card they raised is admitted", async () => {
      expect((await answer({ requester: slack("U_OWNER"), responder: slack("U_OWNER"), optionId })).stage).toBe("admitted");
    });
    it("the owner's answer on a card a SCHEDULED turn raised (requester = the app) is admitted", async () => {
      expect((await answer({ requester: app, responder: slack("U_OWNER"), optionId })).stage).toBe("admitted");
    });
    it("somebody else is refused, on a person's card, a scheduled card and a card with no requester; the card stays open", async () => {
      for (const requester of [slack("U_OWNER"), app, null]) {
        const r = await answer({ requester, responder: slack("U_STRANGER"), optionId });
        expect(r).toMatchObject({ stage: "held-or-refused", types: [["response.settled", "refused"]] }); // eve's verdict: refused by the policy
      }
    });
    it("a card with no requester is answered by the owner and by nobody else", async () => {
      expect((await answer({ requester: null, responder: slack("U_OWNER"), optionId })).stage).toBe("admitted");
    });
    it("an answer with no identity is refused", async () => {
      expect(refused(await answer({ requester: slack("U_OWNER"), responder: null, optionId }))).toBe(true);
      expect(refused(await answer({ requester: app, responder: null, optionId }))).toBe(true);
    });
  });

  describe("a second ALLOWED person (not the owner), on each door", () => {
    it.each([["Slack", slack("U_SECOND")], ["Telegram", telegram("200")]])("%s: refused on a person's card, a scheduled card (requester = the app) and a card with no requester", async (_door, second) => {
      for (const requester of [slack("U_OWNER"), telegram("100"), app, null]) {
        const r = await answer({ requester, responder: second, optionId });
        expect(r, `${_door} ${String((requester as any)?.authenticator)}`).toMatchObject({ stage: "held-or-refused", types: [["response.settled", "refused"]] });
      }
    });
    it("the owner is still admitted next to them", async () => {
      expect((await answer({ requester: app, responder: slack("U_OWNER"), optionId })).stage).toBe("admitted");
      expect((await answer({ requester: app, responder: telegram("100"), optionId })).stage).toBe("admitted");
    });
  });

  describe("Telegram", () => {
    it("a tap resumed with the owner's identity is admitted, on the owner's card, a scheduled card and a card with no requester", async () => {
      for (const requester of [telegram("100"), app, null])
        expect((await answer({ requester, responder: telegram("100"), optionId })).stage, String(requester?.authenticator)).toBe("admitted");
    });
    it("a tap by anyone else (eve resumes it with no identity, or with another id) is refused, on every kind of card", async () => {
      for (const requester of [telegram("100"), app, null]) {
        expect(refused(await answer({ requester, responder: null, optionId }))).toBe(true);
        expect(refused(await answer({ requester, responder: telegram("999"), optionId }))).toBe(true);
      }
    });
  });

  describe("web chat conversation (a native card, answered by a console identity)", () => {
    it("a console identity that is not an allowed approver is refused, on every kind of card", async () => {
      for (const requester of [slack("U_OWNER"), app, null])
        expect(refused(await answer({ requester, responder: consoleStranger, optionId }))).toBe(true);
    });
  });
});

describe("what the default alone would have done (no response policy), for the record", () => {
  it("lets anyone answer a card that has no requester, which is why Lares attaches a policy", async () => {
    const r = await answer({ requester: null, responder: slack("U_STRANGER"), optionId: "approve", withPolicy: false });
    expect(r.stage).toBe("admitted-without-policy");
  });
  it("refuses a different answerer than the requester when the card has one", async () => {
    const r = await answer({ requester: slack("U_OWNER"), responder: slack("U_STRANGER"), optionId: "approve", withPolicy: false });
    expect(r.stage).toBe("refused-before-policy");
  });
});
