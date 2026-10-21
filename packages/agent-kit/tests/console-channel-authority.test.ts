import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {personalActionApprovalDescriptor,PERSONAL_MAIL_SEND_TOOL} from '../src/personal-action-store.js';
vi.mock('../src/grant-store.js',()=>({PgGrantStore:class {async captureUse(){return 1;}async captureUseWithExpiry(){return {accessRevision:1,validUntil:null};}}}));
const fake=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../src/db.js',()=>({getPool:()=>({query:fake.query,connect:async()=>({query:async(sql:string,values?:unknown[])=>{const result=await fake.query(sql,values);return {...result,command:['BEGIN','COMMIT','ROLLBACK'].includes(sql)?sql:result.command};},release(){}})})}));
const dist=pathToFileURL(fileURLToPath(new URL('../node_modules/eve/dist/src/',import.meta.url))).href;
const inc='11111111-1111-4111-8111-111111111111';
let directory:string|undefined;
afterEach(()=>{if(directory)rmSync(directory,{recursive:true,force:true});directory=undefined;fake.query.mockReset();vi.unstubAllEnvs();});
function request(path:string,body?:unknown,purpose='human'){
 return new Request(`http://runtime.invalid${path}`,{method:path.endsWith('/stream')?'GET':'POST',headers:{authorization:`Basic ${Buffer.from('eve:fixture-password').toString('base64')}`,'x-lares-member':'owner@example.invalid','x-lares-member-id':'Owner-ID','x-lares-admission':'a'.repeat(43),'x-lares-purpose':purpose},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function roleModule(role:string){
 directory=mkdtempSync(join(tmpdir(),'console-route-'));writeFileSync(join(directory,'password'),'fixture-password');
 vi.stubEnv('EVE_ROUTE_PASSWORD_FILE',join(directory,'password'));vi.stubEnv('LARES_AGENT_NAME','helper');vi.stubEnv('LARES_AGENT_INCARNATION',inc);vi.stubEnv('AGENT_OWNER_USER_ID','Owner-ID');
 const path=new URL(`../../../services/${role}/agent/channels/eve.ts`,import.meta.url).href;
 vi.resetModules();return import(path);
}
function boundRow(){return {agent:'helper',incarnation:inc,session_id:'wrun_test',member_id:'Owner-ID',admission_nonce:'a'.repeat(43),place_id:'place',audience_revision:1,policy_revision:2,agent_access_revision:1,private_surface_revision:2,source_history_guard_revision:1};}
type ResolverFixture = 'exact'|'missing-action'|'wrong-member'|'wrong-session'|'wrong-request'|'wrong-call'|'expired';
/** Route admission reads distinct persisted records. A session-binding row is not a member,
 * an action, or an approval. Keep SQL filtering so crossed coordinates cannot pass the mock. */
function resolverRows(failure:ResolverFixture='exact'){
 const expiresAt=new Date(Date.now()+(failure==='expired'?-60_000:60_000));
 const selection={actorMemberId:failure==='wrong-member'?'Other-ID':'Owner-ID',agentId:'helper',incarnation:inc,
  sessionId:failure==='wrong-session'?'wrun_other':'wrun_test',originalTurnId:'turn1',originalCallId:'call1',
  accountId:'account1',accountGeneration:0,resourceBindingId:'mailbox1',connectorId:'google',kind:'mail.send' as const};
 const action={id:'22222222-2222-4222-8222-222222222222',actor_member_id:selection.actorMemberId,agent:selection.agentId,incarnation:inc,
  session_id:selection.sessionId,original_turn_id:selection.originalTurnId,original_call_id:selection.originalCallId,
  account_id:selection.accountId,account_generation:0,resource_binding_id:selection.resourceBindingId,connector_id:'google',kind:'mail.send',
  payload_hash:'1'.repeat(64),expires_at:expiresAt,state:'awaiting_dispatch' as const,attempt_id:null,receipt:null,
  approval_call_id:failure==='wrong-call'?'other-call':'call1',approval_request_id:failure==='wrong-request'?'other-request':'request1'};
 const descriptor=personalActionApprovalDescriptor({actionId:action.id,payloadHash:action.payload_hash,expiresAt:expiresAt.toISOString(),
  state:action.state,attemptId:null,receipt:null},selection,'2'.repeat(64));
 const approval={call_id:'call1',request_id:'request1',tool:PERSONAL_MAIL_SEND_TOOL,agent:'helper',acting_member_id:'Owner-ID',session_id:'wrun_test',
  payload_hash:action.payload_hash,original_authority:descriptor,asked_at:new Date(Date.now()-60_000),outcome:null,resolved_by_member_id:null};
 fake.query.mockImplementation(async(sql:string,values:unknown[]=[])=>{
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('pg_advisory_xact_lock')||sql.includes('console_vault_source_captures'))return {rows:[]};
  if(sql.includes('AS organisation_id FROM users'))return {rows:values[0]==='Owner-ID'?[{organisation_id:'fixture-org'}]:[]};
  if(sql.includes('FROM console_session_bindings'))return {rows:values.slice(0,5).join('|')===['helper',inc,'wrun_test','Owner-ID','a'.repeat(43)].join('|')?[boundRow()]:[]};
  if(sql.includes('FROM agent_resources r'))return {rows:values[0]==='helper'&&values[1]===inc?[{ready:true}]:[]};
  if(sql.includes('FROM users WHERE'))return {rows:values[0]==='Owner-ID'?[{id:'Owner-ID',org_id:'fixture-org',org_role:'owner',status:'active',automation_mode:'draft-and-ask'}]:[]};
  if(sql.includes('FROM orgs WHERE'))return {rows:values[0]==='fixture-org'?[{id:'fixture-org'}]:[]};
  if(sql.includes('FROM personal_actions WHERE'))return {rows:failure!=='missing-action'&&values.join('|')===[action.approval_request_id,action.actor_member_id,action.agent,action.session_id].join('|')?[action]:[]};
  if(sql.includes('FROM approval_asks WHERE'))return {rows:values[0]===approval.call_id?[approval]:[]};
  if(sql.includes('AS alive'))return {rows:[{alive:failure!=='expired'}]};
  throw new Error('Unexpected resolver fixture query: '+sql);
 });
}
describe('actual Eve HTTP routes enforce authority independently of onMessage',()=>{
 for(const role of ['chief-of-staff','creative']){
  it(`${role}: message-free create is admitted without inventing a session binding`,async()=>{
   const mod=await roleModule(role);fake.query.mockResolvedValue({rows:[{id:'Owner-ID',organisation_id:'fixture-org',org_id:'fixture-org',org_role:'owner',status:'active',automation_mode:'draft-and-ask'}]});
   const route=mod.default.routes.find((r:any)=>r.method==='POST'&&r.path==='/eve/v1/session');
   const {attachRouteSessionCreator}=await import(`${dist}internal/nitro/routes/channel-route-context.js`);
   const create=vi.fn(async(_options:unknown)=>({sessionId:'wrun_test'}));
   const context=attachRouteSessionCreator({},create);
   const response=await route.handler(request('/eve/v1/session',{}),context);
   expect(response.status).toBe(202);expect(response.headers.get('x-eve-session-id')).toBe('wrun_test');
   expect(create.mock.calls[0]?.[0]).toMatchObject({auth:{attributes:{user_id:'owner@example.invalid',lares_member_id:'Owner-ID',lares_purpose:'human'}}});
   expect(fake.query.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO console_session_bindings'))).toBe(false);
  });
  it(`${role}: invalid bindings stop every session-addressed route before dispatch`,async()=>{
   const mod=await roleModule(role);fake.query.mockResolvedValue({rows:[]});
   for(const [suffix,purpose,body] of [['/stream','read',undefined],['','resolver',{inputResponses:[{requestId:'request1',optionId:'approve'}]}],['/cancel','control',{}],['/clear','control',{}],['/compact','control',{}],['/reset','control',{}]] as const){
    const route=mod.default.routes.find((r:any)=>r.method===(suffix==='/stream'?'GET':'POST')&&r.path===`/eve/v1/session/:sessionId${suffix}`);
    expect(route,`${role} ${suffix}`).toBeDefined();
    const attachSession=vi.fn();
    const response=await route.handler(request(`/eve/v1/session/wrun_test${suffix}`,body,purpose),{params:{sessionId:'wrun_test'},attachSession});
    expect(response.status).toBe(401);expect(attachSession).not.toHaveBeenCalled();
   }
  });
  it(`${role}: callback, observer, unknown modes and file input are rejected before Eve dispatch`,async()=>{
   const mod=await roleModule(role);fake.query.mockResolvedValue({rows:[boundRow()]});
   const route=mod.default.routes.find((r:any)=>r.method==='POST'&&r.path==='/eve/v1/session/:sessionId');
   const attachSession=vi.fn();
   const payloads=[{message:'hello',callback:{url:'https://example.invalid/output'}},{message:'hello',activityObserver:{}},{message:'hello',clientContext:'injected'},{message:'hello',mode:'task'},{message:'hello',outputSchema:{}},{message:'hello',unknown:true},{message:[{type:'file',mediaType:'text/plain',data:'internalref:private'}]}];
   for(const payload of payloads)expect((await route.handler(request('/eve/v1/session/wrun_test',payload),{params:{sessionId:'wrun_test'},attachSession})).status).toBe(401);
   expect(attachSession).not.toHaveBeenCalled();expect(fake.query).not.toHaveBeenCalled();
  });
  it(`${role}: only an exact persisted approval request becomes resolver metadata, without speech authority`,async()=>{
   const mod=await roleModule(role);resolverRows();
   const route=mod.default.routes.find((r:any)=>r.method==='POST'&&r.path==='/eve/v1/session/:sessionId');
   const respond=vi.fn(async(_responses:unknown,_options:unknown)=>({status:'accepted',sessionId:'wrun_test',deliveryId:'delivery1'}));
   const attachSession=vi.fn(()=>({respond}));
   const inputResponses=[{requestId:'request1',optionId:'approve'}];
   expect((await route.handler(request('/eve/v1/session/wrun_test',{inputResponses},'resolver'),{params:{sessionId:'wrun_test'},attachSession})).status).toBe(202);
   expect(respond.mock.calls[0]?.[1]).toMatchObject({auth:{attributes:{lares_purpose:'resolver',lares_resolver_member_id:'Owner-ID',lares_resume_request_id:'request1',lares_resume_option:'approve'}}});
   const attributes=(respond.mock.calls[0]?.[1] as {auth:{attributes:Record<string,unknown>}}).auth.attributes;
   expect(attributes).not.toHaveProperty('lares_member_id');expect(attributes).not.toHaveProperty('lares_admission_nonce');
   expect(fake.query.mock.calls.some(([sql])=>String(sql).includes('FROM personal_actions WHERE'))).toBe(true);
   attachSession.mockClear();fake.query.mockClear();
   expect((await route.handler(request('/eve/v1/session/wrun_test',{message:'hello',inputResponses},'resolver'),{params:{sessionId:'wrun_test'},attachSession})).status).toBe(401);
   expect(attachSession).not.toHaveBeenCalled();expect(fake.query).not.toHaveBeenCalled();
  });
  it.each(['missing-action','wrong-member','wrong-session','wrong-request','wrong-call','expired'] as const)(`${role}: %s approval context is refused before Eve dispatch`,async failure=>{
   const mod=await roleModule(role);resolverRows(failure);
   const route=mod.default.routes.find((r:any)=>r.method==='POST'&&r.path==='/eve/v1/session/:sessionId');
   const respond=vi.fn(),attachSession=vi.fn(()=>({respond}));
   const response=await route.handler(request('/eve/v1/session/wrun_test',{inputResponses:[{requestId:'request1',optionId:'approve'}]},'resolver'),{params:{sessionId:'wrun_test'},attachSession});
   expect(response.status).toBe(401);expect(attachSession).not.toHaveBeenCalled();expect(respond).not.toHaveBeenCalled();
  });
 }
});
