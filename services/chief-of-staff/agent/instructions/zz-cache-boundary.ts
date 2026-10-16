// Marks where this agent's session-stable system prompt ends, so the prompt-cache breakpoint
// can sit there (`@lares/agent-kit/prompt-cache` explains the whole mechanism).
//
// `zz-` because eve runs this directory's resolvers in filename order and keeps every
// session-scoped entry ahead of every turn-scoped one. So this marker lands after the last
// session-scoped block (the persona from aa-definition.ts, the standing facts from
// standing-facts.ts) and before the first turn-scoped one (the language line, the clock, the
// standing-facts correction). `tests/cache-boundary.test.ts` pins that order.
//
// The gateway provider removes the marker before the request leaves, on both lanes; the model
// never sees it.
import { defineDynamic, defineInstructions } from "eve/instructions";

import { PROMPT_CACHE_BOUNDARY } from "@lares/agent-kit/prompt-cache";

export default defineDynamic({
  events: {
    "session.started": async () => defineInstructions({ markdown: PROMPT_CACHE_BOUNDARY }),
  },
});
