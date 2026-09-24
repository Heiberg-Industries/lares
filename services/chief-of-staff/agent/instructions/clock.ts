/**
 * agent/instructions/clock.ts — gives Saga the current time, every turn.
 *
 * eve reads `agent/instructions.md` (the static root file) AND `agent/instructions/` (this
 * directory) together — root content first, then directory entries alphabetically
 * (`node_modules/eve/docs/instructions.mdx`). This directory did not exist before; eve-marcel
 * has had the equivalent since his port (`services/travel/agent/instructions/trip-context.ts`,
 * which injects `## I dag`), and Saga simply never got one.
 *
 * `turn.started`, not `session.started`: eve's compiled types describe `turn.started` output
 * as "Durable turn-scoped instruction messages... Replaced each turn"
 * (`dist/src/context/keys.d.ts`, `TurnDynamicInstructionsKey`). That is required here rather
 * than merely nice — a Telegram DM session lives up to an Oslo day (`lib/telegram-rotation.ts`)
 * and a Slack thread longer still, so a per-SESSION clock would go stale mid-conversation and
 * reintroduce the bug with a smaller error.
 *
 * The first turn of a fresh session is covered. That was doubted once and disproved: ORB-111's
 * investigation showed `workflow_runs.input_cbor` is snapshotted BEFORE resolvers run, so it
 * never shows dynamics on turn 1, while Langfuse's recorded model input for the same turn does
 * carry them. Reading the wrong artifact is what made it look like a hole.
 *
 * ORB-193 — the zone is the OWNER's, not a constant. `ownerTz()` answers trip → Slack profile →
 * home from one resolver the whole fleet shares (`lib/owner-clock.ts`, cached 5 min), so on a New
 * York trip the date and time she states are the ones on Bendik's phone — and the same ones her
 * slot schedules fire on and the proactivity gate's quiet hours are measured against. Telling the
 * model one clock while the fleet acts on another is how "i kveld" stops meaning anything.
 *
 * Never throws: a resolver that fails takes its turn's instructions with it, and there is no
 * state to read here — just a clock — so the only way this errors is a bug in the formatter,
 * which must not cost Saga her whole turn. `ownerTz()` carries the same guarantee on its own side
 * (a failed lookup is the home timezone, logged once), so the catch below is the second net.
 *
 * The `precision` argument is passed EXPLICITLY, not left to `buildClockMarkdown`'s default,
 * because that default is Owner decision B2 (wave 4 plan, track 4B) and this line is where a
 * future change to it would land. `@lares/agent-kit/clock`'s header measures, against the
 * installed eve 0.32 dist, why this matters: every dynamic instruction — this clock included —
 * is merged into ONE system message behind a SINGLE prompt-cache breakpoint, so at
 * `"minute"` precision this block's changing bytes re-bill the WHOLE system prompt (persona,
 * tools, standing facts) on every turn, not just this one. `"hour"` would hold that cache for a
 * whole conversation inside one clock hour, at the cost of no longer resolving "om en time" to
 * the minute — which is exactly the class of bug `clock.ts`'s own header (2026-08-16/17) already
 * paid for once. The safe default while the owner is away is `"minute"`, unchanged: nothing here
 * switches it.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { buildClockMarkdown, DEFAULT_CLOCK_PRECISION } from "@lares/agent-kit/clock";

import { ownerTz } from "../../lib/owner-clock.js";

export default defineDynamic({
  events: {
    "turn.started": async () => {
      try {
        return defineInstructions({
          markdown: buildClockMarkdown(new Date(), await ownerTz(), DEFAULT_CLOCK_PRECISION),
        });
      } catch (err) {
        console.error("eve-saga: clock resolver failed — this turn has NO date context", err);
        return defineInstructions({ markdown: "" });
      }
    },
  },
});
