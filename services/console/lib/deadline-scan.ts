// Where the mail scan for due notices stands, for the Deadlines page: so "No unresolved candidates"
// is never confused with "the scanner has not run, is switched off, or has no mailbox".
//
// The scan is the mail pass inside each chief-of-staff agent's morning brief (it records every due
// notice it sees as a candidate). Its outcome is recorded per agent under `<agent name>/deadline-scan`
// (`schedule_run`, written by the morning brief through `@lares/agent-kit/schedule-heartbeat`; the
// key and reason codes are `@lares/agent-kit/deadline-scan-outcome`). Read here together with the
// agents' definitions, for the display name and whether the morning brief is switched on, so the page
// can say "switched off" without waiting for a run that will not come (ADR 0031).
import type { PoolClient } from "pg";
import { readScheduleRuns, type ScheduleRunRow } from "@lares/agent-kit/schedule-heartbeat";
import { DEADLINE_SCAN_CARRIER, DEADLINE_SCAN_SKIPS, deadlineScanJob } from "@lares/agent-kit/deadline-scan-outcome";
import type { RunState } from "@lares/ui/patterns";
import { pool } from "./db";
import { homeTz } from "./proactivity";
import { runWhen } from "./run-when";

/** What the page shows about the scan, ready for `RunStatus`. `active`: keep the page up to date. */
export interface DeadlineScanView {
  state: RunState;
  when?: string;
  why?: string;
  fix?: { href: string; label: string };
  active: boolean;
  /** True when the last scan finished, so an empty candidate list really means none were found. */
  scanned: boolean;
}

/** A chief-of-staff agent: its definition name, the name people see, and its morning brief switch. */
export interface ScanAgent { name: string; displayName: string; briefOn: boolean }

export interface DeadlineScanFacts {
  /** null when the definitions could not be read: then nothing is said about switches. */
  agents: ScanAgent[] | null;
  /** Each agent's last scan outcome, at most one per agent. */
  runs: readonly ScheduleRunRow[];
}

/** A scan that has said nothing for this long did not finish. The brief's whole mail pass is bounded to minutes. */
export const DEADLINE_SCAN_STALE_MS = 30 * 60_000;

const agentPage = (a: ScanAgent) => `/agents/${encodeURIComponent(a.name)}`;
const recordAgent = (r: ScheduleRunRow): string => r.job.slice(0, r.job.indexOf("/"));

