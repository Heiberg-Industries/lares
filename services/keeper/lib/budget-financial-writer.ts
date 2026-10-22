import {createHash} from 'node:crypto';
import {canonicalBudgetMoney,type BudgetFinancialOperation,type BudgetFinancialWriter} from '@lares/agent-kit/budget-admission-store';
import {sourceTransactionBoundary,type SourceDatabase,type BudgetFinancialChange,type SourceTransactionBoundary} from '@lares/agent-kit/console-source-transaction';
import {HostFinancialJournal,FINANCIAL_ATOM_SCHEMA,markJournaledAbort,type FinancialAtom,type CommittedFinancialReceipt,type DurableFinancialAbortReceipt} from './financial-journal.js';
import {verifyFinancialContinuity} from './financial-continuity.js';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const utc=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** Keeper-owned adapter. The production gateway authority receives this prepared journal;
 * no runtime or configuration switch can supply an alternate writer. It never checks out a
 * second pool client. */
export class JournalBudgetFinancialWriter implements BudgetFinancialWriter {
  constructor(private journal:HostFinancialJournal){}
  get journalId():string{return this.journal.id;}
  run<T>(operation:BudgetFinancialOperation,work:(boundary:SourceTransactionBoundary,operationId:string)=>Promise<T>):Promise<T> {
    return this.execute(operation,work).then(result=>result.value);
  }
  runWithReceipt<T>(operation:BudgetFinancialOperation,work:(boundary:SourceTransactionBoundary,operationId:string)=>Promise<T>,publish?:(receipt:CommittedFinancialReceipt,value:T)=>undefined):Promise<{value:T;receipt:CommittedFinancialReceipt}> {
    if(!this.journal.prepared)return Promise.reject(new Error('Prepared financial journal receipt unavailable'));
    return this.execute(operation,work,publish).then(result=>{if(!result.receipt)throw new Error('Financial commit receipt unavailable');return {value:result.value,receipt:result.receipt};});
  }
  private execute<T>(operation:BudgetFinancialOperation,work:(boundary:SourceTransactionBoundary,operationId:string)=>Promise<T>,publish?:(receipt:CommittedFinancialReceipt,value:T)=>undefined):Promise<{value:T;receipt?:CommittedFinancialReceipt}> {
    let abortReceipt:DurableFinancialAbortReceipt|undefined;
    return this.journal.operation(operation,async operationId=>{
      let settled=false,proposed=false,receipt:CommittedFinancialReceipt|undefined;
      const boundary=sourceTransactionBoundary({
        started:async db=>{if(this.journal.prepared)await verifyFinancialContinuity(this.journal,db);},
        readyToCommit:async db=>{if(this.journal.prepared)await verifyFinancialContinuity(this.journal,db,true);},
        beforeCommit:async(db,changes)=>{
          const atoms=await collectFinancialAtoms(db,changes);
          const proposal=this.journal.propose(operationId,atoms);proposed=true;
          await db.query('INSERT INTO budget_financial_checkpoints(operation_id,journal_id,proposal_sequence,proposal_digest) VALUES($1,$2,$3,$4)',[proposal.operationId,proposal.journalId,proposal.sequence,proposal.digest]);
          // consoleSourceTransaction rechecks source deadlines AFTER this fsync and
          // checkpoint, before choosing its financial COMMIT or revoke-only branch.
        },
        settled:async outcome=>{
          if(outcome==='commit-acknowledged'){
            if(!proposed){this.journal.freeze();throw new Error('Financial checkpoint missing');}
            receipt=this.journal.committed(operationId);
          }else if(outcome==='unknown'){this.journal.freeze();throw new Error('Financial commit could not be confirmed');}
          else abortReceipt=this.journal.aborted(operationId,outcome);
          settled=true;
        },
      });
      try{
        let result:T;
        try{result=await work(boundary,operationId);}
        catch(error){
          // COMMIT may be durable even when the transaction wrapper withholds its
          // result afterward. Without the result, current-receipt publication cannot run.
          if(publish&&receipt){try{this.journal.freeze();}catch{/* Preserve the transaction failure. */}}
          throw error;
        }
        if(!settled)throw new Error('Financial transaction did not durably settle');
        if(publish&&receipt){
          // Only this writer's just-committed receipt crosses the held barrier.
          try{
            const publicationResult:unknown=publish(receipt,result);
            if(publicationResult!==undefined){void Promise.resolve(publicationResult).catch(()=>undefined);throw new Error('Receipt publication must be synchronous');}
          }catch(error){try{this.journal.freeze();}catch{/* Preserve the publication failure; custody remains closed. */}throw error;}
        }
        return {value:result,receipt};
      }finally{if(!settled){try{this.journal.freeze();}catch{/* Preserve the owner failure; the writer remains closed. */}}}
    }).catch(error=>{markJournaledAbort(error,abortReceipt);throw error;});
  }
}
/** Exact post-mutation financial atoms, read on the SAME owned transaction. No generic
 * row serialization: erased identity, authority, tickets and provider bodies have no field. */
