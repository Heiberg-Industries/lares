/**
 * Saga's clock.
 *
 * She did not have one. eve injects no date into the prompt (verified against 0.32.0's dist),
 * `defineAgent` declares none, and `agent/instructions.md` is static markdown captured at
 * build time. So every absolute date she produced was a guess from training priors.
 *
 * That is not a theoretical exposure — it has now cost two reminders:
 *
 *   - 2026-08-16: "in 3 minutes" arrived dated JUNE 2025 (right wall-clock time, hallucinated
 *     date) and fired instantly. Caught, because a past `dueAt` is obviously wrong;
 *     `agent/tools/remind_set.ts` grew a guard whose error message carries the current time.
 *   - 2026-08-17: "i morgen", said on the 17th, was stored as the **20th**. NOT caught — the
 *     guard is one-sided, and a wrong guess landing in the future looks exactly like a
 *     correct one. Saga then confirmed "i morgen kl. 07:00", echoing the request rather than
 *     the stored value, so the disagreement was invisible from the outside.
 *
 * The guard treats the symptom in one direction. This is the root: give the model the time.
 *
 * Rendered fresh on every `turn.started` (see `agent/instructions/clock.ts`), never cached —
 * a session can outlive a day boundary, and a stale "today" is the same bug wearing a
 * different hat. Kept as a pure function of `now` so the crossings that actually break date
 * arithmetic — midnight, and CET/CEST — are unit-testable rather than hoped for.
 *
 * ORB-193: the zone is now a PARAMETER, defaulting to Oslo. Saga's resolver passes the owner
 * clock (`services/chief-of-staff/lib/owner-clock.ts`'s `ownerTz()`), so on a New York trip the date and
 * time she states are the ones on Bendik's own phone — the same clock her slot schedules and the
 * proactivity gate's quiet hours read. Giving the model ONE date and the fleet ANOTHER is how a
 * "tonight" stops meaning anything, and it is the class ORB-124/128/204 already paid for.
 *
 * ## What this block costs the prompt cache — measured, not assumed (2026-09-18)
 *
 * In plain language: every turn carries several blocks of instructions to the model — the
 * persona, the tool descriptions, the standing facts, and this clock. Before any of it reaches
 * the model, eve glues ALL of these blocks into ONE piece of text, and a model provider's prompt
 * cache treats that whole piece as one all-or-nothing unit: if it is byte-for-byte identical to
 * last turn's, most of it is billed at a fraction of the price; if even one character anywhere in
 * it differs, the whole thing is billed at full price, from the top. This clock is rendered fresh
 * on every turn, to the minute (see the header above — that is deliberate and stays deliberate).
 * So today, on every single turn, the model provider re-bills the ENTIRE system prompt — persona,
 * tools and standing facts included — because of this block alone.
 *
 * Read out of the installed eve 0.32.0 dist (`node_modules/.pnpm/eve@0.32.0…/node_modules/eve/dist`
 * — the pnpm-hashed patch suffix varies by install), not assumed:
 *   - `shared/dynamic-tool-definition.js`'s `ALLOWED_DYNAMIC_INSTRUCTION_EVENTS` is
 *     `new Set(["session.started", "turn.started"])` — a dynamic instructions resolver can only
 *     fire once per session or once per turn, nothing finer-grained exists.
 *   - `context/keys.d.ts` documents `SessionDynamicInstructionsKey` as "Persists for the session
 *     lifetime" and `TurnDynamicInstructionsKey` as "Replaced each turn". This module's resolver
 *     (`agent/instructions/clock.ts`) is registered on `turn.started`.
 *   - `context/dynamic-instruction-lifecycle.js`'s `buildDynamicInstructionMessages` concatenates
 *     every session-scoped entry first, then every turn-scoped entry, into one array — so this
 *     clock's block sits beside the (session-scoped) persona's, not apart from it.
 *   - `public/definitions/instructions.d.ts` documents `defineInstructions` as lowering the
 *     returned markdown to "a single `{ role: "system" }` message" per resolver — confirmed by
 *     `dynamic-instruction-lifecycle.js`'s own `lowerToSystemMessage`, which returns exactly that
 *     shape.
 *   - `harness/tool-loop.js` pushes every dynamic instruction message into the SAME system-role
 *     array the persona and the static `instructions.md` use (variable `Y` in the minified dist),
 *     never into the separate user/assistant message array (`X`/`ae`). Its `mergeSystemInstructions`
 *     then joins every entry of that combined array into ONE system message with
 *     `.map(m => m.content).join("\n\n")` — one string, not several blocks.
 *   - `harness/prompt-cache.js`'s `applySystemCacheBreakpoint` marks only the LAST entry of that
 *     array with the provider's cache-control metadata, and it runs BEFORE the join above. Because
 *     the join then collapses every entry into one string, the resulting single merged message
 *     carries that one cache breakpoint over its ENTIRE content — a byte changing anywhere inside
 *     it, not only at the end, invalidates the whole cached prefix.
 *
 * So: at `precision: "minute"` (today's default, unchanged by this file), the whole system prompt
 * is re-billed at full, uncached price on every turn, because this block's minute and its
 * `now.toISOString()` differ from the previous turn's. A coarser `precision` changes how often
 * this block's bytes change and therefore how often that re-bill happens — see {@link ClockPrecision}.
 *
 * What this does NOT measure: no live model call was made to produce this finding and no token
 * count was read off a real API response — every claim above is a source read, not a run. The
 * actual token saving from a coarser precision is an ESTIMATE until it is measured by hand. The
 * runnable probe: send the same short conversation through the real gateway twice, a few seconds
 * apart (well inside the cache's TTL and, for the second call, well inside the same clock hour) —
 * once with the resolver passing `precision: "minute"`, once with `"hour"` — and compare the
 * second call's `cache_read_input_tokens` (or the gateway's equivalent field) each time: at
 * `"minute"` it should read close to 0 cached tokens on the second call; at `"hour"` it should
 * read close to the full system prompt's token count as cached. This is the offline half of wave
 * 0's probe 0.5 ("tokens re-billed per turn"); the live half is LAR-70's, run by the controller
 * after this wave.
 *
 * The choice of precision is Owner decision B2 (wave 4 plan, track 4B): the safe default while the
 * owner is unreachable is `"minute"`, unchanged — nothing in this file switches it.
 */
