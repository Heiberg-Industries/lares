/**
 * Dream-cycle orchestrator.
 *
 * makeDreamCycle({ reflector, promoter, brain, clock? }) returns:
 *
 *   runOnce()      — one full cycle: read logs since cursor → reflect →
 *                    promote → write dated reflection note → return result.
 *
 * The weekly learning summary used to live here as a one-shot LLM prompt. It is now a
 * scheduled brain-turn in bin/saga.ts (her persona, her hands, the door thread), so the
 * cycle no longer reasons about preferences: it needs neither an llm nor the preference
 * store of its own (the promoter owns the store writes).
 *
 * Cursor logic:
 *   - The prior cursor lives in _meta/dream/<YYYY-MM-DD>.md frontmatter as
 *     `cursor: <ISO>`.
 *   - The latest dream note (by date filename) is read to get `since`.
 *   - If no dream notes exist, `since = "1970-01-01T00:00:00.000Z"`.
 *   - After every run, cursor is advanced to `now.toISOString()` so logs
 *     are never reprocessed.
 */

import { ORIGIN_FRONTMATTER_KEY } from "@lares/agent-kit/origin";
import { readConversationEntries } from "./log-reader.js";
import { scrubObservations } from "./redact.js";
import type { LogReaderBrain, EntryReader } from "./log-reader.js";
import type { TurnLogEntry } from "../turn-capture.js";
import type { Observation } from "./reflect.js";
import type { PromoterResult, Rejection, RejectionReason } from "./promote.js";

// ─── Structural deps ──────────────────────────────────────────────────────────

export interface DreamCycleBrain extends LogReaderBrain {
  commitNote(opts: {
    path: string;
    frontmatter: Record<string, unknown>;
    body: string;
    /** Passed straight through to `@lares/agent-kit/vault-git`'s `commitNote`, which already
     *  accepts it. Without one it falls back to the kit's own role-neutral default — never a
     *  persona name here. */
    message?: string;
  }): Promise<{ commit: string }>;
}

export interface DreamCycleReflector {
  reflect(entries: TurnLogEntry[], opts: { since: string }): Promise<Observation[]>;
}

