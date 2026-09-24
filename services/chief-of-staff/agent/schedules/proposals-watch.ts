/**
 * Notion + Atlas proposal announcements — the eve schedule.
 *
 * Ported from `services/agent-runtime/bin/saga.ts`'s `proposalsTick`/`atlasProposalsTick`
 * (~lines 906-1123): poll each store for proposals nobody has been told about
 * (`announced_at IS NULL`), tell Bendik in ONE turn per lane covering everything new (not
 * one message per proposal), then stamp `announced_at` only after the message actually went
 * out. Two independent lanes, not merged — different tables, different cadences, different
 * failure blast radius (the old system's own reasoning, preserved here): a failure
 * announcing or stamping Notion proposals must never block the Atlas lane, or vice versa.
 *
 * DESIGN NOTE — a real agent turn, unlike `reminders.ts`:
 *
 * `reminders.ts` deliberately bypasses eve's session-starting `to(...).send(...)` for raw
 * HTTP sends, because a reminder's exact text must reach Bendik byte-for-byte with no LLM
 * involved. This schedule is the opposite case: the whole point of announcing a proposal is
 * for the agent to look at what's open and be ready to ACT on it — specifically, to call the
 * gated `notion_resolve_proposal`/`atlas_resolve_proposal` tool once Bendik responds, which
 * is what renders eve's inline-keyboard approval card (the eve-native replacement for the
 * old system's Telegram `np:a:`/`np:r:`/`ap:a:`/`ap:r:` buttons — see those tools' own
 * headers). That requires an actual resumed agent session, so this uses eve's documented
 * handler-form pattern verbatim (`node_modules/eve/docs/schedules.mdx`'s own example):
 * `to(telegram, { chatId }).send(prompt, { auth: appAuth })`.
 *
 * One consequence of using the documented session-send API instead of the old system's
 * `runScheduledTurn`: that old call returned the turn's reply text, so the old ticks could
 * treat a non-empty reply as proof Bendik was actually told (`bin/saga.ts`'s own comment:
 * "A NON-EMPTY reply is the only proof he was actually told"). `to(...).send()` resolves to
 * an eve `Session`, not reply text — the framework does not expose that proof through this
 * API. This tick uses the next-best signal it has: `door.send()` resolving without throwing.
 * That is weaker than the old check (a session that starts but never sends a visible message
 * would still count as "delivered" here) but is the strongest signal the documented surface
 * gives, and it preserves the property that actually matters for the defect class this
 * schedule exists to avoid: a THROWN send never stamps `announced_at`, so a proposal whose
 * announce genuinely failed to dispatch is retried on the next tick rather than rotting
 * unseen.
 */
import { defineSchedule } from "eve/schedules";
import { sendTelegramMessage } from "eve/channels/telegram";

import { telegramCredentials } from "../channels/telegram.js";
import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { thisAgent } from "../../lib/definition.js";
import { recordSchedulePass } from "@lares/agent-kit/schedule-heartbeat";
import {
  getUnannouncedAtlasProposals,
  getUnannouncedMemoryProposals,
  getUnannouncedProposals,
  markAtlasProposalAnnounced,
  markMemoryProposalAnnounced,
  markProposalAnnounced,
  type AtlasUnannouncedRow,
  type MemoryProposalRow,
  type ProposalRow,
} from "../../lib/proposals-store.js";
import { emitSignal } from "../../lib/signal-emit.js";
import { doorId, primaryTelegramChatId } from "../../lib/principals.js";
import { initiateTo, SEND_UNGATED, type DoorInitiate, type InitiationOutcome } from "../../lib/initiation.js";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import {
  buildNotionAnnouncement,
  buildAtlasAnnouncement,
  buildMemoryAnnouncement,
  type Announcement,
} from "../../lib/proposal-buttons.js";

// ─── Public types ───────────────────────────────────────────────────────────────────────

