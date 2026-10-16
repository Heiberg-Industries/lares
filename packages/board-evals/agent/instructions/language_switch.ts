// Task 6's own proof, reading half. See agent/tools/set_language.ts's header. turn.started, not
// session.started — a switch asked for mid-thread must hold from the NEXT message
// (agent-definitions spec, Part 3; services/*/agent/instructions/ab-language.ts is the production
// counterpart). The fixture definition leaves its default language unset, so the definition-side
// argument stays `undefined`; this resolver measures the conversation-local override.
import { defineState } from "eve/context";
import { defineDynamic, defineInstructions } from "eve/instructions";

import { LANGUAGE_STATE_KEY, languageInstruction } from "@lares/agent-kit/language";

const language = defineState<string | null>(LANGUAGE_STATE_KEY, () => null);

export default defineDynamic({
  events: {
    "turn.started": async () => defineInstructions({ markdown: languageInstruction(language.get(), undefined) }),
  },
});
