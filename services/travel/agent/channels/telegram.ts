import {interceptTelegramClaim} from '@lares/agent-kit/door-channels';
/**
 * The Telegram door — Marcel's ONLY channel.
 *
 * Two shapes live here, unlike eve-saga's private-chat-only door
 * (`services/chief-of-staff/agent/channels/telegram.ts`, which has no group-chat handling at
 * all):
 *
 *  - A private admin DM, same shape as eve-saga's: `isAllowedAdmin` (lib/principals.ts)
 *    gates everything, fail-closed.
 *  - A group chat, gated by `lib/gatekeeper.ts`'s `Gatekeeper` instead of eve's own default
 *    group-mention dispatch (which this file fully overrides, exactly as eve-saga's
 *    telegram.ts overrides eve's default for private chats). Only an untagged text message
 *    in a group already linked to a trip reaches the gate; `Gatekeeper.consider` decides
 *    "silent" | "react" | "speak" and only "speak" starts a turn.
 *
 * Inbound reaches this channel the long way round, per ADR-0011: Telegram POSTs to eve-marcel's
 * own webhook path, an nginx relay on ops-1 forwards it over the tailnet, and
 * `tailscale serve` on agent-1 hands it to this container. The relay verifies nothing — eve
 * checks `X-Telegram-Bot-Api-Secret-Token` here, where the secret lives.
 *
 * Outbound goes the other long way round: `lib/telegram-fetch.ts` routes Bot API calls
 * through the squid proxy via eve's per-call `api.fetch` seam, because the box's seal
 * (Task 1) drops anything else.
 *
 * SCOPE (Task 3): this file builds the DOOR — credentials, inbound gating, and the
 * `Gatekeeper`-driven group dispatch decision. It never composes or sends deterministic
 * content itself (no `to(telegram, {...}).send()` anywhere here) — that is later tasks'
 * job, calling the raw send primitives eve's own `eve/channels/telegram` module already
 * exports (`sendTelegramMessage`, `editTelegramMessageReplyMarkup`, etc., re-exported
 * un-wrapped from that package — nothing new is added here).
 *
 * Which trip a group chat is linked to (`tripForChat`) is backed by Task 5's real `TripStore`
 * as of this fix round (2026-08-16 — a Task 9 review found the read side was still the
 * placeholder `async () => null` even after `agent/tools/link_group.ts`, Task 9's own
 * deliverable, could WRITE a link via `TripStore.linkChat` — a group message could never reach
 * the Gatekeeper no matter how many times it was linked). The group's conversation history
 * (`appendInbound`/`transcriptFor`) is real as of Task 8b, backed by `lib/conversation-log.ts`
 * — the wave plan's inventory had listed that file as Task 3's job, but Task 3's own dispatched
 * brief never included it, so it shipped as a placeholder until Task 8b. All three surfaces
 * are still injected as `MarcelDoorDeps` seams so tests can stub them (see the interface's own
 * doc comment).
 *
 * `onBotAddedToGroup` (also wired for real in the same 2026-08-16 fix round) is the OTHER half
 * of group-linking: it DMs the admin an inline-button offer — one button per known trip,
 * `callback_data: "link:<chatId>:<tripSlug>"` — the moment the bot is added to a still-unlinked
 * group. Without it there was no path, button or otherwise, by which the admin could even learn
 * a new group's chat id to link it. See "Group-linking wiring" near the bottom of this file.
 *
 * Task 9 (2026-08-16, Ruling 5) added `onCallbackQuery`: the veto button's tap handler, later
 * extended in the same fix round to also resolve the link-offer button above — see the
 * "Callback-query wiring" section near the bottom of this file. It is the one exception to
 * "this file never composes deterministic content": it acks a callback, edits a message's
 * reply markup away, and (link taps only) posts one fixed intro line into the newly linked
 * group — all fixed operational strings/no-ops, same category as this file's own
 * `BUDGET_EXCEEDED_ADMIN_TEXT`, never trip content a model composed.
 *
 * Task 11 (2026-08-17) added live-location tracking: a `location` update from the admin
 * updates `lib/live-location.ts`'s ephemeral, in-memory `lastKnownLocation` for that chat —
 * see the "Live-location tracking" section near the bottom of `createOnMessage` for the
 * set/clear logic, and read the KNOWN GAP paragraph there before assuming a "stop sharing" tap
 * in the real app clears anything today: it doesn't, because of an eve 0.32.0 limitation this
 * file cannot work around from `onMessage` alone. `lib/live-location.ts`'s TTL expiry (off
 * Telegram's own `live_period` field) is what actually keeps this feature safe in production.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  answerTelegramCallbackQuery,
  callTelegramApi,
  defaultTelegramAuth,
  editTelegramMessageReplyMarkup,
  sendTelegramMessage,
  splitTelegramMessageText,
  telegramChannel,
  type TelegramCallbackQuery,
  type TelegramContext,
  type TelegramInboundResult,
  type TelegramMessage,
  type TelegramBotToken,
  type TelegramWebhookSecretToken,
} from "eve/channels/telegram";

import { isAllowedAdmin } from "../../lib/principals.js";
import { OFFICE_MEDIA_TYPES } from "@lares/agent-kit/attachment-hydration";
import { telegramUnreadableNote } from "@lares/agent-kit/unreadable-content";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import {
  respondToSessionFailed,
  respondToTurnFailed,
  type FailureEventData,
} from "@lares/agent-kit/gateway-budget";
import { telegramCredentials } from "../../lib/telegram-credentials.js";
import { mdToTelegramHtml, splitTelegramHtml } from "@lares/agent-kit/telegram-markdown";
import { gatewayModel } from "../../lib/gateway-provider.js";
import { sharedBudget } from "../../lib/shared-budget.js";
import { startSveip, tgSend } from "../../lib/sveip-run.js";
import type { Budget } from "../../lib/budget.js";
import { infoCard } from "../../lib/info-card.js";
import { appendNotert } from "../../lib/notert.js";
import { mentionsBot, stripMention } from "../../lib/text-mention.js";
import { Gatekeeper, makeGateDecide, type GateAction } from "../../lib/gatekeeper.js";
import { ConversationLog, TRANSCRIPT_WINDOW, type LogEntry } from "../../lib/conversation-log.js";
import { TripStore } from "../../lib/trip-store.js";
import { BookingPipeline } from "../../lib/bookings.js";
import { setLiveLocation, clearLiveLocation, hasLiveLocation, ONE_OFF_LOCATION_TTL_SEC } from "../../lib/live-location.js";
import { TELEGRAM_INNER_ROUTE } from "@lares/agent-kit/telegram-routes";

/**
 * No shadow-bot decision was needed for Marcel (unlike Saga's Wave 1 bot split) — this
 * reuses old Marcel's real bot identity (`@MarcelConciergeBot`, `marcel-telegram-bot-token`)
 * on a brand new webhook path. `services/box/compose.yaml`'s `eve-marcel:` block sets
 * `TELEGRAM_BOT_USERNAME: MarcelConciergeBot` (review fix, finding 5) — the group-join offer
 * flow (`isBotAddedToGroup` below, matched against this value) needs the REAL username to
 * ever fire; before that fix this env var was never set anywhere, so the placeholder below
 * silently matched nothing and the flow never triggered. The placeholder still exists as a
 * safe local/test default (never a live-network group match), not as the production value.
 */
