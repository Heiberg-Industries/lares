import {chmodSync,fsyncSync,lstatSync,mkdtempSync,readdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {quiet} from './helpers/quiet-pool.js';
import {HostFinancialJournal} from '../lib/financial-journal.js';
import {prepareFinancialCustody} from '../lib/financial-continuity.js';
import {provisionBudgetAccounts} from '../lib/budget-account-provisioning.js';
import {registerInitialMemberBudgetActions} from '../lib/initial-member-budget.js';
import {resetActions,runAction} from '../lib/actions.js';
import {provisionEngineDatabasePrivileges} from '../../box/lib/database-privileges.js';
import {verifyFinancialContinuity} from '../lib/financial-continuity.js';
import {BudgetNativeProvisioner} from '../lib/budget-native-provisioning.js';
import {BudgetNativeActivator} from '../lib/budget-native-activation.js';
import {createNativeRuntimeAuthority} from '../lib/budget-native-runtime-authority.js';
import {BudgetNativeCredentialClient} from '../lib/budget-native-client.js';
import {BudgetNativeCustodyStore,type NativeCustodyGate,type NativeOperation} from '../lib/budget-native-custody.js';
import {gatewayCanonical} from '@lares/agent-kit/gateway-admission-protocol';
import {PgGrantStore} from '@lares/agent-kit/grant-store';
import {definitionSchema,hashOf,parseDefinition} from '@lares/agent-kit/definition';
import {platformTestJournalLock,testJournalUid} from './helpers/financial-journal.js';
import {createNativeTestCustody,nativeTestPolicy,nativeTestTarget} from './helpers/native-cleanup.js';

let container:StartedPostgreSqlContainer|undefined;
let pool:Pool;
const journals:HostFinancialJournal[]=[],roots:string[]=[];
const restrictedPools:Pool[]=[];
const fixtureCustodies:BudgetNativeCustodyStore[]=[];
const policy=nativeTestPolicy();
const lock=platformTestJournalLock;
const journalOptions={ownershipUid:testJournalUid,lock};
const id=()=>randomUUID();
let addressCounter=1;
const financialPassword=Buffer.from('native-later-financial-role-test-password');
const applicationPassword=Buffer.from('native-later-application-role-test-password');

function nativeFake(options:{extraListFingerprint?:boolean;afterCreateTeam?:()=>Promise<void>;afterCreateUser?:()=>Promise<void>;afterAddMember?:()=>Promise<void>|void;
  afterUnblock?:()=>Promise<void>|void;loseUnblockAck?:boolean;rejectUnblockedReadback?:boolean}={}){
  let team:Record<string,unknown>|undefined;const users=new Map<string,Record<string,unknown>>();
  let afterCreateUser=options.afterCreateUser,afterAddMember=options.afterAddMember;
  let rejectUnblockedReadback=options.rejectUnblockedReadback===true;
  let mismatchTeamPolicy=false,mismatchNextUnblock=false;
  const memberships=new Map<string,{maxBudget:number;budgetDuration:string;models:readonly string[];role:'user'}>();
  const keys=new Map<string,{userId:string;alias:string;teamId:string;maxBudget:number;budgetDuration:string;models:readonly string[];blocked:boolean}>();
  const activationCalls={unblock:0,unblockedRead:0};
  const calls={team:0,user:0,membership:0,key:0,teamRead:0,userRead:0,membershipRead:0,keyRead:0};
  const native={gatewayOrigin:nativeTestTarget.origin,
    async createTeam(input:{teamId:string;maxBudget:number;budgetDuration:string;models:readonly string[]}){calls.team++;team={teamId:input.teamId,teamMaxBudget:input.maxBudget,teamBudgetDuration:input.budgetDuration,teamModels:input.models};await options.afterCreateTeam?.();return {kind:'acknowledged'};},
    async readTeamPolicy(expected:{teamId:string;teamMaxBudget:number;teamBudgetDuration:string;teamModels:readonly string[]}){calls.teamRead++;return !mismatchTeamPolicy&&team&&gatewayCanonical(team).equals(gatewayCanonical(expected))?{kind:'match',value:true}:{kind:'mismatch'};},
    async createUser(input:{userId:string;maxBudget:number;userRole:'internal_user'}){calls.user++;users.set(input.userId,{...input});await afterCreateUser?.();return {kind:'acknowledged'};},
    async readUser(expected:{userId:string;maxBudget:number;userRole:'internal_user'}){calls.userRead++;const user=users.get(expected.userId);return user&&gatewayCanonical(user).equals(gatewayCanonical(expected))?{kind:'match',value:true}:{kind:'mismatch'};},
    async addMember(input:{teamId:string;userId:string;maxBudget:number;budgetDuration:string;models:readonly string[];role:'user'}){calls.membership++;memberships.set(input.userId,{maxBudget:input.maxBudget,budgetDuration:input.budgetDuration,models:input.models,role:input.role});await afterAddMember?.();return {kind:'acknowledged'};},
    async readTeam(expected:{teamId:string;memberUserId:string;teamMaxBudget:number;teamBudgetDuration:string;teamModels:readonly string[];memberMaxBudget:number;memberBudgetDuration:string;memberModels:readonly string[];memberRole:'user'}){calls.membershipRead++;const member=memberships.get(expected.memberUserId);return team&&member&&expected.teamId===team.teamId&&expected.teamMaxBudget===team.teamMaxBudget&&expected.teamBudgetDuration===team.teamBudgetDuration&&gatewayCanonical(expected.teamModels).equals(gatewayCanonical(team.teamModels))&&member.maxBudget===expected.memberMaxBudget&&member.budgetDuration===expected.memberBudgetDuration&&member.role===expected.memberRole&&gatewayCanonical(member.models).equals(gatewayCanonical(expected.memberModels))?{kind:'match',value:true}:{kind:'mismatch'};},
    async readTeamRoster(expected:{teamId:string;teamMaxBudget:number;teamBudgetDuration:string;teamModels:readonly string[];members:readonly {userId:string;maxBudget:number;budgetDuration:string;models:readonly string[];role:'user'}[]}){
      calls.membershipRead++;
      if(!team||!gatewayCanonical({teamId:expected.teamId,teamMaxBudget:expected.teamMaxBudget,teamBudgetDuration:expected.teamBudgetDuration,teamModels:expected.teamModels}).equals(gatewayCanonical(team)))return {kind:'mismatch'};
      const actual=[...memberships].map(([userId,value])=>({userId,maxBudget:value.maxBudget,budgetDuration:value.budgetDuration,models:value.models,role:value.role})).sort((a,b)=>a.userId.localeCompare(b.userId));
      const wanted=[...expected.members].sort((a,b)=>a.userId.localeCompare(b.userId));
      return gatewayCanonical(actual).equals(gatewayCanonical(wanted))?{kind:'match',value:true}:{kind:'mismatch'};
    },
    async listOwnedKeys(userId:string){const hashes=[...keys].filter(([,value])=>value.userId===userId).map(([fingerprint])=>fingerprint).sort();if(options.extraListFingerprint)hashes.push('f'.repeat(64));return {kind:'match',value:hashes};},
    async createBlockedKey(input:{key:string;keyAlias:string;teamId:string;userId:string;maxBudget:number;budgetDuration:string;models:readonly string[]}){calls.key++;const fingerprint=createHash('sha256').update(input.key).digest('hex');keys.set(fingerprint,{userId:input.userId,alias:input.keyAlias,teamId:input.teamId,maxBudget:input.maxBudget,budgetDuration:input.budgetDuration,models:input.models,blocked:true});return {kind:'uncertain'};},
    async lookupKey(fingerprint:string,expected:{keyAlias:string;teamId:string;userId:string;maxBudget:number;budgetDuration:string;models:readonly string[]}){calls.keyRead++;const actual=keys.get(fingerprint);return actual?.blocked===true&&actual.alias===expected.keyAlias&&actual.teamId===expected.teamId&&actual.userId===expected.userId&&actual.maxBudget===expected.maxBudget&&actual.budgetDuration===expected.budgetDuration&&gatewayCanonical(actual.models).equals(gatewayCanonical(expected.models))?{kind:'match',value:true}:{kind:'mismatch'};},
    async unblockKey(fingerprint:string){activationCalls.unblock++;const actual=keys.get(fingerprint);if(!actual)return {kind:'refused'};actual.blocked=false;if(mismatchNextUnblock){mismatchNextUnblock=false;mismatchTeamPolicy=true;}await options.afterUnblock?.();return options.loseUnblockAck?{kind:'uncertain'}:{kind:'acknowledged'};},
    async lookupUnblockedKey(fingerprint:string,expected:{keyAlias:string;teamId:string;userId:string;maxBudget:number;budgetDuration:string;models:readonly string[]}){activationCalls.unblockedRead++;if(rejectUnblockedReadback)return {kind:'mismatch'};const actual=keys.get(fingerprint);return actual?.blocked===false&&actual.alias===expected.keyAlias&&actual.teamId===expected.teamId&&actual.userId===expected.userId&&actual.maxBudget===expected.maxBudget&&actual.budgetDuration===expected.budgetDuration&&gatewayCanonical(actual.models).equals(gatewayCanonical(expected.models))?{kind:'match',value:true}:{kind:'mismatch'};},
  };
  return {native:native as unknown as BudgetNativeCredentialClient,calls,activationCalls,
    rosterSnapshot(){return [...memberships].map(([userId,value])=>({userId,...value})).sort((a,b)=>a.userId.localeCompare(b.userId));},
    changeMembership(userId:string,change:Partial<{maxBudget:number;budgetDuration:string;models:readonly string[];role:'user'}>){const membership=memberships.get(userId);if(!membership)throw new Error('Native fixture membership is missing');memberships.set(userId,{...membership,...change});},
    setAfterCreateUser(callback:()=>Promise<void>){afterCreateUser=callback;},setAfterAddMember(callback:()=>Promise<void>|void){afterAddMember=callback;},
    setRejectUnblockedReadback(value:boolean){rejectUnblockedReadback=value;},mismatchTeamPolicyOnNextUnblock(){mismatchNextUnblock=true;}};
}

async function migrate():Promise<void>{
  const sqlDir=new URL('../../box/sql/',import.meta.url);
  for(const name of readdirSync(sqlDir).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort())await pool.query(readFileSync(new URL(name,sqlDir),'utf8'));
}
function privateTestSocket():{socket:string;database:string;user:string|undefined;port:number}{
  const socket=process.env.LARES_TEST_PG_SOCKET,database=process.env.LARES_TEST_PG_DATABASE;
  if(!socket||database!=='lares_test_budget_native_provisioning'||resolve(socket)!==socket)throw new Error('Refusing to reset a non-private test database');
  const socketDirectory=socket,privateRoot=dirname(socketDirectory),temporaryRoots=[realpathSync(tmpdir()),realpathSync('/tmp')];
  if(basename(socketDirectory)!=='socket'||!temporaryRoots.includes(dirname(privateRoot))||!basename(privateRoot).startsWith('lares-test-private-'))throw new Error('Refusing to reset a non-private test database');
  for(const path of [privateRoot,socketDirectory]){
    const stat=lstatSync(path);
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid!()||(stat.mode&0o077)!==0||realpathSync(path)!==path)throw new Error('Refusing to reset a non-private test database');
  }
  return {socket,database,user:process.env.LARES_TEST_PG_USER,port:Number(process.env.LARES_TEST_PG_PORT)};
}
async function verifyPrivateTestDatabase(connection:{query:(sql:string)=>Promise<{rows:readonly {database:string;major_version:number;unix_socket:boolean;listen_addresses:string}[]}>}):Promise<void>{
  const row=(await connection.query("SELECT current_database() AS database,(current_setting('server_version_num')::int/10000) AS major_version,inet_server_addr() IS NULL AS unix_socket,current_setting('listen_addresses') AS listen_addresses")).rows[0];
  if(row?.database!=='lares_test_budget_native_provisioning'||row.major_version!==15||row.unix_socket!==true||row.listen_addresses!=='')throw new Error('Refusing non-private PostgreSQL test server');
}
async function resetPrivateTestSchema(resetPool:Pool):Promise<void>{
  try{
    const client=await resetPool.connect();
    try{await verifyPrivateTestDatabase(client);await client.query('DROP SCHEMA public CASCADE');await client.query('CREATE SCHEMA public');}finally{client.release();}
  }finally{await resetPool.end();}
}
async function requireFreshPrivateTestDatabase(freshPool:Pool):Promise<void>{
  await verifyPrivateTestDatabase(freshPool);
  const state=(await freshPool.query(`SELECT
    NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S')) AS empty,
    EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n'::"char",n.nspowner))) a
      WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='USAGE' AND NOT a.is_grantable) AS public_usage
  `)).rows[0];
  if(state?.empty!==true||state.public_usage!==true)throw new Error('Private PostgreSQL case requires a fresh database');
}
async function resetDatabase():Promise<void>{
  const socket=process.env.LARES_TEST_PG_SOCKET,config=socket?privateTestSocket():undefined;
  for(const auxiliary of restrictedPools.splice(0))await auxiliary.end();
  for(const journal of journals.splice(0)){try{journal.close();}catch{}}
  await pool.end();
  if(config){
    const resetPool=new Pool({host:config.socket,port:config.port,user:config.user,database:config.database,options:'-c timezone=UTC'});
    await requireFreshPrivateTestDatabase(resetPool);await resetPool.end();
    pool=quiet(new Pool({host:config.socket,port:config.port,user:config.user,database:config.database,max:8,options:'-c timezone=UTC',application_name:'lares-native-runtime-authority-test'}));
  }else{
    await container!.stop();container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();pool=quiet(new Pool({connectionString:container.getConnectionUri(),max:4}));
  }
  await migrate();
}
async function seed(memberId:string,agents:string[],incarnation:string,existingOrg?:string,roles:Record<string,string|null|undefined>={},database:Pool=pool,memberRole:'owner'|'member'='owner',agentOwnerId=memberId):Promise<{org:string;member:string}> {
  const org=existingOrg??id(),member=memberId;
  if(!existingOrg)await database.query('INSERT INTO orgs(id,display_name) VALUES($1,$2)',[org,'Provisioning test']);
  await database.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES($1,'Owner',$2,$3,'active')",[member,org,memberRole]);
  await database.query("INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES($1,'https://identity.example.invalid',$2,'tenant')",[member,`subject-${member}`]);
  await database.query('INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES($1,25)',[member]);
  for(const name of agents){
    const resourceNumber=addressCounter++;
    const raw=JSON.parse(readFileSync(new URL('../../../packages/agent-kit/templates/chief-of-staff/agent.json',import.meta.url),'utf8')) as Record<string,unknown>;
    raw.name=name;raw.model='lares-brain';raw.role='chief-of-staff';if(Object.hasOwn(roles,name)){if(roles[name]===null)delete raw.role;else raw.role=roles[name];}
    const definition=parseDefinition(definitionSchema.parse(raw)),duties='',voice='',definitionHash=hashOf({definition,dutiesMd:duties,voiceMd:voice});
    await database.query('INSERT INTO agent_definitions(name,definition,duties,voice,hash,status) VALUES($1,$2,$3,$4,$5,\'valid\')',[name,JSON.stringify(definition),duties,voice,definitionHash]);
    await database.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,applied_definition,pending) VALUES($1,$2,$3,'owned',$4,$4,'ready',$5::jsonb,false)",[name,`127.0.1.${resourceNumber}`,`neutral_test_${resourceNumber}`,incarnation,JSON.stringify(definition)]);
    await database.query('INSERT INTO agent_access(agent_name,owner_member_id,organisation_id) VALUES($1,$2,$3)',[name,agentOwnerId,org]);
  }
  return {org,member};
}

