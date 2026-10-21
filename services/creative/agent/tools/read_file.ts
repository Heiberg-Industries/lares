// Removes eve's built-in `read_file` tool from the harness.
//
// Every read the creative agent legitimately needs goes through the authored `vault_*` tools,
// which are store-relative and traversal-safe: they resolve inside the Atlas store root and
// nowhere else. `read_file` takes absolute paths, so keeping it would add exactly one thing
// on top — reach into `/run/secrets`, the workflow database's connection string in the
// environment, or any other service's files on the box — and nothing the agent has a use for.
//
// The agent also never reads the Atlas itself in the flow that matters: the studio does the search
// and hands back a grounding line the agent relays verbatim ("relay, don't guess"). A general file
// reader invites it to go and check, which is precisely the guessing that rule forbids.
//
// eve resolves this by FILENAME. A typo does NOT fail `eve build` — verified on eve 0.32: a
// bogus `agent/tools/bahs.ts` compiled clean (0 errors, 0 warnings) and landed in the
// manifest's `disabledFrameworkTools`. The name check lives in `resolveRuntimeAgentGraph`,
// so a typo throws when the container resolves its agent graph, not on the build.
// `tests/tool-harness.test.ts` is what makes it loud instead — see that file's header.
import { disableTool } from "eve/tools";

export default disableTool();
