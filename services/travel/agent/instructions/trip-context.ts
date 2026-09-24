/**
 * agent/instructions/trip-context.ts — the dynamic, per-TURN half of old Marcel's
 * `buildSystemPrompt`.
 *
 * Fix Wave B, Finding 1 — the biggest gap the whole-branch review found: nothing in this port
 * injected trip.md/itinerary.md/bookings.md/shopping.md/learned.md/taste/reise-log/conversation
 * transcript/today's-date into the model's context. `agent/instructions.md` (Task 10, static)
 * already carries the persona and the "## Dette gjør du automatisk" block — this file supplies
 * ONLY the genuinely dynamic sections old Marcel's `buildSystemPrompt`
 * (`services/marcel/lib/brain.ts:81-130`) rebuilt on every single message, via
 * `lib/trip-context.ts`'s pure `buildTripContextMarkdown` (do not re-render persona or the
 * automatic-behaviors block here — they would duplicate).
 *
 * eve reads `agent/instructions.md` (root) AND `agent/instructions/` (this directory) together
 * — root content first, then directory entries alphabetically (`node_modules/eve/docs/
 * instructions.mdx`). This file is the directory's only entry.
 *
 * `turn.started`, not `session.started`: eve's own compiled types confirm `turn.started`
 * resolvers produce "Durable turn-scoped instruction messages... Replaced each turn"
 * (`node_modules/eve/dist/src/context/keys.d.ts`, `TurnDynamicInstructionsKey`'s doc comment) —
 * that per-turn freshness is what gives near-per-message parity with old Marcel's actual
 * behavior (it rebuilt this prompt on every single message, not once per session).
 *
 * No linked trip (private admin DM with nothing active, or any other edge case): returns a
 * MINIMAL fallback — just today's date, no trip sections — rather than throwing or fabricating
 * trip data. Verified against eve's own runtime
 * (`node_modules/eve/dist/src/context/dynamic-instruction-lifecycle.js`): a resolver returning
 * `null` is treated as "no instructions this turn" and cleanly omitted (`n==null` branch), so
 * `null` would have been legal too, but returning the date-only `defineInstructions(...)` is
 * more useful — the model still knows what day it is even with nothing else to say.
 */
import { defineDynamic, defineInstructions, type DynamicResolveContext } from "eve/instructions";

import { TripStore, type Trip } from "../../lib/trip-store.js";
import { ConversationLog, TRANSCRIPT_WINDOW } from "../../lib/conversation-log.js";
import { nearTrip, savedSummary, tasteDigest } from "../../lib/taste.js";
import { TasteStore } from "../../lib/taste-store.js";
import { buildTripContextMarkdown } from "../../lib/trip-context.js";
import { isSweepRunning, readSweepMarker } from "../../lib/sweep-marker.js";
import { isAllowedAdmin } from "../../lib/principals.js";

/** No trip linked — old Marcel's cross-trip fallback tz (see `@lares/agent-kit`'s schedule-gate.ts and
 *  `agent/channels/telegram.ts`'s own `budgetTz()` convention: "Europe/Oslo matches the rest of
 *  this fleet's global day-boundary convention"). A linked trip always uses ITS OWN timezone
 *  instead (matching old Marcel's `todayISOFor(trip.timezone, ...)` call site,
 *  `bin/marcel.ts:538,588,642`). */
const FALLBACK_TZ = "Europe/Oslo";

function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

function todayISOFor(tz: string, nowMs: number): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(nowMs),
  );
}

function chatIdFrom(ctx: DynamicResolveContext): string | undefined {
  const caller = ctx.session.auth?.current ?? ctx.session.auth?.initiator ?? null;
  const chatId = caller?.attributes?.["chat_id"];
  return typeof chatId === "string" ? chatId : undefined;
}