async function useFinancialRole():Promise<Pool>{
  const operator=pool,socket=process.env.LARES_TEST_PG_SOCKET,config=socket?privateTestSocket():undefined;
  const database=config?.database??container?.getDatabase();if(!database)throw new Error('Private Keeper role fixture has no database');
  const client=await operator.connect();
  try{await provisionEngineDatabasePrivileges(client,{expectedDatabase:database,passwords:{application:applicationPassword,financial:financialPassword}});}
  finally{client.release();}
  const financial=quiet(config?new Pool({host:config.socket,port:config.port,user:'lares_financial',password:financialPassword.toString('ascii'),database:config.database,max:8,options:'-c timezone=UTC'}):(()=>{
    const uri=new URL(container!.getConnectionUri());uri.pathname=`/${database}`;uri.username='lares_financial';uri.password=financialPassword.toString('ascii');
    return new Pool({connectionString:uri.toString(),max:8,options:'-c timezone=UTC'});
  })());
  restrictedPools.push(operator);
  const identity=(await financial.query('SELECT current_user,session_user')).rows[0];
  expect(identity).toEqual({current_user:'lares_financial',session_user:'lares_financial'});
  pool=financial;
  return financial;
}

async function setCapThroughRegisteredAction(ownerId:string,targetMemberId:string,sessionToken:string,monthlyLimit:string):Promise<void>{
  resetActions();registerInitialMemberBudgetActions({pool,designatedOwnerId:ownerId});
  await runAction('member.set-initial-budget',{sessionToken,targetMemberId,monthlyLimit},{actor:'native test owner',audit:async()=>{}});
}