const PLACEHOLDER_BOT_USERNAME = "marcel_concierge_bot_UNSET";

function botUsername(): string {
  return process.env["TELEGRAM_BOT_USERNAME"] ?? PLACEHOLDER_BOT_USERNAME;
}

/**
 * Re-exported, not defined here (ORB-107): the credentials moved to
 * `lib/telegram-credentials.ts` so `lib/sveip-run.ts` can send as Marcel without importing this
 * channel — this channel now imports the sweep runner, and the reverse import would be a cycle.
 * Every existing importer (`agent/tools/info.ts`, `link_group.ts`, `toggle_kill_switch.ts`,
 * `predeparture_pack.ts`, `agent/schedules/trip-lifecycle.ts`, `agent/channels/
 * telegram-webhook.ts`, `lib/info-card.ts`) keeps working unchanged.
 */
export { telegramCredentials } from "../../lib/telegram-credentials.js";

/**
 * Who may start a turn from a PRIVATE chat. A verified webhook secret proves only that
 * *Telegram* sent the update, not that the person behind it is trusted — this allowlist is
 * the gate, and it must fail closed: an unset or blank `MARCEL_ADMIN_TELEGRAM_ID`
 * (`lib/principals.ts`) admits nobody.
 *
 * Bots (including the bot's own echoes) are rejected outright. Also rejects anything that
 * isn't a private 1:1 chat — group messages go through the separate gatekeeper path in
 * `createOnMessage` below, never this allowlist, even from the admin's own id (identity
 * alone would otherwise admit every message the admin sends in ANY chat the bot is a member
 * of).
 */
export function isAllowedTelegramMessage(message: TelegramMessage): boolean {
  const from = message.from;
  if (!from || from.isBot) return false;
  if (message.chat.type !== "private") return false;
  return isAllowedAdmin(from.id);
}

/**
 * Drops content-free updates (e.g. service messages carrying no text, caption, or
 * attachment) — the one piece of eve's non-exported `defaultOnMessage` worth keeping once
 * `onMessage` is otherwise fully overridden.
 */
export function hasDispatchableContent(message: TelegramMessage): boolean {
  return (
    message.text.trim().length > 0 ||
    message.caption.trim().length > 0 ||
    message.attachments.length > 0
  );
}

const KILL_SWITCH_REENABLE = /^\/marcel\s+p[åa]$/i;

/** Matches the one command that may flip the (private) kill switch back on, from the admin
 *  only. Turning it OFF happens through a normal admin conversation turn (a tool call, not
 *  channel-level regex matching) — out of this task's scope. */
function isKillSwitchReenable(message: TelegramMessage): boolean {
  const from = message.from;
  if (!from || from.isBot) return false;
  if (message.chat.type !== "private") return false;
  if (!isAllowedAdmin(from.id)) return false;
  return KILL_SWITCH_REENABLE.test(message.text.trim());
}

/** `/sveip`, optionally with Telegram's own `@BotName` suffix. Nothing else — a message that
 *  merely mentions sveiping is a conversation, and belongs to the model. */
const SVEIP_COMMAND = /^\/sveip(@\S+)?$/i;

/**
 * ORB-107 — the `/sveip` command, recognised at CHANNEL level so the model never gets a vote.
 *
 * On 2026-08-17 the model refused four consecutive `/sveip`s because it believed a sweep it had
 * acked hours earlier was still running. It could not know otherwise: the completion report and
 * the interruption DM are raw Telegram sends the session never sees. The refusal happened
 * upstream of the tool, so ORB-104's marker file — which knew the truth — was never consulted.
 *
 * So the command is now matched here, exactly like `isKillSwitchReenable` above, and dispatched
 * straight to `startSveip`. Admin + private only, on the same fail-closed reasoning as every
 * other gate in this file: the sweep reads a whole year of Bendik's Reise mail and DMs him
 * about it, and identity alone (without the private-chat check) would admit the admin's own
 * messages in any group the bot sits in.
 */
function isSveipCommand(message: TelegramMessage): boolean {
  const from = message.from;
  if (!from || from.isBot) return false;
  if (message.chat.type !== "private") return false;
  if (!isAllowedAdmin(from.id)) return false;
  return SVEIP_COMMAND.test(message.text.trim());
}

/** A linked trip's fields the door needs. `tz` is what `Gatekeeper.consider` reads; `dir` (Task
 *  8b) is the trip's data directory (`lib/trip-store.ts`'s `Trip.dir`, `root/trips/<slug>`) —
 *  `appendInbound`/`transcriptFor`'s real implementations join it with `"chatlog"` to build
 *  the trip's `ConversationLog`, exactly as old Marcel's `logFor` did
 *  (`services/marcel/bin/marcel.ts:179-184`). A real `Trip` object satisfies this shape as-is
 *  once Task 5/9 wires `tripForChat` to `TripStore` — no further widening needed. */
export interface TripLookup {
  readonly tz: string;
  readonly dir: string;
}

/**
 * Everything the group-chat path needs but does not own the storage for.
 *
 * `tripForChat` and `onBotAddedToGroup` are Task 5/9's `TripStore` surface, injected as an
 * interface (rather than this file constructing a `TripStore` inline everywhere) purely so
 * tests can stub them independently of the filesystem. `defaultDoorDeps` below wires both to a
 * real `TripStore(dataRoot())` as of the 2026-08-16 fix round.
 *
 * `appendInbound`/`transcriptFor` are the write/read sides of the group's conversation-history
 * log (Task 8b), both backed by `lib/conversation-log.ts`'s `ConversationLog`, keyed off the
 * linked trip's `dir`. `appendInbound` is called for every dispatchable untagged group text
 * message BEFORE `transcriptFor` builds the transcript used for the gate decision — matching
 * old Marcel's write-then-read order exactly (`bin/marcel.ts`'s `handleGroupMessage` appends at
 * the very top, at line 561, before either the tagged branch's or the untagged gate's own
 * `log.transcript(15)` read, at lines 596/619/638/646 — so the CURRENT message is always part
 * of the transcript that judges it, including its own gate decision). Both default to real,
 * `fs`-backed `ConversationLog` instances rooted at `trip.dir/chatlog` — the same layout old
 * Marcel used (`bin/marcel.ts:179-184`).
 *
 * `isKillSwitchOn`/`setKillSwitch` are backed by `TripStore`'s `MarcelConfig.killSwitch` field
 * (`MARCEL_DATA_ROOT/config.json`, review fix finding 2) — the SAME field
 * `lib/trip-schedule.ts`'s `TripScheduler.tick()` and `lib/dream.ts` already read, so the door
 * and every schedule observe one shared, persisted source of truth instead of the module-scope
 * in-memory flag this file used before that fix. Both read fresh off disk on every call (no
 * caching) via an uncached `fs.readFileSync` inside `TripStore.config()` — a restart or a
 * concurrent write from the other side is always picked up on the next check, never stale.
 * `isKillSwitchOn()` treats a missing `config.json` (pre-Task-12 seed) as `false`, not a throw
 * — see its own doc comment for exactly which failure modes that narrow catch covers.
 *
 * `budget`/`notifyBudgetExceeded` are the caller-side circuit breaker ported from old
 * Marcel's `bin/marcel.ts:631-636`: the gate's own raw model calls are budget-tracked inside
 * `makeGateDecide` (`lib/gatekeeper.ts`), but something has to check `exceeded()` BEFORE
 * calling `gatekeeper.consider()` at all, or the cap never actually stops a call — that
 * caller-side check lives here, in the same spot old Marcel's did (the untagged-text branch,
 * right before the gate).
 */
