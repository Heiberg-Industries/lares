// Saga's `@lares/agent-kit` contribution, held directly in her OWN catalogue rather than reached
// through `agent/extensions/agent-kit/tools/market_edge.ts` (ORB-278 step 2, Task 10) — the same
// move Task 9 made for `agent-kit__signals_recent` and eleven other kit tools. That override file
// is now an unconditional `disableTool()` sentinel — see its own header — because a
// resolver-emitted tool under the SAME prefixed key (`agent-kit__market_edge`) replaces an
// authored/mounted tool of that name completely (Task 1, Q1c).
//
// UNLIKE THE OTHER TWELVE, this entry also carries `skill: "market-edge"` (LAR-5-s1's addition to
// `CatalogueEntry`). The old mount used to gate this tool itself, inside a `defineDynamic`
// resolver that read the mounted definition and returned `null` when the skill was undeclared —
// but a `null` dynamic override never removed the kit extension's own STATIC contribution of the
// same tool, so the tool stayed reachable regardless (LAR-5's diagnosis; Q6 in
// docs/research/2026-09-16-eve-0.32-dynamic-seams.md). `grantedToolNames` now does the same
// check — the skill must be declared, `assertSkillsWithinGrants` must pass (never-widen), and no
// capability the skill composes may carry a `never` autonomy — once per session, over the whole
// catalogue, instead of inside this one tool's own mount. See catalogue/index.ts's header.
//
// A thin re-export, not a copy: the tool's real implementation — the required caveat, the
// computed edge, no stake advice anywhere — stays exactly where the kit owns it
// (packages/agent-kit/extension/tools/market_edge.ts).
import { market_edge } from "@lares/agent-kit/tools";

export default market_edge;
