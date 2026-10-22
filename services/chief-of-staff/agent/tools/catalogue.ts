import { verifyPrivateConsoleSession, privateToolAllowed, privateOnlyTool, isPrivateConsoleContext } from "@lares/agent-kit/private-console-surface";
import { isExactApprovalContext } from "@lares/agent-kit/approval-execution";
import { catalogueApprovalRequest, catalogueApprovalResponse, guardCatalogueExecution } from "../../lib/approvals.js";
// The one seam that turns a definition into a toolset (ADR-0015 rule 4).
//
// `session.started`, never `turn.started`: the tool list is part of what the prompt cache keys
// on, and changing it mid-session re-bills the whole conversation. A grant change therefore
// reaches the agent at its NEXT conversation — which the builder says out loud (ADR-0015).
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
// gets here. So each phase is stamped BY HAND, with the closure the inline form would have relied
// on: `{ name }`, one plain string, re-reading the module-level CATALOGUE when it runs.
// See node_modules/eve/docs/guides/dynamic-capabilities.md, "Create dynamic tools in a package".
//
// THE APPROVAL IS COPIED ACROSS, AND THAT LINE IS LOAD-BEARING — here more than anywhere else in
// the fleet so far. `agent-kit__vault_write`, `agent-kit__vault_file` and `agent-kit__vault_drop`
// each carry `approval: always` (a vault write or delete) — it was measured that a
// resolver-emitted tool REPLACES an authored/mounted tool of the same name completely —
// description, executor AND approval (measured on eve 0.32) —
// so omitting this line would ship those three gated writes with no card. The other sixty-four
// entries in `../../catalogue/index.ts` carry no approval today, so for them this line copies
// nothing; it stays unconditional because the day another gated tool joins this catalogue is the
// day this resolver must already be correct, not the day someone remembers to add the line.
import { defineDurableCallback, defineDurableSchema, defineDynamic, defineTool } from "eve/tools";
import { registerDurableDynamicTools } from "@lares/agent-kit/durable-dynamic-tools";

import { grantedToolNames } from "@lares/agent-kit/catalogue";

import { CATALOGUE } from "../../catalogue/index.js";
import { thisAgent } from "../../lib/definition.js";
import { consoleAdmission } from "@lares/agent-kit/console-turn-authority";
import { managedIdentity } from "@lares/agent-kit/door-authority";
import { vaultBrokerRequest } from "@lares/agent-kit/vault-broker-client";
import { vaultTurnCapability } from "../lib/vault-turn.js";

/** Only the field this resolver needs off eve's `DynamicResolveContext`. Optional-chained for the
 *  same reason the instructions resolver's is (agent/instructions/aa-definition.ts). */
interface ResolveCtx { readonly session?: { readonly id?: string } }

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

registerDurableDynamicTools("catalogue", Object.fromEntries(
  Object.keys(CATALOGUE).map(name => [name, valueOf(name)]),
));

export default defineDynamic({
  events: {
    // The session id pins ONE read of the definition for this whole conversation — the persona,
    // the model, the approval fallback and this tool list all resolve from it (lib/definition.ts).
    "session.started": async (_event: unknown, ctx?: ResolveCtx) => {
      const privateSession = await verifyPrivateConsoleSession(ctx);
      const { loaded } = await thisAgent(ctx?.session?.id);
      const names = grantedToolNames(CATALOGUE, loaded.definition).filter(name => privateSession ? privateToolAllowed("chief-of-staff", name) : !privateOnlyTool(name));
      // Eve requires authenticated button responses whenever this descriptor exists.
      // Native Telegram deliberately resumes with auth:null; its legacy executor check stays
      // authoritative. Bound console sessions retain their tagged initiator on cold replay.
      const exactApproval = isExactApprovalContext(ctx);
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
              // Untouched: the approval is whatever the tool itself authored, which since               // step 1 is the permissions board bound to that tool's own name, decided per call.
              // Wrapped, never replaced — the call below IS the authored policy, same arguments,
              // same answer; the wrapper exists only so eve can find it again after a restart.
              ...(tool.approval !== undefined
                ? {
                    approval: {
                      request: defineDurableCallback({
                        closure: { name },
                        callback: async (closure: { name: string }, ctx: unknown) =>
                          catalogueApprovalRequest(closure.name,ctx,valueOf(closure.name).approval),
                      }),
                      ...(exactApproval ? {
                        response: defineDurableCallback({
                          closure: { name },
                          callback: async (closure: { name: string }, ctx: unknown) =>
                            catalogueApprovalResponse(closure.name,ctx),
                        }),
                      } : {}),
                    },
                  }
                : {}),
              // Reaching the module-level `CATALOGUE` through the captured string `name` — the one
              // value that has to survive a cold start. See this file's header before changing it.
              execute: defineDurableCallback({
                closure: { name },
                callback: async (closure: { name: string }, input: unknown, toolCtx: unknown) => {
                  await guardCatalogueExecution(toolCtx,closure.name,input);
                  if(closure.name==='agent-kit__vault_list'||closure.name==='agent-kit__vault_read'){
                    const c=toolCtx as {session?:{id?:string;turn?:{id?:string;sequence?:number};auth?:{current?:unknown}|null}};
                    if(isPrivateConsoleContext(toolCtx)){
                      const admission=consoleAdmission(c.session?.auth?.current),own=managedIdentity(process.env),turnId=c.session?.turn?.id,sequence=c.session?.turn?.sequence;
                      if(admission?.purpose!=='human'||!own||!c.session?.id||typeof turnId!=='string'||!Number.isSafeInteger(sequence))throw new Error('Conversation authority is not available');
                      const turn=vaultTurnCapability({sessionId:c.session.id,turnId,sequence:sequence as number,incarnation:own.incarnation});
                      if(!turn||turn.expiresAt<=Date.now()||turn.turnId!==turnId||turn.sequence!==sequence)throw new Error('Conversation authority is not available');
                      const args=input as {area?:unknown;path?:unknown};
                      if((args.area!=='private'&&args.area!=='shared')||(closure.name==='agent-kit__vault_read'&&typeof args.path!=='string'))throw new Error('Vault access refused');
                      return vaultBrokerRequest('vault.read',{turnCapability:turn.capability,turnId,sequence,sessionId:c.session.id,memberId:admission.memberId,admissionNonce:admission.admissionNonce,operation:closure.name==='agent-kit__vault_list'?'list':'read',area:args.area,...(typeof args.path==='string'?{path:args.path}:{}),...(Number.isSafeInteger((args as {offset?:unknown}).offset)?{offset:(args as {offset:number}).offset}:{})});
                    }
                  }
                  return valueOf(closure.name).execute(input, toolCtx);
                },
              }),
            } as never),
          ];
        }),
      );
    },
  },
});
