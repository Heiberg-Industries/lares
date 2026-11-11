/** Exercise each role's authored authority hook the way eve 1.0 calls it: a `session.started` handler
 * given `(event, ctx)`. eve 1.0 runs a hook handler for a recorded fact before the next model call and
 * FAILS THE RUNNING TURN when the handler throws (`dist/src/public/definitions/hook.d.ts`), so a binding
 * that cannot be made stops the conversation. The old test drove eve 0.60's internal event sink, which
 * no longer exists; what it pinned is pinned below against the shipped contract instead. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(()=>({query:vi.fn(),captureUse:vi.fn(async()=>1)}));
vi.mock('../src/grant-store.js',()=>({PgGrantStore:class {captureUse=fake.captureUse;async captureUseWithExpiry(){const revision=await fake.captureUse();return revision===undefined?undefined:{accessRevision:revision,validUntil:null};}}}));
vi.mock('../src/db.js',()=>({getPool:()=>({query:fake.query,connect:async()=>({query:async(sql:string,values?:unknown[])=>{const result=await fake.query(sql,values);return {...result,command:['BEGIN','COMMIT','ROLLBACK'].includes(sql)?sql:result.command};},release(){}})})}));
// Load role modules at runtime: extension declarations cannot own downstream service sources.
const chiefPath=new URL('../../../services/chief-of-staff/agent/hooks/console-turn-authority.ts',import.meta.url).href;
const creativePath=new URL('../../../services/creative/agent/hooks/console-turn-authority.ts',import.meta.url).href;
const chiefHook=(await import(chiefPath)).default;
const creativeHook=(await import(creativePath)).default;
const inc='11111111-1111-4111-8111-111111111111';
const principal={authenticator:'lares-console',attributes:{lares_member_id:'Owner-ID',lares_admission_nonce:'a'.repeat(43),lares_purpose:'human'}};
afterEach(()=>{vi.unstubAllEnvs();fake.query.mockReset();fake.captureUse.mockClear();});
const startedEvent={type:'session.started',data:{}};
const ctxFor=(auth:unknown=principal)=>({session:{id:'wrun_test',auth:{current:auth,initiator:auth},turn:{id:'turn-1',sequence:0}},channel:{kind:'channel:eve'}});
const handlerOf=(hook:any)=>{
 expect(Object.keys(hook.events)).toEqual(['session.started']);
 return hook.events['session.started'] as (event:unknown,ctx:unknown)=>Promise<void>;
};
describe('both roles install an awaited authority hook on session.started',()=>{
 for(const [role,hook] of [['chief-of-staff',chiefHook],['creative',creativeHook]] as const){
  it(`${role}: awaits the binding; storage failure rejects so eve fails the turn`,async()=>{
   vi.stubEnv('LARES_AGENT_NAME','helper');vi.stubEnv('LARES_AGENT_INCARNATION',inc);vi.stubEnv('AGENT_OWNER_USER_ID','Owner-ID');
   let resolveQuery!:(value:unknown)=>void;
   fake.query.mockImplementation(async(sql:string)=>{
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('pg_advisory_xact_lock'))return {rows:[]};
    if(sql.includes('AS organisation_id FROM users'))return {rows:[{organisation_id:'org'}]};
    if(sql.includes('FROM users WHERE'))return {rows:[{id:'Owner-ID',org_id:'org',org_role:'owner',status:'active',automation_mode:'draft-and-ask'}]};
    if(sql.includes('FROM orgs WHERE'))return {rows:[{id:'org'}]};
    if(sql.includes('FROM agent_resources r'))return {rows:[{}]};
    if(sql.startsWith('INSERT INTO console_session_bindings'))return new Promise(resolve=>{resolveQuery=resolve;});
    throw new Error('Unexpected authority fixture query');
   });
   const handler=handlerOf(hook);
   let settled=false;const dispatch=handler(startedEvent,ctxFor()).then(()=>{settled=true;});
   await vi.waitFor(()=>expect(fake.query.mock.calls.filter(([sql])=>String(sql).startsWith('INSERT INTO console_session_bindings'))).toHaveLength(1));
   expect(fake.captureUse).toHaveBeenCalledOnce();
   expect(settled).toBe(false);
   resolveQuery({rows:[{agent:'helper',incarnation:inc,session_id:'wrun_test',member_id:'Owner-ID',admission_nonce:'a'.repeat(43),place_id:'place',audience_revision:1,policy_revision:2,agent_access_revision:1,private_surface_revision:2,source_history_guard_revision:1}]});
   await dispatch;expect(settled).toBe(true);expect(fake.captureUse).toHaveBeenCalledTimes(2);
   fake.query.mockRejectedValue(new Error('binding unavailable'));
   await expect(handler(startedEvent,ctxFor())).rejects.toThrow('Conversation authority');
  });
  it(`${role}: a malformed or resolver-only tag is refused, and an untagged session is left alone`,async()=>{
   vi.stubEnv('LARES_AGENT_NAME','helper');vi.stubEnv('LARES_AGENT_INCARNATION',inc);
   const handler=handlerOf(hook);
   fake.query.mockRejectedValue(new Error('must not be reached'));
   // Tagged but not a human admission: refused before any database work.
   const resolver={authenticator:'lares-console',attributes:{lares_member_id:'Owner-ID',lares_admission_nonce:'a'.repeat(43),lares_purpose:'resolver'}};
   await expect(handler(startedEvent,ctxFor(resolver))).rejects.toThrow('Conversation authority');
   const noNonce={authenticator:'lares-console',attributes:{lares_member_id:'Owner-ID'}};
   await expect(handler(startedEvent,ctxFor(noNonce))).rejects.toThrow('Conversation authority');
   expect(fake.query).not.toHaveBeenCalled();
   // A door conversation (no private tag) is not this hook's business.
   await expect(handler(startedEvent,ctxFor({authenticator:'slack-webhook',attributes:{}}))).resolves.toBeUndefined();
   await expect(handler(startedEvent,ctxFor(null))).resolves.toBeUndefined();
   expect(fake.query).not.toHaveBeenCalled();
  });
 }
 it('eve 1.0 still says what this relies on: handlers run before the next model call, and a throw fails the turn',()=>{
  const require=createRequire(import.meta.url);
  let dir=path.dirname(require.resolve('eve'));
  while(path.basename(dir)!=='eve'&&dir!==path.dirname(dir))dir=path.dirname(dir);
  const types=readFileSync(path.join(dir,'dist','src','public','definitions','hook.d.ts'),'utf8').replace(/\s*\n\s*\*\s*/g,' ');
  expect(types).toContain('before the next model call');
  expect(types).toContain('A handler that throws during a turn fails the turn');
  expect(types).toContain('"session.started"');
 });
});
