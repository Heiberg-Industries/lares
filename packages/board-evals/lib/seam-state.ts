// Q4's slot. `defineState` is keyed by its NAME, not by the module object, so the bundling trap
// lib/file-board.ts documents (eve compiles instrumentation.ts and agent.ts + tools into separate
// bundles, each with its own copy of a shared module) does not apply here: a tool and an
// instructions resolver in different bundles still read and write the same durable slot.
import { defineState } from "eve/context";

export const language = defineState("board-evals.language", () => "en");