export interface DreamCyclePromoter {
  run(observations: Observation[], opts?: { source?: string }): Promise<PromoterResult>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const EPOCH = "1970-01-01T00:00:00.000Z";

// ─── Cursor resolution ────────────────────────────────────────────────────────

const DREAM_NOTE_RE = /^_meta\/dream\/(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * The prior dream note's frontmatter has TWO things this cycle needs before it does anything
 * else: the cursor, and the running all-rejected streak (added alongside it rather than as a
 * second file read — the note already IS the durable, restart-surviving state this needs).
 */
interface PriorDreamState {
  cursor: string;
  /** `all_rejected_streak` off the latest prior note, or 0 — no new table, no new file; this
   *  is the same read `cursor` already comes from. See `runOnce`'s header comment for how a
   *  run updates it. */
  priorStreak: number;
}

/**
 * Find the latest prior dream note and read its `cursor` and `all_rejected_streak` frontmatter
 * values. Returns EPOCH / 0 if no dream notes exist.
 *
 * EPOCH is also the silent-failure value for the cursor: an unreadable note, missing
 * frontmatter, or a missing `cursor:` line all fall back to it too, and a cursor that degrades
 * to EPOCH means the next cycle rereads the ENTIRE conversation-log corpus into one uncapped
 * reflection prompt. "No dream notes exist yet" is the one EPOCH path that is not a problem —
 * every other path here is a degradation, and each logs a loud console.warn so the failure is
 * observable in production rather than silently producing a giant reflection call.
 *
 * The streak degrades independently and more quietly: a note with no `all_rejected_streak:`
 * line at all is the ordinary case for every note written before this change, and reads as 0
 * with no warning. Only a line that IS present but unparseable (corruption, a hand edit) warns
 * — once, fails soft to 0, and never stops the cycle.
 */
async function resolvePriorState(brain: DreamCycleBrain): Promise<PriorDreamState> {
  const allPaths = await brain.list();
  const dreamPaths = allPaths.filter((p) => DREAM_NOTE_RE.test(p));

  // Legitimately the first-ever run — nothing to warn about.
  if (dreamPaths.length === 0) return { cursor: EPOCH, priorStreak: 0 };

  // Sort by filename date (YYYY-MM-DD) descending → last element = latest
  dreamPaths.sort((a, b) => {
    const dateA = (DREAM_NOTE_RE.exec(a) ?? [])[1] ?? "";
    const dateB = (DREAM_NOTE_RE.exec(b) ?? [])[1] ?? "";
    return dateA.localeCompare(dateB);
  });

  const latestPath = dreamPaths[dreamPaths.length - 1];

  const degraded = (reason: string): string => {
    console.warn(
      `dream: cursor fell back to EPOCH (${reason}) reading ${latestPath} — the next cycle ` +
        `will reflect on the FULL conversation-log corpus instead of the window since the ` +
        `last run.`,
    );
    return EPOCH;
  };

  let content: string;
  try {
    content = await brain.read(latestPath);
  } catch (err) {
    return { cursor: degraded(`unreadable note: ${err}`), priorStreak: 0 };
  }

  // Parse `cursor:` from frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
  if (!fmMatch) return { cursor: degraded("no frontmatter block"), priorStreak: 0 };

  const cursorMatch = fmMatch[1].match(/^cursor:\s*(.+)$/m);
  const cursor = !cursorMatch
    ? degraded("no cursor: line in frontmatter")
    : cursorMatch[1].trim() || degraded("empty cursor: value");

  return { cursor, priorStreak: resolvePriorStreak(fmMatch[1]) };
}

/** Reads `all_rejected_streak:` off an already-fetched frontmatter block — no second file
 *  read. Missing key: 0, silently (every note written before this change). Present but
 *  unparseable: 0, with one warning, and never a thrown error out of this function. */
function resolvePriorStreak(frontmatterBlock: string): number {
  try {
    const m = frontmatterBlock.match(/^all_rejected_streak:\s*(.+)$/m);
    if (!m) return 0;
    const raw = m[1].trim();
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      console.warn(
        `dream: could not read the prior all-rejected streak (${JSON.stringify(raw)}) — treating it as 0.`,
      );
      return 0;
    }
    return n;
  } catch (err) {
    console.warn(
      `dream: failed to read the prior all-rejected streak (${err instanceof Error ? err.message : String(err)}) — treating it as 0.`,
    );
    return 0;
  }
}

// ─── Note body builder ────────────────────────────────────────────────────────

/**
 * One short, role-neutral line per `RejectionReason` — a `Record` so the compiler refuses a
 * build that adds a reason here without wording (ADR-0018 rule 6: "the run tells you plainly
 * when it rejected something and why"). Deliberately NOT the gate's own `say` sentence
 * (`@lares/agent-kit/learning`'s `SAY`, private to that module): this text is grouped behind a
 * COUNT, so it has to read as "N — <reason>", and it is owned here rather than trusted from
 * whatever a caller happened to attach to a `Rejection`, so the report reads the same words no
 * matter who built the result.
 */
const NOT_LEARNED_REASON_TEXT: Record<RejectionReason, string> = {
  "not-owner-origin": "came from somebody else's words, not the owner's",
  "agent-inference": "the agent's own guess, already offered above for the owner to confirm",
  "below-recurrence": "the owner has said once so far",
  "already-held": "already standing — nothing to add",
  "supersede-awaits-owner": "would replace what the owner told me, so it is waiting for their approval",
  "do-not-learn": "a kind of thing that is never learned (a failure, a one-off, a claim about a tool)",
};

/** Fixed, deterministic order the "Not learned" section lists reasons in — the order
 *  `RejectionReason` is declared in `@lares/agent-kit/learning`. */
const NOT_LEARNED_REASON_ORDER: RejectionReason[] = [
  "not-owner-origin",
  "agent-inference",
  "below-recurrence",
  "already-held",
  "supersede-awaits-owner",
  "do-not-learn",
];

/** One "N — reason" line per reason actually present, grouped and counted. Never touches
 *  `rejection.observation.text` — that is, by definition, sometimes third-party content, and
 *  this note is committed to git (ADR-0018 rule 6's "the note names what it rejected and why",
 *  never what it rejected). */
function notLearnedLines(rejected: readonly Rejection[]): string[] {
  const counts = new Map<RejectionReason, number>();
  for (const r of rejected) {
    counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  }
  const lines: string[] = [];
  for (const reason of NOT_LEARNED_REASON_ORDER) {
    const n = counts.get(reason);
    if (n) lines.push(`- ${n} — ${NOT_LEARNED_REASON_TEXT[reason]}`);
  }
  return lines;
}

/** True when a run had nothing at all to report — no promotions, no supersedes, nothing held,
 *  nothing to confirm and nothing rejected. Distinct from `everythingRejected`: a quiet night
 *  and a night that rejected every candidate must never look the same (ADR-0018 rule 6). Used
 *  both by the note's own empty-state line and by the all-rejected streak, which this same
 *  condition must neither increment nor reset. */
function nothingObserved(result: PromoterResult): boolean {
  return (
    result.promoted.length === 0 &&
    result.superseded.length === 0 &&
    result.held.length === 0 &&
    result.needsConfirm.length === 0 &&
    result.rejected.length === 0
  );
}

function buildNoteBody(result: PromoterResult, scrubbed = 0): string {
  const lines: string[] = ["## Dream cycle run", ""];

  if (scrubbed > 0) {
    lines.push(
      `> **Privacy guard:** ${scrubbed} observation${scrubbed === 1 ? "" : "s"} dropped by the PII scrub filter (count only — no content retained).`,
    );
    lines.push("");
  }

  if (result.promoted.length > 0) {
    lines.push("### Promoted");
    for (const p of result.promoted) {
      lines.push(`- ${p.text}`);
    }
    lines.push("");
  }

  if (result.superseded.length > 0) {
    lines.push(`### Superseded`);
    lines.push(`${result.superseded.length} preference(s) replaced by newer observations.`);
    lines.push("");
  }

  if (result.held.length > 0) {
    lines.push("### Held (not yet promoted)");
    for (const h of result.held) {
      lines.push(`- ${h.text}`);
    }
    lines.push("");
  }

  if (result.needsConfirm.length > 0) {
    lines.push("### Needs confirmation");
    for (const n of result.needsConfirm) {
      lines.push(`- ${n.text}`);
    }
    lines.push("");
  }

  if (result.rejected.length > 0) {
    // A run that rejects every candidate must look different from a run with nothing to look
    // at (OpenClaw's own failure, ADR-0018 rule 6, `#121232`): the two used to render the same
    // "_No new observations..._" line. A failure IN this section must never cost the note
    // itself — the promoted/superseded/held/needsConfirm sections above are already built, and
    // the commit below must still happen.
    try {
      lines.push("### Not learned");
      lines.push(
        "_The wording of a rejected observation is not repeated here — it may be someone " +
          "else's words, and this note is committed to the vault. The reason and the count are " +
          "the whole record._",
      );
      lines.push("");
      for (const line of notLearnedLines(result.rejected)) lines.push(line);
      lines.push("");
    } catch (err) {
      console.error(
        `dream: failed to render the rejection summary (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  if (nothingObserved(result)) {
    lines.push("_No new observations in this cycle._");
  }

  // The honest sentence ADR-0018 rule 6 asks for: a reader looking at `git show` on this
  // commit sees the note and the frontmatter's `added`/`superseded` ids, never the rows
  // themselves — those live in the database, and reverting the commit does not touch them.
  // Written EVERY run, not only when something was promoted: a quiet run's commit is just as
  // reviewable a claim as a busy one's.
  lines.push(
    "",
    "This note is the whole of what this run wrote to the vault, and reverting this commit " +
      "removes this note — but **not the rows it names**. Those live in the database; `added` " +
      "and `superseded` above are their ids, and a row is undone by retiring it from the Memory " +
      "page or by rejecting the proposal that would have changed it. A dream is one reviewable " +
      "commit plus the rows it lists; git cannot hold the rows themselves, and pretending " +
      "otherwise would be the more dangerous claim.",
  );

  return lines.join("\n");
}

/**
 * Rejections the gate only reaches AFTER a candidate passed the owner-origin check
 * (`@lares/agent-kit/learning` checks do-not-learn, then origin, and only then these). A run
 * that produced one is proof the gate lets the owner's words through: the fact was already
 * standing, or a change to it now waits for the owner. Neither is the failure the alarm is for.
 */
const PASSED_THE_ORIGIN_CHECK: ReadonlySet<string> = new Set([
  "already-held",
  "supersede-awaits-owner",
]);

/**
 * A run in which candidates existed and NONE of them survived the gate. Not "nothing
 * happened" — a gate that rejects everything looks identical to a gate that is working, and
 * OpenClaw shipped exactly that for weeks (research report 10, issue #121232).
 */
export function everythingRejected(result: PromoterResult): boolean {
  return (
    result.rejected.length > 0 &&
    !result.rejected.some((r) => PASSED_THE_ORIGIN_CHECK.has(r?.reason)) &&
    result.promoted.length === 0 &&
    result.superseded.length === 0 &&
    result.held.length === 0 &&
    result.needsConfirm.length === 0
  );
}

/** The signal a run raises when `everythingRejected` is true. Exported so the test names the
 *  same string the schedule emits. */
export const DREAM_ALL_REJECTED_EVENT = "dream-all-rejected";

/**
 * A single all-rejected night is not yet a problem — a perfectly healthy installation can
 * reject everything on a quiet night (a one-off owner remark is `below-recurrence`; the
 * agent's own inference is `agent-inference`, and both already keep `everythingRejected` false
 * by way of `held`/`needsConfirm`). What is a problem is the SAME failure holding for several
 * nights running — that is `#121232` again, just spread across nights instead of one giant
 * batch. The alarm fires on the third consecutive night, and then again every 7 nights beyond
 * that (10, 17, …) rather than nightly, so a real installation does not get a message it learns
 * to ignore before it matters (`shouldRaiseAllRejectedSignal`).
 */
export const DREAM_ALL_REJECTED_SIGNAL_AT = 3;

/**
 * Whether a streak of this length should raise `DREAM_ALL_REJECTED_EVENT`: never below
 * `DREAM_ALL_REJECTED_SIGNAL_AT`, exactly at it, and then every 7 beyond it (3, 10, 17, …).
 * Pure arithmetic on the streak NUMBER alone — the caller (`agent/schedules/dream.ts`) is what
 * gates this on the run itself actually being an all-rejected one, so a quiet night that merely
 * carries a threshold streak forward unchanged never re-raises it.
 */
export function shouldRaiseAllRejectedSignal(streak: number): boolean {
  return streak >= DREAM_ALL_REJECTED_SIGNAL_AT && (streak - DREAM_ALL_REJECTED_SIGNAL_AT) % 7 === 0;
}

/**
 * The signal's detail line: the same per-reason counts the note renders, plus how long the
 * streak has run, plus — only when EVERY rejection this run is `not-owner-origin` — one plain
 * sentence pointing at the most likely cause. A mixed run (some `not-owner-origin`, some of any
 * other reason) never gets that sentence: a real mix of reasons is what a working, strict gate
 * looks like, and the sentence would be a false lead.
 */
export function buildAllRejectedSignalDetail(rejected: readonly Rejection[], streak: number): string {
  const counts = new Map<RejectionReason, number>();
  for (const r of rejected) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  const countsText = Array.from(counts.entries())
    .map(([reason, n]) => `${reason}: ${n}`)
    .join(", ");
  const streakText = `${streak} run${streak === 1 ? "" : "s"} in a row`;
  const allNotOwnerOrigin = rejected.length > 0 && rejected.every((r) => r.reason === "not-owner-origin");
  const checkSentence = allNotOwnerOrigin
    ? " Check first whether conversation entries are being recorded with an owner origin — if " +
      "every rejection is not-owner-origin, the origin stamping or the conversation record is " +
      "the suspect, not the owner's habits."
    : "";
  return `${countsText} (${streakText}).${checkSentence}`;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function makeDreamCycle(deps: {
  reflector: DreamCycleReflector;
  promoter: DreamCyclePromoter;
  brain: DreamCycleBrain;
  /** `conversation_entries` (ADR-0020) — the dream cycle's primary source since W3B-s3.
   *  `readConversationEntries` falls back to `brain`'s markdown for the one gap the table
   *  cannot itself answer for; see that function's doc comment in `log-reader.ts`. */
  entries: EntryReader;
  /** Which agent's rows to read — must match the value `lib/turn-capture.ts` wrote them
   *  under (`LARES_AGENT_NAME`, falling back to `"unknown"` the same way that write path
   *  does, so a reader can never end up asking for a name the writer never used). */
  agent: string;
  /** The running agent's own label, for matching a legacy markdown reply line — resolved by
   *  the caller from the agent's own definition (`lib/definition.ts`'s `thisAgent()`), never a
   *  literal name here (W3B-s7). Passed straight through to `readConversationEntries`. */
  agentLabel: string;
  clock?: () => Date;
}) {
  const { reflector, promoter, brain, entries, agent, agentLabel } = deps;
  const clock = deps.clock ?? (() => new Date());

  return {
    async runOnce(): Promise<{
      since: string;
      notePath: string;
      result: PromoterResult;
      /** The all-rejected streak AFTER this run, including this run — what the note's
       *  frontmatter carries forward and what the schedule checks against
       *  `shouldRaiseAllRejectedSignal`. */
      allRejectedStreak: number;
    }> {
      // 1. Resolve cursor and the prior all-rejected streak from the same prior-note read.
      const { cursor: since, priorStreak } = await resolvePriorState(brain);

      // 2. Read conversation entries since cursor — the table, with a markdown fallback for
      //    the one installation-lifetime gap it cannot itself answer for.
      const conversationEntries = await readConversationEntries(entries, brain, { agent, since, agentLabel });

      // 3. Reflect
      const observations = await reflector.reflect(conversationEntries, { since });

      // 3b. GDPR PII scrub — deterministic backstop before any observations
      //     reach the store or Brain. Dropping a learning is acceptable;
      //     leaking third-party contact data is not.
      const { kept, dropped } = scrubObservations(observations);

      // 4. Promote (promoter records each observation internally)
      const now = clock();
      const nowIso = now.toISOString();
      const date = nowIso.slice(0, 10);
      const result = await promoter.run(kept, { source: `dream-cycle-${date}` });

      // 5. The all-rejected streak: a quiet run (nothing observed at all) carries the prior
      //    value forward unchanged; an all-rejected run adds one to it; any other run (anything
      //    promoted, superseded, held or shown for confirmation) resets it to 0. This is the
      //    state a multi-night alarm needs and the ONLY place it is kept — the vault note, not a
      //    new table, so it survives a restart the same way the cursor already does.
      const isAllRejected = everythingRejected(result);
      const allRejectedStreak = nothingObserved(result)
        ? priorStreak
        : isAllRejected
          ? priorStreak + 1
          : 0;

      // 6. Write dated reflection note
      const notePath = `_meta/dream/${date}.md`;

      const body = buildNoteBody(result, dropped.length);

      // The ids the commit records (ADR-0018 rule 6 again, from the other end: not just what
      // was rejected and why, but exactly which rows a promotion or a supersede touched).
      // `proposed` names the SUPERSEDES this run filed for the owner (W5X-s6) — a
      // `supersede-awaits-owner` rejection already appears, by reason and count, in the "Not
      // learned" section above; this is the id behind it. An `add` confirmation is filed by the
      // SCHEDULE, after this note is already committed (`agent/schedules/dream.ts`'s
      // `fileConfirmations`, called after `cycle.runOnce()` returns), so its id cannot appear
      // here — the schedule logs `filed` separately instead.
      const added = result.promoted.map((p) => p.id);
      const superseded = result.superseded.map((s) => `${s.oldId} -> ${s.byId}`);
      const proposed = (result.proposed ?? []).map((p) => p.id);
      const message =
        `learning: ${date} (${result.promoted.length} added, ${result.superseded.length} ` +
        `superseded, ${result.rejected.length} not learned)`;

      await brain.commitNote({
        path: notePath,
        message,
        frontmatter: {
          at: nowIso,
          cursor: nowIso,
          // A dated reflection note is a scheduled job's own generated output with no human
          // in the turn — the origin spec's class 5 (docs/specs/2026-09-18-origin-model-
          // design.md:74-77). Keyed via ORIGIN_FRONTMATTER_KEY so the frontmatter key string
          // is never written twice.
          [ORIGIN_FRONTMATTER_KEY]: "system",
          promoted: result.promoted.length,
          added,
          superseded,
          proposed,
          held: result.held.length,
          needsConfirm: result.needsConfirm.length,
          rejected: result.rejected.length,
          all_rejected: isAllRejected,
          all_rejected_streak: allRejectedStreak,
          scrubbed: dropped.length,
        },
        body,
      });

      return { since, notePath, result, allRejectedStreak };
    },
  };
}