import { clockParts } from "./owner-clock.js";

const DEFAULT_TZ = "Europe/Oslo";

/**
 * How precisely the clock block states the time.
 *
 *   - `"minute"` — today's behaviour: the owner's date, weekday, HH:MM and the UTC instant.
 *   - `"hour"`   — the same, with the minute and the UTC instant replaced by the hour it falls
 *     in ("between 14:00 and 15:00"), so a stale system-prompt cache is only invalidated once an
 *     hour instead of once a minute.
 *   - `"day"`    — the owner's date and weekday only; no time of day at all.
 *
 * This is a CACHE decision, not a formatting one: eve merges every dynamic instruction into one
 * system message with a single cache breakpoint at its end (see the header above), so this
 * block's bytes decide whether the whole system prompt — persona, tools and memory included — is
 * re-billed on every turn. Coarsening it also costs the model something real: it can no longer
 * resolve "om en time" to the minute at `"hour"`, and loses the time of day entirely at `"day"`.
 */
export type ClockPrecision = "minute" | "hour" | "day";

/** Today's behaviour, unchanged. Coarsening it is an owner decision (wave 4, B2) — nothing in
 *  this file changes the default. */
export const DEFAULT_CLOCK_PRECISION: ClockPrecision = "minute";

/**
 * The block prepended to every turn. Deliberately short — it rides on every single turn, so
 * it earns its tokens by being the minimum needed to resolve a relative expression into an
 * absolute one:
 *
 *   - the owner's DATE, for "i morgen" / "på fredag"
 *   - the WEEKDAY, because "på fredag" is meaningless without knowing today is Monday
 *   - the owner's TIME, for "om en time" and for deciding whether a same-day slot has passed
 *   - the TIMEZONE, named — `tz` is stated verbatim, because an unlabelled time invites a
 *     UTC/local mix-up and a mislabelled one is worse
 *   - the UTC instant, so an ISO `dueAt` with an offset can be built without inferring
 *     whether the owner's zone is currently +01:00 or +02:00
 */
