import { verifyPrivateConsoleSession, privateToolAllowed } from "@lares/agent-kit/private-console-surface";
import { isExactApprovalContext } from "@lares/agent-kit/approval-execution";
import { catalogueApprovalRequest, catalogueApprovalResponse, guardCatalogueExecution } from "../../lib/approvals.js";
// The one seam that turns a definition into a toolset (ADR-0015 rule 4).
//
// DECIDED ONCE PER CONVERSATION. The tool list is part of what the prompt cache keys on, and
// changing it mid-session re-bills the whole conversation. eve 1.0 runs this function before EVERY
// model call, so the decision (which tools, and whether the conversation is a bound console one)
// is saved with `ctx.memo` under the session id: it runs once, in any process, and a later
// evaluation gets the saved answer. A grant change therefore reaches the agent at its NEXT
// conversation — which the builder says out loud (ADR-0015). The memo holds plain JSON (tool
// names and one flag); the tools and their callbacks are rebuilt from it each time with ordinary
// code, so there is nothing to register for a fresh process (the old durable wrappers are gone).
//
// THE APPROVAL IS COPIED ACROSS, AND THAT LINE IS LOAD-BEARING. A resolver-emitted tool REPLACES an
// authored `agent/tools/<name>.ts` completely — description, executor and approval. Omit the
// approval below and `vault_write`, the creative agent's one gated tool, commits and pushes to the
// Atlas with no card. A tool that authored no approval gets none; one that did gets the object form
// `{ request, response?, prompt }`:
//   - `request` is the authored policy through `catalogueApprovalRequest`;
//   - `response` exists only in a bound console conversation, and eve asks it about a Deny as well
//     as an Approve — only the person who may approve may deny;
//   - `prompt` is the card title (`cardTitle`, never throws), because eve only reads a `prompt`
//     from the object form.
// `guardCatalogueExecution` runs before every catalogue call, whoever approved it.
import { defineDynamic, defineTool } from "eve/tools";
import { withCardTitle } from "@lares/agent-kit/approval-summary";

import { grantedToolNames } from "@lares/agent-kit/catalogue";

import { CATALOGUE } from "../../catalogue/index.js";
import { thisAgent } from "../../lib/definition.js";

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

/** What the resolver decides once per conversation: plain JSON, so `ctx.memo` can keep it. */
interface CatalogueDecision { readonly names: readonly string[]; readonly exactApproval: boolean }

export default defineDynamic(async (ctx) => {
  // The session id pins ONE read of the definition for this whole conversation — the persona,
  // the model, the approval fallback and this tool list all resolve from it (lib/definition.ts).
  // The key says which kind of conversation this is, so a session id that is later seen as a bound
  // console conversation (or the reverse) never reuses the other kind's tool list.
  const decided: CatalogueDecision = await ctx.memo(["catalogue", ctx.session.id, isExactApprovalContext(ctx)], async () => {
    const privateSession = await verifyPrivateConsoleSession(ctx);
    const { loaded } = await thisAgent(ctx.session.id);
    const names = grantedToolNames(CATALOGUE, loaded.definition).filter(name => !privateSession || privateToolAllowed("creative", name));
    // A bound console conversation gets a response policy (and so authenticated button answers).
    // Native Telegram deliberately resumes with auth:null; its legacy executor check stays
    // authoritative. Bound console sessions retain their tagged initiator on cold replay.
    return { names, exactApproval: isExactApprovalContext(ctx) };
  });
  return Object.fromEntries(
    decided.names.map((name) => {
      const tool = valueOf(name);
      return [
        name,
        defineTool({
          description: tool.description,
          inputSchema: tool.inputSchema,
          // The approval is whatever the tool itself authored — the permissions board bound to that
          // tool's own name, decided per call — wrapped in the object form so the card has a title.
          ...(tool.approval !== undefined
            ? {
                approval: withCardTitle({
                  request: async (approvalCtx: unknown) => catalogueApprovalRequest(name, approvalCtx, tool.approval),
                  ...(decided.exactApproval ? { response: async (responseCtx: unknown) => catalogueApprovalResponse(name, responseCtx) } : {}),
                }),
              }
            : {}),
          execute: async (input: unknown, toolCtx: unknown) => {
            await guardCatalogueExecution(toolCtx,name,input);
            return tool.execute(input, toolCtx);
          },
        } as never),
      ];
    }),
  );
});