/** ORB-157 — one registry line per trip for the ADMIN DM only: slug, dates, and the true
 *  link state (`chatId` or "ikke linket"), read straight from config.json so Marcel can
 *  never again invent link state. Returns undefined for every other caller (groups get full
 *  trip context; strangers get nothing) and on any read failure — same "must not crash the
 *  turn" contract as the rest of this resolver. */
function adminDmTripRegistry(ctx: DynamicResolveContext, store: TripStore): string | undefined {
  const caller = ctx.session.auth?.current ?? ctx.session.auth?.initiator ?? null;
  const chatType = caller?.attributes?.["chat_type"];
  const userId = caller?.attributes?.["user_id"];
  if (chatType !== "private" || typeof userId !== "string" || !isAllowedAdmin(userId)) return undefined;
  try {
    const trips = store.trips();
    if (trips.length === 0) return undefined;
    const lines = trips.map(
      (t) =>
        `- ${t.slug} — «${t.name}», ${t.start} → ${t.end}${t.chatId ? ` — linket til gruppe ${t.chatId}` : " — ikke linket til noen gruppe"}`,
    );
    // The authority clause is not decoration. On 2026-08-24 the registry shipped without it,
    // and Marcel — whose OWN pre-fix messages earlier that session claimed the group was
    // unlinked — trusted his transcript over the registry, hedged with "mest sannsynlig",
    // and asked for a chat-id again. Same self-conditioning failure mode as the persona's
    // capability-drift guard; the registry must outrank the conversation explicitly.
    return (
      `## Turer\n` +
      `Dette er FASIT, lest rett fra konfigurasjonen akkurat nå — stol på denne over alt annet i ` +
      `samtalen (også dine egne tidligere meldinger). Står det «linket til gruppe», ER gruppa ` +
      `linket; ikke be om chat-id for noe som allerede står her.\n${lines.join("\n")}`
    );
  } catch {
    return undefined;
  }
}

/**
 * ORB-107 — the sweep-status truth line, injected on EVERY turn from ORB-104's marker file.
 *
 * The defect this closes: the sweep's ack is an ordinary session message, but its completion
 * report and its interrupted-by-restart DM are raw Telegram sends the session never sees. So
 * once the model has acked a sweep, nothing in its context can ever tell it that sweep ended.
 * On 2026-08-17 that stale belief made it refuse four consecutive `/sveip`s for three hours
 * ("Sveipen kjører allerede fra i sto"). The command path no longer asks the model at all, but
 * a conversational "kan du sveipe innboksen?" still does — and it needs the truth, per turn,
 * from the same file the command path trusts.
 *
 * Stated as a fact about the world plus an explicit instruction to distrust memory, because
 * "no sweep is running" alone loses to a vivid in-context ack.
 */
export function sweepStatusMarkdown(root: string, tz: string, nowMs: number): string {
  const marker = readSweepMarker(root);
  if (isSweepRunning(marker, nowMs)) {
    const started = new Intl.DateTimeFormat("no-NO", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(marker!.startedAt));
    return `## Reise-sveip\nEt reise-sveip kjører NÅ (startet ${started}). Ikke start et nytt — rapporten kommer som egen melding når det er ferdig.`;
  }
  return (
    "## Reise-sveip\nIngen reise-sveip kjører nå. Denne linjen leses fra sveipe-markøren på disk " +
    "hvert eneste svar, og er alltid riktig — det du husker fra tidligere i samtalen er det ikke, " +
    "for du får aldri se rapporten som avslutter et sveip. Blir du bedt om å sveipe, så gjør det."
  );
}

/** Gathers every input `buildTripContextMarkdown` needs from disk/taste for a resolved `Trip`.
 *  Exported so the wiring (this function) stays separately testable from the pure assembly
 *  logic (`lib/trip-context.ts`'s own test suite) — mirrors old Marcel's own separation between
 *  `buildSystemPrompt` (pure) and `MarcelBrain.answer` (its I/O-performing caller). */
