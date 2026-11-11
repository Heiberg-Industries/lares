// The language-switch proof, reading half. See agent/tools/set_language.ts's header. eve 1.0 runs
// this function before every model call, so a switch asked for mid-thread holds from the NEXT
// message (services/*/agent/instructions/ab-language.ts is the production counterpart). The fixture
// definition leaves its default language unset, so the definition-side argument stays `undefined`;
// this resolver measures the conversation-local override. No language chosen means no block at all.
import { defineState } from "eve/context";
import { defineDynamic, defineInstructions } from "eve/instructions";

import { LANGUAGE_STATE_KEY, languageInstruction } from "@lares/agent-kit/language";

const language = defineState<string | null>(LANGUAGE_STATE_KEY, () => null);

export default defineDynamic(() => {
  const content = languageInstruction(language.get(), undefined);
  return content === "" ? null : defineInstructions({ content });
});
