// W7D-s3 — a link met in a tainted turn asks first.
//
// The policy under test is the whole control: there is no second check inside `execute` that
// could catch a mistake here, because the in-turn taint is NOT readable there (a turn parked on
// an approval card ends at the park point and the continuation arrives as a brand-new turn id —
// `src/origin-taint.ts`'s `TAINT_MAX_AGE_MS` docblock). So every property the card depends on is
// pinned here, on the policy itself.
//
// THE CONTEXT SHAPES ARE EVE'S OWN. WAVE-3-NOTES point 18: a control that depends on what the
// FRAMEWORK passes in is proven on a real framework run, and a hand-built context proves nothing
// about field names. The last case below is typed as eve 0.60.1's real `ApprovalContext`, so a
// renamed field fails `pnpm -C packages/agent-kit run typecheck` rather than silently reading
// `undefined` and answering "no taint" — which is the fail-OPEN direction and the one failure
// nobody would see.
import type { ApprovalContext } from "eve/tools/approval";
import { afterEach, describe, expect, it } from "vitest";

import { asksAfterUntrustedText, TAINTED_FETCH_REASON } from "../src/tainted-approval.js";
import { resetTaintForTests, taintTurn } from "../src/origin-taint.js";

afterEach(() => resetTaintForTests());
const ctx = (sessionId: string, turnId: string) => ({ session: { id: sessionId, turn: { id: turnId } } });

describe("a fetch after untrusted text", () => {
  it("does not ask on a clean turn", async () => {
    expect(await asksAfterUntrustedText()(ctx("s1", "t1"))).toBe("not-applicable");
  });

  it("asks once the turn has read somebody else's words", async () => {
    taintTurn({ sessionId: "s1", turnId: "t1" }, "third_party");
    expect(await asksAfterUntrustedText()(ctx("s1", "t1"))).toBe("user-approval");
  });

  it("asks after synced text too — a Notion page is still not the owner's own words", async () => {
    taintTurn({ sessionId: "s1", turnId: "t1" }, "synced");
    expect(await asksAfterUntrustedText()(ctx("s1", "t1"))).toBe("user-approval");
  });

  it("does not leak across turns or sessions", async () => {
    taintTurn({ sessionId: "s1", turnId: "t1" }, "third_party");
    expect(await asksAfterUntrustedText()(ctx("s1", "t2"))).toBe("not-applicable");
    expect(await asksAfterUntrustedText()(ctx("s2", "t1"))).toBe("not-applicable");
  });

  it("asks when it cannot tell which turn it is in", async () => {
    expect(await asksAfterUntrustedText()(undefined)).toBe("user-approval");
    expect(await asksAfterUntrustedText()({ session: {} })).toBe("user-approval");
  });

  // Owner decision D1: "a link the owner sent himself, in a turn where nothing else was read,
  // does not ask." That is exactly the untainted case above — stated here as the decision, so a
  // future change that makes every link ask fails a test that names the decision.
  it("a link the owner sent himself, in a turn where nothing else was read, does not ask", async () => {
    expect(await asksAfterUntrustedText()(ctx("owner-session", "first-turn"))).toBe("not-applicable");
  });

  // The policy is a FUNCTION, not eve's `{request, response}` object: each role's
  // `agent/tools/catalogue.ts` re-stamps the durable descriptor by CALLING `tool.approval`, and an
  // object called as a function drops the whole resolver result (the 4/2/3-tools incident).
  it("is a function of one context, the shape a durable descriptor re-stamps by calling it", () => {
    const policy = asksAfterUntrustedText();
    expect(typeof policy).toBe("function");
    expect(policy.length).toBeLessThanOrEqual(1);
  });

  it("says, in one owner-readable sentence, why a link can ask", () => {
    expect(TAINTED_FETCH_REASON).toContain("did not write");
    expect(TAINTED_FETCH_REASON.length).toBeGreaterThan(20);
  });

  // eve 0.60.1's real `ApprovalContext` — `dist/src/approval/definition.d.ts`: it extends
  // `SessionContext` (`dist/src/context/session-context.d.ts`), whose `session.turn` is
  // `SessionTurn = { id, sequence }` (`dist/src/channel/types.d.ts:51-54`). `turnKeyFrom` reads
  // `session.id` + `session.turn.id`, which is what `buildCallbackContext()` fills in
  // (`dist/src/context/build-callback-context.js`).
  it("reads the turn off eve 0.60.1's own ApprovalContext, not off a shape we invented", async () => {
    const real: ApprovalContext = {
      abortSignal: new AbortController().signal,
      approvedTools: new Set<string>(),
      callId: "call-1",
      toolName: "read_url",
      toolInput: { url: "https://example.test/a" },
      session: {
        id: "s9",
        auth: { current: null, initiator: null },
        turn: { id: "t9", sequence: 3 },
      },
      getSandbox: () => {
        throw new Error("no sandbox in a unit test");
      },
      getSkill: () => {
        throw new Error("no skills in a unit test");
      },
    };
    expect(await asksAfterUntrustedText()(real)).toBe("not-applicable");
    taintTurn({ sessionId: "s9", turnId: "t9" }, "third_party");
    expect(await asksAfterUntrustedText()(real)).toBe("user-approval");
  });
});
