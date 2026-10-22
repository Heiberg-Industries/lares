import {chmodSync,fsyncSync,mkdtempSync,readdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {quiet} from './helpers/quiet-pool.js';
import {HostFinancialJournal} from '../lib/financial-journal.js';
import {prepareFinancialCustody} from '../lib/financial-continuity.js';
import {provisionBudgetAccounts} from '../lib/budget-account-provisioning.js';
import {BudgetNativeProvisioner} from '../lib/budget-native-provisioning.js';
import {BudgetNativeActivator} from '../lib/budget-native-activation.js';
import {BudgetNativeCredentialClient} from '../lib/budget-native-client.js';
import {BudgetNativeCustodyStore,type NativeCustodyGate,type NativeOperation} from '../lib/budget-native-custody.js';
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

function nativeFake(options:{extraListFingerprint?:boolean;afterCreateTeam?:()=>Promise<void>;afterUnblock?:()=>Promise<void>|void;loseUnblockAck?:boolean;rejectUnblockedReadback?:boolean}={}){
  let team:Record<string,unknown>|undefined;const users=new Map<string,Record<string,unknown>>();
  let rejectUnblockedReadback=options.rejectUnblockedReadback===true;
  let mismatchTeamPolicy=false,mismatchNextUnblock=false;
  const memberships=new Map<string,{maxBudget:number;budgetDuration:string;models:readonly string[];role:'user'}>();
  const keys=new Map<string,{userId:string;alias:string;teamId:string;maxBudget:number;budgetDuration:string;models:readonly string[];blocked:boolean}>();
  const activationCalls={unblock:0,unblockedRead:0};
  const calls={team:0,user:0,membership:0,key:0,teamRead:0,userRead:0,membershipRead:0,keyRead:0};
  const native={gatewayOrigin:nativeTestTarget.origin,
    async createTeam(input:{teamId:string;maxBudget:number;budgetDuration:string;models:readonly string[]}){calls.team++;team={teamId:input.teamId,teamMaxBudget:input.maxBudget,teamBudgetDuration:input.budgetDuration,teamModels:input.models};await options.afterCreateTeam?.();return {kind:'acknowledged'};},
    async readTeamPolicy(expected:{teamId:string;teamMaxBudget:number;teamBudgetDuration:string;teamModels:readonly string[]}){calls.teamRead++;return !mismatchTeamPolicy&&team&&gatewayCanonical(team).equals(gatewayCanonical(expected))?{kind:'match',value:true}:{kind:'mismatch'};},
    async createUser(input:{userId:string;maxBudget:number;userRole:'internal_user'}){calls.user++;users.set(input.userId,{...input});return {kind:'acknowledged'};},
    async readUser(expected:{userId:string;maxBudget:number;userRole:'internal_user'}){calls.userRead++;const user=users.get(expected.userId);return user&&gatewayCanonical(user).equals(gatewayCanonical(expected))?{kind:'match',value:true}:{kind:'mismatch'};},
    async addMember(input:{teamId:string;userId:string;maxBudget:number;budgetDuration:string;models:readonly string[];role:'user'}){calls.membership++;memberships.set(input.userId,{maxBudget:input.maxBudget,budgetDuration:input.budgetDuration,models:input.models,role:input.role});return {kind:'acknowledged'};},
    async readTeam(expected:{teamId:string;memberUserId:string;teamMaxBudget:number;teamBudgetDuration:string;teamModels:readonly string[];memberMaxBudget:number;memberBudgetDuration:string;memberModels:readonly string[];memberRole:'user'}){calls.membershipRead++;const member=memberships.get(expected.memberUserId);return team&&member&&expected.teamId===team.teamId&&expected.teamMaxBudget===team.teamMaxBudget&&expected.teamBudgetDuration===team.teamBudgetDuration&&gatewayCanonical(expected.teamModels).equals(gatewayCanonical(team.teamModels))&&member.maxBudget===expected.memberMaxBudget&&member.budgetDuration===expected.memberBudgetDuration&&member.role===expected.memberRole&&gatewayCanonical(member.models).equals(gatewayCanonical(expected.memberModels))?{kind:'match',value:true}:{kind:'mismatch'};},
    async listOwnedKeys(userId:string){const hashes=[...keys].filter(([,value])=>value.userId===userId).map(([fingerprint])=>fingerprint).sort();if(options.extraListFingerprint)hashes.push('f'.repeat(64));return {kind:'match',value:hashes};},
    async createBlockedKey(input:{key:string;keyAlias:string;teamId:string;userId:string;maxBudget:number;budgetDuration:string;models:readonly string[]}){calls.key++;const fingerprint=createHash('sha256').update(input.key).digest('hex');keys.set(fingerprint,{userId:input.userId,alias:input.keyAlias,teamId:input.teamId,maxBudget:input.maxBudget,budgetDuration:input.budgetDuration,models:input.models,blocked:true});return {kind:'uncertain'};},
    async lookupKey(fingerprint:string,expected:{keyAlias:string;teamId:string;userId:string;maxBudget:number;budgetDuration:string;models:readonly string[]}){calls.keyRead++;const actual=keys.get(fingerprint);return actual?.blocked===true&&actual.alias===expected.keyAlias&&actual.teamId===expected.teamId&&actual.userId===expected.userId&&actual.maxBudget===expected.maxBudget&&actual.budgetDuration===expected.budgetDuration&&gatewayCanonical(actual.models).equals(gatewayCanonical(expected.models))?{kind:'match',value:true}:{kind:'mismatch'};},
    async unblockKey(fingerprint:string){activationCalls.unblock++;const actual=keys.get(fingerprint);if(!actual)return {kind:'refused'};actual.blocked=false;if(mismatchNextUnblock){mismatchNextUnblock=false;mismatchTeamPolicy=true;}await options.afterUnblock?.();return options.loseUnblockAck?{kind:'uncertain'}:{kind:'acknowledged'};},
    async lookupUnblockedKey(fingerprint:string,expected:{keyAlias:string;teamId:string;userId:string;maxBudget:number;budgetDuration:string;models:readonly string[]}){activationCalls.unblockedRead++;if(rejectUnblockedReadback)return {kind:'mismatch'};const actual=keys.get(fingerprint);return actual?.blocked===false&&actual.alias===expected.keyAlias&&actual.teamId===expected.teamId&&actual.userId===expected.userId&&actual.maxBudget===expected.maxBudget&&actual.budgetDuration===expected.budgetDuration&&gatewayCanonical(actual.models).equals(gatewayCanonical(expected.models))?{kind:'match',value:true}:{kind:'mismatch'};},
  };
  return {native:native as unknown as BudgetNativeCredentialClient,calls,activationCalls,setRejectUnblockedReadback(value:boolean){rejectUnblockedReadback=value;},mismatchTeamPolicyOnNextUnblock(){mismatchNextUnblock=true;}};
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
  const member=id(),secondMember=id(),unknownMember=id(),changedMember=id(),rollbackMember=id(),custodyFailureMember=id(),incarnation=id();
  const [agentA,agentB,agentC,agentD,agentE,agentF,agentG,agentI]=['neutral-helper','neutral-author','neutral-pilot','neutral-inventory','neutral-source','neutral-rollback','neutral-custody','neutral-expiring'];
  const selected=await seed(member,[agentA,agentB,agentI],incarnation);
  await seed(secondMember,[agentC],incarnation,selected.org);await seed(unknownMember,[agentD],incarnation,selected.org);
  await seed(changedMember,[agentE],incarnation,selected.org);await seed(rollbackMember,[agentF],incarnation,selected.org);
  await seed(custodyFailureMember,[agentG],incarnation,selected.org);
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-native-provision-'));chmodSync(root,0o700);roots.push(root);
  const directory=join(root,'journal'),db=await pool.connect();
  try{await prepareFinancialCustody(directory,db,journalOptions);}finally{db.release();}
  const journal=HostFinancialJournal.openExisting(directory,{...journalOptions,requirePrepared:true});journals.push(journal);
  await provisionBudgetAccounts(pool,journal,{installationCap:'100',memberIds:[member,secondMember,unknownMember,changedMember,rollbackMember,custodyFailureMember]});
  const custody=createNativeTestCustody(join(root,'native'));
  const fake=nativeFake(),service=new BudgetNativeProvisioner(pool,journal,custody,fake.native,nativeTestTarget,policy);
  const firstBinding=id(),secondBinding=id();
  try{
    const originalWithGate=custody.withGate,publicationAttempts:Promise<string>[]=[];
    const ownedWithGate=custody.withGate.bind(custody);
    custody.withGate=async <T>(work:(gate:NativeCustodyGate)=>Promise<T>)=>ownedWithGate(gate=>work({...gate,recordBoundClosed:(operationId,receipt)=>{
        publicationAttempts.push(journal.operation('member-remove',async()=>undefined).then(()=> 'entered',error=>error instanceof Error?error.message:'failed'));
        return gate.recordBoundClosed(operationId,receipt);
      }}));
    await expect(service.provision({bindingId:firstBinding,credentialGeneration:'0',memberId:member,agent:agentA,incarnation,purposeAlias:'lares-brain'})).resolves.toEqual({state:'bound-closed',bindingId:firstBinding,credentialGeneration:'0'});
    custody.withGate=originalWithGate;
    await expect(Promise.all(publicationAttempts)).resolves.toEqual(['Financial journal is closed or busy']);
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

  await pool.query("UPDATE agent_definitions SET status='valid' WHERE name=$1",[agentE]);
  const deadlineCases=[
    {phase:'team',memberId:secondMember,agent:agentC},
    {phase:'user',memberId:unknownMember,agent:agentD},
    {phase:'membership',memberId:changedMember,agent:agentE},
    {phase:'key',memberId:rollbackMember,agent:agentF},
  ] as const,originalTime=Date.now();
  for(const [index,item] of deadlineCases.entries()){
    vi.setSystemTime(new Date(originalTime));
    const {phase,memberId,agent}=item,bindingId=id(),storePath=join(root,`deadline-${phase}`),store=createNativeTestCustody(storePath);let crossed=false;
    const originalWithGate=store.withGate.bind(store);
    store.withGate=async <T>(work:(gate:NativeCustodyGate)=>Promise<T>)=>originalWithGate(gate=>work({...gate,
      claimTeamCreate:ownershipId=>{const value=gate.claimTeamCreate(ownershipId);if(phase==='team'){crossed=true;vi.setSystemTime(new Date(Date.now()+20_001));}return value;},
      claimUserCreate:ownershipId=>{const value=gate.claimUserCreate(ownershipId);if(phase==='user'){crossed=true;vi.setSystemTime(new Date(Date.now()+20_001));}return value;},
      claimMembershipCreate:ownershipId=>{const value=gate.claimMembershipCreate(ownershipId);if(phase==='membership'){crossed=true;vi.setSystemTime(new Date(Date.now()+20_001));}return value;},
      readKey:operationId=>{const value=gate.readKey(operationId);if(phase==='key'){crossed=true;vi.setSystemTime(new Date(Date.now()+20_001));}return value;},
    }));
    const fake=nativeFake(),deadlineService=new BudgetNativeProvisioner(pool,journal,store,fake.native,nativeTestTarget,policy);
    const request={bindingId,credentialGeneration:'0',memberId,agent,incarnation,purposeAlias:'lares-brain'};
    try{
      await expect(deadlineService.provision(request)).rejects.toThrow();expect(crossed,phase).toBe(true);
      const expectedCalls={team:index>=1?1:0,user:index>=2?1:0,membership:index>=3?1:0,key:0,teamRead:index>=1?1:0,userRead:index>=2?1:0,membershipRead:index>=3?1:0,keyRead:0};
      expect(fake.calls).toEqual(expectedCalls);
      const control=JSON.parse(readFileSync(join(storePath,'control.json'),'utf8'));
      const inventory=JSON.parse(readFileSync(join(storePath,'snapshot.json'),'utf8'));
      expect(control.state).toBe('uncertain');
      if(index===0)expect(inventory).toMatchObject({teams:[{createAttempt:'attempted'}],operations:[{phase:'provisioning',keyCreateAttempt:'not-attempted'}]});
      else expect(inventory.operations).toMatchObject([{phase:'uncertain'}]);
      await expect(deadlineService.provision(request)).rejects.toThrow();expect(fake.calls).toEqual(expectedCalls);
    }finally{store.close();vi.setSystemTime(new Date(originalTime));vi.useRealTimers();}
  }

  const afterWriteStore=createNativeTestCustody(join(root,'deadline-after-write')),
    afterWriteFake=nativeFake({afterCreateTeam:async()=>{vi.setSystemTime(new Date(Date.now()+20_001));}}),afterWriteBinding=id();
  const afterWriteService=new BudgetNativeProvisioner(pool,journal,afterWriteStore,afterWriteFake.native,nativeTestTarget,policy);
  const afterWriteRequest={bindingId:afterWriteBinding,credentialGeneration:'0',memberId:secondMember,agent:agentC,incarnation,purposeAlias:'lares-brain'};
  try{
    vi.setSystemTime(new Date(originalTime));
    await expect(afterWriteService.provision(afterWriteRequest)).rejects.toThrow();
    expect(afterWriteFake.calls).toMatchObject({team:1,user:0,membership:0,key:0});
    expect(JSON.parse(readFileSync(join(root,'deadline-after-write','snapshot.json'),'utf8')).operations).toMatchObject([{phase:'uncertain'}]);
    const dispatched={...afterWriteFake.calls};
    await expect(afterWriteService.provision(afterWriteRequest)).rejects.toThrow();expect(afterWriteFake.calls).toEqual(dispatched);
  }finally{afterWriteStore.close();vi.setSystemTime(new Date(originalTime));vi.useRealTimers();}

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
    query:async(sql:unknown,values?:unknown[])=>{const text=typeof sql==='string'?sql:sql&&typeof sql==='object'&&'text'in sql?String((sql as {text:unknown}).text):'';
      const result=await (client.query as (query:unknown,parameters?:unknown[])=>Promise<{rows:any[];command?:string}>)(sql,values);if(/^INSERT INTO budget_gateway_bindings/i.test(text))failCustodySync=true;return result;},
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
  await expect(journal.operation('member-remove',async()=>undefined)).rejects.toThrow();

},20_000);

it('activates only verified native keys and preserves the installation epoch for a preprovisioned second member',async()=>{
  await pool.end();await container.stop();
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();pool=quiet(new Pool({connectionString:container.getConnectionUri(),max:4}));await migrate();
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-native-activation-'));chmodSync(root,0o700);roots.push(root);
  const journalDirectory=join(root,'financial'),client=await pool.connect();
  try{await prepareFinancialCustody(journalDirectory,client,journalOptions);}finally{client.release();}
  const journal=HostFinancialJournal.openExisting(journalDirectory,{...journalOptions,requirePrepared:true});journals.push(journal);
  const memberA=id(),memberB=id(),memberC=id(),incarnation=id(),agentA='neutral-activate-a',agentB='neutral-activate-b',agentC='neutral-activate-c';
  const selected=await seed(memberA,[agentA],incarnation);await seed(memberB,[agentB],incarnation,selected.org);await seed(memberC,[agentC],incarnation,selected.org);
  await provisionBudgetAccounts(pool,journal,{installationCap:'100',memberIds:[memberA,memberB,memberC]});
  const custodyPath=join(root,'native'),custody=createNativeTestCustody(custodyPath),fake=nativeFake({loseUnblockAck:true}),provisioner=new BudgetNativeProvisioner(pool,journal,custody,fake.native,nativeTestTarget,policy);
  const bindingA=id(),bindingB=id(),bindingC=id();
  try{
    await expect(provisioner.provision({bindingId:bindingA,credentialGeneration:'0',memberId:memberA,agent:agentA,incarnation,purposeAlias:'lares-brain'})).resolves.toMatchObject({state:'bound-closed'});
    await expect(provisioner.provision({bindingId:bindingB,credentialGeneration:'0',memberId:memberB,agent:agentB,incarnation,purposeAlias:'lares-brain'})).resolves.toMatchObject({state:'bound-closed'});
    await expect(provisioner.provision({bindingId:bindingC,credentialGeneration:'0',memberId:memberC,agent:agentC,incarnation,purposeAlias:'lares-brain'})).resolves.toMatchObject({state:'bound-closed'});
    const before=await pool.query("SELECT id,recovery_epoch,endpoint_generation,selected_endpoint FROM budget_accounts WHERE kind='installation'");
    const initialEpoch=before.rows[0]!.recovery_epoch;
    const windowsBefore=await pool.query(`SELECT w.id,w.account_id,w.opening_cap,to_char(w.starts_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,
      to_char(w.ends_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at FROM budget_windows w JOIN budget_accounts a ON a.active_window_id=w.id WHERE a.kind IN ('installation','member') ORDER BY a.id`);
    const beforeReceipt=await custody.withGate(gate=>Promise.resolve(gate.inventory().operations.filter(row=>row.kind==='operation').map(row=>row.bindingReceipt)));
    const activator=new BudgetNativeActivator(pool,journal,custody,fake.native);
    await expect(activator.activate({bindingId:bindingA,credentialGeneration:'1'})).rejects.toThrow();
    await pool.query("UPDATE agent_definitions SET status='invalid' WHERE name=$1",[agentA]);
    await expect(activator.activate({bindingId:bindingA,credentialGeneration:'0'})).rejects.toThrow();
    expect(fake.activationCalls).toEqual({unblock:0,unblockedRead:0});
    await pool.query("UPDATE agent_definitions SET status='valid' WHERE name=$1",[agentA]);
    await expect(activator.activate({bindingId:bindingA,credentialGeneration:'0'})).resolves.toEqual({state:'active',bindingId:bindingA,credentialGeneration:'0'});
    const afterFirst=await pool.query("SELECT state,reason,recovery_epoch,endpoint_generation,selected_endpoint FROM budget_accounts WHERE kind='installation'");
    expect(afterFirst.rows[0]).toMatchObject({state:'open',reason:'approved',endpoint_generation:'1',selected_endpoint:nativeTestTarget.hash});
    expect(afterFirst.rows[0]!.recovery_epoch).toEqual(expect.any(String));
    const epoch=afterFirst.rows[0]!.recovery_epoch;
    await expect(activator.activate({bindingId:bindingB,credentialGeneration:'0'})).resolves.toEqual({state:'active',bindingId:bindingB,credentialGeneration:'0'});
    await expect(activator.activate({bindingId:bindingA,credentialGeneration:'0'})).rejects.toThrow();
    expect(fake.activationCalls).toEqual({unblock:2,unblockedRead:2});
    const afterSecond=await pool.query("SELECT state,reason,recovery_epoch,endpoint_generation,selected_endpoint FROM budget_accounts WHERE kind='installation'");
    expect(afterSecond.rows[0]).toMatchObject({state:'open',reason:'approved',recovery_epoch:epoch,endpoint_generation:'1',selected_endpoint:nativeTestTarget.hash});
    expect(epoch).not.toBe(initialEpoch);
    const states=await custody.withGate(gate=>Promise.resolve(gate.inventory().operations.filter(row=>row.kind==='operation').map(row=>({phase:row.phase,bindingReceipt:row.bindingReceipt,activationReceipt:row.activationReceipt}))));
    expect(states).toHaveLength(3);expect(states.filter(row=>row.phase==='active')).toHaveLength(2);
    expect(states.every(row=>row.phase==='bound-closed'&&row.activationReceipt===null||row.phase==='active'&&row.activationReceipt?.operation==='native-activation'&&row.bindingReceipt?.operation==='provision')).toBe(true);
    expect(states.map(row=>row.bindingReceipt)).toEqual(beforeReceipt);
    const windowsAfter=await pool.query(`SELECT w.id,w.account_id,w.opening_cap,to_char(w.starts_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,
      to_char(w.ends_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at FROM budget_windows w JOIN budget_accounts a ON a.active_window_id=w.id WHERE a.kind IN ('installation','member') ORDER BY a.id`);
    expect(windowsAfter.rows).toEqual(windowsBefore.rows);
    const members=await pool.query("SELECT live_member_id,state,reason,selected_endpoint,recovery_epoch FROM budget_accounts WHERE kind='member' AND live_member_id=ANY($1::text[])",[[memberA,memberB,memberC]]);
    expect(members.rows).toHaveLength(3);
    for(const row of members.rows){if(row.live_member_id===memberC)expect(row).toMatchObject({state:'closed',reason:'unreconciled',selected_endpoint:null,recovery_epoch:null});
      else expect(row).toMatchObject({state:'open',reason:'approved',selected_endpoint:null,recovery_epoch:null});}
    const failedOperation=(await custody.withGate(gate=>Promise.resolve(gate.inventory().operations.find(row=>row.kind==='operation'&&row.bindingId===bindingC))))!;
    // A false native readback after the durable unblock claim leaves the financial
    // rows closed and records a non-retryable uncertain custody operation.
    expect(failedOperation.phase).toBe('bound-closed');
    fake.mismatchTeamPolicyOnNextUnblock();
    await expect(activator.activate({bindingId:bindingC,credentialGeneration:'0'})).rejects.toThrow();
    expect(fake.activationCalls).toEqual({unblock:3,unblockedRead:3});
    const uncertain=JSON.parse(readFileSync(join(custodyPath,'snapshot.json'),'utf8')).operations.find((row:any)=>row.bindingId===bindingC);
    expect(uncertain).toMatchObject({phase:'uncertain',activationIntent:{unblockAttempt:'verified'}});
    await expect(activator.activate({bindingId:bindingC,credentialGeneration:'0'})).rejects.toThrow();
    expect(fake.activationCalls).toEqual({unblock:3,unblockedRead:3});
    const rejectedMember=(await pool.query("SELECT state,reason FROM budget_accounts WHERE kind='member' AND live_member_id=$1",[memberC])).rows[0];
    expect(rejectedMember).toEqual({state:'closed',reason:'unreconciled'});
  }finally{custody.close();}
},120_000);

it('keeps an activation with an unknown SQL COMMIT non-dispatchable and never unblocks twice',async()=>{
  await pool.end();await container.stop();container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();pool=quiet(new Pool({connectionString:container.getConnectionUri(),max:4}));await migrate();
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-native-activation-unknown-'));chmodSync(root,0o700);roots.push(root);
  const member=id(),incarnation=id(),agent='neutral-activation-unknown';await seed(member,[agent],incarnation);
  const directory=join(root,'financial'),client=await pool.connect();try{await prepareFinancialCustody(directory,client,journalOptions);}finally{client.release();}
  const journal=HostFinancialJournal.openExisting(directory,{...journalOptions,requirePrepared:true});journals.push(journal);
  await provisionBudgetAccounts(pool,journal,{installationCap:'100',memberIds:[member]});
  const custodyPath=join(root,'native'),custody=createNativeTestCustody(custodyPath),fake=nativeFake(),provisioner=new BudgetNativeProvisioner(pool,journal,custody,fake.native,nativeTestTarget,policy),binding=id();
  try{
    await expect(provisioner.provision({bindingId:binding,credentialGeneration:'0',memberId:member,agent,incarnation,purposeAlias:'lares-brain'})).resolves.toMatchObject({state:'bound-closed'});
    const original=await custody.withGate(gate=>Promise.resolve(gate.inventory().operations.find((value):value is NativeOperation=>value.kind==='operation'&&value.bindingId===binding)?.bindingReceipt));
    let reportUnknownCommit=false;
    const unknownCommitSource={query:pool.query.bind(pool),connect:async()=>{const owned=await pool.connect();return {
      query:async(sql:string|{text:string},values?:unknown[])=>{const text=typeof sql==='string'?sql:sql.text;const result=await (owned.query as (query:any,parameters?:unknown[])=>Promise<{rows:any[];command?:string}>)(sql,values);
        if(/UPDATE budget_accounts\s+SET\s+state\s*=\s*'open'/i.test(text))reportUnknownCommit=true;
        if(/^COMMIT$/i.test(text)&&reportUnknownCommit){reportUnknownCommit=false;return {...result,command:'UNKNOWN'};}return result;},release:owned.release.bind(owned),
    };}} as unknown as typeof pool;
    const activator=new BudgetNativeActivator(unknownCommitSource,journal,custody,fake.native);
    await expect(activator.activate({bindingId:binding,credentialGeneration:'0'})).rejects.toThrow();
    expect((await pool.query("SELECT state,reason FROM budget_accounts WHERE kind='member' AND live_member_id=$1",[member])).rows[0]).toEqual({state:'open',reason:'approved'});
    const uncertain=JSON.parse(readFileSync(join(custodyPath,'snapshot.json'),'utf8')).operations.find((value:any)=>value.kind==='operation'&&value.bindingId===binding);
    expect(uncertain).toMatchObject({phase:'activation-pending',activationIntent:{unblockAttempt:'verified'},bindingReceipt:original,activationReceipt:null});
    expect(JSON.parse(readFileSync(join(custodyPath,'control.json'),'utf8')).state).toBe('uncertain');expect(fake.activationCalls).toEqual({unblock:1,unblockedRead:1});
    await expect(new BudgetNativeActivator(pool,journal,custody,fake.native).activate({bindingId:binding,credentialGeneration:'0'})).rejects.toThrow();expect(fake.activationCalls).toEqual({unblock:1,unblockedRead:1});
  }finally{custody.close();}
},120_000);

it('keeps activation SQL committed but non-dispatchable when observed-publication fsync fails',async()=>{
  await pool.end();await container.stop();container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();pool=quiet(new Pool({connectionString:container.getConnectionUri(),max:4}));await migrate();
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-native-activation-fsync-'));chmodSync(root,0o700);roots.push(root);
  const member=id(),incarnation=id(),agent='neutral-activation-fsync';await seed(member,[agent],incarnation);
  const directory=join(root,'financial'),client=await pool.connect();try{await prepareFinancialCustody(directory,client,journalOptions);}finally{client.release();}
  let failNextJournalSync=false;const failingJournalOptions={...journalOptions,sync:(fd:number)=>{if(failNextJournalSync){failNextJournalSync=false;throw new Error('synthetic post-observation fsync failure');}fsyncSync(fd);}};
  const journal=HostFinancialJournal.openExisting(directory,{...failingJournalOptions,requirePrepared:true});journals.push(journal);
  await provisionBudgetAccounts(pool,journal,{installationCap:'100',memberIds:[member]});
  const custodyPath=join(root,'native'),custody=createNativeTestCustody(custodyPath),fake=nativeFake(),provisioner=new BudgetNativeProvisioner(pool,journal,custody,fake.native,nativeTestTarget,policy),binding=id();
  try{
    await expect(provisioner.provision({bindingId:binding,credentialGeneration:'0',memberId:member,agent,incarnation,purposeAlias:'lares-brain'})).resolves.toMatchObject({state:'bound-closed'});
    const original=await custody.withGate(gate=>Promise.resolve(gate.inventory().operations.find((value):value is NativeOperation=>value.kind==='operation'&&value.bindingId===binding)?.bindingReceipt));
    let ownerCommitted=false,observerReading=false;
    const postCommitSource={query:pool.query.bind(pool),connect:async()=>{const owned=await pool.connect();return {
      query:async(sql:string|{text:string},values?:unknown[])=>{const text=typeof sql==='string'?sql:sql.text;const result=await (owned.query as (query:any,parameters?:unknown[])=>Promise<{rows:any[];command?:string}>)(sql,values);
        if(ownerCommitted&&text.includes('pg_control_system'))observerReading=true;
        if(/^COMMIT$/i.test(text)){if(ownerCommitted&&observerReading){observerReading=false;failNextJournalSync=true;}else ownerCommitted=true;}return result;},release:owned.release.bind(owned),
    };}} as unknown as typeof pool;
    await expect(new BudgetNativeActivator(postCommitSource,journal,custody,fake.native).activate({bindingId:binding,credentialGeneration:'0'})).rejects.toThrow();
    expect((await pool.query("SELECT state,reason FROM budget_accounts WHERE kind='member' AND live_member_id=$1",[member])).rows[0]).toEqual({state:'open',reason:'approved'});
    const uncertain=JSON.parse(readFileSync(join(custodyPath,'snapshot.json'),'utf8')).operations.find((value:any)=>value.kind==='operation'&&value.bindingId===binding);
    expect(uncertain).toMatchObject({phase:'activation-pending',activationIntent:{unblockAttempt:'verified'},bindingReceipt:original,activationReceipt:null});
    expect(JSON.parse(readFileSync(join(custodyPath,'control.json'),'utf8')).state).toBe('uncertain');expect(fake.activationCalls).toEqual({unblock:1,unblockedRead:1});
    await expect(new BudgetNativeActivator(pool,journal,custody,fake.native).activate({bindingId:binding,credentialGeneration:'0'})).rejects.toThrow();expect(fake.activationCalls).toEqual({unblock:1,unblockedRead:1});
    await expect(journal.operation('native-activation',async()=>undefined)).rejects.toThrow();
  }finally{custody.close();}
},120_000);

it.each(['grant','month','absolute'] as const)('keeps activation non-dispatchable when the %s deadline expires after the unblock claim',async expiry=>{
  await pool.end();await container.stop();container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();pool=quiet(new Pool({connectionString:container.getConnectionUri(),max:4}));await migrate();
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-native-activation-deadline-'));chmodSync(root,0o700);roots.push(root);
  const member=id(),incarnation=id(),agent=`neutral-activation-${expiry}`;
  const selected=expiry==='grant'?await seed(member,[],incarnation):await seed(member,[agent],incarnation);
  const grantor=expiry==='grant'?id():undefined;if(grantor)await seed(grantor,[agent],incarnation,selected.org);
  const directory=join(root,'financial'),client=await pool.connect();try{await prepareFinancialCustody(directory,client,journalOptions);}finally{client.release();}
  const journal=HostFinancialJournal.openExisting(directory,{...journalOptions,requirePrepared:true});journals.push(journal);
  await provisionBudgetAccounts(pool,journal,{installationCap:'100',memberIds:[member]});
  if(expiry==='grant'){
    await pool.query(`INSERT INTO resource_grants(id,resource_kind,resource_id,principal_member_id,permission,grantor_member_id,issued_access_revision,expires_at)
      SELECT $1,'agent',$2,$3,'use',$4,revision,clock_timestamp()+interval '5 seconds' FROM agent_access WHERE agent_name=$2`,[id(),agent,member,grantor]);
  }
  const custodyPath=join(root,'native'),custody=createNativeTestCustody(custodyPath);let crossedAfterUnblock=false;
  const realNow=Date.now;
  const fake=nativeFake({afterUnblock:async()=>{crossedAfterUnblock=true;if(expiry==='grant')await new Promise(resolve=>setTimeout(resolve,5_500));if(expiry==='absolute')Date.now=()=>realNow()+21_000;}});
  const provisioner=new BudgetNativeProvisioner(pool,journal,custody,fake.native,nativeTestTarget,policy),binding=id();
  try{
    await expect(provisioner.provision({bindingId:binding,credentialGeneration:'0',memberId:member,agent,incarnation,purposeAlias:'lares-brain'})).resolves.toMatchObject({state:'bound-closed'});
    const original=await custody.withGate(gate=>Promise.resolve(gate.inventory().operations.find((value):value is NativeOperation=>value.kind==='operation'&&value.bindingId===binding)?.bindingReceipt));
    const source=expiry==='month'?{query:pool.query.bind(pool),connect:async()=>{const owned=await pool.connect();return {
      query:async(sql:string|{text:string},values?:unknown[])=>{const text=typeof sql==='string'?sql:sql.text;const result=await (owned.query as (query:any,parameters?:unknown[])=>Promise<{rows:any[];command?:string}>)(sql,values);
        if(crossedAfterUnblock&&/^SELECT 1 WHERE \$1::timestamptz>clock_timestamp\(\)/i.test(text))return {...result,rows:[]};return result;},release:owned.release.bind(owned),
    };}} as unknown as typeof pool:pool;
    await expect(new BudgetNativeActivator(source,journal,custody,fake.native).activate({bindingId:binding,credentialGeneration:'0'})).rejects.toThrow();
    expect(crossedAfterUnblock).toBe(true);
    expect((await pool.query("SELECT state,reason FROM budget_accounts WHERE kind='member' AND live_member_id=$1",[member])).rows[0]).toEqual({state:'closed',reason:'unreconciled'});
    const uncertain=JSON.parse(readFileSync(join(custodyPath,'snapshot.json'),'utf8')).operations.find((value:any)=>value.kind==='operation'&&value.bindingId===binding);
    expect(uncertain).toMatchObject({phase:expiry==='absolute'?'uncertain':'activation-pending',activationIntent:{unblockAttempt:'attempted'},bindingReceipt:original,activationReceipt:null});
    expect(JSON.parse(readFileSync(join(custodyPath,'control.json'),'utf8')).state).toBe('uncertain');expect(fake.activationCalls.unblock).toBe(1);
    await expect(new BudgetNativeActivator(pool,journal,custody,fake.native).activate({bindingId:binding,credentialGeneration:'0'})).rejects.toThrow();expect(fake.activationCalls.unblock).toBe(1);
  }finally{Date.now=realNow;custody.close();}
},120_000);

it('keeps an unknown financial commit unpublished in fresh custody',async()=>{
  await pool.end();await container.stop();
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool=quiet(new Pool({connectionString:container.getConnectionUri(),max:4}));await migrate();
  let isolatedJournal:HostFinancialJournal|undefined,unknownCommitStore:BudgetNativeCustodyStore|undefined;
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-native-unknown-commit-'));chmodSync(root,0o700);roots.push(root);
  try{
    const member=id(),incarnation=id(),agent='neutral-unknown-commit';await seed(member,[agent],incarnation);
    const directory=join(root,'financial'),client=await pool.connect();
    try{await prepareFinancialCustody(directory,client,journalOptions);}finally{client.release();}
    isolatedJournal=HostFinancialJournal.openExisting(directory,{...journalOptions,requirePrepared:true});journals.push(isolatedJournal);
    await provisionBudgetAccounts(pool,isolatedJournal,{installationCap:'100',memberIds:[member]});
    let hideNextCommit=false;
    const unknownCommitSource={query:pool.query.bind(pool),connect:async()=>{const owned=await pool.connect();return {
      query:async(sql:unknown,values?:unknown[])=>{const text=typeof sql==='string'?sql:sql&&typeof sql==='object'&&'text'in sql?String((sql as {text:unknown}).text):'';
        const result=await (owned.query as (query:unknown,parameters?:unknown[])=>Promise<{rows:any[];command?:string}>)(sql,values);
        if(/^INSERT INTO budget_gateway_bindings/i.test(text))hideNextCommit=true;
        if(/^COMMIT$/i.test(text)&&hideNextCommit){hideNextCommit=false;return {...result,command:'UNKNOWN'};}return result;},
      release:owned.release.bind(owned),
    };}} as unknown as typeof pool;
    const custodyPath=join(root,'native'),fake=nativeFake();unknownCommitStore=createNativeTestCustody(custodyPath);
    const service=new BudgetNativeProvisioner(unknownCommitSource,isolatedJournal,unknownCommitStore,fake.native,nativeTestTarget,policy),bindingId=id();
    await expect(service.provision({bindingId,credentialGeneration:'0',memberId:member,agent,incarnation,purposeAlias:'lares-brain'})).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int AS count FROM budget_gateway_bindings')).rows[0]!.count).toBe(1);
    const custody=JSON.parse(readFileSync(join(custodyPath,'snapshot.json'),'utf8'));
    expect(custody.operations).toHaveLength(1);expect(custody.operations[0]).toMatchObject({phase:'native-blocked-verified',bindingReceipt:null});
    await expect(isolatedJournal.operation('member-remove',async()=>undefined)).rejects.toThrow();
  }finally{
    unknownCommitStore?.close();
  }
},120_000);
