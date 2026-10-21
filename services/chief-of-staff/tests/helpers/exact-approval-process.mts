/** Fresh-process driver for the pinned Eve dynamic replay and approval coordinator. */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { closePool } from '@lares/agent-kit/db';
import resolver from '../../agent/tools/catalogue.js';
const root = new URL('../../node_modules/eve/dist/src/',import.meta.url).href;
const {ContextContainer,contextStorage}=await import(`${root}context/container.js`);
const keys=await import(`${root}context/keys.js`);
const {refreshDynamicSessionToolsForRuntimeRevision,replayDynamicSessionTools}=await import(`${root}context/dynamic-tool-lifecycle.js`);
const {hasUnregisteredDurableDynamicCallbacks}=await import(`${root}tools/durable-callbacks.js`);
const payload=JSON.parse(readFileSync(0,'utf8'));
const ctx=new ContextContainer();
ctx.set(keys.StaticModelReferenceKey,null);
ctx.set(keys.SessionIdKey,payload.context.session.id);
ctx.set(keys.SessionKey,{sessionId:payload.context.session.id,auth:payload.context.session.auth,turn:payload.context.session.turn});
ctx.set(keys.AuthKey,payload.context.session.auth.current);ctx.set(keys.InitiatorAuthKey,payload.context.session.auth.initiator);
ctx.set(keys.SessionDynamicToolMetadataKey,payload.metadata);
ctx.set(keys.SessionDynamicToolRuntimeRevisionKey,'fixture-runtime');
assert(hasUnregisteredDurableDynamicCallbacks(payload.metadata,{sessionId:payload.context.session.id,scope:'session'}));
const resolvers=[{slug:'catalogue',eventNames:['session.started'],events:resolver.events}];
try {
 await refreshDynamicSessionToolsForRuntimeRevision({ctx,resolvers,event:{type:'session.started',data:{}},messages:[],runtimeRevision:'fixture-runtime'});
 const metadata=ctx.get(keys.SessionDynamicToolMetadataKey);
 assert(!hasUnregisteredDurableDynamicCallbacks(metadata,{sessionId:payload.context.session.id,scope:'session'}));
 const tools=replayDynamicSessionTools(metadata,resolvers,payload.context.session.id);
 const tool=tools.find((t:any)=>t.name==='deadline_dismiss');assert(tool);
 const schema=await tool.inputSchema['~standard'].validate(payload.input);assert(!schema.issues);
 if(process.argv[2]==='response') {
  const {coordinateApprovalDelivery}=await import(`${root}harness/approval-delivery-coordinator.js`);
  const {getApprovalAuditState}=await import(`${root}harness/approval-candidates.js`);
  let session=payload.session,stepInput=payload.stepInput;
  for(let n=0;n<4;n++){
   const result=await contextStorage.run(ctx,()=>coordinateApprovalDelivery({session,stepInput,tools:new Map(tools.map((t:any)=>[t.name,t]))}));
   session=result.session;stepInput=result.stepInput;
  }
  assert.equal(getApprovalAuditState(session.state).settlements[0]?.outcome,'allowed');
 } else {
  const output=await contextStorage.run(ctx,()=>tool.execute(payload.input,{toolCallId:payload.context.callId,messages:[]}));
  assert.equal(output.dismissed,true);
 }
 process.stdout.write(JSON.stringify({pid:process.pid,rebound:true,mode:process.argv[2]}));
} finally {await closePool();}