export interface MarcelDoorDeps {
  tripForChat(chatId: string): Promise<TripLookup | null>;
  /** Appends one inbound group message to the linked trip's conversation log. Called BEFORE
   *  `transcriptFor` — see this interface's own doc comment for the exact old-Marcel ordering
   *  this matches. */
  appendInbound(trip: TripLookup, entry: LogEntry): void | Promise<void>;
  transcriptFor(trip: TripLookup, chatId: string): Promise<string> | string;
  isKillSwitchOn(): boolean;
  setKillSwitch(on: boolean): void;
  /** Called when the bot is added to a still-unlinked group. `defaultDoorDeps`' real
   *  implementation (`defaultOnBotAddedToGroup`, near the bottom of this file) DMs the admin
   *  an inline-button offer — one button per known trip — as of the 2026-08-16 fix round. */
  onBotAddedToGroup?(chatId: string, chatTitle: string | undefined): void | Promise<void>;
  gatekeeper: Gatekeeper;
  /** The gate's own daily token budget (shared with `makeGateDecide`'s `budget.add(...)` —
   *  same `Budget` instance, two different responsibilities: tracking spend vs. enforcing
   *  the cap). */
  budget: Budget;
  /** Fires once per day, the first time `budget.exceeded()` flips true (i.e. only when
   *  `budget.notifyOnce()` itself returns true) — mirrors old Marcel's one-time admin DM
   *  exactly. This is the one deliberate exception to "no composed content": a fixed
   *  operational string, not trip content, same category as the gate's own hardcoded 👍
   *  reaction. */
  notifyBudgetExceeded(): void | Promise<void>;
  /** Fix Wave B, Finding 2 — old Marcel's group `/info` (`bin/marcel.ts:571-575`): renders the
   *  linked trip's house-info card, sends it to the group, and pins it. Routed DIRECTLY from
   *  `onMessage`, ahead of the tagged check AND the gatekeeper/budget gate — a group member
   *  never needs to tag Marcel to see the house info. Resolves its OWN full `Trip` internally
   *  (not the `TripLookup` already in scope) since rendering the card needs `TripStore.read`,
   *  which `{tz, dir}` alone technically supports (`TripStore.read` only needs `.dir`), but
   *  pinning needs the chat id the caller already has — kept chat-id-keyed for symmetry with
   *  every other `MarcelDoorDeps` entry and so tests can stub it without a `TripLookup` in
   *  hand. */
  sendInfoCard(chatId: string): Promise<void>;
  /** Fix Wave B, Finding 2 — old Marcel's group `husk:` shortcut (`bin/marcel.ts:608-616`):
   *  appends `fact` to the linked trip's trip.md "## Notert" section, the exact same section
   *  `agent/tools/remember.ts`'s model-facing tool writes (both call `lib/notert.ts`'s
   *  `appendNotert`). Routed directly from `onMessage`'s tagged branch, ahead of starting a
   *  turn — `husk:` never reaches the model at all, matching old Marcel exactly. */
  appendNotert(chatId: string, fact: string): Promise<void>;
  /** ORB-107 — the `/sveip` command's dispatch target. Wired to `lib/sveip-run.ts`'s
   *  `startSveip` in `defaultDoorDeps`; injected here so a test can assert the command reaches
   *  it without running a hundred-mail Gmail sweep. */
  startSveip(): Promise<unknown>;
}

function gateModelId(): string {
  const id = process.env["MARCEL_MODEL_GATE"];
  if (!id) throw new Error("MARCEL_MODEL_GATE is not set");
  return id;
}

const defaultGatekeeper = new Gatekeeper({
  // `sharedBudget` (lib/shared-budget.ts) — the ONE Budget instance, shared with /sveip's
  // booking extraction. It used to be constructed here; ORB-107 moved it out so the sweep
  // runner could reach it without importing this channel.
  decide: makeGateDecide({ model: () => gatewayModel(gateModelId()), budget: sharedBudget }),
  now: () => Math.floor(Date.now() / 1000),
});

/** The fixed Norwegian string old Marcel sends the admin the first time the daily gate
 *  budget is exceeded (`bin/marcel.ts:633`) — ported verbatim, not composed per-call. */
/**
 * What this door lets through to Marcel. Office files joined on 2026-09-14 (ORB-286): agent-kit's
 * attachment hydration extracts their text; before that they were dropped here unseen. Same policy
 * as eve-saga's door.
 */
export const TELEGRAM_UPLOAD_POLICY = {
  allowedMediaTypes: ["image/*", "application/pdf", "text/*", ...OFFICE_MEDIA_TYPES],
  maxBytes: 10 * 1024 * 1024,
};

const BUDGET_EXCEEDED_ADMIN_TEXT =
  "⚠️ Token-budsjett brukt opp for i dag — Marcel svarer bare når han blir tagget.";

/** Fix Wave B review fix (Important #2): a tagged/replied-to message with no dispatchable
 *  content (a voice note, sticker, video, or anything else eve's inbound parser doesn't
 *  recognize as text/caption/photo/document — `hasDispatchableContent` below) must never start
 *  a turn: eve's `buildTelegramTurnMessage` would produce an empty prompt, which Anthropic
 *  rejects outright. Old Marcel had the identical guard specifically for voice
 *  (`bin/marcel.ts:580-585`, apologizing rather than either silently dropping the tag or
 *  crashing); this generalizes the same UX to every unsupported content type this port can't
 *  tell apart from a voice note (eve's own `TelegramAttachment.kind` only recognizes
 *  `"document" | "photo"`, so a voice/sticker/video reply looks identical to eve — empty
 *  text, empty caption, no attachments). Norwegian phrasing deliberately generalized past old
 *  Marcel's voice-specific wording ("talemeldinger") since we genuinely cannot tell what kind
 *  of unsupported content it was. */
const UNSUPPORTED_TAGGED_CONTENT_TEXT =
  "Beklager, den meldingstypen støtter jeg ikke ennå — skriv det gjerne som tekst! 🎙️";

/** Default `notifyBudgetExceeded`: a real Telegram send to `MARCEL_ADMIN_TELEGRAM_ID`, using
 *  this channel's own credentials and proxied fetch. Reads the admin id lazily, per call —
 *  same build-safety reasoning as every other env/secret read in this file. Fails quiet (no
 *  admin configured) rather than throwing back into the message-handling path. */
async function notifyAdminBudgetExceeded(): Promise<void> {
  const adminId = (process.env["MARCEL_ADMIN_TELEGRAM_ID"] ?? "").trim();
  if (adminId.length === 0) return;
  await tgSend(adminId, BUDGET_EXCEEDED_ADMIN_TEXT);
}

/** `trip.dir/chatlog` — the same layout old Marcel's `logFor` built
 *  (`bin/marcel.ts:179-184`). */
function chatLogFor(trip: TripLookup): ConversationLog {
  return new ConversationLog(path.join(trip.dir, "chatlog"), trip.tz);
}

