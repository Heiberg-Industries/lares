/**
 * The weekly learning summary — Sunday at an hour that is a per-installation setting since
 * LAR-17-s3 (default 9; `packages/agent-kit/src/schedule-settings.ts`'s `weekly-summary` key,
 * no more env var), on the OWNER's clock (`Europe/Oslo` at home, so nothing moves on a normal
 * week — ORB-193). Ported from
 * `services/agent-runtime/bin/saga.ts`'s weekly-summary tick (~lines 1153-1192) and
 * `services/agent-runtime/lib/adapters/dream/weekly-input.ts`'s `buildWeeklySummaryInput`.
 *
 * `saga-dream` is a SIBLING CONTAINER that keeps running through and after this wave's cutover,
 * unaffected by it — its own nightly reflect→promote cycle writes into `dream_preferences` in
 * the SAME shared `lares_state` Postgres this service already connects to via `getPool()`
 * (`services/box/compose.yaml:263-265`'s own comment confirms this wiring was always the
 * plan). This schedule only READS that table (`lib/dream-store.ts`'s `activePreferences`) —
 * never writes it, never migrates it.
 *
 * GATE: `activePreferences()` empty → skip entirely, log why — nothing has been learned yet, so
 * there is nothing to summarize; the old lane's own "Nothing new learned yet" line was noise it
 * existed specifically to remove. Non-empty → build the prompt and send, using this wave's
 * established session-starting pattern (`to(telegram, { chatId }).send(prompt, { auth: { ...appAuth,
 * attributes: { lane: "weekly-summary" } } })`, same as `evening-brief.ts`/`morning-brief.ts`) —
 * NOT the old `runScheduledTurn`/threadRef mechanism. The `lane` attribute is what tells the
 * conversation-log hook this turn was machine-started, so it is never attributed to Bendik
 * (ORB-138; see `agent/hooks/turn-capture.ts`).
 *
 * No stamping or state tracking: `to().send()` doesn't expose reply text — the same API
 * limitation Task 11's `proposals-watch.ts` already accepted (see that file's own header) — and
 * there is nothing here to dedupe against. The gate is entirely `activePreferences().length ===
 * 0`; a send that throws is simply retried next Sunday, same as any other week with nothing new.
 *
 * `makeWeeklySummaryTick` follows `proposals-watch.ts`'s factory-over-injected-deps shape: pure
 * and fully testable without a live Postgres or channel: only the live wiring in `run()` below
 * (and the Sunday/hour slot gate, which is inherently real-clock) is impure.
 */
import { defineSchedule } from "eve/schedules";

import telegram from "../channels/telegram.js";
import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { thisAgent } from "../../lib/definition.js";
import { recordSchedulePass, recordScheduleTick } from "@lares/agent-kit/schedule-heartbeat";
import { dateIn, dowIn, slotIn } from "../../lib/recurrence.js";
import { activePreferences, type PreferenceRow } from "../../lib/dream-store.js";
import { emitSignal } from "../../lib/signal-emit.js";
import { doorId, ownerId, primaryTelegramChatId, telegramPushAttributes } from "../../lib/principals.js";
import { alreadySentToday, initiate, SAGA_AGENT } from "../../lib/initiation.js";
import { ownerTz } from "../../lib/owner-clock.js";
import { scheduleHours } from "../../lib/schedule-hours.js";

/** Sunday on the OWNER's clock (ORB-193), from the same `partsIn` date string the slot above
 *  comes off — one formatter, so the day and the hour cannot disagree. */
function isSunday(now: Date, tz: string): boolean {
  return dowIn(now, tz) === 0;
}

// ─── Prompt ─────────────────────────────────────────────────────────────────────────────────

/**
 * The weekly-summary turn's prompt text — ported from `weekly-input.ts`'s
 * `buildWeeklySummaryInput`: a "report, don't act" instruction, the active preferences listed,
 * and a request for a warm, under-150-word summary. Pure — given the active preferences
 * (already gathered by the caller), decide what belongs in the prompt. Never called with an
 * empty `prefs` — `makeWeeklySummaryTick` gates on that before reaching here.
 */
export function buildWeeklySummaryPrompt(prefs: Pick<PreferenceRow, "text">[]): string {
  const prefLines = prefs.map((p) => `- ${p.text}`).join("\n");

  return [
    "[scheduled turn — the weekly learning summary. This is not a message from a person; it is",
    "your cue to write it.]",
    "",
    "Active preferences learned about how he works this week:",
    prefLines,
    "",
    "Write a short, warm summary (under 150 words) of what you have learned this week, based",
    "ONLY on the preferences listed above. Plain prose. Cover only what is in the list above —",
    "no meta-commentary about your own operation, and nothing not grounded in that list.",
    // 2026-09-06: this arrived in English while every brief around it was Norwegian — the
    // preferences it summarises are stored in English and nothing here named a language.
    "Skriv på norsk (bokmål) — det er språket han leser briefene sine på.",
    "",
    // ORB-167 review fix — the same named prohibition both briefs carry. This turn is the app's
    // too, and the prompt above is a list of learned PREFERENCES, which is exactly the material
    // a model might otherwise decide to promote into standing facts in his voice.
    "This is a REPORT, not an action: take no action and propose nothing this turn — no emails,",
    "no drafts, no calendar changes, no reminders, no notes, no 👍 confirmation cards. Do not",
    "call `remember` or `forget` — he has said nothing on this turn, and a standing fact is only",
    "ever his own words.",
  ].join("\n");
}

// ─── Testable tick ──────────────────────────────────────────────────────────────────────────

/** Minimal store contract for the tick (injectable / fakeable in tests). */
export interface WeeklySummaryStore {
  activePreferences(): Promise<PreferenceRow[]>;
}

