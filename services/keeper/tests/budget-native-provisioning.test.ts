import {chmodSync,fsyncSync,mkdtempSync,readdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {quiet} from './helpers/quiet-pool.js';
import {HostFinancialJournal} from '../lib/financial-journal.js';
import {prepareFinancialCustody} from '../lib/financial-continuity.js';
import {provisionBudgetAccounts} from '../lib/budget-account-provisioning.js';
import {BudgetNativeProvisioner} from '../lib/budget-native-provisioning.js';
import {BudgetNativeCredentialClient} from '../lib/budget-native-client.js';
import {BudgetNativeCustodyStore} from '../lib/budget-native-custody.js';
import {gatewayCanonical} from '@lares/agent-kit/gateway-admission-protocol';
import {definitionSchema,hashOf,parseDefinition} from '@lares/agent-kit/definition';
import {platformTestJournalLock,testJournalUid} from './helpers/financial-journal.js';
import {createNativeTestCustody,nativeTestPolicy,nativeTestTarget} from './helpers/native-cleanup.js';

let container:StartedPostgreSqlContainer;
let pool:Pool;
const journals:HostFinancialJournal[]=[],roots:string[]=[];
const policy=nativeTestPolicy();
const lock=platformTestJournalLock;
const journalOptions={ownershipUid:testJournalUid,lock};
const id=()=>randomUUID();
let addressCounter=1;

function nativeFake(options:{extraListFingerprint?:boolean;afterCreateTeam?:()=>Promise<void>}={}){
  let team:Record<string,unknown>|undefined,user:Record<string,unknown>|undefined;
  const memberships=new Map<string,{maxBudget:number;budgetDuration:string;models:readonly string[];role:'user'}>();
  const keys=new Map<string,{userId:string;alias:string;teamId:string;maxBudget:number;budgetDuration:string;models:readonly string[]}>();
  const calls={team:0,user:0,membership:0,key:0,teamRead:0,userRead:0,membershipRead:0,keyRead:0};
  const native={gatewayOrigin:nativeTestTarget.origin,
    async createTeam(input:{teamId:string;maxBudget:number;budgetDuration:string;models:readonly string[]}){calls.team++;team={teamId:input.teamId,teamMaxBudget:input.maxBudget,teamBudgetDuration:input.budgetDuration,teamModels:input.models};await options.afterCreateTeam?.();return {kind:'acknowledged'};},
    async readTeamPolicy(expected:{teamId:string;teamMaxBudget:number;teamBudgetDuration:string;teamModels:readonly string[]}){calls.teamRead++;return team&&gatewayCanonical(team).equals(gatewayCanonical(expected))?{kind:'match',value:true}:{kind:'mismatch'};},
    async createUser(input:{userId:string;maxBudget:number;userRole:'internal_user'}){calls.user++;user={...input};return {kind:'acknowledged'};},
    async readUser(expected:{userId:string;maxBudget:number;userRole:'internal_user'}){calls.userRead++;return user&&gatewayCanonical(user).equals(gatewayCanonical(expected))?{kind:'match',value:true}:{kind:'mismatch'};},
    async addMember(input:{teamId:string;userId:string;maxBudget:number;budgetDuration:string;models:readonly string[];role:'user'}){calls.membership++;memberships.set(input.userId,{maxBudget:input.maxBudget,budgetDuration:input.budgetDuration,models:input.models,role:input.role});return {kind:'acknowledged'};},
    async readTeam(expected:{teamId:string;memberUserId:string;teamMaxBudget:number;teamBudgetDuration:string;teamModels:readonly string[];memberMaxBudget:number;memberBudgetDuration:string;memberModels:readonly string[];memberRole:'user'}){calls.membershipRead++;const member=memberships.get(expected.memberUserId);return team&&member&&expected.teamId===team.teamId&&expected.teamMaxBudget===team.teamMaxBudget&&expected.teamBudgetDuration===team.teamBudgetDuration&&gatewayCanonical(expected.teamModels).equals(gatewayCanonical(team.teamModels))&&member.maxBudget===expected.memberMaxBudget&&member.budgetDuration===expected.memberBudgetDuration&&member.role===expected.memberRole&&gatewayCanonical(member.models).equals(gatewayCanonical(expected.memberModels))?{kind:'match',value:true}:{kind:'mismatch'};},
    async listOwnedKeys(userId:string){const hashes=[...keys].filter(([,value])=>value.userId===userId).map(([fingerprint])=>fingerprint).sort();if(options.extraListFingerprint)hashes.push('f'.repeat(64));return {kind:'match',value:hashes};},
    async createBlockedKey(input:{key:string;keyAlias:string;teamId:string;userId:string;maxBudget:number;budgetDuration:string;models:readonly string[]}){calls.key++;const fingerprint=createHash('sha256').update(input.key).digest('hex');keys.set(fingerprint,{userId:input.userId,alias:input.keyAlias,teamId:input.teamId,maxBudget:input.maxBudget,budgetDuration:input.budgetDuration,models:input.models});return {kind:'uncertain'};},
    async lookupKey(fingerprint:string,expected:{keyAlias:string;teamId:string;userId:string;maxBudget:number;budgetDuration:string;models:readonly string[]}){calls.keyRead++;const actual=keys.get(fingerprint);return actual&&actual.alias===expected.keyAlias&&actual.teamId===expected.teamId&&actual.userId===expected.userId&&actual.maxBudget===expected.maxBudget&&actual.budgetDuration===expected.budgetDuration&&gatewayCanonical(actual.models).equals(gatewayCanonical(expected.models))?{kind:'match',value:true}:{kind:'mismatch'};},
  };
  return {native:native as unknown as BudgetNativeCredentialClient,calls};
}

async function migrate():Promise<void>{
  const sqlDir=new URL('../../box/sql/',import.meta.url);
  for(const name of readdirSync(sqlDir).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort())await pool.query(readFileSync(new URL(name,sqlDir),'utf8'));
}
async function seed(memberId:string,agents:string[],incarnation:string,existingOrg?:string):Promise<{org:string;member:string}> {
  const org=existingOrg??id(),member=memberId;
  if(!existingOrg)await pool.query('INSERT INTO orgs(id,display_name) VALUES($1,$2)',[org,'Provisioning test']);
  await pool.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES($1,'Owner',$2,'owner','active')",[member,org]);
  await pool.query("INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES($1,'https://identity.example.invalid',$2,'tenant')",[member,`subject-${member}`]);
  await pool.query('INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES($1,25)',[member]);
  for(const name of agents){
    const resourceNumber=addressCounter++;
    const raw=JSON.parse(readFileSync(new URL('../../../packages/agent-kit/templates/chief-of-staff/agent.json',import.meta.url),'utf8')) as Record<string,unknown>;
    raw.name=name;raw.model='lares-brain';
    const definition=parseDefinition(definitionSchema.parse(raw)),duties='',voice='',definitionHash=hashOf({definition,dutiesMd:duties,voiceMd:voice});
    await pool.query('INSERT INTO agent_definitions(name,definition,duties,voice,hash,status) VALUES($1,$2,$3,$4,$5,\'valid\')',[name,JSON.stringify(definition),duties,voice,definitionHash]);
    await pool.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,applied_definition,pending) VALUES($1,$2,$3,'owned',$4,$4,'ready',$5::jsonb,false)",[name,`127.0.1.${resourceNumber}`,`neutral_test_${resourceNumber}`,incarnation,JSON.stringify(definition)]);
    await pool.query('INSERT INTO agent_access(agent_name,owner_member_id,organisation_id) VALUES($1,$2,$3)',[name,member,org]);
  }
  return {org,member};
}

