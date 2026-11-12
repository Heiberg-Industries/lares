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
  // Noted per agent and model name: a check for another model name (a model change being saved) must not
  // read as the agent itself being held and released.
  const logged=new Map<string,string>();
  const note=(identity:NativeRuntimeIdentity,why:string|null)=>{
    const key=`${identity.agent}\n${identity.purposeAlias}`;
    if((logged.get(key)??null)===why)return;
    if(why)logged.set(key,why);else logged.delete(key);
    console.error(why?`keeper: ${identity.agent} is held: ${why}`:`keeper: ${identity.agent} is no longer held`);
  };
  return Object.freeze({current:async(identity:NativeRuntimeIdentity):Promise<NativeRuntimeState>=>{
    const hold=(why:string,state:NativeRuntimeState=held())=>{note(identity,why);return state;};
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
      if(state.state!=='active')return state.detail==='no-matching-key'
        ?hold(`no spending key matches this agent, its incarnation and the model name ${identity.purposeAlias}`,state)
        :hold('the budget authority check refused');
      note(identity,null);
      return state;
    }catch{return hold('the budget authority check failed');}
  }});
}
