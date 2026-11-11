import { defineHook } from "eve/hooks";
import { bindConsoleSessionStarted } from "@lares/agent-kit/console-turn-authority";

// Binds a private console conversation to its member when the session starts. eve 1.0 runs a hook
// for `session.started` after the commit is recorded and before the next model call, and it fails
// the running turn when the hook throws. That is wanted here: an invalid or unavailable authority
// must stop the conversation, never let it run unbound, so this does NOT catch.
export default defineHook({
  events: {
    "session.started": async (_event, ctx) => { await bindConsoleSessionStarted(ctx); },
  },
});
