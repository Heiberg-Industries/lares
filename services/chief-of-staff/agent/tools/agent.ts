// Removes eve's built-in `agent` tool from the harness.
//
// Root-only delegation to a fresh copy of itself. The fleet's hands/skills design puts delegation in explicit grants, not an implicit framework tool.
//
// eve resolves this by FILENAME — and, corrected by ORB-152: eve does NOT validate the name
// at build time, so a typo here silently removes nothing. What makes a typo loud is the fleet
// drift alarm in packages/agent-kit/tests/disable-tool-names.test.ts, which checks every
// disableTool() filename against the installed eve's framework-tools.
import { disableTool } from "eve/tools";

export default disableTool();
