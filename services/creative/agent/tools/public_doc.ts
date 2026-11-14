import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { PUBLIC_DOC_IDS } from "@lares/agent-kit/public-docs";
import { readBakedPublicDoc } from "@lares/agent-kit/public-docs-runtime";
import { assertPrivateConsoleTool, isPrivateConsoleContext, verifyPrivateConsoleSession } from "@lares/agent-kit/private-console-surface";

const refuse = () => new Error("Public documentation is unavailable or this conversation is no longer authorized");

// eve 1.0 calls this before every model call. The authority check that decides whether the tool
// is offered at all is kept once per TURN (a memo keyed on the turn), which is how often it ran
// before; a conversation that is tagged private but not authorized still throws, so the turn
// fails rather than the tool being offered. `execute` checks again on every call, unmemoized.
export default defineDynamic(async (ctx) => {
  await ctx.memo(["private-console", ctx.turn?.id ?? null], () => verifyPrivateConsoleSession(ctx));
  return {
    lares_read_public_doc: defineTool({
      description: "Read exactly one reviewed public Lares documentation page by its listed ID. Use the lares-docs skill to choose an ID; arbitrary paths and URLs are not accepted.",
      inputSchema: z.strictObject({ id: z.enum(PUBLIC_DOC_IDS) }),
      outputSchema: z.string(),
      execute: async (input, context) => {
        const tagged = isPrivateConsoleContext(context);
        let privateSession: boolean;
        try { privateSession = await verifyPrivateConsoleSession(context); }
        catch { if (tagged) throw refuse(); throw new Error("Public documentation is unavailable"); }
        if (tagged && !privateSession) throw refuse();
        if (privateSession) assertPrivateConsoleTool(context, "creative", "lares_read_public_doc");
        try { return readBakedPublicDoc(input.id).markdown; }
        catch { throw refuse(); }
      },
    }),
  };
});
