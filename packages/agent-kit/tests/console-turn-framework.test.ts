/** Exercise Eve's actual authored-hook compiler, resolver, registry and event sink. A
 * channel event with the same spelling is not equivalent: Eve drops session.started there. */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../src/db.js',()=>({getPool:()=>fake}));
// Load role modules at runtime: extension declarations cannot own downstream service sources.
const chiefPath=new URL('../../../services/chief-of-staff/agent/hooks/console-turn-authority.ts',import.meta.url).href;
const creativePath=new URL('../../../services/creative/agent/hooks/console-turn-authority.ts',import.meta.url).href;
const chiefHook=(await import(chiefPath)).default;
const creativeHook=(await import(creativePath)).default;
const dist=pathToFileURL(fileURLToPath(new URL('../node_modules/eve/dist/src/',import.meta.url))).href;
const load=async(p:string):Promise<any>=>import(`${dist}${p}`);
const inc='11111111-1111-4111-8111-111111111111';
const principal={authenticator:'lares-console',attributes:{lares_member_id:'Owner-ID',lares_admission_nonce:'a'.repeat(43),lares_purpose:'human'}};
afterEach(()=>{vi.unstubAllEnvs();fake.query.mockReset();});
async function sinkFor(hook:unknown) {
 const {compileHookEntry}=await load('compiler/normalize-hook.js');
 const {resolveHookDefinition}=await load('runtime/resolve-hook.js');
 const {createRuntimeHookRegistry}=await load('runtime/hooks/registry.js');
 const {ContextContainer,contextStorage}=await load('context/container.js');
 const keys=await load('context/keys.js');
 const {BundleKey}=await load('runtime/sessions/runtime-context-keys.js');
 const {createSessionEventSink}=await load('execution/session/event-sink.js');
 const {createSessionStartedEvent}=await load('protocol/message.js');
 const source={logicalPath:'hooks/console-turn-authority.ts',sourceId:'authority-hook',sourceKind:'module'};
 const definition=await compileHookEntry(source,{binding:source,loadNamespace:async()=>({default:hook})});
 expect(definition.eventNames).toEqual(['session.started']);
 const resolved=await resolveHookDefinition(definition,{nodes:{__root__:{modules:{'authority-hook':{default:hook}}}}},'__root__');
 const bundle={nodeId:'__root__',turnAgent:{id:'test'},graph:{root:{agent:{memories:[]}}},resolvedAgent:{dynamicInstructionsResolvers:[]},subagentRegistry:{},hookRegistry:createRuntimeHookRegistry([resolved])};
 const container=new ContextContainer();
 container.set(keys.SessionKey,{sessionId:'wrun_test',auth:{current:principal,initiator:principal},turn:{id:'turn-1',sequence:0}});
 container.set(keys.SessionIdKey,'wrun_test');container.set(keys.AuthKey,principal);container.set(keys.InitiatorAuthKey,principal);container.set(BundleKey,bundle);
 const sink=createSessionEventSink({adapter:{kind:'http'},bundle,ctx:container,effectiveAgent:{turnAgent:{id:'test'}},isFirstTurn:true,sessionWritable:new WritableStream({write(){}}),sessionId:'wrun_test'});
 return {dispatch:()=>contextStorage.run(container,()=>sink.handleEvent(createSessionStartedEvent(),[])),release:()=>sink.release()};
}
describe('both roles install a real awaited authority hook',()=>{
 for(const [role,hook] of [['chief-of-staff',chiefHook],['creative',creativeHook]] as const){
  it(`${role}: compiles and awaits binding; storage failure stops event dispatch`,async()=>{
   vi.stubEnv('LARES_AGENT_NAME','helper');vi.stubEnv('LARES_AGENT_INCARNATION',inc);vi.stubEnv('AGENT_OWNER_USER_ID','Owner-ID');
   let resolveQuery!:(value:unknown)=>void;
   fake.query.mockImplementation(()=>new Promise(resolve=>{resolveQuery=resolve;}));
   const sink=await sinkFor(hook);
   let settled=false;const dispatch=sink.dispatch().then(()=>{settled=true;});
   await vi.waitFor(()=>expect(fake.query).toHaveBeenCalledOnce());
   expect(settled).toBe(false);
   resolveQuery({rows:[{agent:'helper',incarnation:inc,session_id:'wrun_test',member_id:'Owner-ID',admission_nonce:'a'.repeat(43),place_id:'place',audience_revision:1,policy_revision:1}]});
   await dispatch;expect(settled).toBe(true);sink.release();
   fake.query.mockRejectedValue(new Error('binding unavailable'));
   const failed=await sinkFor(hook);
   await expect(failed.dispatch()).rejects.toThrow('Conversation authority');failed.release();
  });
 }
 it('the pinned event sink dispatches authored hooks before every dynamic capability',()=>{
  const source=readFileSync(new URL(`${dist}execution/session/event-sink.js`),'utf8');
  const hook=source.indexOf('await dispatchStreamEventHooks(');
  expect(hook).toBeGreaterThan(0);
  for(const name of ['dispatchDynamicModelEvent','s.dispatch','dispatchDynamicSubagentEvent','dispatchDynamicToolEvent','dispatchDynamicSkillEvent','dispatchDynamicInstructionEvent']){
   expect(source.indexOf(`await ${name}(`),name).toBeGreaterThan(hook);
  }
 });
});
