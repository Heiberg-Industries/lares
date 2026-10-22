import { defineDurableCallback, defineDurableSchema, defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { PUBLIC_DOC_IDS, type PublicDocId } from "@lares/agent-kit/public-docs";
import { readBakedPublicDoc } from "@lares/agent-kit/public-docs-runtime";
import { assertPrivateConsoleTool, isPrivateConsoleContext, verifyPrivateConsoleSession } from "@lares/agent-kit/private-console-surface";

const refuse = () => new Error("Public documentation is unavailable or this conversation is no longer authorized");

export default defineDynamic({ events: { "session.started": async (_event, ctx) => {
  await verifyPrivateConsoleSession(ctx);
  return {
    lares_read_public_doc: defineTool({
      description: "Read exactly one reviewed public Lares documentation page by its listed ID. Use the lares-docs skill to choose an ID; arbitrary paths and URLs are not accepted.",
      inputSchema: defineDurableSchema({ closure: {}, schema: () => z.strictObject({ id: z.enum(PUBLIC_DOC_IDS) }) }),
      outputSchema: defineDurableSchema({ closure: {}, schema: () => z.string() }),
      execute: defineDurableCallback({
        closure: {},
        callback: async (_closure, input: { id: PublicDocId }, context: unknown) => {
          const tagged = isPrivateConsoleContext(context);
          let privateSession: boolean;
          try { privateSession = await verifyPrivateConsoleSession(context); }
          catch { if (tagged) throw refuse(); throw new Error("Public documentation is unavailable"); }
          if (tagged && !privateSession) throw refuse();
          if (privateSession) assertPrivateConsoleTool(context, "chief-of-staff", "lares_read_public_doc");
          try { return readBakedPublicDoc(input.id).markdown; }
          catch { throw refuse(); }
        },
      }),
    }),
  };
} } });