/** Minimal store contract for the tick (injectable / fakeable in tests). */
export interface ProposalsWatchStore {
  notionUnannounced(): Promise<ProposalRow[]>;
  notionMarkAnnounced(id: number): Promise<void>;
  atlasUnannounced(): Promise<AtlasUnannouncedRow[]>;
  atlasMarkAnnounced(id: number): Promise<void>;
  /** The memory lane (W4C-s5): a change to something the owner told the agent, waiting on
   *  their decision. Same contract as the two above; what differs is the announcement, which
   *  carries no buttons — see `lib/proposal-buttons.ts`'s `buildMemoryAnnouncement`. */
  memoryUnannounced(): Promise<MemoryProposalRow[]>;
  memoryMarkAnnounced(id: number): Promise<void>;
}

/**
 * The one door both lanes speak through. Since the 2026-08-16 one-tap restoration this is
 * a RAW per-proposal send (deterministic text + inline Approve/Reject buttons — see
 * `lib/proposal-buttons.ts`), not an agent turn: no billed model call per announcement,
 * and each proposal's buttons are its own. Resolves once Telegram accepted the message;
 * throws if it did not go out (the lane then leaves the proposal unstamped and retries).
 */
export interface ProposalsWatchDoor {
  announce(a: Announcement): Promise<void>;
}

export interface ProposalsWatchDeps {
  store: ProposalsWatchStore;
  door: ProposalsWatchDoor;
  /**
   * ORB-193 — the proactivity gate each announcement passes (`event` class: a proposal is a thing
   * that happened, keyed on its own durable id). Injected so this factory stays pure and its unit
   * tests keep running with no ledger; the live wiring below always passes the real one.
   */
  gate?: DoorInitiate;
}

/**
 * Single-flight state, held OUTSIDE the tick closure and passed in — module-scope live
 * wiring reuses one instance across every cron fire (matching `bin/saga.ts`'s persistent
 * `let proposalsRunning`/`atlasProposalsRunning`), while tests construct their own per case.
 */
export interface ProposalsWatchState {
  notionRunning: boolean;
  atlasRunning: boolean;
  memoryRunning: boolean;
}

export function freshState(): ProposalsWatchState {
  return { notionRunning: false, atlasRunning: false, memoryRunning: false };
}

export interface ProposalsWatchTick {
  /** Resolves `true` only when EVERY lane completes its pass; `false` if any lane's outer catch
   *  swallowed a failure or was still running from a previous call. ORB-175 fix round 1. */
  tick(): Promise<boolean>;
}

// ─── Prompts ────────────────────────────────────────────────────────────────────────────

/** First non-empty line of a diff preview, truncated — the "one-line summary" the prompt
 *  gives per proposal. The full diff and the exact consequence sentence live behind
 *  notion_proposals/atlas_proposals, which the prompt tells the model to call. */
function summaryLine(text: string, max = 160): string {
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line || "(no preview captured)";
}

export function buildNotionProposalsPrompt(rows: ProposalRow[]): string {
  const lines = rows.map((p) => {
    const what = p.kind === "create" ? `NEW FILE ${p.vaultPath}` : p.vaultPath;
    return `#${p.id} — ${what}: ${summaryLine(p.diffPreview)}`;
  });
  return [
    "[scheduled check — Notion proposals. This is not a message from a person; it is your cue",
    "to tell him what is waiting.]",
    "",
    `${rows.length} Notion→vault proposal(s) are newly open:`,
    "",
    lines.join("\n"),
    "",
    "Tell Bendik about these now. Call notion_proposals first — it has the full diff and each",
    "proposal's own approve/reject consequence sentence; quote that sentence rather than",
    "guessing, the three possible outcomes are NOT the same for every proposal.",
    "",
    "YOU PRESENT, HE DECIDES: do not call notion_resolve_proposal in this turn. When he",
    "replies with a decision — now or later in this conversation — call",
    "notion_resolve_proposal with the id and decision; that is what renders his approval card.",
  ].join("\n");
}

