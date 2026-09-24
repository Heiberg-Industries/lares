import { definitionModel, resolveDefinitionForModel } from "@lares/agent-kit/definition-model";
import { defineAgent } from "eve";
import { gatewayModel } from "../lib/gateway-provider.js";
import { thisAgent } from "../lib/definition.js";

// Every model call is routed through the LiteLLM gateway (gatewayModel) — never the Vercel
// AI Gateway default that a bare model-id string like "anthropic/claude-sonnet-5" would use.
export default defineAgent({
  // The model now comes from agent.json rather than a literal here, so the declaration is the
  // single place an agent's model is stated. EVE_SAGA_MODEL still wins at runtime.
  // ORB-278 step 2: the model is resolved from the definition per CONVERSATION, not frozen into
  // the image — the resolver is what a definition's model change actually reaches, at the NEXT
  // conversation, never mid-session, because prompt caches are per model. That promise is real
  // and not aspirational: the alias is pinned per SESSION, so an edit on the box is picked up by
  // the next conversation, with nothing rebuilt and no container restarted.
  //
  // eve 0.60: the read happens on the session's FIRST STEP rather than at `session.started`, and
  // the definition-level `modelContextWindowTokens` is gone — see `definitionModel`'s docblock
  // in packages/agent-kit/src/definition-model.ts for why those are now the only legal shape,
  // and why a model-id string at session scope would have put this agent on the Vercel AI
  // Gateway. The window travels with each selection instead (`sessionGatewayModel`).
  model: definitionModel({
    // ONE read of the definition for this conversation, shared with the instructions resolver
    // and the approval fallback through `thisAgent`'s per-session pin (lib/definition.ts).
    // `sessionId` is passed through as-is: `thisAgent` treats a missing id as "read fresh, pin
    // nothing" rather than sharing one entry between every conversation in the process.
    resolveAlias: async (sessionId) => {
      const { loaded } = await resolveDefinitionForModel(() => thisAgent(sessionId));
      // The env override still wins — that contract is unchanged.
      return process.env["EVE_SAGA_MODEL"] ?? loaded.definition.model;
    },
    provider: gatewayModel,
  }),
  experimental: {
    workflow: {
      // Self-hosted on the box: session/turn/step state, queues, hooks, and streams persist
      // in the box's own Postgres instead of eve's default local-disk world. The world package
      // reads its connection string from DATABASE_URL (or WORKFLOW_POSTGRES_URL) at runtime —
      // see services/chief-of-staff/sql/001-eve-workflow.sql for the schema it expects to find already
      // applied (the box has no auto-migrate).
      world: "@workflow/world-postgres",
    },
  },
});
