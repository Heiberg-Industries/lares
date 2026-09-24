/**
 * The ported studio pipeline (ORB-135).
 *
 * `lib/studio/pipeline.ts` is a verbatim port, so these tests do not re-prove the algorithm
 * the old runtime's suite already proves (`services/agent-runtime/tests/studio-pipeline.test.ts`
 * and friends). They pin the four things the CUTOVER can break and that Task 5 wires against:
 * the run shape it renders and stores, the grounding string it must relay, and the two ends of
 * the fail-soft behaviour — the one case that throws and the one that degrades.
 *
 * NOTE ON THE BRIEF'S FAKES: the task brief's `consensus` fake was an object with a `.gather()`
 * method returning `{grounded, notes, text}`. No such shape exists. `StudioPipelineDeps.consensus`
 * is a BARE async function `(brief) => Promise<string>` (`lib/studio/types.ts:16`), and the
 * pipeline calls `await deps.consensus(brief)` (`pipeline.ts:22`). Every fake below is therefore
 * a plain async function. The house rule applies: the test matches the ported source.
 */
import { describe, it, expect, vi } from "vitest";
import { runStudioPipeline } from "../lib/studio/pipeline.js";
import { DEFAULT_LENSES } from "../lib/studio/lenses.js";
import type { Lens } from "../lib/studio/types.js";

const LENSES: Lens[] = [
  { id: "l1", name: "L1", instruction: "x" },
  { id: "l2", name: "L2", instruction: "y" },
];

/** Proposers emit one idea each; the critic culls l2-0 below the coherence floor; the
 *  director curates the survivor and writes the baseline. */
function fakeLlm(prompt: string): Promise<string> {
  if (prompt.startsWith("ROLE: PROPOSER — L1"))
    return Promise.resolve('{"ideas":[{"title":"Wild A","body":"aa","oddsTypical":0.1}]}');
  if (prompt.startsWith("ROLE: PROPOSER — L2"))
    return Promise.resolve('{"ideas":[{"title":"Incoherent B","body":"bb","oddsTypical":0.1}]}');
  if (prompt.startsWith("ROLE: CRITIC"))
    return Promise.resolve('{"scores":[{"id":"l1-0","coherence":0.9,"novelty":0.8,"relevance":0.7},{"id":"l2-0","coherence":0.1,"novelty":0.9,"relevance":0.5}]}');
  if (prompt.startsWith("ROLE: DIRECTOR"))
    return Promise.resolve('{"spread":[{"id":"l1-0","rationale":"bold"}],"baseline":{"title":"Safe","body":"obvious","rationale":"default"}}');
  throw new Error(`unexpected prompt: ${prompt.slice(0, 30)}`);
}

