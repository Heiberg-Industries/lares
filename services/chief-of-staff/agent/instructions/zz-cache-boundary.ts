// Marks where this agent's session-stable system prompt ends, so the prompt-cache breakpoint
// can sit there (`@lares/agent-kit/prompt-cache` explains the whole mechanism), and emits the
// per-turn blocks after it.
//
// `zz-` because eve places this directory's entries in filename order, and this file must be the
// LAST one. eve 1.0 has no other ordering: 0.60.1 kept every per-conversation entry ahead of
// every per-turn one whatever the filenames, and that grouping is gone. So everything that sorts
// before this file must be stable for the conversation (the persona from aa-definition.ts, the
// connections, the standing facts), and the blocks that change from turn to turn are built by
// their own files and emitted HERE, after the marker, in the order they always had: the
// language line (ab-language.ts), the clock (clock.ts), the standing-facts correction
// (standing-facts.ts). `tests/cache-boundary.test.ts` pins all of that.
//
// ONE MEMO PER TURN. eve calls this function before every model call. The per-turn blocks are
// built once, on the turn's first call, and the saved text is returned for the rest of the turn,
// so the bytes after the marker do not move between two model calls of one turn either.
//
// The gateway provider removes the marker before the request leaves, on both lanes; the model
// never sees it.
import { verifyPrivateConsoleSession } from "@lares/agent-kit/private-console-surface";
import { startedIn } from "@lares/agent-kit/shared-room";
import { defineDynamic, defineInstructions } from "eve/instructions";

import { PROMPT_CACHE_BOUNDARY } from "@lares/agent-kit/prompt-cache";

import { languageBlock } from "./ab-language.js";
import { clockBlock } from "./clock.js";
import { standingFactsCorrectionBlock } from "./standing-facts.js";

export default defineDynamic(async (ctx) => {
  const perTurn = await ctx.memo(["per-turn", ctx.turn?.id ?? null], async () => {
    // A private console conversation (web chat) gets the language line and the clock after the
    // marker, and no memory: the standing-facts correction is left out here, and `standing-facts.ts`
    // leaves out the facts themselves. Without the clock the model guessed the date ("Friday" in
    // the wrong year). The clock is not private: a shared room gets it too. An unauthorized
    // conversation throws, and the turn fails.
    if (await verifyPrivateConsoleSession(ctx)) return [await languageBlock(ctx.session.id, true), await clockBlock()];
    // A conversation started in a shared room has no standing-facts block (`standing-facts.ts`), so it
    // gets no correction to one either. The language line and the clock are not private.
    if (startedIn(ctx) === "shared-room") return [await languageBlock(ctx.session.id, false), await clockBlock()];
    return [
      await languageBlock(ctx.session.id, false),
      await clockBlock(),
      await standingFactsCorrectionBlock(ctx.session.id),
    ];
  });
  const content = [PROMPT_CACHE_BOUNDARY, ...perTurn].map((block) => block.trim()).filter((block) => block !== "").join("\n\n");
  return defineInstructions({ content });
});
