// Marcel's ONE `@lares/agent-kit` contribution he actually grants (ORB-168), now held directly in
// his OWN catalogue rather than reached through `agent/extensions/agent-kit/tools/transit_plan.ts`
// (ORB-278 step 2, Task 8). That override file is now an unconditional `disableTool()` sentinel —
// see its own header — because a resolver-emitted tool under the SAME prefixed key
// (`agent-kit__transit_plan`) replaces an authored/mounted tool of that name completely (Task 1,
// Q1c; Task 7's `agent/tools/catalogue.ts` header), so leaving both live would either collide or
// silently double-resolve. This file is the first place in the fleet an `agent-kit__` key is
// emitted from a SERVICE's own catalogue rather than from the extension mount itself (Task 1's
// Q3, measured on a purpose-built probe extension, never before on this real mount).
//
// A thin re-export, not a copy: the tool's real implementation — HTTP mechanics, geocode-then-plan
// ordering, Norway-coverage guard — stays exactly where the kit owns it
// (packages/agent-kit/extension/tools/transit_plan.ts). `transit_plan` carries no `.approval`
// (a free, unbilled public read), so nothing here needs to attach a board approval the way a
// gated tool's catalogue entry would — see catalogue/index.ts's header for the tools that do.
import { transit_plan } from "@lares/agent-kit/tools";

export default transit_plan;
