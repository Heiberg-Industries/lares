// Removes eve's built-in `todo` tool from the harness.
//
// Marcel answers one travel question (or chimes in on one group message) per turn — there is
// no multi-step task old Marcel ever tracked across turns, and no ported capability (Tasks
// 3-9) needs a durable per-session todo list.
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