export async function collectFinancialAtoms(db:SourceDatabase,changes:readonly BudgetFinancialChange[]):Promise<FinancialAtom[]> {
  if(changes.length>128)throw new Error('Financial operation is too large');
  const accounts=new Set<string>(),windows=new Set<string>(),bindings=new Set<string>(),attempts=new Set<string>(),grants=new Set<string>();
  for(const change of changes){
    if(!/^[a-f0-9-]{36}$/.test(change.id))throw new Error('Invalid financial coordinate');
    const target={budget_accounts:accounts,budget_windows:windows,budget_gateway_bindings:bindings,budget_attempts:attempts,budget_gateway_grants:grants}[change.table];
    if(!target)throw new Error('Unsupported financial table');target.add(change.id);if(change.table==='budget_gateway_grants')attempts.add(change.id);
  }
  const atoms:FinancialAtom[]=[];
  const add=(value:unknown)=>{if(atoms.length>=128)throw new Error('Financial operation is too large');atoms.push(FINANCIAL_ATOM_SCHEMA.parse(value));};
  for(const id of [...attempts].sort()){
    const a=(await db.query(`SELECT *,${utc('created_at')} AS created_utc,${utc('expires_at')} AS expires_utc,${utc('admitted_at')} AS admitted_utc FROM budget_attempts WHERE id=$1`,[id])).rows[0];if(!a)throw new Error('Financial attempt unavailable');
    accounts.add(a.installation_account_id);accounts.add(a.member_account_id);windows.add(a.installation_window_id);windows.add(a.member_window_id);bindings.add(a.binding_id);
    add({kind:'attempt',id:a.id,installationAccountId:a.installation_account_id,memberAccountId:a.member_account_id,bindingId:a.binding_id,installationWindowId:a.installation_window_id,memberWindowId:a.member_window_id,endpointHash:a.endpoint_hash,credentialGeneration:a.credential_generation,installationPolicyGeneration:a.installation_policy_generation,memberPolicyGeneration:a.member_policy_generation,endpointGeneration:a.endpoint_generation,recoveryEpochHash:hash(a.recovery_epoch),requestHash:a.request_hash,profileHash:a.profile_hash,invocationHash:a.invocation_hash,reservedAmount:canonicalBudgetMoney(a.reserved_amount),installationCapSnapshot:canonicalBudgetMoney(a.installation_cap_snapshot),memberCapSnapshot:canonicalBudgetMoney(a.member_cap_snapshot),createdAt:a.created_utc,expiresAt:a.expires_utc,admittedAt:a.admitted_utc,state:a.state,actualAmount:a.actual_amount===null?null:canonicalBudgetMoney(a.actual_amount),settlementHash:a.settlement_hash,conflictReason:a.conflict_reason,conflictHash:a.conflict_hash,highestObservedLiability:canonicalBudgetMoney(a.highest_observed_liability)});
    // The grant, if present, remains part of later settlement/unknown snapshots too.
    grants.add(id);
  }
  for(const id of [...bindings].sort()){
    const b=(await db.query('SELECT * FROM budget_gateway_bindings WHERE id=$1',[id])).rows[0];if(!b)throw new Error('Financial binding unavailable');accounts.add(b.installation_account_id);accounts.add(b.member_account_id);
    add({kind:'binding',id:b.id,installationAccountId:b.installation_account_id,memberAccountId:b.member_account_id,endpointHash:b.endpoint_hash,credentialGeneration:b.credential_generation,profileHash:b.profile_hash,maximumLiability:canonicalBudgetMoney(b.maximum_liability),pricingProfile:b.pricing_profile,state:b.state});
  }
  for(const id of [...accounts].sort()){
    const a=(await db.query('SELECT * FROM budget_accounts WHERE id=$1',[id])).rows[0];if(!a)throw new Error('Financial account unavailable');if(a.active_window_id)windows.add(a.active_window_id);
    add({kind:'account',id:a.id,installationAccountId:a.installation_account_id,accountKind:a.kind,state:a.state,reason:a.reason,activeWindowId:a.active_window_id,installationCap:a.installation_cap===null?null:canonicalBudgetMoney(a.installation_cap),policyGeneration:String(a.policy_generation),selectedEndpointHash:a.selected_endpoint,endpointGeneration:String(a.endpoint_generation),recoveryEpochHash:a.recovery_epoch===null?null:hash(a.recovery_epoch),canonicalSuppressionHash:a.canonical_suppression_hash,providerSuppressionHashes:a.provider_suppression_hashes});
  }
  for(const id of [...windows].sort()){
    const w=(await db.query(`SELECT *,${utc('starts_at')} AS starts_utc,${utc('ends_at')} AS ends_utc FROM budget_windows WHERE id=$1`,[id])).rows[0];if(!w)throw new Error('Financial window unavailable');
    add({kind:'window',id:w.id,accountId:w.account_id,startsAt:w.starts_utc,endsAt:w.ends_utc,openingLiability:canonicalBudgetMoney(w.opening_liability),openingCap:canonicalBudgetMoney(w.opening_cap),policyRevision:w.policy_revision});
  }
  for(const id of [...grants].sort()){
    const g=(await db.query('SELECT * FROM budget_gateway_grants WHERE attempt_id=$1',[id])).rows[0];if(g)add({kind:'grant',attemptId:g.attempt_id,grantHash:g.grant_hash});
  }
  return atoms;
}
