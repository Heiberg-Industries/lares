/**
 * Reminder delivery — the eve schedule.
 *
 * Ported from `services/agent-runtime/lib/adapters/reminders/loop.ts`'s `makeReminderLoop`:
 * fetch due reminders, deliver each to its pinned door (re-routing through `fallbackDoor` when
 * the pinned door isn't registered or its send throws), re-arm any recurrence BEFORE marking
 * delivered (at-least-once — a crash between send and markDelivered may re-deliver, but a
 * recurrence is never silently lost), and let one delivery failure skip that row rather than
 * abort the tick.
 *
 * PROACTIVITY (ORB-193): every delivery passes `@lares/agent-kit`'s gate as a `scheduled`
 * initiation with `ownerSetTime: true` — see `ReminderTickDeps.gate` for why that exemption is the
 * whole point of a reminder. A held-back reminder stays `pending` (never re-armed, never marked
 * delivered), so it is reconsidered every tick and arrives when the gate reopens. The cost of that
 * shape, stated plainly: a long DND spell writes one suppressed ledger row per tick per reminder.
 * The alternative — dropping it — is the failure mode this whole ticket exists to avoid.
 *
 * DESIGN NOTE — verbatim delivery, not an agent turn:
 *
 * eve's documented proactive-send shape, `to(channel, target).send(text, { auth })`, STARTS OR
 * RESUMES AN AGENT SESSION with `text` as the prompt (`node_modules/eve/docs/channels/
 * overview.mdx`: "`send(address, input)` to start or resume a session"; `schedules.mdx`'s own
 * example passes an instruction — "Check for new critical alerts..." — not literal content).
 * That is architecturally different from the OLD system's loop, which posts a reminder's exact
 * text with no LLM involved at all. Global Constraints require a faithful port: what reaches
 * Bendik must be the reminder's own wording, not a model's paraphrase of it.
 *
 * The plan anticipated this tension and deferred it to execution time, pointing at the
 * bundled docs for "any more direct raw send primitive that bypasses the agent turn entirely".
 * One exists on BOTH channels already wired into this agent:
 *
 *   - Slack: `callSlackApi({ botToken, operation: "chat.postMessage", body })`, documented in
 *     `channels/slack.mdx` under "Slack API calls outside a handler" as the exact escape hatch
 *     for "a schedule ... [with] no inbound Slack request" — it names schedules explicitly.
 *   - Telegram: `sendTelegramMessage({ credentials, chatId, body })`, exported from
 *     `eve/channels/telegram` (`dist/.../telegram/api.d.ts`) — the same primitive the channel's
 *     own `ctx.telegram.sendMessage` calls internally, usable directly with no inbound context.
 *
 * Both are plain HTTP calls to the platform's send API: no session, no prompt, no model turn,
 * byte-exact text, deterministic, and cheaper/faster than a resumed session. This is strictly
 * better than the fallback the brief anticipated (a tightly-constrained "deliver verbatim, no
 * commentary" prompt to a resumed session) because it removes the LLM from the delivery path
 * entirely rather than merely instructing it not to editorialize — so it is used instead of
 * `to(...).send(...)` for real reminder delivery in this schedule.
 */
import { defineSchedule } from "eve/schedules";
import { callSlackApi } from "eve/channels/slack";
import { sendTelegramMessage } from "eve/channels/telegram";

import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { thisAgent } from "../../lib/definition.js";
import { recordSchedulePass } from "@lares/agent-kit/schedule-heartbeat";
import { nextOccurrence as defaultNextOccurrence } from "../../lib/recurrence.js";
import {
  createReminder,
  dueReminders,
  markDelivered,
  type DueReminder,
  type NewReminder,
} from "../../lib/reminders-store.js";
import { slackCredentials } from "../channels/slack.js";
import { telegramCredentials } from "../channels/telegram.js";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { emitSignal } from "../../lib/signal-emit.js";
import { primaryTelegramChatId } from "../../lib/principals.js";
import { initiateFor, SEND_UNGATED, type Initiate } from "../../lib/initiation.js";

// ─── Public types (mirrors services/agent-runtime/lib/adapters/reminders/loop.ts) ─────────

/** Door interface: each door can send a message to a threadRef. */
export interface ReminderDoor {
  send(o: { threadRef: string; text: string }): Promise<void>;
}