/** `MARCEL_DATA_ROOT`-rooted `TripStore` — read lazily per call (never at module scope), same
 *  build-safety reasoning as every other env/secret read in this file. Duplicated across every
 *  tool file that needs one (`agent/tools/*.ts`'s own `dataRoot()`) rather than shared, by this
 *  codebase's own convention. */
function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

/** Old Marcel's `offerLink` (`bin/marcel.ts:544-553`), ported: offers every trip EXCEPT one
 *  already linked to THIS chat (re-offering it would be a no-op) — a trip linked to a
 *  DIFFERENT chat is still offered, labeled "(flytter hit)", since re-linking moves it there
 *  (linkChat overwrites `chatId`, so the old group goes silent). Returns `null` when there is
 *  nothing to offer (no trips at all, or every trip already points here) — pure, exported for
 *  its own unit test. */
export function composeLinkOffer(
  chatTitle: string | undefined,
  chatId: string,
  trips: readonly { slug: string; name: string; chatId?: string }[],
): { text: string; buttons: { text: string; data: string }[] } | null {
  const candidates = trips.filter((t) => t.chatId !== chatId);
  if (candidates.length === 0) return null;
  const buttons = candidates.map((t) => ({
    text: t.chatId === undefined ? t.name : `${t.name} (flytter hit)`,
    data: `link:${chatId}:${t.slug}`,
  }));
  return { text: `Er '${chatTitle ?? "denne gruppen"}' en av turene mine?`, buttons };
}

/** Default `onBotAddedToGroup`: DMs the admin `composeLinkOffer`'s text with one inline button
 *  per candidate trip (single row, matching old Marcel's own `offerLink` and
 *  `agent/tools/sveip.ts`'s `tgSend` button layout). Best-effort and silent on any failure —
 *  including a still-unprovisioned `TripStore` (no `config.json` yet, a real state for a fresh
 *  deployment with zero trips created) — a failed offer must never crash inbound dispatch, the
 *  same contract every other seam in this file honors. */
async function defaultOnBotAddedToGroup(chatId: string, chatTitle: string | undefined): Promise<void> {
  try {
    const adminId = (process.env["MARCEL_ADMIN_TELEGRAM_ID"] ?? "").trim();
    if (!adminId) return;

    const store = new TripStore(dataRoot());
    const offer = composeLinkOffer(chatTitle, chatId, store.trips());
    if (!offer) return;

    await sendTelegramMessage({
      credentials: telegramCredentials,
      chatId: adminId,
      body: {
        text: offer.text,
        reply_markup: { inline_keyboard: [offer.buttons.map((b) => ({ text: b.text, callback_data: b.data }))] },
      },
      fetch: telegramFetch,
    });
  } catch (err) {
    console.error("eve-marcel: failed to send the group-link offer —", err);
  }
}

/** The real dependency set the exported default channel wires up. `tripForChat` and
 *  `onBotAddedToGroup` are backed by a real `TripStore` as of the 2026-08-16 fix round (see
 *  this file's own top-of-file doc comment); `appendInbound`/`transcriptFor` are real as of
 *  Task 8b. */
export const defaultDoorDeps: MarcelDoorDeps = {
  tripForChat: async (chatId) => {
    const trip = new TripStore(dataRoot()).tripForChat(chatId);
    return trip ? { tz: trip.timezone, dir: trip.dir } : null;
  },
  appendInbound: (trip, entry) => {
    chatLogFor(trip).append(entry);
  },
  transcriptFor: (trip) => chatLogFor(trip).transcript(TRANSCRIPT_WINDOW),
  // Persisted on `MarcelConfig.killSwitch` via `TripStore` — the SAME source
  // `lib/trip-schedule.ts`'s tick and `lib/dream.ts` already read (`store.config().killSwitch`).
  // Before this fix these two functions backed the switch with a module-scope flag that only
  // the door itself ever observed — a schedule fired regardless of what the admin had toggled,
  // because nothing ever wrote `killSwitch` to disk. A fresh, unseeded `TripStore` (no
  // `config.json` yet) reads as "off" rather than throwing: the door must not crash on every
  // inbound message just because Task 12's seed step hasn't run yet.
  isKillSwitchOn: () => {
    // Missing config.json is the ONE expected failure mode here — Task 12 hasn't seeded it
    // yet, or this is a fresh deployment with zero trips. Checked explicitly via existsSync
    // (matching TripStore's own private configPath(): path.join(root, "config.json")) so this
    // narrow, expected case never even reaches the try/catch below.
    if (!existsSync(path.join(dataRoot(), "config.json"))) return false;
    try {
      return new TripStore(dataRoot()).config().killSwitch;
    } catch (err) {
      // The file EXISTS but TripStore.config() still threw — a truncated write, malformed
      // JSON, or a permissions problem (plausible if Task 12's `chown 10001:10001` step ever
      // goes wrong). This is NOT the ordinary pre-seed case above, and must not silently read
      // as "off": that would mean a corrupted safety-control file quietly lets Marcel keep
      // talking with no trace in the logs. Log loudly and fail toward SILENCE — `true` is the
      // safe direction for a kill switch — while still leaving the admin's own "/marcel på"
      // re-enable command reachable: onMessage's kill-switch branch checks
      // isKillSwitchReenable() before returning whenever this reads true.
      console.error("eve-marcel: kill switch config unreadable — failing closed (silent) —", err);
      return true;
    }
  },
  setKillSwitch: (on) => {
    const store = new TripStore(dataRoot());
    const cfg = store.config(); // throws if config.json is missing — fail loud, matching TripStore's own contract (seed before use)
    cfg.killSwitch = on;
    store.saveConfig(cfg);
  },
  onBotAddedToGroup: defaultOnBotAddedToGroup,
  gatekeeper: defaultGatekeeper,
  budget: sharedBudget,
  // ORB-107: the real sweep, started without a model in the loop. `startSveip` owns the
  // marker check, the ack, the detach and the completion report — see lib/sveip-run.ts.
  startSveip: () => startSveip(),
  notifyBudgetExceeded: notifyAdminBudgetExceeded,
  // Fix Wave B, Finding 2 — real defaults for the new group `/info`/`husk:` seams above.
  // Silently no-ops when the chat has no linked trip (shouldn't happen in practice: `onMessage`
  // only reaches these once `deps.tripForChat(chatId)` already resolved one) rather than
  // throwing mid-dispatch.
  sendInfoCard: async (chatId) => {
    const store = new TripStore(dataRoot());
    const trip = store.tripForChat(chatId);
    if (!trip) return;
    const card = infoCard(store.read(trip, "trip.md"));
    let firstId: string | undefined;
    for (const chunk of splitTelegramMessageText(card)) {
      const result = await sendTelegramMessage({
        credentials: telegramCredentials,
        chatId,
        body: { text: chunk },
        fetch: telegramFetch,
      });
      if (firstId === undefined) firstId = result.id;
    }
    if (firstId) {
      // Best-effort — a pin failure must never sink the info card itself, matching old
      // Marcel's own tg.pin (services/marcel/lib/telegram.ts:167-169, silently caught) and
      // agent/tools/info.ts's own realPin.
      await callTelegramApi({
        method: "pinChatMessage",
        body: { chat_id: chatId, message_id: Number(firstId), disable_notification: true },
        botToken: telegramCredentials.botToken,
        fetch: telegramFetch,
      }).catch(() => {});
    }
  },
  appendNotert: async (chatId, fact) => {
    const store = new TripStore(dataRoot());
    const trip = store.tripForChat(chatId);
    if (!trip) return;
    appendNotert(store, trip, fact);
  },
};

