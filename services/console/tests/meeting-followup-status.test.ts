// Meetings, section 2: the status line for the meeting follow-up schedule's last pass (ADR 0031).
import { describe, expect, it } from "vitest";
import type { ScheduleRunRow } from "@lares/agent-kit/schedule-heartbeat";
import { MEETING_FOLLOWUP_SKIPS, meetingFollowupJob } from "@lares/agent-kit/meeting-followup-outcome";
import { countsSentence, followupStatus } from "../lib/meeting-followup-status";

const NOW = new Date("2026-11-27T12:00:00.000Z");
const TZ = "UTC";
const run = (over: Partial<ScheduleRunRow> = {}): ScheduleRunRow => ({
  job: meetingFollowupJob("chief"), agent: "chief", state: "finished", reason: "", detail: "", counts: {},
  startedAt: new Date("2026-11-27T11:55:00.000Z"), updatedAt: new Date("2026-11-27T11:55:30.000Z"), ...over,
});
const one = [{ name: "chief", displayName: "Ada" }];
const two = [...one, { name: "second", displayName: "Bea" }];

describe("the follow-up status line", () => {
  it("has nothing to say before the schedule has recorded a pass", () => {
    expect(followupStatus([], one, NOW, TZ)).toBeNull();
  });
  it("last checked: what was sent, what waits for approval, what waits for a summary", () => {
    expect(followupStatus([run({ counts: { sent: 1, waitingForApproval: 2, waitingForSummary: 3, heldBack: 0, failed: 0 } })], one, NOW, TZ)).toEqual({
      state: "finished", when: "today at 11:55",
      why: "Checked the meeting notes: 1 follow-up sent, 2 follow-ups waiting for your approval, 3 meetings waiting for a summary.", active: false,
    });
    expect(countsSentence({ sent: 0, waitingForApproval: 0, waitingForSummary: 0 })).toBe("Checked the meeting notes: nothing new to follow up.");
    expect(countsSentence({ heldBack: 1, failed: 2 })).toContain("1 follow-up held back for now");
  });
  it("a pass that is going keeps the page up to date; one silent for half an hour reads as stopped", () => {
    expect(followupStatus([run({ state: "running", updatedAt: NOW, startedAt: NOW })], one, NOW, TZ)).toMatchObject({ state: "running", active: true });
    const old = new Date(NOW.getTime() - 31 * 60_000);
    expect(followupStatus([run({ state: "running", updatedAt: old, startedAt: old })], one, NOW, TZ)).toMatchObject({ state: "failed", active: false });
  });
  it("a failure says what the error was", () => {
    expect(followupStatus([run({ state: "failed", detail: "Notion did not answer" })], one, NOW, TZ)?.why).toBe("The error was: Notion did not answer");
  });
  it.each([
    [MEETING_FOLLOWUP_SKIPS.switchedOff, "Meeting follow-ups are switched off for Ada.", "/agents/chief/edit"],
    [MEETING_FOLLOWUP_SKIPS.noDelivery, "Ada has nowhere to send follow-ups", "/agents/chief"],
    [MEETING_FOLLOWUP_SKIPS.noMeetingsDatabase, "No meetings database is chosen yet.", undefined],
    [MEETING_FOLLOWUP_SKIPS.noNotion, "Ada may not use Notion, so it cannot read the meeting notes.", "/integrations/notion"],
  ])("a skip (%s) says why, and links to what fixes it", (reason, why, href) => {
    const s = followupStatus([run({ state: "skipped", reason, detail: "the schedule's own sentence", startedAt: null })], one, NOW, TZ)!;
    expect(s.state).toBe("skipped"); expect(s.why).toContain(why); expect(s.fix?.href).toBe(href);
  });
  it("an unknown skip code shows the schedule's own sentence", () => {
    expect(followupStatus([run({ state: "skipped", reason: "something-new", detail: "Plain words.", startedAt: null })], one, NOW, TZ)?.why).toBe("Plain words.");
  });
  it("with two agents: a pass that is going wins, otherwise the newest, named by display name", () => {
    const busy = run({ job: meetingFollowupJob("second"), agent: "second", state: "running", startedAt: new Date("2026-11-27T11:58:00.000Z"), updatedAt: new Date("2026-11-27T11:58:00.000Z") });
    const newer = run({ updatedAt: new Date("2026-11-27T11:59:00.000Z") });
    expect(followupStatus([newer, busy], two, NOW, TZ)).toMatchObject({ state: "running" });
    expect(followupStatus([newer, run({ job: meetingFollowupJob("second"), agent: "second", updatedAt: new Date("2026-11-27T11:00:00.000Z") })], two, NOW, TZ)?.why).toMatch(/^By Ada\. /);
  });
});
