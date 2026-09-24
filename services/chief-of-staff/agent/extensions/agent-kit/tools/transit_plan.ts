// Superseded by `catalogue/agent-kit__transit_plan.ts` (ORB-278 step 2, Task 9) — a resolver-emitted
// tool under the SAME prefixed key (`agent-kit__transit_plan`) replaces an authored/mounted tool of
// that name completely (Task 1, Q1c), so this mount must stay dead unconditionally rather than
// resolve against the grant the way it used to: leaving both live would either collide or
// silently double-resolve. See `catalogue/agent-kit__transit_plan.ts`'s own header.
import { disableTool } from "eve/tools";

export default disableTool();