describe("runStudioPipeline (ported)", () => {
  /** The whole contract Task 5's tool renders and stores: outliers + exactly one baseline,
   *  with the critic's scores carried onto the items. If the port dropped a stage, this fails. */
  it("returns surviving outliers plus exactly one baseline, scores carried through", async () => {
    const run = await runStudioPipeline("three wedges for murmur", {
      consensus: async () => "the obvious take",
      llm: fakeLlm,
      lenses: LENSES,
      critics: 1,
    });

    expect(run.brief).toBe("three wedges for murmur");
    const outliers = run.spread.filter((s) => s.kind === "outlier");
    const baselines = run.spread.filter((s) => s.kind === "baseline");
    expect(outliers.map((o) => o.title)).toEqual(["Wild A"]); // "Incoherent B" culled by the floor
    expect(outliers[0]!.novelty).toBeCloseTo(0.8);
    expect(baselines).toHaveLength(1);
    expect(baselines[0]!.title).toBe("Safe");
  });

  /**
   * Grounding travels on `StudioRun.consensus` — a plain string — and NOWHERE else. That
   * string is the only evidence `renderSpread` has when it decides whether to tell Bendik she
   * found Atlas context, which is what her persona's "relay, don't guess" rule depends on. The
   * brief tested this by diffing two whole runs; asserting the field itself is what actually
   * matters, and it says which field Task 5 must not drop when it persists the run.
   */
  it("carries the consensus string onto the run verbatim, grounded or not", async () => {
    const deps = { llm: fakeLlm, lenses: LENSES, critics: 1 };
    const grounded = await runStudioPipeline("brief", {
      ...deps, consensus: async () => "zero7 is an agentic AI consultancy",
    });
    const ungrounded = await runStudioPipeline("brief", {
      ...deps, consensus: async () => "(no prior material found in the Atlas for this brief)",
    });

    expect(grounded.consensus).toBe("zero7 is an agentic AI consultancy");
    expect(ungrounded.consensus).toBe("(no prior material found in the Atlas for this brief)");
  });

  /**
   * The pipeline's ONE hard throw (`pipeline.ts:42`). The brief asserted the opposite — that
   * junk from the LLM resolves — which is false for the all-proposers-failed case. Pinned so a
   * future "make it fail-soft everywhere" edit has to be a deliberate decision: an empty spread
   * presented as a result would be worse than an error, because she would appear to have
   * thought and come back with nothing.
   */
  it("throws when EVERY proposer fails — an empty spread is not a result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(runStudioPipeline("brief", {
        consensus: async () => "c",
        llm: async () => "not json at all",
        lenses: LENSES,
        critics: 1,
      })).rejects.toThrow(/every proposer failed/);
      expect(warn).toHaveBeenCalledTimes(LENSES.length); // each lens warned before being dropped
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The valuable half of the degradation story: one malformed model reply must not cost her the
   * run. Critics and the director both return junk, so the critics fall back to neutral scores
   * and the director falls back to the deterministic novelty pick — and the spread STILL ends
   * with exactly one baseline, verified against `pipeline.ts:107` (the baseline is pushed
   * unconditionally, from `picked?.baseline` or the hardcoded default).
   */
  it("survives junk critics and a junk director, still returning one baseline", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const run = await runStudioPipeline("brief", {
        consensus: async () => "c",
        llm: async (p: string) => (p.startsWith("ROLE: PROPOSER")
          ? '{"ideas":[{"title":"An idea","body":"why","oddsTypical":0.2}]}'
          : "not json at all"),
        lenses: LENSES,
        critics: 1,
      });

      const outliers = run.spread.filter((s) => s.kind === "outlier");
      const baselines = run.spread.filter((s) => s.kind === "baseline");
      expect(outliers.length).toBeGreaterThan(0);
      expect(baselines).toHaveLength(1);
      expect(baselines[0]!.title).toBe("The conventional approach"); // the hardcoded fallback
      expect(outliers[0]!.rationale).toBe("(selected by novelty)");  // the deterministic pick
      expect(outliers[0]!.coherence).toBe(0.5);                      // NEUTRAL, not culled
      expect(warn.mock.calls.some(([m]) => String(m).includes("director failed"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * What one run COSTS, when the caller omits `lenses`/`critics` — which is exactly how Task 5's
   * tool will call it. Six proposer calls plus three critic calls plus one director call = ten
   * paid model calls per brief. Pinned because that number is a budget fact, and because it
   * proves `DEFAULT_LENSES` survived the port and is actually reached.
   */
  it("defaults to 6 lenses and 3 critics — ten model calls per brief", async () => {
    const prompts: string[] = [];
    await runStudioPipeline("brief", {
      consensus: async () => "c",
      llm: async (p: string) => {
        prompts.push(p);
        if (p.startsWith("ROLE: PROPOSER")) return '{"ideas":[{"title":"t","body":"b","oddsTypical":0.2}]}';
        if (p.startsWith("ROLE: CRITIC")) return '{"scores":[]}';
        return '{"spread":[],"baseline":{"title":"B","body":"b","rationale":"r"}}';
      },
    });

    expect(DEFAULT_LENSES).toHaveLength(6);
    expect(prompts.filter((p) => p.startsWith("ROLE: PROPOSER"))).toHaveLength(6);
    expect(prompts.filter((p) => p.startsWith("ROLE: CRITIC"))).toHaveLength(3);
    expect(prompts.filter((p) => p.startsWith("ROLE: DIRECTOR"))).toHaveLength(1);
  });
});
