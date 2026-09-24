// lib/budget.ts — daily LLM-token spend cap for Marcel, persisted as {date, used, notified}.
// Ported verbatim from services/marcel/lib/budget.ts. One file, single process — plain sync
// fs, no locking (mirrors the old runtime's trips.ts/schedule.ts). The tz decides what
// "today" means for the reset boundary; there's no injected clock because the constructor
// signature is fixed by the daemon contract — tests exercise the reset path by writing a
// stale-dated fixture file instead.
import fs from "node:fs";
import path from "node:path";

interface BudgetState {
  date: string; // YYYY-MM-DD in the configured tz
  used: number;
  notified?: boolean; // set once the first breach of the day has been reported
}

export class Budget {
  private file: string;
  private dailyLimit: number;
  private tz: string;
  private state: BudgetState;

  constructor(file: string, dailyLimit: number, tz: string) {
    this.file = file;
    this.dailyLimit = dailyLimit;
    this.tz = tz;
    this.state = this.loadForToday();
  }

  private todayISO(): string {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: this.tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  private loadForToday(): BudgetState {
    const today = this.todayISO();
    if (fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as BudgetState;
        if (raw.date === today) return raw;
      } catch {
        // malformed file — fall through to a fresh state below
      }
    }
    return { date: today, used: 0 };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state));
  }

  private resetIfNewDay(): void {
    const today = this.todayISO();
    if (this.state.date !== today) {
      this.state = { date: today, used: 0 };
    }
  }

  add(tokens: number): void {
    this.resetIfNewDay();
    this.state.used += tokens;
    this.save();
  }

  exceeded(): boolean {
    this.resetIfNewDay();
    return this.state.used >= this.dailyLimit;
  }

  /** True only the first time this is called on a given day — callers use it to send
   *  exactly one "budget exceeded" DM per day, however many times they hit the check. */
  notifyOnce(): boolean {
    this.resetIfNewDay();
    if (this.state.notified) return false;
    this.state.notified = true;
    this.save();
    return true;
  }
}
