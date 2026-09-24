/**
 * lib/initiation.ts — the one line every proactive message in this service passes through
 * (ORB-193 Task 3).
 *
 * The gate itself lives in `@lares/agent-kit/proactivity` (`gatedSend`: quiet hours on the OWNER's
 * clock, do-not-disturb, already-seen, and the per-door/per-owner daily ceilings, all recorded in
 * the `initiations` ledger). This file is the SERVICE's seam onto it, and it exists for three
 * reasons:
 *
 * 1. **Eleven call sites, one shape.** Owner id, agent name, the owner clock and the pool are the
 *    same for every one of them. Eleven copies of that assembly is how a fleet ends up with two
 *    schedules counting against different doors, or one forgetting the ledger entirely.
 * 2. **One log line, one wording.** `<schedule>: initiation <verdict> (<reason>) for <itemKey>` —
 *    the string an operator greps when a message did not arrive. A per-schedule phrasing would
 *    make that grep miss exactly the lane that went quiet.
 * 3. **Three answers, not two.** A lane's next move is one of three things, and the distinction is
 *    load-bearing (fix round 1, CRITICAL): SENT (do the bookkeeping), ALREADY SEEN (he was told on
 *    an earlier tick and only the bookkeeping failed — do it now, and do NOT re-send), or HELD (mark
 *    nothing, stay eligible, land when the gate reopens). A boolean read `already-seen` as "held",
 *    which in three lanes meant re-detecting — and twice re-BILLING — the same item every tick
 *    forever. `InitiationOutcome.handled` is the flag; every call site converting `Decision` itself
 *    would be a copy of that rule, and the copies are where it would drift back.
 *
 * FAIL-OPEN, all the way down. `gatedSend` never throws (a dead ledger logs and sends); this
 * wrapper adds the same posture for its own two inputs — an unresolvable owner clock falls back
 * to home inside `ownerTz()`, and a pool that cannot be built means the message goes out
 * ungated with a warning. A missed suppression is an annoyance; a silent stop is ORB-179.
 */
import { getPool } from "@lares/agent-kit/db";
import {
  gatedSend,
  wouldSend,
  type Decision,
  type InitiationClass,
  type InitiationRequest,
} from "@lares/agent-kit/proactivity";

import { ownerId } from "./principals.js";
import { ownerTz } from "./owner-clock.js";

/** `initiations.agent` for every schedule in this service. */
export const SAGA_AGENT = "saga";

/** The per-send half of an `InitiationRequest` — what differs between two sends. Owner, agent and
 *  the owner clock are the same for all of them and are filled in below. */
export interface SagaInitiation {
  cls: InitiationClass;
  /** `lib/principals.ts`'s `doorId(...)` — `telegram:<chatId>` / `slack:<channelOrUserId>`. */
  door: string;
  /** scheduled: `<schedule>/<slotKey>`; event: the durable id of the thing; escalation: `<id>#<rung>`. */
  itemKey: string;
  /** Reminders only: the owner chose this time, so quiet hours do not apply (DND still does). */
  ownerSetTime?: boolean;
  /** A ladder's final "I stopped" — deferred under DND, never suppressed. Set by the deadline
   *  ladder's rung 3 (`agent/schedules/deadlines.ts`), the one caller today. */
  finalStop?: boolean;
  /** The tick's own `now`, when it has one (slot schedules do). Defaults to the wall clock. */
  now?: Date;
  /** The owner tz, when the tick already resolved it for its slot. Defaults to `ownerTz()`. */
  tz?: string;
}

/** Every reason the kit's gate can give, without restating the union here. */
export type InitiationReason = Extract<Decision, { reason: string }>["reason"];

/**
 * What a schedule needs to know after asking the gate. NOT a boolean, and that is the whole point
 * (fix round 1, CRITICAL): `suppress`/`already-seen` and `defer`/`door-ceiling` are opposite
 * instructions to the caller, and a boolean collapses them into one.
 *
 *   - `sent` — the callback ran on THIS call.
 *   - `alreadySeen` — a `sent` row for this item key already exists. He WAS told, on an earlier tick
 *     or an earlier process; the only reason this lane is here again is that its own bookkeeping
 *     write failed after that send. Re-sending would be a duplicate; leaving the item "eligible"
 *     would loop forever, re-detecting and (in two lanes) re-BILLING the same item on every tick.
 *   - `handled` — `sent || alreadySeen`: **the flag a lane branches its bookkeeping on.** Mark the
 *     reminder delivered, stamp `announced_at`, write `markReplied` — exactly as after a real send.
 *   - a genuine hold (`dnd`, `quiet-hours`, a ceiling) is neither: the item stays eligible and
 *     nothing is marked, so it lands the moment the gate reopens.
 */
