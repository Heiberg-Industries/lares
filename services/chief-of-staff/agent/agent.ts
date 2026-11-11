import { definitionModel, resolveDefinitionForModel } from "@lares/agent-kit/definition-model";
import { defineAgent } from "eve";
import { gatewayModel } from "../lib/gateway-provider.js";
import { thisAgent } from "../lib/definition.js";
import { claimModelPurposeForInvocation, prepareModelPurposeInvocation } from "./lib/model-purpose.js";

// Every model call is routed through the LiteLLM gateway (gatewayModel) — never the Vercel
// AI Gateway default that a bare model-id string like "anthropic/claude-sonnet-5" would use.
export default defineAgent({
  // The model now comes from agent.json rather than a literal here, so the declaration is the
  // single place an agent's model is stated. AGENT_MODEL still wins at runtime.
  // the model is resolved from the definition per CONVERSATION, not frozen into
  // the image — the resolver is what a definition's model change actually reaches, at the NEXT
  // conversation, never mid-session, because prompt caches are per model. That promise is real
  // and not aspirational: the alias is pinned per SESSION, so an edit on the box is picked up by
  // the next conversation, with nothing rebuilt and no container restarted.
  //
  // eve 1.0: `definitionModel` is one function eve calls before every model call. It reads the
  // definition on the conversation's FIRST call and pins the alias in session state; see its
  // docblock in packages/agent-kit/src/definition-model.ts for why it returns a provider object
  // with its context window on every call, and why a model-id string would have put this agent
  // on the Vercel AI Gateway.
  model: definitionModel({
    // ONE read of the definition for this conversation, shared with the instructions resolver
    // and the approval fallback through `thisAgent`'s per-session pin (lib/definition.ts).
    // `sessionId` is passed through as-is: `thisAgent` treats a missing id as "read fresh, pin
    // nothing" rather than sharing one entry between every conversation in the process.
    resolveAlias: async (sessionId, session) => {
      const { loaded } = await resolveDefinitionForModel(() => thisAgent(sessionId));
      const attributes = (session?.auth?.current as { attributes?: Record<string, unknown> } | undefined)?.attributes;
      const purposeBound = attributes?.lares_model_purpose_required === '1' ||
        typeof attributes?.lares_model_pending_receipt === 'string';
      // Only a request carrying verified model-purpose custody is pinned to the validated
      // session definition. Ordinary Console conversations preserve the AGENT_MODEL override.
      return purposeBound ? loaded.definition.model : process.env["AGENT_MODEL"] ?? loaded.definition.model;
    },
    preparePurpose: prepareModelPurposeInvocation,
    claimPurpose: claimModelPurposeForInvocation,
    provider: gatewayModel,
  }),
  // No framework default tool reaches this agent. eve 1.0 hands every agent bash, read_file,
  // write_file, edit_file, web_fetch and web_search, and the root agent the delegating `agent`
  // tool; `false` drops every one of them that has no file under agent/tools/ (there is none:
  // tests/tool-harness.test.ts). What the agent can do is what Lares adds, nothing else.
  defaultTools: false,
  // The delegating `agent` tool stays off by name as well, so it does not come back if
  // `defaultTools` is ever relaxed. With it off and no subagents declared, eve has no tool that
  // runs as a task, so its `eve__task_wait` / `eve__task_cancel` tools never appear either.
  tool: false,
  limits: {
    // eve's own per-conversation token cap, written out so it is visible here: it is eve 1.0's
    // documented default, not a Lares limit. Lares's budget stays the authority and stops a
    // conversation long before this. At the cap eve pauses the turn and asks the person whether
    // to continue; approving starts a new window.
    sessionUsage: ({ window }) => window.inputTokens - window.cacheReadTokens >= 40_000_000,
  },
  experimental: {
    workflow: {
      // eve keeps its own copy of every conversation's run data, as it always has. Unset, eve
      // 1.0 asks for that copy to be deleted when a private conversation ends (direct messages,
      // private channels, web chat), which makes a finished conversation unreadable.
      retention: "default",
      // Self-hosted on the box: session/turn/step state, queues, hooks, and streams persist
      // in the box's own Postgres instead of eve's default local-disk world. The world package
      // reads its connection string from DATABASE_URL (or WORKFLOW_POSTGRES_URL) at runtime —
      // see services/chief-of-staff/sql/001-eve-workflow.sql for the schema it expects to find already
      // applied (the box has no auto-migrate).
      world: "@workflow/world-postgres",
    },
  },
});
