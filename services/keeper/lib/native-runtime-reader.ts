import type {SourcePool} from '@lares/agent-kit/console-source-transaction';
import type {BudgetNativeCustodyStore} from './budget-native-custody.js';
import {trustedNativeGatewayOrigin} from './budget-native-cleanup.js';
import {readBudgetNativePolicyDocument,selectBudgetNativeReviewedPolicy} from './budget-native-host.js';
import {createNativeRuntimeAuthority} from './budget-native-runtime-authority.js';
import type {HostFinancialJournal} from './financial-journal.js';
import type {NativeRuntimeAuthority,NativeRuntimeIdentity,NativeRuntimeState} from './lifecycle.js';

/** Live Keeper dependencies for the guarded lifecycle's read-only authority check. Getters
 * deliberately resolve at each call: lifecycle construction precedes journal preparation. */
export interface NativeRuntimeReaderSources {
  policyFile?:string;
  custody:()=>BudgetNativeCustodyStore|undefined;
  journal:()=>HostFinancialJournal|undefined;
  pool:()=>SourcePool|undefined;
  designatedOwnerId:()=>string|undefined;
  gatewayUrl:()=>string|undefined;
  runtimeTransportReady:()=>boolean;
}

const held=():NativeRuntimeState=>({state:'held',reason:'Native budget activation required'});

/** Rebuild the narrow current-authority reader for every lifecycle check so a changed protected
 * policy, endpoint commitment, custody owner, journal, or transport can never reuse old approval. */
export function createKeeperNativeRuntimeReader(sources:NativeRuntimeReaderSources):NativeRuntimeAuthority {
  // Every refusal reads the same to the console, so the log says which prerequisite it was: a
  // fixed phrase per step, never a value. Once per change, because the console asks often.
  const logged=new Map<string,string>();
  const note=(agent:string,why:string|null)=>{
    if((logged.get(agent)??null)===why)return;
    if(why)logged.set(agent,why);else logged.delete(agent);
    console.error(why?`keeper: ${agent} is held: ${why}`:`keeper: ${agent} is no longer held`);
  };
  return Object.freeze({current:async(identity:NativeRuntimeIdentity):Promise<NativeRuntimeState>=>{
    const hold=(why:string)=>{note(identity.agent,why);return held();};
    try{
      const custody=sources.custody(),journal=sources.journal(),pool=sources.pool(),ownerId=sources.designatedOwnerId();
      if(!sources.policyFile||!pool||!ownerId)return hold('the budget settings are incomplete');
      if(!custody)return hold('the key store is not open');
      if(!journal?.prepared)return hold('the spending ledger is not open');
      if(!sources.runtimeTransportReady())return hold('the model-purpose transport is not ready yet');
      const gatewayOrigin=trustedNativeGatewayOrigin(sources.gatewayUrl());if(!gatewayOrigin)return hold('the gateway address is not trusted');
      let document,reviewedPolicy;
      try{
        document=readBudgetNativePolicyDocument(sources.policyFile);
        reviewedPolicy=selectBudgetNativeReviewedPolicy(document,identity.purposeAlias);
      }catch{return hold('the reviewed budget policy could not be read for this model');}
      const reader=createNativeRuntimeAuthority({custody,journal,pool,designatedOwnerId:ownerId,gatewayOrigin,
        endpointHash:document.endpointHash,reviewedPolicy});
      const state=await reader.current(identity);
      if(state.state!=='active')return hold('the budget authority check refused');
      note(identity.agent,null);
      return state;
    }catch{return hold('the budget authority check failed');}
  }});
}
