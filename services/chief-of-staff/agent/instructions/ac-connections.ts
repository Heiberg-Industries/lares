/**
 * agent/instructions/ac-connections.ts: tells the chief of staff what is actually connected.
 *
 * Session-scoped, like the persona (`aa-definition.ts`) and the standing facts: a connection
 * changes a few times in an installation's life, and a turn-scoped block that moved would re-bill
 * the whole system prompt (see `standing-facts.ts`'s header for the cache reasoning). A
 * connection made mid-conversation is picked up by the next conversation.
 *
 * Never throws: a failed read yields an empty block, and the persona is then all the agent has, which
 * is where the agent was before this existed.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { connectionsMarkdown, readConnections } from "../../lib/connections.js";

export default defineDynamic({
  events: {
    "session.started": async () => {
      try {
        return defineInstructions({ markdown: connectionsMarkdown(await readConnections()) });
      } catch (err) {
        console.error("chief-of-staff: connections resolver failed; this session has no connected-services block", err);
        return defineInstructions({ markdown: "" });
      }
    },
  },
});
