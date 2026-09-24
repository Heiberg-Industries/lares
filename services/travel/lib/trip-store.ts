// lib/trip-store.ts — file-backed trip store + taste loader.
// Ported verbatim from services/marcel/lib/trips.ts (Task 5). Layout under root
// (MARCEL_DATA_ROOT, see agent/tools/sveip.ts):
//   config.json
//   trips/<slug>/{trip.md,itinerary.md,bookings.md,shopping.md,learned.md}
//   reise-log.md
//   taste/{preferences.md,google-maps-lists/*.csv}
// Sync fs only — this mirrors old Marcel's single-process-daemon assumption; eve-marcel's
// container runs one process per instance too, so no locking is added here. Note: unlike old
// Marcel's `/srv/marcel` bind mount, eve-marcel's compose block bind-mounts a FRESH path,
// `/srv/eve-marcel`, deliberately not the old one (review fix, finding 1 — old Marcel's trip
// files are old-runtime-shaped, e.g. numeric ids vs this file's own `string` ids below, so
// reusing that path would silently invite a shape mismatch). `config.json` must be seeded
// once before first use — see the compose block's own comment for the exact provisioning
// step; every `config()`/`trips()` call throws until it exists.
//
// The one deliberate type change from old Marcel: ids (`adminId`, `Trip.chatId`) are `string`,
// not `number` — matching eve-marcel's own convention (`lib/principals.ts`'s
// `MARCEL_ADMIN_TELEGRAM_ID`, eve's `TelegramChat.id`/`TelegramUser.id`), not old Marcel's
// long-polling Telegram SDK's numeric ids.
import fs from "node:fs";
import path from "node:path";

export interface Trip {
  slug: string;
  name: string;
  start: string; // ISO date, inclusive
  end: string; // ISO date, inclusive
  timezone: string; // e.g. "Europe/Paris"
  destination: { name: string; lat: number; lon: number };
  chatId?: string;
  dir: string; // absolute trip dir
}

export interface MarcelConfig {
  adminId: string;
  killSwitch: boolean;
  dailyTokenBudget: number;
  /** ORB-124 — the clock Marcel posts on BEFORE a trip's derived arrival date, when Bendik is
   *  still at home. Fleet-wide rather than per trip (Bendik: "Oslo is good if we are not able to
   *  pick up where I am before a trip"), and optional so an already-provisioned config.json keeps
   *  working untouched — absent means {@link DEFAULT_HOME_TIMEZONE}.
   *
   *  There is nothing better to read: Telegram does not expose the phone's timezone, so the
   *  alternative to a configured home is a guess. Recorded here so it is not re-litigated. */
  homeTimezone?: string;
  trips: Omit<Trip, "dir">[];
}

/** Where Bendik is when he is not travelling. Matches the fleet's global day-boundary
 *  convention (`@lares/agent-kit`'s schedule-gate.ts, `agent/instructions/trip-context.ts`'s own FALLBACK_TZ). */
export const DEFAULT_HOME_TIMEZONE = "Europe/Oslo";

// `persona-overlay.md` (ORB-96) is created EMPTY like every other trip file and filled in by a
// best-effort model call at /nytur — an empty overlay renders no section at all, so a trip whose
// generation failed behaves exactly like a trip that never had one.
const TRIP_FILES = [
  "trip.md",
  "itinerary.md",
  "bookings.md",
  "shopping.md",
  "learned.md",
  "persona-overlay.md",
] as const;
const REISE_LOG_MAX_LINES = 40;
const REISE_LOG_LINE_TS = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/;

export class TripStore {
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  private configPath(): string {
    return path.join(this.root, "config.json");
  }

  config(): MarcelConfig {
    const file = this.configPath();
    if (!fs.existsSync(file)) {
      throw new Error(`Marcel config missing: ${file} — provision config.json before starting the daemon`);
    }
    return JSON.parse(fs.readFileSync(file, "utf8")) as MarcelConfig;
  }

