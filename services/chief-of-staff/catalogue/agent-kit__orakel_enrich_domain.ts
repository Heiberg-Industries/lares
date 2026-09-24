// Saga's `@lares/agent-kit` contribution, held directly in her OWN catalogue rather than reached
// through `agent/extensions/agent-kit/tools/orakel_enrich_domain.ts` (ORB-278 step 2, Task 9).
// That override file is now an unconditional `disableTool()` sentinel — see its own header —
// because a resolver-emitted tool under the same prefixed key (`agent-kit__orakel_enrich_domain`)
// replaces an authored/mounted tool of that name completely (Task 1, Q1c).
//
// A free, unbilled Brønnøysund-registry read (no `.approval`) — nothing here needs a board card.
//
// A thin re-export, not a copy: the tool's real implementation stays exactly where the kit owns
// it (packages/agent-kit/extension/tools/orakel_enrich_domain.ts).
import { orakel_enrich_domain } from "@lares/agent-kit/tools";

export default orakel_enrich_domain;