export interface InitiationOutcome {
  verdict: Decision["verdict"];
  reason?: InitiationReason;
  sent: boolean;
  alreadySeen: boolean;
  handled: boolean;
}

/**
 * The gate as the schedules consume it.
 *
 * A dep-shaped type, so the pure tick factories (`makeProposalsWatchTick`, `makeCrmRoutingTick`,
 * `makeEmailTriageTick`, …) take the gate as an INJECTED dep and their existing unit tests keep
 * running with no ledger at all — see `SEND_UNGATED`.
 */
export type Initiate<T = SagaInitiation> = (init: T, send: () => Promise<void>) => Promise<InitiationOutcome>;

/**
 * The gate with its DOOR already bound — what a tick factory takes when every send in it goes to
 * the same place (one Slack DM, one Telegram chat), which is all of them but `reminders`.
 *
 * Binding the door in the live wiring rather than inside the tick is deliberate: the channel id is
 * live wiring's business (it comes from an env-backed allowlist), and a pure tick that had to know
 * it would need it injected for no other reason than to hand it straight back.
 */
export type DoorInitiate = Initiate<Omit<SagaInitiation, "door">>;

/**
 * The default for a tick factory constructed without a gate: send, unconditionally.
 *
 * This is NOT a production path — every live wiring in `agent/schedules/*.ts` passes a real gate
 * — it is what keeps a pure unit test pure. Named so that a live wiring that forgot the gate reads
 * as a bug in review rather than as a sensible default.
 */
export const SEND_UNGATED: DoorInitiate = async (_init, send) => {
  await send();
  return { verdict: "send", sent: true, alreadySeen: false, handled: true };
};

/** `<schedule>: initiation <verdict> (<reason>) for <itemKey>` — one line, one wording, and
 *  nothing at all on a normal send. An `already-seen` suppression says a second line, because it
 *  means something a reader would otherwise guess wrong: he was told, and the lane is about to
 *  finish the bookkeeping that failed last time. */
export function logInitiation(schedule: string, d: Decision, itemKey: string): void {
  if (d.verdict === "send") return;
  console.log(`${schedule}: initiation ${d.verdict} (${d.reason}) for ${itemKey}`);
  if (d.verdict === "suppress" && d.reason === "already-seen") {
    console.log(`${schedule}: ${itemKey} was already sent — recording it as handled, not re-sending`);
  }
}

/** The `Decision` the gate returned, in the shape the lanes branch on. */
export function outcomeOf(d: Decision): InitiationOutcome {
  const sent = d.verdict === "send";
  const alreadySeen = d.verdict === "suppress" && d.reason === "already-seen";
  return {
    verdict: d.verdict,
    ...(d.verdict === "send" ? {} : { reason: d.reason }),
    sent,
    alreadySeen,
    handled: sent || alreadySeen,
  };
}

/** The full request, owner/agent/clock filled in. Exported for the tests that assert what a
 *  schedule asks the gate for. */
export async function initiationRequest(init: SagaInitiation): Promise<InitiationRequest> {
  const { now, tz, ...rest } = init;
  return {
    owner: ownerId(),
    agent: SAGA_AGENT,
    ...rest,
    now: now ?? new Date(),
    tz: tz ?? (await ownerTz()),
  };
}

/**
 * THE call. `const sent = await initiate("evening-brief", { … }, async () => { …the send… })`.
 *
 * The callback is invoked only on a `send` verdict, and the ledger's `sent` row is written only
 * after it resolves (`gatedSend`'s own contract) — so a thrown send leaves the item eligible
 * rather than silently spent.
 */
export async function initiate(
  schedule: string,
  init: SagaInitiation,
  send: () => Promise<void>,
): Promise<InitiationOutcome> {
  // Missing identity is not a recoverable ledger outage. Never send unowned.
  ownerId();
  let req: InitiationRequest;
  let db;
  try {
    req = await initiationRequest(init);
    db = getPool();
  } catch (e) {
    // Only the wiring can fail here (no DATABASE_URL, a bad env) — `ownerTz` and `gatedSend`
    // both degrade internally. Fail OPEN, loudly, and name what is not being enforced.
    console.warn(
      `${schedule}: the proactivity gate could not be reached for ${init.itemKey} — sending UNGATED ` +
        "(no quiet hours, no DND, no ceiling, no dedupe)",
      e,
    );
    await send();
    return { verdict: "send", sent: true, alreadySeen: false, handled: true };
  }

  const decision = await gatedSend(db, req, send);
  logInitiation(schedule, decision, req.itemKey);
  return outcomeOf(decision);
}

