/**
 * CRM routing — Oslo 09/13/17 by default; a per-installation setting since LAR-17-s3
 * (`packages/agent-kit/src/schedule-settings.ts`'s `crm-routing` key — no more env var). Scans
 * Twenty for contacts with new
 * meetings/emails since the last scan, classifies which brand pipeline + stage they belong
 * in, and — per newly-proposed signal — sends a Slack session-start prompt instructing the
 * resumed session to call the already-gated `twenty_create_opportunity`/`twenty_set_stage`
 * tool (Task 5). Those tools are `approval: always()`, so calling one immediately renders
 * Bendik's 👍/👎 approval card — **the same surface as today's cards**, replacing the old
 * runtime's `proposeOutbound` mechanism entirely (this schedule never calls a write tool
 * itself; it only asks the resumed session to).
 *
 * Ported from `services/agent-runtime/bin/saga.ts`'s `routeTick` (~lines 1205-1280), which
 * wires together `lib/adapters/route/engine.ts` (→ `lib/route-engine.ts`),
 * `.../classify.ts` (→ `lib/route-classify.ts`), and `.../store.ts` (→ `lib/route-store.ts`).
 *
 * TIMEZONE / SLOT MATCHING: same "poll every minute, gate on Europe/Oslo wall-clock time"
 * shape `evening-brief.ts`/`morning-brief.ts`/`weekly-summary.ts` use, generalised to a LIST
 * of hours (09, 13, 17) rather than one — this is a fixed multi-slot cron like the briefs,
 * not a plain interval like `reping.ts`.
 *
 * DELIVERY ORDER — send BEFORE record, deliberately: `route_proposals` has no separate
 * "announced" ledger the way Notion/Atlas proposals do (Task 11) — a row's mere existence IS
 * the permanent dedup key (`alreadyProposed`). Recording before a send that then fails would
 * silently and PERMANENTLY drop that proposal (every future scan would see it as
 * already-proposed and never re-surface it) — worse than the risk it would guard against.
 * Recording only after a confirmed send matches Task 11's own rule ("a THROWN send never
 * stamps"), and each proposal gets its own try/catch so one failure never blocks the rest of
 * the batch (an improvement on the old `bin/saga.ts` tick, whose single try/catch around the
 * whole loop meant one bad send aborted every remaining proposal in that tick too).
 *
 * The engine's own cursor advance happens INSIDE `scan()`, unconditionally, before this
 * schedule ever sees a proposal — so a signal that fails to send is not retried on the next
 * scan either way (`route-engine.ts`'s own "prefer-drop-over-double-nag" comment). Send-then
 * -record does not change that; it only avoids ALSO burning the dedup key on a proposal
 * nobody was actually told about.
 */
import { defineSchedule } from "eve/schedules";

import slack from "../channels/slack.js";
import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { thisAgent } from "../../lib/definition.js";
import { recordSchedulePass, recordScheduleTick } from "@lares/agent-kit/schedule-heartbeat";
import { slotIn } from "../../lib/recurrence.js";
import { doorId } from "../../lib/principals.js";
import { initiateTo, SEND_UNGATED, type DoorInitiate, type InitiationOutcome } from "../../lib/initiation.js";
import { ownerTz } from "../../lib/owner-clock.js";
import { scheduleHours } from "../../lib/schedule-hours.js";
import { configuredOwnerId, listAliases, listOrgDomains } from "../../lib/identity-client.js";
import { allowedSlackUserIds } from "../../lib/slack-allowlist.js";
import { ensureRouteTables, makeRouteStore, type RouteProposalInput } from "../../lib/route-store.js";
import { makeRouteTwentyClient } from "../../lib/route-twenty.js";
import { makeRouteClassifier } from "../../lib/route-classify.js";
import { makeRouteEngine, type RouteProposal } from "../../lib/route-engine.js";
import { gatewayComplete } from "../../lib/llm-complete.js";
import { emitSignal } from "../../lib/signal-emit.js";

