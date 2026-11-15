/**
 * agent/instructions/ac-connections.ts: tells the chief of staff what is actually connected.
 *
 * Once per conversation, like the persona (`aa-definition.ts`) and the standing facts: a
 * connection changes a few times in an installation's life, and a block that moved between
 * turns would re-bill the whole system prompt (see `standing-facts.ts`'s header for the cache
 * reasoning). The text is kept in a memo keyed on the session, so every later model call gets
 * the same bytes; a connection made mid-conversation is picked up by the next conversation.
 *
 * Never throws for an ordinary conversation: a failed read yields an empty block, and the
 * persona is then all the agent has, which is where the agent was before this existed.
 */
import { verifyPrivateConsoleSession } from "@lares/agent-kit/private-console-surface";
import { defineDynamic, defineInstructions } from "eve/instructions";

import { connectionsMarkdown, readConnections } from "../../lib/connections.js";

export default defineDynamic(async (ctx) => {
  if (await ctx.memo(["private-console", ctx.turn?.id ?? null], () => verifyPrivateConsoleSession(ctx))) return null;
  const content = await ctx.memo(["connections", ctx.session.id], async () => {
    try {
      return connectionsMarkdown(await readConnections());
    } catch (err) {
      console.error("chief-of-staff: connections resolver failed; this session has no connected-services block", err);
      return "";
    }
  });
  return defineInstructions({ content });
});
