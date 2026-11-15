/**
 * agent/instructions/clock.ts — gives the chief of staff the current time, once per turn.
 *
 * PER TURN, not per conversation: a Telegram DM session lives up to a calendar day
 * (`lib/telegram-rotation.ts`) and a Slack thread longer still, so a per-SESSION clock would go
 * stale mid-conversation and reintroduce the bug with a smaller error. And not per model call
 * either: eve 1.0 runs a dynamic instruction before EVERY model call, and a clock that moved
 * between two calls of one turn would change the system prompt's bytes mid-turn. The block is
 * therefore built once per turn (`zz-cache-boundary.ts` keeps it in a memo keyed on the turn).
 *
 * WHERE THE TEXT GOES. eve 1.0 has one ordering for this directory, the filename, and no
 * separate "per turn" group that lands after the per-conversation one (0.60.1 had both). A
 * block emitted from here would sit before the standing facts and the cache marker, and its
 * changing bytes would re-bill the whole system prompt on every turn. So this file only BUILDS
 * the block: `zz-cache-boundary.ts`, the last file in the directory, emits it after the marker,
 * where it always was. The default export contributes nothing, on purpose.
 *
 * — the zone is the OWNER's, not a constant. `ownerTz` answers trip → Slack profile →
 * home from one resolver the whole fleet shares (`lib/owner-clock.ts`, cached 5 min), so on a New
 * York trip the date and time the agent states are the ones on the owner's phone — and the same ones the
 * slot schedules fire on and the proactivity gate's quiet hours are measured against. Telling the
 * model one clock while the fleet acts on another is how "i kveld" stops meaning anything.
 *
 * Never throws: a resolver that fails takes its turn with it, and there is no state to read
 * here — just a clock — so the only way this errors is a bug in the formatter, which must not
 * cost the chief of staff its whole turn. `ownerTz` carries the same guarantee on its own side
 * (a failed lookup is the home timezone, logged once), so the catch below is the second net.
 *
 * The `precision` argument is passed EXPLICITLY, not left to `buildClockMarkdown`'s default,
 * because that default is a deliberate choice and this line is where a future change to it would
 * land. eve merges every system instruction into ONE system message behind a SINGLE prompt-cache
 * breakpoint (`@lares/agent-kit/clock`'s header; unchanged in eve 1.0:
 * `dist/src/harness/model-call/request.js`, `mergeSystemInstructions`), which is why this block
 * sits after the cache marker. The safe default while the owner is away is `"minute"`,
 * unchanged: nothing here switches it.
 */
import { defineDynamic } from "eve/instructions";

import { buildClockMarkdown, DEFAULT_CLOCK_PRECISION } from "@lares/agent-kit/clock";

import { ownerTz } from "../../lib/owner-clock.js";

/** The clock block for this turn; "" when it could not be built. Called by `zz-cache-boundary.ts`. */
export async function clockBlock(): Promise<string> {
  try {
    return buildClockMarkdown(new Date(), await ownerTz(), DEFAULT_CLOCK_PRECISION);
  } catch (err) {
    console.error("chief-of-staff: clock resolver failed — this turn has NO date context", err);
    return "";
  }
}

export default defineDynamic(() => null);
