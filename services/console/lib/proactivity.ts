/**
 * ORB-193 — the read layer and the pure validation behind `/proactivity`.
 *
 * The console is the owner's surface for the one gate every proactive message passes
 * (`packages/agent-kit/src/proactivity.ts`): quiet hours per door on the owner's clock,
 * do-not-disturb, two daily ceilings, and the ledger (`initiations`) that records what actually
 * happened. Console first — every knob gets a surface, so nobody has to open the database to stop
 * their phone ringing.
 *
 * THE ENGINE VALUES ARE MIRRORED, NOT IMPORTED. The console deliberately does not depend on
 * `@lares/agent-kit` (`app/actions/meeting-series.ts` states the same rule for agent-runtime), and
 * the numbers below are a copy of that module's `ENGINE`. They are checked in one place — the
 * "engine max" the page prints and the refusal an action returns come from THIS constant — so a
 * drift shows up as a console that refuses a number the fleet would accept, never as a console that
 * accepts one the fleet silently clamps. If the kit's ceilings change, change these too.
 *
 * Two asymmetries worth stating, because both look like bugs until you see the reason:
 *
 * 1. **The kit CLAMPS a too-high ceiling on read; this page REFUSES it on write.** Silently storing
 *    50 and enforcing 10 leaves an owner reading their own settings and being wrong about
 *    production. A refusal that names the maximum is the honest version of the same rule.
 *
 *    But refusing on write only covers the rows the console wrote. A row edited by hand in SQL
 *    (the runbook's own escape hatch) can hold a 50 the kit clamps to 10, or a 05:00–06:00 window
 *    the kit throws away for the engine's whole 21:00–07:00 — and a page that printed the stored
 *    number would then be the most confident liar in the system. So every stored value is run back
 *    through the KIT'S read-time rules here (`effectiveCeiling`, `effectiveQuietWindow`) and the
 *    page shows what the engine will actually do, annotated with what the row says when the two
 *    disagree: "stored 50 — the engine uses 10".
 * 2. **Quiet hours are per DOOR ID, not per channel.** `loadSettings` matches `door` exactly
 *    against `telegram:<chatId>` / `slack:<channelOrUserId>`, so a row saved as the bare word
 *    `telegram` would match nothing and be a knob that does nothing. The page therefore offers the
 *    global scope (`*`, every door) plus the door ids this install has actually used, discovered
 *    from the ledger — labelled "Telegram · <id>" so it still reads as the brief's telegram/slack.
 *
 * The trip source of the owner clock is NOT visible here: the console container mounts only
 * `/srv/taste` (`services/box/compose.yaml`), not Marcel's `/srv/eve-marcel`. The page says so
 * rather than printing "home" as if no trip existed.
 */
import { pool } from "./db";

// ---------------------------------------------------------------------------------------------
// The engine's floor and ceiling — a mirror of packages/agent-kit/src/proactivity.ts's ENGINE.
// ---------------------------------------------------------------------------------------------

export const ENGINE = {
  quietStart: "21:00",
  quietEnd: "07:00",
  quietMinHours: 8,
  eventPerDoorPerDay: 20,
  escalationPerDoorPerDay: 3,
  perOwnerPerDay: 30,
} as const;

/** The agents that can hold a DND switch of their own (plan Ruling 6: global + per agent). */
export const AGENTS = ["saga", "marcel", "calliope"] as const;
export type AgentScope = "*" | (typeof AGENTS)[number];

/** The same regex as `sql/035_proactivity.sql`'s CHECK and the kit's read-time validation. */
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/u;

export const DEFAULT_HOME_TZ = "Europe/Oslo";
const SLACK_SIGNAL_MAX_AGE_HOURS = 24;
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------------------------

/** Minutes since midnight, or `null` for anything the schema's CHECK would refuse. A malformed
 *  value reaches the gate as NaN minutes and every comparison against NaN is false — quiet hours
 *  would vanish at every hour of the day — which is why this refuses instead of coercing. */