/** Minimal store contract for the tick (injectable / fakeable in tests). */
export interface ReminderTickStore {
  /** Return all pending reminders with due_at <= now. */
  due(now: Date): Promise<DueReminder[]>;
  /** Mark a reminder as delivered. */
  markDelivered(id: string): Promise<void>;
  /** Create a new pending reminder row (for re-arming recurring ones). */
  create(r: Pick<NewReminder, "agent" | "owner" | "dueAt" | "recurrence" | "payload" | "createdBy">): Promise<void>;
}

export interface ReminderTickDeps {
  store: ReminderTickStore;
  doors: Record<string, ReminderDoor>;
  clock?: () => Date;
  /** Override the nextOccurrence computation (injectable for tests). */
  nextOccurrence?: (recurrence: string, from: Date) => Date;
  /**
   * The agent's current live channel — used to re-route a reminder whose pinned door isn't
   * registered at all (e.g. any reminder pinned to "email", which simply has no entry in
   * `doors` — this agent never registers one) or whose send throws. Without this, such a
   * reminder stays `pending` forever.
   */
  fallbackDoor?: string;
  /**
   * Resolve the per-door "to Bendik" address. Needed for re-routing: the pinned door's
   * threadRef (e.g. a Slack channel id) is meaningless on the fallback door, so the target is
   * re-resolved for the fallback channel. Returns undefined when there's no address there.
   */
  resolveTarget?: (door: string) => string | undefined;
  /**
   * ORB-193 — the proactivity gate each delivery passes: `scheduled` class with
   * `ownerSetTime: true`, because the owner chose this minute himself. That exempts a reminder from
   * quiet hours (a 06:30 alarm is not an interruption) and from the attention ceilings, leaving DND
   * and already-seen — the two that mean "not now" whoever asked.
   *
   * Injected so this factory stays pure; the live wiring below always passes the real one.
   */
  gate?: Initiate;
}

export interface ReminderTick {
  tick(): Promise<void>;
}

// ─── Implementation ─────────────────────────────────────────────────────────────────────

/**
 * Builds the tick function. This is the whole delivery algorithm, kept as a pure factory over
 * injected deps so it is fully testable without a live Postgres, Slack, or Telegram — the
 * `default export` below wires it to the real store and real doors and is the only impure
 * part of this module.
 */
export function makeReminderTick(deps: ReminderTickDeps): ReminderTick {
  const {
    store,
    doors,
    clock = () => new Date(),
    nextOccurrence: computeNext = defaultNextOccurrence,
    fallbackDoor,
    resolveTarget,
    gate = SEND_UNGATED,
  } = deps;

  function fallbackTargetFor(door: string): string | undefined {
    if (!fallbackDoor || fallbackDoor === door) return undefined;
    if (!doors[fallbackDoor]) return undefined;
    return resolveTarget?.(fallbackDoor) ?? undefined;
  }

  /**
   * Deliver one reminder, re-routing to the fallback door if the pinned door is gone or its
   * send throws. Throws only when neither the pinned nor the fallback door can deliver — the
   * caller then leaves the row pending for the next tick.
   */
  async function send(id: string, door: string, threadRef: string, text: string): Promise<void> {
    const pinned = doors[door];
    if (pinned) {
      try {
        await pinned.send({ threadRef, text });
        return;
      } catch (err) {
        const fbTarget = fallbackTargetFor(door);
        if (!fbTarget) throw err;
        console.warn(`[reminders] door "${door}" send failed for ${id}; re-routing to "${fallbackDoor}"`);
        await doors[fallbackDoor!]!.send({ threadRef: fbTarget, text });
        return;
      }
    }
    // Pinned door not registered at all — this is the generic path an "email"-pinned (or any
    // other unregistered-door) reminder takes; there is no email-specific branch anywhere.
    const fbTarget = fallbackTargetFor(door);
    if (!fbTarget) throw new Error(`Unknown door "${door}" for reminder ${id}`);
    console.warn(`[reminders] door "${door}" unavailable for ${id}; re-routing to "${fallbackDoor}"`);
    await doors[fallbackDoor!]!.send({ threadRef: fbTarget, text });
  }

  async function deliverOne(reminder: DueReminder): Promise<void> {
    const { id, agent, owner, due_at, recurrence, payload } = reminder;
    const { text, door, threadRef } = payload;

    // ORB-193 — the PINNED door is what the ledger counts against: `<door>:<threadRef>`, which for
    // `slack`/`telegram` is byte-identical to `lib/principals.ts`'s `doorId(...)`, and for a door
    // this agent does not register (`email`) is still a stable, honest key rather than a lie about
    // which surface was used. The re-route inside `send` may land the text elsewhere; the DECISION
    // was made about the door the owner pinned.
    const initiation = await gate(
      { cls: "scheduled", door: `${door}:${threadRef}`, itemKey: `reminder/${id}`, ownerSetTime: true },
      () => send(id, door, threadRef, text),
    );
    if (!initiation.handled) {
      // A genuine HOLD (DND). NOT re-armed and NOT marked delivered: the row stays pending, so the
      // next tick reconsiders it and it lands the moment the gate reopens. A recurrence must never
      // be advanced past a delivery that did not happen.
      return;
    }
    // `handled` and not `sent` means ALREADY SEEN — a `sent` row for `reminder/<id>` exists, so the
    // text DID reach him; the only reason this row is due again is that `markDelivered` below failed
    // after that send (the at-least-once window the next comment describes). Falling through is what
    // closes it: the re-arm and the mark are exactly what should have happened then, and both are
    // idempotent-by-key. Treating it as a hold instead would leave the row pending FOREVER, re-firing
    // every minute against a gate that will suppress it every minute.

    // Re-arm BEFORE marking delivered (at-least-once semantics: a crash between send and
    // markDelivered may re-deliver, but the recurrence is never silently lost).
    if (recurrence) {
      const nextDueAt = computeNext(recurrence, due_at);
      await store.create({
        agent,
        owner,
        dueAt: nextDueAt,
        recurrence,
        payload,
        createdBy: "schedule:re-arm",
      });
    }

    await store.markDelivered(id);
  }

  return {
    async tick() {
      const now = clock();
      const due = await store.due(now);

      for (const reminder of due) {
        try {
          await deliverOne(reminder);
        } catch (err) {
          // One failure must not kill the tick. The row stays pending → retried next tick.
          console.error(`[reminders] failed to deliver reminder ${reminder.id}:`, err);
          await emitSignal(
            "reminder-delivery-failed",
            `reminders: failed to deliver reminder ${reminder.id}`,
            String(err),
          );
        }
      }
    },
  };
}

