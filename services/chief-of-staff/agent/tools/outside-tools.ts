import { defineDynamic, defineDurableCallback } from 'eve/tools';
import { resolveOutsideTools } from '@lares/agent-kit/outside-connections';
import { verifyPrivateConsoleSession } from '@lares/agent-kit/private-console-surface';
import { thisAgent } from '../../lib/definition.js';
import { acceptedOutsideTools, runOutsideTool } from '../../lib/outside-tools.js';

export default defineDynamic({events:{'session.started':async(_event,ctx)=>{
 if(!await verifyPrivateConsoleSession(ctx))return null;
 const {loaded}=await thisAgent(ctx?.session?.id);
 return resolveOutsideTools(loaded.definition,{
  acceptedTools:connection=>acceptedOutsideTools(ctx,connection),
  executor:(connectionName,toolName)=>defineDurableCallback({closure:{connectionName,toolName},
   callback:async(selection:{connectionName:string;toolName:string},input:unknown,toolCtx:unknown)=>
    runOutsideTool(selection.connectionName,selection.toolName,input,toolCtx as never)}),
 });
}}});
