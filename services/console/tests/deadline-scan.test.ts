import { describe, expect, it } from "vitest";
import type { ScheduleRunRow } from "@lares/agent-kit/schedule-heartbeat";
import { DEADLINE_SCAN_SKIPS, deadlineScanJob } from "@lares/agent-kit/deadline-scan-outcome";
import { DEADLINE_SCAN_STALE_MS, deadlineScanStatus, emptyCandidatesText, type ScanAgent } from "../lib/deadline-scan";

const tz = "UTC";
const now = new Date("2026-11-27T12:00:00Z");
const agent: ScanAgent = { name: "chief-of-staff", displayName: "Example", briefOn: true };
const run = (over: Partial<ScheduleRunRow>): ScheduleRunRow => ({
  job: deadlineScanJob(agent.name), agent: agent.name, state: "finished", reason: "", detail: "", counts: {},
  startedAt: new Date("2026-11-27T07:00:00Z"), updatedAt: new Date("2026-11-27T07:01:00Z"), ...over,
});

describe("the Deadlines page tells an empty list from a scan that did not happen", () => {
  it("a finished scan: the empty list means none were found", () => {
    const view = deadlineScanStatus({ agents: [agent], runs: [run({ counts: { found: 0 } })] }, now, tz);
    expect(view).toEqual({ state: "finished", when: "today at 07:01", why: "No due notices in mail.", active: false, scanned: true });
    expect(emptyCandidatesText(view)).toBe("No unresolved candidates.");
    expect(deadlineScanStatus({ agents: [agent], runs: [run({ counts: { found: 2 } })] }, now, tz).why).toBe("Saw 2 due notices in mail.");
  });

  it("no record yet: it has not run, and the empty list does not claim otherwise", () => {
    const view = deadlineScanStatus({ agents: [agent], runs: [] }, now, tz);
    expect(view.state).toBe("waiting");
    expect(view.why).toBe("The mail scan has not run yet. It runs with the morning brief, at its hour.");
    expect(emptyCandidatesText(view)).not.toBe("No unresolved candidates.");
  });

  it("switched off: says so from the definition, with the switch to press, before any run", () => {
    const view = deadlineScanStatus({ agents: [{ ...agent, briefOn: false }], runs: [run({ counts: { found: 0 } })] }, now, tz);
    expect(view.state).toBe("skipped");
    expect(view.why).toBe("The morning brief is switched off for Example, and the mail scan for due notices runs inside it.");
    expect(view.fix).toEqual({ href: "/agents/chief-of-staff/edit", label: "Switch it on in Edit agent" });
    expect(view.scanned).toBe(false);
  });

  it("no mailbox and an unusable mailbox are skips with their reason and where to fix them", () => {
    const skip = (reason: string) => deadlineScanStatus({ agents: [agent], runs: [run({ state: "skipped", reason, detail: "the schedule's sentence", startedAt: null })] }, now, tz);
    expect(skip(DEADLINE_SCAN_SKIPS.noMailbox)).toMatchObject({ state: "skipped", when: "today at 07:01", why: "No mailbox chosen for Example, so there was no mail to scan.", fix: { href: "/agents/chief-of-staff", label: "Choose one on its Access tab" } });
    expect(skip(DEADLINE_SCAN_SKIPS.mailboxUnusable)).toMatchObject({ why: "The mailbox chosen for Example cannot be used right now." });
    expect(skip("something-new")).toMatchObject({ why: "the schedule's sentence" });
  });

  it("a failed scan says the error, and a running one keeps the page up to date until it stops", () => {
    expect(deadlineScanStatus({ agents: [agent], runs: [run({ state: "failed", detail: "Gmail did not answer" })] }, now, tz))
      .toMatchObject({ state: "failed", why: "The error was: Gmail did not answer", active: false });
    const going = run({ state: "running", startedAt: new Date(now.getTime() - 60_000), updatedAt: new Date(now.getTime() - 60_000) });
    expect(deadlineScanStatus({ agents: [agent], runs: [going] }, now, tz)).toMatchObject({ state: "running", active: true });
    const silent = run({ state: "running", startedAt: new Date(now.getTime() - DEADLINE_SCAN_STALE_MS - 1), updatedAt: new Date(now.getTime() - DEADLINE_SCAN_STALE_MS - 1) });
    expect(deadlineScanStatus({ agents: [agent], runs: [silent] }, now, tz)).toMatchObject({ state: "failed", active: false });
  });

  it("with two agents, the newest outcome wins and names whose it was; a retired agent's record is ignored", () => {
    const other: ScanAgent = { name: "second-cos", displayName: "Second", briefOn: true };
    const theirs = run({ job: deadlineScanJob(other.name), agent: other.name, state: "skipped", reason: DEADLINE_SCAN_SKIPS.noMailbox, updatedAt: new Date("2026-11-27T08:00:00Z") });
    const view = deadlineScanStatus({ agents: [agent, other], runs: [run({ counts: { found: 1 } }), theirs] }, now, tz);
    expect(view.why).toBe("No mailbox chosen for Second, so there was no mail to scan.");
    const gone = run({ job: deadlineScanJob("retired-one"), agent: "retired-one", updatedAt: new Date("2026-11-27T09:00:00Z"), state: "failed", detail: "x" });
    expect(deadlineScanStatus({ agents: [agent], runs: [run({ counts: { found: 1 } }), gone] }, now, tz).state).toBe("finished");
  });

  it("no chief-of-staff agent, or definitions that could not be read, are said plainly", () => {
    expect(deadlineScanStatus({ agents: [], runs: [] }, now, tz).why).toBe("There is no chief-of-staff agent, so nothing scans mail for due notices.");
    expect(deadlineScanStatus({ agents: null, runs: [] }, now, tz).why).toBe("Whether the mail scan has run could not be read just now.");
  });
});
