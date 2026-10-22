import {randomUUID} from 'node:crypto';
import {BudgetNativeCustodyStore,type BudgetNativeReviewedPolicy,type NativeCustodyGate} from '../../lib/budget-native-custody.js';
import {gatewayCanonical,gatewayHash} from '@lares/agent-kit/gateway-admission-protocol';
import {platformTestJournalLock,testJournalUid} from './financial-journal.js';

export const nativeTestTarget={origin:'http://gateway.invalid:4000',hash:'a'.repeat(64)};
export function nativeTestPolicy():BudgetNativeReviewedPolicy {
  const capability={version:1 as const,provider:'openai' as const,model:'synthetic-model',providerBaseUrl:'https://provider.invalid/v1',aliases:['lares-brain','lares-writer','lares-utility','lares-gate'],maxBodyBytes:1_048_576,maxOutputTokens:1000};
  return {capability,pricing:{version:1,capabilityHash:gatewayHash(gatewayCanonical(capability)),format:'openai',limits:{inputTokens:1000,outputTokens:1000},usdPerMillionTokens:{input:'1',output:'2',cacheRead:'0',cacheWrite:'0'}},maximumLiability:'0.003',team:{maxBudget:'100',models:capability.aliases,budgetDuration:'1d'},user:{maxBudget:'30',userRole:'internal_user',autoCreateKey:false},membership:{maxBudget:'20',allowedModels:capability.aliases,budgetDuration:'1d',role:'user'},key:{maxBudget:'10',models:['lares-brain'],budgetDuration:'1d',keyType:'llm_api',blocked:true}};
}
export function createNativeTestCustody(directory:string):BudgetNativeCustodyStore {
  return BudgetNativeCustodyStore.createNew(directory,{ownershipUid:testJournalUid,ownershipGid:process.getgid!(),lock:platformTestJournalLock});
}
export function openNativeTestCustody(directory:string):BudgetNativeCustodyStore {
  return BudgetNativeCustodyStore.openExisting(directory,{ownershipUid:testJournalUid,ownershipGid:process.getgid!(),lock:platformTestJournalLock});
}
export async function addUnboundNativeCredential(store:BudgetNativeCustodyStore,accountId:string,installationAccountId=randomUUID()):Promise<string>{
  let operationId='';
  await store.withGate(async(gate:NativeCustodyGate)=>{
    const policy=nativeTestPolicy(),team=gate.reserveTeam(installationAccountId,nativeTestTarget,policy),user=gate.reserveUser(accountId,team.ownershipId,policy);
    const operation=gate.prepareOperation({bindingId:randomUUID(),credentialGeneration:'0',userOwnershipId:user.ownershipId,
      association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:policy},`sk-${'x'.repeat(43)}`);
    operationId=operation.operationId;
  });
  return operationId;
}
