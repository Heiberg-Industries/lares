import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {pathToFileURL,fileURLToPath} from 'node:url';
const fake=vi.hoisted(()=>({binding:vi.fn(),turn:vi.fn(),source:vi.fn(),approval:vi.fn()}));
vi.mock('../src/console-turn-authority.js',async original=>({...await original<typeof import('../src/console-turn-authority.js')>(),requireConsoleSessionBinding:fake.binding,guardConsoleToolContext:fake.turn}));
const dist=pathToFileURL(fileURLToPath(new URL('../node_modules/eve/dist/src/',import.meta.url))).href;
import {verifyPrivateConsoleSession,assertPrivateConsoleTool,privateToolAllowed,privateOnlyTool,privateOwnerTool,privateRoleInstructions,privateConsoleTracePolicy} from '../src/private-console-surface.js';
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
it('the private console channel exports no trace, under the 1.0 channel name and the old one; everything else keeps its content decision',async()=>{
 const {resolveTracePolicy}=await import(`${dist}shared/trace-policy.js`);
 for(const kind of ['channel:eve','eve','http','channel:http']){
  expect(privateConsoleTracePolicy({channel:{kind}}),kind).toEqual({emit:false});
  expect(resolveTracePolicy(privateConsoleTracePolicy,{agentName:'helper',channel:{kind},audience:'private',principalType:'user',mode:'conversation',environment:'production'}),kind).toEqual({action:'drop'});
 }
 for(const kind of ['channel:slack','channel:telegram','slack','telegram','schedule','subagent','unknown'])expect(privateConsoleTracePolicy({channel:{kind}}),kind).toEqual({emit:true,recordInputs:true,recordOutputs:true});
});
// Not ported with this change, because each one drives code another part of the eve 1.0 upgrade owns:
//  - the model-selection boundary (both provider modes, cached selection, cold history): needs the new `definitionModel`.
//  - the cold replay of a persisted dynamic-tool descriptor: eve 1.0 has no durable dynamic-tool callbacks.
it.todo('model boundary: a selected model re-checks authority at the provider call in both modes, even after a cached selection or a resolver failure (needs definitionModel on eve 1.0)');
it.todo('model boundary: cold private history with an old cached prompt and no current surface proof fails closed (needs definitionModel on eve 1.0)');
it.todo('a persisted private tool descriptor replayed cold is refused before authored source (re-state for eve 1.0 dynamic tools)');
