// Q4's writer and reader in one tool: `{ set }` stores a value in eve session state, and every call
// returns the current value. Reading it back on a later turn proves the value survived the turn
// boundary; reading it in a second session proves it did not leak there.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { language } from "../../lib/seam-state.js";

export default defineTool({
  description: "Read or set this session's language (fixture).",
  inputSchema: z.object({ set: z.string().optional() }),
  execute: async ({ set }) => {
    if (set !== undefined) language.update(() => set);
    return { lang: language.get() };
  },
});
