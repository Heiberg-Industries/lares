// Read layer for the email voice. Reads the same voice_profile / voice_exemplar tables the
// runtime uses. No secrets reach the DTO (learn_key is a NAME, not a value).
//
//  (sql/001_baseline.sql): one card per MAILBOX. `default` is the shared fallback card and carries the
// learn settings; every enrolled mailbox has its own row, proposal and learn status.
import { pool } from "./db";
import { readScheduleRun, type ScheduleRunRow } from "@lares/agent-kit/schedule-heartbeat";
import { VOICE_LEARN_JOB, VOICE_LEARN_SKIPS } from "@lares/agent-kit/voice-learn-outcome";
import type { RunState } from "@lares/ui/patterns";
import { formatInOwnerTz, homeTz, ownerDayIn } from "./proactivity";
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
//   - the job's last outcome (`schedule_run`, written by the voice-learn schedule through
//     `@lares/agent-kit/schedule-heartbeat`), with its reason codes from
//     `@lares/agent-kit/voice-learn-outcome`;
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
  run: ScheduleRunRow | null;
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

function whenText(at: Date, now: Date, tz: string): string {
  const [day, time] = formatInOwnerTz(at, tz).split(" ");
  return day === ownerDayIn(now, tz) ? `today at ${time}` : `on ${day} at ${time}`;
}

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

/** Pure: the one place the facts become words. */
export function relearnStatus(f: RelearnFacts, now: Date, tz: string): RelearnStatusView | null {
  const pending = f.requestedAt !== null;
  const run = f.run;
  const agentOf = (name?: string): VoiceLearnAgent | undefined => f.agents?.find((a) => a.name === name) ?? f.agents?.[0];
  const named = (a: VoiceLearnAgent | undefined) => a?.displayName ?? "the agent";
  /** The same name at the start of a sentence. */
  const Named = (a: VoiceLearnAgent | undefined) => a?.displayName ?? "The agent";

  // 1. Running now. A request that came in during a run is answered by that run.
  const covering = run?.state === "skipped" && run.reason === VOICE_LEARN_SKIPS.alreadyRunning;
  if (run && (run.state === "running" || covering)) {
    const since = run.startedAt ?? run.updatedAt;
    if (now.getTime() - since.getTime() < RELEARN_STALE_MS) {
      return { state: "running", why: covering ? "Already learning. Your request is covered by the run that is going." : RUNNING_WHY, active: true };
    }
    return {
      state: "failed", when: whenText(run.updatedAt, now, tz),
      why: "It stopped before it finished. The agent may have restarted. Press Re-learn to try again.", active: pending,
    };
  }
  if (!run && f.mailboxes.some((m) => m.learnStatus === "running")) return { state: "running", why: RUNNING_WHY, active: true };

  // 2. Switched off right now, for every agent that learns: say so before anyone presses the button.
  if (f.agents && f.agents.length > 0 && f.agents.every((a) => !a.voiceLearnOn)) {
    const off = f.agents[0]!;
    return {
      state: "skipped",
      why: `Voice Learn is switched off for ${off.displayName}, so it does not learn from Sent mail.${pending ? " Your request runs once it is switched on." : ""}`,
      fix: { href: `${agentPage(off)}/edit`, label: "Switch it on in Edit agent" },
      active: pending,
    };
  }

  // 3. Asked for and not taken yet.
  if (pending) {
    if (run?.state === "skipped" && run.updatedAt.getTime() >= f.requestedAt!.getTime()) return { ...skipped(run), active: true };
    const a = agentOf(run?.agent);
    if (now.getTime() - f.requestedAt!.getTime() < RELEARN_NOT_PICKED_UP_MS) {
      return { state: "requested", why: `${Named(a)} starts it within a minute or two.`, active: true };
    }
    return {
      state: "waiting", why: `${Named(a)} has not picked this up yet. It may be stopped.`,
      ...(a ? { fix: { href: agentPage(a), label: "Open the agent" } } : {}), active: true,
    };
  }

  // 4. The last outcome.
  if (run?.state === "finished") return { state: "finished", when: whenText(run.updatedAt, now, tz), why: countsSentence(run.counts), active: false };
  if (run?.state === "failed") return { state: "failed", when: whenText(run.updatedAt, now, tz), why: run.detail ? `The error was: ${run.detail}` : undefined, active: false };
  if (run?.state === "skipped") return { ...skipped(run), active: false };

  // 5. No outcome record yet (an older engine): the mailbox rows are all there is.
  const failed = f.mailboxes.find((m) => m.learnStatus === "error");
  if (failed) return { state: "failed", why: failed.learnMessage ? `The error was: ${failed.learnMessage}` : undefined, active: false };
  return null;

  function skipped(r: ScheduleRunRow): Omit<RelearnStatusView, "active"> {
    const a = agentOf(r.agent);
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

/** The chief-of-staff agents and their Voice Learn switch, from their saved definitions. */
export async function voiceLearnAgents(): Promise<VoiceLearnAgent[]> {
  const { rows } = await pool.query<{ name: string; definition: { display?: unknown; schedules?: Record<string, { on?: unknown }> } | null }>(
    `SELECT name, definition FROM agent_definitions
      WHERE definition->>'role' = 'chief-of-staff' AND status = 'valid' ORDER BY name`,
  );
  return rows.map((r) => ({
    name: r.name,
    displayName: typeof r.definition?.display === "string" && r.definition.display ? r.definition.display : r.name,
    // Silence means on (`@lares/agent-kit/schedule-switch`).
    voiceLearnOn: r.definition?.schedules?.["voice-learn"]?.on !== false,
  }));
}

/** The page's read. Each source that cannot be read is left out rather than failing the page. */
export async function getRelearnStatus(cards: readonly VoiceCardDTO[], now: Date = new Date()): Promise<RelearnStatusView | null> {
  const [requestedAt, run, agents] = await Promise.all([
    pool.query<{ relearn_requested_at: Date | string | null }>(`SELECT relearn_requested_at FROM voice_profile WHERE id = 'default'`)
      .then(({ rows }) => (rows[0]?.relearn_requested_at ? new Date(rows[0].relearn_requested_at) : null))
      .catch(() => null),
    readScheduleRun(pool, VOICE_LEARN_JOB).catch(() => null),
    voiceLearnAgents().catch(() => null),
  ]);
  return relearnStatus({ requestedAt, run, agents, mailboxes: cards.filter((c) => c.id !== "default") }, now, homeTz());
}
