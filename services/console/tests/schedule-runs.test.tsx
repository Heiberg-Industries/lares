// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("../app/actions/definition", () => ({ acceptOutsideDescriptions: vi.fn() }));
vi.mock("../app/actions/autonomy", () => ({ setAutonomy: vi.fn() }));
vi.mock("../app/actions/delivery", () => ({ saveDelivery: vi.fn() }));
vi.mock("../lib/db", () => ({ pool: { query: vi.fn() } }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
import type { ScheduleRunRow } from "@lares/agent-kit/schedule-heartbeat";
import { AgentDetail } from "../components/AgentDetail";
import type { AgentFolder } from "../lib/agents";
import { readScheduleLastRuns, SCHEDULE_RUN_STALE_MS, scheduleLastRun, type ScheduleRunFacts } from "../lib/schedule-runs";

afterEach(cleanup);
const tz = "UTC";
const now = new Date("2026-11-27T12:00:00Z");
const outcome = (over: Partial<ScheduleRunRow>): ScheduleRunRow => ({
  job: "example/voice-learn", agent: "example", state: "finished", reason: "", detail: "", counts: {},
  startedAt: new Date("2026-11-27T09:00:00Z"), updatedAt: new Date("2026-11-27T09:30:00Z"), ...over,
});
const facts = (over: Partial<ScheduleRunFacts> = {}): ScheduleRunFacts => ({ outcomes: {}, passes: {}, shared: false, ...over });

describe("a schedule's last run, from what it recorded", () => {
  it("uses the outcome record where the schedule writes one: finished, failed with the error, skipped with why", () => {
    expect(scheduleLastRun("voice-learn", facts({ outcomes: { "voice-learn": outcome({}) } }), now, tz)).toEqual({ state: "finished", when: "today at 09:30" });
    expect(scheduleLastRun("voice-learn", facts({ outcomes: { "voice-learn": outcome({ state: "failed", detail: "no model" }) } }), now, tz))
      .toEqual({ state: "failed", when: "today at 09:30", why: "The error was: no model" });
    expect(scheduleLastRun("voice-learn", facts({ outcomes: { "voice-learn": outcome({ state: "skipped", reason: "switched-off", detail: "Voice Learn is switched off for this agent, so it did not run." }) } }), now, tz))
      .toEqual({ state: "skipped", when: "today at 09:30", why: "Voice Learn is switched off for this agent, so it did not run." });
  });

  it("a run that is going says Running; one silent for hours did not finish", () => {
    const going = outcome({ state: "running", startedAt: new Date(now.getTime() - 60_000), updatedAt: new Date(now.getTime() - 60_000) });
    expect(scheduleLastRun("voice-learn", facts({ outcomes: { "voice-learn": going } }), now, tz)).toEqual({ state: "running" });
    const silent = outcome({ state: "running", startedAt: new Date(now.getTime() - SCHEDULE_RUN_STALE_MS), updatedAt: new Date(now.getTime() - SCHEDULE_RUN_STALE_MS) });
    expect(scheduleLastRun("voice-learn", facts({ outcomes: { "voice-learn": silent } }), now, tz)?.state).toBe("failed");
  });

  it("otherwise uses the heartbeat's last pass, and says when that is shared by every agent of this kind", () => {
    const pass = new Date("2026-11-26T07:00:00Z");
    expect(scheduleLastRun("morning-brief", facts({ passes: { "morning-brief": pass } }), now, tz)).toEqual({ state: "finished", when: "on 2026-11-26 at 07:00" });
    expect(scheduleLastRun("morning-brief", facts({ passes: { "morning-brief": pass }, shared: true }), now, tz)?.why).toBe("That is the last pass by any agent of this kind.");
    expect(scheduleLastRun("digest", facts(), now, tz)).toBeNull();
  });

  it("reads the outcome record by the agent's own key and the heartbeat by the role's key, in one call each", async () => {
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes("FROM schedule_run")) {
        expect(values).toEqual([["example/voice-learn"]]);
        return { rows: [{ job: "example/voice-learn", agent: "example", state: "skipped", reason: "no-mailbox", detail: "No mailbox is chosen.", counts: {}, started_at: null, updated_at: "2026-11-27T09:30:00Z" }] };
      }
      if (sql.includes("FROM agent_definitions")) { expect(values).toEqual(["chief-of-staff"]); return { rows: [{ n: "1" }] }; }
      expect(values).toEqual([["chief-of-staff/voice-learn", "chief-of-staff/morning-brief", "chief-of-staff/digest"]]);
      return { rows: [{ agent: "chief-of-staff/morning-brief", updated_at: "2026-11-27T07:00:00Z" }] };
    });
    const runs = await readScheduleLastRuns({ name: "example", role: "chief-of-staff", started: true }, ["voice-learn", "morning-brief", "digest"], now, { query } as never);
    expect(runs["voice-learn"]).toMatchObject({ state: "skipped", why: "No mailbox is chosen." });
    expect(runs["morning-brief"]).toMatchObject({ state: "finished" });
    expect(runs.digest).toBeNull();
    expect(runs["morning-brief"]?.why).toBeUndefined();
  });

  it("counts every saved agent of the kind, started or not, before calling a heartbeat its own", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM agent_definitions")) return { rows: [{ n: "2" }] };
      return { rows: [{ agent: "chief-of-staff/morning-brief", updated_at: "2026-11-27T07:00:00Z" }] };
    });
    const runs = await readScheduleLastRuns({ name: "example", role: "chief-of-staff", started: true }, ["morning-brief"], now, { query } as never);
    expect(runs["morning-brief"]?.why).toBe("That is the last pass by any agent of this kind.");
  });

  it("an agent that has never started gets no heartbeat time, only its own outcome records", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM schedule_run")) return { rows: [] };
      throw new Error(`no other read is expected: ${sql}`);
    });
    const runs = await readScheduleLastRuns({ name: "example", role: "chief-of-staff", started: false }, ["voice-learn", "morning-brief"], now, { query } as never);
    expect(runs).toEqual({ "voice-learn": null, "morning-brief": null });
  });

  it("a source that cannot be read is said as unreadable, never as nothing recorded or an older pass", async () => {
    // Only the outcome record fails: voice learning must not fall back to its older heartbeat.
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM schedule_run")) throw new Error("no such table");
      return { rows: [{ agent: "chief-of-staff/voice-learn", updated_at: "2026-11-20T04:00:00Z" }] };
    });
    await expect(readScheduleLastRuns({ name: "example", role: "chief-of-staff", started: true }, ["voice-learn"], now, { query } as never)).rejects.toThrow();
    const down = vi.fn(async () => { throw new Error("database down"); });
    await expect(readScheduleLastRuns({ name: "example", role: "chief-of-staff", started: true }, ["digest"], now, { query: down } as never)).rejects.toThrow();
  });
});