export function buildAtlasProposalsPrompt(rows: AtlasUnannouncedRow[]): string {
  const lines = rows.map((p) => {
    const brand = p.brand ? `${p.brand} — ` : "";
    return `#${p.id} — ${brand}${p.notePath}: ${summaryLine(p.diffPreview)}`;
  });
  return [
    "[scheduled check — Atlas proposals. This is not a message from a person; it is your cue",
    "to tell him what is waiting.]",
    "",
    `${rows.length} Atlas proposal(s) are newly open — a venture note whose narrative has`,
    "been re-derived from its sources:",
    "",
    lines.join("\n"),
    "",
    "Tell Bendik about these now. Call atlas_proposals first — it has the full diff and each",
    "proposal's own approve/reject consequence sentence; quote that sentence rather than",
    "guessing.",
    "",
    "YOU PRESENT, HE DECIDES: do not call atlas_resolve_proposal in this turn. When he replies",
    "with a decision — now or later in this conversation — call atlas_resolve_proposal with",
    "the id and decision; that is what renders his approval card.",
  ].join("\n");
}

// ─── Implementation ─────────────────────────────────────────────────────────────────────

/**
 * Builds the tick function. Pure factory over injected deps, fully testable without a live
 * Postgres or channel — the live wiring at the bottom is the only impure part.
 */
/** Once per process, not once per minute — see `memoryLane`'s catch. */
let warnedNoMemoryQueue = false;

