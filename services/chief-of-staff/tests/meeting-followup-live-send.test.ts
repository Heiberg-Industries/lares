import { describe, it, expect, vi } from "vitest";

import {
  appendSagaSignoff, computeAutonomousPreCheck, makeLivePrecheckWith, meetingFollowupItemKey,
  type FollowupPrecheckDeps,
} from "../agent/schedules/meeting-followup.js";
import { followupApproval, type FollowupApprovalDeps } from "../catalogue/meeting_followup_send.js";
import { fingerprintRecipients } from "../lib/meeting-followup-store.js";

/**
 * Regression coverage for the finding-1 regression: `makeLiveSend`'s pre-check
 * (`computeAutonomousPreCheck`) became load-bearing once finding 1 wired the schedule's
 * read-back/error branch to it, but it was never taught finding 4's group-alias rule — so an
 * opted-in series containing `post@` disagreed with `followupApproval`'s policy, took the
 * "autonomous" path, hit the read-back branch, recorded a false 'error', and could duplicate
 * a send if Bendik approved more than one of the resulting duplicate cards.
 *
 * `computeAutonomousPreCheck` now shares `isGroupAlias` with `followupApproval` and takes the
 * exact same `FollowupApprovalDeps` shape, so this file can drive both from IDENTICAL fixed
 * deps and prove they agree — not merely assert that each independently does the right thing.
 */

const PERSONAL = ["sam@example.com", "taylor@example.com"];
const WITH_ALIAS = ["sam@example.com", "post@company.no"];

function deps(opts: { level?: "autonomous" | "gated" | "never"; lastFingerprint?: string | null }): FollowupApprovalDeps {
  return {
    level: async () => opts.level ?? "gated",
    lastFingerprint: async () => opts.lastFingerprint ?? null,
  };
}

describe("appendSagaSignoff", () => {
  const draft = { subject: "Follow-up", bodyText: "Recap and action items." };

  it("appends the Norwegian disclosure as the final body paragraph", () => {
    expect(appendSagaSignoff(draft, "no", "Bendik Heiberg").bodyText)
      .toBe("Recap and action items.\n\nFra Saga, på vegne av Bendik");
  });

  it("appends the English disclosure and uses the registry first name", () => {
    expect(appendSagaSignoff(draft, "en", "Bendik Heiberg").bodyText)
      .toBe("Recap and action items.\n\nFrom Saga, on behalf of Bendik");
  });
});

describe("computeAutonomousPreCheck (finding-1 regression fix)", () => {
  it("treats an alias recipient as NOT autonomous even for a fully opted-in, fingerprint-matching series", async () => {
    const d = deps({ level: "autonomous", lastFingerprint: fingerprintRecipients(WITH_ALIAS) });
    const autonomous = await computeAutonomousPreCheck({ seriesKey: "s1", to: WITH_ALIAS }, d);
    expect(autonomous).toBe(false);

    // And the tool's own policy agrees — this alias-containing series takes the gated path,
    // never the read-back/error branch the schedule would otherwise route it into.
    const decide = followupApproval(d);
    const decision = await decide({ toolInput: { seriesKey: "s1", to: WITH_ALIAS } } as never);
    expect(decision).toBe("user-approval");
  });

  it("still reports autonomous for a plain opted-in series with matching recipients", async () => {
    const d = deps({ level: "autonomous", lastFingerprint: fingerprintRecipients(PERSONAL) });
    expect(await computeAutonomousPreCheck({ seriesKey: "s1", to: PERSONAL }, d)).toBe(true);
  });
});

