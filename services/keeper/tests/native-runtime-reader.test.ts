import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createKeeperNativeRuntimeReader} from '../lib/native-runtime-reader.js';
import {trustedNativeGatewayOrigin} from '../lib/budget-native-cleanup.js';
import {readBudgetNativePolicyDocument,selectBudgetNativeReviewedPolicy} from '../lib/budget-native-host.js';
import {createNativeRuntimeAuthority} from '../lib/budget-native-runtime-authority.js';

vi.mock('../lib/budget-native-cleanup.js',()=>({trustedNativeGatewayOrigin:vi.fn((url:string|undefined)=>url==='http://gateway.invalid:4000'?'http://gateway.invalid:4000':undefined)}));
vi.mock('../lib/budget-native-host.js',()=>({readBudgetNativePolicyDocument:vi.fn(),selectBudgetNativeReviewedPolicy:vi.fn()}));
vi.mock('../lib/budget-native-runtime-authority.js',()=>({createNativeRuntimeAuthority:vi.fn()}));

describe('Keeper native lifecycle reader composition',()=>{
 const identity={agent:'bookkeeper',incarnation:'11111111-1111-4111-8111-111111111111',purposeAlias:'lares-main'};
 const custody={} as never,pool={} as never;
 let journal:any,policy:any,authority:any,sources:any;
 beforeEach(()=>{
  vi.clearAllMocks();
  journal={prepared:true};policy={endpointHash:'b'.repeat(64),policies:[{key:{models:['lares-main']}}]};
  authority={current:vi.fn(async()=>({state:'active' as const}))};
  vi.mocked(readBudgetNativePolicyDocument).mockImplementation(()=>policy);
  vi.mocked(selectBudgetNativeReviewedPolicy).mockImplementation(document=>document.policies[0] as never);
  vi.mocked(createNativeRuntimeAuthority).mockReturnValue(authority as never);
  sources={policyFile:'/protected/reviewed-policy.json',custody:()=>custody,journal:()=>journal,pool:()=>pool,
   designatedOwnerId:()=> 'owner-id',gatewayUrl:()=> 'http://gateway.invalid:4000',runtimeTransportReady:()=>true};
 });

 it('holds when any live prerequisite is absent, without constructing an authority reader',async()=>{
  const reader=createKeeperNativeRuntimeReader({...sources,custody:()=>undefined});
  await expect(reader.current(identity)).resolves.toEqual({state:'held',reason:'Native budget activation required'});
  expect(readBudgetNativePolicyDocument).not.toHaveBeenCalled();
  expect(createNativeRuntimeAuthority).not.toHaveBeenCalled();
  expect(trustedNativeGatewayOrigin).not.toHaveBeenCalled();
 });

 it('logs which prerequisite held an agent, once per change, and never a value',async()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{
   let ready=false;
   const reader=createKeeperNativeRuntimeReader({...sources,runtimeTransportReady:()=>ready});
   await reader.current(identity);await reader.current(identity);
   expect(log.mock.calls.map(call=>call.join(' '))).toEqual(['keeper: bookkeeper is held: the model-purpose transport is not ready yet']);
   ready=true;authority.current.mockResolvedValueOnce({state:'held',reason:'Native budget activation required'});
   await reader.current(identity);
   expect(log.mock.calls.at(-1)!.join(' ')).toBe('keeper: bookkeeper is held: the budget authority check refused');
   await reader.current(identity);
   expect(log.mock.calls.at(-1)!.join(' ')).toBe('keeper: bookkeeper is no longer held');
   // No key at all for this agent, incarnation and model name is told apart from every other refusal.
   authority.current.mockResolvedValueOnce({state:'held',reason:'Native budget activation required',detail:'no-matching-key'});
   await expect(reader.current(identity)).resolves.toEqual({state:'held',reason:'Native budget activation required',detail:'no-matching-key'});
   expect(log.mock.calls.at(-1)!.join(' ')).toBe('keeper: bookkeeper is held: no spending key matches this agent, its incarnation and its model name');
   await reader.current(identity);
   // A check made while a model change is saved is about the new name: it never says the running agent is
   // held or released, only that the change was refused, in a fixed phrase. A passing check says nothing.
   authority.current.mockResolvedValueOnce({state:'held',reason:'Native budget activation required',detail:'no-matching-key'});
   const before=log.mock.calls.length;
   await reader.current({...identity,purposeAlias:'lares-other'},'model-change');
   await reader.current({...identity,purposeAlias:'lares-other'},'model-change');
   await reader.current(identity);
   expect(log.mock.calls.slice(before).map(call=>call.join(' '))).toEqual(['keeper: bookkeeper: a model change was refused: no spending key matches this agent, its incarnation and the new model name']);
   const all=log.mock.calls.flat().join(' ');
   for(const secret of [identity.incarnation,identity.purposeAlias,'lares-other','owner-id','/protected/reviewed-policy.json'])expect(all).not.toContain(secret);
  }finally{log.mockRestore();}
 });

 it('fails closed when protected policy, owner, pool or trusted gateway configuration is missing',async()=>{
  const incomplete=[
   {...sources,policyFile:undefined},
   {...sources,pool:()=>undefined},
   {...sources,designatedOwnerId:()=>undefined},
   {...sources,gatewayUrl:()=> 'http://gateway.invalid:4000/untrusted-path'},
  ];
  for(const candidate of incomplete){
   const reader=createKeeperNativeRuntimeReader(candidate);
   await expect(reader.current(identity)).resolves.toEqual({state:'held',reason:'Native budget activation required'});
  }
  expect(createNativeRuntimeAuthority).not.toHaveBeenCalled();
 });

 it('reloads the protected policy and endpoint commitment for every current check',async()=>{
  const reader=createKeeperNativeRuntimeReader(sources);
  await expect(reader.current(identity)).resolves.toEqual({state:'active'});
  policy={endpointHash:'c'.repeat(64),policies:[{key:{models:['lares-main']}}]};
  authority={current:vi.fn(async()=>({state:'held' as const,reason:'Native budget activation required' as const}))};
  vi.mocked(createNativeRuntimeAuthority).mockReturnValue(authority as never);
  await expect(reader.current(identity)).resolves.toEqual({state:'held',reason:'Native budget activation required'});
  expect(readBudgetNativePolicyDocument).toHaveBeenCalledTimes(2);
  expect(selectBudgetNativeReviewedPolicy).toHaveBeenCalledTimes(2);
  expect(createNativeRuntimeAuthority).toHaveBeenNthCalledWith(1,expect.objectContaining({gatewayOrigin:'http://gateway.invalid:4000',endpointHash:'b'.repeat(64)}));
  expect(createNativeRuntimeAuthority).toHaveBeenNthCalledWith(2,expect.objectContaining({gatewayOrigin:'http://gateway.invalid:4000',endpointHash:'c'.repeat(64)}));
  expect(authority.current).toHaveBeenCalledWith(identity,{});
  // A wait the lifecycle asks for reaches the authority as it is.
  await reader.current(identity,'runtime',{waitMs:10_000});
  expect(authority.current).toHaveBeenLastCalledWith(identity,{waitMs:10_000});
 });

 it('says a busy key store or ledger is busy, never that the agent is held, and keeps its held record as it was',async()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{
   const reader=createKeeperNativeRuntimeReader(sources);
   const busy={state:'held',reason:'Native budget activation required',detail:'key-store-busy'};
   authority.current.mockResolvedValueOnce({state:'held',reason:'Native budget activation required',detail:'key-store-busy'});
   await expect(reader.current(identity,'runtime',{waitMs:10_000})).resolves.toEqual(busy);
   authority.current.mockResolvedValueOnce({state:'held',reason:'Native budget activation required',detail:'ledger-busy'});
   await expect(reader.current(identity,'runtime',{waitMs:10_000})).resolves.toEqual(busy);
   authority.current.mockResolvedValueOnce({state:'held',reason:'Native budget activation required',detail:'key-store-busy'});
   await expect(reader.current({...identity,purposeAlias:'lares-other'},'model-change',{waitMs:10_000})).resolves.toEqual(busy);
   // A good check after them changes nothing either: the agent was never recorded as held.
   await expect(reader.current(identity)).resolves.toEqual({state:'active'});
   expect(log.mock.calls.map(call=>call.join(' '))).toEqual([
    'keeper: bookkeeper: the budget check could not finish: the spending-key store was busy',
    'keeper: bookkeeper: the budget check could not finish: the spending ledger was busy',
    'keeper: bookkeeper: the budget check could not finish: the spending-key store was busy']);
   // A real hold later is still logged, and released, as before.
   authority.current.mockResolvedValueOnce({state:'held',reason:'Native budget activation required'});
   await reader.current(identity);await reader.current(identity);
   expect(log.mock.calls.slice(3).map(call=>call.join(' '))).toEqual(['keeper: bookkeeper is held: the budget authority check refused','keeper: bookkeeper is no longer held']);
  }finally{log.mockRestore();}
 });

 it('rechecks live journal and transport state instead of retaining a prior reader',async()=>{
  const reader=createKeeperNativeRuntimeReader(sources);
  await expect(reader.current(identity)).resolves.toEqual({state:'active'});
  journal={prepared:false};
  await expect(reader.current(identity)).resolves.toEqual({state:'held',reason:'Native budget activation required'});
  expect(createNativeRuntimeAuthority).toHaveBeenCalledTimes(1);
  journal={prepared:true};sources.runtimeTransportReady=()=>false;
  await expect(reader.current(identity)).resolves.toEqual({state:'held',reason:'Native budget activation required'});
  expect(createNativeRuntimeAuthority).toHaveBeenCalledTimes(1);
 });
});
