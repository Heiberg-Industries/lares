/**
 * The creative agent — the ideation agent, on eve.
 *
 * DATABASE WIRING (the highest-risk detail in this service). Two connection strings, deliberately pointed at two different databases:
 *
 *   WORKFLOW_POSTGRES_URL = postgres://lares@db:5432/lares_agent_creative ← the agent's own database
 *   DATABASE_URL = postgres://lares@db:5432/lares_state ← the shared one
 *
 * Its own workflow database, because `@workflow/world-postgres@5.0.0-beta.32` offers no
 * schema override at all: the schema names `workflow` and `workflow_drizzle` are string
 * literals inside the package (`dist/drizzle/schema.d.ts` and `dist/cli.js`), and its
 * `jobPrefix`/`namespace` options prefix graphile LISTEN topics only, never tables. So a
 * second eve app on the same database is a second eve app on the SAME session store and the
 * SAME graphile queue. That is not theoretical: exactly that arrangement once made
 * one agent answer a conversation the owner was having with another, and
 * `services/box/compose.yaml` has carried the resulting standing rule ever since —
 * *"RULE FOR EVERY FUTURE EVE APP ON THIS BOX: its own workflow database, always."*
 *
 * `DATABASE_URL` staying on `lares_state` is the deliberate other half, and it is a feature,
 * not an oversight: `getPool()` (@lares/agent-kit/db) reads DATABASE_URL, so the agent's
 * domain tables remain the ones it already has. The `studio_runs` table stays the SAME table the
 * old agent-runtime wrote to, and the run history carries across the
 * cutover instead of forking into an empty copy.
 *
 * All of that isolation is env-level, in compose. Nothing is passed here: `world` is the bare
 * package string, exactly as chief-of-staff's is.
 */
import { defineAgent } from "eve";
import { definitionModel, resolveDefinitionForModel } from "@lares/agent-kit/definition-model";
import { assertDeclarationIntegrity } from "@lares/agent-kit/manifest";

import { gatewayModel } from "../lib/gateway-provider.js";
import { thisAgent } from "../lib/definition.js";
// The agent declaration. Imported as a JSON module, not read with readFileSync: a
// bundled module has no reliable `import.meta.dirname` at the agent root.
import manifest from "../agent.json";

// `assertDeclarationIntegrity` is opt-in — the kit cannot force a call, so if nobody makes
// one the declaration enforces nothing and a broken agent.json fails only the test suite,
// never the build. This is that call, and it lives HERE rather than in an extension the way
// other agents' do (agent/extensions/agent-kit/extension.ts) because the creative agent has no
// extension that makes it. What matters is that `eve build` evaluates this module once per
// build, so a duplicate grant, an unknown capability, an autonomy level over an ungranted
// capability, or an empty persona fails the BUILD rather than surfacing mid-session.
//
// The return value is the PARSED manifest. Nothing reads it any more — eve has no compiled
// fallback model, so there is no build-time model id to anchor, and the alias comes
// from the definition the resolver reads per conversation. The CALL still has to happen: if
// an extension ever calls this too, a second call is harmless — it is a pure
// validation of the same frozen JSON — but the call must not LEAVE this file while it is the
// only one, or the build-time gate goes with it.
assertDeclarationIntegrity(manifest);

// Every model call is routed through the LiteLLM gateway (gatewayModel) — never the Vercel
// AI Gateway default that a bare model-id string like "anthropic/claude-sonnet-5" would use.
export default defineAgent({
  // The model comes from the definition rather than a literal here, so the declaration is the
  // single place an agent's model is stated. AGENT_MODEL still wins at runtime.
  // The model is resolved from the definition per CONVERSATION, not frozen into
  // the image — the resolver is what a definition's model change actually reaches, at the NEXT
  // conversation, never mid-session, because prompt caches are per model. That promise is real
  // and not aspirational: the alias is pinned per SESSION, so an edit on the box is picked up by
  // the next conversation, with nothing rebuilt and no container restarted.
  //
  // eve 1.0: `definitionModel` is one function eve calls before every model call. It reads the
  // definition on the conversation's FIRST call and pins the alias in session state; see its
  // docblock in packages/agent-kit/src/definition-model.ts for why it returns a provider object
  // with its context window on every call, and why a model-id string would have put this agent
  // on the Vercel AI Gateway. The 200k window travels with each selection, where it is still
  // WRONG for any smaller-window model: pointing AGENT_MODEL at one silently mis-tunes
  // compaction rather than failing. Change the alias and that constant together.
  model: definitionModel({
    // ONE read of the definition for this conversation, shared with the instructions resolver
    // and the approval fallback through `thisAgent`'s per-session pin (lib/definition.ts).
    resolveAlias: async (sessionId) => {
      const { loaded } = await resolveDefinitionForModel(() => thisAgent(sessionId));
      // The env override still wins — that contract is unchanged.
      return process.env["AGENT_MODEL"] ?? loaded.definition.model;
    },
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
      // Self-hosted on the box: session/turn/step state, queues, hooks and streams persist in
      // the box's own Postgres instead of eve's default local-disk world. The world package
      // reads its connection string from WORKFLOW_POSTGRES_URL (falling back to DATABASE_URL)
      // at runtime — see this file's header for why those two must differ for the creative agent, and
      // sql/001-eve-workflow.sql for the schema that must already exist in `lares_agent_creative`
      // (the box has no auto-migrate; apply it by hand before first boot).
      world: "@workflow/world-postgres",
    },
  },
});
