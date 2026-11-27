// Read layer for the email voice. Reads the same voice_profile / voice_exemplar tables the
// runtime uses. No secrets reach the DTO (learn_key is a NAME, not a value).
//
//  (sql/001_baseline.sql): one card per MAILBOX. `default` is the shared fallback card and carries the
// learn settings; every enrolled mailbox has its own row, proposal and learn status.
import type { PoolClient } from "pg";
import { pool } from "./db";
import { readScheduleRuns, type ScheduleRunRow } from "@lares/agent-kit/schedule-heartbeat";
import { VOICE_LEARN_SKIPS, voiceLearnJob } from "@lares/agent-kit/voice-learn-outcome";
import type { RunState } from "@lares/ui/patterns";
import { homeTz } from "./proactivity";
import { runWhen as whenText } from "./run-when";
import type { VoiceCardDTO, VoiceExampleDTO, VoiceProposed } from "./contracts";

export interface VoiceCardRow {
  id: string;
  core: string; notes_en: string; notes_no: string;
  model_en: string | null; model_no: string | null;
  learn_key: string; learn_lookback_days: number; learn_cap: number;
  learn_status: string; learn_message: string;
  proposed: VoiceProposed | null;
}

const EMPTY_DEFAULT: VoiceCardRow = {
  id: "default", core: "", notes_en: "", notes_no: "", model_en: null, model_no: null,
  learn_key: "chief-of-staff", learn_lookback_days: 365, learn_cap: 300, learn_status: "idle", learn_message: "", proposed: null,
};

function toDTO(r: VoiceCardRow): VoiceCardDTO {
  return {
    id: r.id,
    core: r.core ?? "", notesEn: r.notes_en ?? "", notesNo: r.notes_no ?? "",
    modelEn: r.model_en ?? "", modelNo: r.model_no ?? "",
    learnKey: r.learn_key ?? "chief-of-staff", lookbackDays: r.learn_lookback_days ?? 365, cap: r.learn_cap ?? 300,
    learnStatus: r.learn_status ?? "idle", learnMessage: r.learn_message ?? "",
    proposed: r.proposed ?? null,
  };
}

/** Pure: `default` first (synthesised empty when the table has none, so the page always has a
 *  shared card to edit), then every mailbox alphabetically. The only place ordering is decided. */
export function orderVoiceCards(rows: readonly VoiceCardRow[]): VoiceCardDTO[] {
  const def = rows.find((r) => r.id === "default") ?? EMPTY_DEFAULT;
  const mailboxes = rows.filter((r) => r.id !== "default").sort((a, b) => a.id.localeCompare(b.id));
  return [def, ...mailboxes].map(toDTO);
}

export async function getVoiceCards(): Promise<VoiceCardDTO[]> {
  const { rows } = await pool
    .query<VoiceCardRow>(
      `SELECT id, core, notes_en, notes_no, model_en, model_no, learn_key, learn_lookback_days, learn_cap,
              learn_status, learn_message, proposed FROM voice_profile`,
    )
    .catch(() => ({ rows: [] as VoiceCardRow[] }));
  return orderVoiceCards(rows);
}

export async function listVoiceExamples(limit = 200): Promise<VoiceExampleDTO[]> {
  const { rows } = await pool
    .query<{ id: string; lang: "en" | "no"; text: string; included: boolean }>(
      `SELECT id, lang, text, included FROM voice_exemplar ORDER BY created_at DESC LIMIT $1`,
      [limit],
    )
    .catch(() => ({ rows: [] }));
  return rows.map((r) => ({ id: r.id, lang: r.lang, included: r.included, snippet: r.text.replace(/\s+/g, " ").slice(0, 140) }));
}

// ---------------------------------------------------------------------------------------------
// Where learning from Sent mail is: asked for, running, finished, failed or skipped, and why.
//
// Three sources, read together because no one of them is enough:
//   - `voice_profile.relearn_requested_at` on `default`: the owner pressed Re-learn and the
//     schedule has not taken it yet (it is cleared once the run is recorded as started);
//   - each chief-of-staff agent's last outcome (`schedule_run`, one row per agent under
//     `<agent name>/voice-learn`, written by the voice-learn schedule through
//     `@lares/agent-kit/schedule-heartbeat`), with its reason codes from
//     `@lares/agent-kit/voice-learn-outcome`. Combined here: a run that is going wins, otherwise
//     the newest outcome, named by the display name of the agent it belongs to;
//   - each MAILBOX's own row (`learn_status`, `learn_message`): the schedule writes the per-mailbox
//     status there, never on `default`. Used when there is no outcome record yet (an older engine).
// And the chief-of-staff agents' definitions, for the agent's display name and whether its Voice
// Learn switch is on, so the page can say "switched off" before anyone presses the button.
// ---------------------------------------------------------------------------------------------

