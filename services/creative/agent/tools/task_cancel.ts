// Removes eve's built-in `task_cancel` tool from the harness.
//
// New in eve 0.60.1 — absent from `dist/src/tools/framework/` on the 0.32 install this fleet
// shipped with. It cancels an in-flight local or remote task by id: the other half of the
// `agent` delegation tool this directory's neighbour already disables for the same reason —
// Calliope's own fan-out lives inside `studio_ideate`, bounded and observable, never in a
// framework primitive that spawns or now controls tasks outside that pipeline. W2-s8b's ruling
// on this wave's safety bar makes the general case explicit: a NEW framework tool arriving from
// an eve version bump is an owner decision, not a side effect — the model-visible tool list must
// stay identical to the 0.32 baseline (packages/board-evals/snapshots/tools-creative.txt), which
// predates task_cancel entirely.
//
// eve resolves this by FILENAME. On 0.60.1 a name matching no framework-default tool now fails
// `eve build` outright ("disables a slot with no lower-precedence source" — the CI blocker
// W2-s8 retired the glob.ts/grep.ts sentinels for); `task_cancel` IS a real framework-default
// slot (eve/dist/src/framework/sources/registry.js's `eve:defaults` registration), so this
// disable is live, not inert. `tests/tool-harness.test.ts` is what makes a typo loud instead —
// see that file's header.
import { disableTool } from "eve/tools";

export default disableTool();