/** "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Pure: the one place the facts become words. */
export function deadlineScanStatus(f: DeadlineScanFacts, now: Date, tz: string): DeadlineScanView {
  // Only the records of agents that run today count (a retired agent's record is ignored).
  const known = f.agents ? new Set(f.agents.map((a) => a.name)) : null;
  const runs = f.runs.filter((r) => known === null || known.has(recordAgent(r)))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const agentOf = (r: ScheduleRunRow) => f.agents?.find((a) => a.name === recordAgent(r));
  const named = (a: ScanAgent | undefined) => a?.displayName ?? "the agent";
  const byWhom = (r: ScheduleRunRow) => ((f.agents?.length ?? 0) > 1 ? ` By ${named(agentOf(r))}.` : "");

  // 1. Scanning now. One that has said nothing for too long stopped.
  const going = runs.find((r) => r.state === "running");
  if (going && now.getTime() - (going.startedAt ?? going.updatedAt).getTime() < DEADLINE_SCAN_STALE_MS) {
    return { state: "running", why: "Scanning mail for due notices now.", active: true, scanned: false };
  }

  // 2. Nobody to scan, or the morning brief (which carries the scan) is off for every agent.
  if (f.agents && f.agents.length === 0) {
    return { state: "skipped", why: "There is no chief-of-staff agent, so nothing scans mail for due notices.", active: false, scanned: false };
  }
  if (f.agents && !f.agents.some((a) => a.briefOn)) {
    const off = f.agents[0]!;
    return {
      state: "skipped",
      why: `The morning brief is switched off for ${listNames(f.agents.map((a) => a.displayName))}, and the mail scan for due notices runs inside it.`,
      fix: { href: `${agentPage(off)}/edit`, label: "Switch it on in Edit agent" },
      active: false, scanned: false,
    };
  }

  // 3. The last outcome.
  const last = runs[0];
  if (!last && f.agents === null) {
    return { state: "waiting", why: "Whether the mail scan has run could not be read just now.", active: false, scanned: false };
  }
  if (!last) {
    return { state: "waiting", why: "The mail scan has not run yet. It runs with the morning brief, at its hour.", active: false, scanned: false };
  }
  const when = runWhen(last.updatedAt, now, tz);
  const a = agentOf(last);
  if (last.state === "running") {
    return { state: "failed", when, why: `It stopped before it finished. The agent may have restarted; it tries again at the next morning brief.${byWhom(last)}`, active: false, scanned: false };
  }
  if (last.state === "finished") {
    const found = last.counts.found;
    const said = typeof found === "number"
      ? (found === 0 ? "No due notices in mail." : `Saw ${found} due ${found === 1 ? "notice" : "notices"} in mail.`)
      : "";
    return { state: "finished", when, why: `${said}${byWhom(last)}`.trim() || undefined, active: false, scanned: true };
  }
  if (last.state === "failed") {
    return { state: "failed", when, why: `${last.detail ? `The error was: ${last.detail}` : ""}${byWhom(last)}`.trim() || undefined, active: false, scanned: false };
  }
  switch (last.reason) {
    case DEADLINE_SCAN_SKIPS.noMailbox:
      return { state: "skipped", when, why: `No mailbox chosen for ${named(a)}, so there was no mail to scan.`, ...(a ? { fix: { href: agentPage(a), label: "Choose one on its Access tab" } } : {}), active: false, scanned: false };
    case DEADLINE_SCAN_SKIPS.mailboxUnusable:
      return { state: "skipped", when, why: `The mailbox chosen for ${named(a)} cannot be used right now.`, ...(a ? { fix: { href: agentPage(a), label: "Check it on its Access tab" } } : {}), active: false, scanned: false };
    default:
      return { state: "skipped", when, why: last.detail || undefined, active: false, scanned: false };
  }
}

/** What the empty candidate list says, so it never claims a scan that did not happen. */
export function emptyCandidatesText(scan: DeadlineScanView): string {
  return scan.scanned ? "No unresolved candidates." : "No candidates to show. The mail scan's status above says why.";
}

/** The chief-of-staff agents that are not retired, with their morning brief switch (silence means on). */
export async function scanAgents(db: Pick<PoolClient, "query"> = pool): Promise<ScanAgent[]> {
  const { rows } = await db.query<{ name: string; definition: { display?: unknown; schedules?: Record<string, { on?: unknown }> } | null }>(
    `SELECT name, definition FROM agent_definitions
      WHERE definition->>'role' = 'chief-of-staff' AND status <> 'retired' ORDER BY name`,
  );
  return rows.map((r) => ({
    name: r.name,
    displayName: typeof r.definition?.display === "string" && r.definition.display ? r.definition.display : r.name,
    briefOn: r.definition?.schedules?.[DEADLINE_SCAN_CARRIER]?.on !== false,
  }));
}

/** An agent name that cannot be a record key is left out of the read instead of failing it. */
function jobOf(a: ScanAgent): string | null {
  try { return deadlineScanJob(a.name); } catch { return null; }
}

/** The page's read. A source that cannot be read is left out rather than failing the page. */
export async function getDeadlineScanStatus(now: Date = new Date()): Promise<DeadlineScanView> {
  const agents = await scanAgents().catch(() => null);
  const jobs = (agents ?? []).map(jobOf).filter((j): j is string => j !== null);
  const runs = await readScheduleRuns(pool, jobs).catch(() => []);
  return deadlineScanStatus({ agents, runs }, now, homeTz());
}
