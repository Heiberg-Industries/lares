// Removes eve's built-in root-only `agent` delegation tool from the harness.
//
// Calliope ALREADY delegates, and she does it through one deliberate seam: `studio_ideate`
// (Task 5), the codified creative team. That pipeline has a shape — proposers, a consensus
// map, one deliberate conventional baseline — and a cost, since every stage is a real model
// call billed through the gateway.
//
// eve's `agent` tool delegates to a fresh copy of the ROOT agent: same instructions, same
// tools, fresh history. So a child would be another Calliope, who would call the studio
// again. That is an unbounded fan-out of a paid multi-model pipeline with no budget in front
// of it — the 2026-08-14/15 uncapped-retry lesson in a different costume. Her ideation
// concurrency belongs inside the studio, where it is bounded and observable, not in a
// framework primitive that can call itself.
//
// It also breaks curation, which is her actual job: she is supposed to present ONE spread
// verbatim and let Bendik choose, not merge several children's spreads into a favourite.
//
// eve resolves this by FILENAME. A typo does NOT fail `eve build` — verified on eve 0.32: a
// bogus `agent/tools/bahs.ts` compiled clean (0 errors, 0 warnings) and landed in the
// manifest's `disabledFrameworkTools`. The name check lives in `resolveRuntimeAgentGraph`,
// so a typo throws when the container resolves its agent graph, not on the build.
// `tests/tool-harness.test.ts` is what makes it loud instead — see that file's header.
import { disableTool } from "eve/tools";

export default disableTool();
