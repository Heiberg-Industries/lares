// The Meetings page (it was "Meeting follow-ups" at another address): where the notes come from, then the follow-ups.
import React from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const m = vi.hoisted(() => ({ guard: vi.fn(), source: vi.fn(), lookup: vi.fn(), credential: vi.fn(), status: vi.fn(), series: vi.fn(), agents: vi.fn() }));
vi.mock("../lib/auth", () => ({ requirePage: m.guard }));
vi.mock("../lib/meetings-source", () => ({ getMeetingsSourceView: m.source }));
vi.mock("../lib/clipping", () => ({ getMeetingsLookupView: m.lookup }));
vi.mock("../lib/credentials", () => ({ getCredentialView: m.credential }));
vi.mock("../lib/meeting-followup-status", () => ({ getFollowupStatus: m.status }));
vi.mock("../lib/meeting-series", () => ({ listAutoSendSeries: m.series }));
vi.mock("../lib/agents", () => ({ listAgents: m.agents }));
vi.mock("../components/MeetingsSourceControl", () => ({ MeetingsSourceControl: ({ notion }: { notion: string }) => <section>SOURCE notion:{notion}</section> }));
vi.mock("../components/MeetingSeriesRow", () => ({ MeetingSeriesRow: ({ name }: { name: string }) => <li>SERIES {name}</li> }));
vi.mock("../components/KeepPageFresh", () => ({ KeepPageFresh: ({ active }: { active: boolean }) => <i>fresh:{String(active)}</i> }));
import MeetingsPage from "../app/meetings/page";

const show = async () => renderToStaticMarkup(await MeetingsPage()).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const status = (over: object = {}) => ({ kind: "status", status: { activeRevision: "x", state: "applied", ...over } });
beforeEach(() => {
  vi.clearAllMocks(); m.guard.mockResolvedValue({ id: "owner-1" });
  m.source.mockResolvedValue({ value: null, from: "none", canChange: true, chiefCount: 1 });
  m.lookup.mockResolvedValue({ unavailable: false, request: null, busy: false });
  m.credential.mockResolvedValue(status());
  m.status.mockResolvedValue({ state: "finished", when: "today at 11:55", why: "Checked the meeting notes: nothing new to follow up.", active: false });
  m.series.mockResolvedValue([]); m.agents.mockResolvedValue([]);
});

it("is called Meetings, opens to admins, and has its two sections in order", async () => {
  const t = await show();
  expect(m.guard).toHaveBeenCalledWith("admin");
  expect(t).toContain("Meetings");
  expect(t).not.toContain("Meeting follow-ups");
  const order = ["SOURCE", "Follow-ups", "Finished today at 11:55. Checked the meeting notes: nothing new to follow up.", "No meeting series sends follow-ups on its own"].map((w) => t.indexOf(w));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(t).toContain("fresh:false");
});

it("tells the source whether Notion is connected, and claims nothing when it cannot see the key", async () => {
  expect(await show()).toContain("notion:connected");
  m.credential.mockResolvedValue(status({ activeRevision: null, state: "not-configured" }));
  expect(await show()).toContain("notion:not-connected");
  m.credential.mockResolvedValue({ kind: "administrator-required" });
  expect(await show()).toContain("notion:unknown");
});

it("keeps itself up to date while a pass is going, and says so when nothing has run or nothing can be read", async () => {
  m.status.mockResolvedValue({ state: "running", why: "Reading the meeting notes now.", active: true });
  expect(await show()).toContain("fresh:true");
  m.status.mockResolvedValue(null);
  expect(await show()).toContain("The follow-ups have not run yet.");
  m.status.mockResolvedValue("unavailable");
  expect(await show()).toContain("What the follow-ups last did could not be read.");
});

it("lists the series that may send on their own", async () => {
  m.series.mockResolvedValue([{ agent: "a", seriesKey: "k", name: "Weekly sync", updatedBy: "owner", updatedAt: new Date("2026-11-01T00:00:00Z") }]);
  expect(await show()).toContain("SERIES Weekly sync");
});
