import {afterEach,describe,expect,it} from 'vitest';
import {chmodSync,copyFileSync,fstatSync,fsyncSync,linkSync,lstatSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,statSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gatewayCanonical,gatewayHash} from '@lares/agent-kit/gateway-admission-protocol';
import {BudgetNativeCustodyStore,NATIVE_CUSTODY_MAX_BYTES,NATIVE_CUSTODY_MAX_RECORDS,budgetNativeReviewedPolicySchema,type BudgetNativeReviewedPolicy,type NativeCustodyGate,type NativeOperation} from '../lib/budget-native-custody.js';
import {HostFinancialJournal,committedFinancialEvidence,type CommittedFinancialReceipt,type FinancialAtom} from '../lib/financial-journal.js';
import {consoleSourceTransaction,sourceTransactionBoundary} from '@lares/agent-kit/console-source-transaction';
import {observeCommittedFinancialProjection} from '../lib/financial-continuity.js';
import {BudgetNativeCredentialClient,type NativeHashAbsenceReceipt} from '../lib/budget-native-client.js';
import {platformTestJournalLock} from './helpers/financial-journal.js';

const roots:string[]=[],stores:BudgetNativeCustodyStore[]=[];
const options={ownershipUid:process.getuid!(),ownershipGid:process.getgid!(),lock:platformTestJournalLock};
const fixture=(extra:{sync?:(fd:number)=>void}={})=>{
  const parent=mkdtempSync(join(realpathSync(tmpdir()),'lares-native-custody-'));roots.push(parent);
  const directory=join(parent,'custody'),store=BudgetNativeCustodyStore.createNew(directory,{...options,...extra});stores.push(store);return {directory,store};
};
const open=(directory:string)=>{const store=BudgetNativeCustodyStore.openExisting(directory,options);stores.push(store);return store;};
let financial:HostFinancialJournal|undefined;
afterEach(()=>{financial?.close();financial=undefined;for(const store of stores.splice(0))try{store.close();}catch{}for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const target={origin:'http://gateway.invalid:4000',hash:'a'.repeat(64)};
function reviewed():BudgetNativeReviewedPolicy {
  const capability={version:1 as const,provider:'openai' as const,model:'synthetic-model',providerBaseUrl:'https://provider.invalid/v1',aliases:['lares-brain','lares-writer','lares-utility','lares-gate'],maxBodyBytes:1_048_576,maxOutputTokens:1000};
  return {capability,pricing:{version:1,capabilityHash:gatewayHash(gatewayCanonical(capability)),format:'openai',limits:{inputTokens:1000,outputTokens:1000},usdPerMillionTokens:{input:'1',output:'2',cacheRead:'0',cacheWrite:'0'}},maximumLiability:'0.003',team:{maxBudget:'100',models:capability.aliases,budgetDuration:'1d'},user:{maxBudget:'30',userRole:'internal_user',autoCreateKey:false},membership:{maxBudget:'20',allowedModels:capability.aliases,budgetDuration:'1d',role:'user'},key:{maxBudget:'10',models:['lares-brain'],budgetDuration:'1d',keyType:'llm_api',blocked:true}};
}
const secret=()=>`sk-${'x'.repeat(43)}`;
function accountAtom(p:ReturnType<typeof prepare>,kind:'provision'|'member-remove'|'erase-person',installation=false):FinancialAtom {
  return {kind:'account',id:installation?p.installationId:p.accountId,installationAccountId:p.installationId,accountKind:installation?'installation':'member',state:kind==='provision'?'closed':'retired',reason:kind==='provision'?'unreconciled':kind==='erase-person'?'member_erased':'member_removed',activeWindowId:null,installationCap:installation?'100':null,policyGeneration:'0',selectedEndpointHash:null,endpointGeneration:'0',recoveryEpochHash:null,canonicalSuppressionHash:kind==='erase-person'?'d'.repeat(64):null,providerSuppressionHashes:kind==='erase-person'?['e'.repeat(64)]:[]};
}
function bindingAtom(p:ReturnType<typeof prepare>,state:'active'|'revoked'):Extract<FinancialAtom,{kind:'binding'}> {
  const policy=p.input.reviewedPolicy;return {kind:'binding',id:p.input.bindingId,installationAccountId:p.installationId,memberAccountId:p.accountId,endpointHash:target.hash,credentialGeneration:p.input.credentialGeneration,profileHash:policy.pricing.capabilityHash,maximumLiability:policy.maximumLiability,pricingProfile:policy.pricing,state};
}
// Real journal operations mint every positive fixture; copied JSON has no authority.
async function receipt(p?:ReturnType<typeof prepare>,kind:'provision'|'member-remove'|'erase-person'='member-remove',override?:FinancialAtom[]):Promise<CommittedFinancialReceipt> {
  if(!financial){
    const parent=mkdtempSync(join(realpathSync(tmpdir()),'lares-native-financial-'));roots.push(parent);const directory=join(parent,'financial');
    const database={systemIdentifier:'74683378529478211',postmasterStartedAt:'2026-10-22T00:00:00.123456Z',databaseOid:'16384'},selected={ownershipUid:options.ownershipUid,lock:options.lock};
    const preparation=HostFinancialJournal.prepareFresh(directory,database,selected);try{preparation.complete();}finally{preparation.close();}
    financial=HostFinancialJournal.openExisting(directory,{...selected,requirePrepared:true});
  }
  let result:CommittedFinancialReceipt|undefined;const j=financial;
  const atoms=override??(p?[accountAtom(p,kind),...(kind==='provision'?[accountAtom(p,kind,true),bindingAtom(p,'active')]:[]),...(kind==='erase-person'?[{kind:'tombstone' as const,accountId:p.accountId,canonicalSuppressionHash:'d'.repeat(64),providerSuppressionHashes:['e'.repeat(64)],state:'erased' as const}]:[])]:[]);
  await j.operation(kind,async id=>{j.propose(id,atoms);result=j.committed(id);});if(!result)throw new Error('Prepared receipt fixture failed');return result;
}
async function publishReceipt(gate:NativeCustodyGate,p:ReturnType<typeof prepare>,kind:'provision'|'member-remove'|'erase-person',publish:(receipt:CommittedFinancialReceipt)=>void,override?:FinancialAtom[]):Promise<void>{
  if(!financial)await receipt();const j=financial!;
  const atoms=override??[accountAtom(p,kind),...(kind==='provision'?[accountAtom(p,kind,true),bindingAtom(p,'active')]:[]),...(kind==='erase-person'?[{kind:'tombstone' as const,accountId:p.accountId,canonicalSuppressionHash:'d'.repeat(64),providerSuppressionHashes:['e'.repeat(64)],state:'erased' as const}]:[])];
  await j.operation(kind,async operationId=>{
    j.propose(operationId,atoms);
    const committed=j.committedObserved(operationId,await ownedObservationHandle(j,operationId))!;j.withPublicationProof(committed,()=>publish(committed));
  });
}
function prepare(gate:NativeCustodyGate,values:{installationId?:string;accountId?:string;bindingId?:string;key?:string;policy?:BudgetNativeReviewedPolicy}={}){
  const policy=values.policy??reviewed(),installationId=values.installationId??randomUUID(),accountId=values.accountId??randomUUID();
  let team=gate.reserveTeam(installationId,target,policy),user=gate.reserveUser(accountId,team.ownershipId,policy);
  if(team.createAttempt==='not-attempted'){gate.claimTeamCreate(team.ownershipId);gate.verifyTeamCreated(team.ownershipId);}
  team=gate.reserveTeam(installationId,target,policy);user=gate.reserveUser(accountId,team.ownershipId,policy);
  if(user.userCreateAttempt==='not-attempted'){gate.claimUserCreate(user.ownershipId);gate.verifyUserCreated(user.ownershipId);}
  user=gate.reserveUser(accountId,team.ownershipId,policy);
  if(user.membershipCreateAttempt==='not-attempted'){gate.claimMembershipCreate(user.ownershipId);gate.verifyMembershipCreated(user.ownershipId);}
  user=gate.reserveUser(accountId,team.ownershipId,policy);
  const input={bindingId:values.bindingId??randomUUID(),credentialGeneration:'0',userOwnershipId:user.ownershipId,association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:policy};
  const operation=gate.prepareOperation(input,values.key??secret());return {team,user,input,operation,accountId,installationId};
}
const bytes=(directory:string)=>Object.fromEntries(readdirSync(directory).map(name=>[name,readFileSync(join(directory,name))]));
const digestForTest=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function restoreOpenControl(directory:string):void {
  const path=join(directory,'control.json'),control=JSON.parse(readFileSync(path,'utf8'));control.state='open';
  writeFileSync(path,gatewayCanonical(control),{mode:0o600});chmodSync(path,0o600);
}
async function ownedObservationHandle(journal:HostFinancialJournal,operationId:string):Promise<Awaited<ReturnType<typeof observeCommittedFinancialProjection>>>{
  const client={async query(value:string|{text:string}){
    const sql=typeof value==='string'?value:value.text,command=/^\s*([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase();let rows:any[]=[];
    const projection=journal.expectedProjection(true),atoms=projection.atoms.filter(atom=>atom.kind!=='tombstone');
    if(sql.includes('pg_control_system'))rows=[{systemIdentifier:'74683378529478211',postmasterStartedAt:'2026-10-22T00:00:00.123456Z',databaseOid:'16384'}];
    else if(sql.includes('FROM budget_accounts) AS accounts'))rows=[{accounts:String(atoms.filter(a=>a.kind==='account').length),windows:String(atoms.filter(a=>a.kind==='window').length),bindings:String(atoms.filter(a=>a.kind==='binding').length),attempts:String(atoms.filter(a=>a.kind==='attempt').length),grants:String(atoms.filter(a=>a.kind==='grant').length),checkpoints:String(projection.checkpoints.length)}];
    else if(sql.includes('FROM budget_financial_checkpoints WHERE proposal_sequence'))rows=projection.checkpoints.map(c=>({...c,sequence:String(c.sequence)}));
    else if(sql.includes('FROM budget_financial_checkpoints ORDER BY'))rows=projection.checkpoints.slice(-1).map(c=>({...c,sequence:String(c.sequence)}));
    else if(sql.includes('FROM budget_accounts WHERE id='))rows=atoms.filter((a):a is Extract<FinancialAtom,{kind:'account'}>=>a.kind==='account').map(a=>({id:a.id,installation_account_id:a.installationAccountId,kind:a.accountKind,state:a.state,reason:a.reason,active_window_id:a.activeWindowId,installation_cap:a.installationCap,policy_generation:a.policyGeneration,selected_endpoint:a.selectedEndpointHash,endpoint_generation:a.endpointGeneration,recovery_epoch:null,canonical_suppression_hash:a.canonicalSuppressionHash,provider_suppression_hashes:a.providerSuppressionHashes}));
    else if(sql.includes('FROM budget_gateway_bindings WHERE id='))rows=atoms.filter((a):a is Extract<FinancialAtom,{kind:'binding'}>=>a.kind==='binding').map(a=>({id:a.id,installation_account_id:a.installationAccountId,member_account_id:a.memberAccountId,endpoint_hash:a.endpointHash,credential_generation:a.credentialGeneration,profile_hash:a.profileHash,maximum_liability:a.maximumLiability,pricing_profile:a.pricingProfile,state:a.state}));
    return {rows,command};
  },release(){}};
  const pool={async query(){return {rows:[]};},async connect(){return client;}};let handle:Awaited<ReturnType<typeof observeCommittedFinancialProjection>>|undefined;
  const boundary=sourceTransactionBoundary({beforeCommit:async()=>{},afterCommitObservation:async db=>{handle=await observeCommittedFinancialProjection(journal,db,operationId);return handle;},settled:async()=>{}},operationId);
  await consoleSourceTransaction(pool,async()=>undefined,boundary);if(!handle)throw new Error('Owned financial observer fixture unavailable');return handle;
}
async function cleanupRecoveryFixture(options:{revokePending?:boolean;secondKey?:boolean}={}){
  const {directory,store}=fixture();let p!:ReturnType<typeof prepare>,other!:ReturnType<typeof prepare>;
  await store.withGate(async gate=>{
    p=prepare(gate);const id=p.operation.operationId;
    gate.beginProvisioning(id);gate.claimKeyCreate(id);gate.verifyKeyCreated(id);gate.recordNativeBlockedVerification(id);
    await publishReceipt(gate,p,'provision',current=>{gate.linkFinancialOperation(id,current.operationId,current.journalId);gate.recordBoundClosed(id,current);},
      [accountAtom(p,'provision'),accountAtom(p,'provision',true),bindingAtom(p,'active')]);
    if(options.revokePending)await publishReceipt(gate,p,'member-remove',current=>gate.recordRevocation(id,current),[accountAtom(p,'member-remove'),bindingAtom(p,'revoked')]);
    if(options.secondKey)other=prepare(gate);
  });
  store.close();restoreOpenControl(directory);
  return {directory,id:p.operation.operationId,p,otherId:other?.operation.operationId};
}
async function publishCleanupProof(journal:HostFinancialJournal,recovery:ReturnType<typeof BudgetNativeCustodyStore.openCleanupRecovery>,id:string,after?:()=>void):Promise<void>{
  await journal.operation('native-cleanup-recovery',async operationId=>{
    journal.propose(operationId,[]);const current=journal.committedObserved(operationId,await ownedObservationHandle(journal,operationId));if(!current)throw new Error('Observed recovery fixture unavailable');
    journal.withPublicationProof(current,()=>{recovery.publishLocalPlaintextCleanup(id,current);after?.();});
  });
}
async function absence(fingerprint:string,challenge:string,origin=target.origin):Promise<NativeHashAbsenceReceipt> {
  const client=new BudgetNativeCredentialClient(origin,'sk-master-fixture-0123456789',async()=>new Response(JSON.stringify({key:[fingerprint],info:[]} ),{headers:{'content-type':'application/json'}}));
  const result=await client.lookupKeyHashOnly(fingerprint,challenge);if(result.kind!=='absent')throw new Error('Absence fixture failed');return result.receipt;
}

describe('protected native custody foundation',()=>{
  it('uses only a fresh observed cleanup proof for exact raw operations and leaves the control open',async()=>{
    const {directory,store}=fixture();let p!:ReturnType<typeof prepare>,id='',bindingReceipt!:CommittedFinancialReceipt;
    await store.withGate(async gate=>{
      p=prepare(gate);id=p.operation.operationId;gate.beginProvisioning(id);gate.claimKeyCreate(id);gate.verifyKeyCreated(id);gate.recordNativeBlockedVerification(id);
      await publishReceipt(gate,p,'provision',current=>{bindingReceipt=current;gate.linkFinancialOperation(id,current.operationId,current.journalId);gate.recordBoundClosed(id,current);},
        [accountAtom(p,'provision'),accountAtom(p,'provision',true),bindingAtom(p,'active')]);
      await publishReceipt(gate,p,'member-remove',()=>undefined,[accountAtom(p,'member-remove'),bindingAtom(p,'revoked')]);
    });
    store.close();restoreOpenControl(directory);
    const recovery=BudgetNativeCustodyStore.openCleanupRecovery(directory,options);
    try{
      const candidates=recovery.candidates();expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({operationId:id,accountId:p.accountId,phase:'bound-closed',plaintext:'present',binding:bindingAtom(p,'revoked')});
      expect(Object.keys(recovery).sort()).toEqual(['candidates','close','publishLocalPlaintextCleanup']);
      const before=bytes(directory);expect(()=>recovery.publishLocalPlaintextCleanup(id,bindingReceipt)).toThrow('refused');expect(bytes(directory)).toEqual(before);
      const journal=financial!;
      await journal.operation('native-cleanup-recovery',async operationId=>{
        journal.propose(operationId,[]);
        const current=journal.committedObserved(operationId,await ownedObservationHandle(journal,operationId));if(!current)throw new Error('Observed recovery fixture unavailable');
        expect(committedFinancialEvidence(current,{kind:'native-cleanup-recovery',binding:bindingAtom(p,'revoked')})?.operation).toBe('native-cleanup-recovery');
        journal.withPublicationProof(current,()=>recovery.publishLocalPlaintextCleanup(id,current));
      });
      expect(readdirSync(directory)).not.toContain(`${id}.key`);
      const snapshot=JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8'));
      expect(snapshot.operations[0]).toMatchObject({phase:'revoke-pending',plaintext:'removed',revocationReceipt:{operation:'native-cleanup-recovery'}});
      expect(snapshot.operations[0].bindingReceipt).toEqual(bindingReceipt);
      expect(JSON.parse(readFileSync(join(directory,'control.json'),'utf8')).state).toBe('open');
    }finally{recovery.close();}
    expect(JSON.parse(readFileSync(join(directory,'control.json'),'utf8')).state).toBe('open');
    expect(()=>open(directory)).toThrow('reconciliation');
  });

  it('preserves an existing revoke receipt while a current cleanup proof resumes pending local removal',async()=>{
    const {directory,store}=fixture();
    let p!:ReturnType<typeof prepare>,id='',originalRevocation!:CommittedFinancialReceipt;
    await store.withGate(async gate=>{
      p=prepare(gate);id=p.operation.operationId;gate.beginProvisioning(id);gate.claimKeyCreate(id);gate.verifyKeyCreated(id);gate.recordNativeBlockedVerification(id);
      await publishReceipt(gate,p,'provision',current=>{gate.linkFinancialOperation(id,current.operationId,current.journalId);gate.recordBoundClosed(id,current);},
        [accountAtom(p,'provision'),accountAtom(p,'provision',true),bindingAtom(p,'active')]);
      await publishReceipt(gate,p,'member-remove',current=>{originalRevocation=current;gate.recordRevocation(id,current);},
        [accountAtom(p,'member-remove'),bindingAtom(p,'revoked')]);
    });
    store.close();
    const raw=JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8'));raw.operations[0].plaintext='removal-pending';
    const snapshotBytes=gatewayCanonical(raw),snapshotPath=join(directory,'snapshot.json');writeFileSync(snapshotPath,snapshotBytes,{mode:0o600});chmodSync(snapshotPath,0o600);
    const controlPath=join(directory,'control.json'),control=JSON.parse(readFileSync(controlPath,'utf8'));control.state='open';control.snapshotDigest=digestForTest(snapshotBytes);
    writeFileSync(controlPath,gatewayCanonical(control),{mode:0o600});chmodSync(controlPath,0o600);
    const recovery=BudgetNativeCustodyStore.openCleanupRecovery(directory,options);
    try{
      expect(recovery.candidates()[0]).toMatchObject({phase:'revoke-pending',plaintext:'removal-pending'});
      const journal=financial!;
      await journal.operation('native-cleanup-recovery',async operationId=>{
        journal.propose(operationId,[]);
        const current=journal.committedObserved(operationId,await ownedObservationHandle(journal,operationId));if(!current)throw new Error('Observed recovery fixture unavailable');
        journal.withPublicationProof(current,()=>recovery.publishLocalPlaintextCleanup(id,current));
      });
      const next=JSON.parse(readFileSync(snapshotPath,'utf8')).operations[0];
      expect(next).toMatchObject({phase:'revoke-pending',plaintext:'removed'});expect(next.revocationReceipt).toEqual(originalRevocation);
      expect(JSON.parse(readFileSync(controlPath,'utf8')).state).toBe('open');expect(readdirSync(directory)).not.toContain(`${id}.key`);
    }finally{recovery.close();}
  });

  it('closes an early partially opened recovery owner without changing custody files',()=>{
    const {directory,store}=fixture();store.close();restoreOpenControl(directory);const before=bytes(directory);
    expect(()=>BudgetNativeCustodyStore.openCleanupRecovery(directory,{...options,lock:()=>{throw new Error('synthetic lock failure');}}))
      .toThrow('Native custody unavailable; explicit reconciliation is required');
    expect(bytes(directory)).toEqual(before);
  });

  it('stops before unlink when the exact retained inventory changes at the intent sync boundary',async()=>{
    let directory='';let injected=false;
    const {directory:created,store}=fixture();directory=created;let p!:ReturnType<typeof prepare>,other!:ReturnType<typeof prepare>;
    await store.withGate(async gate=>{
      p=prepare(gate);const id=p.operation.operationId;gate.beginProvisioning(id);gate.claimKeyCreate(id);gate.verifyKeyCreated(id);gate.recordNativeBlockedVerification(id);
      await publishReceipt(gate,p,'provision',current=>{gate.linkFinancialOperation(id,current.operationId,current.journalId);gate.recordBoundClosed(id,current);},[accountAtom(p,'provision'),accountAtom(p,'provision',true),bindingAtom(p,'active')]);
      await publishReceipt(gate,p,'member-remove',()=>undefined,[accountAtom(p,'member-remove'),bindingAtom(p,'revoked')]);
      other=prepare(gate,{key:`sk-${'y'.repeat(43)}`});
    });store.close();restoreOpenControl(directory);
    const recovery=BudgetNativeCustodyStore.openCleanupRecovery(directory,{...options,sync:fd=>{
      fsyncSync(fd);if(injected||!fstatSync(fd).isDirectory())return;
      let intent:any;try{intent=JSON.parse(readFileSync(join(directory,'publication-intent.json'),'utf8'));}catch{return;}
      if(intent.kind==='key-remove'){injected=true;writeFileSync(join(directory,'unexpected'),Buffer.from('foreign'),{mode:0o600});}
    }});
    try{
      const journal=financial!;
      await expect(publishCleanupProof(journal,recovery,p.operation.operationId)).rejects.toThrow();
      const row=JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8')).operations.find((value:any)=>value.operationId===p.operation.operationId);
      expect(injected).toBe(true);expect(readdirSync(directory)).toContain(`${p.operation.operationId}.key`);
      expect(row).toMatchObject({phase:'revoke-pending',plaintext:'removal-pending'});
      expect(readFileSync(join(directory,`${other.operation.operationId}.key`))).toEqual(Buffer.from(`sk-${'y'.repeat(43)}`));
      expect(readdirSync(directory)).toContain('unexpected');
    }finally{recovery.close();}
  });

  it('refuses an identical-byte replacement of a different retained key before unlink',async()=>{
    let directory='';let injected=false;let secondKey='';
    const {directory:created,store}=fixture();directory=created;let p!:ReturnType<typeof prepare>,other!:ReturnType<typeof prepare>;
    await store.withGate(async gate=>{
      p=prepare(gate);const id=p.operation.operationId;gate.beginProvisioning(id);gate.claimKeyCreate(id);gate.verifyKeyCreated(id);gate.recordNativeBlockedVerification(id);
      await publishReceipt(gate,p,'provision',current=>{gate.linkFinancialOperation(id,current.operationId,current.journalId);gate.recordBoundClosed(id,current);},[accountAtom(p,'provision'),accountAtom(p,'provision',true),bindingAtom(p,'active')]);
      await publishReceipt(gate,p,'member-remove',()=>undefined,[accountAtom(p,'member-remove'),bindingAtom(p,'revoked')]);
      other=prepare(gate,{key:`sk-${'y'.repeat(43)}`});secondKey=other.operation.operationId;
    });store.close();restoreOpenControl(directory);const secondInode=lstatSync(join(directory,`${secondKey}.key`)).ino;
    const recovery=BudgetNativeCustodyStore.openCleanupRecovery(directory,{...options,sync:fd=>{
      fsyncSync(fd);if(injected||!fstatSync(fd).isDirectory())return;
      let intent:any;try{intent=JSON.parse(readFileSync(join(directory,'publication-intent.json'),'utf8'));}catch{return;}
      if(intent.kind==='key-remove'){
        injected=true;const path=join(directory,`${secondKey}.key`),replacement=join(directory,'.foreign-key');
        copyFileSync(path,replacement);chmodSync(replacement,0o600);renameSync(replacement,path);
      }
    }});
    try{
      await expect(publishCleanupProof(financial!,recovery,p.operation.operationId)).rejects.toThrow();
      const row=JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8')).operations.find((value:any)=>value.operationId===p.operation.operationId);
      expect(injected).toBe(true);expect(readdirSync(directory)).toContain(`${p.operation.operationId}.key`);
      expect(row).toMatchObject({phase:'revoke-pending',plaintext:'removal-pending'});
      expect(lstatSync(join(directory,`${secondKey}.key`)).ino).not.toBe(secondInode);
      expect(readFileSync(join(directory,`${secondKey}.key`))).toEqual(Buffer.from(`sk-${'y'.repeat(43)}`));
    }finally{recovery.close();}
  });

  it('withdraws cleanup proof at intent sync and prevents the following unlink',async()=>{
    let directory='';let injected=false;let publicationReturned=false;const journalForFault=()=>financial!;
    const {directory:created,store}=fixture();directory=created;
    let p!:ReturnType<typeof prepare>;
    await store.withGate(async gate=>{
      p=prepare(gate);const id=p.operation.operationId;gate.beginProvisioning(id);gate.claimKeyCreate(id);gate.verifyKeyCreated(id);gate.recordNativeBlockedVerification(id);
      await publishReceipt(gate,p,'provision',current=>{gate.linkFinancialOperation(id,current.operationId,current.journalId);gate.recordBoundClosed(id,current);},[accountAtom(p,'provision'),accountAtom(p,'provision',true),bindingAtom(p,'active')]);
      await publishReceipt(gate,p,'member-remove',()=>undefined,[accountAtom(p,'member-remove'),bindingAtom(p,'revoked')]);
    });store.close();restoreOpenControl(directory);
    const recovery=BudgetNativeCustodyStore.openCleanupRecovery(directory,{...options,sync:fd=>{
      fsyncSync(fd);if(injected||!fstatSync(fd).isDirectory())return;
      let intent:any;try{intent=JSON.parse(readFileSync(join(directory,'publication-intent.json'),'utf8'));}catch{return;}
      if(intent.kind==='key-remove'){injected=true;journalForFault().freeze();}
    }});
    try{
      await expect(publishCleanupProof(financial!,recovery,p.operation.operationId,()=>{publicationReturned=true;})).rejects.toThrow();
      const row=JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8')).operations[0];
      expect(injected).toBe(true);expect(publicationReturned).toBe(false);expect(readdirSync(directory)).toContain(`${p.operation.operationId}.key`);
      expect(row).toMatchObject({phase:'revoke-pending',plaintext:'removal-pending'});
    }finally{recovery.close();}
  });

  it.each([false,true])('rejects a fresh cleanup proof from another journal for %s revocation state',async revokePending=>{
    const {directory,id,p}=await cleanupRecoveryFixture({revokePending});const originalJournal=financial!.id;financial!.close();financial=undefined;
    const foreign=await receipt(p,'member-remove',[accountAtom(p,'member-remove'),bindingAtom(p,'revoked')]);expect(foreign.journalId).not.toBe(originalJournal);
    const recovery=BudgetNativeCustodyStore.openCleanupRecovery(directory,options);
    try{
      const before=bytes(directory);await expect(publishCleanupProof(financial!,recovery,id)).rejects.toThrow('refused');
      expect(bytes(directory)).toEqual(before);
      const row=JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8')).operations[0];
      expect(row.financialJournalId).toBe(originalJournal);
      if(revokePending)expect(row.revocationReceipt.journalId).toBe(originalJournal);
    }finally{recovery.close();}
  });

  it('refuses forged, copied, unrelated and wrong-kind financial receipts without publishing',async()=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),r=await receipt(p),unrelated=await receipt({...p,accountId:randomUUID()}),wrongKind=await receipt(p,'provision'),before=bytes(directory);
      for(const invalid of [{...r},JSON.parse(JSON.stringify(r)),unrelated,wrongKind] as CommittedFinancialReceipt[]){expect(()=>gate.recordRevocation(p.operation.operationId,invalid)).toThrow('refused');expect(bytes(directory)).toEqual(before);}
      expect(gate.accountOperations(p.accountId)).toEqual([p.operation]);expect(gate.accountOperations(randomUUID())).toEqual([]);await publishReceipt(gate,p,'member-remove',current=>gate.recordRevocation(p.operation.operationId,current));
    });
  });
  it('requires exact binding policy and closed account atoms for binding completion',async()=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),id=p.operation.operationId;
      gate.beginProvisioning(id);gate.claimKeyCreate(id);gate.verifyKeyCreated(id);gate.recordNativeBlockedVerification(id);
      const badBinding={...bindingAtom(p,'active'),maximumLiability:'0.004'} as FinancialAtom;
      await publishReceipt(gate,p,'provision',bad=>{gate.linkFinancialOperation(id,bad.operationId,bad.journalId);const before=bytes(directory);expect(()=>gate.recordBoundClosed(id,bad)).toThrow('refused');expect(bytes(directory)).toEqual(before);},[accountAtom(p,'provision'),accountAtom(p,'provision',true),badBinding]);
    });
  });
  it('requires exact erased tombstone and account before removing account linkage',async()=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate);await publishReceipt(gate,p,'member-remove',current=>gate.recordRevocation(p.operation.operationId,current));gate.removePlaintext(p.operation.operationId);
      const noTombstone=await receipt(p,'erase-person',[accountAtom(p,'erase-person')]),before=bytes(directory);
      expect(()=>gate.eraseAccountAssociation(p.accountId,noTombstone)).toThrow('refused');expect(bytes(directory)).toEqual(before);
      await publishReceipt(gate,p,'erase-person',current=>gate.eraseAccountAssociation(p.accountId,current));
    });
  });
  it('requires the revoked binding for a bound operation, with erased-account closure for omitted historical bindings',async()=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),id=p.operation.operationId;gate.beginProvisioning(id);gate.claimKeyCreate(id);gate.verifyKeyCreated(id);gate.recordNativeBlockedVerification(id);
      await publishReceipt(gate,p,'provision',bound=>{gate.linkFinancialOperation(id,bound.operationId,bound.journalId);gate.recordBoundClosed(id,bound);});
      const accountOnly=await receipt(p),mismatched=await receipt(p,'member-remove',[{...bindingAtom(p,'revoked'),endpointHash:'f'.repeat(64)} as FinancialAtom,accountAtom(p,'member-remove')]),before=bytes(directory);
      for(const invalid of [accountOnly,mismatched]){expect(()=>gate.recordRevocation(id,invalid)).toThrow('refused');expect(bytes(directory)).toEqual(before);}
      // Erasure projects all member account retirement/tombstone facts even when an
      // already-revoked historical binding was excluded from its mutation projection.
      await publishReceipt(gate,p,'erase-person',erased=>{gate.recordRevocation(id,erased);gate.removePlaintext(id);gate.eraseAccountAssociation(p.accountId,erased);return undefined;});
    });
  });
  it.each([false,true])('records only a genuine exact native absence after durable revocation and plaintext removal (erased %s)',async erased=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),id=p.operation.operationId,early=await absence(p.operation.keyFingerprint,'1'.repeat(64));
      expect(()=>gate.prepareNativeAbsence(id)).toThrow('refused');expect(()=>gate.recordNativeAbsence(id,early)).toThrow('refused');await publishReceipt(gate,p,'member-remove',current=>gate.recordRevocation(id,current));
      expect(()=>gate.prepareNativeAbsence(id)).toThrow('refused');expect(()=>gate.recordNativeAbsence(id,early)).toThrow('refused');gate.removePlaintext(id);
      if(erased)await publishReceipt(gate,p,'erase-person',current=>gate.eraseAccountAssociation(p.accountId,current));
      const request=erased?gate.prepareErasedNativeAbsence(p.operation.keyFingerprint):gate.prepareNativeAbsence(id),proof=await absence(request.fingerprint,request.challenge),wrong=await absence(request.fingerprint,request.challenge,'http://other.invalid:4000'),wrongChallenge=await absence(request.fingerprint,'2'.repeat(64));
      const finish=(r:NativeHashAbsenceReceipt)=>erased?gate.recordErasedNativeAbsence(p.operation.keyFingerprint,r):gate.recordNativeAbsence(id,r),before=bytes(directory);
      for(const invalid of [{} as NativeHashAbsenceReceipt,early,wrong,wrongChallenge]){expect(()=>finish(invalid)).toThrow('refused');expect(bytes(directory)).toEqual(before);}
      finish(proof);expect(gate.inventory().operations[0]).toMatchObject({phase:'revoked',plaintext:'removed',nativeDeletion:'verified'});expect(()=>finish(proof)).toThrow('refused');
      if(!erased){await publishReceipt(gate,p,'erase-person',current=>gate.eraseAccountAssociation(p.accountId,current));expect(gate.inventory().operations[0]).toMatchObject({kind:'cleanup',phase:'revoked',nativeDeletion:'verified'});}
    });store.close();await open(directory).withGate(async gate=>expect(gate.inventory().operations[0].nativeDeletion).toBe('verified'));
  });
  it('discards absence challenges when the gate ends and when a fresh request replaces one',async()=>{
    const {directory,store}=fixture();let id!:string,old!:NativeHashAbsenceReceipt;
    await store.withGate(async gate=>{const p=prepare(gate);id=p.operation.operationId;await publishReceipt(gate,p,'member-remove',current=>gate.recordRevocation(id,current));gate.removePlaintext(id);const request=gate.prepareNativeAbsence(id);old=await absence(request.fingerprint,request.challenge);});
    await store.withGate(async gate=>{
      const before=bytes(directory);expect(()=>gate.recordNativeAbsence(id,old)).toThrow('refused');const replaced=gate.prepareNativeAbsence(id),replacedProof=await absence(replaced.fingerprint,replaced.challenge),fresh=gate.prepareNativeAbsence(id);
      for(const invalid of [old,replacedProof])expect(()=>gate.recordNativeAbsence(id,invalid)).toThrow('refused');expect(bytes(directory)).toEqual(before);
      gate.recordNativeAbsence(id,await absence(fresh.fingerprint,fresh.challenge));
    });
  });
  it('retains evidence and refuses reopen after a native-absence publication fsync failure',async()=>{
    let fail=false;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(fail)throw new Error('synthetic fsync failure');}});
    await expect(store.withGate(async gate=>{const p=prepare(gate),id=p.operation.operationId;await publishReceipt(gate,p,'member-remove',current=>gate.recordRevocation(id,current));gate.removePlaintext(id);const request=gate.prepareNativeAbsence(id),proof=await absence(request.fingerprint,request.challenge);fail=true;gate.recordNativeAbsence(id,proof);})).rejects.toThrow('reconciliation');fail=false;
    expect(()=>store.close()).not.toThrow();const before=bytes(directory);expect(()=>open(directory)).toThrow('reconciliation');expect(bytes(directory)).toEqual(before);
  });

  it('keeps a strict intent across key creation and removal without recording secrets or native identities',async()=>{
    let directory='';const observed=new Map<string,any>();
    const {store}=fixture({sync:fd=>{
      fsyncSync(fd);if(!directory||!readdirSync(directory).includes('publication-intent.json'))return;
      const record=JSON.parse(readFileSync(join(directory,'publication-intent.json'),'utf8'));observed.set(record.kind,record);
    }});directory=join(roots[roots.length-1],'custody');
    await store.withGate(async gate=>{
      const p=prepare(gate);expect(readdirSync(directory)).not.toContain('publication-intent.json');
      const created=observed.get('key-create');expect(created).toBeDefined();expect(created.key).toEqual({operationId:p.operation.operationId,keyFingerprint:p.operation.keyFingerprint});
      expect(JSON.stringify(created)).not.toContain(secret());expect(JSON.stringify(created)).not.toContain(p.team.nativeTeamId);expect(JSON.stringify(created)).not.toContain(p.user.nativeUserId);
      expect(created.next.controlDigest).toBe(gatewayHash(gatewayCanonical(JSON.parse(readFileSync(join(directory,'control.json'),'utf8')))));
      await publishReceipt(gate,p,'member-remove',current=>gate.recordRevocation(p.operation.operationId,current));gate.removePlaintext(p.operation.operationId);
      const removed=observed.get('key-remove');expect(removed).toBeDefined();expect(removed.key).toEqual(created.key);expect(removed.next.revision).toBeGreaterThan(created.next.revision);
      expect(readdirSync(directory)).not.toContain('publication-intent.json');
      await publishReceipt(gate,p,'erase-person',current=>gate.eraseAccountAssociation(p.accountId,current));
      const erasure=observed.get('snapshot');expect(erasure).toBeDefined();expect(JSON.stringify(erasure)).not.toContain(p.accountId);expect(JSON.stringify(erasure)).not.toContain(p.user.nativeUserId);
    });
    store.close();expect(readdirSync(directory)).not.toContain('publication-intent.json');const reopened=open(directory);reopened.close();
  });

  it.each([1,2,4,7])('preserves an unacknowledged publication intent at fsync boundary %i and refuses open without changing bytes',async failAt=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===failAt)throw new Error('synthetic publication sync failure');}});let returned=false;
    enabled=true;await expect(store.withGate(async gate=>{gate.reserveTeam(randomUUID(),target,reviewed());returned=true;})).rejects.toThrow('reconciliation');enabled=false;
    expect(returned).toBe(false);const before=bytes(directory);store.close();expect(()=>open(directory)).toThrow('reconciliation');expect(bytes(directory)).toEqual(before);
    if(failAt===2||failAt===4)expect(readdirSync(directory)).toContain('publication-intent.json');
    if(failAt===7)expect(readdirSync(directory)).not.toContain('publication-intent.json');
  });

  it('refuses to replace a foreign final publication intent',async()=>{
    const {directory,store}=fixture();const snapshot=readFileSync(join(directory,'snapshot.json')),foreign=gatewayCanonical({version:1,foreign:true});
    writeFileSync(join(directory,'publication-intent.json'),foreign,{mode:0o600});
    await expect(store.withGate(async gate=>{gate.reserveTeam(randomUUID(),target,reviewed());})).rejects.toThrow('reconciliation');
    expect(readFileSync(join(directory,'publication-intent.json')).equals(foreign)).toBe(true);expect(readFileSync(join(directory,'snapshot.json'))).toEqual(snapshot);
    store.close();const before=bytes(directory);expect(()=>open(directory)).toThrow('reconciliation');expect(bytes(directory)).toEqual(before);
  });

  it('preserves foreign bytes inserted during intent-file fsync after gate verification',async()=>{
    let directory='',armed=false,injected=false;const foreign=gatewayCanonical({version:1,foreign:'inserted-at-file-sync'});
    const {store}=fixture({sync:fd=>{
      fsyncSync(fd);if(!armed||injected||!directory||fstatSync(fd).isDirectory())return;
      injected=true;writeFileSync(join(directory,'publication-intent.json'),foreign,{mode:0o600});
    }});directory=join(roots[roots.length-1],'custody');const snapshot=readFileSync(join(directory,'snapshot.json'));let returned=false;
    armed=true;await expect(store.withGate(async gate=>{gate.reserveTeam(randomUUID(),target,reviewed());returned=true;})).rejects.toThrow('reconciliation');armed=false;
    expect(injected).toBe(true);expect(returned).toBe(false);expect(readFileSync(join(directory,'publication-intent.json'))).toEqual(foreign);
    expect(readFileSync(join(directory,'snapshot.json'))).toEqual(snapshot);store.close();const before=bytes(directory);
    expect(()=>open(directory)).toThrow('reconciliation');expect(bytes(directory)).toEqual(before);
  });

  it.each(['foreign-intent','snapshot-swap','control-swap'] as const)('does not return a claim when %s is inserted at the post-clear sync boundary',async tamper=>{
    let directory='',enabled=false,done=false;const {store}=fixture({sync:fd=>{
      fsyncSync(fd);if(!enabled||done||!directory||!fstatSync(fd).isDirectory()||readdirSync(directory).includes('publication-intent.json'))return;done=true;
      if(tamper==='foreign-intent')writeFileSync(join(directory,'publication-intent.json'),gatewayCanonical({version:1,foreign:true}),{mode:0o600});
      else{const name=tamper==='snapshot-swap'?'snapshot.json':'control.json',path=join(directory,name),replacement=join(directory,'replacement');copyFileSync(path,replacement);chmodSync(replacement,0o600);renameSync(replacement,path);}
    }});directory=join(roots[roots.length-1],'custody');let returned=false;
    enabled=true;await expect(store.withGate(async gate=>{gate.reserveTeam(randomUUID(),target,reviewed());returned=true;})).rejects.toThrow('reconciliation');enabled=false;
    expect(done).toBe(true);expect(returned).toBe(false);store.close();const before=bytes(directory);
    expect(()=>open(directory)).toThrow('reconciliation');expect(bytes(directory)).toEqual(before);
  });

  it('retains the exact erasure intent and refuses reopen after an interrupted snapshot rename',async()=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===4)throw new Error('synthetic erasure snapshot sync failure');}});
    await expect(store.withGate(async gate=>{
      const p=prepare(gate);await publishReceipt(gate,p,'member-remove',current=>gate.recordRevocation(p.operation.operationId,current));gate.removePlaintext(p.operation.operationId);
      enabled=true;await publishReceipt(gate,p,'erase-person',current=>gate.eraseAccountAssociation(p.accountId,current));
    })).rejects.toThrow('reconciliation');enabled=false;const intent=JSON.parse(readFileSync(join(directory,'publication-intent.json'),'utf8'));
    expect(intent.kind).toBe('snapshot');expect(JSON.stringify(intent)).not.toContain('accountId');
    const before=bytes(directory);store.close();expect(()=>open(directory)).toThrow('reconciliation');expect(bytes(directory)).toEqual(before);
  });

  it('refuses a persisted or partial publication intent byte-for-byte without adoption',()=>{
    for(const name of ['publication-intent.json','.publication-intent.json.partial']){
      const {directory,store}=fixture();store.close();writeFileSync(join(directory,name),gatewayCanonical({version:1,unexpected:true}),{mode:0o600});const before=bytes(directory);
      expect(()=>open(directory)).toThrow('reconciliation');expect(bytes(directory)).toEqual(before);
    }
  });
  it.each([5,6])('inspects and completes a persisted next snapshot/control pair after publication fsync boundary %i',async failAt=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===failAt)throw new Error('synthetic publication sync failure');}});
    enabled=true;await expect(store.withGate(async gate=>gate.reserveTeam(randomUUID(),target,reviewed()))).rejects.toThrow('reconciliation');enabled=false;store.close();
    const before=bytes(directory),inspected=BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options);
    expect(inspected).toEqual({status:'recovery-available',action:'complete-publication',runtimeReady:false});expect(bytes(directory)).toEqual(before);
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,options)).toEqual({status:'repaired-locally',action:'complete-publication',runtimeReady:false});
    expect(readdirSync(directory)).not.toContain('publication-intent.json');expect(readdirSync(directory)).not.toContain('.snapshot.json.partial');expect(readdirSync(directory)).not.toContain('.control.json.partial');
    expect(JSON.parse(readFileSync(join(directory,'control.json'),'utf8')).state).toBe('open');expect(()=>open(directory)).toThrow('reconciliation');
  });

  it.each([
    {failAt:5,name:'snapshot.json',field:'revision'},
    {failAt:4,name:'control.json',field:'revision'},
  ])('refuses a current $name that matches neither intent pair even when its partial is valid',async ({failAt,name,field})=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===failAt)throw new Error('synthetic publication sync failure');}});
    enabled=true;await expect(store.withGate(async gate=>gate.reserveTeam(randomUUID(),target,reviewed()))).rejects.toThrow('reconciliation');enabled=false;store.close();
    const value=JSON.parse(readFileSync(join(directory,name),'utf8'));value[field]=97;writeFileSync(join(directory,name),gatewayCanonical(value),{mode:0o600});const before=bytes(directory);
    expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options)).toEqual({status:'recovery-required',runtimeReady:false});
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,options)).toEqual({status:'recovery-required',runtimeReady:false});expect(bytes(directory)).toEqual(before);
  });

  it('keeps read-only inspection descriptor-clean across repeated calls',async()=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===5)throw new Error('synthetic publication sync failure');}});
    enabled=true;await expect(store.withGate(async gate=>gate.reserveTeam(randomUUID(),target,reviewed()))).rejects.toThrow('reconciliation');enabled=false;store.close();
    const descriptorCount=()=>readdirSync('/dev/fd').length,before=descriptorCount();
    for(let index=0;index<8;index++)expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options)).toEqual({status:'recovery-available',action:'complete-publication',runtimeReady:false});
    expect(descriptorCount()).toBe(before);
  });

  it.each(['file','root'] as const)('never reports repair success when the recovery %s sync fails',async failedSync=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===5)throw new Error('synthetic publication sync failure');}});
    enabled=true;await expect(store.withGate(async gate=>gate.reserveTeam(randomUUID(),target,reviewed()))).rejects.toThrow('reconciliation');enabled=false;store.close();const before=bytes(directory);
    const descriptors=()=>readdirSync('/dev/fd').length,descriptorCount=descriptors();
    const sync=(fd:number)=>{fsyncSync(fd);if(fstatSync(fd).isDirectory()===(failedSync==='root'))throw new Error(`synthetic recovery ${failedSync} sync failure`);};
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,{...options,sync})).toEqual({status:'recovery-required',runtimeReady:false});
    expect(descriptors()).toBe(descriptorCount);
    if(failedSync==='file')expect(bytes(directory)).toEqual(before);
    expect(()=>open(directory)).toThrow('reconciliation');
    expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options)).toEqual({status:'recovery-available',action:'complete-publication',runtimeReady:false});
    expect(descriptors()).toBe(descriptorCount);
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,options)).toEqual({status:'repaired-locally',action:'complete-publication',runtimeReady:false});
    expect(descriptors()).toBe(descriptorCount);
  });

  it('never reports success when the final intent-removal directory sync fails',async()=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===5)throw new Error('synthetic publication sync failure');}});
    enabled=true;await expect(store.withGate(async gate=>gate.reserveTeam(randomUUID(),target,reviewed()))).rejects.toThrow('reconciliation');enabled=false;store.close();
    let failed=false;const sync=(fd:number)=>{fsyncSync(fd);if(!failed&&fstatSync(fd).isDirectory()&&!readdirSync(directory).includes('publication-intent.json')){failed=true;throw new Error('synthetic final intent sync failure');}};
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,{...options,sync})).toEqual({status:'recovery-required',runtimeReady:false});expect(failed).toBe(true);
    expect(readdirSync(directory)).not.toContain('publication-intent.json');expect(JSON.parse(readFileSync(join(directory,'control.json'),'utf8')).state).toBe('open');expect(()=>open(directory)).toThrow('reconciliation');
  });

  it('refuses to adopt a replacement directory observed between file sync and rename',async()=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===5)throw new Error('synthetic publication sync failure');}});
    enabled=true;await expect(store.withGate(async gate=>gate.reserveTeam(randomUUID(),target,reviewed()))).rejects.toThrow('reconciliation');enabled=false;store.close();const before=bytes(directory),moved=`${directory}-moved`;
    let swapped=false;const sync=(fd:number)=>{fsyncSync(fd);if(!swapped){swapped=true;renameSync(directory,moved);mkdirSync(directory,{mode:0o700});}};
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,{...options,sync})).toEqual({status:'recovery-required',runtimeReady:false});
    expect(bytes(moved)).toEqual(before);expect(readdirSync(directory)).toEqual([]);expect(()=>open(directory)).toThrow('reconciliation');
  });

  it.each(['control.json','publication-intent.json','writer.lock'] as const)('refuses a replaced %s after partial-file sync and before rename',async targetName=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===5)throw new Error('synthetic publication sync failure');}});
    enabled=true;await expect(store.withGate(async gate=>gate.reserveTeam(randomUUID(),target,reviewed()))).rejects.toThrow('reconciliation');enabled=false;store.close();const before=bytes(directory),originalInode=statSync(join(directory,targetName)).ino;
    let swapped=false;const sync=(fd:number)=>{fsyncSync(fd);if(swapped)return;swapped=true;const path=join(directory,targetName),replacement=`${path}.replacement`;copyFileSync(path,replacement);chmodSync(replacement,0o600);renameSync(replacement,path);};
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,{...options,sync})).toEqual({status:'recovery-required',runtimeReady:false});
    expect(bytes(directory)).toEqual(before);expect(statSync(join(directory,targetName)).ino).not.toBe(originalInode);
  });

  it.each(['cross-final','extra-entry','duplicate-partial'] as const)('retains every original item when recovery evidence changes during sync: %s',async scenario=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===5)throw new Error('synthetic publication sync failure');}});
    enabled=true;await expect(store.withGate(async gate=>gate.reserveTeam(randomUUID(),target,reviewed()))).rejects.toThrow('reconciliation');enabled=false;store.close();
    if(scenario==='duplicate-partial'){copyFileSync(join(directory,'snapshot.json'),join(directory,'.snapshot.json.partial'));chmodSync(join(directory,'.snapshot.json.partial'),0o600);}
    const before=bytes(directory);let injected=false;const sync=(fd:number)=>{fsyncSync(fd);if(injected)return;injected=true;
      if(scenario==='extra-entry')writeFileSync(join(directory,'unexpected'),Buffer.from('foreign'),{mode:0o600});
      else{const path=join(directory,scenario==='cross-final'?'snapshot.json':'.snapshot.json.partial'),replacement=join(directory,'replacement');copyFileSync(path,replacement);chmodSync(replacement,0o600);renameSync(replacement,path);}
    };
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,{...options,sync})).toEqual({status:'recovery-required',runtimeReady:false});
    for(const [name,value] of Object.entries(before))if(name!=='snapshot.json'&&name!=='.snapshot.json.partial')expect(readFileSync(join(directory,name))).toEqual(value);
    expect(readdirSync(directory)).toContain('publication-intent.json');expect(readdirSync(directory)).toContain('.control.json.partial');expect(readFileSync(join(directory,'control.json'))).toEqual(before['control.json']);
  });

  it('keeps the cancellation intent when sync observes a replaced final after deleting its partial',async()=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===3)throw new Error('synthetic publication sync failure');}});
    await expect(store.withGate(async gate=>{
      const team=gate.reserveTeam(randomUUID(),target,reviewed());gate.claimTeamCreate(team.ownershipId);gate.verifyTeamCreated(team.ownershipId);
      const user=gate.reserveUser(randomUUID(),team.ownershipId,reviewed());gate.claimUserCreate(user.ownershipId);gate.verifyUserCreated(user.ownershipId);
      gate.claimMembershipCreate(user.ownershipId);gate.verifyMembershipCreated(user.ownershipId);
      const input={bindingId:randomUUID(),credentialGeneration:'0',userOwnershipId:user.ownershipId,
        association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:reviewed()};
      enabled=true;gate.prepareOperation(input,secret());
    })).rejects.toThrow('reconciliation');enabled=false;store.close();const intent=JSON.parse(readFileSync(join(directory,'publication-intent.json'),'utf8'));
    const before=bytes(directory);expect(readdirSync(directory)).toContain('.snapshot.json.partial');let swapped=false;
    const sync=(fd:number)=>{fsyncSync(fd);if(swapped||!fstatSync(fd).isDirectory()||readdirSync(directory).includes('.snapshot.json.partial'))return;swapped=true;
      const path=join(directory,'snapshot.json'),replacement=join(directory,'replacement');copyFileSync(path,replacement);chmodSync(replacement,0o600);renameSync(replacement,path);
    };
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,{...options,sync})).toEqual({status:'recovery-required',runtimeReady:false});
    expect(readdirSync(directory)).toContain('publication-intent.json');expect(readdirSync(directory)).not.toContain('.snapshot.json.partial');
    expect(readFileSync(join(directory,'snapshot.json'))).toEqual(before['snapshot.json']);expect(JSON.parse(readFileSync(join(directory,'publication-intent.json'),'utf8'))).toEqual(intent);
  });

  it.each(['target','unrelated'] as const)('retains exact %s key evidence throughout key-create recovery',async replaced=>{
    let directory='',enabled=false,failed=false;const {store}=fixture({sync:fd=>{
      fsyncSync(fd);if(!enabled||failed||!directory||fstatSync(fd).isDirectory()||!readdirSync(directory).includes('publication-intent.json'))return;
      const intent=JSON.parse(readFileSync(join(directory,'publication-intent.json'),'utf8'));
      if(intent.kind==='key-create'&&intent.key&&readdirSync(directory).includes(`${intent.key.operationId}.key`)){failed=true;throw new Error('synthetic key sync failure');}
    }});directory=join(roots[roots.length-1],'custody');let previousOperation!:NativeOperation;
    await expect(store.withGate(async gate=>{
      previousOperation=prepare(gate).operation;
      const policy=reviewed(),installationId=randomUUID(),team=gate.reserveTeam(installationId,target,policy);gate.claimTeamCreate(team.ownershipId);gate.verifyTeamCreated(team.ownershipId);
      const user=gate.reserveUser(randomUUID(),team.ownershipId,policy);gate.claimUserCreate(user.ownershipId);gate.verifyUserCreated(user.ownershipId);
      gate.claimMembershipCreate(user.ownershipId);gate.verifyMembershipCreated(user.ownershipId);
      const input={bindingId:randomUUID(),credentialGeneration:'0',userOwnershipId:user.ownershipId,
        association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:policy};
      enabled=true;gate.prepareOperation(input,`sk-${'y'.repeat(43)}`);
    })).rejects.toThrow('reconciliation');enabled=false;store.close();const intent=JSON.parse(readFileSync(join(directory,'publication-intent.json'),'utf8'));
    const name=replaced==='target'?`${intent.key.operationId}.key`:`${previousOperation.operationId}.key`,before=bytes(directory);let swapped=false;
    const sync=(fd:number)=>{fsyncSync(fd);if(swapped)return;swapped=true;const path=join(directory,name),replacement=join(directory,'replacement');copyFileSync(path,replacement);chmodSync(replacement,0o600);renameSync(replacement,path);};
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,{...options,sync})).toEqual({status:'recovery-required',runtimeReady:false});
    expect(readdirSync(directory)).toContain('publication-intent.json');for(const [file,value] of Object.entries(before))if(file!==name)expect(readFileSync(join(directory,file))).toEqual(value);
    expect(()=>open(directory)).toThrow('reconciliation');
  });

  it('refuses a missing persisted next control without changing the interrupted bytes',async()=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===4)throw new Error('synthetic publication sync failure');}});
    enabled=true;await expect(store.withGate(async gate=>gate.reserveTeam(randomUUID(),target,reviewed()))).rejects.toThrow('reconciliation');enabled=false;store.close();const before=bytes(directory);
    expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options)).toEqual({status:'recovery-required',runtimeReady:false});
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,options)).toEqual({status:'recovery-required',runtimeReady:false});expect(bytes(directory)).toEqual(before);
  });

  it('cancels an unstarted key-create intent only with the exact old pair and absent key',async()=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===2)throw new Error('synthetic key-create intent sync failure');}});let operationId='';
    await expect(store.withGate(async gate=>{
      const team=gate.reserveTeam(randomUUID(),target,reviewed());gate.claimTeamCreate(team.ownershipId);gate.verifyTeamCreated(team.ownershipId);
      const user=gate.reserveUser(randomUUID(),team.ownershipId,reviewed());gate.claimUserCreate(user.ownershipId);gate.verifyUserCreated(user.ownershipId);
      const latest=gate.reserveUser(user.accountId,team.ownershipId,reviewed());gate.claimMembershipCreate(latest.ownershipId);gate.verifyMembershipCreated(latest.ownershipId);
      const input={bindingId:randomUUID(),credentialGeneration:'0',userOwnershipId:user.ownershipId,
        association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:reviewed()};
      enabled=true;const op=gate.prepareOperation(input,secret());operationId=op.operationId;
    })).rejects.toThrow('reconciliation');enabled=false;store.close();operationId=JSON.parse(readFileSync(join(directory,'publication-intent.json'),'utf8')).key.operationId;
    const before=bytes(directory);expect(readdirSync(directory)).not.toContain(`${operationId}.key`);
    expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options)).toEqual({status:'recovery-available',action:'cancel-unstarted-key-create',runtimeReady:false});expect(bytes(directory)).toEqual(before);
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,options)).toEqual({status:'repaired-locally',action:'cancel-unstarted-key-create',runtimeReady:false});
    expect(readdirSync(directory)).not.toContain('publication-intent.json');expect(readdirSync(directory)).not.toContain(`${operationId}.key`);
  });

  it('refuses to relabel a next snapshot as key creation for an operation present in the exact previous snapshot',async()=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===3)throw new Error('synthetic publication sync failure');}});let existing!:NativeOperation;
    await expect(store.withGate(async gate=>{
      existing=prepare(gate).operation;const policy=reviewed(),team=gate.reserveTeam(randomUUID(),target,policy);gate.claimTeamCreate(team.ownershipId);gate.verifyTeamCreated(team.ownershipId);
      const user=gate.reserveUser(randomUUID(),team.ownershipId,policy);gate.claimUserCreate(user.ownershipId);gate.verifyUserCreated(user.ownershipId);gate.claimMembershipCreate(user.ownershipId);gate.verifyMembershipCreated(user.ownershipId);
      const input={bindingId:randomUUID(),credentialGeneration:'0',userOwnershipId:user.ownershipId,
        association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:policy};
      enabled=true;gate.prepareOperation(input,`sk-${'y'.repeat(43)}`);
    })).rejects.toThrow('reconciliation');enabled=false;store.close();
    const intent=JSON.parse(readFileSync(join(directory,'publication-intent.json'),'utf8'));intent.kind='key-create';intent.key={operationId:existing.operationId,keyFingerprint:existing.keyFingerprint};
    writeFileSync(join(directory,'publication-intent.json'),gatewayCanonical(intent),{mode:0o600});const before=bytes(directory);
    expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options)).toEqual({status:'recovery-required',runtimeReady:false});expect(bytes(directory)).toEqual(before);
  });

  it('completes a key-create publication only after verifying and syncing its exact key bytes',async()=>{
    let directory='',enabled=false,failed=false;const {store}=fixture({sync:fd=>{
      fsyncSync(fd);if(!enabled||failed||!directory||fstatSync(fd).isDirectory()||!readdirSync(directory).some(name=>name.endsWith('.key')))return;
      const intentPath=join(directory,'publication-intent.json');if(!readdirSync(directory).includes('publication-intent.json')||JSON.parse(readFileSync(intentPath,'utf8')).kind!=='key-create')return;
      failed=true;throw new Error('synthetic key sync failure');
    }});directory=join(roots[roots.length-1],'custody');
    await expect(store.withGate(async gate=>{
      const policy=reviewed(),installationId=randomUUID(),team=gate.reserveTeam(installationId,target,policy);gate.claimTeamCreate(team.ownershipId);gate.verifyTeamCreated(team.ownershipId);
      const user=gate.reserveUser(randomUUID(),team.ownershipId,policy);gate.claimUserCreate(user.ownershipId);gate.verifyUserCreated(user.ownershipId);
      gate.claimMembershipCreate(user.ownershipId);gate.verifyMembershipCreated(user.ownershipId);
      const input={bindingId:randomUUID(),credentialGeneration:'0',userOwnershipId:user.ownershipId,
        association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:policy};
      enabled=true;return gate.prepareOperation(input,secret());
    })).rejects.toThrow('reconciliation');enabled=false;store.close();
    const before=bytes(directory);expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options)).toEqual({status:'recovery-available',action:'complete-publication',runtimeReady:false});expect(bytes(directory)).toEqual(before);
    const alteredIntent=JSON.parse(before['publication-intent.json'].toString());alteredIntent.key.operationId=randomUUID();writeFileSync(join(directory,'publication-intent.json'),gatewayCanonical(alteredIntent),{mode:0o600});const altered=bytes(directory);
    expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options)).toEqual({status:'recovery-required',runtimeReady:false});expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,options)).toEqual({status:'recovery-required',runtimeReady:false});expect(bytes(directory)).toEqual(altered);
    writeFileSync(join(directory,'publication-intent.json'),before['publication-intent.json'],{mode:0o600});expect(bytes(directory)).toEqual(before);
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,options)).toEqual({status:'repaired-locally',action:'complete-publication',runtimeReady:false});
    const snapshot=JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8')),operation=snapshot.operations.find((row:any)=>row.kind==='operation');
    expect(operation).toMatchObject({phase:'prepared',plaintext:'present',keyCreateAttempt:'not-attempted'});expect(digestForTest(readFileSync(join(directory,`${operation.operationId}.key`)))).toBe(operation.keyFingerprint);
    expect(readdirSync(directory)).not.toContain('publication-intent.json');expect(()=>open(directory)).toThrow('reconciliation');
  });

  it('refuses a key-create next pair when the required key has not reached disk',async()=>{
    let directory='',enabled=false,failed=false;const {store}=fixture({sync:fd=>{
      fsyncSync(fd);if(!enabled||failed||!directory||!fstatSync(fd).isDirectory()||!readdirSync(directory).includes('publication-intent.json'))return;
      const intent=JSON.parse(readFileSync(join(directory,'publication-intent.json'),'utf8'));
      if(intent.kind==='key-create'&&digestForTest(readFileSync(join(directory,'control.json')) )===intent.next.controlDigest&&!readdirSync(directory).includes(`${intent.key.operationId}.key`)){failed=true;throw new Error('synthetic key-not-created crash');}
    }});directory=join(roots[roots.length-1],'custody');
    await expect(store.withGate(async gate=>{
      const policy=reviewed(),team=gate.reserveTeam(randomUUID(),target,policy);gate.claimTeamCreate(team.ownershipId);gate.verifyTeamCreated(team.ownershipId);
      const user=gate.reserveUser(randomUUID(),team.ownershipId,policy);gate.claimUserCreate(user.ownershipId);gate.verifyUserCreated(user.ownershipId);gate.claimMembershipCreate(user.ownershipId);gate.verifyMembershipCreated(user.ownershipId);
      const input={bindingId:randomUUID(),credentialGeneration:'0',userOwnershipId:user.ownershipId,
        association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:policy};
      enabled=true;gate.prepareOperation(input,secret());
    })).rejects.toThrow('reconciliation');enabled=false;store.close();const before=bytes(directory);
    expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options)).toEqual({status:'recovery-required',runtimeReady:false});
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,options)).toEqual({status:'recovery-required',runtimeReady:false});expect(bytes(directory)).toEqual(before);
  });

  it('completes a key-remove next pair only when the exact key is absent',async()=>{
    let directory='',enabled=false,failed=false;const {store}=fixture({sync:fd=>{
      fsyncSync(fd);if(!enabled||failed||!directory||!fstatSync(fd).isDirectory()||!readdirSync(directory).includes('publication-intent.json'))return;
      const intent=JSON.parse(readFileSync(join(directory,'publication-intent.json'),'utf8'));
      if(intent.kind==='key-remove'&&digestForTest(readFileSync(join(directory,'control.json')) )===intent.next.controlDigest&&!readdirSync(directory).includes(`${intent.key.operationId}.key`)){failed=true;throw new Error('synthetic key-removed crash');}
    }});directory=join(roots[roots.length-1],'custody');let operationId='';
    await expect(store.withGate(async gate=>{
      const p=prepare(gate);operationId=p.operation.operationId;await publishReceipt(gate,p,'member-remove',current=>gate.recordRevocation(operationId,current));enabled=true;gate.removePlaintext(operationId);
    })).rejects.toThrow('reconciliation');enabled=false;store.close();const before=bytes(directory);
    expect(readdirSync(directory)).not.toContain(`${operationId}.key`);expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options)).toEqual({status:'recovery-available',action:'complete-publication',runtimeReady:false});expect(bytes(directory)).toEqual(before);
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,options)).toEqual({status:'repaired-locally',action:'complete-publication',runtimeReady:false});expect(readdirSync(directory)).not.toContain(`${operationId}.key`);expect(readdirSync(directory)).not.toContain('publication-intent.json');
  });

  it('cancels a key-remove intent only while removal-pending and the exact plaintext key remain',async()=>{
    let directory='',enabled=false,failed=false;const {store}=fixture({sync:fd=>{
      fsyncSync(fd);if(!enabled||failed||!directory||!fstatSync(fd).isDirectory()||!readdirSync(directory).includes('publication-intent.json'))return;
      if(JSON.parse(readFileSync(join(directory,'publication-intent.json'),'utf8')).kind==='key-remove'){failed=true;throw new Error('synthetic key-remove intent sync failure');}
    }});directory=join(roots[roots.length-1],'custody');let operationId='';
    await expect(store.withGate(async gate=>{
      const p=prepare(gate);operationId=p.operation.operationId;await publishReceipt(gate,p,'member-remove',current=>gate.recordRevocation(operationId,current));
      enabled=true;gate.removePlaintext(operationId);
    })).rejects.toThrow('reconciliation');enabled=false;store.close();
    const before=bytes(directory),snapshot=JSON.parse(before['snapshot.json'].toString()),operation=snapshot.operations.find((row:any)=>row.operationId===operationId);
    expect(operation).toMatchObject({phase:'revoke-pending',plaintext:'removal-pending',nativeDeletion:'unverified'});
    expect(digestForTest(readFileSync(join(directory,`${operationId}.key`)))).toBe(operation.keyFingerprint);
    expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options)).toEqual({status:'recovery-available',action:'cancel-local-key-removal',runtimeReady:false});expect(bytes(directory)).toEqual(before);
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,options)).toEqual({status:'repaired-locally',action:'cancel-local-key-removal',runtimeReady:false});
    expect(JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8')).operations.find((row:any)=>row.operationId===operationId)).toMatchObject({phase:'revoke-pending',plaintext:'removal-pending'});
    expect(digestForTest(readFileSync(join(directory,`${operationId}.key`)))).toBe(operation.keyFingerprint);
  });

  it('refuses a foreign publication intent and preserves every byte',()=>{
    const {directory,store}=fixture();store.close();writeFileSync(join(directory,'publication-intent.json'),gatewayCanonical({version:1,foreign:true}),{mode:0o600});const before=bytes(directory);
    expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options)).toEqual({status:'recovery-required',runtimeReady:false});
    expect(BudgetNativeCustodyStore.repairPublicationRecovery(directory,options)).toEqual({status:'recovery-required',runtimeReady:false});expect(bytes(directory)).toEqual(before);
  });

  it('reports an unchanged open store with no intent without making it runtime-ready',()=>{
    const {directory,store}=fixture();store.close();const control=JSON.parse(readFileSync(join(directory,'control.json'),'utf8'));control.state='open';writeFileSync(join(directory,'control.json'),gatewayCanonical(control),{mode:0o600});const before=bytes(directory);
    expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options)).toEqual({status:'no-intent',runtimeReady:false});expect(bytes(directory)).toEqual(before);
    expect(()=>open(directory)).toThrow('reconciliation');
    control.state='uncertain';writeFileSync(join(directory,'control.json'),gatewayCanonical(control),{mode:0o600});const uncertain=bytes(directory);
    expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,options)).toEqual({status:'recovery-required',runtimeReady:false});expect(bytes(directory)).toEqual(uncertain);
  });

  it.each(['mode','hardlink','symlink','owner'] as const)('refuses recovery files with altered %s protection',async scenario=>{
    const {directory,store}=fixture();let keyName='';if(scenario==='hardlink')await store.withGate(async gate=>{const p=prepare(gate);keyName=`${p.operation.operationId}.key`;});store.close();
    if(scenario==='mode')chmodSync(join(directory,'control.json'),0o640);
    if(scenario==='hardlink')linkSync(join(directory,keyName),join(directory,`${keyName}.extra`));
    if(scenario==='symlink'){renameSync(join(directory,'snapshot.json'),join(directory,'snapshot.saved'));symlinkSync(join(directory,'snapshot.saved'),join(directory,'snapshot.json'));}
    const recoveryOptions=scenario==='owner'?{...options,ownershipUid:options.ownershipUid+1}:options;
    expect(BudgetNativeCustodyStore.inspectPublicationRecovery(directory,recoveryOptions)).toEqual({status:'recovery-required',runtimeReady:false});
    if(scenario==='symlink')expect(lstatSync(join(directory,'snapshot.json')).isSymbolicLink()).toBe(true);
  });
  it('requires explicit creation, clean close and exact protected files',async()=>{
    const missing=join(realpathSync(tmpdir()),`lares-native-missing-${randomUUID()}`);
    expect(()=>open(missing)).toThrow('reconciliation');expect(()=>statSync(missing)).toThrow();
    const {directory,store}=fixture();expect(statSync(directory).mode&0o777).toBe(0o700);
    expect(()=>BudgetNativeCustodyStore.createNew(directory,options)).toThrow('reconciliation');
    await store.withGate(async gate=>{const p=prepare(gate);expect(gate.readKey(p.operation.operationId)).toBe(secret());});
    for(const name of readdirSync(directory))expect(statSync(join(directory,name)).mode&0o777).toBe(0o600);
    store.close();const next=open(directory);await next.withGate(async gate=>expect(gate.inventory().operations).toHaveLength(1));
  });

  it('persists stable shared team/user ownership across several credentials and restarts',async()=>{
    const {directory,store}=fixture(),installationId=randomUUID(),accountId=randomUUID();let first!:ReturnType<typeof prepare>;
    await store.withGate(async gate=>{
      first=prepare(gate,{installationId,accountId});const team=gate.reserveTeam(installationId,target,reviewed()),user=gate.reserveUser(accountId,team.ownershipId,reviewed());
      expect(team).toEqual(first.team);expect(user).toEqual(first.user);
      const second=gate.prepareOperation({...first.input,bindingId:randomUUID(),credentialGeneration:'1'},`sk-${'y'.repeat(43)}`);
      expect(second.userOwnershipId).toBe(user.ownershipId);expect(gate.inventory().teams).toHaveLength(1);expect(gate.inventory().users).toHaveLength(1);
    });store.close();await open(directory).withGate(async gate=>{expect(gate.reserveTeam(installationId,target,reviewed())).toEqual(first.team);expect(gate.reserveUser(accountId,first.team.ownershipId,reviewed())).toEqual(first.user);});
  });

  it('persists fixed write attempts before returning permission and refuses repeats without dirtying clean custody',async()=>{
    const {directory,store}=fixture(),installationId=randomUUID(),accountId=randomUUID(),policy=reviewed();let teamId='',userId='',operationId='';let expectedTeam!:ReturnType<NativeCustodyGate['reserveTeam']>,expectedUser!:ReturnType<NativeCustodyGate['reserveUser']>;
    await store.withGate(async gate=>{
      const team=gate.reserveTeam(installationId,target,policy),beforeTeam=bytes(directory);
      expect(()=>gate.verifyTeamCreated(team.ownershipId)).toThrow('refused');expect(bytes(directory)).toEqual(beforeTeam);
      const teamIntent=gate.claimTeamCreate(team.ownershipId);expect(teamIntent).toMatchObject({nativeTeamId:team.nativeTeamId,endpoint:target,policy:policy.team,createAttempt:'attempted'});
      expect(Object.isFrozen(teamIntent)&&Object.isFrozen(teamIntent.endpoint)&&Object.isFrozen(teamIntent.policy)).toBe(true);
      const afterTeam=bytes(directory);expect(afterTeam).not.toEqual(beforeTeam);expect(()=>gate.claimTeamCreate(team.ownershipId)).toThrow('refused');expect(bytes(directory)).toEqual(afterTeam);
      teamId=team.ownershipId;gate.verifyTeamCreated(teamId);expect(()=>gate.verifyTeamCreated(teamId)).toThrow('refused');
      const user=gate.reserveUser(accountId,teamId,policy),beforeUser=bytes(directory);
      expect(()=>gate.claimMembershipCreate(user.ownershipId)).toThrow('refused');expect(bytes(directory)).toEqual(beforeUser);
      expect(()=>gate.verifyUserCreated(user.ownershipId)).toThrow('refused');expect(bytes(directory)).toEqual(beforeUser);
      const userIntent=gate.claimUserCreate(user.ownershipId);expect(userIntent).toMatchObject({nativeUserId:user.nativeUserId,teamOwnershipId:teamId,policy:policy.user,membership:policy.membership,userCreateAttempt:'attempted'});
      expect(Object.isFrozen(userIntent)&&Object.isFrozen(userIntent.policy)&&Object.isFrozen(userIntent.membership)).toBe(true);
      const afterUser=bytes(directory);expect(()=>gate.claimUserCreate(user.ownershipId)).toThrow('refused');expect(bytes(directory)).toEqual(afterUser);
      userId=user.ownershipId;gate.verifyUserCreated(userId);expect(()=>gate.verifyMembershipCreated(userId)).toThrow('refused');gate.claimMembershipCreate(userId);
      const input={bindingId:randomUUID(),credentialGeneration:'0',userOwnershipId:userId,association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:policy},p=gate.prepareOperation(input,secret());
      operationId=p.operationId;const beforeProvision=bytes(directory);expect(()=>gate.claimKeyCreate(operationId)).toThrow('refused');expect(bytes(directory)).toEqual(beforeProvision);gate.beginProvisioning(operationId);
      const beforeKey=bytes(directory);expect(()=>gate.claimKeyCreate(operationId)).toThrow('refused');expect(()=>gate.verifyKeyCreated(operationId)).toThrow('refused');expect(()=>gate.recordNativeBlockedVerification(operationId)).toThrow('refused');expect(bytes(directory)).toEqual(beforeKey);
      gate.verifyMembershipCreated(userId);expectedTeam=gate.reserveTeam(installationId,target,policy);expectedUser=gate.reserveUser(accountId,teamId,policy);
      const keyIntent=gate.claimKeyCreate(operationId);expect(keyIntent).toMatchObject({operationId,keyFingerprint:p.keyFingerprint,reviewedPolicy:policy,keyCreateAttempt:'attempted'});
      expect(Object.isFrozen(keyIntent)&&Object.isFrozen(keyIntent.reviewedPolicy)&&Object.isFrozen(keyIntent.reviewedPolicy.key)).toBe(true);
      const afterKey=bytes(directory);expect(()=>gate.claimKeyCreate(operationId)).toThrow('refused');expect(bytes(directory)).toEqual(afterKey);
    });
    store.close();const reopened=open(directory);
    await reopened.withGate(async gate=>{
      const before=bytes(directory),inventory=gate.inventory(),persistedTeam=inventory.teams.find(t=>t.ownershipId===teamId),persistedUser=inventory.users.find(u=>u.kind==='user'&&u.ownershipId===userId),persistedOperation=inventory.operations.find(o=>o.kind==='operation'&&o.operationId===operationId);
      expect(persistedTeam).toEqual(expectedTeam);expect(persistedUser).toEqual(expectedUser);expect(persistedOperation).toMatchObject({keyCreateAttempt:'attempted',phase:'provisioning',reviewedPolicy:policy});
      expect(gate.reserveTeam(installationId,target,policy)).toEqual(expectedTeam);expect(gate.reserveUser(accountId,teamId,policy)).toEqual(expectedUser);
      expect(()=>gate.claimKeyCreate(operationId)).toThrow('refused');expect(bytes(directory)).toEqual(before);
    });
  });

  it('allows durable preparation before any native write, blocks key claims until prerequisites, and erases never-attempted identities',async()=>{
    const {directory,store}=fixture();let opId='',accountId='';
    await store.withGate(async gate=>{
      const policy=reviewed(),installationId=randomUUID();accountId=randomUUID();const team=gate.reserveTeam(installationId,target,policy),user=gate.reserveUser(accountId,team.ownershipId,policy),input={bindingId:randomUUID(),credentialGeneration:'0',userOwnershipId:user.ownershipId,association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:policy};
      const operation=gate.prepareOperation(input,secret());opId=operation.operationId;gate.beginProvisioning(opId);const before=bytes(directory);
      expect(()=>gate.claimKeyCreate(opId)).toThrow('refused');expect(bytes(directory)).toEqual(before);
      const p={team,user,input,operation,accountId,installationId};await publishReceipt(gate,p,'erase-person',current=>{gate.recordRevocation(opId,current);gate.removePlaintext(opId);gate.eraseAccountAssociation(accountId,current);return undefined;});
      const cleanup=gate.inventory().operations[0];expect(cleanup.kind).toBe('cleanup');if(cleanup.kind==='cleanup'){
        expect(cleanup).not.toHaveProperty('nativeUserId');expect(cleanup).not.toHaveProperty('userCreateAttempt');expect(cleanup).not.toHaveProperty('membershipCreateAttempt');expect(cleanup).not.toHaveProperty('keyCreateAttempt');
      }
    });
    store.close();await open(directory).withGate(async gate=>{expect(gate.inventory().operations).toMatchObject([{kind:'cleanup',phase:'revoke-pending',nativeDeletion:'unverified'}]);expect(()=>gate.readOperation(opId)).toThrow('refused');});
  });

  it.each(['team','user','membership','key'] as const)('does not return a %s write intent when its durable publication fails',async stage=>{
    let fail=false,returned=false;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(fail)throw new Error('synthetic fsync failure');}});
    await expect(store.withGate(async gate=>{
      const policy=reviewed(),team=gate.reserveTeam(randomUUID(),target,policy),user=gate.reserveUser(randomUUID(),team.ownershipId,policy);
      if(stage!=='team'){gate.claimTeamCreate(team.ownershipId);gate.verifyTeamCreated(team.ownershipId);}
      if(stage==='user'||stage==='membership'||stage==='key'){if(stage!=='user'){gate.claimUserCreate(user.ownershipId);gate.verifyUserCreated(user.ownershipId);}}
      if(stage==='key')gate.claimMembershipCreate(user.ownershipId);
      if(stage==='key'){
        gate.verifyMembershipCreated(user.ownershipId);
        const operation=gate.prepareOperation({bindingId:randomUUID(),credentialGeneration:'0',userOwnershipId:user.ownershipId,association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:policy},secret());gate.beginProvisioning(operation.operationId);
      }
      fail=true;
      if(stage==='team')gate.claimTeamCreate(team.ownershipId);
      else if(stage==='user')gate.claimUserCreate(user.ownershipId);
      else if(stage==='membership')gate.claimMembershipCreate(user.ownershipId);
      else {const operation=gate.inventory().operations[0];if(operation?.kind!=='operation')throw new Error('Expected key attempt fixture');gate.claimKeyCreate(operation.operationId);}
      returned=true;
    })).rejects.toThrow('reconciliation');
    expect(returned).toBe(false);fail=false;store.close();const before=bytes(directory);expect(()=>open(directory)).toThrow('reconciliation');expect(bytes(directory)).toEqual(before);
  });

  it('accepts only exact repeated preparation and never regenerates or changes a policy',async()=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),before=bytes(directory);
      expect(gate.prepareOperation(p.input,secret())).toEqual(p.operation);expect(bytes(directory)).toEqual(before);
      expect(()=>gate.prepareOperation(p.input,`sk-${'y'.repeat(43)}`)).toThrow('refused');
      expect(()=>gate.prepareOperation({...p.input,association:{...p.input.association,incarnation:randomUUID()}},secret())).toThrow('refused');
      const changed=reviewed();changed.key.maxBudget='9';expect(()=>gate.prepareOperation({...p.input,reviewedPolicy:changed},secret())).toThrow('refused');
      changed.team.maxBudget='99';expect(()=>gate.reserveTeam(p.installationId,target,changed)).toThrow('refused');
      expect(gate.readKey(p.operation.operationId)).toBe(secret());expect(bytes(directory)).toEqual(before);
    });
  });

  it.each(['live','cleanup'])('refuses a fingerprint already owned by another %s record before any publication',async kind=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const original=prepare(gate);let survivor=original;
      if(kind==='cleanup'){
        await publishReceipt(gate,original,'erase-person',current=>{gate.recordRevocation(original.operation.operationId,current);gate.removePlaintext(original.operation.operationId);gate.eraseAccountAssociation(original.accountId,current);return undefined;});
        survivor=prepare(gate,{key:`sk-${'y'.repeat(43)}`});
      }
      const before=bytes(directory);
      expect(()=>gate.prepareOperation({...survivor.input,bindingId:randomUUID(),credentialGeneration:'1'},secret())).toThrow('refused');
      expect(bytes(directory)).toEqual(before);expect(gate.readOperation(survivor.operation.operationId)).toEqual(survivor.operation);
      expect(gate.readKey(survivor.operation.operationId)).toBe(kind==='cleanup'?`sk-${'y'.repeat(43)}`:secret());
    });store.close();expect(()=>open(directory)).not.toThrow();
  });

  it('accepts the signed bigint maximum and refuses larger or noncanonical generations without writes',async()=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),before=bytes(directory);
      for(const value of ['9223372036854775808','9999999999999999999','-1','00','1.0','not-a-counter']){
        expect(()=>gate.prepareOperation({...p.input,bindingId:randomUUID(),credentialGeneration:value},`sk-${'y'.repeat(43)}`)).toThrow('refused');expect(bytes(directory)).toEqual(before);
      }
      const last=gate.prepareOperation({...p.input,bindingId:randomUUID(),credentialGeneration:'9223372036854775807'},`sk-${'y'.repeat(43)}`);
      expect(last.credentialGeneration).toBe('9223372036854775807');
    });store.close();expect(()=>open(directory)).not.toThrow();
  });

  it('refuses an oversized generation in a canonical stored snapshot',async()=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{prepare(gate);});store.close();
    const snapshot=JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8'));snapshot.operations[0].credentialGeneration='9223372036854775808';
    const raw=gatewayCanonical(snapshot);writeFileSync(join(directory,'snapshot.json'),raw);
    const control=JSON.parse(readFileSync(join(directory,'control.json'),'utf8'));control.snapshotDigest=gatewayHash(raw);writeFileSync(join(directory,'control.json'),gatewayCanonical(control));
    const before=bytes(directory);expect(()=>open(directory)).toThrow('reconciliation');expect(bytes(directory)).toEqual(before);
  });

  it('validates complete reconstructable reviewed policy and exact liability without defaults',async()=>{
    const {store}=fixture();await store.withGate(async gate=>{
      for(const mutate of [(p:any)=>delete p.pricing,(p:any)=>p.pricing.capabilityHash='d'.repeat(64),(p:any)=>p.maximumLiability='0.002',(p:any)=>p.user.userRole='proxy_admin',(p:any)=>p.user.autoCreateKey=true,(p:any)=>p.key.blocked=false,(p:any)=>p.team.maxBudget='1.0',(p:any)=>p.memberId='private-member',(p:any)=>p.key.secret=secret()]){
        const p:any=reviewed();mutate(p);expect(()=>gate.reserveTeam(randomUUID(),target,p)).toThrow('refused');
      }
      const p=prepare(gate);expect(gate.readOperation(p.operation.operationId).reviewedPolicy).toEqual(reviewed());expect(budgetNativeReviewedPolicySchema.parse(reviewed())).toEqual(reviewed());
    });
  });

  it('enforces monotonic phases, immutable financial linkage and exact acknowledged binding',async()=>{
    const {store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),id=p.operation.operationId,unrelated=await receipt();
      expect(()=>gate.recordNativeBlockedVerification(id)).toThrow('refused');expect(()=>gate.linkFinancialOperation(id,randomUUID(),randomUUID())).toThrow('refused');
      gate.beginProvisioning(id);gate.beginProvisioning(id);gate.claimKeyCreate(id);gate.verifyKeyCreated(id);gate.recordNativeBlockedVerification(id);
      await publishReceipt(gate,p,'provision',current=>{
        gate.linkFinancialOperation(id,current.operationId,current.journalId);gate.linkFinancialOperation(id,current.operationId,current.journalId);
        expect(()=>gate.linkFinancialOperation(id,current.operationId,randomUUID())).toThrow('refused');expect(()=>gate.linkFinancialOperation(id,randomUUID(),current.journalId)).toThrow('refused');expect(()=>gate.recordBoundClosed(id,unrelated)).toThrow('refused');
        gate.recordBoundClosed(id,current);gate.recordBoundClosed(id,current);return undefined;
      });expect(gate.readOperation(id).phase).toBe('bound-closed');
      expect(()=>gate.beginProvisioning(id)).toThrow('refused');expect(()=>gate.prepareOperation(p.input,secret())).toThrow('refused');
    });
  });

  it('retains cleanup custody, removes plaintext only after journal revocation, and never claims native deletion',async()=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),id=p.operation.operationId,unrelated=await receipt();
      expect(()=>gate.removePlaintext(id)).toThrow('refused');expect(()=>gate.eraseAccountAssociation(p.accountId,unrelated)).toThrow('refused');
      await publishReceipt(gate,p,'member-remove',current=>{gate.recordRevocation(id,current);gate.recordRevocation(id,current);return undefined;});expect(()=>gate.recordRevocation(id,unrelated)).toThrow('refused');
      gate.removePlaintext(id);gate.removePlaintext(id);expect(readdirSync(directory)).not.toContain(`${id}.key`);
      const op=gate.readOperation(id);expect(op.phase).toBe('revoke-pending');expect(op.plaintext).toBe('removed');expect(op.nativeDeletion).toBe('unverified');
      expect(()=>gate.readKey(id)).toThrow('refused');expect(gate.inventory().users).toEqual([p.user]);
    });store.close();await open(directory).withGate(async gate=>expect(gate.inventory().operations[0].nativeDeletion).toBe('unverified'));
  });

  it('erases account/private associations into domain-separated tombstones while preserving minimal cleanup receipts',async()=>{
    const {directory,store}=fixture();let p!:ReturnType<typeof prepare>;
    await store.withGate(async gate=>{
      p=prepare(gate);const unrelated=await receipt();await publishReceipt(gate,p,'erase-person',erasure=>{gate.recordRevocation(p.operation.operationId,erasure);gate.removePlaintext(p.operation.operationId);gate.eraseAccountAssociation(p.accountId,erasure);gate.eraseAccountAssociation(p.accountId,erasure);return undefined;});
      const s=gate.inventory(),u=s.users[0],cleanup=s.operations[0];expect(u.kind).toBe('erased-user');expect(cleanup.kind).toBe('cleanup');
      expect(cleanup).toMatchObject({phase:'revoke-pending',plaintext:'removed',nativeDeletion:'unverified',keyFingerprint:p.operation.keyFingerprint,policyDigest:p.operation.policyDigest,endpoint:target});
      const disk=readFileSync(join(directory,'snapshot.json'),'utf8');
      for(const value of [p.accountId,p.user.nativeUserId,p.user.ownershipId,p.input.bindingId,p.input.association.agent,p.input.association.incarnation,secret()])expect(disk).not.toContain(value);
      if(u.kind==='erased-user'&&cleanup.kind==='cleanup')expect(new Set([u.accountCommitment,u.coordinateCommitment,cleanup.coordinateCommitment,cleanup.operationCommitment]).size).toBe(4);
      expect(()=>gate.reserveUser(p.accountId,p.team.ownershipId,reviewed())).toThrow('refused');expect(()=>gate.eraseAccountAssociation(p.accountId,unrelated)).toThrow('refused');
      const other=gate.reserveTeam(p.installationId,{...target,hash:'d'.repeat(64)},reviewed());
      expect(()=>gate.reserveUser(p.accountId,other.ownershipId,reviewed())).toThrow('refused');
    });store.close();await open(directory).withGate(async gate=>{expect(()=>gate.reserveUser(p.accountId,p.team.ownershipId,reviewed())).toThrow('refused');expect(gate.inventory().teams).toContainEqual(p.team);});
  });

  it('requires every pending operation to be revoked and plaintext-free before erasure',async()=>{
    const {store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),other=gate.prepareOperation({...p.input,bindingId:randomUUID()},`sk-${'y'.repeat(43)}`);
      await publishReceipt(gate,p,'erase-person',erasure=>{gate.recordRevocation(p.operation.operationId,erasure);gate.removePlaintext(p.operation.operationId);return undefined;});
      const incomplete=await receipt(p,'erase-person');expect(()=>gate.eraseAccountAssociation(p.accountId,incomplete)).toThrow('refused');
      await publishReceipt(gate,{...p,operation:{...p.operation,operationId:other.operationId}},'erase-person',erasure=>{gate.recordRevocation(other.operationId,erasure);gate.removePlaintext(other.operationId);gate.eraseAccountAssociation(p.accountId,erasure);return undefined;});
      expect(gate.inventory().operations.every(o=>o.kind==='cleanup')).toBe(true);
    });
  });

  it('refuses concurrent gates and closes only after the active gate drains',async()=>{
    const {store}=fixture();let resume!:()=>void,oldGate!:NativeCustodyGate;const paused=new Promise<void>(resolve=>resume=resolve);
    const running=store.withGate(async gate=>{oldGate=gate;await paused;gate.inventory();});
    await expect(store.withGate(async()=>undefined)).rejects.toThrow('reconciliation');expect(()=>store.close()).toThrow('still owns');
    let drained=false;const draining=store.drainForShutdown().then(()=>{drained=true;});await Promise.resolve();expect(drained).toBe(false);
    resume();await running;await draining;expect(drained).toBe(true);expect(()=>oldGate.inventory()).toThrow('reconciliation');
    await expect(store.withGate(async()=>undefined)).rejects.toThrow('reconciliation');store.close();
  });

  it('holds the lifecycle lock until close',()=>{const {directory,store}=fixture();expect(()=>open(directory)).toThrow('reconciliation');store.close();expect(()=>open(directory)).not.toThrow();});

  it.each(['before-rename','after-rename','repeat-file','repeat-directory','repeat-after-rename'])('does not reopen a failed %s close as clean',mode=>{
    let enabled=false,count=0;
    const {directory,store}=fixture({sync:fd=>{
      fsyncSync(fd);if(!enabled)return;count++;
      if(mode==='before-rename'&&count===1||mode==='after-rename'&&count===2||mode==='repeat-file'&&!fstatSync(fd).isDirectory()||mode==='repeat-directory'&&fstatSync(fd).isDirectory()||mode==='repeat-after-rename'&&count>=2)throw new Error('synthetic close sync failure');
    }});
    enabled=true;expect(()=>store.close()).toThrow('reconciliation');enabled=false;
    expect(()=>open(directory)).toThrow('reconciliation');
  });

  it('keeps a close directory-sync failure uncertain and byte-preserving on reopen',()=>{
    let enabled=false,count=0;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===2)throw new Error('synthetic close directory sync failure');}});
    enabled=true;expect(()=>store.close()).toThrow('reconciliation');enabled=false;
    expect(readdirSync(directory)).not.toContain('publication-intent.json');expect(JSON.parse(readFileSync(join(directory,'control.json'),'utf8')).state).toBe('uncertain');
    const before=bytes(directory);expect(()=>open(directory)).toThrow('reconciliation');expect(bytes(directory)).toEqual(before);
  });

  it('freezes unknown work and retains records for later explicit reconciliation',async()=>{
    const {directory,store}=fixture();await expect(store.withGate(async gate=>{const p=prepare(gate);gate.recordUncertain(p.operation.operationId);})).rejects.toThrow('reconciliation');
    const before=bytes(directory);store.close();expect(bytes(directory)).toEqual(before);expect(JSON.parse(before['control.json'].toString()).state).toBe('uncertain');
    expect(()=>open(directory)).toThrow('reconciliation');expect(bytes(directory)).toEqual(before);
  });

  it.each(['snapshot.json','control.json','writer.lock'])('refuses external descriptor/path replacement of %s',async name=>{
    const {directory,store}=fixture();const path=join(directory,name),replacement=join(directory,'replacement');copyFileSync(path,replacement);chmodSync(replacement,0o600);renameSync(replacement,path);
    await expect(store.withGate(async gate=>gate.inventory())).rejects.toThrow('reconciliation');
  });

  it('refuses replacement of the root even when all replacement bytes and permissions match',async()=>{
    const {directory,store}=fixture(),old=directory+'-old';renameSync(directory,old);mkdirSync(directory,{mode:0o700});
    for(const name of readdirSync(old)){copyFileSync(join(old,name),join(directory,name));chmodSync(join(directory,name),0o600);}
    await expect(store.withGate(async gate=>gate.inventory())).rejects.toThrow('reconciliation');
  });

  it.each(['missing-key','changed-key','symlink','hardlink','mode','unexpected','partial'])('never repairs or adopts %s custody',async fault=>{
    const {directory,store}=fixture();let id='';await store.withGate(async gate=>{id=prepare(gate).operation.operationId;});store.close();const path=join(directory,`${id}.key`);
    if(fault==='missing-key')unlinkSync(path);
    if(fault==='changed-key')writeFileSync(path,`sk-${'z'.repeat(43)}`);
    if(fault==='symlink'){unlinkSync(path);const outside=join(dirnameForTest(directory),'outside');writeFileSync(outside,secret(),{mode:0o600});symlinkSync(outside,path);}
    if(fault==='hardlink')linkSync(path,join(dirnameForTest(directory),'extra-link'));
    if(fault==='mode')chmodSync(path,0o644);
    if(fault==='unexpected')writeFileSync(join(directory,'unknown.json'),'{}',{mode:0o600});
    if(fault==='partial')writeFileSync(join(directory,'.snapshot.json.partial'),'partial',{mode:0o600});
    expect(()=>open(directory)).toThrow('reconciliation');if(fault==='missing-key')expect(()=>statSync(path)).toThrow();else if(fault==='changed-key')expect(readFileSync(path,'utf8')).toBe(`sk-${'z'.repeat(43)}`);
  });

  it('bounds inventories and file reads before allocating or adopting them',()=>{
    const {directory,store}=fixture();store.close();writeFileSync(join(directory,'snapshot.json'),Buffer.alloc(NATIVE_CUSTODY_MAX_BYTES+1));expect(()=>open(directory)).toThrow('reconciliation');
  });

  it('refuses a full record inventory before publishing any additional ownership',async()=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      for(let i=0;i<NATIVE_CUSTODY_MAX_RECORDS;i++)gate.reserveTeam(randomUUID(),target,reviewed());
      const before=bytes(directory);expect(()=>gate.reserveTeam(randomUUID(),target,reviewed())).toThrow('refused');expect(bytes(directory)).toEqual(before);
    });
  },15000);

  it.each([1,2,3,4,5])('retains incomplete fresh creation after fsync failure %i',failAt=>{
    const parent=mkdtempSync(join(realpathSync(tmpdir()),'lares-native-partial-'));roots.push(parent);const directory=join(parent,'custody');let count=0;
    expect(()=>BudgetNativeCustodyStore.createNew(directory,{...options,sync:fd=>{fsyncSync(fd);if(++count===failAt)throw new Error('synthetic disk failure');}})).toThrow('reconciliation');
    expect(()=>open(directory)).toThrow('reconciliation');expect(()=>BudgetNativeCustodyStore.createNew(directory,options)).toThrow('reconciliation');
  });

  it.each([1,2,3,4])('freezes after a full visible publication fsync failure %i',failAt=>{
    let count=0,enabled=false;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===failAt)throw new Error('synthetic failure');}});
    enabled=true;return expect(store.withGate(async gate=>{gate.reserveTeam(randomUUID(),target,reviewed());})).rejects.toThrow('reconciliation').then(()=>{enabled=false;store.close();expect(()=>open(directory)).toThrow('reconciliation');});
  });

  it.each([1,2,3,4,5,6,7,8,9])('never promotes incomplete tuple/secret publication after fsync failure %i',async failAt=>{
    let count=0,enabled=false;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===failAt)throw new Error('synthetic failure');}});
    await expect(store.withGate(async gate=>{
      const p=reviewed(),team=gate.reserveTeam(randomUUID(),target,p),user=gate.reserveUser(randomUUID(),team.ownershipId,p);
      gate.claimTeamCreate(team.ownershipId);gate.verifyTeamCreated(team.ownershipId);gate.claimUserCreate(user.ownershipId);gate.verifyUserCreated(user.ownershipId);gate.claimMembershipCreate(user.ownershipId);gate.verifyMembershipCreated(user.ownershipId);
      enabled=true;gate.prepareOperation({bindingId:randomUUID(),credentialGeneration:'0',userOwnershipId:user.ownershipId,association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:p},secret());
    })).rejects.toThrow('reconciliation');enabled=false;
    const before=bytes(directory);store.close();expect(()=>open(directory)).toThrow('reconciliation');expect(bytes(directory)).toEqual(before);
  });

  it.each([1,5,6,7,8,9,10,12,15])('does not claim plaintext erasure after cleanup fsync failure %i',async failAt=>{
    let count=0,enabled=false;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===failAt)throw new Error('synthetic failure');}});let id='';
    await expect(store.withGate(async gate=>{const p=prepare(gate);id=p.operation.operationId;await publishReceipt(gate,p,'member-remove',current=>gate.recordRevocation(id,current));enabled=true;gate.removePlaintext(id);})).rejects.toThrow('reconciliation');enabled=false;
    const s=JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8')),row=s.operations[0];
    if(row.plaintext==='removed')expect(()=>statSync(join(directory,`${id}.key`))).toThrow();
    expect(row.nativeDeletion).toBe('unverified');expect(row.phase).toBe('revoke-pending');
    store.close();expect(()=>open(directory)).toThrow('reconciliation');
  });
});

function dirnameForTest(path:string):string{return join(path,'..');}