async function startActiveOwnerFixture():Promise<{operator:Pool;financial:Pool;owner:string;org:string;incarnation:string;ownerAgent:string;ownerBinding:string;
  ownerAccountId:string;installationId:string;ownerNativeUserId:string;sessionToken:string;root:string;journal:HostFinancialJournal;
  custody:BudgetNativeCustodyStore;fake:ReturnType<typeof nativeFake>;provisioner:BudgetNativeProvisioner}>{
  await resetDatabase();
  const operator=pool,owner=id(),incarnation=id(),ownerAgent='neutral-native-owner';
  const selected=await seed(owner,[ownerAgent],incarnation);
  const sessionToken=Buffer.from(randomUUID()+randomUUID()).toString('base64url').slice(0,43);
  await operator.query('INSERT INTO member_sessions(id,member_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\')',
    [id(),owner,createHash('sha256').update(sessionToken).digest('hex')]);
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-native-restricted-owner-'));chmodSync(root,0o700);roots.push(root);
  const directory=join(root,'financial'),db=await operator.connect();
  try{await prepareFinancialCustody(directory,db,journalOptions);}finally{db.release();}
  const journal=HostFinancialJournal.openExisting(directory,{...journalOptions,requirePrepared:true});journals.push(journal);
  const financial=await useFinancialRole();
  await setCapThroughRegisteredAction(owner,owner,sessionToken,'45');
  await expect(provisionBudgetAccounts(financial,journal,{installationCap:'100',memberIds:[owner]})).resolves.toMatchObject({state:'closed',reason:'unreconciled',members:1});
  const ownerAccountId=(await financial.query("SELECT id FROM budget_accounts WHERE kind='member' AND live_member_id=$1",[owner])).rows[0]?.id;
  const installationId=(await financial.query("SELECT id FROM budget_accounts WHERE kind='installation'")).rows[0]?.id;
  if(typeof ownerAccountId!=='string'||typeof installationId!=='string')throw new Error('Active owner fixture accounts are missing');
  const custody=createNativeTestCustody(join(root,'native')),fake=nativeFake(),provisioner=new BudgetNativeProvisioner(financial,journal,custody,fake.native,nativeTestTarget,policy),ownerBinding=id();
  fixtureCustodies.push(custody);
  await expect(provisioner.provision({bindingId:ownerBinding,credentialGeneration:'0',memberId:owner,agent:ownerAgent,incarnation,purposeAlias:'lares-brain'})).resolves.toMatchObject({state:'bound-closed'});
  await expect(new BudgetNativeActivator(financial,journal,custody,fake.native).activate({bindingId:ownerBinding,credentialGeneration:'0'})).resolves.toMatchObject({state:'active'});
  const ownerNativeUserId=(await custody.withGate(gate=>Promise.resolve(gate.inventory().users.find((row):row is Extract<typeof row,{kind:'user'}>=>row.kind==='user'&&row.accountId===ownerAccountId)?.nativeUserId)))!;
  if(typeof ownerNativeUserId!=='string')throw new Error('Verified owner native user is missing');
  expect((await financial.query('SELECT current_user,session_user')).rows[0]).toEqual({current_user:'lares_financial',session_user:'lares_financial'});
  await verifyFinancialContinuity(journal,financial as never);
  return{operator,financial,owner,org:selected.org,incarnation,ownerAgent,ownerBinding,ownerAccountId,installationId,ownerNativeUserId,sessionToken,root,journal,custody,fake,provisioner};
}

async function addLaterAccount(fixture:Awaited<ReturnType<typeof startActiveOwnerFixture>>,agent='neutral-native-later'):Promise<{member:string;agent:string;accountId:string}>{
  const member=id();await seed(member,[agent],fixture.incarnation,fixture.org,{},fixture.operator,'member',fixture.owner);
  await setCapThroughRegisteredAction(fixture.owner,member,fixture.sessionToken,'40');
  await expect(provisionBudgetAccounts(fixture.financial,fixture.journal,{installationCap:'100',memberIds:[member]})).resolves.toMatchObject({state:'closed',reason:'unreconciled',members:1});
  const accountId=(await fixture.financial.query("SELECT id FROM budget_accounts WHERE kind='member' AND live_member_id=$1",[member])).rows[0]?.id;
  if(typeof accountId!=='string')throw new Error('Later member account is missing');
  return{member,agent,accountId};
}

