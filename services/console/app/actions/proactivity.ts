"use server";
/**
 * ORB-193 — the three knobs of the proactivity gate, written from the console.
 *
 * Every write is an upsert on `(owner, agent, door)`, the primary key of `proactivity_settings`,
 * and each action touches only its own columns: a saved DND must not blank someone's quiet hours,
 * and the row for a scope is shared by all three knobs.
 *
 * Invalid input is REFUSED and reported ("do not disturb" and a ceiling are the two settings whose
 * silent mangling costs an owner real messages) — these actions return `{ ok: false, message }`
 * rather than throwing, so the surface can say what was wrong beside the field. An unauthenticated
 * caller still throws, exactly as every other action here does: that is not user error.
 *
 * LAR-16-s3 — `saveBriefLanguage` is a fourth, unrelated knob (`brief_settings`, not
 * `proactivity_settings`) that lives here because the control it backs sits on this same page,
 * beside the home-timezone line. Modelled on `saveLadderEnabled` in `app/actions/deadlines.ts`.
 *
 * LAR-17-s5 — `saveScheduleHours` is a fifth, also unrelated knob (`schedule_settings`), owner-
 * scoped like `saveBriefLanguage` rather than door-scoped like the three above. Only the five
 * owner-facing schedules `lib/schedule-hours.ts`'s `OWNER_FACING_SCHEDULES` names may be changed
 * here — `dream` and `voice-learn` are internal night jobs the kit knows but this page refuses.
 */
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { pool } from "../../lib/db";
import { verify } from "../../lib/auth";
import { AGENTS, checkCeilings, ownerId, readDoors, validateQuietHours } from "../../lib/proactivity";
import type { Ceilings } from "../../lib/proactivity";
import { isBriefLanguageCode } from "../../lib/brief-settings";
import { isOwnerFacingSchedule, validateHours } from "../../lib/schedule-settings";

export type SaveResult = { ok: true } | { ok: false; message: string };

async function requireUser(): Promise<string> {
  const email = await verify((await cookies()).get("lares_session")?.value);
  if (!email) throw new Error("unauthenticated");
  return email;
}

const AGENT_SCOPES: readonly string[] = ["*", ...AGENTS];

/** A door scope must be `*` or a door this install has actually used. The gate matches `door`
 *  EXACTLY (`telegram:<chatId>`), so a typed-in door nobody speaks through would be a knob that
 *  silently does nothing — the same reasoning as `requireCardId` in the voice actions. */
async function requireDoor(owner: string, door: string): Promise<SaveResult> {
  if (door === "*") return { ok: true };
  const known = await readDoors(owner);
  if (!known.includes(door)) {
    return { ok: false, message: `${door} is not a door this install has used — it would be a setting nothing reads.` };
  }
  return { ok: true };
}

/**
 * Do not disturb, globally (`agent: "*"`) or for one agent. The gate ORs the scopes together, so
 * turning the global switch on cannot be undone by an agent row — the page says so too.
 */
export async function saveDnd(input: { agent: string; dnd: boolean }): Promise<SaveResult> {
  const email = await requireUser();
  if (!AGENT_SCOPES.includes(input.agent)) {
    return { ok: false, message: `Unknown agent scope ${JSON.stringify(input.agent)}.` };
  }
  if (typeof input.dnd !== "boolean") return { ok: false, message: "Do not disturb must be on or off." };
  const owner = ownerId();
  await pool.query(
    `INSERT INTO proactivity_settings (owner, agent, door, dnd, updated_by, updated_at)
     VALUES ($1, $2, '*', $3, $4, now())
     ON CONFLICT (owner, agent, door)
     DO UPDATE SET dnd = EXCLUDED.dnd, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [owner, input.agent, input.dnd, email],
  );
  revalidatePath("/proactivity");
  return { ok: true };
}

/**
 * Quiet hours for a door scope (`*` = every door). Movable, not removable: the window is refused if
 * it is shorter than the engine floor, which is the same rule the kit applies on read — except the
 * kit falls back to the engine window and this tells the owner instead.
 */
export async function saveQuietHours(input: { door: string; quietStart: string; quietEnd: string }): Promise<SaveResult> {
  const email = await requireUser();
  const owner = ownerId();
  const door = await requireDoor(owner, input.door);
  if (!door.ok) return door;
  const valid = validateQuietHours(input.quietStart, input.quietEnd);
  if (!valid.ok) return valid;
  await pool.query(
    `INSERT INTO proactivity_settings (owner, agent, door, quiet_start, quiet_end, updated_by, updated_at)
     VALUES ($1, '*', $2, $3, $4, $5, now())
     ON CONFLICT (owner, agent, door)
     DO UPDATE SET quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end,
                   updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [owner, input.door, input.quietStart, input.quietEnd, email],
  );
  revalidatePath("/proactivity");
  return { ok: true };
}

