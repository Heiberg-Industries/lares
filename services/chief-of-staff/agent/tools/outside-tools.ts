import { defineDynamic } from 'eve/tools';
import { approvalResponderOf } from '@lares/agent-kit/approval-execution';
import { resolveOutsideTools, type AcceptedOutsideTool } from '@lares/agent-kit/outside-connections';
import { outsideToolsInEffect } from '@lares/agent-kit/outside-tools';
import { verifyPrivateConsoleSession } from '@lares/agent-kit/private-console-surface';
import { hasConsoleTurnAuthorityTag } from '@lares/agent-kit/console-turn-authority';
import { thisAgent } from '../../lib/definition.js';
import { doorVaultRoute } from '@lares/agent-kit/door-vault-turn';
import { acceptedOutsideTools, acceptedOutsideToolsOnDoor, runOutsideTool, runTrustedOutsideTool, runTrustedOutsideToolOnDoor, requestOutsideApproval, respondOutsideApproval } from '../../lib/outside-tools.js';

// Outside tools: ordinary tools whose approval is always the object form (request, response, and the
// card title). eve 1.0 runs this function before every model call, so what must not repeat is kept
// with `ctx.memo` (plain JSON, keyed on the session): whether this is a verified private conversation,
// and each connection's accepted tool catalog, read through Keeper. A connection that cannot be read
// is left out and tried again at the next evaluation; a failed read is never kept.
export default defineDynamic(async (ctx) => {
 const privateSession=await ctx.memo(['outside-private',ctx.session.id,hasConsoleTurnAuthorityTag(ctx)],()=>verifyPrivateConsoleSession(ctx));
 // A chat door (Slack, Telegram, ...) has no console session. The claimed person in a private chat is offered the
 // lookups the owner lets run without asking, through the door's claim at Keeper; every other conversation gets nothing.
 const onDoor=!privateSession&&doorVaultRoute(ctx)!==undefined;
 if(!privateSession&&!onDoor)return null;
 const {loaded}=await thisAgent(ctx.session.id);
 const catalog=new Map<string,AcceptedOutsideTool[]>();
 for(const entry of outsideToolsInEffect(loaded.definition)){
  try{catalog.set(entry.name,await ctx.memo(['outside-tools',ctx.session.id,entry.name,...(onDoor?['door']:[])],()=>onDoor?acceptedOutsideToolsOnDoor(ctx as never,entry.name):acceptedOutsideTools(ctx as never,entry.name)));}catch{/* left out */}
 }
 if(onDoor)return resolveOutsideTools(loaded.definition,{
  surface:'private-door-chat',
  acceptedTools:async connection=>{const tools=catalog.get(connection);if(tools===undefined)throw new Error('Outside connection unavailable');return tools;},
  executor:(connectionName,toolName)=>async (input,toolCtx)=>runTrustedOutsideToolOnDoor(connectionName,toolName,input,toolCtx as never),
 });
 return resolveOutsideTools(loaded.definition,{
  acceptedTools:async connection=>{const tools=catalog.get(connection);if(tools===undefined)throw new Error('Outside connection unavailable');return tools;},
  approval:(connectionName,toolName)=>({
   request:async approvalCtx=>requestOutsideApproval(connectionName,toolName,approvalCtx) as never,
   response:async responseCtx=>respondOutsideApproval(connectionName,toolName,responseCtx) as never,
  }),
  executor:(connectionName,toolName,runsFree)=>async (input,toolCtx)=>runsFree&&approvalResponderOf(toolCtx)===undefined
   ?runTrustedOutsideTool(connectionName,toolName,input,toolCtx as never)
   :runOutsideTool(connectionName,toolName,input,toolCtx as never),
 });
});
