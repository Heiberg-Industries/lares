/**
 * lib/initiation.ts — the one line every proactive message Marcel sends passes through
 * (ORB-193 Task 4). The mirror of `services/chief-of-staff/lib/initiation.ts`, same shape, agent
 * `"marcel"`.
 *
 * The gate itself lives in `@lares/agent-kit/proactivity` (`gatedSend`: quiet hours on the
 * OWNER's clock, do-not-disturb, already-seen, and the per-door/per-owner daily ceilings, all
 * recorded in the `initiations` ledger). This file is the SERVICE's seam onto it, and it holds
 * the two ITEM-KEY shapes, which is the part a second copy would get subtly wrong:
 *
 *   - a lifecycle post: `trip/<slug>/<kind>/<dateISO>` — one send per trip per slot per day,
 *   - a flight card:    `flight/<slug>/<flightRef>/<state fingerprint>` — one send per material
 *     change, so a card that says the same thing twice is already-seen and a genuinely new state
 *     is a new item.
 *
 * WHAT IS NOT AN INITIATION. An EDIT of a live flight card (`editFlightMessage`) is not a new
 * message — the group's phone does not light up for it — so it never reaches this file. The gate
 * counts messages that interrupt, and the whole point of the edit-in-place card (ORB-130's
 * "one live message per flight") is that it interrupts once.
 *
 * MARCEL'S OWN QUIET HOURS STAY. `lib/trip-schedule.ts`'s `isQuietForPost` (22:00 on the posting
 * clock, and 22:00–07:00 for flight deltas) runs BEFORE anything here and is the stricter rule of
 * the two — the gate's default window is 21:00–07:00, so it can only ever hold back more, never
 * less. DND and the ceilings are the gate's alone.
 *
 * FAIL-OPEN, all the way down. `gatedSend` never throws (a dead ledger logs and sends); this
 * wrapper adds the same posture for its own two inputs — an unresolvable owner clock falls back
 * to home inside `ownerTz()`, and a pool that cannot be built means the message goes out ungated
 * with a warning. A missed suppression is an annoyance; a silent stop is ORB-179.
 */
import { getPool } from "@lares/agent-kit/db";
import {
  gatedSend,
  type Decision,
  type InitiationClass,
  type InitiationRequest,
} from "@lares/agent-kit/proactivity";

/** The gate's three answers, as the send sites consume them. Derived from the kit's own `Decision`
 *  so the two can never drift; `lib/trip-schedule.ts`'s `PostVerdict` is the same union spelled out
 *  (that file stays dependency-free), and the two meet — and are type-checked against each other —
 *  in `agent/schedules/trip-lifecycle.ts`. */
export type InitiationVerdict = Decision["verdict"];

import { ownerId } from "./principals.js";
import { ownerTz } from "./owner-clock.js";
import type { PostKind, PostSlot, FlightCard } from "./trip-schedule.js";

/** `initiations.agent` for every send in this service. */
export const MARCEL_AGENT = "marcel";

/** The per-send half of an `InitiationRequest` — what differs between two sends. Owner, agent and
 *  the owner clock are the same for all of them and are filled in below. */
export interface MarcelInitiation {
  cls: InitiationClass;
  /** `lib/principals.ts`'s `doorId("telegram", chatId)`. */
  door: string;
  itemKey: string;
  /** The tick's own `now`, when it has one. Defaults to the wall clock. */
  now?: Date;
  /** The owner tz, when the caller already resolved it. Defaults to `ownerTz()`. */
  tz?: string;
  /**
   * Quiet-hours exempt: an owner-set time, or a safety-critical alert. DND still applies, and a
   * DND suppression is terminal for both — the owner asked for silence, and this fleet does not
   * hold a message for a switch with no end time.
   *
   * Two callers set it, and the second is the one worth reading twice:
   *
   *  - a `reminder`, because Bendik's own booking chose the hour (plan Ruling 3). Marcel's local
   *    rule only rolls a fire time forward from 22:00, while the gate's quiet window opens at
   *    21:00 — without this, every 21:00–22:00 reminder was suppressed for good.
   *  - a flight CANCELLATION, because deferring it loses it: `diffFlightState` has already written
   *    `cancelled: true` into `flight-state.json` by then, so the same alert is never generated
   *    again and a hold until 07:00 is silence about a cancelled flight, not a delay.
   */
  ownerSetTime?: boolean;
  /** A ladder's final "I stopped" — deferred under DND, never suppressed. No caller sets it yet. */
  finalStop?: boolean;
}

