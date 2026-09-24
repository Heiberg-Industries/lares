// ORB-278 step 2, Task 8: superseded, not deleted. Until this task this file was
// `resolveExtensionTool(manifest, "transit", transit_plan)` — byte-identical to Saga's and
// Calliope's — and resolved LIVE here because Marcel grants `transit` at `read` (ORB-168, the
// first kit contribution he resolved rather than sentineled).
//
// It is now an UNCONDITIONAL `disableTool()`, because `agent-kit__transit_plan` is emitted
// instead from Marcel's OWN catalogue (catalogue/agent-kit__transit_plan.ts, wired through
// agent/tools/catalogue.ts) — the same prefixed key, deliberately, because a resolver-emitted
// tool REPLACES an authored/mounted tool of the same name completely (Task 1, Q1c) and having
// both this mount and the catalogue try to answer `agent-kit__transit_plan` at once is exactly
// the collision that measurement warns about. This file staying mounted but disabled — rather
// than being deleted — is what keeps `tests/agent-kit-tools-disabled.test.ts`'s "one override
// file per kit-contributed tool, no more, no less" comparison meaningful: the kit still
// contributes twelve tools, so Marcel still needs twelve override files, and now all twelve are
// sentinels regardless of what his agent.json grants — the declaration no longer decides this
// FILE's outcome, only the catalogue's.
//
// Saga's copy is untouched and still resolves this tool live from the extension mount — she has
// not moved to a catalogue yet (that is Task 9) — so this file diverging from hers here is
// expected, not drift.
import { disableTool } from "eve/tools";

export default disableTool();
