// Removes eve's built-in `web_search` tool from the harness.
//
// Same reason as `web_fetch`, one step further out: `web_search` has no local executor at all
// — the model PROVIDER runs it (Exa by default for AI Gateway models). Calliope's calls go
// through the self-hosted LiteLLM gateway, not the Vercel AI Gateway, and she is sealed, so
// there is no provider-side search path for her. The tool would be advertised and never work.
//
// It is also the wrong shape for what she does. Her value is outlier ideas grounded in what
// the portfolio actually knows — the Atlas, searched by the studio, relayed with its grounding
// line. Web results would give her a second, ungrounded source to blend in silently, and
// "relay, don't guess" is the one rule in her persona written to stop exactly that.
//
// eve resolves this by FILENAME. A typo does NOT fail `eve build` — verified on eve 0.32: a
// bogus `agent/tools/bahs.ts` compiled clean (0 errors, 0 warnings) and landed in the
// manifest's `disabledFrameworkTools`. The name check lives in `resolveRuntimeAgentGraph`,
// so a typo throws when the container resolves its agent graph, not on the build.
// `tests/tool-harness.test.ts` is what makes it loud instead — see that file's header.
import { disableTool } from "eve/tools";

export default disableTool();
