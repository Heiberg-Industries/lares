// Q4's other half: a per-turn instruction resolver that reads eve session state. If eve refuses
// state access here, eve logs the failure and omits this fragment — the marker simply never reaches
// the system prompt and the eval reports NO rather than crashing.
//
// A directory entry, not agent/instructions.ts: the flat agent/instructions.md and this directory
// coexist by design (eve/docs/instructions.mdx, "Split instructions across a directory"), so the
// fixture's existing persona is untouched.
import { defineDynamic, defineInstructions } from "eve/instructions";
import { language } from "../../lib/seam-state.js";

export default defineDynamic({
  events: {
    "turn.started": async () => defineInstructions({ markdown: `SEAM_LANG=${language.get()}` }),
  },
});
