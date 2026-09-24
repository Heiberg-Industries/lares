/**
 * Conversation reader for the dream cycle.
 *
 * THIS MODULE NAMES NO PERSON AND NO PERSONA (W3B-s7). A legacy log's body has exactly one
 * bold label that is the running agent's own reply line; every other bold label is a speaker —
 * a person on a door turn, or a scheduled lane's name on a machine-authored one. Which label is
 * "the agent's" is not this module's business to know: every function below takes it as an
 * `agentLabel` parameter, supplied by the caller. The caller resolves it the same way the rest
 * of this service resolves "who am I" — `lib/definition.ts`'s `thisAgent()` — never a literal
 * name baked in here.
 *
 * parseConversationLog(markdown, agentLabel) → TurnLogEntry | null
 *   Parses a single conversation log file back into a TurnLogEntry.
 *   Returns null if the content is not a parseable log (no frontmatter `at`).
 *
 * readConversationLogs(brain, { since, agentLabel }) → Promise<TurnLogEntry[]>
 *   Reads all _meta/conversations/**\/*.md files from the brain,
 *   parses each, drops unparseable ones, keeps entries with `at` strictly
 *   greater than `since`, and returns them sorted by `at` ascending.
 *   STILL HERE, DELIBERATELY: `readConversationEntries` below falls back to this on the one
 *   installation-lifetime gap the table cannot answer for. Do not delete until that fallback
 *   is retired too.
 *
 * readConversationEntries(reader, brain, { agent, since, agentLabel }) → Promise<TurnLogEntry[]>
 *   ADR-0020's table (`conversation_entries`) is the primary source. See its own doc comment
 *   below for the NO GAP, NO DOUBLE READ rule this function implements — a rule this slice
 *   (W3B-s3) adds; the plan that named this function did not specify one (see that comment and
 *   this builder's report for why).
 */

import type { ConversationEntry } from "@lares/agent-kit/conversation-record";
import type { TurnLogEntry } from "../turn-capture.js";

// ─── Structural brain subset ──────────────────────────────────────────────────

export interface LogReaderBrain {
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
}

// ─── parseConversationLog ─────────────────────────────────────────────────────

/**
 * Parse one conversation log file's markdown content back into a TurnLogEntry.
 * `agentLabel` is the running agent's own label, resolved by the caller — see the module
 * header. Returns null if:
 *  - The content has no YAML frontmatter
 *  - The frontmatter contains no `at:` field
 */
export function parseConversationLog(markdown: string, agentLabel: string): TurnLogEntry | null {
  if (!markdown) return null;

  // Extract the frontmatter block between the first pair of ---
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/m);
  if (!fmMatch) return null;

  const fmBlock = fmMatch[1];
  const bodyBlock = fmMatch[2];

  // Parse frontmatter fields
  const at = extractFmField(fmBlock, "at");
  if (!at) return null;

  const door = extractFmField(fmBlock, "door") ?? "";
  const principal = extractFmField(fmBlock, "principal") ?? "";
  const lane = extractFmField(fmBlock, "lane") ?? "";
  const proposalsRaw = extractFmField(fmBlock, "proposals") ?? "";
  const proposals = proposalsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Parse body: find the speaker's block and the agent's reply block
  const { input, reply } = parseBody(bodyBlock, agentLabel);

  return { at, door, principal, proposals, input, reply, ...(lane ? { lane } : {}) };
}

/** Extract a value from a YAML-style key: value line. */
function extractFmField(fmBlock: string, key: string): string | null {
  // Match `key: value` (value may be empty)
  const re = new RegExp(`^${key}:\\s*(.*)$`, "m");
  const m = fmBlock.match(re);
  if (!m) return null;
  return m[1].trim();
}

/**
 * Parse the body block (after the closing ---) to extract input and reply.
 *
 * Format:
 *   (blank line)
 *   **<speaker>:** <input text, may be multi-line>
 *   (blank line)
 *   **<agent>:** <reply text, may be multi-line>
 *   (blank line)
 *
 * The SPEAKER is the FIRST bold label in the body that is NOT `agentLabel` — a person's name
 * on a door turn, or a scheduled lane's name (rendered as "<lane> (scheduled)") on a
 * machine-authored one. This function knows no name of its own; both labels it matches against
 * come from the caller. The agent's reply block may be absent (action-only turn).
 */