export function makeProposalsWatchTick(
  deps: ProposalsWatchDeps,
  state: ProposalsWatchState = freshState(),
): ProposalsWatchTick {
  const { store, door, gate = SEND_UNGATED } = deps;

  /** Resolves `true` for a completed lane pass (nothing pending, or the batch was walked —
   *  per-proposal send/stamp failures are caught individually and still count as completed) and
   *  `false` when the OUTER catch swallowed the whole lane or a previous run of this lane is
   *  still in flight. ORB-175 fix round 1. */
  async function notionLane(): Promise<boolean> {
    if (state.notionRunning) return false; // previous turn still running
    state.notionRunning = true;
    try {
      const pending = await store.notionUnannounced();
      if (pending.length === 0) return true;

      for (const p of pending) {
        let initiation: InitiationOutcome;
        try {
          // ORB-193 — one `event` initiation per proposal, keyed on the proposal's own row id.
          initiation = await gate(
            { cls: "event", itemKey: `proposal/notion/${p.id}` },
            () => door.announce(buildNotionAnnouncement(p)),
          );
        } catch (err) {
          // Leaving announced_at NULL is the whole point — the next tick retries THIS one;
          // later proposals in the batch still get their own attempt.
          console.error(
            `proposals-watch: notion announce FAILED for proposal ${p.id} — ` +
              "leaving it unannounced for the next tick",
            err,
          );
          continue;
        }
        // A genuine HOLD: `announced_at` stays NULL, exactly as for a failed send — a proposal he
        // was not told about must stay tellable.
        //
        // ALREADY SEEN falls through to the stamp instead (fix round 1, CRITICAL): a `sent` row for
        // `proposal/notion/<id>` proves the card with its Approve/Reject buttons reached his chat,
        // so the only thing left undone is the `announced_at` write that failed last time. Held
        // "eligible", this proposal would be re-picked by `notionUnannounced` on every tick and
        // suppressed on every tick — the hourly nag this system has already been bitten by
        // (`project_notion_sync_rejected_create_loop`).
        if (!initiation.handled) continue;
        if (initiation.sent) {
          await emitSignal("proposal-offered", "Saga offered a Notion proposal", undefined, {
            kind: "event", severity: "info", key: "notion",
          });
        }
        await store.notionMarkAnnounced(p.id).catch((err) => {
          // Stamping failed AFTER he was told: he hears about this one twice. That is the
          // right way round — better a repeat than a proposal that rots unseen.
          console.error(`proposals-watch: could not stamp announced_at for notion proposal ${p.id}`, err);
        });
      }
      return true;
    } catch (err) {
      // UNMIGRATED/UNREACHABLE DB IS A NO-OP: this lane must survive a store error without
      // taking the schedule (or the atlas lane) down with it.
      console.error("proposals-watch: notion lane failed", err);
      await emitSignal("schedule-tick-failed", "proposals-watch: notion lane failed", String(err));
      return false;
    } finally {
      state.notionRunning = false;
    }
  }

  /** Same contract as `notionLane` above, for the Atlas lane. */
  async function atlasLane(): Promise<boolean> {
    if (state.atlasRunning) return false; // previous turn still running
    state.atlasRunning = true;
    try {
      const pending = await store.atlasUnannounced();
      if (pending.length === 0) return true;

      for (const p of pending) {
        let initiation: InitiationOutcome;
        try {
          // ORB-193 — one `event` initiation per proposal, keyed on the proposal's own row id.
          initiation = await gate(
            { cls: "event", itemKey: `proposal/atlas/${p.id}` },
            () => door.announce(buildAtlasAnnouncement(p)),
          );
        } catch (err) {
          console.error(
            `proposals-watch: atlas announce FAILED for proposal ${p.id} — ` +
              "leaving it unannounced for the next tick",
            err,
          );
          continue;
        }
        if (!initiation.handled) continue; // held back — see the notion lane's own note
        if (initiation.sent) {
          await emitSignal("proposal-offered", "Saga offered an Atlas proposal", undefined, {
            kind: "event", severity: "info", key: "atlas",
          });
        }
        await store.atlasMarkAnnounced(p.id).catch((err) => {
          console.error(`proposals-watch: could not stamp announced_at for atlas proposal ${p.id}`, err);
        });
      }
      return true;
    } catch (err) {
      console.error("proposals-watch: atlas lane failed", err);
      await emitSignal("schedule-tick-failed", "proposals-watch: atlas lane failed", String(err));
      return false;
    } finally {
      state.atlasRunning = false;
    }
  }

  /** Same contract as the two lanes above, for memory changes waiting on the owner (W4C-s5).
   *  It ANNOUNCES ONLY. Unlike Notion and Atlas, the announcement carries no Approve/Reject
   *  buttons: applying a memory change re-reads the standing row inside the transaction that
   *  writes it and refuses if that row has moved since, which a one-tap callback has nowhere to
   *  report. The owner replies in words and the gated `memory_resolve_proposal` tool does the
   *  rest — the single path that ever applies one. */
  async function memoryLane(): Promise<boolean> {
    if (state.memoryRunning) return false; // previous turn still running
    state.memoryRunning = true;
    try {
      const pending = await store.memoryUnannounced();
      if (pending.length === 0) return true;

      for (const p of pending) {
        let initiation: InitiationOutcome;
        try {
          initiation = await gate(
            { cls: "event", itemKey: `proposal/memory/${p.id}` },
            () => door.announce(buildMemoryAnnouncement(p)),
          );
        } catch (err) {
          console.error(
            `proposals-watch: memory announce FAILED for proposal ${p.id} — ` +
              "leaving it unannounced for the next tick",
            err,
          );
          continue;
        }
        if (!initiation.handled) continue; // held back — see the notion lane's own note
        if (initiation.sent) {
          await emitSignal("proposal-offered", "a memory change is waiting for the owner", undefined, {
            kind: "event", severity: "info", key: "memory",
          });
        }
        await store.memoryMarkAnnounced(p.id).catch((err) => {
          console.error(`proposals-watch: could not stamp announced_at for memory proposal ${p.id}`, err);
        });
      }
      return true;
    } catch (err) {
      // AN INSTALLATION WITHOUT THE QUEUE IS NOT A FAILURE. This poll runs every minute; a box
      // that has not applied services/box/sql/072_memory_proposals.sql would otherwise report a
      // failed tick forever, never record a schedule pass, and bury the two lanes that ARE
      // working under a permanent red. There is nothing waiting, because there is nowhere for
      // anything to wait — so the pass is complete, with one warning saying what to apply.
      if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42P01") {
        if (!warnedNoMemoryQueue) {
          warnedNoMemoryQueue = true;
          console.warn(
            "proposals-watch: this installation has no memory_proposals table, so memory " +
              "changes cannot be put to the owner. Apply services/box/sql/072_memory_proposals.sql " +
              "to switch that lane on.",
          );
        }
        return true;
      }
      console.error("proposals-watch: memory lane failed", err);
      await emitSignal("schedule-tick-failed", "proposals-watch: memory lane failed", String(err));
      return false;
    } finally {
      state.memoryRunning = false;
    }
  }

  return {
    async tick() {
      // Sequential, not concurrent: both lanes send through the SAME door/target (one
      // Telegram chat), and two session-starting sends racing each other against the same
      // chat is not a scenario eve's docs describe. Sequencing costs nothing here — proposal
      // volume is low and this is a ~1 min poll, not a latency-sensitive path — while keeping
      // each lane's own try/catch is what stops one lane's failure from touching the other's
      // announcement or stamp.
      //
      // ORB-175 fix round 1 (controller ruling): the combined pass is complete only when BOTH
      // lanes complete — a lane's own outer-catch failure (or overlap guard) must not be
      // masked by the other lane's success, or the heartbeat would read a half-failed tick as
      // healthy. Both awaits already run sequentially (see the comment above), so the boolean
      // combine below never short-circuits atlasLane() away on a notion failure.
      const notionOk = await notionLane();
      const atlasOk = await atlasLane();
      const memoryOk = await memoryLane();
      return notionOk && atlasOk && memoryOk;
    },
  };
}

