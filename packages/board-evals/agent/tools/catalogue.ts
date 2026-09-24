// The required proof reads a real mounted definition and selects the pool through the shared
// catalogue policy. Without a mounted definition, the original SEAM_GRANTS measurement remains
// available for historical dynamic-seam research; it is not authorization evidence.
//
// `execute` is INLINE on purpose: eve's bundler transform reconstructs each executor from its stored
// closure variables on replay and does not detect `execute: someFunction`
// (eve/docs/guides/dynamic-capabilities.md, "execute must be an inline function").
//
// ORB-278 step 2, Task 7 adds the second half: `POOL`, a catalogue of REAL tools carrying their own
// input schemas, executors and board approvals, emitted through the exact shape
// `services/creative/agent/tools/catalogue.ts` uses — the description and schema copied across, the
// approval spread across, and an inline `execute` that reaches the pool entry through the captured
// name. `evals/replay.eval.ts` drives it. The constant-result entries above are untouched, so
// Q1–Q3's committed output is unchanged.
//
// EVERY POOL CALLBACK BELOW CARRIES A DURABLE DESCRIPTOR (eve 0.59.0+), FOR THE SAME REASON
// `services/creative/agent/tools/catalogue.ts` does: eve refuses a dynamic tool whose `execute`,
// approval policy or live (zod) `inputSchema` it cannot rebuild in a fresh process, and it refuses
// the WHOLE resolver result when a single entry fails. eve's compiler transform cannot help here —
// it only rewrites a `defineTool(<object literal>)` call, and the literal below is cast `as never`
// and reached through a conditional approval spread, both of which hide it from the transform. So
// each phase is stamped by hand with the public helpers `defineDurableCallback` / `defineDurableSchema`
// (`eve/tools`), closure `{ name }` — one plain string, re-reading the module-level `POOL` when it
// runs. The constant-result `CATALOGUE` entries above stay as plain inline callbacks: they are a
// literal `defineTool({...})` argument with no cast and no conditional spread, so eve's compiler
// transform stamps them itself.
import { defineDurableCallback, defineDurableSchema, defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { POOL } from "../../catalogue/index.js";
import { grantedToolNames } from "@lares/agent-kit/catalogue";
import { fixtureDefinition } from "../../lib/definition.js";
import { grantedNames } from "../../lib/seam-grants.js";

/** The four fields the resolver reads off a pool tool — the same local assertion Calliope's
 *  resolver makes, and for the same reason (`CatalogueEntry.tool` is structural). */
interface PoolToolValue {
  readonly description: string;
  readonly inputSchema: unknown;
  readonly approval?: unknown;
  readonly execute: (input: unknown, ctx: unknown) => unknown;
}

const poolValueOf = (name: string): PoolToolValue => POOL[name]!.tool as unknown as PoolToolValue;

const CATALOGUE: Record<string, { description: string; result: unknown }> = {
  cat_alpha: { description: "Catalogue tool alpha.", result: { from: "catalogue", tool: "alpha" } },
  cat_beta: { description: "Catalogue tool beta.", result: { from: "catalogue", tool: "beta" } },
  // Q3: emitted under the probe extension's reserved prefix, from the AGENT's own catalogue, while
  // agent/extensions/probe/tools/probe_extension_tool.ts is a disableTool() sentinel.
  probe__probe_extension_tool: {
    description: "Catalogue's copy of the probe extension tool.",
    result: { from: "catalogue", tool: "probe_extension_tool" },
  },
  // Q1: the same name as the authored agent/tools/vault_write.ts. The description is the tell —
  // whichever copy the model is shown names its own origin.
  vault_write: {
    description: "Catalogue's own vault_write.",
    result: { from: "catalogue", tool: "vault_write" },
  },
};

export default defineDynamic({
  events: {
    "session.started": async (_event: unknown, ctx?: { session?: { id?: string } }) => {
      const granted = process.env.LARES_DEFINITION_DIR
        ? grantedToolNames(POOL, (await fixtureDefinition(ctx?.session?.id)).loaded.definition)
        : grantedNames();
      return Object.fromEntries([
        ...granted
          .filter((name) => CATALOGUE[name] !== undefined)
          .map((name) => [
            name,
            defineTool({
              description: CATALOGUE[name]!.description,
              inputSchema: z.object({}),
              execute: async () => CATALOGUE[name]!.result,
            }),
          ]),
        // The production shape, including each pool entry's own approval and inline executor.
        // Required evals select these names through the mounted definition above.
        ...granted
          .filter((name) => POOL[name] !== undefined)
          .map((name) => {
            const tool = poolValueOf(name);
            return [
              name,
              defineTool({
                description: tool.description,
                // The SAME validator, behind a factory eve can re-run. See
                // services/creative/agent/tools/catalogue.ts for why a durable descriptor replaces
                // the plain `tool.inputSchema` this used to pass through directly.
                inputSchema: defineDurableSchema({
                  closure: { name },
                  schema: (closure) => poolValueOf(closure.name).inputSchema as Record<string, unknown>,
                }),
                // Untouched: the approval is whatever the pool tool itself authored. Wrapped, never
                // replaced — the call below IS the authored policy, same arguments, same answer;
                // the wrapper exists only so eve can find it again after a restart.
                ...(tool.approval !== undefined
                  ? {
                      approval: defineDurableCallback({
                        closure: { name },
                        callback: (closure: { name: string }, ...args: unknown[]) =>
                          (poolValueOf(closure.name).approval as (...a: unknown[]) => unknown)(...args),
                      }),
                    }
                  : {}),
                // Reaching the module-level POOL through the captured string `name` — the one value
                // that has to survive a cold start.
                execute: defineDurableCallback({
                  closure: { name },
                  callback: async (closure: { name: string }, input: unknown, ctx: unknown) =>
                    poolValueOf(closure.name).execute(input, ctx),
                }),
              } as never),
            ];
          }),
      ]);
    },
  },
});
