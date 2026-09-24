/**
 * agent/schedules/trip-lifecycle.ts — the eve schedule tying lib/trip-schedule.ts's pure
 * date-math + at-most-once ledger to real I/O: TripStore, live flight data, and Telegram.
 *
 * DESIGN NOTE — two different sends, deliberately:
 *
 *  - Lifecycle PostKinds (evening/finale/arrival/checkout/reminder/weatherwarn) are genuinely
 *    LLM-composed in old Marcel too (`services/marcel/bin/marcel.ts`'s `makeCompose` calls
 *    `brain.answer()`/`dreamer.finale()` — never a raw pre-written string). For THIS content,
 *    `to(telegram, {chatId}).send(prompt)` is the correct primitive: per eve's own
 *    `schedules.mdx` ("Handler form"), it starts an agent turn that both COMPOSES and
 *    DELIVERS in one step — the turn's own reply IS the post. A prompt that should yield
 *    nothing (weatherwarn with no extreme weather) simply finishes without sending ("The
 *    agent does not have to deliver a message on every run"). This is the ONE place in the
 *    whole plan this schedule starts an agent turn rather than using a raw primitive — the
 *    Global Constraints' verbatim-delivery rule does not apply here because old Marcel's own
 *    behavior for this content was never byte-exact either (see `services/chief-of-staff/agent/
 *    schedules/reminders.ts`'s header for the contrasting case where it DOES apply).
 *
 *  - The flight-status card (`lib/flightwatch.ts`'s diffFlightState/renderFlightStatus) is
 *    deterministic — computed entirely in code, never touched by a model — so it is sent via
 *    the RAW `sendTelegramMessage`/`callTelegramApi("editMessageText")` primitives, exactly
 *    like `agent/tools/sveip.ts`'s completion report and eve-saga's `agent/schedules/
 *    reminders.ts` door sends. Markdown here is old Marcel's own convention
 *    (`services/marcel/lib/text.ts`'s `toTelegramHtml`/`toPlain`): `**`/`_` tokens convert to
 *    Telegram HTML, sent with `parse_mode: "HTML"`, falling back to plain text if the HTML
 *    send is rejected — ported verbatim below (`services/marcel/lib/telegram.ts:94-124`).
 *
 * Overlap guard: `running` is module-scope, matching eve-saga's `evening-brief.ts` convention
 * — a fresh `TripScheduler` is built every tick (cheap: TripStore is a stateless wrapper,
 * `defaultFlightStatusDeps.flights()` memoizes its own client), so this guard — not
 * TripScheduler's own internal one, which only protects a single already-constructed instance
 * — is what actually prevents two overlapping ticks in this schedule's live wiring.
 */
import { defineSchedule } from "eve/schedules";
import type { SessionAuthContext } from "eve/context";
import { sendTelegramMessage, callTelegramApi, type TelegramMessageBody } from "eve/channels/telegram";

import { getPool } from "@lares/agent-kit/db";
import { scheduleEnabled } from "@lares/agent-kit/schedule-switch";
import { recordSchedulePass } from "@lares/agent-kit/schedule-heartbeat";
import { thisAgent } from "../../lib/definition.js";
import { TripStore, type Trip } from "../../lib/trip-store.js";
import { TripScheduler, type PostKind, type FlightCard } from "../../lib/trip-schedule.js";
import { initiate, tripItemKey, flightItemKey } from "../../lib/initiation.js";
import { doorId } from "../../lib/principals.js";
import { BOOKING_HONESTY_RULES, weatherAdviceInstruction } from "../../lib/itinerary-advice.js";
import telegram, { telegramCredentials } from "../channels/telegram.js";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { defaultFlightStatusDeps } from "../../catalogue/flight_status.js";

/** `MARCEL_DATA_ROOT` points at the real `/srv/eve-marcel` bind mount in production
 *  (`services/box/compose.yaml`'s `eve-marcel:` block, review fix finding 1) — same as
 *  `lib/trip-store.ts`'s own doc comment and `agent/tools/sveip.ts`'s `dataRoot()`. Re-declared
 *  locally, matching every other file's own lazy per-call read. */
function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

/** International-leg connection-buffer threshold override (Tier 1 #3). Unset/invalid falls
 *  through to flightwatch.ts's own DEFAULT_CONNECTION_BUFFER_MIN — this file never hardcodes
 *  a number itself. */
