import { definitionModel, resolveDefinitionForModel } from "@lares/agent-kit/definition-model";
import { defineAgent } from "eve";
import { gatewayModel } from "../lib/gateway-provider.js";
import { thisAgent } from "../lib/definition.js";

// Every model call is routed through the LiteLLM gateway (gatewayModel) — never the Vercel
// AI Gateway default that a bare model-id string like "anthropic/claude-sonnet-5" would use.
// MARCEL_MODEL_BRAIN mirrors old Marcel's own env var (services/marcel/bin/marcel.ts:754,
// requireEnv — no fallback there because old Marcel's daemon never started without it); with it
// unset the alias comes from the definition, so the declaration is the single place an agent's
// model is stated.
export default defineAgent({
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
    resolveAlias: async (sessionId) => {
      const { loaded } = await resolveDefinitionForModel(() => thisAgent(sessionId));
      // The env override still wins — that contract is unchanged.
      return process.env["MARCEL_MODEL_BRAIN"] ?? loaded.definition.model;
    },
    provider: gatewayModel,
  }),
  experimental: {
    workflow: {
      // Self-hosted on the box: session/turn/step state, queues, hooks, and streams persist
      // in the box's own Postgres instead of eve's default local-disk world. The world package
      // reads its connection string from DATABASE_URL (or WORKFLOW_POSTGRES_URL) at runtime —
      // eve-marcel's compose block wires DATABASE_URL the same way eve-saga's does
      // (services/travel/Dockerfile's CMD, services/box/compose.yaml).
      world: "@workflow/world-postgres",
    },
  },
});
