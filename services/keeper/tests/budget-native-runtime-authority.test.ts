import {describe,it,expect,vi} from 'vitest';
import {createNativeRuntimeAuthority,matchesCurrentFinancialAtom,type NativeRuntimeIdentity} from '../lib/budget-native-runtime-authority.js';
import type {BudgetNativeCustodyStore,NativeCustodyGate} from '../lib/budget-native-custody.js';
import type {HostFinancialJournal,FinancialAtom} from '../lib/financial-journal.js';
import type {SourcePool} from '@lares/agent-kit/console-source-transaction';
import {nativeTestPolicy} from './helpers/native-cleanup.js';

const identity:NativeRuntimeIdentity={agent:'neutral-helper',incarnation:'11111111-1111-4111-8111-111111111111',
  definitionHash:'a'.repeat(64),purposeAlias:'lares-brain'};

function authorityFixture(){
  const query=vi.fn(),connect=vi.fn();
  const pool={query,connect} as unknown as SourcePool;
  const gate={inventory:()=>({version:1,storeId:'22222222-2222-4222-8222-222222222222',revision:0,teams:[],users:[],operations:[]})} as unknown as NativeCustodyGate;
  const custody={withGate:async<T>(work:(gate:NativeCustodyGate)=>Promise<T>)=>work(gate)} as unknown as BudgetNativeCustodyStore;
  const journal={prepared:true,id:'33333333-3333-4333-8333-333333333333',expectedProjection:()=>({checkpoints:[],atoms:[]})} as unknown as HostFinancialJournal;
  const authority=createNativeRuntimeAuthority({custody,journal,pool,reviewedPolicy:nativeTestPolicy(),designatedOwnerId:'owner-id',gatewayOrigin:'http://gateway.invalid:4000',endpointHash:'a'.repeat(64)});
  return {authority,query,connect};
}

describe('native runtime authority reader',()=>{
  it('holds when no exact active custody operation exists, even before consulting SQL',async()=>{
    const {authority,query,connect}=authorityFixture();
    await expect(authority.current(identity)).resolves.toEqual({state:'held',reason:'Native budget activation required'});
    expect(query).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();
  });

  it('refuses unbounded runtime identity input with the neutral reason',async()=>{
    const {authority,query}=authorityFixture();
    await expect(authority.current({...identity,operationId:'private'})).rejects.toThrow('Native budget activation required');
    await expect(authority.current({...identity,definitionHash:'not-a-hash'})).rejects.toThrow('Native budget activation required');
    expect(query).not.toHaveBeenCalled();
  });

  it('requires the locked source row to equal the journal committed atom',()=>{
    const expected:FinancialAtom={kind:'binding',id:'44444444-4444-4444-8444-444444444444',installationAccountId:'55555555-5555-4555-8555-555555555555',
      memberAccountId:'66666666-6666-4666-8666-666666666666',endpointHash:'b'.repeat(64),credentialGeneration:'3',profileHash:'c'.repeat(64),
      maximumLiability:'0.003',pricingProfile:null,state:'active'};
    expect(matchesCurrentFinancialAtom(expected,structuredClone(expected))).toBe(true);
    expect(matchesCurrentFinancialAtom(expected,{...expected,credentialGeneration:'4'})).toBe(false);
    expect(matchesCurrentFinancialAtom(undefined,expected)).toBe(false);
  });
});
