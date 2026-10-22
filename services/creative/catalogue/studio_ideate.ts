// Run the studio on a brief. UNGATED — `studio` is a plain `write` in the agent's grants and
// `autonomous` in its autonomy block (agent.json).
//
// IT WAS GATED FOR ONE DAY, AND THE CARD IS WHY IT ISN'T. It first shipped behind a bare
// `always()` approval on the intent that "a studio run is an expensive
// multi-model pipeline, so a confirmation is proportionate". Seeing the first live card
// settled it the other way (the owner's call): the gate had no decision content. The owner is the
// only principal who can reach the agent, had asked for the run in the message directly above,
// and the card asked whether they meant it. Nothing destructive was being prevented — the worst
// case is spend, not damage. It also contradicted the first rule of the persona ("Run first —
// don't gatekeep. A terse brief is not a reason to stall") and, sitting next to `vault_write`,
// it devalued the one gate that does guard something: a gate in front of the harmless teaches
// you to tap without reading.
//
// WHY THE SCOPE MOVED TOO, and why editing `autonomy` alone would have done NOTHING. Under the
// ported governance semantics (@lares/agent-kit/manifest's header, from agent-runtime's
// governance/decide.ts) the scope matrix answers first and a plain `write` is allowed outright;
// autonomy bites ONLY on the confirm class. And `resolveExtensionTool` — the thing that strips
// a gate under `autonomous` — only ever runs on EXTENSION tools. This is a local tool, so
// nothing resolves it against the declaration at runtime: the gate had to come off the code
// here, and the declaration had to move with it or it would have described a gate that no
// longer exists. tests/agent-declaration.test.ts pins both halves.
//
// A STUDIO RUN IS STILL A WRITE, not a read: one run is TEN paid model calls (six proposers,
// three critics, one director) and it INSERTs a `studio_runs` row. `write` is the honest class;
// `read` would understate it.
//
// Ported from `services/agent-runtime/lib/adapters/hands/studio.ts`. There is no studio
// SERVICE to call — the pipeline runs here, from `lib/studio/`, wiring consensus/llm/store
// in-process from the files in that directory.
//
// NOTHING IS READ AT MODULE SCOPE. `makeAtlasConsensus()` resolves `ATLAS_PATH` lazily, on
// each call of the function it returns, so this factory call is safe at the top level of a
// module `eve build` evaluates with no env and no secrets.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { approverFrom, assertApproval } from "../lib/approvals.js";
import { gatewayComplete } from "../lib/llm-complete.js";
import { makeAtlasConsensus } from "../lib/studio/atlas-consensus.js";
import { runStudioPipeline } from "../lib/studio/pipeline.js";
import { renderSpread } from "../lib/studio/render.js";
import { makeStudioStore } from "../lib/studio/store.js";

/** The Atlas-backed grounding step. Constructed once; it reads no env until it is called. */
const consensus = makeAtlasConsensus();

/**
 * The old runtime's `maxTokens: 4096` (registry.ts:184), carried over deliberately rather than
 * left to `gatewayComplete`'s 512-token default. Every stage of the pipeline returns JSON —
 * three ideas with a title and a body per lens, a score row per idea — and a truncated reply
 * does not fail loudly: `extractJson` throws, the stage is DROPPED fail-soft, and if enough
 * stages are cut short the pipeline reports "every proposer failed". A cheap default here
 * would look like a model problem for as long as it took someone to find this line.
 */
const STUDIO_MAX_OUTPUT_TOKENS = 4096;

export default defineTool({
  description:
    "Run the studio on a brief: ground it in the Atlas, run the proposer lenses, score them " +
    "with critics, and return a spread of outlier ideas plus the obvious baseline — with a " +
    "line saying whether the Atlas actually had context for this brief. Expensive (ten model " +
    "calls) — say so if a brief looks like it wants a cheaper answer than a full studio run.",
  inputSchema: z.object({ brief: z.string().min(1) }),
  async execute(input, ctx) {
    // KEPT after the gate came off, and not redundant. With no approval card there is no
    // stray-tap path to close, but this is also the only identity check on the run: it refuses
    // anything that is not an allowlisted, channel-verified Slack principal, which is what
    // keeps ten paid model calls unreachable from any future non-Slack route. It also supplies
    // the `principal` recorded below.
    //
    // `assertApproval` also checks the card this call answered, through the same
    // ledger every gated tool does. There is no card here (this tool is UNGATED), so
    // `assertApprovedCall` always finds no row and passes — the addition is for uniformity with
    // every other tool that re-checks the approver, not because this one has anything to check.
    await assertApproval(ctx, "studio_ideate", input);
    const { brief } = input;
    const approver = approverFrom(ctx.session.auth);
    // Resolve and capture the Slack claim's current member before any paid model work. The
    // capture is single-use and is checked again in a fresh short transaction after generation.
    const store = makeStudioStore(getPool());
    const ownerCapture = await store.captureOwner(approver);

    // The model is NOT named here: `gatewayComplete`'s own precedence is STUDIO_MODEL →
    // AGENT_MODEL → <prefix>-brain (studio stages are the brain purpose).
    // Naming a model here would shadow all three.
    const run = await runStudioPipeline(brief, {
      consensus,
      llm: (prompt: string) => gatewayComplete(prompt, { maxOutputTokens: STUDIO_MAX_OUTPUT_TOKENS }),
    });

    // A refusal here cannot undo paid generation. Preserve the spread, while saying plainly
    // that the history save could not be confirmed. The log contains no brief, generated content or error details.
    let historyConfirmed = true;
    try {
      await store.recordRun(run, ownerCapture);
    } catch {
      historyConfirmed = false;
      console.error("studio: run history save could not be confirmed");
    }

    // The RENDERED spread, never the raw StudioRun. The grounding line it carries is the only
    // Atlas ground truth the narrating model gets; hand it JSON instead and it guesses.
    const rendered = renderSpread(run);
    return historyConfirmed ? rendered : `${rendered}\n\n*I couldn't confirm this run was saved to history.*`;
  },
});
