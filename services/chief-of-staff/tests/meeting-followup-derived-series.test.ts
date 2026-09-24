import { describe, expect, it } from "vitest";
import { derivedSeriesKey } from "../lib/meeting-followup.js";
import { makeFollowupTick, type FollowupDeps, type MeetingRow } from "../agent/schedules/meeting-followup.js";

describe("derivedSeriesKey", () => {
  it("is stable when Notion appends a numeric date to a separately-booked meeting", () => {
    expect(derivedSeriesKey("Folkepuls Sync 11.09", "2026-09-14T09:00:00+02:00"))
      .toBe("title:folkepuls sync:mon");
    expect(derivedSeriesKey("Folkepuls Sync 18.09", "2026-09-21T09:00:00+02:00"))
      .toBe("title:folkepuls sync:mon");
    expect(derivedSeriesKey("Folkepuls sync", "2026-09-28")).toBe("title:folkepuls sync:mon");
  });

  it("keeps weekdays distinct without converting the written date through UTC", () => {
    expect(derivedSeriesKey("Folkepuls sync", "2026-09-15")).toBe("title:folkepuls sync:tue");
  });
});

function row(isStandingSeries: boolean): MeetingRow {
  return {
    pageId: isStandingSeries ? "second" : "first", title: "Folkepuls Sync", startsAt: "2026-09-14T09:00:00+02:00",
    series: "title:folkepuls sync:mon", isStandingSeries,
    attendees: "Stefan <stefan@example.com>, Bendik <owner@owner.example>", summaryBlock: "Summary", actionItems: "- Stefan: Follow up",
  };
}

describe("separately-booked standing meetings", () => {
  it("forces the first occurrence through the card but sends the derived key for recording", async () => {
    const sent: Array<{ seriesKey: string; forceApproval?: boolean }> = [];
    const recorded: Array<[string, string]> = [];
    const deps: FollowupDeps = {
      listMeetings: async () => [row(false)], claim: async () => ({ claimed: true, attempt: 1, isFinalAttempt: false }),
      recordSeriesKey: async (pageId, seriesKey) => { recorded.push([pageId, seriesKey]); },
      compose: async () => ({ subject: "s", bodyText: "b" }), send: async (payload) => { sent.push(payload); },
      getOutcome: async () => null, recordOutcome: async () => {}, notify: async () => {}, reportAutonomousSendFailed: async () => {}, reportDropped: async () => {}, selfEmails: ["owner@owner.example"],
    };
    await makeFollowupTick(deps).tick(new Date("2026-09-14T10:00:00+02:00"));
    expect(recorded).toEqual([["first", "title:folkepuls sync:mon"]]);
    expect(sent).toEqual([expect.objectContaining({ seriesKey: "title:folkepuls sync:mon", forceApproval: true })]);
  });

  it("lets later occurrences use the normal standing-series path", async () => {
    const sent: Array<{ forceApproval?: boolean }> = [];
    const deps: FollowupDeps = {
      listMeetings: async () => [row(true)], claim: async () => ({ claimed: true, attempt: 1, isFinalAttempt: false }),
      compose: async () => ({ subject: "s", bodyText: "b" }), send: async (payload) => { sent.push(payload); },
      getOutcome: async () => null, recordOutcome: async () => {}, notify: async () => {}, reportAutonomousSendFailed: async () => {}, reportDropped: async () => {}, selfEmails: ["owner@owner.example"],
    };
    await makeFollowupTick(deps).tick(new Date("2026-09-14T10:00:00+02:00"));
    expect(sent).toEqual([expect.objectContaining({ forceApproval: false })]);
  });
});