/**
 * A slot key for the current minute across MULTIPLE hours, or null when `now` is not exactly one of
 * `hours`:00 on `tz`'s wall clock. The single-hour case is `lib/recurrence.ts`'s `slotIn`, which
 * this delegates to so every slot in the fleet comes off one formatter.
 *
 * ORB-193 — `tz` is the OWNER's timezone, resolved per tick (`ownerTz()`). At home it is
 * `Europe/Oslo` and the route hours are the ones they have always been; `hours` keeps its position.
 */
export function dueRouteSlot(now: Date, tz: string, hours: number[]): string | null {
  for (const hour of hours) {
    const slot = slotIn(now, tz, hour);
    if (slot) return slot;
  }
  return null;
}

// ─── Prompt ─────────────────────────────────────────────────────────────────────────────────

/** The per-proposal turn prompt — describes the proposed CRM move and tells the model which
 *  gated tool call renders the approval card. Pure — one proposal in, one prompt out. */
export function buildRouteProposalPrompt(p: RouteProposal): string {
  const actionLabel = p.action === "create" ? "create a NEW opportunity" : "move the EXISTING opportunity";
  const toolLine = p.action === "create"
    ? `Then call twenty_create_opportunity with { name: "${p.brand} — ${p.personName}", stage: "${p.stage}", brand: "${p.brand}", pointOfContactId: "${p.personId}" }.`
    : `Then call twenty_set_stage with { opportunityId: "${p.opportunityId}", stage: "${p.stage}" }.`;

  return [
    "[scheduled check — CRM routing. This is not a message from a person; it is your cue to",
    "propose a pipeline move based on recent activity.]",
    "",
    `New signal for ${p.personName} <${p.personHandle}> (CRM person ${p.personId}):`,
    `- Brand: ${p.brand}`,
    `- Proposed stage: ${p.stage}`,
    `- Action: ${actionLabel}`,
    `- Confidence: ${Math.round(p.confidence * 100)}%`,
    `- Why: ${p.reasoning}`,
    "",
    "First post ONE short plain-language sentence telling Bendik who this is and what you",
    `propose — e.g. "${p.personName} has been ${p.reasoning ? `active (${p.reasoning})` : "active recently"} — I suggest we ${actionLabel.toLowerCase()} at ${p.stage}."`,
    "No JSON, no tool names, no ids in that sentence — the approval card below it carries the",
    "technical detail.",
    "",
    toolLine,
    "That tool is gated (`approval: always()`), so calling it renders his 👍/👎 approval",
    "card directly under your sentence — do not wait for a reply first, the tool call itself",
    "is the ask.",
    "",
    "If the activity above does not actually support this move, reply with at most ONE short sentence",
    "saying so and stop — no analysis, no bullets, no offers to draft or look things up. Do not call",
    "the tool. Bendik reads these every morning; a decline should cost him one line.",
  ].join("\n");
}

// ─── Testable tick ──────────────────────────────────────────────────────────────────────────

export interface CrmRoutingEngine {
  scan(): Promise<RouteProposal[]>;
}

/** The store surface the tick needs — just the write half; dedup reads
 *  (`alreadyProposed`/cursor) stay inside the engine. */
export interface CrmRoutingStore {
  recordProposal(input: RouteProposalInput): Promise<{ id: string }>;
}

/** The door the tick speaks through — one resumed-session send per proposal. */
export interface CrmRoutingDoor {
  /** Resolves once eve has accepted and dispatched the send; throws if it did not go out. */
  send(prompt: string): Promise<void>;
}

export interface CrmRoutingDeps {
  engine: CrmRoutingEngine;
  store: CrmRoutingStore;
  door: CrmRoutingDoor;
  /**
   * ORB-193 — the proactivity gate each proposal's send passes (`event` class: a proposal is a
   * thing that happened, not a slot). Injected so this factory stays pure and its unit tests keep
   * running with no ledger; the live wiring below always passes the real one.
   */
  gate?: DoorInitiate;
}