async function grantLaterAgentUse(fixture:Awaited<ReturnType<typeof startActiveOwnerFixture>>,later:{member:string;agent:string},lifetimeMs?:number){
  const revision=(await fixture.operator.query('SELECT revision FROM agent_access WHERE agent_name=$1',[later.agent])).rows[0]?.revision;
  if(revision===undefined)throw new Error('Later agent access row is missing');
  const expiresAt=lifetimeMs===undefined?null:new Date(Date.now()+lifetimeMs).toISOString();
  await new PgGrantStore(fixture.operator).updateAgentAccess(fixture.owner,{agentName:later.agent,expectedRevision:Number(revision),grants:[{
    principal:{kind:'member',id:later.member},permission:'use',expiresAt,
  }]});
  const captured=await new PgGrantStore(fixture.operator).captureUseWithExpiry(later.member,later.agent,{db:fixture.financial});
  if(!captured)throw new Error('Later member grant was not readable through the production grant store');
  if(lifetimeMs!==undefined&&captured.validUntil===null)throw new Error('Later member grant fixture must retain a finite expiry');
  return captured;
}

beforeAll(async()=>{
  const socket=process.env.LARES_TEST_PG_SOCKET;
  if(socket){const config=privateTestSocket();pool=quiet(new Pool({host:config.socket,port:config.port,user:config.user,database:config.database,max:8,options:'-c timezone=UTC',application_name:'lares-native-runtime-authority-test'}));}
  else{container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();pool=quiet(new Pool({connectionString:container.getConnectionUri(),max:4}));}
  if(socket)await verifyPrivateTestDatabase(pool);
  else await migrate();
},120_000);
afterAll(async()=>{
  for(const journal of journals.splice(0)){try{journal.close();}catch{}}
  for(const custody of fixtureCustodies.splice(0)){try{custody.close();}catch{}}
  for(const auxiliary of restrictedPools.splice(0))await auxiliary.end();
  await pool?.end();if(container)await container.stop();
  for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});
});