/** The door the tick speaks through — a single resumed-session send. */
export interface WeeklySummaryDoor {
  /**
   * `true` once eve has accepted and dispatched the send; throws if it did not go out.
   *
   * ORB-193 fix round 1 — `false` means the proactivity gate held it back (quiet hours, DND). The
   * pass is still COMPLETE either way (the schedule ran and did what the settings asked), but the
   * tick must not log "delivered" about a message nobody received, which is the whole failure class
   * this service keeps auditing itself for.
   */
  send(prompt: string): Promise<boolean>;
}

export interface WeeklySummaryDeps {
  store: WeeklySummaryStore;
  door: WeeklySummaryDoor;
}

/**
 * Builds the tick function. Pure factory over injected deps — fully testable without a live
 * Postgres or channel, and without depending on the real-clock Sunday/hour slot gate (which
 * `run()` below applies before ever reaching this).
 *
 * Resolves `true` for a completed pass — the quiet "nothing learned yet" path, or a delivered
 * summary — and `false` when `door.send` throws (a caught failure, not a completed pass).
 * `store.activePreferences()` throwing is NOT caught here — it propagates to `run()`'s own
 * catch, which already skips the heartbeat stamp for any thrown error (ORB-175 fix round 1).
 */
export function makeWeeklySummaryTick(deps: WeeklySummaryDeps): { tick(): Promise<boolean> } {
  const { store, door } = deps;
  return {
    async tick() {
      const prefs = await store.activePreferences();
      if (prefs.length === 0) {
        console.log("weekly-summary: skipped — nothing learned yet, so nothing to summarize");
        return true;
      }

      const prompt = buildWeeklySummaryPrompt(prefs);
      let sent: boolean;
      try {
        sent = await door.send(prompt);
      } catch (err) {
        console.error(`weekly-summary: send FAILED for ${prefs.length} active preference(s)`, err);
        return false;
      }

      // A completed pass either way — see `WeeklySummaryDoor.send`. Only the wording differs, and
      // it has to: "delivered" about a suppressed message is the lie, not the missing summary.
      console.log(
        sent
          ? `weekly-summary: delivered — ${prefs.length} active preference(s)`
          : `weekly-summary: held back by the proactivity gate — ${prefs.length} active preference(s) not summarised this week`,
      );
      return true;
    },
  };
}

// ─── Live wiring ────────────────────────────────────────────────────────────────────────────

function liveTelegramChatId(): string | undefined {
  return primaryTelegramChatId();
}

function liveStore(): WeeklySummaryStore {
  const pool = getPool();
  return { activePreferences: () => activePreferences(pool) };
}

let lastSlot: string | null = null;
let running = false;

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/weekly-summary";

export default defineSchedule({
  cron: "* * * * *",
  async run({ to, waitUntil, appAuth }) {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "weekly-summary")) return;
    await recordScheduleTick(getPool(), HEARTBEAT_KEY);
    const now = new Date();
    // The owner clock, resolved once per tick and cached for five minutes (lib/owner-clock.ts).
    const tz = await ownerTz();
    // LAR-17-s3 — the hour is a setting now, cached in-process for a few minutes
    // (lib/schedule-hours.ts) so this per-minute tick does not query Postgres.
    const [hour] = await scheduleHours("weekly-summary");
    const slot = slotIn(now, tz, hour);
    if (!slot || slot === lastSlot) return;      // not in slot, or already fired this week
    if (!isSunday(now, tz)) return;
    if (running) return;                          // previous turn still running

    lastSlot = slot;
    running = true;
    try {
      const pool = getPool();

      // LAR-17-s4 — the same belt the two briefs wear (`lib/initiation.ts`'s `alreadySentToday`):
      // the hour can change MID-DAY now, and the ledger's dedupe is keyed on the SLOT
      // (`weekly-summary/<owner date>T<hour>`), not the day — a hour moved after this week's
      // summary already sent would give the new hour's tick a BRAND NEW key nobody has seen, and
      // the gate would happily send a second one. Checked before any gathering below, same as
      // the briefs.
      const ownerToday = dateIn(now, tz);
      if (await alreadySentToday(pool, ownerId(), SAGA_AGENT, "weekly-summary", ownerToday)) {
        console.log(
          `weekly-summary: already sent today (${ownerToday}) — skipping slot ${slot} ` +
          "(the hour setting changed after this week's summary went out)",
        );
        await recordSchedulePass(pool, HEARTBEAT_KEY);
        return;
      }

      const chatId = liveTelegramChatId();
      if (!chatId) {
        console.warn("weekly-summary: no TELEGRAM_PRINCIPAL_ID configured; skipping");
        return;
      }

      const door: WeeklySummaryDoor = {
        async send(prompt) {
          // ORB-193 — a `scheduled` initiation keyed on the slot. There is nothing per-item to
          // finish here, so `sent` (not `handled`) is the honest answer: an already-sent slot did
          // not deliver anything on THIS call either.
          const initiation = await initiate(
            "weekly-summary",
            { cls: "scheduled", door: doorId("telegram", chatId), itemKey: `weekly-summary/${slot}`, now, tz },
            async () => {
              const task = to(telegram, { chatId }).send(prompt, { auth: { ...appAuth, attributes: telegramPushAttributes("weekly-summary", chatId) } });
              waitUntil(task);
              await task;
            },
          );
          return initiation.sent;
        },
      };

      const completed = await makeWeeklySummaryTick({ store: liveStore(), door }).tick();
      if (completed) await recordSchedulePass(getPool(), HEARTBEAT_KEY);
    } catch (e) {
      console.error("weekly-summary: tick failed", e);
      await emitSignal("schedule-tick-failed", "weekly-summary: tick failed", String(e));
    } finally {
      running = false;
    }
  },
});
