// The one seam that turns a definition into a toolset (ADR-0015 rule 4).
//
// `session.started`, never `turn.started`: the tool list is part of what the prompt cache keys
// on, and changing it mid-session re-bills the whole conversation. A grant change therefore
// reaches the agent at its NEXT conversation — which the builder says out loud (spec Part 3).
//
// EVERY CALLBACK BELOW CARRIES A DURABLE DESCRIPTOR, AND THAT IS NOT OPTIONAL (eve 0.59.0+).
// eve refuses a dynamic tool whose `execute`, approval policy or live (zod) `inputSchema` it
// cannot rebuild in a fresh process, and it refuses the WHOLE resolver result when a single
// entry fails — one unstamped tool would leave this agent with no catalogue at all, silently,
// with only a log line. Two things can produce a descriptor: eve's compiler transform, which
// rewrites inline callbacks in AUTHORED source, and the public helpers `defineDurableCallback` /
// `defineDurableSchema` (`eve/tools`). The transform cannot help here — it only rewrites a
// `defineTool(<object literal>)` call (`eve/dist/src/internal/workflow-bundle/
// dynamic-tool-transform.js` requires `arguments[0].type === "ObjectExpression"`), and the
// literal below is cast `as never` for the typing reason the `CatalogueToolValue` docblock gives;
// it also never sees a callback reached through a conditional spread, which is how an approval
// gets here. So each phase is stamped BY HAND, with the same closure the old inline code relied
// on: `{ name }`, one plain string, re-reading the module-level CATALOGUE when it runs.
// See node_modules/eve/docs/guides/dynamic-capabilities.md, "Create dynamic tools in a package".
//
// THE APPROVAL IS COPIED ACROSS, AND THAT LINE IS LOAD-BEARING. Task 1 measured that a
// resolver-emitted tool REPLACES an authored `agent/tools/<name>.ts` completely — description,
// executor and approval (docs/research/2026-09-16-eve-0.32-dynamic-seams.md, Q1). Omit the
// spread below and `vault_write`, Calliope's one gated tool, commits and pushes to the Atlas
// with no card. eve's own `DynamicToolEntry` docstring claims approval is "only honored for
// step-scoped dynamic tools"; that comment is stale for 0.32 — `dynamic-tool-lifecycle.js`
// registers a session-scoped entry's approval as a durable step function
// (`eve:dynamic-tool-approval:<slug>:<key>`) and `build-dynamic-tools.js`'s `buildReplayedApproval`
// rebuilds it on replay, defaulting to "user-approval" if the step is missing. Measured, not read:
// packages/board-evals/evals/replay.eval.ts drives this exact shape through autonomous -> no card
// -> runs and gated -> card -> approve -> runs. The autonomous half is what discriminates: a lost
// approval would ALSO produce a card, so only a case where the card must NOT appear can tell the
// tool's own approval from eve's ask-by-default fallback.
import { defineDurableCallback, defineDurableSchema, defineDynamic, defineTool } from "eve/tools";
import { registerDurableDynamicTools } from "@lares/agent-kit/durable-dynamic-tools";

import { grantedToolNames } from "@lares/agent-kit/catalogue";

import { CATALOGUE } from "../../catalogue/index.js";
import { thisAgent } from "../../lib/definition.js";

/** Only the field this resolver needs off eve's `DynamicResolveContext`. Optional-chained for the
 *  same reason the instructions resolver's is (agent/instructions/aa-definition.ts). */
interface ResolveCtx { readonly session?: { readonly id?: string } }

/** The four fields the resolver reads off a catalogue tool. `CatalogueEntry.tool` is typed as the
 *  kit's structural `ResolvableTool` — description + approval only — because eve's `Approval<…>`
 *  is invariant in the tool's input type and rejects every concretely-typed tool, including the
 *  `any` form (see @lares/agent-kit/manifest's own docblock). The pool's entries really are eve
 *  tools, so the two remaining fields are asserted here rather than threaded through a generic. */
interface CatalogueToolValue {
  readonly description: string;
  readonly inputSchema: unknown;
  readonly approval?: unknown;
  readonly execute: (input: unknown, ctx: unknown) => unknown;
}

const valueOf = (name: string): CatalogueToolValue =>
  CATALOGUE[name]!.tool as unknown as CatalogueToolValue;

registerDurableDynamicTools("catalogue", Object.fromEntries(
  Object.keys(CATALOGUE).map(name => [name, valueOf(name)]),
));

export default defineDynamic({
  events: {
    // The session id pins ONE read of the definition for this whole conversation — the persona,
    // the model, the approval fallback and this tool list all resolve from it (lib/definition.ts).
    "session.started": async (_event: unknown, ctx?: ResolveCtx) => {
      const { loaded } = await thisAgent(ctx?.session?.id);
      const names = grantedToolNames(CATALOGUE, loaded.definition);
      return Object.fromEntries(
        names.map((name) => {
          const tool = valueOf(name);
          return [
            name,
            defineTool({
              description: tool.description,
              // The SAME validator, behind a factory eve can re-run. `defineDurableSchema` returns
              // a delegating view whose prototype IS the authored schema and whose JSON Schema is
              // serialized from it, so what the model is handed does not change; a plain JSON
              // Schema (no validator) is returned untouched and needs no descriptor at all.
              inputSchema: defineDurableSchema({
                closure: { name },
                schema: (closure) => valueOf(closure.name).inputSchema as Record<string, unknown>,
              }),
              // Untouched: the approval is whatever the tool itself authored, which since ORB-278
              // step 1 is the permissions board bound to that tool's own name, decided per call.
              // Wrapped, never replaced — the call below IS the authored policy, same arguments,
              // same answer; the wrapper exists only so eve can find it again after a restart.
              ...(tool.approval !== undefined
                ? {
                    approval: defineDurableCallback({
                      closure: { name },
                      callback: (closure: { name: string }, ...args: unknown[]) =>
                        (valueOf(closure.name).approval as (...a: unknown[]) => unknown)(...args),
                    }),
                  }
                : {}),
              // Reaching the module-level `CATALOGUE` through the captured string `name` — the one
              // value that has to survive a cold start. See this file's header before changing it.
              execute: defineDurableCallback({
                closure: { name },
                callback: async (closure: { name: string }, input: unknown, toolCtx: unknown) =>
                  valueOf(closure.name).execute(input, toolCtx),
              }),
            } as never),
          ];
        }),
      );
    },
  },
});