/** A lifecycle post's ledger key: `trip/<slug>/<kind>/<dateISO>`, plus the booking id when the
 *  day can hold several of the same kind. Only `reminder` can (one per booking with a time), and
 *  without the id two dinners on one day would collapse into one item — the second suppressed as
 *  already-seen, which is a missed reminder, not a saved interruption. */
export function tripItemKey(slug: string, kind: PostKind, slot: PostSlot): string {
  const base = `trip/${slug}/${kind}/${slot.dateISO}`;
  return slot.itemId === undefined ? base : `${base}/${slot.itemId}`;
}

/** A flight card's ledger key: `flight/<slug>/<flightRef>/<state fingerprint>`. */
export function flightItemKey(card: FlightCard): string {
  return `flight/${card.slug}/${card.flightRef}/${card.fingerprint}`;
}

/** `<schedule>: initiation <verdict> (<reason>) for <itemKey>` — one line, one wording, and
 *  nothing at all on a normal send. The string an operator greps when a post did not arrive. */
export function logInitiation(schedule: string, d: Decision, itemKey: string): void {
  if (d.verdict === "send") return;
  console.log(`${schedule}: initiation ${d.verdict} (${d.reason}) for ${itemKey}`);
}

/** The full request, owner/agent/clock filled in. Exported for the tests that assert what a send
 *  site asks the gate for. */
export async function initiationRequest(init: MarcelInitiation): Promise<InitiationRequest> {
  const { now, tz, ...rest } = init;
  return {
    owner: ownerId(),
    agent: MARCEL_AGENT,
    ...rest,
    now: now ?? new Date(),
    tz: tz ?? (await ownerTz()),
  };
}

/**
 * THE call. `const sent = await initiate("trip-lifecycle", { … }, async () => { …the send… })`.
 *
 * The callback is invoked only on a `send` verdict, and the ledger's `sent` row is written only
 * after it resolves (`gatedSend`'s own contract) — so a thrown send leaves the item eligible
 * rather than silently spent.
 *
 * Returns the gate's own verdict, not a boolean, because the two ways of being held back have
 * different consequences for the caller's local ledger: a `defer` comes back when its hold expires
 * and must stay eligible; a `suppress` is final (see `lib/trip-schedule.ts`'s `PostVerdict`).
 */
export async function initiate(
  schedule: string,
  init: MarcelInitiation,
  send: () => Promise<void>,
): Promise<InitiationVerdict> {
  // Missing identity is not a recoverable ledger outage. Never send unowned.
  ownerId();
  let req: InitiationRequest;
  let db;
  try {
    req = await initiationRequest(init);
    db = getPool();
  } catch (e) {
    // Only the wiring can fail here (no DATABASE_URL, a bad env) — `ownerTz` and `gatedSend` both
    // degrade internally. Fail OPEN, loudly, and name what is not being enforced.
    console.warn(
      `${schedule}: the proactivity gate could not be reached for ${init.itemKey} — sending UNGATED ` +
        "(no quiet hours, no DND, no ceiling, no dedupe)",
      e,
    );
    await send();
    return "send";
  }

  const decision = await gatedSend(db, req, send);
  logInitiation(schedule, decision, req.itemKey);
  return decision.verdict;
}
