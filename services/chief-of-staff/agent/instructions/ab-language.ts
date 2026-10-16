// The language switch, every turn (agent-definitions spec, Part 3). `ab-` because eve reads this
// directory's entries in filename order (node_modules/eve/docs/instructions.mdx) and this must
// land after the persona (aa-definition.ts) and before the clock — the same ordering rule
// instructions.md and clock.ts already follow.
//
// turn.started, NOT session.started: a switch asked for mid-thread must hold from the NEXT
// message, and an eve session is a whole chat-day on Slack and Telegram. This is the opposite of
// the persona's rule, deliberately — see aa-definition.ts: the persona is the system prompt
// (prompt-cache-keyed, rebuilt per turn would re-bill the conversation), the language line is a
// small addition that does not.
//
// `defineState`, not `ctx.session.state`: see set_language.ts's header. Keyed by NAME, so this
// resolver's handle and the tool's handle read and write the same durable slot even though eve
// compiles them into separate bundles.
//
// Never throws: a failed resolver takes its turn's instructions with it, and there is nothing
// here worth a lost turn.
import { defineState } from "eve/context";
import { defineDynamic, defineInstructions } from "eve/instructions";

import { LANGUAGE_STATE_KEY, languageInstruction } from "@lares/agent-kit/language";

import { thisAgent } from "../../lib/definition.js";

/** Only the field this resolver needs off eve's `DynamicResolveContext`. */
interface ResolveCtx { readonly session?: { readonly id?: string } }

const language = defineState<string | null>(LANGUAGE_STATE_KEY, () => null);

export default defineDynamic({
  events: {
    "turn.started": async (_event: unknown, ctx?: ResolveCtx) => {
      try {
        const { loaded } = await thisAgent(ctx?.session?.id);
        return defineInstructions({
          markdown: languageInstruction(language.get(), loaded.definition.language),
        });
      } catch (err) {
        console.error("language resolver failed — this turn has no language instruction", err);
        return defineInstructions({ markdown: "" });
      }
    },
  },
});
