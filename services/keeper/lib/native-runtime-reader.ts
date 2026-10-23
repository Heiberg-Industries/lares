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
  return Object.freeze({current:async(identity:NativeRuntimeIdentity):Promise<NativeRuntimeState>=>{
    try{
      const custody=sources.custody(),journal=sources.journal(),pool=sources.pool(),ownerId=sources.designatedOwnerId();
      if(!sources.policyFile||!custody||!journal?.prepared||!pool||!ownerId||!sources.runtimeTransportReady())return held();
      const gatewayOrigin=trustedNativeGatewayOrigin(sources.gatewayUrl());if(!gatewayOrigin)return held();
      const document=readBudgetNativePolicyDocument(sources.policyFile);
      const reviewedPolicy=selectBudgetNativeReviewedPolicy(document,identity.purposeAlias);
      const reader=createNativeRuntimeAuthority({custody,journal,pool,designatedOwnerId:ownerId,gatewayOrigin,
        endpointHash:document.endpointHash,reviewedPolicy});
      return await reader.current(identity);
    }catch{return held();}
  }});
}
