import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createKeeperNativeRuntimeReader} from '../lib/native-runtime-reader.js';
import {trustedNativeGatewayOrigin} from '../lib/budget-native-cleanup.js';
import {readBudgetNativePolicyDocument,selectBudgetNativeReviewedPolicy} from '../lib/budget-native-host.js';
import {createNativeRuntimeAuthority} from '../lib/budget-native-runtime-authority.js';

vi.mock('../lib/budget-native-cleanup.js',()=>({trustedNativeGatewayOrigin:vi.fn((url:string|undefined)=>url==='http://gateway.invalid:4000'?'http://gateway.invalid:4000':undefined)}));
vi.mock('../lib/budget-native-host.js',()=>({readBudgetNativePolicyDocument:vi.fn(),selectBudgetNativeReviewedPolicy:vi.fn()}));
vi.mock('../lib/budget-native-runtime-authority.js',()=>({createNativeRuntimeAuthority:vi.fn()}));

describe('Keeper native lifecycle reader composition',()=>{
 const identity={agent:'bookkeeper',incarnation:'11111111-1111-4111-8111-111111111111',definitionHash:'a'.repeat(64),purposeAlias:'lares-main'};
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
  expect(authority.current).toHaveBeenCalledWith(identity);
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