// ─── Live wiring ─────────────────────────────────────────────────────────────────────────

/** Raw Slack send — bypasses the agent turn entirely (see file header). */
export function slackDoor(): ReminderDoor {
  return {
    async send({ threadRef, text }) {
      const res = await callSlackApi({
        botToken: slackCredentials.botToken,
        operation: "chat.postMessage",
        body: { channel: threadRef, text },
      });
      if (!res.ok) throw new Error(`slack reminder send failed: ${String((res as { error?: unknown }).error)}`);
    },
  };
}

/** Raw Telegram send — bypasses the agent turn entirely (see file header). */
export function telegramDoor(): ReminderDoor {
  return {
    async send({ threadRef, text }) {
      await sendTelegramMessage({
        credentials: telegramCredentials,
        chatId: threadRef,
        body: { text },
        fetch: telegramFetch,
      });
    },
  };
}

/**
 * The fallback "to Bendik" address on Telegram — `lib/principals.ts`'s `primaryTelegramChatId`,
 * the first entry of the (comma-separated-list-shaped) `TELEGRAM_PRINCIPAL_ID`, read the same
 * lazy, per-call way every other secret/env read in this agent is (never cached at module
 * scope).
 */
export function liveResolveTarget(door: string): string | undefined {
  if (door !== "telegram") return undefined;
  return primaryTelegramChatId();
}

/** Wraps `lib/reminders-store.ts`'s pooled functions to the tick's minimal store contract. */
export function liveStore(): ReminderTickStore {
  const pool = getPool();
  return {
    due: (now) => dueReminders(pool, now),
    markDelivered: (id) => markDelivered(pool, id),
    create: async (r) => {
      await createReminder(pool, r);
    },
  };
}

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/reminders";

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "reminders")) return;
    try {
      const tick = makeReminderTick({
        store: liveStore(),
        doors: { slack: slackDoor(), telegram: telegramDoor() },
        fallbackDoor: "telegram",
        resolveTarget: liveResolveTarget,
        gate: initiateFor("reminders"),
      });
      await tick.tick();
      await recordSchedulePass(getPool(), HEARTBEAT_KEY);
    } catch (err) {
      // makeReminderTick/liveStore/getPool throwing before the per-reminder loop even starts
      // (e.g. a dead Postgres pool) — the loop above already signals per-reminder failures, so
      // this outer catch exists to route THAT class of failure to the spine too.
      console.error("[reminders] tick failed:", err);
      await emitSignal("schedule-tick-failed", "reminders: tick failed", String(err));
    }
  },
});