function parseBody(body: string, agentLabel: string): { input: string; reply: string } {
  const agentMarker = `**${agentLabel}:**`;
  const boldLabel = /\*\*([^*\n]+):\*\*/g;
  let speaker: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = boldLabel.exec(body)) !== null) {
    if (m[1] !== agentLabel) {
      speaker = m;
      break;
    }
  }
  if (!speaker) {
    return { input: "", reply: "" };
  }

  const afterSpeaker = body.slice(speaker.index + speaker[0].length);
  const agentIdx = afterSpeaker.indexOf(agentMarker);

  let inputRaw: string;
  let replyRaw: string;

  if (agentIdx === -1) {
    inputRaw = afterSpeaker;
    replyRaw = "";
  } else {
    inputRaw = afterSpeaker.slice(0, agentIdx);
    replyRaw = afterSpeaker.slice(agentIdx + agentMarker.length);
  }

  return {
    input: inputRaw.trim(),
    reply: replyRaw.trim(),
  };
}

// ─── readConversationLogs ─────────────────────────────────────────────────────

/**
 * Load all conversation log files from the brain, parse them, filter to
 * entries strictly AFTER `since`, and return sorted by `at` ascending.
 *
 * The `since` filter is STRICT (greater-than), so a re-run never reprocesses
 * the boundary entry from the previous dream cycle.
 *
 * Scheduled turns (entries carrying a `lane`) are EXCLUDED. The dream cycle exists to
 * learn how he works from what HE said; a scheduled lane's "input" is a machine-generated
 * nudge with no human in it. It carries zero signal, and feeding it back in only risks
 * her promoting observations about her own briefs.
 */
export async function readConversationLogs(
  brain: LogReaderBrain,
  opts: { since: string; agentLabel: string },
): Promise<TurnLogEntry[]> {
  const allPaths = await brain.list();

  const convPaths = allPaths.filter(
    (p) => p.startsWith("_meta/conversations/") && p.endsWith(".md"),
  );

  const entries: TurnLogEntry[] = [];

  for (const path of convPaths) {
    let markdown: string;
    try {
      markdown = await brain.read(path);
    } catch {
      continue; // skip unreadable files
    }

    const entry = parseConversationLog(markdown, opts.agentLabel);
    if (!entry) continue;

    // A scheduled turn is not him talking — nothing to learn from it.
    if (entry.lane) continue;

    // STRICT greater-than: exclude boundary entry
    if (entry.at <= opts.since) continue;

    entries.push(entry);
  }

  // Sort by `at` ascending (ISO strings sort lexicographically)
  entries.sort((a, b) => a.at.localeCompare(b.at));

  return entries;
}

// ─── readConversationEntries — the table, with a fallback for one installation-lifetime gap ──

/** The structural slice of `@lares/agent-kit/conversation-record`'s `makeConversationRecord(db)`
 *  this reader needs — narrowed so a test can inject a fake without a database. */
export interface EntryReader {
  since(opts: {
    agent: string;
    since: Date;
    excludeLanes?: boolean;
    limit?: number;
  }): Promise<ConversationEntry[]>;
}

/** Postgres' "relation does not exist" (42P01) — the shape an unapplied migration 060
 *  produces. The same code `lib/turn-capture.ts`'s `isMissingTableError` checks on the write
 *  side; duplicated here rather than imported because that helper is module-private there. */
function isMissingTableError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01";
}

function toTurnLogEntry(row: ConversationEntry): TurnLogEntry {
  return {
    at: row.at.toISOString(),
    door: row.door,
    principal: row.personKey,
    input: row.input,
    reply: row.reply,
    proposals: row.proposals,
    // The whole reason this track exists: the reflector's input must be able to tell an
    // owner's own words from a reply that quoted a fetched page or a synced document.
    // `lane` is deliberately NOT carried onto the result — every row here already excluded
    // one (`excludeLanes: true` below and in the markdown reader above), and carrying an
    // always-absent field would let a later reader believe the filter had not run.
    origin: row.origin,
  };
}

