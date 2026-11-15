import { defineHook } from "eve/hooks";
import { observeConversation } from "@lares/agent-kit/conversation-control";

// Feeds the console's conversation list. eve 1.0 fails the running turn when a hook throws, and this
// projection is optional work, so nothing may escape: `observeConversation` already swallows its
// database errors; the catch covers anything else (an odd event or context shape). A `*` handler
// never receives `content.delta`, `call.input` or `call.progress`, which this does not read.
export default defineHook({
  events: {
    "*": async (event, ctx) => {
      try {
        await observeConversation(event, ctx);
      } catch {
        console.warn("[conversations] projection unavailable");
      }
    },
  },
});