/** True for a Telegram "new chat members" service message whose member list includes the
 *  bot itself (matched by configured username) — i.e. "the bot was just added to this
 *  group". Reads the raw Bot API payload directly since eve's `TelegramMessage` doesn't
 *  project service-message fields into its own shape. */
function isBotAddedToGroup(message: TelegramMessage, configuredBotUsername: string | undefined): boolean {
  if (!configuredBotUsername) return false;
  const raw = message.raw as { new_chat_members?: ReadonlyArray<{ username?: string }> };
  const added = raw.new_chat_members;
  if (!Array.isArray(added)) return false;
  return added.some((m) => m?.username?.toLowerCase() === configuredBotUsername.toLowerCase());
}

/** True when `message` is a reply to one of the bot's own messages — half of old Marcel's
 *  `tagged` check (`bin/marcel.ts:578`: `u.replyToBot || mentionsBot(...)`). eve's
 *  `TelegramMessage.replyToMessage` carries no bot id to compare against directly (only
 *  `TelegramHandle.botUsername`, no bot id — see `eve/channels/telegram`'s own
 *  `TelegramHandle` type), so this matches by username, the same signal `isBotAddedToGroup`
 *  above already uses for the identical reason. A bot account's `from.username` is always set
 *  on Telegram, so this is reliable whenever `TELEGRAM_BOT_USERNAME` is configured. */
function isReplyToBot(message: TelegramMessage, configuredBotUsername: string | undefined): boolean {
  if (!configuredBotUsername) return false;
  return message.replyToMessage?.from?.username?.toLowerCase() === configuredBotUsername.toLowerCase();
}

/** Telegram's own message timestamp (unix seconds), read from the raw Bot API payload — eve's
 *  `TelegramMessage` doesn't project it (same raw-access pattern as `isBotAddedToGroup` above).
 *  Falls back to wall-clock time on a missing/malformed field so logging never throws. */
function telegramMessageTimestamp(message: TelegramMessage): number {
  const raw = message.raw as { date?: unknown };
  return typeof raw.date === "number" ? raw.date : Math.floor(Date.now() / 1000);
}

/** Telegram's `location` object (Bot API), read from the raw payload — eve's `TelegramMessage`
 *  doesn't project it (same raw-access pattern as `isBotAddedToGroup`/`telegramMessageTimestamp`
 *  above). `livePeriod` is present (seconds) for a live-location share; absent for a plain
 *  one-off "send my location" AND for Telegram's own "stopped sharing" signal — see
 *  `createOnMessage`'s "Live-location tracking" section below for how those two are told apart. */
function parseTelegramLocation(message: TelegramMessage): { lat: number; lon: number; livePeriod?: number } | null {
  const raw = message.raw as { location?: { latitude?: unknown; longitude?: unknown; live_period?: unknown } };
  const loc = raw.location;
  if (!loc || typeof loc.latitude !== "number" || typeof loc.longitude !== "number") return null;
  return { lat: loc.latitude, lon: loc.longitude, livePeriod: typeof loc.live_period === "number" ? loc.live_period : undefined };
}

/**
 * Builds the channel's `onMessage` handler, parametrized by `MarcelDoorDeps` so tests can
 * inject stubs for the not-yet-built TripStore/config surface. `createOnMessage(defaultDoorDeps)`
 * is what the exported default channel below actually wires up.
 */
