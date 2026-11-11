// WHO APPROVED A VAULT WRITE, ON EVE 1.0.
//
// `ctx.session.auth.current` is the person who ASKED; for a card a scheduled job raised it is the
// app. The person who ANSWERED is `ctx.approval.responder`. The kit's own check can only ask about
// the requester, so a mounting service injects `NoteWriteDeps.assertApproval`, which then REPLACES
// the kit's requester check. These cases pin that, for all three tools:
//   - injected: the kit's requester check is not asked (it would refuse the app); the injected
//     check gets the tool's own ctx and raw input; a refusal stops the write before any git step;
//     the injected card check (`assertApprovedCall`) still runs after it;
//   - not injected: the kit's requester check runs exactly as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP = { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: {} };
const scheduledCard = {
  callId: "call-1",
  session: { id: "s", auth: { current: APP, initiator: APP } },
  approval: { responder: { authenticator: "telegram-webhook", attributes: { user_id: "100" } } },
};

const TOOLS = [
  { name: "writeTool", input: { area: "private", title: "t", body: "b" } },
  { name: "fileTool", input: { area: "private", path: "_inbox/a.md", destination: "seeds" } },
  { name: "dropTool", input: { area: "private", path: "_inbox/a.md" } },
] as const;

let gitSteps: string[];
let requesterChecks: unknown[];

beforeEach(() => {
  gitSteps = [];
  requesterChecks = [];
  vi.resetModules();
  // The kit's own requester check: refuses the app, as the real one does for any principal not
  // on the allow-list. Recorded so a case can see whether it was asked at all.
  vi.doMock("../extension/lib/approval-gate.js", () => ({
    approverFrom: (auth: { current?: unknown }) => auth?.current,
    assertApprover: (who: unknown) => {
      requesterChecks.push(who);
      throw new Error("approval refused: the requester is not an allowed approver");
    },
  }));
  vi.doMock("../src/vault-git.js", () => ({
    commitNote: async () => { gitSteps.push("commit"); return { commit: "abc1234" }; },
    moveNote: async () => { gitSteps.push("move"); return { commit: "abc1234" }; },
    removeNote: async () => { gitSteps.push("remove"); return { commit: "abc1234" }; },
  }));
  vi.doMock("../src/notes-store.js", () => ({ storeRootForArea: () => "/tmp/vault" }));
});

afterEach(() => {
  vi.doUnmock("../extension/lib/approval-gate.js");
  vi.doUnmock("../src/vault-git.js");
  vi.doUnmock("../src/notes-store.js");
});

const build = async (name: (typeof TOOLS)[number]["name"], deps: Record<string, unknown>) => {
  const kit = await import("../extension/lib/note-write-tools.js");
  return kit[name]({ areas: () => ["private"], ...deps } as never) as unknown as {
    execute: (input: unknown, ctx: unknown) => Promise<unknown>;
  };
};

describe("an injected approver check replaces the kit's requester check", () => {
  for (const { name, input } of TOOLS) {
    it(`${name}: a scheduled card's approved call runs; the requester (the app) is not asked`, async () => {
      const order: string[] = [];
      const seen: unknown[][] = [];
      const tool = await build(name, {
        assertApproval: async (ctx: unknown, raw: unknown) => { order.push("answerer"); seen.push([ctx, raw]); },
        assertApprovedCall: async () => { order.push("card"); },
      });
      await tool.execute(input, scheduledCard);
      expect(requesterChecks).toEqual([]);
      expect(order).toEqual(["answerer", "card"]);
      expect(seen[0]?.[0]).toBe(scheduledCard);
      expect(seen[0]?.[1]).toBe(input);
      expect(gitSteps).toHaveLength(1);
    });

    it(`${name}: a refusal from the injected check stops the call before the card check and any git step`, async () => {
      const order: string[] = [];
      const tool = await build(name, {
        assertApproval: async () => { throw new Error("approval refused: only the owner can answer"); },
        assertApprovedCall: async () => { order.push("card"); },
      });
      await expect(tool.execute(input, scheduledCard)).rejects.toThrow("only the owner can answer");
      expect(order).toEqual([]);
      expect(gitSteps).toEqual([]);
    });

    it(`${name}: with nothing injected the kit's requester check runs, as before`, async () => {
      const tool = await build(name, {});
      await expect(tool.execute(input, scheduledCard)).rejects.toThrow("the requester is not an allowed approver");
      expect(requesterChecks).toEqual([APP]);
      expect(gitSteps).toEqual([]);
    });
  }
});