describe("pre-check / policy agreement (regression guard)", () => {
  async function bothAgree(seriesKey: string, to: string[], d: FollowupApprovalDeps): Promise<{ autonomous: boolean; approved: boolean }> {
    const autonomous = await computeAutonomousPreCheck({ seriesKey, to }, d);
    const decide = followupApproval(d);
    const decision = await decide({ toolInput: { seriesKey, to } } as never);
    return { autonomous, approved: decision === "approved" };
  }

  it("(a) a plain opted-in series — both say autonomous/approved", async () => {
    const d = deps({ level: "autonomous", lastFingerprint: fingerprintRecipients(PERSONAL) });
    const { autonomous, approved } = await bothAgree("s1", PERSONAL, d);
    expect(autonomous).toBe(approved);
    expect(autonomous).toBe(true);
  });

  it("(b) an opted-in series with an alias recipient — both say gated, never autonomous/approved", async () => {
    const d = deps({ level: "autonomous", lastFingerprint: fingerprintRecipients(WITH_ALIAS) });
    const { autonomous, approved } = await bothAgree("s1", WITH_ALIAS, d);
    expect(autonomous).toBe(approved);
    expect(autonomous).toBe(false);
  });

  it("(c) a one-off meeting (empty seriesKey) — both say gated, whatever the ratchet default is", async () => {
    const d = deps({ level: "autonomous", lastFingerprint: fingerprintRecipients(PERSONAL) });
    const { autonomous, approved } = await bothAgree("", PERSONAL, d);
    expect(autonomous).toBe(approved);
    expect(autonomous).toBe(false);
  });

  it("also agrees when the series is simply gated (not opted in)", async () => {
    const d = deps({ level: "gated" });
    const { autonomous, approved } = await bothAgree("s1", PERSONAL, d);
    expect(autonomous).toBe(approved);
    expect(autonomous).toBe(false);
  });

  it("also agrees when the recipient set has drifted from the last approved fingerprint", async () => {
    const d = deps({ level: "autonomous", lastFingerprint: fingerprintRecipients(PERSONAL) });
    const { autonomous, approved } = await bothAgree("s1", [...PERSONAL, "newperson@external.example"], d);
    expect(autonomous).toBe(approved);
    expect(autonomous).toBe(false);
  });
});

/**
 * LAR-35-s3 — the precheck asked BEFORE `compose`, so a held-back page never bills a compose call
 * at all. `makeLivePrecheckWith` is `makeLiveSend`'s own sibling: parameterised over injected deps
 * the same way `computeAutonomousPreCheck` is, so this can drive it directly and prove it (a)
 * shares `meetingFollowupItemKey` with the real send-turn gate rather than restating it, and (b)
 * releases the claim on a hold the same way `makeLiveSend`'s own held branch does.
 */
describe("makeLivePrecheckWith (LAR-35-s3)", () => {
  function precheckDeps(over: Partial<FollowupPrecheckDeps> = {}): {
    impl: FollowupPrecheckDeps; releasedPageIds: string[]; askedInit: Array<{ cls: string; door: string; itemKey: string }>;
  } {
    const releasedPageIds: string[] = [];
    const askedInit: Array<{ cls: string; door: string; itemKey: string }> = [];
    const impl: FollowupPrecheckDeps = {
      wouldInitiate: async (_schedule, init) => { askedInit.push(init); return { handled: false }; },
      releaseClaim: async (pageId) => { releasedPageIds.push(pageId); },
      ...over,
    };
    return { impl, releasedPageIds, askedInit };
  }

  it("asks under the exact same key `meetingFollowupItemKey` builds — never a restated template", async () => {
    const d = precheckDeps();
    const precheck = makeLivePrecheckWith("C1", d.impl);
    await precheck("page-1", 2);
    expect(d.askedInit).toEqual([
      { cls: "event", door: "slack:C1", itemKey: meetingFollowupItemKey("page-1", 2) },
    ]);
    expect(meetingFollowupItemKey("page-1", 2)).toBe("meeting-followup/page-1#2");
  });

  it("a genuine hold releases the claim and returns held:true", async () => {
    const wouldInitiate = vi.fn(async () => ({ handled: false }));
    const releaseClaim = vi.fn(async () => {});
    const precheck = makeLivePrecheckWith("C1", { wouldInitiate, releaseClaim });
    const outcome = await precheck("page-1", 1);
    expect(outcome).toEqual({ held: true });
    expect(releaseClaim).toHaveBeenCalledWith("page-1");
  });

  it("a `send`-handled outcome returns held:false and does NOT release the claim", async () => {
    const releaseClaim = vi.fn(async () => {});
    const precheck = makeLivePrecheckWith("C1", {
      wouldInitiate: async () => ({ handled: true }),
      releaseClaim,
    });
    const outcome = await precheck("page-1", 1);
    expect(outcome).toEqual({ held: false });
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  it("an already-seen outcome is ALSO handled:true — falls through to one more compose, never a release", async () => {
    // Same `handled` flag the real gate's already-seen suppression sets (fix round 1, CRITICAL) —
    // the precheck cannot and must not tell "send" and "already-seen" apart, since both mean
    // "do not hold this back".
    const releaseClaim = vi.fn(async () => {});
    const precheck = makeLivePrecheckWith("C1", {
      wouldInitiate: async () => ({ handled: true }),
      releaseClaim,
    });
    expect(await precheck("page-1", 1)).toEqual({ held: false });
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  it("a failed release is caught and logged, never thrown into the tick", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const precheck = makeLivePrecheckWith("C1", {
        wouldInitiate: async () => ({ handled: false }),
        releaseClaim: async () => { throw new Error("db down"); },
      });
      await expect(precheck("page-1", 1)).resolves.toEqual({ held: true });
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