export function createOnMessage(
  deps: MarcelDoorDeps,
): (ctx: TelegramContext, message: TelegramMessage) => Promise<TelegramInboundResult> {
  return async (ctx, message) => {
    if (await interceptTelegramClaim(message)) return null;
    // Kill switch short-circuits everything, group or private, except the one admin command
    // that turns it back on — ported from services/marcel/bin/marcel.ts's onUpdate (the
    // `cfg.killSwitch` block, ~line 662).
    if (deps.isKillSwitchOn()) {
      if (isKillSwitchReenable(message)) {
        deps.setKillSwitch(false);
      }
      return null;
    }

    // ── /sveip, dispatched past the model (ORB-107) ───────────────────────────────────────
    //
    // Deliberately AFTER the kill switch (a silenced Marcel must not start a sweep that DMs)
    // and BEFORE everything else, including the private-admin turn start below — the whole
    // point is that this text never becomes a model turn. `startSveip` decides whether a sweep
    // is already running by reading ORB-104's marker; nothing here needs to know.
    //
    // Failures are swallowed and logged rather than thrown: an exception out of `onMessage`
    // would fail the webhook, and Telegram would redeliver the same `/sveip` on its retry
    // schedule — turning one broken send into a stream of sweep attempts.
    if (isSveipCommand(message)) {
      try {
        await deps.startSveip();
      } catch (err) {
        console.error("eve-marcel: /sveip command failed to start —", err);
      }
      return null;
    }

    // ── Live-location tracking (Task 11) ─────────────────────────────────────────────────
    //
    // Admin-only (fail-closed, matching this file's own pattern for the private-DM allowlist
    // and the veto/link callback gate below): the whole point is tracking BENDIK's real-world
    // position for nearby-place suggestions, and admitting any other sender's location would
    // let a group member spoof what "nearby" resolves to. A location share is never itself a
    // request for a reply — this branch always returns null, for both chat types, whether or
    // not it recognized an admin sender.
    //
    // `livePeriod` present → a live share starting or continuing: (re)set with that TTL.
    // `livePeriod` absent + a live location WAS being tracked for this chat → Telegram's own
    // "stopped sharing" signal: clear it. KNOWN GAP: in real Telegram traffic this branch is
    // currently UNREACHABLE — Telegram delivers both the live-location ping updates and the
    // explicit stop signal as `edited_message` updates, and eve 0.32.0's `parseTelegramUpdate`
    // (node_modules/eve/dist/.../telegram/inbound.js) recognizes only `message` and
    // `callback_query` top-level keys, so the webhook route drops an `edited_message` before
    // `onMessage` is ever invoked. The logic below is real and unit-tested (see
    // tests/telegram-live-location.test.ts), ready for the day eve adds `edited_message`
    // support — but `lib/live-location.ts`'s TTL expiry, not this clear, is what actually
    // bounds a stale share in production until then.
    // `livePeriod` absent + nothing tracked yet → a fresh one-off share: record it, bounded by
    // `ONE_OFF_LOCATION_TTL_SEC` so it's never treated as permanent.
    const location = parseTelegramLocation(message);
    if (location) {
      const from = message.from;
      if (from && !from.isBot && isAllowedAdmin(from.id)) {
        if (location.livePeriod !== undefined) {
          setLiveLocation(message.chat.id, location.lat, location.lon, location.livePeriod);
        } else if (hasLiveLocation(message.chat.id)) {
          clearLiveLocation(message.chat.id);
        } else {
          setLiveLocation(message.chat.id, location.lat, location.lon, ONE_OFF_LOCATION_TTL_SEC);
        }
      }

      // Group location share (Fix Wave B, Finding 2 — old Marcel `bin/marcel.ts:564-568`): log
      // + react 👌 for ANY group member's shared position, not just the admin's. This is
      // independent of the admin-only live-location TTL tracker above (Task 11) — it only
      // feeds the group's own transcript, so the gatekeeper's gate decisions and the nightly
      // dream job both see it, matching old Marcel's `handleGroupMessage` exactly.
      if ((message.chat.type === "group" || message.chat.type === "supergroup") && from && !from.isBot) {
        const groupTrip = await deps.tripForChat(message.chat.id);
        if (groupTrip) {
          await deps.appendInbound(groupTrip, {
            ts: telegramMessageTimestamp(message),
            from: from.id,
            name: from.firstName ?? from.id,
            text: `[posisjon] ${location.lat.toFixed(5)}, ${location.lon.toFixed(5)}`,
          });
          await ctx.telegram
            .request("setMessageReaction", {
              chat_id: Number(message.chat.id),
              message_id: Number(message.messageId),
              reaction: [{ type: "emoji", emoji: "👌" }],
            })
            .catch(() => {});
        }
      }

      return null;
    }

    if (message.chat.type === "private") {
      if (!isAllowedTelegramMessage(message)) return null;
      // ORB-286: a voice note, video, sticker, contact or a file outside the policy used to vanish
      // without a word. The note names it for Marcel. Locations never reach here (handled above).
      const unreadable = telegramUnreadableNote(message, TELEGRAM_UPLOAD_POLICY, { includeLocation: false });
      if (!hasDispatchableContent(message) && unreadable === null) return null;
      await ctx.telegram.startTyping();
      return { auth: defaultTelegramAuth(message), ...(unreadable ? { context: [unreadable] } : {}) };
    }

    // "channel" posts are parsed by eve but never dispatched (matches eve's own default);
    // only "group"/"supergroup" run the gatekeeper path below.
    if (message.chat.type !== "group" && message.chat.type !== "supergroup") return null;

    const from = message.from;
    if (!from || from.isBot) return null;

    const chatId = message.chat.id;
    const trip = await deps.tripForChat(chatId);
    if (!trip) {
      if (isBotAddedToGroup(message, ctx.telegram.botUsername) && deps.onBotAddedToGroup) {
        await deps.onBotAddedToGroup(chatId, message.chat.title);
      }
      return null;
    }

    const trimmedText = message.text.trim();
    const hasPhotoCaption = message.attachments.some((a) => a.kind === "photo") && message.caption.trim().length > 0;

    // Write side of the conversation log, ported from old Marcel's `handleGroupMessage`
    // (bin/marcel.ts:557-566): logged BEFORE anything downstream (/info, husk:, the tagged
    // branch, or the untagged gate) reads the transcript, so the CURRENT message is always
    // part of the transcript that judges it. Widened (Fix Wave B, Finding 2) to also log a
    // photo's caption, not just plain text — old Marcel logged `[foto] <caption>` the same way
    // (`bin/marcel.ts:562-563`); dropping it before logging degraded both the gate's own
    // transcript quality and the nightly dream job's.
    if (trimmedText.length > 0) {
      await deps.appendInbound(trip, {
        ts: telegramMessageTimestamp(message),
        from: from.id,
        name: from.firstName ?? from.id,
        text: message.text,
      });
    } else if (hasPhotoCaption) {
      await deps.appendInbound(trip, {
        ts: telegramMessageTimestamp(message),
        from: from.id,
        name: from.firstName ?? from.id,
        text: `[foto] ${message.caption}`,
      });
    }

    // Group `/info` (Fix Wave B, Finding 2 — old Marcel `bin/marcel.ts:571-575`): direct,
    // bypasses the tagged check AND the gatekeeper/budget gate entirely — any group member can
    // pull the house-info card without tagging Marcel, exactly like old Marcel. NOT admin-gated
    // (matches old Marcel's own group `/info`, which has no sender check — the group itself is
    // already implicitly trusted).
    if (trimmedText.length > 0 && /^\/info\b/i.test(trimmedText)) {
      await deps.sendInfoCard(chatId);
      return null;
    }

    // Tagged/replied-to detection (Fix Wave B, Finding 2 — old Marcel `bin/marcel.ts:578`):
    // `tagged = replyToBot || mentionsBot(text-or-caption)`. A tagged message answers
    // UNCONDITIONALLY below, bypassing the gatekeeper AND the budget check entirely — the same
    // two checks the untagged path still runs, further down.
    const botUsername = ctx.telegram.botUsername;
    const textForMention = trimmedText.length > 0 ? message.text : message.caption;
    const tagged =
      isReplyToBot(message, botUsername) ||
      (textForMention.trim().length > 0 && !!botUsername && mentionsBot(textForMention, botUsername));

    if (tagged) {
      // `husk:` shortcut (Fix Wave B, Finding 2 — old Marcel `bin/marcel.ts:608-616`): appends
      // the note and acks with a fixed string, WITHOUT starting a turn — the model never sees
      // this message at all, matching old Marcel exactly.
      if (trimmedText.length > 0 && botUsername) {
        const stripped = stripMention(message.text, botUsername).trim();
        const husk = /^husk\s*:\s*(.*)$/i.exec(stripped);
        if (husk) {
          const fact = husk[1]!.trim();
          await deps.appendNotert(chatId, fact);
          await ctx.telegram.sendMessage(`Notert! 📝 ${fact}`);
          return null;
        }
      }

      // Content-free tagged message (voice note, sticker, video, ...) — starting a turn here
      // would hand eve an empty prompt, which Anthropic rejects outright. Apologize instead of
      // starting a turn, matching old Marcel's own voice-specific UX (`bin/marcel.ts:580-585`),
      // generalized to every content type this port can't tell apart from a voice note (see
      // `UNSUPPORTED_TAGGED_CONTENT_TEXT`'s own doc comment above). The private-DM path already
      // guards against exactly this via the same `hasDispatchableContent` check, at the
      // `isAllowedTelegramMessage` branch above.
      if (!hasDispatchableContent(message)) {
        await ctx.telegram.sendMessage(UNSUPPORTED_TAGGED_CONTENT_TEXT);
        return null;
      }

      // Anything else tagged (text or photo, with or without a caption) starts a turn
      // unconditionally — old Marcel's `if (tagged) { ... }` branch (`bin/marcel.ts:587-627`)
      // never even reaches the untagged path's gate/budget check below, and neither does this.
      await ctx.telegram.startTyping();
      return { auth: defaultTelegramAuth(message) };
    }

    // Untagged-gate territory only reads text — matches old Marcel's
    // `u.kind === "text" && u.text` guard before calling the gatekeeper.
    if (trimmedText.length === 0) return null;

    // Caller-side circuit breaker, ported from bin/marcel.ts:631-636: check the daily budget
    // BEFORE calling the gate at all. The gate's own `makeGateDecide` only tracks spend
    // (`budget.add(...)`) — enforcement has to happen here, or the cap never stops a call.
    if (deps.budget.exceeded()) {
      if (deps.budget.notifyOnce()) {
        await deps.notifyBudgetExceeded();
      }
      return null;
    }

    const transcript = await deps.transcriptFor(trip, chatId);
    const decision: GateAction = await deps.gatekeeper.consider(chatId, transcript, trip.tz);

    if (decision.action === "silent") return null;

    if (decision.action === "react") {
      await ctx.telegram.request("setMessageReaction", {
        chat_id: Number(chatId),
        message_id: Number(message.messageId),
        reaction: [{ type: "emoji", emoji: decision.emoji }],
      });
      return null;
    }

    // decision.action === "speak"
    await ctx.telegram.startTyping();
    return { auth: defaultTelegramAuth(message) };
  };
}