/**
 * The dream cycle's read. `conversation_entries` (ADR-0020's table) is the source of truth;
 * `_meta/conversations/**\/*.md` is read only for the one gap the table cannot itself answer
 * for, and only until that gap is gone.
 *
 * NO GAP, NO DOUBLE READ — a rule this slice adds. The plan that named this function assumed a
 * clean cutover (the table always has everything since the cursor); the code as actually
 * shipped by the slice before this one (W3B-s2/turn-capture.ts) DUAL-WRITES, keeping the
 * markdown log on so the dream cycle would not go blind before this slice landed. That leaves
 * a real installation-lifetime case: a box that applies migration 060 (or starts the dual
 * write) LATER than its dream cycle's own cursor. On that box, the table has nothing before
 * the moment writes started landing in it, even though the cursor points further back — and
 * everything between the cursor and that moment exists ONLY in markdown.
 *
 *   1. Ask the table for its EARLIEST row for this agent (`since: EPOCH, limit: 1`,
 *      excluding scheduled lanes the same way the main read does). If that row is AT OR
 *      BEFORE the cursor, the table's coverage already reaches back through the cursor, so
 *      `since(cursor)` on the table alone is a complete, gap-free answer. Markdown is not
 *      read at all.
 *   2. If the table's earliest row is AFTER the cursor (or the table has nothing for this
 *      agent yet), the table cannot answer for the window right after the cursor. Read
 *      markdown for THAT SAME WINDOW ONLY — `cursor < at < table's earliest row` (or, if the
 *      table has nothing after the cursor either, the whole window after the cursor) — and
 *      combine it with whatever the table did return. The two windows are disjoint by
 *      construction (nothing the table returned has an `at` before its own earliest row), so
 *      no turn is ever read from both sources.
 *   3. If the table cannot be queried at all — migration 060 has not been applied, Postgres'
 *      42P01 — the read fails soft to markdown for the WHOLE window, with one warning, and
 *      the nightly job still completes. This is the same failure `lib/turn-capture.ts`
 *      recognises on the write side; here it is not throttled, because the dream cycle runs
 *      at most nightly, not once per turn.
 *
 * Once every installation's table has been given a chance to catch up past its own cursor,
 * step 1 always finds coverage and steps 2/3 stop firing on their own — no code needs to
 * change to retire them, only the markdown corpus itself (a later slice's job).
 */
export async function readConversationEntries(
  reader: EntryReader,
  brain: LogReaderBrain,
  opts: { agent: string; since: string; agentLabel: string },
): Promise<TurnLogEntry[]> {
  const cursor = new Date(opts.since);
  const EPOCH_DATE = new Date(0);

  let sinceCursor: ConversationEntry[];
  try {
    sinceCursor = await reader.since({ agent: opts.agent, since: cursor, excludeLanes: true });
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    console.warn(
      "dream: conversation_entries does not exist yet — apply services/box/sql/060_conversation_entries.sql. " +
        "Reading the legacy markdown log for this cycle instead.",
      err,
    );
    return readConversationLogs(brain, { since: opts.since, agentLabel: opts.agentLabel });
  }

  const earliest = await reader.since({ agent: opts.agent, since: EPOCH_DATE, excludeLanes: true, limit: 1 });
  const tableEarliestAt = earliest[0]?.at;
  const hasCoverageAtCursor = tableEarliestAt !== undefined && tableEarliestAt.getTime() <= cursor.getTime();

  if (hasCoverageAtCursor) {
    return sinceCursor.map(toTurnLogEntry);
  }

  // The table does not yet reach back to the cursor — fill the gap from markdown, once, never
  // overlapping what the table already returned.
  const boundary = sinceCursor[0]?.at; // undefined ⇒ the table has nothing after the cursor either
  const markdownEntries = await readConversationLogs(brain, { since: opts.since, agentLabel: opts.agentLabel });
  const gapEntries = boundary
    ? markdownEntries.filter((e) => new Date(e.at).getTime() < boundary.getTime())
    : markdownEntries;

  return [...gapEntries, ...sinceCursor.map(toTurnLogEntry)].sort((a, b) => a.at.localeCompare(b.at));
}
