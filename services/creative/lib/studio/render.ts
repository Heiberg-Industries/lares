/**
 * Rendering a studio run as the markdown spread Calliope actually says out loud.
 *
 * Ported from `services/agent-runtime/lib/adapters/hands/studio.ts` (ORB-135). ONLY
 * `renderSpread` is ported: `makeStudioHand` from the same file depends on the old runtime's
 * `Capability` / `HandToolSpec` registry types, which have no eve equivalent — eve's
 * `defineTool()` replaces that wiring entirely.
 *
 * Losing this function at the cutover would be a silent behaviour regression: without it the
 * spread reaches Slack as raw JSON, and the grounding line below — the one piece of ground
 * truth the narrating model cannot otherwise see — disappears.
 */
import type { StudioRun } from "./types.js";

/**
 * The exact sentinel `makeBrainConsensus` returns when the Atlas matched nothing. The
 * grounding line is decided by a prefix test against it, so the two modules are coupled by
 * this string; `tests/studio-consensus.test.ts` pins the coupling so an edit to one cannot
 * silently flip the other's meaning.
 */
const NO_MATERIAL_PREFIX = "(no prior";

/** Render a run as a markdown spread for the brain to narrate (and for the future UI). */
export function renderSpread(run: StudioRun): string {
  const outliers = run.spread.filter((s) => s.kind === "outlier");
  const baseline = run.spread.find((s) => s.kind === "baseline");
  // Grounding line = ground truth the narrating brain otherwise can't see (it only gets this
  // rendered spread, not the consensus). Without it, Calliope guesses and wrongly claims
  // "Atlas came up empty" even when the proposers grounded fully on a brand note.
  const grounded = !!run.consensus && !run.consensus.startsWith(NO_MATERIAL_PREFIX);
  const groundingLine = grounded
    ? "_Grounded in the Atlas (found business context for this brief)._"
    : "_No Atlas note matched this brief — ran on the brief alone; point me at the right brand if I missed it._";
  const lines: string[] = [`*Ideas for:* ${run.brief}`, groundingLine, ""];
  outliers.forEach((o, i) => {
    lines.push(`*${i + 1}. ${o.title}*  _(novelty ${o.novelty.toFixed(2)})_`);
    lines.push(o.body);
    lines.push(`— ${o.rationale}`, "");
  });
  if (baseline) {
    lines.push(`*Baseline (the obvious): ${baseline.title}*`);
    lines.push(baseline.body);
    lines.push(`— ${baseline.rationale}`);
  }
  return lines.join("\n");
}
