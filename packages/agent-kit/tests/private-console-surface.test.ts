import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {MockLanguageModelV3} from 'ai/test';
const fake=vi.hoisted(()=>({binding:vi.fn(),turn:vi.fn(),source:vi.fn(),approval:vi.fn()}));
vi.mock('../src/console-turn-authority.js',async original=>({...await original<typeof import('../src/console-turn-authority.js')>(),requireConsoleSessionBinding:fake.binding,guardConsoleToolContext:fake.turn}));
const dist=pathToFileURL(fileURLToPath(new URL('../node_modules/eve/dist/src/',import.meta.url))).href;
const {ContextContainer,contextStorage}=await import(`${dist}context/container.js`);
const keys=await import(`${dist}context/keys.js`);
const {dispatchDynamicToolEvent}=await import(`${dist}context/dynamic-tool-lifecycle.js`);
const {buildDynamicTools,replayDynamicTools}=await import(`${dist}context/build-dynamic-tools.js`);
const {clearDurableDynamicCallbacks}=await import(`${dist}tools/durable-callbacks.js`);
import {verifyPrivateConsoleSession,markPrivateConsoleSurface,assertPrivateConsoleTool,privateToolAllowed,privateOnlyTool,privateOwnerTool,privateRoleInstructions,privateConsoleTracePolicy} from '../src/private-console-surface.js';
import {definitionModel} from '../src/definition-model.js';
import {defineDurableCallback,defineDurableSchema,defineDynamic,defineTool} from 'eve/tools';
import {z} from 'zod';
const stepEvent=(turnId:string,stepIndex=0)=>({type:'step.started',data:{turnId,sequence:0,stepIndex}});
const inc='11111111-1111-4111-8111-111111111111';
const auth=(member='member-a')=>({authenticator:'lares-console',principalType:'user',principalId:member,attributes:{lares_member_id:member,lares_admission_nonce:'a'.repeat(43),lares_purpose:'human'}});
const ctx=()=>({session:{id:'private-test',auth:{current:auth(),initiator:auth()}}});
beforeEach(()=>{vi.stubEnv('LARES_AGENT_NAME','helper');vi.stubEnv('LARES_AGENT_INCARNATION',inc);fake.binding.mockResolvedValue({});fake.source.mockResolvedValue('read');fake.turn.mockResolvedValue(undefined);});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
it('validates identical immutable admissions before any binding read; malformed tags never become native',async()=>{
 await expect(verifyPrivateConsoleSession(ctx())).resolves.toBe(true);
 const c=ctx();c.session.auth.current=auth('member-b');
 await expect(verifyPrivateConsoleSession(c)).rejects.toThrow('Conversation authority');
 await expect(verifyPrivateConsoleSession({session:{auth:{initiator:{attributes:{lares_admission_nonce:''}}}}})).rejects.toThrow('Conversation authority');
 expect(fake.binding).toHaveBeenCalledTimes(1);
 await expect(verifyPrivateConsoleSession({session:{auth:{current:null,initiator:null}}})).resolves.toBe(false);
});
it('private tools are an intersection and native/source-free controls keep their scope',()=>{
 expect(['gmail_accounts','gmail_search','gmail_read','gmail_send','vault_read','tracks_list','track_items','track_create','set_language','lares_read_public_doc'].filter(n=>privateToolAllowed('chief-of-staff',n))).toEqual(['gmail_accounts','gmail_search','gmail_read','tracks_list','track_items','track_create','lares_read_public_doc']);
 expect(privateToolAllowed('creative','lares_read_public_doc')).toBe(true);
 expect(privateToolAllowed('creative','gmail_read')).toBe(false);
 expect(privateToolAllowed('creative','personal_mailbox_send')).toBe(false);
 expect(()=>assertPrivateConsoleTool({},'chief-of-staff','personal_mailbox_send')).toThrow('Conversation authority');
 expect(()=>assertPrivateConsoleTool({session:{initiator:auth()}},'chief-of-staff','gmail_send')).toThrow('Conversation authority');
 expect(()=>assertPrivateConsoleTool({},'chief-of-staff','gmail_send')).not.toThrow();
 expect(privateRoleInstructions('creative')).not.toContain('OWNER_CANARY');
 expect(privateConsoleTracePolicy({channel:{kind:'http'}})).toEqual({emit:false});
 expect(privateConsoleTracePolicy({channel:{kind:'channel:http'}})).toEqual({emit:false});
 expect(privateConsoleTracePolicy({channel:{kind:'telegram'}})).toEqual({emit:true,recordInputs:true,recordOutputs:true});
});
it('owner-only tools are offered to a chief of staff only when the caller is the owner',()=>{
 const owner=['gmail_draft','gmail_draft_recipients','read_url','calendar_list_events','calendar_list_calendars','calendar_free_busy','calendar_conflicts','calendar_create_event','calendar_update_event','calendar_delete_event'];
 for(const n of owner){
  expect(privateOwnerTool(n),n).toBe(true);
  expect(privateToolAllowed('chief-of-staff',n),n).toBe(false);
  expect(privateToolAllowed('chief-of-staff',n,{}),n).toBe(false);
  expect(privateToolAllowed('chief-of-staff',n,{callerIsOwner:false}),n).toBe(false);
  expect(privateToolAllowed('chief-of-staff',n,{callerIsOwner:true}),n).toBe(true);
  expect(privateToolAllowed('creative',n,{callerIsOwner:true}),n).toBe(false);
  // Native channels keep them exactly as before.
  expect(privateOnlyTool(n),n).toBe(false);
  expect(()=>assertPrivateConsoleTool({},'chief-of-staff',n)).not.toThrow();
  const priv={session:{initiator:auth()}};
  expect(()=>assertPrivateConsoleTool(priv,'chief-of-staff',n)).toThrow('Conversation authority');
  expect(()=>assertPrivateConsoleTool(priv,'chief-of-staff',n,{callerIsOwner:false})).toThrow('Conversation authority');
  expect(()=>assertPrivateConsoleTool(priv,'chief-of-staff',n,{callerIsOwner:true})).not.toThrow();
  expect(()=>assertPrivateConsoleTool(priv,'creative',n,{callerIsOwner:true})).toThrow('Conversation authority');
 }
 // Nothing else widens, not even for the owner: no send, no other tool. Event writes are owner-only and ask an exact card first.
 for(const n of ['gmail_send','gmail_signature','remember'])expect(privateToolAllowed('chief-of-staff',n,{callerIsOwner:true}),n).toBe(false);
 expect(privateToolAllowed('chief-of-staff','gmail_read',{callerIsOwner:false})).toBe(true);
 expect(privateToolAllowed('chief-of-staff','personal_mailbox_send',{callerIsOwner:false})).toBe(true);
 expect(privateRoleInstructions('chief-of-staff')).toContain('never send them');
 expect(privateRoleInstructions('chief-of-staff')).toContain('add, move and delete events');
});
it('a chief of staff may propose a new private note in a private conversation; nothing else changes notes',()=>{
 expect(privateToolAllowed('chief-of-staff','agent-kit__vault_write')).toBe(true);
 for(const name of ['agent-kit__vault_file','agent-kit__vault_drop','vault_write','remember','forget','save_note'])expect(privateToolAllowed('chief-of-staff',name),name).toBe(false);
 expect(privateToolAllowed('creative','agent-kit__vault_write')).toBe(false);
 // Native channels keep offering it under their own grant.
 expect(privateOnlyTool('agent-kit__vault_write')).toBe(false);
 expect(privateRoleInstructions('chief-of-staff')).not.toContain('general note writes are unavailable');
 expect(privateRoleInstructions('chief-of-staff')).toContain('new private note');
});
for(const method of ['doGenerate','doStream'] as const){
 it(`${method}: checks selection and real provider boundary, even after cached selection and resolver failure`,async()=>{
  const storage=new ContextContainer(),c=ctx();
  await contextStorage.run(storage,async()=>{
   markPrivateConsoleSurface();
   const call=vi.fn(async()=>{throw new Error('PROVIDER REACHED');});
   const resolver=definitionModel({resolveAlias:async()=> 'private-alias',provider:()=>new MockLanguageModelV3({doGenerate:call,doStream:call})});
   const selection=await resolver.events['step.started']!(stepEvent('surface-'+method),c as never);
   // Later resolver failure cannot authorize an already-constructed provider.
   fake.binding.mockRejectedValue(new Error('revoked'));
   await expect(resolver.events['step.started']!(stepEvent('surface-'+method,1),c as never)).rejects.toThrow('revoked');
   await expect(selection.model[method]({prompt:[]})).rejects.toThrow('revoked');expect(call).not.toHaveBeenCalled();
   fake.binding.mockResolvedValue({});
   await expect(selection.model[method]({prompt:[]})).rejects.toThrow('fresh trusted model invocation');
   const fresh=await resolver.events['step.started']!(stepEvent('surface-'+method,2),c as never);
   // The provider closes over the original coordinates, not this mutable resolver object.
   c.session.auth.current=auth('member-b');
   await expect(fresh.model[method]({prompt:[]})).rejects.toThrow('PROVIDER REACHED');
   expect(fake.binding.mock.calls.at(-1)?.[0].memberId).toBe('member-a');
  });
 });
 it(`${method}: cold private history with an old cached prompt and no current surface proof fails closed`,async()=>{
  const storage=new ContextContainer();storage.set(keys.SessionDynamicInstructionsKey,{old:[{role:'system',content:'OWNER_CANARY'}]});
  await contextStorage.run(storage,async()=>{
   const call=vi.fn();const resolver=definitionModel({resolveAlias:async()=>{throw new Error('prompt resolver failed');},provider:()=>new MockLanguageModelV3({doGenerate:call,doStream:call})});
   await expect(resolver.events['step.started']!(stepEvent('cold-'+method),ctx() as never)).rejects.toThrow('Conversation authority');expect(call).not.toHaveBeenCalled();
  });
 });
}
it('installed Eve reconstructs a persisted unsafe descriptor but the live guard refuses before authored source',async()=>{
 const storage=new ContextContainer();storage.set(keys.SessionIdKey,'cold-surface');storage.set(keys.StaticModelReferenceKey,null);
 const resolver=defineDynamic({events:{'session.started':()=>({fixture:defineTool({description:'owner source',inputSchema:defineDurableSchema({closure:{},schema:()=>z.object({})}),execute:defineDurableCallback({closure:{name:'fixture'},callback:async(c: {name:string},input:unknown,context:unknown)=>{assertPrivateConsoleTool(context,'chief-of-staff',c.name);return fake.source(input);}})})})}});
 await contextStorage.run(storage,()=>dispatchDynamicToolEvent({ctx:storage,resolvers:[{slug:'fixture',logicalPath:'fixture.ts',eventNames:['session.started'],events:resolver.events}],event:{type:'session.started',data:{},meta:{}},messages:[]}));
 const metadata=structuredClone(storage.get(keys.SessionDynamicToolMetadataKey));
 clearDurableDynamicCallbacks('cold-surface');
 // Rebind from the deployed implementation just as cold recovery does.
 await contextStorage.run(storage,()=>dispatchDynamicToolEvent({ctx:storage,resolvers:[{slug:'fixture',logicalPath:'fixture.ts',eventNames:['session.started'],events:resolver.events}],event:{type:'session.started',data:{},meta:{}},messages:[]}));
 const tools=replayDynamicTools(metadata,{sessionId:'cold-surface',scope:'session'});
 storage.set(keys.SessionKey,{sessionId:'cold-surface',auth:ctx().session.auth,turn:{id:'turn-1',sequence:0}});
 await expect(contextStorage.run(storage,()=>tools[0].execute({},{toolCallId:'call-1'}))).rejects.toThrow('Conversation authority');expect(fake.source).not.toHaveBeenCalled();
});
