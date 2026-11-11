// The reading half of the session-state probe: an instruction resolver that reads eve session state
// before every model call. If eve refused state access here, the resolver would throw and the turn
// would fail, and the eval would report NO.
//
// A directory entry, not agent/instructions.ts: the flat agent/instructions.md and this directory
// coexist by design (eve/docs/instructions.mdx, "Split instructions across a directory"), so the
// fixture's existing persona is untouched.
import { defineDynamic, defineInstructions } from "eve/instructions";
import { language } from "../../lib/seam-state.js";

export default defineDynamic(() => defineInstructions({ content: `SEAM_LANG=${language.get()}` }));
