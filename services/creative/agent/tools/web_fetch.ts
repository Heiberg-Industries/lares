// Removes eve's built-in `web_fetch` tool from the harness.
//
// Calliope is SEALED — `agent.json` says `{"egress":{"sealed":true}}`, and on the box that is
// enforced by nftables, not by politeness: outbound traffic is denied except to the explicit
// allowlist (the LiteLLM gateway, the box's Postgres). She cannot fetch a URL. Keeping the
// tool would advertise a capability the network layer refuses.
//
// That is worse than it sounds, because a blocked call does not look like "blocked" — it
// surfaces as a connection error the model tends to narrate as "that page doesn't exist" or
// "I couldn't find it". eve-saga hit the same class of thing with `glob`: reached for a tool
// that could not work, got an environment error mid-answer, and had to recover in front of
// the user.
//
// Her grounding comes from the Atlas via the studio, which is the only source she is supposed
// to cite anyway.
//
// eve resolves this by FILENAME. A typo does NOT fail `eve build` — verified on eve 0.32: a
// bogus `agent/tools/bahs.ts` compiled clean (0 errors, 0 warnings) and landed in the
// manifest's `disabledFrameworkTools`. The name check lives in `resolveRuntimeAgentGraph`,
// so a typo throws when the container resolves its agent graph, not on the build.
// `tests/tool-harness.test.ts` is what makes it loud instead — see that file's header.
import { disableTool } from "eve/tools";

export default disableTool();
