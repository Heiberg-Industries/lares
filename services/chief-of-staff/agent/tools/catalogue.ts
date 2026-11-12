import { verifyPrivateConsoleSession, privateToolAllowed, privateOnlyTool, isPrivateConsoleContext, sharedRoomHiddenTool, startedInSharedSlackRoom } from "@lares/agent-kit/private-console-surface";
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
// THE APPROVAL IS COPIED ACROSS, AND THAT LINE IS LOAD-BEARING — here more than anywhere else in
// the fleet so far. `agent-kit__vault_write`, `agent-kit__vault_file` and `agent-kit__vault_drop`
// each carry `approval: always` (a vault write or delete) — a resolver-emitted tool REPLACES an
// authored/mounted tool of the same name completely (description, executor AND approval), so
// omitting it would ship those gated writes with no card. A tool that authored no approval gets
// none here; a tool that did gets the object form `{ request, response?, prompt }`:
//   - `request` is the authored policy, run through `catalogueApprovalRequest` (same arguments,
//     same answer; bound console conversations additionally reserve an exact approval first);
//   - `response` is on every gated tool, and eve asks it about a Deny as well as an Approve: in a
//     bound console conversation it is the exact check, on a native door it refuses a card with no
//     requester and anyone who is not an allowed approver — only the person who may approve may deny;
//   - `prompt` is the card title (`cardTitle`, never throws), because eve only reads a `prompt`
//     from the object form.
// `guardCatalogueExecution` runs before every catalogue call, whoever approved it.
import { defineDynamic, defineTool } from "eve/tools";
import { withCardTitle } from "@lares/agent-kit/approval-summary";

import { grantedToolNames } from "@lares/agent-kit/catalogue";

import { CATALOGUE } from "../../catalogue/index.js";
import { thisAgent } from "../../lib/definition.js";
import { callerIsAgentOwner } from "../../lib/webchat-owner.js";
import { consoleAdmission } from "@lares/agent-kit/console-turn-authority";
import { managedIdentity } from "@lares/agent-kit/door-authority";
import { vaultBrokerRequest } from "@lares/agent-kit/vault-broker-client";
import { vaultTurnCapability } from "../lib/vault-turn.js";

/** The four fields the resolver reads off a catalogue tool. `CatalogueEntry.tool` is typed as the
 *  kit's structural `ResolvableTool` (description + approval only) because eve's `Approval<…>`
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
interface CatalogueDecision { readonly names: readonly string[] }

export default defineDynamic(async (ctx) => {
  // The session id pins ONE read of the definition for this whole conversation — the persona,
  // the model, the approval fallback and this tool list all resolve from it (lib/definition.ts).
  // The key says which kind of conversation this is, so a session id that is later seen as a bound
  // console conversation (or the reverse) never reuses the other kind's tool list.
  // A conversation started in a shared Slack room (decided from the session's initiator, which never
  // changes) gets its own key, so a list saved without that rule is never reused for it.
  const sharedRoom = startedInSharedSlackRoom(ctx);
  const decided: CatalogueDecision = await ctx.memo(["catalogue", ctx.session.id, isExactApprovalContext(ctx), ...(sharedRoom ? ["shared-room"] : [])], async () => {
    const privateSession = await verifyPrivateConsoleSession(ctx);
    const { loaded } = await thisAgent(ctx.session.id);
    // Decided once, here; the guard at execution asks again (ownership can change mid-conversation).
    const callerIsOwner = privateSession ? await callerIsAgentOwner(ctx) : false;
    const names = grantedToolNames(CATALOGUE, loaded.definition).filter(name => privateSession
      ? privateToolAllowed("chief-of-staff", name, { callerIsOwner })
      : !privateOnlyTool(name) && !(sharedRoom && sharedRoomHiddenTool(name)));
    return { names };
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
                  response: async (responseCtx: unknown) => catalogueApprovalResponse(name, responseCtx),
                }),
              }
            : {}),
          execute: async (input: unknown, toolCtx: unknown) => {
            await guardCatalogueExecution(toolCtx,name,input);
            if(name==='agent-kit__vault_list'||name==='agent-kit__vault_read'){
              const c=toolCtx as {session?:{id?:string;turn?:{id?:string;sequence?:number};auth?:{current?:unknown}|null}};
              if(isPrivateConsoleContext(toolCtx)){
                const admission=consoleAdmission(c.session?.auth?.current),own=managedIdentity(process.env),turnId=c.session?.turn?.id,sequence=c.session?.turn?.sequence;
                if(admission?.purpose!=='human'||!own||!c.session?.id||typeof turnId!=='string'||!Number.isSafeInteger(sequence))throw new Error('Conversation authority is not available');
                const turn=vaultTurnCapability({sessionId:c.session.id,turnId,sequence:sequence as number,incarnation:own.incarnation});
                if(!turn||turn.expiresAt<=Date.now()||turn.turnId!==turnId||turn.sequence!==sequence)throw new Error('Conversation authority is not available');
                const args=input as {area?:unknown;path?:unknown};
                if((args.area!=='private'&&args.area!=='shared')||(name==='agent-kit__vault_read'&&typeof args.path!=='string'))throw new Error('Vault access refused');
                return vaultBrokerRequest('vault.read',{turnCapability:turn.capability,turnId,sequence,sessionId:c.session.id,memberId:admission.memberId,admissionNonce:admission.admissionNonce,operation:name==='agent-kit__vault_list'?'list':'read',area:args.area,...(typeof args.path==='string'?{path:args.path}:{}),...(Number.isSafeInteger((args as {offset?:unknown}).offset)?{offset:(args as {offset:number}).offset}:{})});
              }
            }
            return tool.execute(input, toolCtx);
          },
        } as never),
      ];
    }),
  );
});
