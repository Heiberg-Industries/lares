// Removes eve's built-in `write_file` tool from the harness.
//
// Marcel's only durable write is the "## Notert" section of a trip's trip.md, and that goes
// through `remember.ts`'s own `TripStore`-scoped write, never a general filesystem write. A
// bare `write_file` would also just write /tmp and the workflow-data volume, neither of which
// is where trip state lives.
//
// Global Constraints (docs/superpowers/plans/2026-08-16-eve-marcel-wave.md): disable every
// default eve tool except the one explicit re-enable (web_search, agent/tools/web_search.ts).
//
// eve resolves this by FILENAME — and, corrected by ORB-152: eve does NOT validate the name
// at build time, so a typo here silently removes nothing. What makes a typo loud is the fleet
// drift alarm in packages/agent-kit/tests/disable-tool-names.test.ts, which checks every
// disableTool() filename against the installed eve's framework-tools.
import { disableTool } from "eve/tools";

export default disableTool();
