/** Recovery-only local plaintext cleanup. This coordinator never calls the gateway and
 * returns no custody handle, key, or financial receipt. */
import {consoleSourceTransaction,type SourcePool} from '@lares/agent-kit/console-source-transaction';
import {BudgetNativeCustodyStore,type NativeCleanupRecoverySession} from './budget-native-custody.js';
import {HostFinancialJournal} from './financial-journal.js';
import {JournalBudgetFinancialWriter} from './budget-financial-writer.js';

export interface NativeCleanupRecoveryResult {readonly processedOperations:number}

/** Recheck the complete prepared SQL projection, append one fresh checkpoint per exact
 * raw native operation, then authorize only that operation's local key cleanup. */
export async function recoverNativePlaintextCleanup(pool:SourcePool,journal:HostFinancialJournal,directory:string):Promise<NativeCleanupRecoveryResult> {
  if(!journal.prepared)throw new Error('Prepared financial journal is required for native cleanup recovery');
  const recovery:NativeCleanupRecoverySession=BudgetNativeCustodyStore.openCleanupRecovery(directory);
  try{
    const candidates=recovery.candidates(),writer=new JournalBudgetFinancialWriter(journal);let completed=0;
    for(const candidate of candidates){
      await writer.runWithReceipt('native-cleanup-recovery',async(boundary,operationId)=>consoleSourceTransaction(pool,async()=>{
        journal.validateNativeCleanupRecoveryProjection(operationId,candidate.binding);
      },boundary,{deadlineAtMs:Date.now()+5_000}),receipt=>{
        recovery.publishLocalPlaintextCleanup(candidate.operationId,receipt);
        return undefined;
      });
      completed++;
    }
    return {processedOperations:completed};
  }finally{recovery.close();}
}