function connectionBufferMinutes(): number | undefined {
  const raw = Number(process.env["MARCEL_CONNECTION_BUFFER_MIN"]);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

// --- markdown → Telegram HTML, ported verbatim from services/marcel/lib/text.ts -----------
// Exported (review fix, finding 10) so tests/text.test.ts — ported from
// services/marcel/tests/text.test.ts — can exercise this logic directly. This is the ONLY
// place eve-marcel holds this logic; there is no separate lib/text.ts in this port.

export function toPlain(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`{1,3}/g, "")
    .trim();
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Markdown → Telegram HTML (parse_mode "HTML"). Escapes FIRST so text can never smuggle real
 *  tags; markdown tokens (*, _, [, ], parens, backticks) survive escaping, so the transforms
 *  run safely on escaped text. Link → bold → code → italic → heading order matters: ** must be
 *  consumed before single *.
 *
 *  The inline-code placeholder below uses the TEXT ESCAPE SEQUENCE `\u0000` (backslash, u, 0,
 *  0, 0, 0 — six source characters, interpreted by the JS engine as an actual NUL character at
 *  runtime), exactly like `services/marcel/lib/text.ts`'s own `toTelegramHtml` (lines 26, 33).
 *  This file previously had a LITERAL raw NUL byte in the source instead of the escape
 *  sequence (review fix, finding 9) — functionally identical at runtime, but a raw byte makes
 *  the file opaque to `git diff` and most text tooling (it renders as "Binary files differ").
 *  The escape sequence form is source-safe and still evaluates to the same NUL placeholder. */
export function toTelegramHtml(md: string): string {
  let s = md.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]!);
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    codes.push(body);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${url.replace(/"/g, "%22")}">${label}</a>`);
  s = s.replace(/(\*\*|__)(.+?)\1/g, "<b>$2</b>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/gm, "$1<i>$2</i>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/gm, "$1<i>$2</i>");
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
  return s.trim();
}

// --- raw Telegram send/edit — the flight-status card's ONLY delivery path -----------------

async function sendWithHtmlFallback(chatId: string, text: string) {
  try {
    return await sendTelegramMessage({
      credentials: telegramCredentials,
      chatId,
      body: { text: toTelegramHtml(text), parse_mode: "HTML" } as TelegramMessageBody,
      fetch: telegramFetch,
    });
  } catch {
    // Malformed HTML must never cost the group its flight-status update — resend as plain
    // text (services/marcel/lib/telegram.ts:100-106's own fallback, ported verbatim).
    return await sendTelegramMessage({
      credentials: telegramCredentials,
      chatId,
      body: { text: toPlain(text) },
      fetch: telegramFetch,
    });
  }
}

/**
 * ORB-193 Task 4 — the flight watcher's two NEW-message paths, each one gated initiation.
 *
 * `event`, not `scheduled`: a gate change or a delay is a thing that happened, not a slot that came
 * round, so it counts against the per-door attention ceiling (10/day) exactly as Saga's event lanes
 * do. The item key is the flight and the material state it reports — the same state twice is
 * already-seen; a genuinely new state is a new item.
 *
 * `SCHEDULE` below is the one string the log line and the operator's grep share with the lifecycle
 * post above.
 */
const SCHEDULE = "trip-lifecycle";

/**
 * A delta line or a cancellation alert. A held-back message is simply not sent — the watcher's own
 * `flight-state.json` has already recorded the change as seen, so the next material change posts a
 * fresh, current card rather than replaying this one.
 *
 * A CANCELLATION is quiet-hours exempt (`ownerSetTime`, which in this fleet means "an owner set
 * this time, OR this is safety-critical"). The reason is the sentence above: the state has already
 * advanced past the cancellation, so `diffFlightState` will never generate the alert a second time
 * — a deferral to 07:00 would not delay the message, it would delete it, and the flight leaves
 * before then.
 *
 * DND still suppresses it, and that IS terminal for the same reason. That is deliberate and it is
 * the one case worth stating out loud: DND has no end time, so there is nothing to hold the message
 * until, and a fleet that decides for itself which of the owner's silences to ignore has no
 * do-not-disturb at all. The ledger keeps the suppressed row, so the console can show what was held
 * back and the morning brief can name it.
 */