// ── Callback-query wiring (ADDED SCOPE, Ruling 5 — Task 5's review; extended 2026-08-16 fix
// round to also resolve the group-link offer button above) ─────────────────────────────────
//
// Task 5 built the veto BUTTON (`agent/tools/sveip.ts`'s `tgSend`, an inline keyboard with
// `callback_data: "veto:<bookingId>"`, matching old Marcel's own convention verbatim
// `services/marcel/lib/telegram.ts:95-96`) and the veto LOGIC (`lib/bookings.ts`'s
// `BookingPipeline.veto`), but nothing ever called it when the button was actually tapped —
// this file is that missing wiring, per Ruling 5: "Task 3 already deals with inline-button
// flows... so it's the natural home." The same review's fix round found the group-link OFFER
// (`composeLinkOffer`/`defaultOnBotAddedToGroup` above) had the identical problem — a button
// with nothing to resolve its tap — so both shapes are handled by ONE handler here, per the
// review's own instruction to reuse this exact pattern rather than build a second one.
//
// eve routes callback taps in two lanes: its own HITL approval taps go through a SEPARATE
// path the channel never sees (see eve-saga's `agent/channels/telegram.ts`'s own doc comment
// on `onCallbackQuery`, which this file's wiring structurally mirrors), and everything else —
// including a `veto:<id>` or `link:<chatId>:<slug>` tap, neither of which carries an HITL
// prefix — lands here. The regex checks below are what stop this handler from ever mistaking
// some OTHER future callback shape for either of these two.

const VETO_CALLBACK_RE = /^veto:(.+)$/;
/** `link:<chatId>:<tripSlug>` — chat ids are plain (optionally negative) integers and slugs are
 *  `agent/tools/nytur.ts`'s `slugify()` output (`[a-z0-9-]+`), so neither segment can ever
 *  contain a `:` and a simple two-group split is unambiguous. */
const LINK_CALLBACK_RE = /^link:([^:]+):(.+)$/;

/** The veto pipeline's own admin DM (the "hus-info may be stale" warning `BookingPipeline.veto`
 *  sends when it removes a booking that had merged house facts) AND the link flow's intro line
 *  into a newly linked group.
 *
 *  Now simply `lib/sveip-run.ts`'s `tgSend`. It used to be a duplicate, because the old home of
 *  `tgSend` (`agent/tools/sveip.ts`) imported FROM this file and importing back would have been
 *  a cycle. ORB-107 moved the sweep runner into `lib/`, which removes the cycle — and ORB-112
 *  makes sharing it necessary rather than merely tidy: the markdown→HTML conversion has to apply
 *  to every outbound text, and two send helpers means two chances to forget it. */
async function rawTgSend(chatId: string, text: string): Promise<string> {
  return tgSend(chatId, text);
}

/** A `BookingPipeline` scoped to veto-only use. `veto()` itself never calls `extract` (it only
 *  reads/writes bookings.md + vetoed.json and sends the optional hus-info warning DM above),
 *  so `extract` is a stub that throws rather than pulling in the LLM gateway
 *  (`gatewayModel`/`MARCEL_MODEL_BRAIN`, `agent/tools/sveip.ts`'s own concern) just to
 *  construct this object for a button tap. */
function vetoPipeline(): BookingPipeline {
  return new BookingPipeline({
    extract: async () => {
      throw new Error("telegram.ts veto handler: extract() must never be called");
    },
    store: new TripStore(dataRoot()),
    tg: { send: rawTgSend },
    adminId: (process.env["MARCEL_ADMIN_TELEGRAM_ID"] ?? "").trim(),
    now: () => Math.floor(Date.now() / 1000),
  });
}

/** Result of a link-callback resolution — `ok: false` is a normal, expected outcome (a stale
 *  offer button naming a slug that no longer exists), not an error to throw. */
export type LinkCallbackResult = { ok: true } | { ok: false; error: string };

export interface TelegramCallbackDeps {
  veto(bookingId: string): Promise<void>;
  linkGroup(chatId: string, tripSlug: string): Promise<LinkCallbackResult>;
}

/** Mirrors `agent/tools/link_group.ts`'s own logic exactly (`TripStore.linkChat` + a fixed
 *  intro line into the newly linked group) — duplicated rather than imported for the same
 *  channel↔tool cycle reason as `rawTgSend` above; `link_group.ts` already imports
 *  `telegramCredentials` FROM this file. */
export const defaultTelegramCallbackDeps: TelegramCallbackDeps = {
  veto: (bookingId) => vetoPipeline().veto(bookingId),
  linkGroup: async (chatId, tripSlug) => {
    const store = new TripStore(dataRoot());
    const trip = store.trips().find((t) => t.slug === tripSlug);
    if (!trip) return { ok: false, error: `fant ingen tur med slug "${tripSlug}"` };
    store.linkChat(tripSlug, chatId);
    await rawTgSend(chatId, `👋 Hei! Jeg er Marcel og hjelper med "${trip.name}" i denne gruppa fra nå av.`);
    return { ok: true };
  },
};

/** Builds the channel's `onCallbackQuery` handler, parametrized the same way `createOnMessage`
 *  is, for the same reason: tests inject stub `veto`/`linkGroup` rather than exercise the real
 *  `BookingPipeline`/`TripStore`/filesystem. Admin-only, checked BEFORE either action runs — a
 *  non-admin tap must be rejected without touching bookings.md OR config.json at all. Always
 *  acks (clears the tapper's spinner, matching old Marcel's own `finally { answerCallback }`,
 *  `bin/marcel.ts:712-714`) and, once the action actually SUCCEEDED, edits the original
 *  message's reply markup away so the same button can't be tapped twice — a failed link (e.g.
 *  a stale slug) deliberately leaves the buttons in place so the admin can try another one. */
export function createOnCallbackQuery(
  deps: TelegramCallbackDeps,
): (ctx: TelegramContext, query: TelegramCallbackQuery) => Promise<void> {
  return async (_ctx, query) => {
    const data = query.data ?? "";
    const vetoMatch = VETO_CALLBACK_RE.exec(data);
    const linkMatch = vetoMatch ? null : LINK_CALLBACK_RE.exec(data);

    if (!vetoMatch && !linkMatch) {
      // Not our shape — never touch veto() or linkGroup(). Still ack so eve's own
      // spinner-clearing contract holds for whoever tapped it, mirroring eve-saga's fallback
      // for a callback nobody claims.
      await answerTelegramCallbackQuery({
        credentials: telegramCredentials,
        callbackQueryId: query.id,
        text: "Unsupported action.",
        fetch: telegramFetch,
      }).catch(() => {});
      return;
    }

    if (!isAllowedAdmin(query.from.id)) {
      await answerTelegramCallbackQuery({
        credentials: telegramCredentials,
        callbackQueryId: query.id,
        text: "Not allowed.",
        fetch: telegramFetch,
      }).catch(() => {});
      return;
    }

    try {
      let ackText: string;
      let succeeded: boolean;
      if (vetoMatch) {
        await deps.veto(vetoMatch[1]!);
        ackText = "Fjernet.";
        succeeded = true;
      } else {
        const [, chatId, tripSlug] = linkMatch!;
        const result = await deps.linkGroup(chatId!, tripSlug!);
        succeeded = result.ok;
        ackText = result.ok ? "Lenket." : result.error;
      }

      await answerTelegramCallbackQuery({
        credentials: telegramCredentials,
        callbackQueryId: query.id,
        text: ackText,
        fetch: telegramFetch,
      }).catch(() => {});

      if (succeeded && query.message) {
        await editTelegramMessageReplyMarkup({
          credentials: telegramCredentials,
          chatId: query.message.chat.id,
          messageId: query.message.messageId,
          replyMarkup: undefined,
          fetch: telegramFetch,
        }).catch(() => {});
      }
    } catch (err) {
      console.error("eve-marcel: callback handler failed —", err);
      await answerTelegramCallbackQuery({
        credentials: telegramCredentials,
        callbackQueryId: query.id,
        text: "Feilet — prøv igjen.",
        fetch: telegramFetch,
      }).catch(() => {});
    }
  };
}

