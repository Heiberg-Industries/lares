// This agent's `@lares/agent-kit` contribution, held directly in its own catalogue rather than reached
// through `agent/extensions/agent-kit/tools/transit_plan.ts`. That mount file is an unconditional
// `disableTool` sentinel (see its own header), because a resolver-emitted tool under the same prefixed
// key (`agent-kit__transit_plan`) replaces an authored/mounted tool of that name completely.
//
// `transit_plan` carries no `.approval` (a free, unbilled public read), so nothing here needs to
// attach a board approval the way the vault entries in this directory do.
//
// A thin re-export, not a copy: the tool's real implementation (HTTP mechanics,
// geocode-then-plan ordering, Norway-coverage guard) stays exactly where the kit owns it
// (packages/agent-kit/extension/tools/transit_plan.ts).
import { transit_plan } from "@lares/agent-kit/tools";

export default transit_plan;
