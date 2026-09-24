// Task 6's own proof, not Q4's generic seam fixture (seam_language.ts/seam_lang.ts above): this is
// the REAL `@lares/agent-kit/language` module wired through eve's real tool + turn.started seam,
// under production's own tool name, so a later eve regressing the seam breaks THIS file, not a
// stand-in for it. See agent/instructions/language_switch.ts for the reading half.
//
// Byte-for-byte the same shape as services/*/agent/tools/set_language.ts, minus the definition
// lookup those files pass through (this fixture has no per-agent definition to read a default
// language from — see language_switch.ts).
import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { LANGUAGE_STATE_KEY } from "@lares/agent-kit/language";

const language = defineState<string | null>(LANGUAGE_STATE_KEY, () => null);

export default defineTool({
  description: "Record the language to use for THIS conversation only (fixture, mirrors production set_language).",
  inputSchema: z.object({ language: z.string().min(2) }),
  async execute({ language: chosen }) {
    const trimmed = chosen.trim();
    language.update(() => trimmed);
    return { language: trimmed, scope: "this conversation only" };
  },
});