  saveConfig(c: MarcelConfig): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.configPath(), JSON.stringify(c, null, 2));
  }

  /** ORB-124 — the configured home clock, or Europe/Oslo when the config predates the field.
   *  One accessor so no caller has to remember the default. */
  homeTimezone(): string {
    return this.config().homeTimezone ?? DEFAULT_HOME_TIMEZONE;
  }

  private dirFor(slug: string): string {
    return path.join(this.root, "trips", slug);
  }

  createTrip(t: Omit<Trip, "dir" | "chatId">): Trip {
    const dir = this.dirFor(t.slug);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of TRIP_FILES) {
      fs.writeFileSync(path.join(dir, file), "");
    }

    const cfg = this.config();
    cfg.trips.push({ ...t });
    this.saveConfig(cfg);

    return { ...t, dir };
  }

  trips(): Trip[] {
    return this.config().trips.map((t) => ({ ...t, dir: this.dirFor(t.slug) }));
  }

  tripForChat(chatId: string): Trip | undefined {
    return this.trips().find((t) => t.chatId === chatId);
  }

  linkChat(slug: string, chatId: string): void {
    const cfg = this.config();
    const t = cfg.trips.find((t) => t.slug === slug);
    if (!t) throw new Error(`linkChat: no trip with slug "${slug}"`);
    t.chatId = chatId;
    this.saveConfig(cfg);
  }

  activeTrips(todayISO: string): Trip[] {
    return this.trips().filter((t) => t.start <= todayISO && todayISO <= t.end);
  }

  read(trip: Trip, file: (typeof TRIP_FILES)[number]): string {
    const full = path.join(trip.dir, file);
    if (!fs.existsSync(full)) return "";
    return fs.readFileSync(full, "utf8");
  }

  write(trip: Trip, file: string, content: string): void {
    fs.mkdirSync(trip.dir, { recursive: true });
    fs.writeFileSync(path.join(trip.dir, file), content);
  }

  append(trip: Trip, file: string, block: string): void {
    fs.mkdirSync(trip.dir, { recursive: true });
    fs.appendFileSync(path.join(trip.dir, file), block + "\n");
  }

  // Rolling log of every Reise-mail the pipeline has seen and its outcome — the chat brain
  // reads this so Marcel can answer "did you see the Avis mail?" truthfully even when the
  // mail was silently skipped (duplicate/no-trip/not-booking).
  private reiseLogPath(): string {
    return path.join(this.root, "reise-log.md");
  }

  reiseLog(): string {
    const file = this.reiseLogPath();
    if (!fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8");
  }

  appendReiseLog(line: string): void {
    fs.mkdirSync(this.root, { recursive: true });
    const lines = this.reiseLog().split("\n").filter((l) => l.length > 0);
    lines.push(line);
    // Cap by NEWEST received-timestamp, never by append order: a year-long sweep appends
    // newest mail first, so last-appended-wins evicted today's mails in favor of year-old
    // ones (old Marcel live bug 2026-07-21). Timestamp prefix sorts lexicographically; lines
    // without one sort last. Sort is stable — same-minute lines keep their append order.
    const ts = (l: string) => l.match(REISE_LOG_LINE_TS)?.[1] ?? "";
    lines.sort((a, b) => ts(b).localeCompare(ts(a)));
    fs.writeFileSync(this.reiseLogPath(), lines.slice(0, REISE_LOG_MAX_LINES).join("\n") + "\n");
  }

  /**
   * Marcel's OWN learned taste — what his dream/promote schedules worked out across trips
   * (lib/dream.ts's `promoteTaste` appends here). Writable, and staying exactly where it is.
   *
   * It is NOT the saved-places store: that is `/srv/taste`, fed by the console, read through
   * lib/taste-store.ts, and read-only to Marcel (ORB-100 retired the Takeout CSVs that used to
   * live beside this file — one store, one shape, one parser). Two different things: one is what
   * Bendik saved, the other is what Marcel noticed.
   */
  tasteProfile(): string {
    const prefsFile = path.join(this.root, "taste", "preferences.md");
    return fs.existsSync(prefsFile) ? fs.readFileSync(prefsFile, "utf8") : "";
  }
}
