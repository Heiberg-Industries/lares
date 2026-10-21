import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('../src/grant-store.js',()=>({PgGrantStore:class {async captureUse(){return 1;}}}));
const fake=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../src/db.js',()=>({getPool:()=>fake}));
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
function boundRow(){return {agent:'helper',incarnation:inc,session_id:'wrun_test',member_id:'Owner-ID',admission_nonce:'a'.repeat(43),place_id:'place',audience_revision:1,policy_revision:1,agent_access_revision:1};}
describe('actual Eve HTTP routes enforce authority independently of onMessage',()=>{
 for(const role of ['chief-of-staff','creative']){
  it(`${role}: message-free create is admitted without inventing a session binding`,async()=>{
   const mod=await roleModule(role);fake.query.mockResolvedValue({rows:[{id:'Owner-ID'}]});
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
  it(`${role}: approval-only continuation is a resolver and cannot be mixed with speech`,async()=>{
   const mod=await roleModule(role);fake.query.mockResolvedValue({rows:[boundRow()]});
   const route=mod.default.routes.find((r:any)=>r.method==='POST'&&r.path==='/eve/v1/session/:sessionId');
   const respond=vi.fn(async(_responses:unknown,_options:unknown)=>({status:'accepted',sessionId:'wrun_test',deliveryId:'delivery1'}));
   const attachSession=vi.fn(()=>({respond}));
   const inputResponses=[{requestId:'request1',optionId:'approve'}];
   expect((await route.handler(request('/eve/v1/session/wrun_test',{inputResponses},'resolver'),{params:{sessionId:'wrun_test'},attachSession})).status).toBe(202);
   expect(respond.mock.calls[0]?.[1]).toMatchObject({auth:{attributes:{lares_purpose:'resolver'}}});
   attachSession.mockClear();
   expect((await route.handler(request('/eve/v1/session/wrun_test',{message:'hello',inputResponses},'resolver'),{params:{sessionId:'wrun_test'},attachSession})).status).toBe(401);
   expect(attachSession).not.toHaveBeenCalled();
  });
 }
});
