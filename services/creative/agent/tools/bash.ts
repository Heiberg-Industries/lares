// Removes eve's built-in `bash` tool from the harness.
//
// Calliope's whole job is a brief in and a spread of ideas out: she calls the studio, relays
// its grounding line, presents the result verbatim, and proposes an Atlas write for whatever
// Bendik keeps. Not one step of that is a shell command.
//
// The cost of leaving it on is not hypothetical. `bash` is not sandboxed here (`sandbox:
// null`), so it runs against the container's real filesystem — including `/run/secrets`,
// where the LiteLLM gateway key lives, and the Atlas mount, which she is supposed to reach
// only through the store-relative `atlas_*` tools. Disabled BEFORE her own tools exist
// (Task 5), so there is never a build in which she has a shell on a box with an Atlas mount.
//
// eve resolves this by FILENAME. A typo does NOT fail `eve build` — verified on eve 0.32: a
// bogus `agent/tools/bahs.ts` compiled clean (0 errors, 0 warnings) and landed in the
// manifest's `disabledFrameworkTools`. The name check lives in `resolveRuntimeAgentGraph`,
// so a typo throws when the container resolves its agent graph, not on the build.
// `tests/tool-harness.test.ts` is what makes it loud instead — see that file's header.
import { disableTool } from "eve/tools";

export default disableTool();