export function parseHHMM(value: string): number | null {
  if (typeof value !== "string" || !HHMM.test(value)) return null;
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export type Validation = { ok: true } | { ok: false; message: string };

/**
 * The engine floor, checked the way the kit checks it: the window may be MOVED anywhere, but never
 * shrunk below {@link ENGINE.quietMinHours}. The span is computed modulo the day, so a window that
 * crosses midnight (23:00→07:00 = 8 h) is measured correctly and an equal start and end is an
 * empty window, not a whole day.
 *
 * The kit's fallback for a too-short window is the ENGINE window whole; this refuses instead, so
 * the owner learns that 05:00–06:00 was not stored rather than discovering later that their
 * mornings are silent.
 */
export function validateQuietHours(quietStart: string, quietEnd: string): Validation {
  const s = parseHHMM(quietStart);
  if (s === null) return { ok: false, message: `Quiet-hours start ${JSON.stringify(quietStart)} is not a 24-hour time like 21:00.` };
  const e = parseHHMM(quietEnd);
  if (e === null) return { ok: false, message: `Quiet-hours end ${JSON.stringify(quietEnd)} is not a 24-hour time like 07:00.` };
  const span = (e - s + 1440) % 1440;
  if (span < ENGINE.quietMinHours * 60) {
    return {
      ok: false,
      message:
        `${quietStart}–${quietEnd} is ${(span / 60).toFixed(1)} h of quiet. Quiet hours are movable, not removable: ` +
        `the window must be at least ${ENGINE.quietMinHours} h.`,
    };
  }
  return { ok: true };
}

export interface Ceilings {
  eventPerDoorPerDay: number;
  escalationPerDoorPerDay: number;
  perOwnerPerDay: number;
}

export type CeilingCheck = { ok: true; values: Ceilings } | { ok: false; message: string };

/**
 * Settings may only LOWER a ceiling. Every field must be a whole number between 0 and its engine
 * maximum; 0 is legitimate (silence is a setting). Anything higher is refused by name, because the
 * kit would clamp it on read and the stored number would then lie to the person who typed it.
 *
 * Named `checkCeilings` and not `clampCeilings` because it REFUSES — it never returns a trimmed
 * number. The clamping half of the same rule lives in `effectiveCeiling` below, which is a READ, and
 * a name that promised clamping on the write path is how someone comes to believe a too-high value
 * was quietly fixed for them.
 */
export function checkCeilings(input: Ceilings): CeilingCheck {
  const fields: Array<[keyof Ceilings, string, number]> = [
    ["eventPerDoorPerDay", "Events per door per day", ENGINE.eventPerDoorPerDay],
    ["escalationPerDoorPerDay", "Escalations per door per day", ENGINE.escalationPerDoorPerDay],
    ["perOwnerPerDay", "Messages per day (all doors)", ENGINE.perOwnerPerDay],
  ];
  for (const [key, label, max] of fields) {
    const v = input[key];
    if (!Number.isInteger(v) || v < 0) return { ok: false, message: `${label} must be a whole number, 0 or more.` };
    if (v > max) return { ok: false, message: `${label} cannot be raised above the engine maximum of ${max}.` };
  }
  return {
    ok: true,
    values: {
      eventPerDoorPerDay: input.eventPerDoorPerDay,
      escalationPerDoorPerDay: input.escalationPerDoorPerDay,
      perOwnerPerDay: input.perOwnerPerDay,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Re-validation on READ — what the engine will actually do with the row that is stored
// ---------------------------------------------------------------------------------------------

/**
 * One setting as the ENGINE will use it, plus the stored value when the two disagree.
 *
 * `note` is the whole point: an owner looking at this page must never be able to read a number the
 * fleet is not enforcing. When the row and the engine agree, `note` is null and the page shows a
 * plain value; when they do not, the page shows the EFFECTIVE value and says what the row holds.
 */
export interface Effective<T> {
  /** What the engine uses — the number or time the page shows. */
  value: T;
  /** The stored value, only when it differs from {@link value}; null when they agree. */
  stored: T | null;
  /** Plain language, e.g. `stored 50 — the engine uses 10`. Null when nothing disagrees. */
  note: string | null;
}

const agrees = <T>(value: T): Effective<T> => ({ value, stored: null, note: null });

/**
 * `loadSettings`'s `clamp`, mirrored: null means the engine default, and a stored number is capped
 * at the engine maximum (and floored at 0) on every read. A row above the maximum is not an error
 * here — the fleet is already running the clamped value — so this reports rather than refuses.
 */
export function effectiveCeiling(stored: number | null, max: number): Effective<number> {
  if (stored === null || stored === undefined || !Number.isFinite(Number(stored))) return agrees(max);
  const value = Math.max(0, Math.min(Number(stored), max));
  return value === Number(stored)
    ? agrees(value)
    : { value, stored: Number(stored), note: `stored ${Number(stored)} — the engine uses ${value}` };
}

export interface EffectiveQuietWindow {
  quietStart: string;
  quietEnd: string;
  /** True when the row stores nothing at all — the page's "· default" marker. */
  isDefault: boolean;
  /** Null when the stored window is the one the engine uses. */
  note: string | null;
}

/**
 * `loadSettings`'s quiet-hours reading, mirrored in the same order: each cell falls back to its own
 * engine value when it is not `HH:MM` (so one bad half does not discard the good one), and THEN a
 * window shorter than the engine floor is replaced by the engine window WHOLESALE — not by the
 * owner's start with the end pushed out, which would turn 05:00–06:00 into 05:00–13:00.
 *
 * A null cell is the engine default and is not a disagreement; a malformed one is.
 */
export function effectiveQuietWindow(storedStart: string | null, storedEnd: string | null): EffectiveQuietWindow {
  const isDefault = (storedStart ?? null) === null && (storedEnd ?? null) === null;
  const notes: string[] = [];

  const cell = (raw: string | null, engine: string): string => {
    if (raw === null || raw === undefined) return engine;
    if (parseHHMM(raw) !== null) return raw;
    notes.push(`stored ${JSON.stringify(raw)} is not a 24-hour time — the engine uses ${engine}`);
    return engine;
  };

  let quietStart = cell(storedStart, ENGINE.quietStart);
  let quietEnd = cell(storedEnd, ENGINE.quietEnd);

  const span = ((parseHHMM(quietEnd) ?? 0) - (parseHHMM(quietStart) ?? 0) + 1440) % 1440;
  if (span < ENGINE.quietMinHours * 60) {
    notes.push(
      `stored ${quietStart}–${quietEnd} is ${(span / 60).toFixed(1)} h — the engine uses ` +
      `${ENGINE.quietStart}–${ENGINE.quietEnd}`,
    );
    quietStart = ENGINE.quietStart;
    quietEnd = ENGINE.quietEnd;
  }

  return { quietStart, quietEnd, isDefault, note: notes.length === 0 ? null : notes.join("; ") };
}

/** DND is an OR across scopes, exactly as the kit resolves it: a global switch cannot be undone by
 *  a narrower row saying false. */
export function effectiveDnd(global: boolean, agent: boolean | undefined): boolean {
  return global || agent === true;
}

// ---------------------------------------------------------------------------------------------
// Owner clock (the part the console can see)
// ---------------------------------------------------------------------------------------------

export interface ConsoleOwnerClock {
  tz: string;
  source: "slack-profile" | "home";
  detail: string;
  /** Always false here: the console does not mount Marcel's trip store. */
  tripVisible: boolean;
}

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || tz.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("sv-SE", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure: the clock as far as the console can see it — a FRESH Slack-profile signal, else home.
 * Mirrors `packages/agent-kit/src/owner-clock.ts`'s priority minus its first source (trip), which
 * needs a file this container does not mount. Never throws; an unusable timezone degrades one step.
 */
export function resolveConsoleOwnerClock(
  now: Date,
  opts: { homeTz: string; slackProfile?: { tz: string; observedAt: Date } },
): ConsoleOwnerClock {
  const home = isValidTimeZone(opts.homeTz) ? opts.homeTz : DEFAULT_HOME_TZ;
  const signal = opts.slackProfile;
  if (signal && isValidTimeZone(signal.tz)) {
    const ageHours = (now.getTime() - signal.observedAt.getTime()) / HOUR_MS;
    if (ageHours <= SLACK_SIGNAL_MAX_AGE_HOURS) {
      return {
        tz: signal.tz,
        source: "slack-profile",
        detail: `Slack profile, observed ${Math.max(0, Math.round(ageHours))}h ago`,
        tripVisible: false,
      };
    }
    return { tz: home, source: "home", detail: "home timezone — the Slack signal is stale (older than 24 h)", tripVisible: false };
  }
  return { tz: home, source: "home", detail: "home timezone — no fresh Slack signal", tripVisible: false };
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (!f) {
    // `sv-SE` formats as `YYYY-MM-DD HH:MM` — ISO-shaped without hand-assembling it, the same
    // trick the kit uses so a date and a time always come off the same clock.
    f = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

/** The owner's calendar day (`YYYY-MM-DD`) for an instant — what the ceilings count on. */
export function ownerDayIn(now: Date, tz: string): string {
  return formatter(tz).format(now).slice(0, 10);
}

/** A ledger timestamp on the owner's clock: `YYYY-MM-DD HH:MM`. `null` renders as empty. */
export function formatInOwnerTz(at: Date | null, tz: string): string {
  if (at === null) return "";
  return formatter(tz).format(at).replace(",", "");
}

// ---------------------------------------------------------------------------------------------
// Labels — plain language, the raw id kept visible
// ---------------------------------------------------------------------------------------------

export function doorLabel(door: string): string {
  if (door === "*") return "All doors";
  const i = door.indexOf(":");
  if (i <= 0) return door;
  const kind = door.slice(0, i);
  const id = door.slice(i + 1);
  const name = kind === "telegram" ? "Telegram" : kind === "slack" ? "Slack" : kind;
  return `${name} · ${id}`;
}

const REASONS: Record<string, string> = {
  dnd: "do not disturb was on",
  "dnd-final-stop": "do not disturb was on — held, not dropped",
  "quiet-hours": "inside quiet hours",
  "already-seen": "already sent once",
  "door-ceiling": "this door's daily ceiling was full",
  "owner-ceiling": "the day's ceiling across all doors was full",
};

/** An unknown reason passes through verbatim — a new kit reason must show up, not disappear. */
export function reasonLabel(reason: string | null): string {
  if (reason === null || reason === undefined || reason === "") return "";
  return REASONS[reason] ?? reason;
}

export function agentLabel(agent: string): string {
  return agent === "*" ? "Every agent" : agent;
}

// ---------------------------------------------------------------------------------------------
// The owner this console speaks for
// ---------------------------------------------------------------------------------------------

/**
 * `initiations.owner` / `proactivity_settings.owner` — the identity registry's canonical id.
 * The same rule as `services/chief-of-staff/lib/principals.ts`'s `ownerId()`, so the console reads and
 * writes the rows the fleet reads. Read per call, never at module scope.
 */
export function ownerId(env: NodeJS.ProcessEnv = process.env): string {
  const owner = env["AGENT_OWNER_USER_ID"]?.trim();
  if (!owner) throw new Error("Owner identity is not configured: set AGENT_OWNER_USER_ID");
  return owner;
}

/** The home fallback of the owner clock — the plan's one env-only knob, shown read-only. */
export function homeTz(env: NodeJS.ProcessEnv = process.env): string {
  return env["OWNER_HOME_TZ"]?.trim() || DEFAULT_HOME_TZ;
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export interface SettingsRowDTO {
  agent: string;
  door: string;
  quietStart: string | null;
  quietEnd: string | null;
  eventPerDoorPerDay: number | null;
  escalationPerDoorPerDay: number | null;
  perOwnerPerDay: number | null;
  dnd: boolean;
  updatedBy: string | null;
  updatedAt: Date | null;
  /**
   * The same row put back through the kit's read-time rules — what the fleet will actually enforce.
   * Attached on READ (see asymmetry 1 in the module header) so no surface downstream can print a
   * stored number the engine is quietly overriding.
   */
  effective: EffectiveSettings;
}

export interface EffectiveSettings {
  quiet: EffectiveQuietWindow;
  eventPerDoorPerDay: Effective<number>;
  escalationPerDoorPerDay: Effective<number>;
  perOwnerPerDay: Effective<number>;
}

/** Pure, and exported so the page and its tests read the row exactly as `readSettings` does. */
export function effectiveSettings(row: {
  quietStart: string | null; quietEnd: string | null;
  eventPerDoorPerDay: number | null; escalationPerDoorPerDay: number | null; perOwnerPerDay: number | null;
}): EffectiveSettings {
  return {
    quiet: effectiveQuietWindow(row.quietStart, row.quietEnd),
    eventPerDoorPerDay: effectiveCeiling(row.eventPerDoorPerDay, ENGINE.eventPerDoorPerDay),
    escalationPerDoorPerDay: effectiveCeiling(row.escalationPerDoorPerDay, ENGINE.escalationPerDoorPerDay),
    perOwnerPerDay: effectiveCeiling(row.perOwnerPerDay, ENGINE.perOwnerPerDay),
  };
}

export interface TodayRowDTO {
  door: string;
  status: "sent" | "suppressed" | "deferred";
  reason: string | null;
  count: number;
}

export interface InitiationRowDTO {
  id: string;
  decidedAt: Date;
  sentAt: Date | null;
  agent: string;
  door: string;
  cls: string;
  itemKey: string;
  status: string;
  reason: string | null;
  untilAt: Date | null;
}

export interface ProactivityView {
  owner: string;
  clock: ConsoleOwnerClock;
  homeTz: string;
  /** Every stored settings row for this owner (any scope). */
  settings: SettingsRowDTO[];
  /** `*` first, then every door id this install has used — the scopes quiet hours can be set for. */
  doors: string[];
  today: TodayRowDTO[];
  /** The owner day `today` was counted for, on the owner's clock. */
  todayDay: string;
  recent: InitiationRowDTO[];
  /** Read failures, in plain language. Non-empty means the numbers below are NOT the live ones. */
  errors: string[];
}

interface RawSettings {
  agent: string; door: string;
  quiet_start: string | null; quiet_end: string | null;
  event_per_door_per_day: number | null; escalation_per_door_per_day: number | null; per_owner_per_day: number | null;
  dnd: boolean; updated_by: string | null; updated_at: Date | null;
}

export async function readSettings(owner: string): Promise<SettingsRowDTO[]> {
  const { rows } = await pool.query<RawSettings>(
    `SELECT agent, door, quiet_start, quiet_end, event_per_door_per_day, escalation_per_door_per_day,
            per_owner_per_day, dnd, updated_by, updated_at
       FROM proactivity_settings
      WHERE owner = $1
      ORDER BY (agent = '*') DESC, agent, (door = '*') DESC, door`,
    [owner],
  );
  return rows.map((r) => {
    const stored = {
      quietStart: r.quiet_start,
      quietEnd: r.quiet_end,
      eventPerDoorPerDay: r.event_per_door_per_day === null ? null : Number(r.event_per_door_per_day),
      escalationPerDoorPerDay: r.escalation_per_door_per_day === null ? null : Number(r.escalation_per_door_per_day),
      perOwnerPerDay: r.per_owner_per_day === null ? null : Number(r.per_owner_per_day),
    };
    return {
      agent: r.agent,
      door: r.door,
      ...stored,
      dnd: r.dnd === true,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at === null ? null : new Date(r.updated_at),
      effective: effectiveSettings(stored),
    };
  });
}

/** Today's ledger, grouped the way the page shows it: per door, per status, per reason. */
export async function readToday(owner: string, ownerDay: string): Promise<TodayRowDTO[]> {
  const { rows } = await pool.query<{ door: string; status: TodayRowDTO["status"]; reason: string | null; count: number }>(
    `SELECT door, status, reason, count(*)::int AS count
       FROM initiations
      WHERE owner = $1 AND owner_day = $2
      GROUP BY door, status, reason
      ORDER BY door, status, reason NULLS FIRST`,
    [owner, ownerDay],
  );
  return rows.map((r) => ({ door: r.door, status: r.status, reason: r.reason, count: Number(r.count) }));
}

export async function readRecent(owner: string, limit = 50): Promise<InitiationRowDTO[]> {
  const { rows } = await pool.query<{
    id: string; decided_at: Date; sent_at: Date | null; agent: string; door: string;
    cls: string; item_key: string; status: string; reason: string | null; until_at: Date | null;
  }>(
    `SELECT id, decided_at, sent_at, agent, door, cls, item_key, status, reason, until_at
       FROM initiations
      WHERE owner = $1
      ORDER BY id DESC
      LIMIT $2`,
    [owner, limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    decidedAt: new Date(r.decided_at),
    sentAt: r.sent_at === null ? null : new Date(r.sent_at),
    agent: r.agent,
    door: r.door,
    cls: r.cls,
    itemKey: r.item_key,
    status: r.status,
    reason: r.reason,
    untilAt: r.until_at === null ? null : new Date(r.until_at),
  }));
}

/**
 * The door ids quiet hours can be set for: `*` plus every door this install has actually spoken
 * through (from the ledger) or already has a settings row for. Discovered rather than configured —
 * the console has no way to know a Telegram chat id, and a hard-coded `telegram` would be a knob
 * that matches nothing (see the module header).
 */
export async function readDoors(owner: string): Promise<string[]> {
  const { rows } = await pool.query<{ door: string }>(
    `SELECT DISTINCT door FROM (
       SELECT door FROM initiations WHERE owner = $1
       UNION SELECT door FROM proactivity_settings WHERE owner = $1
     ) d
      WHERE door <> '*'
      ORDER BY door`,
    [owner],
  );
  return ["*", ...rows.map((r) => r.door)];
}

async function readSlackSignal(owner: string): Promise<{ tz: string; observedAt: Date } | undefined> {
  const { rows } = await pool.query<{ tz: string; observed_at: Date }>(
    `SELECT tz, observed_at FROM owner_clock_signals WHERE owner = $1 AND source = 'slack-profile'`,
    [owner],
  );
  const row = rows[0];
  return row ? { tz: row.tz, observedAt: new Date(row.observed_at) } : undefined;
}

/** Each read is caught separately and reported by name: a page that silently shows "DND off" after
 *  a failed read is a lie about production, which is the one thing this surface must never be. */
async function attempt<T>(what: string, fallback: T, errors: string[], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    console.error(`proactivity console: could not read ${what}`, e);
    errors.push(`Could not read ${what} — what is shown below is not the live value.`);
    return fallback;
  }
}

/** Everything `/proactivity` renders, in one round of reads. */
export async function getProactivityView(now: Date = new Date()): Promise<ProactivityView> {
  const owner = ownerId();
  const home = homeTz();
  const errors: string[] = [];

  const signal = await attempt("the owner-clock signal", undefined, errors, () => readSlackSignal(owner));
  const clock = resolveConsoleOwnerClock(now, { homeTz: home, ...(signal ? { slackProfile: signal } : {}) });
  const todayDay = ownerDayIn(now, clock.tz);

  const [settings, doors, today, recent] = await Promise.all([
    attempt("the proactivity settings", [] as SettingsRowDTO[], errors, () => readSettings(owner)),
    attempt("the door list", ["*"], errors, () => readDoors(owner)),
    attempt("today's ledger", [] as TodayRowDTO[], errors, () => readToday(owner, todayDay)),
    attempt("the recent initiations", [] as InitiationRowDTO[], errors, () => readRecent(owner, 50)),
  ]);

  return { owner, clock, homeTz: home, settings, doors, today, todayDay, recent, errors };
}

/**
 * Today's grouped rows folded per door, the way the page shows them: the sent count, then each
 * suppression and each deferral with its reason. Pure, and here rather than in the page so it can
 * be tested — a wrong fold would understate what was held back, which is the number that matters.
 */
export interface TodayDoorFold {
  door: string;
  sent: number;
  suppressed: TodayRowDTO[];
  deferred: TodayRowDTO[];
}

export function foldTodayByDoor(rows: readonly TodayRowDTO[]): TodayDoorFold[] {
  const doors = [...new Set(rows.map((r) => r.door))].sort();
  return doors.map((door) => {
    const mine = rows.filter((r) => r.door === door);
    return {
      door,
      sent: mine.filter((r) => r.status === "sent").reduce((n, r) => n + r.count, 0),
      suppressed: mine.filter((r) => r.status === "suppressed"),
      deferred: mine.filter((r) => r.status === "deferred"),
    };
  });
}

/** The stored row for a scope, if any — the page's per-scope defaults. */
export function rowFor(settings: readonly SettingsRowDTO[], agent: string, door: string): SettingsRowDTO | undefined {
  return settings.find((r) => r.agent === agent && r.door === door);
}
