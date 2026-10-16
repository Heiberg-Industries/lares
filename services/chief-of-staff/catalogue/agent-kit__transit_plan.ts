// Chief of staff's `@lares/agent-kit` contribution, held directly in her OWN catalogue rather than reached
// through `agent/extensions/agent-kit/tools/transit_plan.ts` — the same
// move Task 8 made for the travel agent's copy of this exact tool (`services/travel/catalogue/
// agent-kit__transit_plan.ts`). That override file is now an unconditional `disableTool`
// sentinel — see its own header — because a resolver-emitted tool under the same prefixed key
// (`agent-kit__transit_plan`) replaces an authored/mounted tool of that name completely (Task 1,
// Q1c). the chief of staff's and the travel agent's copies of this file are now expected to diverge only in this header's
// service-specific references — the re-export line itself is identical.
//
// `transit_plan` carries no `.approval` (a free, unbilled public read), so nothing here needs to
// attach a board approval the way the brain-family entries in this directory do.
//
// A thin re-export, not a copy: the tool's real implementation — HTTP mechanics,
// geocode-then-plan ordering, Norway-coverage guard — stays exactly where the kit owns it
// (packages/agent-kit/extension/tools/transit_plan.ts).
import { transit_plan } from "@lares/agent-kit/tools";

export default transit_plan;
