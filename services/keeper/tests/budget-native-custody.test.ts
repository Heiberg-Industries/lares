import {afterEach,describe,expect,it} from 'vitest';
import {chmodSync,copyFileSync,fstatSync,fsyncSync,linkSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,statSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gatewayCanonical,gatewayHash} from '@lares/agent-kit/gateway-admission-protocol';
import {BudgetNativeCustodyStore,NATIVE_CUSTODY_MAX_BYTES,NATIVE_CUSTODY_MAX_RECORDS,budgetNativeReviewedPolicySchema,type BudgetNativeReviewedPolicy,type NativeCustodyGate} from '../lib/budget-native-custody.js';
import {HostFinancialJournal,type CommittedFinancialReceipt,type FinancialAtom} from '../lib/financial-journal.js';
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
function bindingAtom(p:ReturnType<typeof prepare>,state:'active'|'revoked'):FinancialAtom {
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
function prepare(gate:NativeCustodyGate,values:{installationId?:string;accountId?:string;bindingId?:string;key?:string;policy?:BudgetNativeReviewedPolicy}={}){
  const policy=values.policy??reviewed(),installationId=values.installationId??randomUUID(),accountId=values.accountId??randomUUID();
  const team=gate.reserveTeam(installationId,target,policy),user=gate.reserveUser(accountId,team.ownershipId,policy);
  const input={bindingId:values.bindingId??randomUUID(),credentialGeneration:'0',userOwnershipId:user.ownershipId,association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:policy};
  const operation=gate.prepareOperation(input,values.key??secret());return {team,user,input,operation,accountId,installationId};
}
const bytes=(directory:string)=>Object.fromEntries(readdirSync(directory).map(name=>[name,readFileSync(join(directory,name))]));
async function absence(fingerprint:string,challenge:string,origin=target.origin):Promise<NativeHashAbsenceReceipt> {
  const client=new BudgetNativeCredentialClient(origin,'sk-master-fixture-0123456789',async()=>new Response(JSON.stringify({key:[fingerprint],info:[]} ),{headers:{'content-type':'application/json'}}));
  const result=await client.lookupKeyHashOnly(fingerprint,challenge);if(result.kind!=='absent')throw new Error('Absence fixture failed');return result.receipt;
}

describe('protected native custody foundation',()=>{
  it('refuses forged, copied, unrelated and wrong-kind financial receipts without publishing',async()=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),r=await receipt(p),unrelated=await receipt({...p,accountId:randomUUID()}),wrongKind=await receipt(p,'provision'),before=bytes(directory);
      for(const invalid of [{...r},JSON.parse(JSON.stringify(r)),unrelated,wrongKind] as CommittedFinancialReceipt[]){expect(()=>gate.recordRevocation(p.operation.operationId,invalid)).toThrow('refused');expect(bytes(directory)).toEqual(before);}
      expect(gate.accountOperations(p.accountId)).toEqual([p.operation]);expect(gate.accountOperations(randomUUID())).toEqual([]);gate.recordRevocation(p.operation.operationId,r);
    });
  });
  it('requires exact binding policy and closed account atoms for binding completion',async()=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),id=p.operation.operationId;
      gate.beginProvisioning(id);gate.recordNativeBlockedVerification(id);
      const badBinding={...bindingAtom(p,'active'),maximumLiability:'0.004'} as FinancialAtom,bad=await receipt(p,'provision',[accountAtom(p,'provision'),accountAtom(p,'provision',true),badBinding]);
      gate.linkFinancialOperation(id,bad.operationId,bad.journalId);const before=bytes(directory);expect(()=>gate.recordBoundClosed(id,bad)).toThrow('refused');expect(bytes(directory)).toEqual(before);
    });
  });
  it('requires exact erased tombstone and account before removing account linkage',async()=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate);gate.recordRevocation(p.operation.operationId,await receipt(p));gate.removePlaintext(p.operation.operationId);
      const noTombstone=await receipt(p,'erase-person',[accountAtom(p,'erase-person')]),before=bytes(directory);
      expect(()=>gate.eraseAccountAssociation(p.accountId,noTombstone)).toThrow('refused');expect(bytes(directory)).toEqual(before);
      gate.eraseAccountAssociation(p.accountId,await receipt(p,'erase-person'));
    });
  });
  it('requires the revoked binding for a bound operation, with erased-account closure for omitted historical bindings',async()=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),id=p.operation.operationId,bound=await receipt(p,'provision');gate.beginProvisioning(id);gate.recordNativeBlockedVerification(id);gate.linkFinancialOperation(id,bound.operationId,bound.journalId);gate.recordBoundClosed(id,bound);
      const accountOnly=await receipt(p),mismatched=await receipt(p,'member-remove',[{...bindingAtom(p,'revoked'),endpointHash:'f'.repeat(64)} as FinancialAtom,accountAtom(p,'member-remove')]),before=bytes(directory);
      for(const invalid of [accountOnly,mismatched]){expect(()=>gate.recordRevocation(id,invalid)).toThrow('refused');expect(bytes(directory)).toEqual(before);}
      // Erasure projects all member account retirement/tombstone facts even when an
      // already-revoked historical binding was excluded from its mutation projection.
      const erased=await receipt(p,'erase-person');gate.recordRevocation(id,erased);gate.removePlaintext(id);gate.eraseAccountAssociation(p.accountId,erased);
    });
  });
  it.each([false,true])('records only a genuine exact native absence after durable revocation and plaintext removal (erased %s)',async erased=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),id=p.operation.operationId,early=await absence(p.operation.keyFingerprint,'1'.repeat(64));
      expect(()=>gate.prepareNativeAbsence(id)).toThrow('refused');expect(()=>gate.recordNativeAbsence(id,early)).toThrow('refused');gate.recordRevocation(id,await receipt(p));
      expect(()=>gate.prepareNativeAbsence(id)).toThrow('refused');expect(()=>gate.recordNativeAbsence(id,early)).toThrow('refused');gate.removePlaintext(id);
      if(erased)gate.eraseAccountAssociation(p.accountId,await receipt(p,'erase-person'));
      const request=erased?gate.prepareErasedNativeAbsence(p.operation.keyFingerprint):gate.prepareNativeAbsence(id),proof=await absence(request.fingerprint,request.challenge),wrong=await absence(request.fingerprint,request.challenge,'http://other.invalid:4000'),wrongChallenge=await absence(request.fingerprint,'2'.repeat(64));
      const finish=(r:NativeHashAbsenceReceipt)=>erased?gate.recordErasedNativeAbsence(p.operation.keyFingerprint,r):gate.recordNativeAbsence(id,r),before=bytes(directory);
      for(const invalid of [{} as NativeHashAbsenceReceipt,early,wrong,wrongChallenge]){expect(()=>finish(invalid)).toThrow('refused');expect(bytes(directory)).toEqual(before);}
      finish(proof);expect(gate.inventory().operations[0]).toMatchObject({phase:'revoked',plaintext:'removed',nativeDeletion:'verified'});expect(()=>finish(proof)).toThrow('refused');
      if(!erased){gate.eraseAccountAssociation(p.accountId,await receipt(p,'erase-person'));expect(gate.inventory().operations[0]).toMatchObject({kind:'cleanup',phase:'revoked',nativeDeletion:'verified'});}
    });store.close();await open(directory).withGate(async gate=>expect(gate.inventory().operations[0].nativeDeletion).toBe('verified'));
  });
  it('discards absence challenges when the gate ends and when a fresh request replaces one',async()=>{
    const {directory,store}=fixture();let id!:string,old!:NativeHashAbsenceReceipt;
    await store.withGate(async gate=>{const p=prepare(gate);id=p.operation.operationId;gate.recordRevocation(id,await receipt(p));gate.removePlaintext(id);const request=gate.prepareNativeAbsence(id);old=await absence(request.fingerprint,request.challenge);});
    await store.withGate(async gate=>{
      const before=bytes(directory);expect(()=>gate.recordNativeAbsence(id,old)).toThrow('refused');const replaced=gate.prepareNativeAbsence(id),replacedProof=await absence(replaced.fingerprint,replaced.challenge),fresh=gate.prepareNativeAbsence(id);
      for(const invalid of [old,replacedProof])expect(()=>gate.recordNativeAbsence(id,invalid)).toThrow('refused');expect(bytes(directory)).toEqual(before);
      gate.recordNativeAbsence(id,await absence(fresh.fingerprint,fresh.challenge));
    });
  });
  it('retains evidence and refuses reopen after a native-absence publication fsync failure',async()=>{
    let fail=false;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(fail)throw new Error('synthetic fsync failure');}});
    await expect(store.withGate(async gate=>{const p=prepare(gate),id=p.operation.operationId;gate.recordRevocation(id,await receipt(p));gate.removePlaintext(id);const request=gate.prepareNativeAbsence(id),proof=await absence(request.fingerprint,request.challenge);fail=true;gate.recordNativeAbsence(id,proof);})).rejects.toThrow('reconciliation');fail=false;
    expect(()=>store.close()).not.toThrow();const before=bytes(directory);expect(()=>open(directory)).toThrow('reconciliation');expect(bytes(directory)).toEqual(before);
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
        gate.recordRevocation(original.operation.operationId,await receipt(original));gate.removePlaintext(original.operation.operationId);gate.eraseAccountAssociation(original.accountId,await receipt(original,'erase-person'));
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
      const p=prepare(gate),id=p.operation.operationId,r=await receipt(p,'provision'),unrelated=await receipt();
      expect(()=>gate.recordNativeBlockedVerification(id)).toThrow('refused');expect(()=>gate.linkFinancialOperation(id,r.operationId,r.journalId)).toThrow('refused');
      gate.beginProvisioning(id);gate.beginProvisioning(id);gate.recordNativeBlockedVerification(id);
      gate.linkFinancialOperation(id,r.operationId,r.journalId);gate.linkFinancialOperation(id,r.operationId,r.journalId);
      expect(()=>gate.linkFinancialOperation(id,r.operationId,randomUUID())).toThrow('refused');expect(()=>gate.linkFinancialOperation(id,randomUUID(),r.journalId)).toThrow('refused');expect(()=>gate.recordBoundClosed(id,unrelated)).toThrow('refused');
      gate.recordBoundClosed(id,r);gate.recordBoundClosed(id,r);expect(gate.readOperation(id).phase).toBe('bound-closed');
      expect(()=>gate.beginProvisioning(id)).toThrow('refused');expect(()=>gate.prepareOperation(p.input,secret())).toThrow('refused');
    });
  });

  it('retains cleanup custody, removes plaintext only after journal revocation, and never claims native deletion',async()=>{
    const {directory,store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),id=p.operation.operationId,unrelated=await receipt();
      expect(()=>gate.removePlaintext(id)).toThrow('refused');expect(()=>gate.eraseAccountAssociation(p.accountId,unrelated)).toThrow('refused');
      const r=await receipt(p);gate.recordRevocation(id,r);gate.recordRevocation(id,r);expect(()=>gate.recordRevocation(id,unrelated)).toThrow('refused');
      gate.removePlaintext(id);gate.removePlaintext(id);expect(readdirSync(directory)).not.toContain(`${id}.key`);
      const op=gate.readOperation(id);expect(op.phase).toBe('revoke-pending');expect(op.plaintext).toBe('removed');expect(op.nativeDeletion).toBe('unverified');
      expect(()=>gate.readKey(id)).toThrow('refused');expect(gate.inventory().users).toEqual([p.user]);
    });store.close();await open(directory).withGate(async gate=>expect(gate.inventory().operations[0].nativeDeletion).toBe('unverified'));
  });

  it('erases account/private associations into domain-separated tombstones while preserving minimal cleanup receipts',async()=>{
    const {directory,store}=fixture();let p!:ReturnType<typeof prepare>;
    await store.withGate(async gate=>{
      p=prepare(gate);const erasure=await receipt(p,'erase-person'),unrelated=await receipt();gate.recordRevocation(p.operation.operationId,await receipt(p));gate.removePlaintext(p.operation.operationId);gate.eraseAccountAssociation(p.accountId,erasure);
      const s=gate.inventory(),u=s.users[0],cleanup=s.operations[0];expect(u.kind).toBe('erased-user');expect(cleanup.kind).toBe('cleanup');
      expect(cleanup).toMatchObject({phase:'revoke-pending',plaintext:'removed',nativeDeletion:'unverified',keyFingerprint:p.operation.keyFingerprint,policyDigest:p.operation.policyDigest,endpoint:target});
      const disk=readFileSync(join(directory,'snapshot.json'),'utf8');
      for(const value of [p.accountId,p.user.nativeUserId,p.user.ownershipId,p.input.bindingId,p.input.association.agent,p.input.association.incarnation,secret()])expect(disk).not.toContain(value);
      if(u.kind==='erased-user'&&cleanup.kind==='cleanup')expect(new Set([u.accountCommitment,u.coordinateCommitment,cleanup.coordinateCommitment,cleanup.operationCommitment]).size).toBe(4);
      expect(()=>gate.reserveUser(p.accountId,p.team.ownershipId,reviewed())).toThrow('refused');gate.eraseAccountAssociation(p.accountId,erasure);
      expect(()=>gate.eraseAccountAssociation(p.accountId,unrelated)).toThrow('refused');
      const other=gate.reserveTeam(p.installationId,{...target,hash:'d'.repeat(64)},reviewed());
      expect(()=>gate.reserveUser(p.accountId,other.ownershipId,reviewed())).toThrow('refused');
    });store.close();await open(directory).withGate(async gate=>{expect(()=>gate.reserveUser(p.accountId,p.team.ownershipId,reviewed())).toThrow('refused');expect(gate.inventory().teams).toContainEqual(p.team);});
  });

  it('requires every pending operation to be revoked and plaintext-free before erasure',async()=>{
    const {store}=fixture();await store.withGate(async gate=>{
      const p=prepare(gate),other=gate.prepareOperation({...p.input,bindingId:randomUUID()},`sk-${'y'.repeat(43)}`);
      const erasure=await receipt(p,'erase-person'),revocation=await receipt(p);
      gate.recordRevocation(p.operation.operationId,revocation);gate.removePlaintext(p.operation.operationId);
      expect(()=>gate.eraseAccountAssociation(p.accountId,erasure)).toThrow('refused');gate.recordRevocation(other.operationId,revocation);
      expect(()=>gate.eraseAccountAssociation(p.accountId,erasure)).toThrow('refused');gate.removePlaintext(other.operationId);gate.eraseAccountAssociation(p.accountId,erasure);
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
  });

  it.each([1,2,3,4,5])('retains incomplete fresh creation after fsync failure %i',failAt=>{
    const parent=mkdtempSync(join(realpathSync(tmpdir()),'lares-native-partial-'));roots.push(parent);const directory=join(parent,'custody');let count=0;
    expect(()=>BudgetNativeCustodyStore.createNew(directory,{...options,sync:fd=>{fsyncSync(fd);if(++count===failAt)throw new Error('synthetic disk failure');}})).toThrow('reconciliation');
    expect(()=>open(directory)).toThrow('reconciliation');expect(()=>BudgetNativeCustodyStore.createNew(directory,options)).toThrow('reconciliation');
  });

  it.each([1,2,3,4])('freezes after a full visible publication fsync failure %i',failAt=>{
    let count=0,enabled=false;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===failAt)throw new Error('synthetic failure');}});
    enabled=true;return expect(store.withGate(async gate=>{gate.reserveTeam(randomUUID(),target,reviewed());})).rejects.toThrow('reconciliation').then(()=>{enabled=false;store.close();expect(()=>open(directory)).toThrow('reconciliation');});
  });

  it.each([1,2,3,4,5,6])('never promotes incomplete tuple/secret publication after fsync failure %i',async failAt=>{
    let count=0,enabled=false;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===failAt)throw new Error('synthetic failure');}});
    await expect(store.withGate(async gate=>{
      const p=reviewed(),team=gate.reserveTeam(randomUUID(),target,p),user=gate.reserveUser(randomUUID(),team.ownershipId,p);
      enabled=true;gate.prepareOperation({bindingId:randomUUID(),credentialGeneration:'0',userOwnershipId:user.ownershipId,association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:p},secret());
    })).rejects.toThrow('reconciliation');enabled=false;
    const before=bytes(directory);store.close();expect(()=>open(directory)).toThrow('reconciliation');expect(bytes(directory)).toEqual(before);
  });

  it.each([1,5,6,9])('does not claim plaintext erasure after cleanup fsync failure %i',async failAt=>{
    let count=0,enabled=false;const {directory,store}=fixture({sync:fd=>{fsyncSync(fd);if(enabled&&++count===failAt)throw new Error('synthetic failure');}});let id='';
    await expect(store.withGate(async gate=>{const p=prepare(gate);id=p.operation.operationId;gate.recordRevocation(id,await receipt(p));enabled=true;gate.removePlaintext(id);})).rejects.toThrow('reconciliation');enabled=false;
    const s=JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8')),row=s.operations[0];
    if(row.plaintext==='removed')expect(()=>statSync(join(directory,`${id}.key`))).toThrow();
    expect(row.nativeDeletion).toBe('unverified');expect(row.phase).toBe('revoke-pending');
    store.close();expect(()=>open(directory)).toThrow('reconciliation');
  });
});

function dirnameForTest(path:string):string{return join(path,'..');}
