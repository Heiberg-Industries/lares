/**
 * `renderSpread` (`lib/studio/render.ts`, ORB-135) — the only thing ported out of the old
 * runtime's `hands/studio.ts`. It is what turns a run into the message Bendik actually reads,
 * so losing it at the cutover would be a silent behaviour regression rather than a build break.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSpread } from "../lib/studio/render.js";
import { makeAtlasConsensus } from "../lib/studio/atlas-consensus.js";
import type { StudioRun, StudioSpreadItem } from "../lib/studio/types.js";

const item = (over: Partial<StudioSpreadItem>): StudioSpreadItem => ({
  id: "l1-0", lens: "l1", title: "An idea", body: "why it works", oddsTypical: 0.2,
  coherence: 0.9, novelty: 0.75, relevance: 0.8, kind: "outlier", rationale: "bold", ...over,
});

const run = (consensus: string): StudioRun => ({
  brief: "three wedges for murmur",
  consensus,
  spread: [
    item({}),
    item({ id: "l2-0", title: "Another idea", novelty: 0.6, rationale: "orthogonal" }),
    item({ id: "baseline", kind: "baseline", title: "The conventional approach", body: "the safe default", rationale: "to judge the outliers against" }),
  ],
});

describe("renderSpread", () => {
  /** The shape of the message: brief, grounding line, numbered outliers with their novelty,
   *  then the baseline called out as the baseline. Numbering is what lets Bendik answer "do 2". */
  it("numbers the outliers, shows novelty, and labels the baseline", () => {
    const out = renderSpread(run("zero7 is an agentic AI consultancy"));

    expect(out.startsWith("*Ideas for:* three wedges for murmur")).toBe(true);
    expect(out).toContain("*1. An idea*  _(novelty 0.75)_");
    expect(out).toContain("*2. Another idea*  _(novelty 0.60)_");
    expect(out).toContain("*Baseline (the obvious): The conventional approach*");
    expect(out).not.toContain("*3. The conventional approach*"); // the baseline is never an outlier
  });

  /**
   * The grounding line is ground truth the narrating model cannot otherwise see — it receives
   * the rendered spread, not the consensus. Without it she guesses, and the observed failure was
   * her claiming "the Atlas came up empty" on a run that had grounded fully on a brand note.
   */
  it("says grounded when there was consensus material", () => {
    expect(renderSpread(run("zero7 is an agentic AI consultancy")))
      .toContain("_Grounded in the Atlas (found business context for this brief)._");
  });

  /**
   * THE COUPLING TEST, and the reason it is worth a temp directory: `renderSpread` decides
   * "grounded" by prefix-testing `run.consensus` against a sentinel string that is authored in a
   * DIFFERENT module (`consensus.ts`). Nothing but this test connects the two. Rather than
   * hardcode the sentinel on both sides, it produces the real one — a real Atlas with no match,
   * through the real adapter — and feeds it to the real renderer. Change either string alone and
   * this goes red; without it, the failure is silent and lands as her lying about grounding.
   */
  it("says NOT grounded for the sentinel the real Atlas consensus actually emits", async () => {
    const root = mkdtempSync(join(tmpdir(), "calliope-atlas-render-"));
    try {
      mkdirSync(join(root, "_brands"), { recursive: true });
      writeFileSync(join(root, "_brands", "zero7.md"), "# Zero7\nAn agentic AI consultancy.\n");
      const sentinel = await makeAtlasConsensus({ root })("quantum submarine liturgy");

      const out = renderSpread(run(sentinel));
      expect(out).toContain("_No Atlas note matched this brief");
      expect(out).not.toContain("_Grounded in the Atlas");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** An empty consensus string is also not grounding — the `!!run.consensus` half of the test.
   *  Cheap, and it stops a "simplify to a prefix check" edit from claiming grounding on "". */
  it("says NOT grounded for an empty consensus", () => {
    expect(renderSpread(run(""))).toContain("_No Atlas note matched this brief");
  });
});