// ─── Live wiring ─────────────────────────────────────────────────────────────────────────

/** Bendik's Telegram chat id — `lib/principals.ts`'s `primaryTelegramChatId`, same as
 *  `agent/schedules/reminders.ts`'s `liveResolveTarget`. */
function liveTelegramChatId(): string | undefined {
  return primaryTelegramChatId();
}

function liveStore(): ProposalsWatchStore {
  const pool = getPool();
  return {
    notionUnannounced: () => getUnannouncedProposals(pool),
    notionMarkAnnounced: (id) => markProposalAnnounced(pool, id),
    atlasUnannounced: () => getUnannouncedAtlasProposals(pool),
    atlasMarkAnnounced: (id) => markAtlasProposalAnnounced(pool, id),
    memoryUnannounced: () => getUnannouncedMemoryProposals(pool),
    memoryMarkAnnounced: (id) => markMemoryProposalAnnounced(pool, id),
  };
}

/** Persists across cron fires within the same warm process — see ProposalsWatchState. */
const liveState = freshState();

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/proposals-watch";

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "proposals-watch")) return;

    const chatId = liveTelegramChatId();
    if (!chatId) {
      console.warn("proposals-watch: no TELEGRAM_PRINCIPAL_ID configured; skipping");
      return;
    }

    const door: ProposalsWatchDoor = {
      async announce(a) {
        await sendTelegramMessage({
          credentials: telegramCredentials,
          chatId,
          body: { text: a.text, parse_mode: a.parseMode, reply_markup: a.replyMarkup } as never,
          fetch: telegramFetch,
        });
      },
    };

    const tick = makeProposalsWatchTick(
      { store: liveStore(), door, gate: initiateTo("proposals-watch", doorId("telegram", chatId)) },
      liveState,
    );
    const completed = await tick.tick();
    if (completed) await recordSchedulePass(getPool(), HEARTBEAT_KEY);
  },
});
