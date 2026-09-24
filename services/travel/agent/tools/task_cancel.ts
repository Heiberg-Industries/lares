// Removes eve's built-in `task_cancel` tool from the harness.
//
// New in eve 0.60.1 — absent from `dist/src/tools/framework/` on the 0.32 install this fleet
// shipped with. It cancels an in-flight local or remote task by id — the other half of the
// `agent` delegation tool this directory already disables, and Marcel has exactly as little use
// for it: no subagents, no remote agents, no fan-out. Global Constraints (docs/superpowers/plans/
// 2026-08-16-eve-marcel-wave.md) already disables every default eve tool except the one explicit
// re-enable (web_search); a version bump handing him a new one silently would contradict that on
// its own, and W2-s8b's ruling makes it explicit: a NEW framework tool from an eve bump is an
// owner decision, not a side effect — the model-visible tool list must stay identical to the 0.32
// baseline (packages/board-evals/snapshots/tools-travel.txt), which predates task_cancel entirely.
//
// eve resolves this by FILENAME. On 0.60.1 a name matching no framework-default tool now fails
// `eve build` outright ("disables a slot with no lower-precedence source" — the CI blocker
// W2-s8 retired the glob.ts/grep.ts sentinels for); `task_cancel` IS a real framework-default
// slot (eve/dist/src/framework/sources/registry.js's `eve:defaults` registration), so this
// disable is live, not inert. `packages/agent-kit/tests/disable-tool-names.test.ts` checks every
// disableTool() filename here against that same registry.
import { disableTool } from "eve/tools";

export default disableTool();
