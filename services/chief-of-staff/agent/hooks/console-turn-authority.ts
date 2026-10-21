import { defineHook } from "eve/hooks";
import { bindConsoleSessionStarted } from "@lares/agent-kit/console-turn-authority";

// Eve 0.60.1 awaits authored session.started hooks before dynamic capabilities. Its
// channel event API omits this event, and channel-handler exceptions are swallowed.
export default defineHook({
  events: {
    "session.started": async (_event, ctx) => { await bindConsoleSessionStarted(ctx); },
  },
});
