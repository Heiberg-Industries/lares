// Superseded by `catalogue/agent-kit__market_edge.ts` (ORB-278 step 2, Task 10) — a resolver-emitted
// tool under the SAME prefixed key (`agent-kit__market_edge`) replaces an authored/mounted tool of
// that name completely (Task 1, Q1c), so this mount must stay dead unconditionally rather than
// resolve the skill itself the way it used to (reading the mounted definition and returning `null`
// via `resolveSkillTool`): leaving both live would either collide or silently double-resolve, and
// the old shape never actually removed the tool anyway — a `null` dynamic override does not
// remove the kit extension's own static contribution of the same name (LAR-5's diagnosis; Q6 in
// docs/research/2026-09-16-eve-0.32-dynamic-seams.md). The declared-skill / never-widen /
// no-composed-`never` check now lives in `grantedToolNames`
// (packages/agent-kit/src/catalogue.ts's `CatalogueEntry.skill`), run once per session over the
// whole catalogue instead of inside this one tool's own mount. See
// `catalogue/agent-kit__market_edge.ts`'s own header.
//
// SAGA'S OWN COPY DIVERGES FROM MARCEL'S AND CALLIOPE'S HERE, deliberately: she is the only one of
// the three this task touches. Marcel's and Calliope's copies stay on the old `defineDynamic`
// form (their own `session.started` handlers reading their own mounted definitions), because
// neither has moved `market_edge` into its own catalogue.
import { disableTool } from "eve/tools";

export default disableTool();