export function buildClockMarkdown(
  now: Date = new Date(),
  tz: string = DEFAULT_TZ,
  precision: ClockPrecision = DEFAULT_CLOCK_PRECISION,
): string {
  const { date, hhmm, weekday } = clockParts(now, tz);

  if (precision === "day") {
    return [
      "## Now",
      `It is ${weekday} ${date} (${tz}).`,
      "Resolve every relative time the user gives you (\"i morgen\", \"på fredag\", \"om en time\")",
      "against this, and never against your own sense of the date — you do not have one.",
      "When you set or report a time, state the absolute date back, not the words the user used.",
      "You are not told the time of day; if a decision depends on it, ask or use a tool that reports it.",
    ].join("\n");
  }

  if (precision === "hour") {
    const hh = hhmm.slice(0, 2);
    const nextHh = String((Number(hh) + 1) % 24).padStart(2, "0");
    return [
      "## Now",
      `It is ${weekday} ${date}, between ${hh}:00 and ${nextHh}:00 (${tz}).`,
      "Resolve every relative time the user gives you (\"i morgen\", \"på fredag\", \"om en time\")",
      "against this, and never against your own sense of the date — you do not have one.",
      "When you set or report a time, state the absolute date back, not the words the user used.",
    ].join("\n");
  }

  return [
    "## Now",
    `It is ${weekday} ${date}, ${hhmm} (${tz}). In UTC that instant is ${now.toISOString()}.`,
    "Resolve every relative time the user gives you (\"i morgen\", \"på fredag\", \"om en time\")",
    "against this, and never against your own sense of the date — you do not have one.",
    "When you set or report a time, state the absolute date back, not the words the user used.",
  ].join("\n");
}

/**
 * One stored instant, rendered as an absolute date on a NAMED clock — the string a confirmation
 * should repeat back.
 *
 * This exists because of the second half of the 2026-08-17 failure. `remind_set` returned
 * only `dueAt` as a UTC ISO string; Saga then told Bendik "i morgen kl. 07:00", paraphrasing
 * his own request rather than reading back what was stored. Both halves of the exchange
 * agreed, and the database held a different day. A wrong date is survivable — it is caught
 * the moment it is said out loud. A wrong date confirmed in the user's own words is not.
 *
 * ORB-193 final review: the zone is a PARAMETER. `buildClockMarkdown` above already speaks the
 * OWNER's clock (Saga passes `ownerTz()`), so a hard-coded Oslo here meant the turn told him it was
 * Tuesday 15:00 in New York and the confirmation card under it said Tuesday 21:00 Europe/Oslo — the
 * same instant, described on two clocks, in one exchange. That is the ORB-124/128/204 class exactly:
 * a "tonight" that stops meaning anything. The tz is always NAMED in the output, because an
 * unlabelled time invites a mix-up and a mislabelled one is worse.
 */
export function formatDateTimeIn(when: Date, tz: string = DEFAULT_TZ): string {
  const { date, hhmm, weekday } = clockParts(when, tz);
  return `${weekday} ${date} ${hhmm} (${tz})`;
}

/** {@link formatDateTimeIn} on the home clock. Kept for callers with no owner clock to hand — the
 *  approval-card registry's default, and every agent that has not wired one. */
export function formatOsloDateTime(when: Date): string {
  return formatDateTimeIn(when, DEFAULT_TZ);
}