export default telegramChannel({
  // ORB-101: this channel now listens on an INNER path. The public webhook URL is unchanged and is
  // owned by agent/channels/telegram-webhook.ts, which reads live-location `edited_message` updates
  // (which eve 0.32.0 drops) and forwards every update here untouched. No setWebhook change: the
  // URL Telegram posts to is the same one it always has been.
  route: TELEGRAM_INNER_ROUTE,
  botUsername: botUsername(),
  credentials: telegramCredentials as {
    botToken: TelegramBotToken;
    webhookSecretToken: TelegramWebhookSecretToken;
  },
  uploadPolicy: TELEGRAM_UPLOAD_POLICY,
  // Routes Bot API calls through the squid proxy via eve's documented per-call seam.
  api: { fetch: telegramFetch },
  // Fully overrides eve's default dispatch — see this file's own top-of-file doc comment for
  // why: a private-admin door plus a gatekeeper-driven group door, neither of which matches
  // eve's default group-mention/command dispatch.
  onMessage: createOnMessage(defaultDoorDeps),
  // The veto AND group-link-offer buttons' shared tap handler — see this file's own
  // "Callback-query wiring" section above.
  onCallbackQuery: createOnCallbackQuery(defaultTelegramCallbackDeps),
  events: {
    // ORB-112 — the model's own reply, rendered as Telegram HTML. See onMessageCompleted below,
    // and read its doc comment before touching this line: supplying "message.completed" REPLACES
    // eve's default handler, and the default's whole job is the post that makes the reply
    // visible.
    "message.completed": onMessageCompleted,
    // LAR-53-s1 — a capped gateway key says so instead of failing generically. Same trap as
    // `message.completed` above: supplying a handler REPLACES eve's default, so both of these
    // reproduce the default's own text for every non-budget failure.
    "turn.failed": onTurnFailed,
    "session.failed": onSessionFailed,
  },
});

/**
 * LAR-53-s1 — what Marcel says on Telegram when his gateway key hits its cap.
 *
 * Same condition, same sentence and the same reasoning as eve-saga's telegram door
 * (`services/chief-of-staff/agent/channels/telegram.ts`, read its docblock for the fuller
 * story) — this is a DIFFERENT mechanism from Marcel's own `BUDGET_EXCEEDED_ADMIN_TEXT` above,
 * which is a local token breaker checked BEFORE the model is ever called; this refusal is
 * eve's own report of the model call itself hitting the gateway's spend cap. Only the dialect
 * differs: eve words its own default failure text slightly differently per channel, and the
 * non-budget path has to reproduce THIS channel's version.
 *
 * Posted as a plain string, not through `mdToTelegramHtml`: the sentence carries no markdown,
 * and eve's own failure posts are plain strings too, so the non-budget path stays identical to
 * what the chat saw before.
 */
const BUDGET_EXCEEDED_TEXT =
  "I have hit my spending cap — nothing was done. It resets with the next budget period, or you can raise the cap.";

const FAILURE_OPTIONS = { refusalText: BUDGET_EXCEEDED_TEXT, dialect: "telegram" } as const;

/** The post surface these handlers need — eve's `TelegramEventContext` satisfies it. */
interface FailureChat {
  readonly telegram: { post(message: unknown): Promise<unknown> };
}

/** `turn.failed` — EXPORTED for tests, the same convention as `onMessageCompleted` below. */
export async function onTurnFailed(data: FailureEventData, channel: FailureChat): Promise<void> {
  const response = respondToTurnFailed(data, FAILURE_OPTIONS);
  if (response.kind === "silent") return;
  if (response.kind === "budget-refusal") {
    console.warn("eve-marcel telegram: gateway budget exceeded — answered with the fixed refusal; nothing was executed");
  }
  await channel.telegram.post(response.text);
}

/**
 * `session.failed` — a budget refusal is terminal, so eve emits it right after `turn.failed`
 * for the same fault. `onTurnFailed` already answered; this stays quiet so a capped turn
 * produces exactly one sentence. Everything else keeps eve's default text.
 */
export async function onSessionFailed(data: FailureEventData, channel: FailureChat): Promise<void> {
  const response = respondToSessionFailed(data, FAILURE_OPTIONS);
  if (response.kind === "silent") return;
  await channel.telegram.post(response.text);
}

/**
 * ORB-112 — deliver the model's reply as Telegram HTML instead of raw markdown.
 *
 * Marcel's structured answers arrived in the NYC group as literal `**Fly (SAS, business…)**`.
 * eve's default poster sends `text` with no `parse_mode`, so markdown renders as itself, and
 * eve's own context block already asks the model not to use markdown — which it does anyway,
 * every time. So the conversion happens here, on the way out, where it is a fact.
 *
 * ⚠️ DELIVERY FIRST, AND NOTHING BEFORE IT. Supplying `"message.completed"` REPLACES eve's
 * default handler (`{...defaultEvents, ...events}` inside `telegramChannel`), and the default's
 * entire job is the `telegram.post` that makes the assistant's reply visible. eve-saga shipped
 * exactly this override without the post on 2026-08-17 and every Telegram reply went silently
 * undelivered while raw sends kept working and masked it. Mirrors `defaultEvents`: post unless
 * the turn is interim tool-call narration or empty.
 *
 * Exported because the outage above happened precisely because nothing exercised the function.
 */
export async function onMessageCompleted(
  data: { finishReason: string; message?: string | null },
  channel: { telegram: { post(message: unknown): Promise<unknown> } },
): Promise<void> {
  if (data.finishReason === "tool-calls" || !data.message) return;

  // Chunked here rather than left to eve's `post`: its own splitter passes the body's extra
  // fields to the FIRST chunk only (`e === 0 ? {...n, text: a} : {text: a}`), so every chunk
  // after the first would lose `parse_mode` and arrive as visible tag soup. Splitting on
  // newlines is safe because `mdToTelegramHtml` never opens a tag on one line and closes it on
  // another — see @lares/agent-kit's telegram-markdown.ts.
  for (const chunk of splitTelegramHtml(mdToTelegramHtml(data.message))) {
    await channel.telegram.post({ text: chunk, parse_mode: "HTML" });
  }
}