it('refuses unsafe local database reset targets before schema deletion',async()=>{
  const queries:string[]=[];
  const unsafeClient={query:async(sql:string)=>{queries.push(sql);return {rows:[{database:'lares_test_budget_native_provisioning',major_version:14,unix_socket:true,listen_addresses:''}]};},release(){}};
  const unsafePool={connect:async()=>unsafeClient,end:async()=>{}} as unknown as Pool;
  vi.stubEnv('LARES_TEST_PG_SOCKET','/shared/lares-test-private-not-private/socket');
  try{expect(()=>privateTestSocket()).toThrow('Refusing to reset a non-private test database');}finally{vi.unstubAllEnvs();}
  await expect(resetPrivateTestSchema(unsafePool)).rejects.toThrow('Refusing non-private PostgreSQL test server');
  expect(queries).toHaveLength(1);
  expect(queries.some(sql=>/^(DROP|CREATE)\s+SCHEMA\b/i.test(sql))).toBe(false);
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
    expect(fake.calls).toEqual({team:1,user:1,membership:1,key:2,teamRead:2,userRead:2,membershipRead:6,keyRead:2});
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
      const expectedCalls={team:index>=1?1:0,user:index>=2?1:0,membership:index>=3?1:0,key:0,teamRead:index>=1?1:0,userRead:index>=2?1:0,membershipRead:index===3?2:index===2?1:0,keyRead:0};
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
    expect(expiryFake.calls.key).toBe(0);
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
  await resetDatabase();
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

it('adds a genuinely later capped member to an active installation under the financial role without changing owner authority',async()=>{
  const fixture=await startActiveOwnerFixture(),later=await addLaterAccount(fixture),laterBinding=id();
  await grantLaterAgentUse(fixture,later);
  const before=(await fixture.financial.query(`SELECT id,installation_id,installation_account_id,live_member_id,state,reason,installation_cap,
    active_window_id,endpoint_generation,recovery_epoch,selected_endpoint FROM budget_accounts WHERE kind IN ('installation','member') ORDER BY kind,id`)).rows;
  const ownerWindow=(await fixture.financial.query(`SELECT w.* FROM budget_windows w WHERE w.account_id=$1`,[fixture.ownerAccountId])).rows;
  const bindingsBefore=(await fixture.financial.query('SELECT * FROM budget_gateway_bindings ORDER BY id')).rows;
  const ownerRoster=fixture.fake.rosterSnapshot();expect(ownerRoster).toHaveLength(1);
  expect((await fixture.financial.query('SELECT current_user,session_user')).rows[0]).toEqual({current_user:'lares_financial',session_user:'lares_financial'});
  await expect(fixture.provisioner.provision({bindingId:laterBinding,credentialGeneration:'0',memberId:later.member,agent:later.agent,incarnation:fixture.incarnation,purposeAlias:'lares-brain'}))
    .resolves.toMatchObject({state:'bound-closed'});
  const after=(await fixture.financial.query(`SELECT id,installation_id,installation_account_id,live_member_id,state,reason,installation_cap,
    active_window_id,endpoint_generation,recovery_epoch,selected_endpoint FROM budget_accounts WHERE kind IN ('installation','member') ORDER BY kind,id`)).rows;
  expect(after).toEqual(before);
  expect((await fixture.financial.query('SELECT * FROM budget_windows WHERE account_id=$1',[fixture.ownerAccountId])).rows).toEqual(ownerWindow);
  expect((await fixture.financial.query('SELECT state,reason FROM budget_accounts WHERE id=$1',[later.accountId])).rows[0]).toEqual({state:'closed',reason:'unreconciled'});
  const bindingsAfter=(await fixture.financial.query('SELECT * FROM budget_gateway_bindings ORDER BY id')).rows;
  expect(bindingsAfter.filter((row:any)=>row.id!==laterBinding)).toEqual(bindingsBefore);
  expect(bindingsAfter.find((row:any)=>row.id===laterBinding)).toMatchObject({id:laterBinding,live_member_id:later.member,state:'active'});
  expect(fixture.fake.rosterSnapshot()).toHaveLength(2);
  expect(fixture.fake.rosterSnapshot().find(row=>row.userId===ownerRoster[0]!.userId)).toEqual(ownerRoster[0]);
  await expect(fixture.custody.withGate(gate=>Promise.resolve(gate.inventory().operations.filter(row=>row.kind==='operation').map(row=>row.phase))))
    .resolves.toEqual(['active','bound-closed']);
  await verifyFinancialContinuity(fixture.journal,fixture.financial as never);
},30_000);

it('completes a reopened prepared native retry using the current verified target state and retained owner roster',async()=>{
  const fixture=await startActiveOwnerFixture(),later=await addLaterAccount(fixture,'neutral-native-prepared-retry'),binding=id();
  await grantLaterAgentUse(fixture,later);
  const team=(await fixture.custody.withGate(gate=>Promise.resolve(gate.inventory().teams[0])))!;
  const definitionHash=(await fixture.financial.query('SELECT hash FROM agent_definitions WHERE name=$1',[later.agent])).rows[0]!.hash;
  await fixture.custody.withGate(async gate=>{
    const user=gate.reserveUser(later.accountId,team.ownershipId,policy);
    gate.prepareOperation({bindingId:binding,credentialGeneration:'0',userOwnershipId:user.ownershipId,
      association:{agent:later.agent,incarnation:fixture.incarnation,definitionHash,purposeAlias:'lares-brain'},reviewedPolicy:policy},`sk-${randomBytes(32).toString('base64url')}`);
  });
  const ownerBefore=fixture.fake.rosterSnapshot().find(row=>row.userId===fixture.ownerNativeUserId);
  fixture.custody.close();
  const custody=BudgetNativeCustodyStore.openExisting(join(fixture.root,'native'),{ownershipUid:testJournalUid,ownershipGid:process.getgid!(),lock});
  fixtureCustodies.push(custody);
  fixture.custody=custody;
  const provisioner=new BudgetNativeProvisioner(fixture.financial,fixture.journal,custody,fixture.fake.native,nativeTestTarget,policy);
  await expect(provisioner.provision({bindingId:binding,credentialGeneration:'0',memberId:later.member,agent:later.agent,incarnation:fixture.incarnation,purposeAlias:'lares-brain'}))
    .resolves.toMatchObject({state:'bound-closed'});
  expect(fixture.fake.rosterSnapshot().find(row=>row.userId===fixture.ownerNativeUserId)).toEqual(ownerBefore);
  await expect(custody.withGate(gate=>Promise.resolve(gate.inventory().users.find((row):row is Extract<typeof row,{kind:'user'}>=>row.kind==='user'&&row.accountId===later.accountId))))
    .resolves.toMatchObject({userCreateAttempt:'verified',membershipCreateAttempt:'verified'});
  await verifyFinancialContinuity(fixture.journal,fixture.financial as never);
},30_000);

it('does not dispatch another native mutation after delayed SQL deadline replies cross the original grant expiry',async()=>{
  const fixture=await startActiveOwnerFixture(),later=await addLaterAccount(fixture,'neutral-native-delayed-deadline');
  const ownerCalls={...fixture.fake.calls};
  const grant=await grantLaterAgentUse(fixture,later,1_700);expect(grant.validUntil).toEqual(expect.any(String));
  const delayed:{latencyMs:number;remainingMs:number}[]=[];
  const source={query:fixture.financial.query.bind(fixture.financial),connect:async()=>{
    const client=await fixture.financial.connect();
    return{...client,query:async(sql:string|{text:string},values?:unknown[])=>{
      const text=typeof sql==='string'?sql:sql.text,started=performance.now();
      const result=await client.query(sql as never,values as never) as {rows:any[]};
      if(text.includes('AS remaining_ms')){
        const remainingMs=Number(result.rows[0]?.remaining_ms);await new Promise(resolve=>setTimeout(resolve,600));
        delayed.push({latencyMs:performance.now()-started,remainingMs});
      }
      return result;
    },release:client.release.bind(client)};
  }} as unknown as Pool;
  fixture.fake.setAfterCreateUser(async()=>new Promise(resolve=>setTimeout(resolve,600)));
  try{
    const provisioner=new BudgetNativeProvisioner(source,fixture.journal,fixture.custody,fixture.fake.native,nativeTestTarget,policy);
    await expect(provisioner.provision({bindingId:id(),credentialGeneration:'0',memberId:later.member,agent:later.agent,incarnation:fixture.incarnation,purposeAlias:'lares-brain'})).rejects.toThrow();
    expect(delayed).toHaveLength(2);expect(delayed.every(row=>row.latencyMs>250&&row.remainingMs>250)).toBe(true);
    expect(delayed.every(row=>row.latencyMs-250>0)).toBe(true);
    expect(fixture.fake.calls).toMatchObject({team:ownerCalls.team,user:ownerCalls.user+1,membership:ownerCalls.membership,key:ownerCalls.key});
    expect((await fixture.financial.query('SELECT count(*)::int AS n FROM budget_gateway_bindings WHERE live_member_id=$1',[later.member])).rows[0]!.n).toBe(0);
    expect(JSON.parse(readFileSync(join(fixture.root,'native','control.json'),'utf8')).state).toBe('uncertain');
    await verifyFinancialContinuity(fixture.journal,fixture.financial as never);
  }finally{fixture.fake.setAfterCreateUser(async()=>undefined);}
},30_000);

it('withholds success after custody completion expires without rewriting the published closed receipt',async()=>{
  const fixture=await startActiveOwnerFixture(),later=await addLaterAccount(fixture,'neutral-native-postgate-expiry'),binding=id();
  const grant=await grantLaterAgentUse(fixture,later,3_000);expect(grant.validUntil).toEqual(expect.any(String));
  const originalWithGate=fixture.custody.withGate.bind(fixture.custody);let delayReturn=false,publishedReceipt:unknown,uncertainWrites=0;
  fixture.custody.withGate=async <T>(work:(gate:NativeCustodyGate)=>Promise<T>)=>{
    const result=await originalWithGate(gate=>work({...gate,
      recordBoundClosed:(operationId,receipt)=>{publishedReceipt=receipt;return gate.recordBoundClosed(operationId,receipt);},
      recordUncertain:(operationId)=>{uncertainWrites++;return gate.recordUncertain(operationId);},
    }));
    if(delayReturn){delayReturn=false;await new Promise(resolve=>setTimeout(resolve,3300));}
    return result;
  };
  delayReturn=true;
  await expect(fixture.provisioner.provision({bindingId:binding,credentialGeneration:'0',memberId:later.member,agent:later.agent,incarnation:fixture.incarnation,purposeAlias:'lares-brain'})).rejects.toThrow();
  expect(uncertainWrites).toBe(0);
  expect((await fixture.financial.query('SELECT state FROM budget_gateway_bindings WHERE live_member_id=$1',[later.member])).rows[0]).toEqual({state:'active'});
  const operation=await fixture.custody.withGate(gate=>Promise.resolve(gate.inventory().operations.find((row):row is NativeOperation=>row.kind==='operation'&&row.bindingId===binding)));
  expect(operation).toMatchObject({phase:'bound-closed',bindingReceipt:publishedReceipt});
  await verifyFinancialContinuity(fixture.journal,fixture.financial as never);
},30_000);

it.each(['grant-expiry','resource-revision'] as const)('revalidates source authority changed during a released-lock native call (%s)',async mutation=>{
  const fixture=await startActiveOwnerFixture(),later=await addLaterAccount(fixture,`neutral-native-${mutation==='grant-expiry'?'grant':'resource'}`);
  const grant=await grantLaterAgentUse(fixture,later,10*60_000);expect(grant.validUntil).toEqual(expect.any(String));
  let mutationCommitted=false,mutationError='';
  const update=async()=>{
    const client=await fixture.operator.connect();
    try{await client.query("SET statement_timeout='2s'");
      if(mutation==='grant-expiry'){
        const revision=(await client.query('SELECT revision FROM agent_access WHERE agent_name=$1',[later.agent])).rows[0]?.revision;
        if(revision===undefined)throw new Error('Held grant mutation lost its access row');
        await new PgGrantStore(fixture.operator).updateAgentAccess(fixture.owner,{agentName:later.agent,expectedRevision:Number(revision),grants:[{
          principal:{kind:'member',id:later.member},permission:'use',expiresAt:new Date(Date.now()+20*60_000).toISOString(),
        }]});
      }
      else await client.query("UPDATE agent_resources SET applied_definition=applied_definition || '{\"model\":\"changed\"}'::jsonb WHERE name=$1",[later.agent]);
      mutationCommitted=true;
    }catch(error){mutationError=error instanceof Error?error.message:String(error);throw error;
    }finally{try{await client.query('RESET statement_timeout');}catch{}client.release();}
  };
  fixture.fake.setAfterCreateUser(update);
  try{
    const service=new BudgetNativeProvisioner(fixture.financial,fixture.journal,fixture.custody,fixture.fake.native,nativeTestTarget,policy);
    const outcome=await service.provision({bindingId:id(),credentialGeneration:'0',memberId:later.member,agent:later.agent,incarnation:fixture.incarnation,purposeAlias:'lares-brain'}).then(value=>({value}),error=>({error}));
    expect(mutationCommitted,`held native callback must commit its source mutation; error=${mutationError}; outcome=${'error' in outcome?String(outcome.error):'success'}; calls=${JSON.stringify(fixture.fake.calls)}`).toBe(true);
    const sourceChange=(await fixture.operator.query(mutation==='grant-expiry'?'SELECT revision<>$2 AS changed FROM agent_access WHERE agent_name=$1':"SELECT applied_definition->>'model'='changed' AS changed,applied_definition->>'model' AS model FROM agent_resources WHERE name=$1",
      mutation==='grant-expiry'?[later.agent,grant.accessRevision]:[later.agent])).rows[0];
    expect(sourceChange?.changed,`source mutation did not persist: ${JSON.stringify({sourceChange,mutationCommitted,mutationError,calls:fixture.fake.calls})}`).toBe(true);
    expect('error' in outcome,'provisioning must refuse after the changed authority readback').toBe(true);
    expect((await fixture.financial.query('SELECT count(*)::int AS n FROM budget_gateway_bindings WHERE live_member_id=$1',[later.member])).rows[0]!.n).toBe(0);
    expect(JSON.parse(readFileSync(join(fixture.root,'native','control.json'),'utf8')).state).toBe('uncertain');
    await verifyFinancialContinuity(fixture.journal,fixture.financial as never);
  }finally{fixture.fake.setAfterCreateUser(async()=>undefined);}
},30_000);

it('refuses a full-roster readback when the retained owner membership changes during member addition',async()=>{
  const fixture=await startActiveOwnerFixture(),later=await addLaterAccount(fixture,'neutral-native-roster-change');
  await grantLaterAgentUse(fixture,later);
  fixture.fake.setAfterAddMember(()=>fixture.fake.changeMembership(fixture.ownerNativeUserId,{maxBudget:1}));
  try{
    const service=new BudgetNativeProvisioner(fixture.financial,fixture.journal,fixture.custody,fixture.fake.native,nativeTestTarget,policy);
    const callsBefore={...fixture.fake.calls};
    await expect(service.provision({bindingId:id(),credentialGeneration:'0',memberId:later.member,agent:later.agent,incarnation:fixture.incarnation,purposeAlias:'lares-brain'})).rejects.toThrow();
    expect(fixture.fake.calls.membership).toBe(callsBefore.membership+1);expect(fixture.fake.calls.key).toBe(callsBefore.key);
    expect(fixture.fake.rosterSnapshot().find(row=>row.userId===fixture.ownerNativeUserId)?.maxBudget).toBe(1);
    expect((await fixture.financial.query('SELECT count(*)::int AS n FROM budget_gateway_bindings WHERE live_member_id=$1',[later.member])).rows[0]!.n).toBe(0);
    expect(JSON.parse(readFileSync(join(fixture.root,'native','control.json'),'utf8')).state).toBe('uncertain');
    await verifyFinancialContinuity(fixture.journal,fixture.financial as never);
  }finally{fixture.fake.setAfterAddMember(()=>undefined);}
},30_000);

it('keeps an activation with an unknown SQL COMMIT non-dispatchable and never unblocks twice',async()=>{
  await resetDatabase();
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
  await resetDatabase();
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
  await resetDatabase();
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
  await resetDatabase();
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

it('keeps native runtime eligibility read-only across source, custody, journal, and role denials',async()=>{
  await resetDatabase();
  const owner=id(),secondOwner=id(),duplicateOwner=id(),creativeOwner=id(),missingOwner=id(),unknownOwner=id(),capOwner=id(),grantOwner=id(),grantee=id(),incarnation=id();
  const chief='neutral-runtime-chief',duplicateAgent='neutral-runtime-duplicate',creative='neutral-runtime-creative',missing='neutral-runtime-missing',unknown='neutral-runtime-unknown',capChief='neutral-runtime-cap',delegated='neutral-runtime-grant';
  const selected=await seed(owner,[chief],incarnation);
  await seed(creativeOwner,[creative],incarnation,selected.org,{[creative]:'creative'});
  await seed(secondOwner,[],incarnation,selected.org);
  await seed(duplicateOwner,[duplicateAgent],incarnation,selected.org);
  await seed(missingOwner,[missing],incarnation,selected.org,{[missing]:null});
  await seed(unknownOwner,[unknown],incarnation,selected.org,{[unknown]:'unadapted-role'});
  await seed(capOwner,[capChief],incarnation,selected.org);
  await seed(grantOwner,[delegated],incarnation,selected.org);
  await seed(grantee,[],incarnation,selected.org);
  const members=[owner,secondOwner,duplicateOwner,creativeOwner,missingOwner,unknownOwner,capOwner,grantOwner,grantee];
  const root=mkdtempSync(join(realpathSync(tmpdir()),'lares-native-runtime-authority-'));chmodSync(root,0o700);roots.push(root);
  const directory=join(root,'financial'),db=await pool.connect();try{await prepareFinancialCustody(directory,db,journalOptions);}finally{db.release();}
  const journal=HostFinancialJournal.openExisting(directory,{...journalOptions,requirePrepared:true});journals.push(journal);
  await provisionBudgetAccounts(pool,journal,{installationCap:'100',memberIds:members});
  let grantId=id();
  await pool.query(`INSERT INTO resource_grants(id,resource_kind,resource_id,principal_member_id,permission,grantor_member_id,issued_access_revision,expires_at)
    SELECT $1,'agent',$2,$3,'use',owner_member_id,revision,clock_timestamp()+interval '1 hour' FROM agent_access WHERE agent_name=$2`,[grantId,delegated,grantee]);
  const chiefGrantId=id();
  await pool.query(`INSERT INTO resource_grants(id,resource_kind,resource_id,principal_member_id,permission,grantor_member_id,issued_access_revision,expires_at)
    SELECT $1,'agent',$2,$3,'use',owner_member_id,revision,clock_timestamp()+interval '1 hour' FROM agent_access WHERE agent_name=$2`,[chiefGrantId,chief,secondOwner]);
  const custodyPath=join(root,'native'),custody=createNativeTestCustody(custodyPath),fake=nativeFake(),provisioner=new BudgetNativeProvisioner(pool,journal,custody,fake.native,nativeTestTarget,policy);
  const entries=[{member:owner,agent:chief},{member:creativeOwner,agent:creative},{member:missingOwner,agent:missing},{member:unknownOwner,agent:unknown},{member:capOwner,agent:capChief},{member:grantee,agent:delegated},{member:duplicateOwner,agent:duplicateAgent}];
  const bindings=new Map<string,string>();
  const emptyAuthority=createNativeRuntimeAuthority({custody,journal,pool:pool as never,reviewedPolicy:policy,designatedOwnerId:owner,gatewayOrigin:nativeTestTarget.origin,endpointHash:nativeTestTarget.hash});
  await expect(emptyAuthority.current({agent:chief,incarnation,definitionHash:'a'.repeat(64),purposeAlias:'lares-brain'})).resolves.toMatchObject({state:'held'});
  expect(JSON.parse(readFileSync(join(custodyPath,'control.json'),'utf8')).state).toBe('open');
  const readerFor=async(member:string,agent:string,selectedJournal=journal)=>{
    const inventory=await custody.withGate(gate=>Promise.resolve(gate.inventory()));
    const operation=inventory.operations.find((row):row is NativeOperation=>row.kind==='operation'&&row.association.agent===agent);
    if(!operation)throw new Error('Test operation unavailable');
    return {authority:createNativeRuntimeAuthority({custody,journal:selectedJournal,pool:pool as never,reviewedPolicy:policy,designatedOwnerId:member,gatewayOrigin:nativeTestTarget.origin,endpointHash:nativeTestTarget.hash}),
      identity:{...operation.association}};
  };
  try{
    for(const entry of entries){
      const binding=id();bindings.set(entry.agent,binding);
      await expect(provisioner.provision({bindingId:binding,credentialGeneration:'0',memberId:entry.member,agent:entry.agent,incarnation,purposeAlias:'lares-brain'})).resolves.toMatchObject({state:'bound-closed'});
    }
    const secondChiefBinding=id();
    await expect(provisioner.provision({bindingId:secondChiefBinding,credentialGeneration:'0',memberId:secondOwner,agent:chief,incarnation,purposeAlias:'lares-brain'})).resolves.toMatchObject({state:'bound-closed'});
    const chiefReader=await readerFor(owner,chief);
    await expect(chiefReader.authority.current(chiefReader.identity)).resolves.toEqual({state:'held',reason:'Native budget activation required'});
    expect(JSON.parse(readFileSync(join(custodyPath,'control.json'),'utf8')).state).toBe('open');
    const activator=new BudgetNativeActivator(pool,journal,custody,fake.native);
    await expect(activator.activate({bindingId:bindings.get(chief)!,credentialGeneration:'0'})).resolves.toMatchObject({state:'active'});
    await expect(chiefReader.authority.current(chiefReader.identity)).resolves.toEqual({state:'active'});
    for(const entry of entries.slice(1)){await expect(activator.activate({bindingId:bindings.get(entry.agent)!,credentialGeneration:'0'})).resolves.toMatchObject({state:'active'});}
    await expect(activator.activate({bindingId:secondChiefBinding,credentialGeneration:'0'})).resolves.toMatchObject({state:'active'});
    await expect(chiefReader.authority.current(chiefReader.identity)).resolves.toEqual({state:'active'});
    const duplicateReader=await readerFor(duplicateOwner,duplicateAgent);
    await expect(duplicateReader.authority.current(duplicateReader.identity)).resolves.toEqual({state:'active'});
    const duplicateBinding=bindings.get(duplicateAgent)!;
    const duplicateOperation=await custody.withGate(gate=>Promise.resolve(gate.inventory().operations.find((row):row is NativeOperation=>row.kind==='operation'&&row.bindingId===duplicateBinding)));
    expect(duplicateOperation).toBeDefined();
    await custody.withGate(gate=>{gate.prepareOperation({bindingId:id(),credentialGeneration:'0',userOwnershipId:duplicateOperation!.userOwnershipId,
      association:duplicateReader.identity,reviewedPolicy:policy},`sk-${'x'.repeat(43)}`);return Promise.resolve();});
    await expect(duplicateReader.authority.current(duplicateReader.identity)).resolves.toMatchObject({state:'held'});
    expect(JSON.parse(readFileSync(join(custodyPath,'control.json'),'utf8')).state).toBe('open');
    const changedEndpointReader=createNativeRuntimeAuthority({custody,journal,pool:pool as never,reviewedPolicy:policy,designatedOwnerId:owner,
      gatewayOrigin:nativeTestTarget.origin,endpointHash:'b'.repeat(64)});
    await expect(changedEndpointReader.current(chiefReader.identity)).resolves.toMatchObject({state:'held'});
    for(const entry of entries.slice(1,4)){
      const reader=await readerFor(entry.member,entry.agent);
      await expect(reader.authority.current(reader.identity)).resolves.toEqual({state:'held',reason:'Native budget activation required'});
    }

    await pool.query("UPDATE agent_definitions SET duties='stale source' WHERE name=$1",[chief]);
    await expect(chiefReader.authority.current(chiefReader.identity)).resolves.toMatchObject({state:'held'});
    await pool.query("UPDATE agent_definitions SET duties='' WHERE name=$1",[chief]);
    await expect(chiefReader.authority.current(chiefReader.identity)).resolves.toEqual({state:'active'});

    await pool.query('UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE id=$1',[grantId]);
    const delegatedReader=await readerFor(grantee,delegated);
    await expect(delegatedReader.authority.current(delegatedReader.identity)).resolves.toMatchObject({state:'held'});
    grantId=id();
    await pool.query(`INSERT INTO resource_grants(id,resource_kind,resource_id,principal_member_id,permission,grantor_member_id,issued_access_revision,expires_at)
      SELECT $1,'agent',$2,$3,'use',owner_member_id,revision,clock_timestamp()+interval '2 months' FROM agent_access WHERE agent_name=$2`,[grantId,delegated,grantee]);
    await expect(delegatedReader.authority.current(delegatedReader.identity)).resolves.toEqual({state:'active'});
    await pool.query('UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE id=$1',[grantId]);
    grantId=id();
    await pool.query(`INSERT INTO resource_grants(id,resource_kind,resource_id,principal_member_id,permission,grantor_member_id,issued_access_revision,expires_at)
      SELECT $1,'agent',$2,$3,'use',owner_member_id,revision,clock_timestamp()+interval '5 seconds' FROM agent_access WHERE agent_name=$2`,[grantId,delegated,grantee]);
    const originalPoolConnectDescriptor=Object.getOwnPropertyDescriptor(pool,'connect');
    const originalConnect=pool.connect.bind(pool) as (...args:any[])=>any;
    type WrappedClient={client:any;queryDescriptor:PropertyDescriptor|undefined;releaseDescriptor:PropertyDescriptor|undefined;originalQuery:any;originalRelease:any;
      restore:()=>void;restoredAtRelease:boolean};
    const wrappedClients:WrappedClient[]=[];
    const restoreProperty=(client:any,key:'query'|'release',descriptor:PropertyDescriptor|undefined):void=>{
      if(descriptor)Object.defineProperty(client,key,descriptor);else delete client[key];
    };
    const installCommitDelay=(client:any)=>{
      const entry:WrappedClient={client,queryDescriptor:Object.getOwnPropertyDescriptor(client,'query'),releaseDescriptor:Object.getOwnPropertyDescriptor(client,'release'),
        originalQuery:client.query,originalRelease:client.release,restore:()=>{},restoredAtRelease:false};
      let restored=false;
      entry.restore=()=>{if(restored)return;restored=true;restoreProperty(client,'query',entry.queryDescriptor);restoreProperty(client,'release',entry.releaseDescriptor);};
      const wrappedQuery=function(...args:any[]){
        const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
        const result=entry.originalQuery.apply(client,args);
        if(!/^COMMIT$/i.test(String(sql))||args.some(value=>typeof value==='function'))return result;
        return Promise.resolve(result).then(async acknowledged=>{
          commitsReached++;await entry.originalQuery.call(client,'SELECT pg_sleep(5.5)');
          expiredAtAcknowledgement=(await entry.originalQuery.call(client,'SELECT expires_at<=clock_timestamp() AS expired FROM resource_grants WHERE id=$1',[grantId])).rows[0]!.expired===true;
          return acknowledged;
        });
      };
      const wrappedRelease=function(...args:any[]){
        entry.restore();entry.restoredAtRelease=client.query===entry.originalQuery&&client.release===entry.originalRelease;
        return entry.originalRelease.apply(client,args);
      };
      Object.defineProperty(client,'query',{configurable:true,writable:true,value:wrappedQuery});
      Object.defineProperty(client,'release',{configurable:true,writable:true,value:wrappedRelease});
      wrappedClients.push(entry);return client;
    };
    let commitsReached=0;
    let expiredAtAcknowledgement=false;
    (pool as any).connect=(...args:any[])=>{
      const callbackIndex=args.findIndex(value=>typeof value==='function');
      if(callbackIndex>=0){const forwarded=[...args],callback=forwarded[callbackIndex];forwarded[callbackIndex]=(error:any,client:any,...rest:any[])=>callback(error,client?installCommitDelay(client):client,...rest);return originalConnect(...forwarded);}
      return Promise.resolve(originalConnect(...args)).then(installCommitDelay);
    };
    let expiryResult;
    try{expiryResult=await delegatedReader.authority.current(delegatedReader.identity);}finally{
      if(originalPoolConnectDescriptor)Object.defineProperty(pool,'connect',originalPoolConnectDescriptor);else delete (pool as any).connect;
      for(const entry of wrappedClients)entry.restore();
    }
    expect(commitsReached).toBe(1);
    expect(expiryResult).toMatchObject({state:'held'});
    expect(expiredAtAcknowledgement).toBe(true);
    expect(wrappedClients).toHaveLength(1);
    expect(wrappedClients[0]!.restoredAtRelease).toBe(true);
    expect(wrappedClients.every(entry=>entry.client.query===entry.originalQuery&&entry.client.release===entry.originalRelease)).toBe(true);
    const afterExpiryConnection=await pool.connect();
    try{await expect(afterExpiryConnection.query('SELECT 1 AS ok')).resolves.toMatchObject({rows:[{ok:1}]});}finally{afterExpiryConnection.release();}
    expect(JSON.parse(readFileSync(join(custodyPath,'control.json'),'utf8')).state).toBe('open');

    const capReader=await readerFor(capOwner,capChief);
    await expect(capReader.authority.current(capReader.identity)).resolves.toEqual({state:'active'});
    const policyUpdate=await pool.connect();try{await policyUpdate.query('UPDATE org_member_policy SET spend_cap_usd_month=24.99 WHERE user_id=$1',[capOwner]);}finally{policyUpdate.release();}
    await expect(capReader.authority.current(capReader.identity)).resolves.toMatchObject({state:'held'});
    expect(JSON.parse(readFileSync(join(custodyPath,'control.json'),'utf8')).state).toBe('open');
    await expect(chiefReader.authority.current(chiefReader.identity)).resolves.toEqual({state:'active'});

    let busyResult;
    await journal.operation('member-remove',async operationId=>{
      expect(journal.aborted(operationId,'not-started')).toBeDefined();
      busyResult=await chiefReader.authority.current(chiefReader.identity);
    });
    expect(busyResult).toMatchObject({state:'held'});
    await expect(chiefReader.authority.current(chiefReader.identity)).resolves.toEqual({state:'active'});

    const accountLookup=await pool.connect();let memberAccount:string;
    try{memberAccount=(await accountLookup.query("SELECT id FROM budget_accounts WHERE kind='member' AND live_member_id=$1",[owner])).rows[0]!.id;}finally{accountLookup.release();}
    const organisationWriter=await pool.connect(),monitor=await pool.connect();let restoreConnect:(()=>Promise<any>)|undefined;
    try{
      await organisationWriter.query('BEGIN');
      await organisationWriter.query("SELECT pg_advisory_xact_lock(hashtextextended('lares-console-source:' || $1,0))",[selected.org]);
      let readerPid:number|undefined;
      const connect=pool.connect.bind(pool);restoreConnect=connect;(pool as any).connect=async()=>{const client=await connect();await client.query("SET application_name='lares-runtime-authority-lock-reader'");readerPid=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);return client;};
      const read=chiefReader.authority.current(chiefReader.identity);
      let waiting=false,activity:unknown[]=[];
      for(let attempt=0;attempt<100&&!waiting;attempt++){
        activity=(await monitor.query("SELECT pid,application_name,state,wait_event_type,wait_event,left(query,160) AS query FROM pg_stat_activity WHERE pid=$1",[readerPid??-1])).rows;
        waiting=activity.some((row:any)=>Number(row.pid)===readerPid&&row.application_name==='lares-runtime-authority-lock-reader'&&row.wait_event_type==='Lock');
        if(!waiting)await new Promise(resolve=>setTimeout(resolve,20));
      }
      expect(waiting,JSON.stringify(activity)).toBe(true);
      await organisationWriter.query("SET LOCAL lock_timeout='300ms'");
      await expect(organisationWriter.query('SELECT id FROM budget_accounts WHERE id=$1 FOR UPDATE',[memberAccount])).resolves.toMatchObject({rowCount:1});
      await organisationWriter.query('COMMIT');
      await expect(read).resolves.toEqual({state:'active'});
    }finally{if(restoreConnect)(pool as any).connect=restoreConnect;try{await organisationWriter.query('ROLLBACK');}catch{}organisationWriter.release();monitor.release();}

    await expect(chiefReader.authority.current(chiefReader.identity)).resolves.toEqual({state:'active'});
    await journal.drainForShutdown();
    await expect(chiefReader.authority.current(chiefReader.identity)).resolves.toMatchObject({state:'held'});

    // A journal's writer marker is part of its custody. Exercise each transition on
    // the original directory with a clean close/reopen instead of copying live state.
    journal.close();
    const closedJournal=HostFinancialJournal.openExisting(directory,{...journalOptions,requirePrepared:true});journals.push(closedJournal);
    const closedReader=await readerFor(owner,chief,closedJournal);
    await expect(closedReader.authority.current(closedReader.identity)).resolves.toEqual({state:'active'});
    closedJournal.close();
    await expect(closedReader.authority.current(closedReader.identity)).resolves.toMatchObject({state:'held'});

    const frozenJournal=HostFinancialJournal.openExisting(directory,{...journalOptions,requirePrepared:true});journals.push(frozenJournal);
    const frozenReader=await readerFor(owner,chief,frozenJournal);
    await expect(frozenReader.authority.current(frozenReader.identity)).resolves.toEqual({state:'active'});
    frozenJournal.freeze();
    await expect(frozenReader.authority.current(frozenReader.identity)).resolves.toMatchObject({state:'held'});

  }finally{custody.close();}
},60_000);