/** Single-flight + once-per-slot state, held OUTSIDE the tick closure — module-scope live
 *  wiring reuses one instance across every cron fire (matching `evening-brief.ts`'s
 *  `lastSlot`/`running`), while tests construct their own per case. */
export interface CrmRoutingState {
  lastSlot: string | null;
  running: boolean;
}

export function freshState(): CrmRoutingState {
  return { lastSlot: null, running: false };
}

export interface CrmRoutingTick {
  /** `now`/`hours`/`tz` are explicit arguments (not baked into deps) so a test can drive the
   *  once-per-slot-hour gate directly, across many simulated clock ticks, without a real
   *  timer or a live Postgres/Twenty/Slack.
   *
   *  Resolves `true` for a completed scan pass (delivered proposals or none) and `false` when
   *  this call did no pass at all — not in slot, already fired this slot, a previous scan still
   *  running, or the outer catch swallowed a thrown failure. ORB-175 fix round 1: only `true`
   *  may stamp the schedule's heartbeat. */
  tick(now: Date, hours: number[], tz: string): Promise<boolean>;
}

/**
 * Builds the tick function. Pure factory over injected deps — fully testable without a live
 * Postgres, Twenty, or Slack: only the live wiring in `run()` below (and the real-clock slot
 * gate, which is inherently real-clock) is impure.
 */
export function makeCrmRoutingTick(
  deps: CrmRoutingDeps,
  state: CrmRoutingState = freshState(),
): CrmRoutingTick {
  const { engine, store, door, gate = SEND_UNGATED } = deps;
  return {
    async tick(now, hours, tz) {
      const slot = dueRouteSlot(now, tz, hours);
      if (!slot || slot === state.lastSlot) return false; // not in slot, or already fired this slot
      if (state.running) return false;                     // previous scan still running

      state.lastSlot = slot;
      state.running = true;
      try {
        const proposals = await engine.scan();
        let delivered = 0;

        for (const p of proposals) {
          if (p.mode !== "confirm") continue; // v1: all are confirm; "auto" is the graduation hook

          let initiation: InitiationOutcome;
          try {
            // ORB-193 — one `event` initiation per proposal, keyed on the SIGNAL that produced it:
            // the proposal row does not exist yet (it is written below, after the send), and the
            // signal ref is the durable id the engine's own dedupe already keys on.
            initiation = await gate(
              { cls: "event", itemKey: `crm-routing/${p.signalRef}`, now, tz },
              () => door.send(buildRouteProposalPrompt(p)),
            );
          } catch (err) {
            console.error(
              `crm-routing: send FAILED for ${p.personHandle} (${p.brand} ▸ ${p.stage}, slot ${slot}) — ` +
              "not recorded; the cursor has already advanced past this signal, so it will not be retried",
              err,
            );
            continue;
          }
          // A genuine HOLD: NOT recorded, deliberately — the same posture as a failed send one line
          // up, so nothing is marked as told-about that he was not told. ALREADY SEEN falls through
          // to `recordProposal` instead (fix round 1): a `sent` row for this signal proves the
          // proposal reached his DM, and the row below is the record of that, not a second telling.
          if (!initiation.handled) continue;

          try {
            await store.recordProposal({
              personId: p.personId,
              opportunityId: p.opportunityId ?? undefined,
              brand: p.brand,
              proposedStage: p.stage,
              signalRef: p.signalRef,
              confidence: p.confidence,
            });
            delivered += 1;
          } catch (err) {
            // Sent but not recorded: he hears about this one twice at worst (a future scan
            // may re-propose the same signal). Better a repeat than a silently unrecorded row.
            console.error(
              `crm-routing: could not record proposal for ${p.personHandle} AFTER a successful send`,
              err,
            );
          }
        }

        if (delivered > 0) {
          console.log(`crm-routing: delivered ${delivered} proposal(s) (slot ${slot})`);
        }
        return true;
      } catch (err) {
        console.error("crm-routing: tick failed", err);
        await emitSignal("schedule-tick-failed", "crm-routing: tick failed", String(err));
        return false;
      } finally {
        state.running = false;
      }
    },
  };
}