/** What the Writing style page shows about learning, ready for `RunStatus`. `active`: keep the page up to date. */
export interface RelearnStatusView {
  state: RunState;
  when?: string;
  why?: string;
  fix?: { href: string; label: string };
  active: boolean;
}

/** An agent that runs voice learning: its definition name, the name people see, and its switch. */
export interface VoiceLearnAgent { name: string; displayName: string; voiceLearnOn: boolean }

export interface RelearnFacts {
  requestedAt: Date | null;
  /** Each chief-of-staff agent's last outcome, at most one per agent (`<agent name>/voice-learn`). */
  runs: readonly ScheduleRunRow[];
  /** null when the definitions could not be read: then nothing is said about switches. */
  agents: VoiceLearnAgent[] | null;
  /** The mailbox cards (not `default`). */
  mailboxes: readonly Pick<VoiceCardDTO, "learnStatus" | "learnMessage">[];
}

/** A run that has said nothing for this long did not finish (the learn's own deadline is 45 minutes). */
export const RELEARN_STALE_MS = 2 * 60 * 60_000;
/** A request nobody has taken after this long is shown as not picked up. The schedule looks every minute. */
export const RELEARN_NOT_PICKED_UP_MS = 3 * 60_000;

const RUNNING_WHY = "Reading Sent mail and learning how you write. This can take several minutes.";

