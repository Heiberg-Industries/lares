// lib/conversation-log.ts — per-trip, per-day JSONL conversation log.
// Ported verbatim from services/marcel/lib/conversation-log.ts (Task 8b — the wave plan's
// inventory listed this file as Task 3's responsibility, but Task 3's own dispatched brief
// never included it, so it was never built; agent/channels/telegram.ts and
// agent/schedules/dream.ts both carried a documented placeholder in its place until now).
//
// One trip = one chatlog dir (trip.dir/chatlog, see lib/trip-store.ts's `Trip.dir` — the same
// `root/trips/<slug>` path old Marcel used); one file per tz-local day (YYYY-MM-DD.jsonl) so a
// day's transcript is a single readable file and old days never need rewriting. Sync fs only —
// this is a single-process daemon, matching lib/trip-store.ts's own sync-fs assumption.
import fs from "node:fs";
import path from "node:path";

/** Same window old Marcel used for every `log.transcript(...)` call feeding the gate/brain
 *  (`services/marcel/bin/marcel.ts:596,619,638,646` and `MarcelBrain.answer`'s own callers —
 *  see `lib/brain.ts:367`'s `buildSystemPrompt` invocation) — 15 recent messages. One shared
 *  constant (Fix Wave B, Finding 1) so `agent/channels/telegram.ts`'s own transcript reads and
 *  `agent/instructions/trip-context.ts`'s dynamic "## Samtalen nylig" section never drift apart
 *  on the window size. */
export const TRANSCRIPT_WINDOW = 15;

export interface LogEntry {
  ts: number; // unix seconds
  from: string;
  name: string;
  text: string;
  marcel?: boolean;
}

export class ConversationLog {
  private dir: string;
  private tz: string;

  constructor(dir: string, tz: string) {
    this.dir = dir;
    this.tz = tz;
  }

  private dateKey(ts: number): string {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: this.tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ts * 1000));
  }

  private fileFor(dateISO: string): string {
    return path.join(this.dir, `${dateISO}.jsonl`);
  }

  append(e: LogEntry): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.fileFor(this.dateKey(e.ts)), JSON.stringify(e) + "\n");
  }

  day(dateISO: string): LogEntry[] {
    const file = this.fileFor(dateISO);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as LogEntry);
  }

  recent(n: number): LogEntry[] {
    const now = new Date();
    const todayKey = this.dateKey(Math.floor(now.getTime() / 1000));
    const yesterdayKey = this.dateKey(Math.floor(now.getTime() / 1000) - 86400);
    const entries = [...this.day(yesterdayKey), ...this.day(todayKey)];
    return entries.slice(-n);
  }

  transcript(n: number): string {
    return this.recent(n)
      .map((e) => `${e.marcel ? "Marcel" : e.name}: ${e.text}`)
      .join("\n");
  }
}