/**
 * The three daily ceilings. Settings may only LOWER them: a value above the engine maximum is
 * refused by name rather than stored and silently clamped on read.
 */
export async function saveCeilings(input: { door: string } & Ceilings): Promise<SaveResult> {
  const email = await requireUser();
  const owner = ownerId();
  const door = await requireDoor(owner, input.door);
  if (!door.ok) return door;
  const checked = checkCeilings({
    eventPerDoorPerDay: input.eventPerDoorPerDay,
    escalationPerDoorPerDay: input.escalationPerDoorPerDay,
    perOwnerPerDay: input.perOwnerPerDay,
  });
  if (!checked.ok) return checked;
  await pool.query(
    `INSERT INTO proactivity_settings
       (owner, agent, door, event_per_door_per_day, escalation_per_door_per_day, per_owner_per_day, updated_by, updated_at)
     VALUES ($1, '*', $2, $3, $4, $5, $6, now())
     ON CONFLICT (owner, agent, door)
     DO UPDATE SET event_per_door_per_day = EXCLUDED.event_per_door_per_day,
                   escalation_per_door_per_day = EXCLUDED.escalation_per_door_per_day,
                   per_owner_per_day = EXCLUDED.per_owner_per_day,
                   updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [owner, input.door, checked.values.eventPerDoorPerDay, checked.values.escalationPerDoorPerDay, checked.values.perOwnerPerDay, email],
  );
  revalidatePath("/proactivity");
  return { ok: true };
}

/**
 * The brief's language. Refuses anything outside `BRIEF_LANGUAGES_MIRROR` by name rather than
 * storing it — the same "refused, not mangled" rule the rest of this file states, and the reason
 * `sql/050_brief_settings.sql`'s own CHECK is a FORMAT check only, not an enumerated list: this
 * file is where an unsupported code is actually turned away.
 */
export async function saveBriefLanguage(input: { language: string }): Promise<SaveResult> {
  const email = await requireUser();
  if (!isBriefLanguageCode(input.language)) {
    return { ok: false, message: `${JSON.stringify(input.language)} is not a supported brief language.` };
  }
  const owner = ownerId();
  await pool.query(
    `INSERT INTO brief_settings (owner, language, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (owner) DO UPDATE SET language = EXCLUDED.language, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [owner, input.language, email],
  );
  revalidatePath("/proactivity");
  return { ok: true };
}

/**
 * The hour(s) one owner-facing schedule fires on. The mirrored validation
 * (`lib/schedule-hours.ts`'s `validateHours`) runs BEFORE any write, so a malformed input (not a
 * whole hour, more than one hour for a single-slot schedule, a duplicate, or an unsorted list) is
 * refused with a plain sentence and nothing is written — the same "refused, not mangled" rule
 * every other action in this file follows. Input is never reordered: an unsorted list is refused,
 * not silently sorted, so what the owner typed and what got stored never quietly disagree.
 */
export async function saveScheduleHours(input: { schedule: string; hours: number[] }): Promise<SaveResult> {
  const email = await requireUser();
  if (!isOwnerFacingSchedule(input.schedule)) {
    return { ok: false, message: `${JSON.stringify(input.schedule)} is not one of the schedules this page can change.` };
  }
  const checked = validateHours(input.schedule, input.hours);
  if (!checked.ok) return checked;
  const owner = ownerId();
  await pool.query(
    `INSERT INTO schedule_settings (owner, schedule, hours, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (owner, schedule)
     DO UPDATE SET hours = EXCLUDED.hours, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [owner, input.schedule, input.hours, email],
  );
  revalidatePath("/proactivity");
  return { ok: true };
}