const agentPage = (a: VoiceLearnAgent) => `/agents/${encodeURIComponent(a.name)}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function countsSentence(counts: Record<string, number>): string | undefined {
  const parts: string[] = [];
  if (typeof counts.kept === "number") parts.push(`Kept ${plural(counts.kept, "email", "emails")} as examples`);
  if (typeof counts.dropped === "number") parts.push(`left out ${counts.dropped}`);
  let text = parts.length ? `${parts.join(", ")}.` : "";
  if (counts.failed) text += ` ${plural(counts.failed, "mailbox", "mailboxes")} failed.`;
  return text.trim() || undefined;
}

/** The agent a record belongs to: the first half of its key (`<agent name>/voice-learn`). */
const recordAgent = (r: ScheduleRunRow): string => r.job.slice(0, r.job.indexOf("/"));

/** Running, or a request already covered by a run (`already-running`): a run is going, unless silent too long. */
function isGoing(r: ScheduleRunRow): boolean {
  return r.state === "running" || (r.state === "skipped" && r.reason === VOICE_LEARN_SKIPS.alreadyRunning);
}

/** One outcome out of every agent's: a run that is going (and not silent for hours) wins, the most
 *  recently written of them; otherwise the newest outcome of all. */
export function combineRuns(runs: readonly ScheduleRunRow[], now: Date): ScheduleRunRow | null {
  const newestFirst = [...runs].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const fresh = (r: ScheduleRunRow) => now.getTime() - (r.startedAt ?? r.updatedAt).getTime() < RELEARN_STALE_MS;
  return newestFirst.find((r) => isGoing(r) && fresh(r)) ?? newestFirst[0] ?? null;
}

/** "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Pure: the one place the facts become words. */
export function relearnStatus(f: RelearnFacts, now: Date, tz: string): RelearnStatusView | null {
  const pending = f.requestedAt !== null;
  const run = combineRuns(f.runs, now);
  const agentOf = (name?: string): VoiceLearnAgent | undefined => f.agents?.find((a) => a.name === name) ?? f.agents?.[0];
  const named = (a: VoiceLearnAgent | undefined) => a?.displayName ?? "the agent";
  /** The same name at the start of a sentence. */
  const Named = (a: VoiceLearnAgent | undefined) => a?.displayName ?? "The agent";
  /** With more than one agent that learns, a finished or failed run says whose it was. */
  const byWhom = (r: ScheduleRunRow) => ((f.agents?.length ?? 0) > 1 ? `Last run by ${named(agentOf(recordAgent(r)))}. ` : "");
  const anyOn = f.agents?.some((a) => a.voiceLearnOn) ?? false;

  // 1. Running now. A request that came in during a run is answered by that run.
  const covering = run?.state === "skipped" && run.reason === VOICE_LEARN_SKIPS.alreadyRunning;
  if (run && (run.state === "running" || covering)) {
    const since = run.startedAt ?? run.updatedAt;
    if (now.getTime() - since.getTime() < RELEARN_STALE_MS) {
      return { state: "running", why: covering ? "Already learning. Your request is covered by the run that is going." : RUNNING_WHY, active: true };
    }
    return {
      state: "failed", when: whenText(run.updatedAt, now, tz),
      why: `${byWhom(run)}It stopped before it finished. The agent may have restarted. Press Re-learn to try again.`, active: pending,
    };
  }
  if (!run && f.mailboxes.some((m) => m.learnStatus === "running")) return { state: "running", why: RUNNING_WHY, active: true };

  // 2. Switched off right now, for every agent that learns: say so before anyone presses the button.
  if (f.agents && f.agents.length > 0 && !anyOn) {
    const off = f.agents[0]!;
    return {
      state: "skipped",
      why: `Voice Learn is switched off for ${listNames(f.agents.map((a) => a.displayName))}, so it does not learn from Sent mail.${pending ? " Your request runs once it is switched on." : ""}`,
      fix: { href: `${agentPage(off)}/edit`, label: "Switch it on in Edit agent" },
      active: pending,
    };
  }

  // 3. Asked for and not taken yet.
  if (pending) {
    // A skip written for this request says why it has not run — except a "switched off" while some
    // agent has Voice Learn on now: that agent picks the request up within a minute.
    const answers = run?.state === "skipped" && run.updatedAt.getTime() >= f.requestedAt!.getTime()
      && !(run.reason === VOICE_LEARN_SKIPS.switchedOff && anyOn);
    if (answers) return { ...skipped(run!), active: true };
    // Named: the agent that will pick it up (the first with Voice Learn on).
    const a = f.agents?.find((x) => x.voiceLearnOn) ?? agentOf(run ? recordAgent(run) : undefined);
    if (now.getTime() - f.requestedAt!.getTime() < RELEARN_NOT_PICKED_UP_MS) {
      return { state: "requested", why: `${Named(a)} starts it within a minute or two.`, active: true };
    }
    return {
      state: "waiting", why: `${Named(a)} has not picked this up yet. It may be stopped.`,
      ...(a ? { fix: { href: agentPage(a), label: "Open the agent" } } : {}), active: true,
    };
  }

  // 4. The last outcome.
  if (run?.state === "finished") {
    const why = `${byWhom(run)}${countsSentence(run.counts) ?? ""}`.trim();
    return { state: "finished", when: whenText(run.updatedAt, now, tz), why: why || undefined, active: false };
  }
  if (run?.state === "failed") {
    const why = `${byWhom(run)}${run.detail ? `The error was: ${run.detail}` : ""}`.trim();
    return { state: "failed", when: whenText(run.updatedAt, now, tz), why: why || undefined, active: false };
  }
  if (run?.state === "skipped") return { ...skipped(run), active: false };

  // 5. No outcome record yet (an older engine): the mailbox rows are all there is.
  const failed = f.mailboxes.find((m) => m.learnStatus === "error");
  if (failed) return { state: "failed", why: failed.learnMessage ? `The error was: ${failed.learnMessage}` : undefined, active: false };
  return null;

  function skipped(r: ScheduleRunRow): Omit<RelearnStatusView, "active"> {
    const a = agentOf(recordAgent(r));
    const when = whenText(r.updatedAt, now, tz);
    switch (r.reason) {
      case VOICE_LEARN_SKIPS.switchedOff:
        return a?.voiceLearnOn
          ? { state: "skipped", when, why: `Voice Learn was switched off for ${named(a)}. It is on now: press Re-learn to run it.` }
          : { state: "skipped", when, why: `Voice Learn is switched off for ${named(a)}.`, ...(a ? { fix: { href: `${agentPage(a)}/edit`, label: "Switch it on in Edit agent" } } : {}) };
      case VOICE_LEARN_SKIPS.schedulesOff:
        return { state: "skipped", when, why: "Schedules are switched off on this server, so nothing runs on its own." };
      case VOICE_LEARN_SKIPS.noMailbox:
        return { state: "skipped", when, why: `No mailbox chosen for ${named(a)}.`, ...(a ? { fix: { href: agentPage(a), label: "Choose one on its Access tab" } } : {}) };
      case VOICE_LEARN_SKIPS.mailboxUnusable:
        return { state: "skipped", when, why: `The mailbox chosen for ${named(a)} cannot be used right now.`, ...(a ? { fix: { href: agentPage(a), label: "Check it on its Access tab" } } : {}) };
      case VOICE_LEARN_SKIPS.noCompareModel:
        return { state: "skipped", when, why: "No model for comparing texts is set up, so emails cannot be sorted for learning." };
      default:
        return { state: "skipped", when, why: r.detail || undefined };
    }
  }
}

/** The chief-of-staff agents and their Voice Learn switch, from their saved definitions: every one
 *  that is not retired. An agent whose saved definition is invalid still runs on its last valid one
 *  (ADR-0015), so it counts; a retired one does not run. The voice-learn schedule's claim reads the
 *  same set of agents' records (`claimAndRecordStart`), so the page and the schedule agree on which
 *  runs are going. */
export async function voiceLearnAgents(db: Pick<PoolClient, "query"> = pool): Promise<VoiceLearnAgent[]> {
  const { rows } = await db.query<{ name: string; definition: { display?: unknown; schedules?: Record<string, { on?: unknown }> } | null }>(
    `SELECT name, definition FROM agent_definitions
      WHERE definition->>'role' = 'chief-of-staff' AND status <> 'retired' ORDER BY name`,
  );
  return rows.map((r) => ({
    name: r.name,
    displayName: typeof r.definition?.display === "string" && r.definition.display ? r.definition.display : r.name,
    // Silence means on (`@lares/agent-kit/schedule-switch`).
    voiceLearnOn: r.definition?.schedules?.["voice-learn"]?.on !== false,
  }));
}

/** One step inside a read-only transaction: its result, or `fallback` when it cannot be read (an
 *  older database without the table), without spoiling the rest of the transaction. */
async function orElse<T>(db: PoolClient, step: () => Promise<T>, fallback: T): Promise<T> {
  await db.query("SAVEPOINT step");
  try {
    const result = await step();
    await db.query("RELEASE SAVEPOINT step");
    return result;
  } catch {
    await db.query("ROLLBACK TO SAVEPOINT step");
    return fallback;
  }
}

/** An agent name that cannot be a record key is left out of the read instead of failing it. */
function jobOf(a: VoiceLearnAgent): string | null {
  try { return voiceLearnJob(a.name); } catch { return null; }
}

/** The request, the agents and each agent's outcome from ONE snapshot. The schedule clears the
 *  request and records "running" in one transaction; separate reads could fall either side of it
 *  and see an old finished outcome with no request, and the page would stop keeping itself up to
 *  date. Only the records of the agents read here are looked at: a record under any other key (an
 *  agent that is gone, or the one shared record an earlier engine build kept) is ignored. */
async function readRelearnSnapshot(): Promise<Pick<RelearnFacts, "requestedAt" | "runs" | "agents">> {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const db = client;
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const requestedAt = await orElse(db, async () => {
      const { rows } = await db.query<{ relearn_requested_at: Date | string | null }>(
        `SELECT relearn_requested_at FROM voice_profile WHERE id = 'default'`,
      );
      return rows[0]?.relearn_requested_at ? new Date(rows[0].relearn_requested_at) : null;
    }, null);
    const agents = await orElse<VoiceLearnAgent[] | null>(db, () => voiceLearnAgents(db), null);
    const jobs = (agents ?? []).map(jobOf).filter((j): j is string => j !== null);
    const runs = await orElse(db, () => readScheduleRuns(db, jobs), []);
    await db.query("COMMIT");
    return { requestedAt, runs, agents };
  } catch {
    await client?.query("ROLLBACK").catch(() => {});
    return { requestedAt: null, runs: [], agents: null };
  } finally {
    client?.release();
  }
}

/** The page's read. Each source that cannot be read is left out rather than failing the page. */
export async function getRelearnStatus(cards: readonly VoiceCardDTO[], now: Date = new Date()): Promise<RelearnStatusView | null> {
  const facts = await readRelearnSnapshot();
  return relearnStatus({ ...facts, mailboxes: cards.filter((c) => c.id !== "default") }, now, homeTz());
}
