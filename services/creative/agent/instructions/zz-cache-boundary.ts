// Marks where this agent's session-stable system prompt ends, so the prompt-cache breakpoint
// can sit there (`@lares/agent-kit/prompt-cache` explains the whole mechanism), and emits the
// per-turn block after it.
//
// `zz-` because eve places this directory's entries in filename order, and this file must be the
// LAST one. eve 1.0 has no other ordering: 0.60.1 kept every per-conversation entry ahead of
// every per-turn one whatever the filenames, and that grouping is gone. So everything that sorts
// before this file must be stable for the conversation (the persona from aa-definition.ts), and
// the one block that changes from turn to turn, the language line, is built by ab-language.ts and
// emitted HERE, after the marker, where it always was. `tests/cache-boundary.test.ts` pins that.
//
// ONE MEMO PER TURN. eve calls this function before every model call. The language line is built
// once, on the turn's first call, and the saved text is returned for the rest of the turn.
//
// The gateway provider removes the marker before the request leaves, on both lanes; the model
// never sees it.
import { verifyPrivateConsoleSession } from "@lares/agent-kit/private-console-surface";
import { defineDynamic, defineInstructions } from "eve/instructions";

import { PROMPT_CACHE_BOUNDARY } from "@lares/agent-kit/prompt-cache";

import { languageBlock } from "./ab-language.js";

export default defineDynamic(async (ctx) => {
  const perTurn = await ctx.memo(["per-turn", ctx.turn?.id ?? null], async () =>
    // An unauthorized private console conversation throws here, and the turn fails.
    [await languageBlock(ctx.session.id, await verifyPrivateConsoleSession(ctx))],
  );
  const content = [PROMPT_CACHE_BOUNDARY, ...perTurn].map((block) => block.trim()).filter((block) => block !== "").join("\n\n");
  return defineInstructions({ content });
});