// ─── Live wiring ────────────────────────────────────────────────────────────────────────────

/** Bendik's Slack user id, reused as the DM channel id — Slack's `chat.postMessage` opens
 *  (or reuses) the DM when `channel` is a user id. Same convention as
 *  `agent/tools/digest_run.ts`'s `allowedSlackUserIds()[0]`. */
function liveSlackChannelId(): string | undefined {
  return allowedSlackUserIds()[0];
}

let tablesEnsured = false;

/** Persists across cron fires within the same warm process — see CrmRoutingState. */
const liveState = freshState();

/** ORB-175 — the row input-freshness.sh reads; pinned to this filename by the conformance test. */
export const HEARTBEAT_KEY = "saga/crm-routing";

export default defineSchedule({
  cron: "* * * * *",
  async run({ to, waitUntil, appAuth }) {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "crm-routing")) return;
    await recordScheduleTick(getPool(), HEARTBEAT_KEY);

    const now = new Date();
    // The owner clock first, because the slot cannot be computed without it. It is NOT a round trip
    // per tick: `ownerTz()` serves a 5-minute cache and falls back to the home zone rather than
    // throwing (lib/owner-clock.ts), so the pre-check below is as cheap as it was before ORB-193.
    const tz = await ownerTz();
    // LAR-17-s3 — the hour list is a setting now, cached in-process for a few minutes
    // (lib/schedule-hours.ts) so this per-minute pre-check does not query Postgres either.
    const hours = await scheduleHours("crm-routing");
    // Pre-check before touching the identity registry/Twenty/Slack at all — avoids that work on the
    // 59 out-of-slot minutes of every hour.
    if (dueRouteSlot(now, tz, hours) === null) return;

    const channelId = liveSlackChannelId();
    if (!channelId) {
      console.warn("crm-routing: no Slack principal configured (SLACK_ALLOWED_USER_IDS); skipping");
      return;
    }

    try {
      const pool = getPool();
      if (!tablesEnsured) {
        await ensureRouteTables(pool);
        tablesEnsured = true;
      }

      // Self-handles (Bendik's own email addresses) so the engine never treats his own
      // sent mail/organised meetings as a contact signal — same purpose as the old runtime's
      // EMAIL_ALLOWED_SENDERS, sourced from the identity registry instead of a second env var
      // (matching evening-brief.ts's own `myAddresses`).
      const selfHandles = await listAliases(pool, configuredOwnerId(), "email");
      // The org's own domains (sql/032 orgs.domains): colleagues and the org's own product
      // senders are never prospects. Per-install data, read here so the engine stays literal-free.
      const internalDomains = await listOrgDomains(pool, configuredOwnerId());

      const routeStore = makeRouteStore(pool);
      const routeClassifier = makeRouteClassifier({
        llm: (prompt) => gatewayComplete(prompt, { model: process.env["ROUTE_MODEL"], maxOutputTokens: 512 }),
      });
      const engine = makeRouteEngine({
        twenty: makeRouteTwentyClient(),
        classifier: routeClassifier,
        store: routeStore,
        selfHandles,
        internalDomains,
      });

      const door: CrmRoutingDoor = {
        async send(prompt) {
          const task = to(slack, { channelId }).send(prompt, { auth: { ...appAuth, attributes: { lane: "crm-routing" } } });
          waitUntil(task);
          await task;
        },
      };

      const completed = await makeCrmRoutingTick(
        { engine, store: routeStore, door, gate: initiateTo("crm-routing", doorId("slack", channelId)) },
        liveState,
      ).tick(now, hours, tz);
      if (completed) await recordSchedulePass(pool, HEARTBEAT_KEY);
    } catch (err) {
      console.error("crm-routing: live wiring failed", err);
      await emitSignal("schedule-tick-failed", "crm-routing: live wiring failed", String(err));
    }
  },
});