async function rawSend(chatId: string, text: string, card: FlightCard): Promise<void> {
  await initiate(
    SCHEDULE,
    {
      cls: "event",
      door: doorId("telegram", chatId),
      itemKey: flightItemKey(card),
      ownerSetTime: card.cancelled === true,
    },
    async () => {
      await sendWithHtmlFallback(chatId, text);
    },
  );
}

/** The live card's first appearance. `undefined` = the gate held it back, so no message id is
 *  recorded and nothing is later edited in place (see `postFlightMessageWithId`'s own contract). */
async function rawSendWithId(chatId: string, text: string, card: FlightCard): Promise<string | undefined> {
  let id: string | undefined;
  const verdict = await initiate(
    SCHEDULE,
    { cls: "event", door: doorId("telegram", chatId), itemKey: flightItemKey(card) },
    async () => {
      id = (await sendWithHtmlFallback(chatId, text)).id;
    },
  );
  return verdict === "send" ? id : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** `sendTelegramMessage` has no text-editing counterpart in eve's public Telegram surface
 *  (only `editTelegramMessageReplyMarkup` is exported) — `callTelegramApi("editMessageText")`
 *  is the same raw HTTP primitive `sendTelegramMessage` itself calls internally, used directly
 *  here for the same reason `agent/tools/sveip.ts`'s doc comment gives for its own raw sends:
 *  deterministic content, no model in the delivery path. */
async function rawEdit(chatId: string, messageId: string, text: string): Promise<boolean> {
  const attempt = async (body: Record<string, unknown>): Promise<boolean> => {
    const res = await callTelegramApi({
      method: "editMessageText",
      body: { chat_id: chatId, message_id: Number(messageId), ...body },
      botToken: telegramCredentials.botToken,
      fetch: telegramFetch,
    });
    if (res.ok) return true;
    const description = isRecord(res.body) && typeof res.body["description"] === "string" ? res.body["description"] : "";
    return /message is not modified/i.test(description);
  };
  if (await attempt({ text: toTelegramHtml(text), parse_mode: "HTML" })) return true;
  return attempt({ text: toPlain(text) });
}

// --- lifecycle-post prompts — the one place this schedule starts an agent turn ------------

/** Norwegian composition instructions for each lifecycle PostKind, analogous to old Marcel's
 *  `composeInstruction`/`makeCompose` (`services/marcel/bin/marcel.ts:891-924`) — but where
 *  old Marcel resolved these into text itself (via `brain.answer()`/`dreamer.finale()`) and
 *  handed the result to a raw `post()`, here the prompt IS what gets sent to `to(telegram,
 *  {chatId}).send(...)`: the resumed agent turn does the composing (and, for weatherwarn,
 *  decides for itself whether to send anything at all). Old Marcel's memory-backed `Dreamer`
 *  (nightly learning → finale) is Task 8's territory, not ported here — finale's prompt below
 *  is a plain, reasonable instruction, not a literal port of `dreamer.finale`. */
/** ORB-130 — repeated at the LAST thing the model reads before it writes.
 *
 *  The rule already lives in the persona and in the turn's own "## Signatur" section, and Marcel
 *  signed 🇫🇷 anyway through two deploys: a habit visible in every previous message beats an
 *  instruction read earlier in the context. This sits at the end of the composition prompt,
 *  which is the last position available. It names no flag — the context supplies the trip's own. */
const FLAG_RULE = "Signerer du med en flagg-emoji, bruk turens eget flagg fra konteksten — aldri 🇫🇷.";

export function composePrompt(kind: PostKind, trip: Trip, ctx: Record<string, string>): string {
  return `${composeBody(kind, trip, ctx)}\n\n${FLAG_RULE}`;
}

function composeBody(kind: PostKind, trip: Trip, ctx: Record<string, string>): string {
  switch (kind) {
    case "evening": {
      const lines = [
        `Skriv en kort, hyggelig kveldspost til reisegruppen for turen "${trip.name}" om planen for i morgen: reiseplan, værmelding (bruk værverktøyet), og en hyggelig detalj om stedet.`,
      ];
      if (ctx.sitat) lines.push(`Avslutt med dagens sitat: ${ctx.sitat}`);
      // ORB-126 — only when tomorrow actually holds something. The bookings arrive as the
      // confirmation's own text (lib/itinerary-advice.ts), and the honesty rules ride with
      // them: a wrong "yes, you can move that" is worse than saying nothing at all.
      if (ctx.tomorrow && ctx.tomorrowBookings) {
        lines.push(weatherAdviceInstruction(ctx.tomorrow, ctx.tomorrowBookings));
      }
      return lines.join("\n\n");
    }
    case "packing": {
      // ORB-125 — T-3. Three days out is the first moment a forecast is worth packing by, and
      // the last moment an open loop (a booking with no time, something still unconfirmed) can
      // still be closed calmly. Bendik is at home: this is not a "tomorrow" post.
      const lines = [
        `Skriv en kort pakkepost til reisegruppen for turen "${trip.name}". Det er ${ctx.countdownDays ?? "noen"} dager til dere ankommer ${trip.destination.name} (${ctx.arrival ?? trip.start}), og dere er fortsatt hjemme.`,
        `Hent værmeldingen for ${trip.destination.name} med værverktøyet så langt fram den rekker (turen varer til ${ctx.end ?? trip.end}) — kommer du ikke helt fram, si det rett ut i stedet for å gjette.`,
        "Si hva været betyr for pakkingen, konkret.",
        "Nevn til slutt løse tråder fra turnotatene: bookinger uten klokkeslett, noe som ikke er bekreftet, noe som mangler. Har du ingen løse tråder, ikke finn på noen.",
        // ORB-126 — this post already talks about what is and is not confirmed, so it is
        // subject to the same rule: only what the notes actually say, never a reassurance.
        BOOKING_HONESTY_RULES,
      ];
      return lines.join(" ");
    }
    case "departure": {
      // ORB-125 — T-1. Purely logistics, read off bookings.md: this is the post that has to be
      // right, not charming.
      return [
        `Skriv en kort avreisepost til reisegruppen for turen "${trip.name}" — i morgen (${ctx.arrival ?? trip.start}) drar dere.`,
        "Gå gjennom morgendagens logistikk slik den står i turnotatene: fly, parkering, bagasje, hotell før avreise, tider. Bruk bare det som faktisk står der — mangler et klokkeslett, si at det mangler.",
        "Avslutt med det som bør gjøres i kveld.",
      ].join(" ");
    }
    case "arrival":
      return `Skriv en varm velkomstpost — dere har akkurat ankommet ${trip.destination.name}. Del praktisk info (wifi, husregler om du finner dem i turnotatene) og en hyggelig anbefaling i nærheten (bruk søkeverktøyet).`;
    case "finale":
      return `Skriv en varm avslutningspost for turen "${trip.name}" — takk for turen, noen høydepunkter fra oppholdet, og ønsk god reise hjem.`;
    case "checkout":
      // ORB-204 — keyed to the recorded check-out day now, so "i dag" is true by construction;
      // the time rides along when trip.md has one, and is not invented when it does not.
      return [
        `Skriv en kort utsjekk-påminnelse for i dag${ctx.checkoutTime ? ` — utsjekk er kl. ${ctx.checkoutTime}` : ""}.`,
        "Nevn eventuelle oppgaver før avreise slik de står i turnotatene. Bruk bare det som faktisk står der — mangler klokkeslettet, si at det mangler.",
      ].join(" ");
    case "reminder":
      return `Skriv en kort påminnelse om en kommende booking: ${ctx.kind ?? ""} ${ctx.start ?? ""} ${ctx.time ?? ""}.${ctx.flightStatus ? ` Status: ${ctx.flightStatus}.` : ""} Nevn når de bør dra (kjøretid om relevant).`;
    case "weatherwarn":
      return `Sjekk værmeldingen for ${trip.destination.name} i dag med værverktøyet. Skriv KUN en kort advarsel til gruppen hvis det er noe ekstremt (kraftig vind, uvær, ekstrem varme/kulde) — har du ingenting ekstremt å melde, ikke send noe.`;
  }
  return "";
}

/**
 * ORB-123 — the identity a scheduled post's turn runs under.
 *
 * `appAuth` (eve's `SCHEDULE_APP_AUTH`) carries `attributes: {}`. Delivery to the group was
 * always correct — `to(telegram, { chatId })` decides that — but the TURN's identity was the
 * app's own, and every trip-aware tool resolves its trip from
 * `auth.current.attributes.chat_id` (`agent/tools/weather_forecast.ts:38`, and identically in
 * `remember.ts`, `nytur.ts`, `place_link.ts`, `info.ts`, `flight_status.ts`, `strava_routes.ts`,
 * `shopping_add.ts`, `shopping_remove.ts`, plus `agent/instructions/trip-context.ts`'s whole
 * context injection). With no `chat_id` they ALL resolved null inside a scheduled post: no
 * weather, no itinerary, no bookings — and on 2026-08-19 a model left to improvise an
 * explanation for its own blindness ("ingen tur er koblet til denne chatten", posted into the
 * very group the trip is linked to).
 *
 * Stamping the destination chat onto the auth makes every one of those tools work inside a
 * scheduled post exactly as it does when Bendik asks in the chat — with no tool changes at all.
 * Everything else about `appAuth` is preserved (`authenticator`/`principalId`/`principalType`),
 * so eve's own `isScheduleAppAuth` still recognises the turn as app-initiated.
 *
 * `chat_id` is a STRING here on purpose: `agent/instructions/trip-context.ts:61` accepts the
 * attribute only when `typeof chatId === "string"`, and `Trip.chatId` is a string throughout
 * this service (`lib/trip-store.ts`'s own doc comment on the id-type change).
 */
export function chatScopedAuth(appAuth: SessionAuthContext, chatId: string): SessionAuthContext {
  return { ...appAuth, attributes: { ...appAuth.attributes, chat_id: String(chatId) } };
}

let running = false;

/** LAR-44 (ORB-175) — the row input-freshness.sh reads; pinned to this filename by the
 *  conformance test. Every-minute polling schedule: no separate `/tick` row, the pass IS the
 *  tick. */
export const HEARTBEAT_KEY = "marcel/trip-lifecycle";

export default defineSchedule({
  cron: "* * * * *",
  async run({ to, waitUntil, appAuth }) {
    const { loaded } = await thisAgent(undefined);
    if (!scheduleEnabled(loaded.definition, "trip-lifecycle")) return;
    if (running) return;
    running = true;
    try {
      const flights = defaultFlightStatusDeps.flights();
      const scheduler = new TripScheduler({
        store: new TripStore(dataRoot()),
        now: () => Math.floor(Date.now() / 1000),
        // ORB-193 Task 4 — a lifecycle post is a `scheduled` initiation: a named slot, one send per
        // trip per kind per day, so it is bounded by the slot list rather than by an attention
        // ceiling. Marcel's own quiet rule (lib/trip-schedule.ts's 22:00) has already run by the
        // time this is called; DND and the ceilings are the gate's. Returning the gate's verdict is
        // what keeps `sent.json` honest — see `PostVerdict` for which verdict un-marks.
        //
        // ONE DELIBERATE CONSEQUENCE, as the plan's Ruling 3 designed it: the two clocks do not
        // agree between 21:00 and 22:00. A post whose minute was missed and is catching up in that
        // hour is inside the gate's quiet window but outside Marcel's, so it is suppressed — and,
        // being scheduled, dropped for good rather than deferred to 07:00 (nobody wants last
        // night's "here is tomorrow's plan" at breakfast). The 20:00 slot itself is unaffected;
        // this only ever costs a post that was already an hour late. Reminders are exempt below.
        post: (kind, trip, chatId, ctx, slot) =>
          initiate(
            SCHEDULE,
            {
              cls: "scheduled",
              door: doorId("telegram", chatId),
              itemKey: tripItemKey(trip.slug, kind, slot),
              // Plan Ruling 3 — Bendik's own booking chose the hour, so quiet hours do not apply
              // (DND still does). `reminderFireTime` only rolls forward from 22:00, so without this
              // every 21:00–22:00 reminder was suppressed for good.
              ownerSetTime: kind === "reminder",
            },
            async () => {
              const task = to(telegram, { chatId }).send(composePrompt(kind, trip, ctx), {
                auth: chatScopedAuth(appAuth, chatId),
              });
              waitUntil(task);
              await task;
            },
          ),
        onJobError: (trip, key, err) => {
          console.error(`trip-lifecycle: job "${key}" failed for trip ${trip.slug}`, err);
        },
        flights: { status: (ref, opts) => flights.status(ref, opts) },
        postFlightMessage: rawSend,
        postFlightMessageWithId: rawSendWithId,
        editFlightMessage: rawEdit,
        connectionBufferMinutes: connectionBufferMinutes(),
      });
      await scheduler.tick();
      await recordSchedulePass(getPool(), HEARTBEAT_KEY);
    } catch (err) {
      console.error("[trip-lifecycle] tick failed:", err);
    } finally {
      running = false;
    }
  },
});