beforeAll(async()=>{
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool=quiet(new Pool({connectionString:container.getConnectionUri(),max:4}));
  await migrate();
},120_000);
afterAll(async()=>{
  for(const journal of journals.splice(0)){try{journal.close();}catch{}}
  await pool?.end();if(container)await container.stop();
  for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});
});

it('reuses verified team and membership, reconciles exact reads, and freezes ambiguous failures',async()=>{
  const member=id(),secondMember=id(),unknownMember=id(),changedMember=id(),rollbackMember=id(),custodyFailureMember=id(),unknownCommitMember=id(),incarnation=id();
  const [agentA,agentB,agentC,agentD,agentE,agentF,agentG,agentH,agentI]=['neutral-helper','neutral-author','neutral-pilot','neutral-inventory','neutral-source','neutral-rollback','neutral-custody','neutral-commit','neutral-expiring'];
  const selected=await seed(member,[agentA,agentB,agentI],incarnation);
  await seed(secondMember,[agentC],incarnation,selected.org);await seed(unknownMember,[agentD],incarnation,selected.org);
  await seed(changedMember,[agentE],incarnation,selected.org);await seed(rollbackMember,[agentF],incarnation,selected.org);
  await seed(custodyFailureMember,[agentG],incarnation,selected.org);await seed(unknownCommitMember,[agentH],incarnation,selected.org);
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-native-provision-'));chmodSync(root,0o700);roots.push(root);
  const directory=join(root,'journal'),db=await pool.connect();
  try{await prepareFinancialCustody(directory,db,journalOptions);}finally{db.release();}
  const journal=HostFinancialJournal.openExisting(directory,{...journalOptions,requirePrepared:true});journals.push(journal);
  await provisionBudgetAccounts(pool,journal,{installationCap:'100',memberIds:[member,secondMember,unknownMember,changedMember,rollbackMember,custodyFailureMember,unknownCommitMember]});
  const custody=createNativeTestCustody(join(root,'native'));
  const fake=nativeFake(),service=new BudgetNativeProvisioner(pool,journal,custody,fake.native,nativeTestTarget,policy);
  const firstBinding=id(),secondBinding=id();
  try{
    await expect(service.provision({bindingId:firstBinding,credentialGeneration:'0',memberId:member,agent:agentA,incarnation,purposeAlias:'lares-brain'})).resolves.toEqual({state:'bound-closed',bindingId:firstBinding,credentialGeneration:'0'});
    const beforeReplay={...fake.calls};
    await expect(service.provision({bindingId:firstBinding,credentialGeneration:'0',memberId:member,agent:agentA,incarnation,purposeAlias:'lares-brain'})).rejects.toThrow();
    expect(fake.calls).toEqual(beforeReplay);
    await expect(service.provision({bindingId:secondBinding,credentialGeneration:'0',memberId:member,agent:agentB,incarnation,purposeAlias:'lares-brain'})).resolves.toEqual({state:'bound-closed',bindingId:secondBinding,credentialGeneration:'0'});
    expect(fake.calls).toEqual({team:1,user:1,membership:1,key:2,teamRead:2,userRead:2,membershipRead:2,keyRead:2});
    const bindings=(await pool.query('SELECT id,state,key_fingerprint FROM budget_gateway_bindings ORDER BY id')).rows;
    expect(bindings).toHaveLength(2);expect(bindings.every(row=>row.state==='active'&&/^[a-f0-9]{64}$/.test(row.key_fingerprint))).toBe(true);
    const snapshot=custody.withGate(gate=>Promise.resolve(gate.inventory()));
    await expect(snapshot).resolves.toMatchObject({teams:[{createAttempt:'verified'}],users:[{userCreateAttempt:'verified',membershipCreateAttempt:'verified'}],operations:[{phase:'bound-closed',keyCreateAttempt:'verified'},{phase:'bound-closed',keyCreateAttempt:'verified'}]});
  }finally{custody.close();}
  const stalePath=join(root,'native-stale-source'),staleInitial=createNativeTestCustody(stalePath);staleInitial.close();
  const staleStore=BudgetNativeCustodyStore.openExisting(stalePath,{ownershipUid:testJournalUid,ownershipGid:process.getgid!(),lock});
  const staleFake=nativeFake(),staleService=new BudgetNativeProvisioner(pool,journal,staleStore,staleFake.native,nativeTestTarget,policy);
  try{
    await expect(staleService.provision({bindingId:id(),credentialGeneration:'0',memberId:secondMember,agent:agentC,incarnation:id(),purposeAlias:'lares-brain'})).rejects.toThrow();
    expect(staleFake.calls).toEqual({team:0,user:0,membership:0,key:0,teamRead:0,userRead:0,membershipRead:0,keyRead:0});
    await expect(staleStore.withGate(gate=>Promise.resolve(gate.inventory()))).resolves.toMatchObject({teams:[],users:[],operations:[]});
  }finally{staleStore.close();}
  const installation=(await pool.query("SELECT id FROM budget_accounts WHERE kind='installation'")).rows[0]!.id;
  const custodyPath=join(root,'native-attempted'),attemptedTeamCustody=createNativeTestCustody(custodyPath);
  await attemptedTeamCustody.withGate(async gate=>{const team=gate.reserveTeam(installation,nativeTestTarget,policy);gate.claimTeamCreate(team.ownershipId);});
  attemptedTeamCustody.close();
  const reopened=(await import('../lib/budget-native-custody.js')).BudgetNativeCustodyStore.openExisting(custodyPath,{ownershipUid:testJournalUid,ownershipGid:process.getgid!(),lock});
  const secondFake=nativeFake(),secondService=new BudgetNativeProvisioner(pool,journal,reopened,secondFake.native,nativeTestTarget,policy);
  try{
    await expect(secondService.provision({bindingId:id(),credentialGeneration:'0',memberId:secondMember,agent:agentC,incarnation,purposeAlias:'lares-brain'})).rejects.toThrow();
    expect(secondFake.calls).toEqual({team:0,user:0,membership:0,key:0,teamRead:0,userRead:0,membershipRead:0,keyRead:0});
    await expect(reopened.withGate(gate=>Promise.resolve(gate.inventory()))).resolves.toMatchObject({teams:[{createAttempt:'attempted'}],users:[],operations:[]});
    expect((await pool.query('SELECT count(*)::int AS count FROM budget_gateway_bindings')).rows[0]!.count).toBe(2);
  }finally{reopened.close();}

  const attemptedBinding=id(),attemptedPath=join(root,'native-key-attempt'),attempted=createNativeTestCustody(attemptedPath);
  const memberAccount=(await pool.query("SELECT id FROM budget_accounts WHERE kind='member' AND live_member_id=$1",[secondMember])).rows[0]!.id;
  const definitionHash=(await pool.query('SELECT hash FROM agent_definitions WHERE name=$1',[agentC])).rows[0]!.hash;
  await attempted.withGate(async gate=>{
    const team=gate.reserveTeam(installation,nativeTestTarget,policy),user=gate.reserveUser(memberAccount,team.ownershipId,policy);
    gate.claimTeamCreate(team.ownershipId);gate.verifyTeamCreated(team.ownershipId);
    gate.claimUserCreate(user.ownershipId);gate.verifyUserCreated(user.ownershipId);
    gate.claimMembershipCreate(user.ownershipId);gate.verifyMembershipCreated(user.ownershipId);
    const op=gate.prepareOperation({bindingId:attemptedBinding,credentialGeneration:'0',userOwnershipId:user.ownershipId,
      association:{agent:agentC,incarnation,definitionHash,purposeAlias:'lares-brain'},reviewedPolicy:policy},`sk-${'a'.repeat(43)}`);
    gate.beginProvisioning(op.operationId);gate.claimKeyCreate(op.operationId);
  });
  attempted.close();
  const attemptedOpen=(await import('../lib/budget-native-custody.js')).BudgetNativeCustodyStore.openExisting(attemptedPath,{ownershipUid:testJournalUid,ownershipGid:process.getgid!(),lock});
  const repeatedFake=nativeFake(),repeated=new BudgetNativeProvisioner(pool,journal,attemptedOpen,repeatedFake.native,nativeTestTarget,policy);
  try{
    await expect(repeated.provision({bindingId:attemptedBinding,credentialGeneration:'0',memberId:secondMember,agent:agentC,incarnation,purposeAlias:'lares-brain'})).rejects.toThrow();
    expect(repeatedFake.calls).toEqual({team:0,user:0,membership:0,key:0,teamRead:0,userRead:0,membershipRead:0,keyRead:0});
    await expect(attemptedOpen.withGate(gate=>Promise.resolve(gate.inventory()))).resolves.toMatchObject({operations:[{phase:'provisioning',keyCreateAttempt:'attempted'}]});
  }finally{attemptedOpen.close();}

  const unknownStore=createNativeTestCustody(join(root,'native-unknown-inventory')),unknownFake=nativeFake({extraListFingerprint:true});
  const unknownService=new BudgetNativeProvisioner(pool,journal,unknownStore,unknownFake.native,nativeTestTarget,policy);
  try{
    await expect(unknownService.provision({bindingId:id(),credentialGeneration:'0',memberId:unknownMember,agent:agentD,incarnation,purposeAlias:'lares-brain'})).rejects.toThrow();
    expect(unknownFake.calls.key).toBe(0);expect((await pool.query('SELECT count(*)::int AS count FROM budget_gateway_bindings')).rows[0]!.count).toBe(2);
  }finally{unknownStore.close();}

  const changedStore=createNativeTestCustody(join(root,'native-source-change')),changedFake=nativeFake({afterCreateTeam:async()=>{await pool.query("UPDATE agent_definitions SET status='invalid' WHERE name=$1",[agentE]);}});
  const changedService=new BudgetNativeProvisioner(pool,journal,changedStore,changedFake.native,nativeTestTarget,policy);
  try{
    await expect(changedService.provision({bindingId:id(),credentialGeneration:'0',memberId:changedMember,agent:agentE,incarnation,purposeAlias:'lares-brain'})).rejects.toThrow();
    expect(changedFake.calls.key).toBe(1);expect((await pool.query('SELECT count(*)::int AS count FROM budget_gateway_bindings')).rows[0]!.count).toBe(2);
  }finally{changedStore.close();}

  const expiryGrant=id();
  await pool.query(`INSERT INTO resource_grants(id,resource_kind,resource_id,principal_organisation_id,permission,grantor_member_id,issued_access_revision,expires_at)
    SELECT $1,'agent',$2,organisation_id,'use',owner_member_id,revision,clock_timestamp()+interval '2 seconds' FROM agent_access WHERE agent_name=$2`,[expiryGrant,agentI]);
  const expiryStore=createNativeTestCustody(join(root,'native-expired-grant'));
  const expiryFake=nativeFake({afterCreateTeam:async()=>new Promise(resolve=>setTimeout(resolve,3000))});
  const expiryService=new BudgetNativeProvisioner(pool,journal,expiryStore,expiryFake.native,nativeTestTarget,policy),expiryBinding=id();
  try{
    await expect(expiryService.provision({bindingId:expiryBinding,credentialGeneration:'0',memberId:secondMember,agent:agentI,incarnation,purposeAlias:'lares-brain'})).rejects.toThrow();
    expect(expiryFake.calls.key).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM budget_gateway_bindings')).rows[0]!.count).toBe(2);
  }finally{expiryStore.close();}

  await pool.query(`CREATE FUNCTION reject_test_budget_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic binding rollback'; END $$;
    CREATE TRIGGER reject_test_budget_binding BEFORE INSERT ON budget_gateway_bindings FOR EACH ROW EXECUTE FUNCTION reject_test_budget_binding()`);
  const rollbackStore=createNativeTestCustody(join(root,'native-final-rollback')),rollbackFake=nativeFake();
  const rollbackService=new BudgetNativeProvisioner(pool,journal,rollbackStore,rollbackFake.native,nativeTestTarget,policy);
  try{
    await expect(rollbackService.provision({bindingId:id(),credentialGeneration:'0',memberId:rollbackMember,agent:agentF,incarnation,purposeAlias:'lares-brain'})).rejects.toThrow();
    expect(rollbackFake.calls.key).toBe(1);expect((await pool.query('SELECT count(*)::int AS count FROM budget_gateway_bindings')).rows[0]!.count).toBe(2);
  }finally{rollbackStore.close();await pool.query('DROP TRIGGER reject_test_budget_binding ON budget_gateway_bindings; DROP FUNCTION reject_test_budget_binding()');}

  let failCustodySync=false;
  const postCommitSource={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();return {
    query:async(sql:string,values?:unknown[])=>{const result=await (client.query as (query:string,parameters?:unknown[])=>Promise<{rows:any[];command?:string}>)(sql,values);if(/^INSERT INTO budget_gateway_bindings/i.test(sql))failCustodySync=true;return result;},
    release:client.release.bind(client),
  };}} as unknown as typeof pool;
  const custodySync=(fd:number)=>{fsyncSync(fd);if(failCustodySync){failCustodySync=false;throw new Error('synthetic post-commit custody fsync failure');}};
  const postCommitStore=BudgetNativeCustodyStore.createNew(join(root,'native-post-commit'),{ownershipUid:testJournalUid,ownershipGid:process.getgid!(),lock,sync:custodySync});
  const postCommitFake=nativeFake(),postCommitService=new BudgetNativeProvisioner(postCommitSource,journal,postCommitStore,postCommitFake.native,nativeTestTarget,policy);
  try{
    await expect(postCommitService.provision({bindingId:id(),credentialGeneration:'0',memberId:custodyFailureMember,agent:agentG,incarnation,purposeAlias:'lares-brain'})).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int AS count FROM budget_gateway_bindings')).rows[0]!.count).toBe(3);
  }finally{postCommitStore.close();}
  const {BudgetNativeCustodyStore:Custody}=await import('../lib/budget-native-custody.js');
  expect(()=>Custody.openExisting(join(root,'native-post-commit'),{ownershipUid:testJournalUid,ownershipGid:process.getgid!(),lock})).toThrow();

  let hideNextCommit=false;
  const unknownCommitSource={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();return {
    query:async(sql:string,values?:unknown[])=>{const result=await (client.query as (query:string,parameters?:unknown[])=>Promise<{rows:any[];command?:string}>)(sql,values);
      if(/^INSERT INTO budget_gateway_bindings/i.test(sql))hideNextCommit=true;
      if(/^COMMIT$/i.test(sql)&&hideNextCommit){hideNextCommit=false;return {...result,command:'UNKNOWN'};}return result;},
    release:client.release.bind(client),
  };}} as unknown as typeof pool;
  const unknownCommitStore=createNativeTestCustody(join(root,'native-unknown-commit')),unknownCommitFake=nativeFake();
  const unknownCommitService=new BudgetNativeProvisioner(unknownCommitSource,journal,unknownCommitStore,unknownCommitFake.native,nativeTestTarget,policy);
  try{
    await expect(unknownCommitService.provision({bindingId:id(),credentialGeneration:'0',memberId:unknownCommitMember,agent:agentH,incarnation,purposeAlias:'lares-brain'})).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int AS count FROM budget_gateway_bindings')).rows[0]!.count).toBe(4);
  }finally{unknownCommitStore.close();}
},20_000);