/**
 * LAR-35-s2: `initiate`'s precheck twin — "would you let this through right now?", asked before
 * any billed work rather than around it. Same request-building and the same fail-open wiring as
 * `initiate`; the only difference is that it calls the kit's `wouldSend` instead of `gatedSend`,
 * so there is no callback and nothing is ever sent. A caller checks this first, and only does the
 * classify/compose/draft work — then calls `initiate` for the real send — on a `handled: false`
 * (genuine hold) it can skip entirely.
 */
export async function wouldInitiate(
  schedule: string,
  init: SagaInitiation,
): Promise<InitiationOutcome> {
  // Missing identity is not a recoverable ledger outage. Never send unowned.
  ownerId();
  let req: InitiationRequest;
  let db;
  try {
    req = await initiationRequest(init);
    db = getPool();
  } catch (e) {
    // Same posture as `initiate`'s own catch: only the wiring can fail here. Fail OPEN — a
    // precheck that cannot reach the ledger must not block the caller from proceeding.
    console.warn(
      `${schedule}: the proactivity gate could not be reached for ${init.itemKey} — this precheck ` +
        "answers UNGATED (no quiet hours, no DND, no ceiling, no dedupe)",
      e,
    );
    return { verdict: "send", sent: true, alreadySeen: false, handled: true };
  }

  const decision = await wouldSend(db, req);
  logInitiation(schedule, decision, req.itemKey);
  return outcomeOf(decision);
}

/** `initiate` bound to one schedule — the full-door shape (`reminders`, whose door is per row). */
export function initiateFor(schedule: string): Initiate {
  return (init, send) => initiate(schedule, init, send);
}

/** `initiate` bound to one schedule AND one door — the shape every other tick factory takes. */
export function initiateTo(schedule: string, door: string): DoorInitiate {
  return (init, send) => initiate(schedule, { ...init, door }, send);
}

/**
 * LAR-17-s2 — the extra guard a single-slot-per-owner-day schedule needs now that its hour is a
 * SETTING an owner can change mid-day.
 *
 * The ledger's own dedupe (`already-seen`, above) is keyed on the exact item key,
 * `<schedule>/<owner date>T<hour>` — by design, and NOT the seam to widen for this: LAR-67's tests
 * (`tests/brief-owner-day-wiring.test.ts`) pin that exact shape, hour included, and the proactivity
 * contract (ADR 0014) pins the ledger's dedupe key to the item key it is given. So moving a
 * schedule's hour mid-day (08:00 → 09:00, say, changed AFTER today's 08:00 brief already sent)
 * gives the 09:00 tick a BRAND NEW key the ledger has never seen — a second brief, not a duplicate
 * of the first one.
 *
 * For a schedule where "at most one send per owner-day" IS the actual contract (today, the two
 * briefs), this is the belt in front of that: before ever asking the gate, ask whether ANY hour of
 * `schedule` already has a `sent` row for `ownerDay`. It reads the ledger table directly — not a
 * new kit export, because "the hour is folded into the item key" is a shape assumption about THIS
 * service's slot schedules, not a kit-level concept — and, like every other read on this path, a
 * failure answers `false` rather than blocking the tick: a rare double-send on a DB hiccup that
 * ALSO happens to coincide with a same-day settings change costs far less than a schedule gone
 * silent for the rest of the day because of that same hiccup.
 */
export async function alreadySentToday(
  db: ReturnType<typeof getPool>, owner: string, agent: string, schedule: string, ownerDay: string,
): Promise<boolean> {
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM initiations
        WHERE owner = $1 AND agent = $2 AND owner_day = $3 AND status = 'sent' AND item_key LIKE $4
        LIMIT 1`,
      [owner, agent, ownerDay, `${schedule}/%`],
    );
    return rows.length > 0;
  } catch (e) {
    console.warn(`${schedule}: could not check today's send history — proceeding as if nothing has gone out yet`, e);
    return false;
  }
}
