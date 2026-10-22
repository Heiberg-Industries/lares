import { defineDurableCallback, defineDurableSchema, defineDynamic, defineTool } from "eve/tools";
import { loadSkill } from "eve/tools/load_skill";
import { z } from "zod";
import laresDocs from "../skills/lares-docs.js";
import { isPrivateConsoleContext, verifyPrivateConsoleSession } from "@lares/agent-kit/private-console-surface";

export default defineDynamic({ events: { "session.started": async (_event, ctx) => {
  const privateSession = await verifyPrivateConsoleSession(ctx);
  return {
    load_skill: defineTool({
      description: loadSkill.description,
      inputSchema: defineDurableSchema({
        closure: { privateSession },
        schema: (closure: { privateSession: boolean }) => closure.privateSession
          ? z.strictObject({ skill: z.literal("lares-docs") })
          : loadSkill.inputSchema as never,
      }),
      ...(loadSkill.outputSchema ? { outputSchema: defineDurableSchema({ closure: {}, schema: () => loadSkill.outputSchema as never }) } : {}),
      ...(loadSkill.label ? { label: {
        start: defineDurableCallback({ closure: {}, callback: (_closure, input: unknown) => loadSkill.label!.start(input as never) }),
        ...(loadSkill.label.delta ? { delta: defineDurableCallback({ closure: {}, callback: (_closure, input: unknown, partial: unknown) => loadSkill.label!.delta!(input as never, partial as never) }) } : {}),
        ...(loadSkill.label.complete ? { complete: defineDurableCallback({ closure: {}, callback: (_closure, input: unknown, output: unknown) => loadSkill.label!.complete!(input as never, output as never) }) } : {}),
      } } : {}),
      ...(loadSkill.toModelOutput ? { toModelOutput: defineDurableCallback({ closure: {}, callback: (_closure, output: unknown) => loadSkill.toModelOutput!(output as never) }) } : {}),
      execute: defineDurableCallback({
        closure: {},
        callback: async (_closure, input: unknown, context: unknown) => {
          const privateSession = await verifyPrivateConsoleSession(context);
          if (isPrivateConsoleContext(context) && !privateSession) throw new Error("Conversation authority is unavailable");
          if ((input as { skill?: unknown } | null)?.skill === "lares-docs") {
            const resolved = await laresDocs.events["session.started"]!({}, context as never);
            if (!resolved) throw new Error('No skill named "lares-docs".');
            return resolved.markdown;
          }
          if (privateSession) {
            throw new Error('No skill named "lares-docs".');
          }
          return loadSkill.execute(input as never, context as never);
        },
      }),
    }),
  };
} } });
