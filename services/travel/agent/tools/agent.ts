// Removes eve's built-in `agent` tool from the harness.
//
// Root-only delegation to a fresh copy of itself. eve-marcel declares no subagents and has no
// fan-out use case (one conversation, one reply) — but per eve's own docs
// (node_modules/eve/docs/subagents.mdx: "The root session receives `agent` by default")
// this tool is present in ANY root session unconditionally, NOT gated on subagents being
// declared the way `load_skill`/`connection_search` are gated on skills/connections being
// declared. So leaving this file out would NOT make the tool disappear on its own — it would
// leave the one default tool this agent wires beyond web_search, contradicting Global
// Constraints' "disable every default eve tool except the one explicit re-enable." eve-saga's
// own agent/tools/agent.ts (also a root agent with no subagents) sets the same precedent.
//
// Global Constraints (docs/superpowers/plans/2026-08-16-eve-marcel-wave.md, line 19: "disable
// the 11 default eve tools ... are NOT wired unless a task below explicitly wires one").
//
// eve resolves this by FILENAME — and, corrected by ORB-152: eve does NOT validate the name
// at build time, so a typo here silently removes nothing. What makes a typo loud is the fleet
// drift alarm in packages/agent-kit/tests/disable-tool-names.test.ts, which checks every
// disableTool() filename against the installed eve's framework-tools.
import { disableTool } from "eve/tools";

export default disableTool();