export function resolveTripContextMarkdown(store: TripStore, trip: Trip, nowMs: number): string {
  const tripMd = store.read(trip, "trip.md");
  const itinerary = store.read(trip, "itinerary.md");
  const bookings = store.read(trip, "bookings.md");
  const shopping = store.read(trip, "shopping.md");
  const learned = store.read(trip, "learned.md");
  // ORB-96: read only — the overlay is generated ONCE at /nytur (or by the persona_overlay
  // tool), never here. Context assembly stays pure I/O with no model call in it.
  const personaOverlay = store.read(trip, "persona-overlay.md");

  // Two DIFFERENT sources, deliberately: `tasteProfile()` is Marcel's own learned taste (his
  // dream/promote schedules write it), while TasteStore is Bendik's console-fed store, read-only
  // here. ORB-100 replaced the old Takeout-CSV loader with the latter.
  const taste = new TasteStore();
  const tasteProfile = [store.tasteProfile().trim(), tasteDigest(taste.lists())]
    .filter((s) => s.length > 0)
    .join("\n\n");
  const tasteGeoHits = savedSummary(nearTrip(taste.places(), trip.destination));

  const reiseLog = store.reiseLog();
  const transcript = new ConversationLog(`${trip.dir}/chatlog`, trip.timezone).transcript(TRANSCRIPT_WINDOW);

  return buildTripContextMarkdown({
    trip,
    tripMd,
    itinerary,
    bookings,
    shopping,
    learned,
    personaOverlay,
    tasteProfile,
    tasteGeoHits,
    todayISO: todayISOFor(trip.timezone, nowMs),
    transcript,
    reiseLog,
  });
}

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const chatId = chatIdFrom(ctx);
      const store = new TripStore(dataRoot());

      // TripStore.tripForChat()/.config() throws until config.json is seeded (Task 12's
      // provisioning step) — a turn must never crash just because that hasn't run yet, on a
      // fresh deployment, or because of any other read failure. Same "must not crash the door
      // over an expected pre-seed state" reasoning as agent/channels/telegram.ts's
      // `defaultDoorDeps.isKillSwitchOn()`.
      let trip: Trip | undefined;
      try {
        trip = chatId ? await store.tripForChat(chatId) : undefined;
      } catch (err) {
        console.error("eve-marcel: trip-context resolver failed to resolve the linked trip —", err);
        trip = undefined;
      }

      // ORB-107: the sweep-status line rides EVERY branch, including the no-trip one — /sveip
      // happens in the admin DM, which usually has no linked trip at all, so putting it only on
      // the trip path would have left the exact conversation that failed uncorrected.
      const now = Date.now();
      if (!trip) {
        // ORB-157: the admin DM additionally gets the trip REGISTRY — every trip's slug,
        // dates, and true link state. Without it Marcel is blind in the DM and invents the
        // nearest plausible story (2026-08-24: claimed an already-linked group was unlinked
        // and asked for a chat-id that would have fixed nothing). Best-effort: any read
        // failure (unseeded store included) just means no registry, never a crashed turn.
        const registry = adminDmTripRegistry(ctx, store);
        const md =
          `## I dag\n${todayISOFor(FALLBACK_TZ, now)}\n\n${sweepStatusMarkdown(dataRoot(), FALLBACK_TZ, now)}` +
          (registry ? `\n\n${registry}` : "");
        return defineInstructions({ markdown: md });
      }

      const sweepStatus = sweepStatusMarkdown(dataRoot(), trip.timezone, now);
      try {
        return defineInstructions({
          markdown: `${resolveTripContextMarkdown(store, trip, now)}\n\n${sweepStatus}`,
        });
      } catch (err) {
        console.error("eve-marcel: trip-context resolver failed to build the trip context —", err);
        return defineInstructions({ markdown: `## I dag\n${todayISOFor(trip.timezone, now)}\n\n${sweepStatus}` });
      }
    },
  },
});
