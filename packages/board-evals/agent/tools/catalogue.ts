// The required proof reads a real mounted definition and selects the pool through the shared
// catalogue policy. Without a mounted definition, the original SEAM_GRANTS measurement remains
// available for dynamic-seam research; it is not authorization evidence.
//
// DECIDED ONCE PER CONVERSATION, REBUILT BEFORE EVERY MODEL CALL. eve 1.0 runs this function before
// every model call, in any process. WHICH tools the conversation has is saved with `ctx.memo` under
// the session id (plain JSON: names only), so a grant changed mid-conversation reaches the next
// conversation; the tools themselves, with their schemas, approvals and executors, are rebuilt
// from those names with ordinary code each time. That is the same shape
// `services/creative/agent/tools/catalogue.ts` has, and it is why the hand-stamped durable
// wrappers eve 0.59 to 0.60 needed here are gone: there is nothing to register for a fresh process.
//
// The second half is `POOL`, a catalogue of REAL tools carrying their own input schemas, executors
// and board approvals. The approval is copied across untouched: a resolver-emitted tool REPLACES an
// authored `agent/tools/<name>.ts` completely, so a dropped approval would run a gated tool with no
// card. `evals/replay.eval.ts` drives it. The constant-result `CATALOGUE` entries are plain tools
// with no approval, which the seam probes read back.
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { POOL } from "../../catalogue/index.js";
import { grantedToolNames } from "@lares/agent-kit/catalogue";
import { fixtureDefinition } from "../../lib/definition.js";
import { grantedNames } from "../../lib/seam-grants.js";

/** The four fields the resolver reads off a pool tool — the same local assertion the creative agent's
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
  // Emitted under the probe extension's reserved prefix, from the AGENT's own catalogue, while
  // agent/extensions/probe/tools/probe_extension_tool.ts is a disableTool() sentinel.
  probe__probe_extension_tool: {
    description: "Catalogue's copy of the probe extension tool.",
    result: { from: "catalogue", tool: "probe_extension_tool" },
  },
  // The same name as the authored agent/tools/vault_write.ts. The description is the tell —
  // whichever copy the model is shown names its own origin.
  vault_write: {
    description: "Catalogue's own vault_write.",
    result: { from: "catalogue", tool: "vault_write" },
  },
};

/** What the resolver decides once per conversation: plain JSON, so `ctx.memo` can keep it. */
interface CatalogueDecision { readonly names: readonly string[] }

export default defineDynamic(async (ctx) => {
  const decided: CatalogueDecision = await ctx.memo(["catalogue", ctx.session.id], async () => ({
    names: process.env.LARES_DEFINITION_DIR
      ? grantedToolNames(POOL, (await fixtureDefinition(ctx.session.id)).loaded.definition)
      : grantedNames(),
  }));
  return Object.fromEntries([
    ...decided.names
      .filter((name) => CATALOGUE[name] !== undefined)
      .map((name) => [
        name,
        defineTool({
          description: CATALOGUE[name]!.description,
          inputSchema: z.object({}),
          execute: async () => CATALOGUE[name]!.result,
        }),
      ]),
    // The production shape, including each pool entry's own approval and executor.
    // Required evals select these names through the mounted definition above.
    ...decided.names
      .filter((name) => POOL[name] !== undefined)
      .map((name) => {
        const tool = poolValueOf(name);
        return [
          name,
          defineTool({
            description: tool.description,
            inputSchema: tool.inputSchema,
            // Untouched: the approval is whatever the pool tool itself authored.
            ...(tool.approval !== undefined ? { approval: tool.approval } : {}),
            execute: async (input: unknown, toolCtx: unknown) => tool.execute(input, toolCtx),
          } as never),
        ];
      }),
  ]);
});
