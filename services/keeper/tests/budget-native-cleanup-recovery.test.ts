import {chmodSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {consoleSourceTransaction,noteBudgetFinancialChange,type SourcePool} from '@lares/agent-kit/console-source-transaction';
import {gatewayCanonical} from '@lares/agent-kit/gateway-admission-protocol';
import {JournalBudgetFinancialWriter} from '../lib/budget-financial-writer.js';
import {HostFinancialJournal} from '../lib/financial-journal.js';
import {prepareFinancialCustody} from '../lib/financial-continuity.js';
import {provisionBudgetAccounts} from '../lib/budget-account-provisioning.js';
import {BudgetNativeCustodyStore,type BudgetNativeReviewedPolicy,type NativeOperation} from '../lib/budget-native-custody.js';
import {recoverNativePlaintextCleanup} from '../lib/budget-native-cleanup-recovery.js';
import {quiet} from './helpers/quiet-pool.js';
import {platformTestJournalLock,testJournalUid} from './helpers/financial-journal.js';
import {nativeTestPolicy,nativeTestTarget} from './helpers/native-cleanup.js';

let container:StartedPostgreSqlContainer,pool:Pool,journal:HostFinancialJournal,directory:string,native:BudgetNativeCustodyStore;
const roots:string[]=[];
const nativeOptions={ownershipUid:testJournalUid,ownershipGid:process.getgid!(),lock:platformTestJournalLock};
beforeAll(async()=>{
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();pool=quiet(new Pool({connectionString:container.getConnectionUri(),max:2,connectionTimeoutMillis:3000}));
  const sqlDir=new URL('../../box/sql/',import.meta.url);
  for(const name of readdirSync(sqlDir).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort())await pool.query(readFileSync(new URL(name,sqlDir),'utf8'));
  await pool.query("INSERT INTO orgs(id,display_name) VALUES('recovery-org','Recovery')");
  await pool.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('recovery-member','Recovery member','recovery-org','member','active')");
  await pool.query("INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES('recovery-member','https://identity.example.invalid','recovery','tenant')");
  await pool.query("INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES('recovery-member',30)");
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-native-cleanup-recovery-'));chmodSync(root,0o700);roots.push(root);directory=join(root,'financial');
  const client=await pool.connect();try{await prepareFinancialCustody(directory,client,{ownershipUid:testJournalUid,lock:platformTestJournalLock});}finally{client.release();}
  journal=HostFinancialJournal.openExisting(directory,{ownershipUid:testJournalUid,lock:platformTestJournalLock,requirePrepared:true});
});
afterAll(async()=>{try{native?.close();}catch{}try{journal?.close();}catch{}if(pool)await pool.end();if(container)await container.stop();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

it('observes the current PostgreSQL retirement before removing only exact local plaintext',async()=>{
  await provisionBudgetAccounts(pool as unknown as SourcePool,journal,{installationCap:'100',memberIds:['recovery-member']});
  const accounts=(await pool.query("SELECT id,installation_account_id FROM budget_accounts WHERE live_member_id='recovery-member'")).rows[0];
  expect(accounts).toBeDefined();const policy:BudgetNativeReviewedPolicy=nativeTestPolicy(),secret=`sk-${'x'.repeat(43)}`,fingerprint=createHash('sha256').update(secret).digest('hex');
  const root=roots[0]!,nativeDirectory=join(root,'native');native=BudgetNativeCustodyStore.createNew(nativeDirectory,nativeOptions);
  let operation!:NativeOperation,memberAccountId=String(accounts.id),installationAccountId=String(accounts.installation_account_id),teamOwnershipId='',userOwnershipId='';
  await native.withGate(async gate=>{
    let team=gate.reserveTeam(installationAccountId,nativeTestTarget,policy),user=gate.reserveUser(memberAccountId,team.ownershipId,policy);
    if(team.createAttempt==='not-attempted'){gate.claimTeamCreate(team.ownershipId);gate.verifyTeamCreated(team.ownershipId);}
    team=gate.reserveTeam(installationAccountId,nativeTestTarget,policy);user=gate.reserveUser(memberAccountId,team.ownershipId,policy);
    if(user.userCreateAttempt==='not-attempted'){gate.claimUserCreate(user.ownershipId);gate.verifyUserCreated(user.ownershipId);}
    user=gate.reserveUser(memberAccountId,team.ownershipId,policy);if(user.membershipCreateAttempt==='not-attempted'){gate.claimMembershipCreate(user.ownershipId);gate.verifyMembershipCreated(user.ownershipId);}
    user=gate.reserveUser(memberAccountId,team.ownershipId,policy);teamOwnershipId=team.ownershipId;userOwnershipId=user.ownershipId;
    operation=gate.prepareOperation({bindingId:randomUUID(),credentialGeneration:'0',userOwnershipId:user.ownershipId,
      association:{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:policy},secret);
    gate.beginProvisioning(operation.operationId);gate.claimKeyCreate(operation.operationId);gate.verifyKeyCreated(operation.operationId);gate.recordNativeBlockedVerification(operation.operationId);
    const writer=new JournalBudgetFinancialWriter(journal);
    await writer.runWithReceipt('provision',boundary=>consoleSourceTransaction(pool as unknown as SourcePool,async db=>{
      await db.query(`INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,key_fingerprint,agent,incarnation,native_team,native_user,purpose_alias,profile_hash,maximum_liability,state,pricing_profile)
        VALUES($1,$2,$3,'recovery-member',$4,0,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13)`,[operation.bindingId,installationAccountId,memberAccountId,nativeTestTarget.hash,fingerprint,
        operation.association.agent,operation.association.incarnation,teamOwnershipId,userOwnershipId,operation.association.purposeAlias,policy.pricing.capabilityHash,policy.maximumLiability,policy.pricing]);
      noteBudgetFinancialChange(db,'budget_gateway_bindings',operation.bindingId);
    },boundary),receipt=>{gate.linkFinancialOperation(operation.operationId,receipt.operationId,receipt.journalId);gate.recordBoundClosed(operation.operationId,receipt);return undefined;});
  });

  const writer=new JournalBudgetFinancialWriter(journal);
  await writer.run('member-remove',boundary=>consoleSourceTransaction(pool as unknown as SourcePool,async db=>{
    await db.query("UPDATE users SET status='removed' WHERE id='recovery-member'");
    noteBudgetFinancialChange(db,'budget_accounts',installationAccountId);noteBudgetFinancialChange(db,'budget_accounts',memberAccountId);noteBudgetFinancialChange(db,'budget_gateway_bindings',operation.bindingId);
  },boundary));
  native.close();
  const controlPath=join(nativeDirectory,'control.json'),control=JSON.parse(readFileSync(controlPath,'utf8'));control.state='open';writeFileSync(controlPath,gatewayCanonical(control),{mode:0o600});chmodSync(controlPath,0o600);

  const openRecovery=BudgetNativeCustodyStore.openCleanupRecovery;
  vi.spyOn(BudgetNativeCustodyStore,'openCleanupRecovery').mockImplementation((path,options={})=>openRecovery(path,{...options,...nativeOptions}));
  try{await expect(recoverNativePlaintextCleanup(pool as unknown as SourcePool,journal,nativeDirectory)).resolves.toEqual({processedOperations:1});}
  finally{vi.restoreAllMocks();}
  expect(readdirSync(nativeDirectory)).not.toContain(`${operation.operationId}.key`);
  const snapshot=JSON.parse(readFileSync(join(nativeDirectory,'snapshot.json'),'utf8'));
  expect(snapshot.operations[0]).toMatchObject({phase:'revoke-pending',plaintext:'removed',revocationReceipt:{operation:'native-cleanup-recovery'}});
  expect(JSON.parse(readFileSync(controlPath,'utf8')).state).toBe('open');
  const records=readFileSync(join(directory,'journal.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line).record),lastBegin=records.filter(record=>record.kind==='begin').at(-1);
  expect(lastBegin).toMatchObject({operation:'native-cleanup-recovery'});
});
