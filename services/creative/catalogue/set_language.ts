// Record the language for THIS conversation. Always present — it is not a capability, it has no
// grant, and no definition can remove it: an owner must always be able to say "answer me in
// English" whatever their agent is set up to speak.
//
// It writes the SESSION's state and nothing else. The definition on the box is untouched
// (agent-definitions spec, Part 3), which is why this tool has no approval: it changes nothing
// outside the conversation it is spoken in.
//
// `defineState` (eve/context, node_modules/eve/docs/guides/state.md), not `ctx.session.state` —
// eve 0.32 keys durable per-session memory by the slot's NAME, not by which module declared it
// or which bundle it runs in (Task 1, Q4), so this tool's handle and the instructions resolver's
// handle in ab-language.ts read and write the same slot despite being compiled separately.
import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { LANGUAGE_STATE_KEY } from "@lares/agent-kit/language";

const language = defineState<string | null>(LANGUAGE_STATE_KEY, () => null);

export default defineTool({
  description:
    "Record the language to use for THIS conversation only. Call it when someone asks me to " +
    "switch language here. It does not change my default, and it does not affect any other " +
    "conversation. Pass a plain language name or tag (\"English\", \"en\", \"norsk\").",
  inputSchema: z.object({ language: z.string().min(2) }),
  async execute({ language: chosen }) {
    const trimmed = chosen.trim();
    language.update(() => trimmed);
    return { language: trimmed, scope: "this conversation only" };
  },
});