describe("the Schedules tab", () => {
  const agent = { name: "example", displayName: "Example", role: "Chief of staff", skills: [], doors: [], grants: [], startedAt: "2026-10-01T06:00:00Z" } as unknown as AgentFolder;
  it("keeps On and Off, adds each schedule's last run and why, and drops the saved-setting caveat", async () => {
    render(<AgentDetail owner agent={agent} board={{ available: true, value: [] }} events={{ available: false }} schedules={{ available: true, value: [
      { name: "voice-learn", on: true, lastRun: { state: "skipped", when: "today at 09:30", why: "No mailbox is chosen." } },
      { name: "morning-brief", on: true, lastRun: { state: "finished", when: "today at 07:00" } },
      { name: "digest", on: true, lastRun: null },
      { name: "dream", on: false },
    ] }} />);
    await userEvent.click(screen.getByRole("tab", { name: "Schedules" }));
    const html = document.body.innerHTML;
    expect(html).toContain(">On<");
    expect(html).toContain("Did not run today at 09:30. No mailbox is chosen.");
    expect(html).toContain("Finished today at 07:00.");
    expect(html).toContain("No run recorded yet.");
    expect(html).not.toContain("On means the setting is saved.");
    expect(html).toContain("Each schedule that is on shows when it last ran, from what it recorded.");
  });
  // Real time: the page asks again after its own five seconds (`useKeepFresh`).
  it("a schedule that is running keeps the page up to date until it is not", { timeout: 15_000 }, async () => {
    refresh.mockClear();
    render(<AgentDetail owner agent={agent} board={{ available: true, value: [] }} events={{ available: false }} schedules={{ available: true, value: [
      { name: "voice-learn", on: true, lastRun: { state: "running" } },
    ] }} />);
    await userEvent.click(screen.getByRole("tab", { name: "Schedules" }));
    expect(document.body.innerHTML).toContain('data-state="running"');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled(), { timeout: 7_000 });
  });

  it("keeps the caveat when the runs could not be read", async () => {
    render(<AgentDetail owner agent={agent} board={{ available: true, value: [] }} events={{ available: false }} schedules={{ available: true, value: [{ name: "digest", on: true }] }} />);
    await userEvent.click(screen.getByRole("tab", { name: "Schedules" }));
    expect(document.body.innerHTML).toContain("On means the setting is saved. It does not confirm the next run.");
  });
});
