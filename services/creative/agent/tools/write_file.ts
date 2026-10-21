// Removes eve's built-in `write_file` tool from the harness.
//
// The creative agent has exactly one way to write anything down: propose an Atlas note and wait for
// the owner's 👍. `agent.json` says so — `{"capability":"vault","scope":"write-with-confirm",
// "areas":["shared"]}` with `autonomy.vault: "gated"` — and the authored `vault_*` tools
// are what enforce it.
//
// A raw `write_file` is the same capability with the gate missing: it writes wherever it is
// pointed, needs no approval, and is not sandboxed here, so it could put a file into the
// Atlas mount that never passed through the confirm class the declaration promises. The
// persona's "you may propose saving it to the Atlas … it waits for them to tap Approve" would then be a
// description of one path out of two.
//
// eve resolves this by FILENAME. A typo does NOT fail `eve build` — verified on eve 0.32: a
// bogus `agent/tools/bahs.ts` compiled clean (0 errors, 0 warnings) and landed in the
// manifest's `disabledFrameworkTools`. The name check lives in `resolveRuntimeAgentGraph`,
// so a typo throws when the container resolves its agent graph, not on the build.
// `tests/tool-harness.test.ts` is what makes it loud instead — see that file's header.
import { disableTool } from "eve/tools";

export default disableTool();
