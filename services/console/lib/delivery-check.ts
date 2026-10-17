/**
 * "Would this message ever be sent?" - the check behind three saves: a brief hour, a door's quiet
 * hours, and where a message is routed.
 *
 * The gate holds back any message whose door is inside its quiet window at the moment it is due
 * (`@lares/agent-kit/proactivity`). A brief set for 06:00 that goes to a door whose quiet hours
 * end at 07:00 is therefore never sent, silently, every day. Nothing used to look at the two
 * settings together; this does, at save time, and the actions refuse with the sentence below.
 *
 * Server only (it reads the proactivity helpers, which reach the database module). The pure part is
 * `briefConflicts`, tested without one; `loadConflictInputs` gathers what it needs and answers
 * `null` when it cannot, in which case the caller saves as before - a check that cannot see is not
 * a reason to block the owner.
 */
import { isDeliveryKind, configuredDoors, DELIVERY_KIND_LABEL, DOOR_LABEL, type DeliveryDoor, type DeliveryKind, type DeliveryMap } from "@lares/agent-kit/delivery";
import { listAgents } from "./agents";
import { keeper } from "./keeper-client";
import { effectiveQuietWindow, parseHHMM, readDoors, readSettings } from "./proactivity";
import { readScheduleHoursSettings } from "./schedule-settings";

/** The schedules that fire at an owner-chosen hour, and the kind of message each sends. */
export const HOURLY_KINDS: Readonly<Record<string, DeliveryKind>> = {
  "morning-brief": "morning-brief",
  "evening-brief": "evening-brief",
  "weekly-summary": "weekly-summary",
  digest: "digest",
  "crm-routing": "crm-routing",
};

export const WEB_DOOR_ID = "web:inbox";

export interface RoutingFact {
  agent: string;
  delivery: DeliveryMap | undefined;
  doors: { kind: string; enabled: boolean }[];
}

export interface QuietRow { agent: string; door: string; quietStart: string | null; quietEnd: string | null }

/** The door a kind really goes to for this agent: the first listed door that is switched on, else web chat. */
export function doorFor(fact: RoutingFact, kind: DeliveryKind): DeliveryDoor | null {
  const mapped = fact.delivery?.[kind] !== undefined;
  const order = configuredDoors(kind, fact.delivery);
  if (mapped && !order.includes("web")) order.push("web");
  for (const door of order) {
    if (door === "web") return "web";
    if (fact.doors.some((d) => d.kind === door && d.enabled)) return door;
  }
  return null;
}

/** The quiet window the gate would use for (agent, door), by the kit's rule: the most specific stored value wins. */
export function quietWindowFor(rows: readonly QuietRow[], agent: string, doorId: string): { start: string; end: string } {
  const applicable = rows
    .filter((r) => (r.agent === "*" || r.agent === agent) && (r.door === "*" || r.door === doorId))
    .sort((a, b) => rank(a) - rank(b));
  let start: string | null = null;
  let end: string | null = null;
  for (const r of applicable) {
    if (r.quietStart !== null) start = r.quietStart;
    if (r.quietEnd !== null) end = r.quietEnd;
  }
  const w = effectiveQuietWindow(start, end);
  return { start: w.quietStart, end: w.quietEnd };
}
const rank = (r: QuietRow) => (r.agent === "*" ? 0 : 1) + (r.door === "*" ? 0 : 2);

/** Is `hour`:00 inside the window? A window that crosses midnight (21:00-07:00) is handled. */
export function hourInQuietWindow(hour: number, w: { start: string; end: string }): boolean {
  const s = parseHHMM(w.start);
  const e = parseHHMM(w.end);
  if (s === null || e === null || s === e) return false;
  const t = hour * 60;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

const hh = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

export interface ConflictInput {
  facts: readonly RoutingFact[];
  /** Hours per schedule (the values being saved, or the stored ones). */
  hours: Readonly<Record<string, readonly number[]>>;
  rows: readonly QuietRow[];
  /** Door ids this install has used, to find the real ids behind "Telegram". */
  knownDoors: readonly string[];
  /** Check only these schedules / only this door id (a quiet-hours save names one door). */
  onlySchedules?: readonly string[];
  onlyDoorId?: string;
}

/** Plain sentences, one per brief hour that would never be sent. Empty = fine. */
export function briefConflicts(input: ConflictInput): string[] {
  const out: string[] = [];
  const many = input.facts.length > 1;
  for (const fact of input.facts) {
    for (const [schedule, kind] of Object.entries(HOURLY_KINDS)) {
      if (input.onlySchedules && !input.onlySchedules.includes(schedule)) continue;
      const hours = input.hours[schedule];
      if (!hours) continue;
      const door = doorFor(fact, kind);
      if (door === null) continue;
      const ids = door === "web" ? [WEB_DOOR_ID] : input.knownDoors.filter((d) => d.startsWith(`${door}:`));
      for (const doorId of ids.length > 0 ? ids : [`${door}:`]) {
        if (input.onlyDoorId && input.onlyDoorId !== "*" && input.onlyDoorId !== doorId) continue;
        const w = quietWindowFor(input.rows, fact.agent, doorId);
        for (const hour of hours) {
          if (!hourInQuietWindow(hour, w)) continue;
          out.push(
            `${DELIVERY_KIND_LABEL[kind]}${many ? ` (${fact.agent})` : ""} is set for ${hh(hour)}, but it goes to ` +
            `${DOOR_LABEL[door]} and ${DOOR_LABEL[door]}'s quiet hours run ${w.start} to ${w.end}, so it would be held back ` +
            `every day. Choose an hour outside quiet hours, or change where it goes.`,
          );
        }
      }
    }
  }
  return [...new Set(out)];
}

export interface ConflictData {
  facts: RoutingFact[];
  hours: Record<string, number[]>;
  rows: QuietRow[];
  knownDoors: string[];
}

/** What the check needs, or null when any of it cannot be read (the save then goes ahead). */
export async function loadConflictInputs(owner: string, actor: string): Promise<ConflictData | null> {
  try {
    const agents = (await listAgents({ strict: true })).filter((a) => a.role === "Chief of Staff");
    const facts: RoutingFact[] = [];
    for (const a of agents) {
      const saved = await keeper<{ definition: string }>("definition.get", { name: a.name }, actor);
      const def = JSON.parse(saved.definition) as { delivery?: DeliveryMap; doors?: RoutingFact["doors"]; channels?: string[] };
      const doors = def.doors ?? (def.channels ?? []).map((kind) => ({ kind, enabled: true }));
      facts.push({ agent: a.name, delivery: def.delivery, doors: doors.map((d) => ({ kind: d.kind, enabled: d.enabled })) });
    }
    const [schedule, settings, knownDoors] = await Promise.all([
      readScheduleHoursSettings(owner), readSettings(owner), readDoors(owner),
    ]);
    if (schedule.unavailable) return null;
    return {
      facts,
      hours: Object.fromEntries(schedule.rows.map((r) => [r.schedule, r.hours])),
      rows: settings.map((s) => ({ agent: s.agent, door: s.door, quietStart: s.quietStart, quietEnd: s.quietEnd })),
      knownDoors,
    };
  } catch (e) {
    console.warn("delivery check: could not read what it needs - saving without the quiet-hours check", e);
    return null;
  }
}

/** Is this key one the map may carry? (Used by the save action before it touches the keeper.) */
export function knownKind(kind: string): kind is DeliveryKind {
  return isDeliveryKind(kind);
}
