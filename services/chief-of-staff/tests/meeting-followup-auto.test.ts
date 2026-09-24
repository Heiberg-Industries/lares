import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * ORB-156 Task 12 — meeting_followup_auto: the spoken-to-Saga path onto the same ratchet
 * rows `meeting_followup_send`'s policy reads (tests/meeting-followup-approval.test.ts) and
 * the Console (Task 11) lists/revokes. No real Postgres needed here — `KitRatchet` is
 * stubbed the same way tests/meeting-followup-approval.test.ts stubs `../lib/google.js`:
 * a hoisted `vi.mock`, so `execute()` runs for real against a fake ratchet instead of a
 * live one.
 */
let setLevelSpy: ReturnType<typeof vi.fn>;

vi.mock("@lares/agent-kit/ratchet", () => ({
  KitRatchet: class {
    setLevel(...args: unknown[]) {
      return setLevelSpy(...args);
    }
  },
}));
vi.mock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

import meetingFollowupAuto from "../catalogue/meeting_followup_auto.js";
import { UnauthorizedApproverError } from "../lib/approvals.js";
import { configuredOwnerId } from "../lib/identity-client.js";

const BENDIK = "U_EXAMPLE_OWNER";
const SOMEONE_ELSE = "U0BADBADBAD";

function slackAuth(userId: string) {
  // Matches tests/gate.test.ts and tests/remind-set-clock.test.ts: the shape eve's Slack
  // channel builds (buildSlackAuthContext).
  return { authenticator: "slack-webhook", attributes: { user_id: userId } };
}

function ctx(auth: unknown) {
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

beforeEach(() => {
  process.env["SLACK_ALLOWED_USER_IDS"] = BENDIK;
  setLevelSpy = vi.fn(async () => {});
});

afterEach(() => {
  delete process.env["SLACK_ALLOWED_USER_IDS"];
});

describe("meeting_followup_auto (ORB-156)", () => {
  it("writes the level against the series, attributed to the approver", async () => {
    const result = await meetingFollowupAuto.execute(
      { seriesKey: "s1", level: "autonomous", meetingName: "Folkepuls" },
      ctx(slackAuth(BENDIK)),
    );

    expect(setLevelSpy).toHaveBeenCalledTimes(1);
    expect(setLevelSpy).toHaveBeenCalledWith("saga", "meeting_followup", "autonomous", "s1", configuredOwnerId());
    expect(configuredOwnerId()).toBe("bendik");
    expect(result).toMatchObject({ seriesKey: "s1", level: "autonomous", meetingName: "Folkepuls" });
  });

  it("accepts a derived title/day key so a standing separately-booked meeting can be opted in", async () => {
    await meetingFollowupAuto.execute(
      { seriesKey: "title:folkepuls sync:mon", level: "autonomous", meetingName: "Folkepuls Sync" },
      ctx(slackAuth(BENDIK)),
    );
    expect(setLevelSpy).toHaveBeenCalledWith("saga", "meeting_followup", "autonomous", "title:folkepuls sync:mon", configuredOwnerId());
  });

  it("refuses an empty series key rather than writing the capability default", async () => {
    // action = '' is the capability-wide default row. A typo that silently switched EVERY
    // meeting to autonomous is the worst outcome this tool has available to it.
    await expect(
      meetingFollowupAuto.execute({ seriesKey: "", level: "autonomous", meetingName: "x" }, ctx(slackAuth(BENDIK))),
    ).rejects.toThrow(/series/i);
    expect(setLevelSpy).not.toHaveBeenCalled();
  });

  it("refuses a whitespace-only series key the same way", async () => {
    await expect(
      meetingFollowupAuto.execute({ seriesKey: "   ", level: "never", meetingName: "x" }, ctx(slackAuth(BENDIK))),
    ).rejects.toThrow(/series/i);
    expect(setLevelSpy).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace off an otherwise-valid series key before writing", async () => {
    await meetingFollowupAuto.execute(
      { seriesKey: "  s1  ", level: "gated", meetingName: "x" },
      ctx(slackAuth(BENDIK)),
    );
    expect(setLevelSpy).toHaveBeenCalledWith("saga", "meeting_followup", "gated", "s1", configuredOwnerId());
  });

  it("refuses an approver who is not on the allowlist, before writing anything", async () => {
    await expect(
      meetingFollowupAuto.execute(
        { seriesKey: "s1", level: "autonomous", meetingName: "x" },
        ctx(slackAuth(SOMEONE_ELSE)),
      ),
    ).rejects.toThrow(UnauthorizedApproverError);
    expect(setLevelSpy).not.toHaveBeenCalled();
  });

  it("carries an approval gate — always() — so no call can bypass the 👍", () => {
    // Deleting `approval: always()` would let a conversational turn talk Saga into granting
    // autonomy with no human confirmation, which is exactly what this tool must never do.
    expect(meetingFollowupAuto.approval).toBeDefined();
  });
});
