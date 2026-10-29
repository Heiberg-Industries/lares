import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createCipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import {Pool} from 'pg';
import {quiet} from './helpers/quiet-pool.js';
import {outsidePayloadHash} from '@lares/agent-kit/outside-execution-receipts';
import {provisionEngineDatabasePrivileges} from '../../box/lib/database-privileges.js';
import {PgAccountStore} from '@lares/agent-kit/account-store';

const grant=vi.hoisted(()=>({capture:undefined as unknown,edit:undefined as unknown}));
const http=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('@lares/agent-kit/grant-store',()=>({PgGrantStore:class{
  async captureOutsideUse(){return grant.capture;}
  async captureOutsideDescriptorEdit(){return grant.edit;}
  async captureUseWithExpiry(){return {accessRevision:7,validUntil:null};}
  async captureUse(){return grant.capture;}
}}));
vi.mock('undici',()=>({request:http.request,ProxyAgent:class{destroy(){return Promise.resolve();}},Client:class{}}));
import {OutsideCustodyStore} from '../lib/outside-custody.js';

const KEY=Buffer.alloc(32,31),owner='pending-apply-owner',other='pending-apply-other',org='pending-apply-org';
const token='P'.repeat(43),otherToken='O'.repeat(43),accountId='00000000-0000-4000-8000-000000000101';
const incarnation='00000000-0000-4000-8000-000000000104',admissionNonce='N'.repeat(43),sessionId='pending-apply-session';
let container:StartedPostgreSqlContainer,admin:Pool,app:Pool,custody:Pool,store:OutsideCustodyStore;
let failAppliedRoute=false,appliedRouteAttempts=0;
const appPassword=Buffer.from('pending-apply-app-role-disposable');
const custodyPassword=Buffer.from('pending-apply-custody-role-disposable');
const financialPassword=Buffer.from('pending-apply-financial-role-disposable');
const capture={version:1 as const,actor:{memberId:owner,organisationId:org,role:'owner' as const},
  agent:{name:'worker',ownerMemberId:owner,accessRevision:7,definitionHash:'a'.repeat(64)},ownerPolicy:{kind:'unrestricted' as const},
  outside:{scope:'read' as const,autonomy:'gated' as const,connection:{name:'connector',url:'https://example.test/mcp',auth:'bearer' as const,
    allow:['lookup'],read:['lookup'],trusted:false}},grant:{kind:'owner' as const,validUntil:null}};
const editorCapture={version:1,actor:{memberId:owner,organisationId:org,role:'owner'},
  agent:{name:'worker',ownerMemberId:owner,accessRevision:7,definitionHash:'a'.repeat(64),connectionName:'connector'},grant:{kind:'owner',validUntil:null}};
const route={policyHash:'d'.repeat(64),sourceAddress:'198.51.100.10',proxyUrl:'http://lares-egress-proxy:8888/'};
const profile={version:2,protocolVersion:'2025-06-18',parser:'strict-json-sse-v1',operationTimeoutMs:8000,transportTimeoutMs:5000,
  connectTimeoutMs:1000,idleTimeoutMs:2000,cleanupReserveMs:1000,responseBytes:65536,totalResponseBytes:262144,headerBytes:8192,
  resultBytes:65536,maxPages:10,maxPosts:12,maxCursorBytes:1024,maxJsonDepth:16,maxTools:256,maxToolNameBytes:128,
  maxRequestBytes:16384,maxSessionIdBytes:1024,maxCredentialBytes:4096};
function canonical(value:unknown):string{
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
type MacCoordinates={accountId:string;ownerMemberId:string;resourceId:string;connectionName:string};
const defaultCoordinates:MacCoordinates={accountId,ownerMemberId:owner,resourceId:'worker',connectionName:'connector'};
function sealEvidence(body:unknown,operationId:string,kind:'activation-review-v1'|'descriptor-publication-v1'|'descriptor-acceptance-v1',hash:string,coordinates=defaultCoordinates){
  const aad=Buffer.from(canonical(['lares-outside-custody-evidence-v1',{...coordinates,operationId,kind,hash}]));
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',KEY,nonce);cipher.setAAD(aad);
  const plaintext=Buffer.from(canonical(body));
  return {nonce,ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()])};
}
function sealBound(plaintext:Buffer,input:{generation:number;revision:number;consent:number;operationId:string;purpose:'discovery'|'executable';policyHash:string},coordinates=defaultCoordinates){
  const aad=Buffer.from(JSON.stringify(['lares-outside-custody-v1',coordinates.ownerMemberId,coordinates.accountId,coordinates.resourceId,input.generation,input.revision,input.consent,input.operationId]));
  const bound=Buffer.from(JSON.stringify(['lares-outside-custody-bound-v1',aad.toString('utf8'),coordinates.connectionName,input.purpose,input.policyHash]));
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',KEY,nonce);cipher.setAAD(bound);
  return {nonce,ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()])};
}
function sealDiscovery(plaintext:Buffer,coordinates:{requestId:string;claimOperationId:string;resultOperationId:string;generation:number;revision:number;
  consent:number;policyHash:string}){
  const aad=Buffer.from(canonical(['lares-outside-discovery-result-v1',{ownerMemberId:owner,accountId,agentName:'worker',connectionName:'connector',
    requestId:coordinates.requestId,claimOperationId:coordinates.claimOperationId,resultOperationId:coordinates.resultOperationId,
    generation:coordinates.generation,credentialRevision:coordinates.revision,consentGeneration:coordinates.consent,policyHash:coordinates.policyHash}]));
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',KEY,nonce);cipher.setAAD(aad);
  return {nonce,ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()])};
}
const document={protocolVersion:'2025-06-18',serverInfo:{name:'fixture',version:'1'},tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}]};
const projection={version:1,connectionName:'connector',scope:'read',allow:['lookup'],read:['lookup'],tools:document.tools};
const publicationId='00000000-0000-4000-8000-000000000105',acceptanceId='00000000-0000-4000-8000-000000000106';
const sourceRequestId='00000000-0000-4000-8000-000000000107',sourceClaimId='00000000-0000-4000-8000-000000000108';
const activeOperationId='00000000-0000-4000-8000-000000000109',sourceResultId='00000000-0000-4000-8000-000000000110';
const reviewRoute={policyHash:'d'.repeat(64),sourceAddress:'198.51.100.10',proxyUrl:'http://lares-egress-proxy:8888/'};
const useCapture={version:1,actor:{memberId:owner,organisationId:org,role:'owner'},agent:{name:'worker',ownerMemberId:owner,
  accessRevision:7,definitionHash:'a'.repeat(64)},ownerPolicy:{kind:'unrestricted'},outside:{scope:'read',autonomy:'gated',connection:{name:'connector',
    url:'https://example.test/mcp',auth:'bearer',allow:['lookup'],read:['lookup'],trusted:false}},grant:{kind:'owner',validUntil:null}};
const discoveryPolicy={version:profile.version,profile,purpose:'streamable-http-discovery-v1',ownerMemberId:owner,accountId,agentName:'worker',
  connectionName:'connector',endpoint:capture.outside.connection.url,capture,route:reviewRoute};
const discoveryPolicyHash=createHash('sha256').update(canonical(discoveryPolicy)).digest('hex');
const publicationHash=createHash('sha256').update(canonical(projection)).digest('hex');
const publicationBody={version:1,organisationId:org,actorMemberId:owner,publicationHash,
  source:{requestId:sourceRequestId,claimOperationId:sourceClaimId,revision:2,consentGeneration:2,policyHash:discoveryPolicyHash},
  definition:{hash:'a'.repeat(64),accessRevision:7},capture,projection};
const acceptanceBody={version:1,organisationId:org,editorMemberId:owner,publicationId,publicationHash,resourceId:'worker',
  connectionName:'connector',definitionHash:'a'.repeat(64),accessRevision:7,grant:editorCapture.grant};
const acceptanceHash=createHash('sha256').update(canonical(acceptanceBody)).digest('hex');
const policyJson={version:1,purpose:'outside-executable-v1',ownerMemberId:owner,accountId,resourceId:'worker',connectionName:'connector',
  capture:useCapture,route:reviewRoute,publication:{id:publicationId,hash:publicationHash,
    descriptorDigest:publicationHash,acceptedScope:{scope:'read',allow:['lookup'],read:['lookup']}},
  acceptance:{id:acceptanceId,hash:acceptanceHash,editorMemberId:owner}};
const policyHash=createHash('sha256').update(canonical(policyJson)).digest('hex');
const publicationEvidenceHash=createHash('sha256').update(canonical(publicationBody)).digest('hex');
let selectors:{accountId:string;agentName:string;connectionName:string;requestId:string;claimOperationId:string;publicationId:string;acceptanceId:string;
  expectedGeneration:number;expectedCandidateRevision:number|null;expectedConsentGeneration:number;expectedDefinitionHash:string;expectedAccessRevision:number;
  expectedPublicationHash:string;expectedAcceptanceHash:string};
let activation:{reviewId:string;reviewHash:string;policyHash:string};
let staged:{operationId:string;credentialRevision:number};
const deadline=()=>({deadlineAtMs:Date.now()+10000});
async function seedMacDescriptor():Promise<{fingerprint:string;projection:Record<string,unknown>;ownerAccountId:string}>{
  const connectionName='mac-private-metadata',ownerAccountId=randomUUID(),publicationId=randomUUID(),acceptanceId=randomUUID(),operationId=randomUUID();
  const coordinates={accountId:ownerAccountId,ownerMemberId:owner,resourceId:'worker',connectionName};
  const macCapture={...structuredClone(capture),outside:{...capture.outside,connection:{...capture.outside.connection,name:connectionName}}};
  const projection={version:1,connectionName,scope:'read',allow:['lookup'],read:['lookup'],tools:document.tools};
  const fingerprint=createHash('sha256').update(canonical(projection)).digest('hex');
  const publicationBody={version:1,organisationId:org,actorMemberId:owner,publicationHash:fingerprint,
    source:{requestId:randomUUID(),claimOperationId:randomUUID(),revision:1,consentGeneration:1,policyHash:'d'.repeat(64)},
    definition:{hash:'a'.repeat(64),accessRevision:7},capture:macCapture,projection};
  const acceptanceBody={version:1,organisationId:org,editorMemberId:owner,publicationId,publicationHash:fingerprint,
    resourceId:'worker',connectionName,definitionHash:'a'.repeat(64),accessRevision:7,grant:{kind:'owner',validUntil:null}};
  const publicationEvidenceHash=createHash('sha256').update(canonical(publicationBody)).digest('hex');
  const acceptanceHash=createHash('sha256').update(canonical(acceptanceBody)).digest('hex');
  const policy={version:1,purpose:'outside-executable-v1',ownerMemberId:owner,accountId:ownerAccountId,resourceId:'worker',connectionName,
    capture:macCapture,route:reviewRoute,publication:{id:publicationId,hash:fingerprint,descriptorDigest:fingerprint,
      acceptedScope:{scope:'read',allow:['lookup'],read:['lookup']}},acceptance:{id:acceptanceId,hash:acceptanceHash,editorMemberId:owner}};
  const policyHash=createHash('sha256').update(canonical(policy)).digest('hex');
  const encrypted=sealBound(Buffer.from('owner-config-secret'),{generation:1,revision:1,consent:1,operationId,purpose:'executable',policyHash},coordinates);
  await admin.query(`INSERT INTO outside_custody_accounts(account_id,owner_member_id,resource_id,connection_name,generation,active_revision,
    candidate_revision,consent_generation,state) VALUES($1,$2,'worker',$3,1,1,NULL,1,'active')`,[ownerAccountId,owner,connectionName]);
  await admin.query(`INSERT INTO outside_custody_revisions(account_id,owner_member_id,credential_revision,generation,consent_generation,
    revision_purpose,policy_json,policy_hash,operation_id,nonce,ciphertext) VALUES($1,$2,1,1,1,'executable',$3::jsonb,$4,$5,$6,$7)`,
    [ownerAccountId,owner,canonical(policy),Buffer.from(policyHash,'hex'),operationId,encrypted.nonce,encrypted.ciphertext]);
  for(const [id,kind,body,digest,outcome] of [[publicationId,'descriptor-publication-v1',publicationBody,publicationEvidenceHash,'published'],
      [acceptanceId,'descriptor-acceptance-v1',acceptanceBody,acceptanceHash,'accepted']] as const){
    const evidence=sealEvidence(body,id,kind,digest,coordinates);
    await admin.query(`INSERT INTO outside_custody_operations(operation_id,account_id,owner_member_id,actor_member_id,operation_kind,event_phase,
      request_hash,expected_generation,result_generation,outcome,result_nonce,result_ciphertext,evidence_kind,evidence_hash)
      VALUES($1,$2,$3,$3,$4,'operation',$5,1,1,$6,$7,$8,$9,$10)`,
      [id,ownerAccountId,owner,kind==='descriptor-publication-v1'?'publish':'accept',Buffer.alloc(32,4),outcome,evidence.nonce,evidence.ciphertext,kind,Buffer.from(digest,'hex')]);
  }
  return {fingerprint,projection,ownerAccountId};
}
function previewBody(){return {version:1,accountId,ownerMemberId:owner,resourceId:'worker',connectionName:'connector',expectedGeneration:1,
  expectedCandidateRevision:null,sourceRevision:2,sourceRequestId,sourceClaimOperationId:sourceClaimId,publicationId,publicationHash,
  acceptanceId,acceptanceHash,policyHash:activation.policyHash,capture:editorCapture,route:reviewRoute,consentGeneration:3};}
async function setupFixture(){
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  admin=quiet(new Pool({connectionString:container.getConnectionUri()}));
  const repo=new URL('../../..',import.meta.url).pathname;
  const sqlDir=`${repo}/services/box/sql`;
  const names=(await import('node:fs/promises')).readdir(sqlDir);
  for(const name of (await names).filter((file:string)=>/^\d+.*\.sql$/.test(file)).sort((a:string,b:string)=>Number(a.match(/^\d+/)![0])-Number(b.match(/^\d+/)![0])||a.localeCompare(b)))
    await admin.query(await (await import('node:fs/promises')).readFile(`${sqlDir}/${name}`,'utf8'));
  const setup=await admin.connect();
  try{await provisionEngineDatabasePrivileges(setup,{expectedDatabase:container.getDatabase(),passwords:{application:appPassword,financial:financialPassword,outsideCustody:custodyPassword}});}
  finally{setup.release();}
  const appUrl=new URL(container.getConnectionUri());appUrl.username='lares_app';appUrl.password=appPassword.toString();
  app=quiet(new Pool({connectionString:appUrl.toString()}));
  const custodyUrl=new URL(container.getConnectionUri());custodyUrl.username='lares_outside_custody';custodyUrl.password=custodyPassword.toString();
  custody=quiet(new Pool({connectionString:custodyUrl.toString()}));
  await admin.query('INSERT INTO orgs(id,display_name) VALUES($1,\'fixture\')',[org]);
  await admin.query(`INSERT INTO users(id,display_name,org_id,org_role,status,automation_mode)
    VALUES($1,'owner',$3,'owner','active','draft-and-ask'),($2,'other',$3,'member','active','draft-and-ask')`,[owner,other,org]);
  for(const [member,raw] of [[owner,token],[other,otherToken]] as const)
    await admin.query('INSERT INTO member_sessions(id,member_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\')',
      [member,member,createHash('sha256').update(raw).digest('hex')]);
  await admin.query(`INSERT INTO agent_definitions(name,definition,hash,status) VALUES('worker','{}'::jsonb,$1,'valid')`,['a'.repeat(64)]);
  await admin.query(`INSERT INTO agent_access(agent_name,owner_member_id,organisation_id,revision) VALUES('worker',$1,$2,7)`,[owner,org]);
  await admin.query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,applied_definition,pending)
    VALUES('worker','127.0.0.1'::inet,'fixture','owned',$1,$1,'ready','{}'::jsonb,false)`,[incarnation]);
  await admin.query(`INSERT INTO console_session_bindings(agent,incarnation,session_id,admission_nonce,place_id,member_id,
      agent_access_revision,private_surface_revision,source_history_guard_revision,policy_revision)
    VALUES('worker',$1,$2,$3,'fixture',$4,7,2,1,2)`,[incarnation,sessionId,admissionNonce,owner]);
  await admin.query(`INSERT INTO outside_custody_accounts(account_id,owner_member_id,resource_id,connection_name,generation,active_revision,candidate_revision,consent_generation,state)
    VALUES($1,$2,'worker','connector',1,1,NULL,2,'active')`,[accountId,owner]);
  const active=sealBound(Buffer.from('working-token'),{generation:1,revision:1,consent:1,operationId:activeOperationId,purpose:'executable',policyHash});
  const source=sealBound(Buffer.from('working-token'),{generation:1,revision:2,consent:2,operationId:sourceClaimId,purpose:'discovery',policyHash:discoveryPolicyHash});
  const sourceResult=sealDiscovery(Buffer.from(canonical(document)),{requestId:sourceRequestId,claimOperationId:sourceClaimId,resultOperationId:sourceResultId,
    generation:1,revision:2,consent:2,policyHash:discoveryPolicyHash});
  await admin.query(`INSERT INTO outside_custody_revisions(account_id,owner_member_id,credential_revision,generation,consent_generation,
    revision_purpose,policy_json,policy_hash,operation_id,nonce,ciphertext)
    VALUES($1,$2,1,1,1,'executable',$3::jsonb,$4,$5,$6,$7),($1,$2,2,1,2,'discovery',$8::jsonb,$9,$10,$11,$12)`,
    [accountId,owner,canonical(policyJson),Buffer.from(policyHash,'hex'),activeOperationId,active.nonce,active.ciphertext,
      canonical(discoveryPolicy),Buffer.from(discoveryPolicyHash,'hex'),sourceClaimId,source.nonce,source.ciphertext]);
  const sourceRequestHash=Buffer.alloc(32,4);
  await admin.query(`INSERT INTO outside_custody_operations(operation_id,account_id,owner_member_id,operation_kind,event_phase,request_id,
      request_hash,expected_generation,result_generation,credential_revision,outcome)
    VALUES($1,$2,$3,'discover','claim',$4,$5,0,1,2,'claimed')`,[sourceClaimId,accountId,owner,sourceRequestId,sourceRequestHash]);
  await admin.query(`INSERT INTO outside_custody_operations(operation_id,account_id,owner_member_id,operation_kind,event_phase,request_id,
      request_hash,expected_generation,result_generation,credential_revision,outcome,result_nonce,result_ciphertext)
    VALUES($1,$2,$3,'discover','result',$4,$5,0,1,2,'completed',$6,$7)`,
    [sourceResultId,accountId,owner,sourceRequestId,sourceRequestHash,sourceResult.nonce,sourceResult.ciphertext]);
  const publication=sealEvidence(publicationBody,publicationId,'descriptor-publication-v1',publicationEvidenceHash);
  const acceptance=sealEvidence(acceptanceBody,acceptanceId,'descriptor-acceptance-v1',acceptanceHash);
  await admin.query(`INSERT INTO outside_custody_operations(operation_id,account_id,owner_member_id,actor_member_id,operation_kind,
      event_phase,request_hash,expected_generation,result_generation,credential_revision,outcome,result_nonce,result_ciphertext,evidence_kind,evidence_hash)
    VALUES($1,$2,$3,$3,'publish','operation',$4,1,1,2,'published',$5,$6,'descriptor-publication-v1',$7),
      ($8,$2,$3,$3,'accept','operation',$9,1,1,NULL,'accepted',$10,$11,'descriptor-acceptance-v1',$12)`,
    [publicationId,accountId,owner,Buffer.alloc(32,5),publication.nonce,publication.ciphertext,Buffer.from(publicationEvidenceHash,'hex'),
      acceptanceId,Buffer.alloc(32,6),acceptance.nonce,acceptance.ciphertext,Buffer.from(acceptanceHash,'hex')]);
  grant.capture=capture;
  grant.edit=editorCapture;
  const lifecycle={reviewOutsideRoute:async()=>reviewRoute,withAppliedOutsideRoute:async(_endpoint:string,_hash:string,_deadline:number,
    work:(lease:{assertCurrent:()=>Promise<typeof reviewRoute>})=>Promise<unknown>)=>{
      appliedRouteAttempts++;
      const result=await work({assertCurrent:async()=>reviewRoute});
      if(failAppliedRoute)throw new Error('fixture route activation failed before transaction commit');
      return result;
    }};
  store=new OutsideCustodyStore(custody as never,KEY,{mainPool:app as never,lifecycle:lifecycle as never});
  selectors={accountId,agentName:'worker',connectionName:'connector',requestId:sourceRequestId,claimOperationId:sourceClaimId,publicationId,acceptanceId,
    expectedGeneration:1,expectedCandidateRevision:null,expectedConsentGeneration:3,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:7,
    expectedPublicationHash:publicationHash,expectedAcceptanceHash:acceptanceHash};
  try{activation=await store.previewExecutableActivation(token,{...selectors,operationId:randomUUID()},deadline());}
  catch{throw new Error('disposable fixture failed during real activation preview');}
  let stageResult;
  try{stageResult=await store.stage(token,{...selectors,operationId:randomUUID(),expectedPolicyHash:activation.policyHash,
    activationReviewId:activation.reviewId,expectedActivationReviewHash:activation.reviewHash},deadline());}
  catch{throw new Error('disposable fixture failed during real stage');}
  staged={operationId:stageResult.operationId,credentialRevision:stageResult.credentialRevision!};
  appliedRouteAttempts=0;
}
beforeEach(async()=>{failAppliedRoute=false;appliedRouteAttempts=0;await setupFixture();},120_000);
afterEach(async()=>{store?.close();await custody?.end();await app?.end();await admin?.end();await container?.stop();});

it('recovers the original exact preview from real encrypted stage evidence under the restricted custody role',async()=>{
  const projection=await store.inspectHumanPendingApply(token,{agentName:'worker',connectionName:'connector'},deadline());
  expect(projection.activationReviewId).toBe(activation.reviewId);
  expect(projection.candidateRevision).toBe(staged.credentialRevision);
  expect(JSON.stringify(projection)).not.toMatch(/ciphertext|credential|private-token|policyJson/i);
  expect((await custody.query('SELECT current_user')).rows[0]?.current_user).toBe('lares_outside_custody');
  expect((await app.query('SELECT current_user')).rows[0]?.current_user).toBe('lares_app');
});

it('refuses the same candidate from a different custodian session',async()=>{
  await expect(store.inspectHumanPendingApply(otherToken,{agentName:'worker',connectionName:'connector'},deadline())).rejects.toThrow();
});

it('refuses current access or candidate revision changes before returning recovered selectors',async()=>{
  grant.capture={...capture,agent:{...capture.agent,accessRevision:8}};
  await expect(store.inspectHumanPendingApply(token,{agentName:'worker',connectionName:'connector'},deadline())).rejects.toThrow();
  grant.capture=capture;
  await admin.query('UPDATE outside_custody_accounts SET candidate_revision=$2 WHERE account_id=$1',[accountId,staged.credentialRevision+1]);
  await expect(store.inspectHumanPendingApply(token,{agentName:'worker',connectionName:'connector'},deadline())).rejects.toThrow();
  await admin.query('UPDATE outside_custody_accounts SET candidate_revision=$2 WHERE account_id=$1',[accountId,staged.credentialRevision]);
});

it('selects the stage-bound preview among equivalent preview bodies and refuses missing or mismatched evidence',async()=>{
  const anotherId=randomUUID(),preview=sealEvidence(await previewBody(),anotherId,'activation-review-v1',activation.reviewHash);
  await admin.query(`INSERT INTO outside_custody_operations(operation_id,account_id,owner_member_id,actor_member_id,operation_kind,event_phase,
      request_hash,expected_generation,result_generation,outcome,result_nonce,result_ciphertext,evidence_kind,evidence_hash)
    VALUES($1,$2,$3,$3,'activation-preview','operation',$4,1,1,'previewed',$5,$6,'activation-review-v1',$7)`,
    [anotherId,accountId,owner,Buffer.alloc(32,8),preview.nonce,preview.ciphertext,Buffer.from(activation.reviewHash,'hex')]);
  await expect(store.inspectHumanPendingApply(token,{agentName:'worker',connectionName:'connector'},deadline())).resolves.toMatchObject({activationReviewId:activation.reviewId});
  const saved=await admin.query('SELECT * FROM outside_custody_operations WHERE operation_id=$1',[activation.reviewId]);
  await admin.query('DELETE FROM outside_custody_operations WHERE operation_id=$1',[activation.reviewId]);
  await expect(store.inspectHumanPendingApply(token,{agentName:'worker',connectionName:'connector'},deadline())).rejects.toThrow();
  const row=saved.rows[0]!;
  await admin.query(`INSERT INTO outside_custody_operations(operation_id,account_id,owner_member_id,actor_member_id,operation_kind,event_phase,
    request_hash,expected_generation,result_generation,credential_revision,outcome,result_nonce,result_ciphertext,evidence_kind,evidence_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[row.operation_id,row.account_id,row.owner_member_id,row.actor_member_id,
    row.operation_kind,row.event_phase,row.request_hash,row.expected_generation,row.result_generation,row.credential_revision,row.outcome,
    row.result_nonce,row.result_ciphertext,row.evidence_kind,row.evidence_hash]);
});

it('preserves active custody when a valid Apply fails before commit',async()=>{
  const recovered=await store.inspectHumanPendingApply(token,{agentName:'worker',connectionName:'connector'},deadline());
  const {activationReviewHash,...selectors}=recovered;
  const applyInput={...selectors,operationId:randomUUID(),expectedActivationReviewHash:activationReviewHash};
  const before=(await admin.query(`SELECT generation::text,active_revision::text,candidate_revision::text,consent_generation::text
    FROM outside_custody_accounts WHERE account_id=$1`,[accountId])).rows[0];
  const activeCipher=(await admin.query('SELECT nonce,ciphertext FROM outside_custody_revisions WHERE account_id=$1 AND credential_revision=1',[accountId])).rows[0];
  failAppliedRoute=true;
  await expect(store.apply(token,applyInput,{deadlineAtMs:Date.now()+10000})).rejects.toThrow();
  expect(appliedRouteAttempts).toBe(1);
  const after=(await admin.query(`SELECT generation::text,active_revision::text,candidate_revision::text,consent_generation::text
    FROM outside_custody_accounts WHERE account_id=$1`,[accountId])).rows[0];
  expect(after).toEqual(before);
  const activeCipherAfter=(await admin.query('SELECT nonce,ciphertext FROM outside_custody_revisions WHERE account_id=$1 AND credential_revision=1',[accountId])).rows[0];
  expect(activeCipherAfter?.nonce.equals(activeCipher?.nonce)).toBe(true);
  expect(activeCipherAfter?.ciphertext.equals(activeCipher?.ciphertext)).toBe(true);
  expect((await admin.query('SELECT 1 FROM outside_custody_operations WHERE operation_id=$1',[applyInput.operationId])).rowCount).toBe(0);
});

it('activates a valid credential revision on its first real Store Apply',async()=>{
  const recovered=await store.inspectHumanPendingApply(token,{agentName:'worker',connectionName:'connector'},deadline());
  const {activationReviewHash,...selectors}=recovered;
  const result=await store.apply(token,{...selectors,operationId:randomUUID(),expectedActivationReviewHash:activationReviewHash},deadline());
  expect(appliedRouteAttempts).toBe(1);
  expect(result).toMatchObject({outcome:'applied',credentialRevision:staged.credentialRevision});
  const head=(await admin.query(`SELECT generation::text,active_revision::text,candidate_revision::text,consent_generation::text
    FROM outside_custody_accounts WHERE account_id=$1`,[accountId])).rows[0];
  expect(head).toMatchObject({generation:'2',active_revision:String(staged.credentialRevision),candidate_revision:null,consent_generation:'3'});
});

it('uses the old active revision before rotation and refuses an unconsumed old execution afterward',async()=>{
  const binding={agent:'worker',incarnation,sessionId,memberId:owner,approverMemberId:owner,admissionNonce,policyRevision:2};
  const callBefore={callId:randomUUID(),connectionName:'connector',toolName:'lookup',input:{query:'before-rotation'}};
  const callAfter={callId:randomUUID(),connectionName:'connector',toolName:'lookup',input:{query:'after-rotation'}};
  const insertApproval=async(call:typeof callBefore,requestId:string)=>admin.query(`INSERT INTO outside_execution_approvals(call_id,request_id,session_id,member_id,
    approver_member_id,agent,incarnation,definition_hash,connection_name,account_id,credential_revision,tool_name,payload_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,clock_timestamp()+interval '1 minute')`,[call.callId,requestId,sessionId,
    owner,owner,'worker',incarnation,Buffer.from('a'.repeat(64),'hex'),'connector',accountId,'lookup',Buffer.from(outsidePayloadHash('lookup',call.input),'hex')]);
  await insertApproval(callBefore,randomUUID());await insertApproval(callAfter,randomUUID());
  http.request.mockImplementation(async(_url:string,options:{body:Buffer})=>{
    const message=JSON.parse(options.body.toString());
    const result=message.method==='initialize'?{protocolVersion:'2025-06-18',serverInfo:{name:'Fixture',version:'1'}}:{content:[{type:'text',text:'Fixture result'}]};
    return {statusCode:message.id===undefined?202:200,headers:{'content-type':'application/json','mcp-session-id':'fixture-session'},
      body:Readable.from(message.id===undefined?[]:[Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))])};
  });
  try{
    const dispatched=await store.dispatchApproved(binding,callBefore,{deadlineAtMs:Date.now()+10000});
    expect(dispatched).toMatchObject({content:[{text:'Fixture result'}]});
    expect(http.request).toHaveBeenCalledTimes(3);
    const recovered=await store.inspectHumanPendingApply(token,{agentName:'worker',connectionName:'connector'},deadline());
    const {activationReviewHash,...selectors}=recovered;
    const rotation=await store.apply(token,{...selectors,operationId:randomUUID(),expectedActivationReviewHash:activationReviewHash},deadline());
    expect(rotation).toMatchObject({outcome:'applied',credentialRevision:staged.credentialRevision});
    expect((await admin.query('SELECT active_revision::text FROM outside_custody_accounts WHERE account_id=$1',[accountId])).rows[0])
      .toEqual({active_revision:String(staged.credentialRevision)});
    await expect(store.dispatchApproved(binding,callAfter,{deadlineAtMs:Date.now()+10000})).rejects.toThrow();
    expect(http.request).toHaveBeenCalledTimes(3);
  }finally{http.request.mockReset();}
});

it('enrolls two members into separate datasets and dispatches only their own exact-approved lookup credential',async()=>{
  const descriptor=await seedMacDescriptor(),connectionName='mac-private-metadata',definitionHash='a'.repeat(64);
  const third='pending-apply-third',thirdToken='T'.repeat(43),thirdSession='pending-apply-third-session';
  const macNonces=new Map<string,string>();
  await admin.query(`INSERT INTO users(id,display_name,org_id,org_role,status,automation_mode) VALUES($1,'third',$2,'member','active','draft-and-ask')`,[third,org]);
  await admin.query(`INSERT INTO member_sessions(id,member_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,
    [third,third,createHash('sha256').update(thirdToken).digest('hex')]);
  for(const [member,memberSession] of [[other,`pending-apply-${other}-session`],[third,thirdSession]] as const){
    const macNonce=randomBytes(32).toString('base64url');macNonces.set(member,macNonce);
    await admin.query(`INSERT INTO console_session_bindings(agent,incarnation,session_id,admission_nonce,place_id,member_id,
      agent_access_revision,private_surface_revision,source_history_guard_revision,policy_revision)
      VALUES('worker',$1,$2,$3,'fixture',$4,7,2,1,2)`,[incarnation,memberSession,macNonce,member]);
  }
  const adapter={connectorId:'lares-private-metadata-v1',verifyAccount:async()=>({issuer:'lares-private-metadata-v1',subject:randomUUID(),label:'Private dataset'}),
    verifyResource:async()=>({resourceKind:'dataset',externalId:randomUUID(),providerLabel:'Private metadata dataset'})};
  const accountRepo=new PgAccountStore(app as never),accountStore=accountRepo.forTrustedAdapter(adapter);
  const ownerDataset=await accountStore.createPersonalAccount(owner,null,undefined,[null]);
  const ownerResources=await accountRepo.listResources(owner,ownerDataset.id,ownerDataset.generation);
  const members=[{id:owner,token,session:sessionId},{id:other,token:otherToken,session:`pending-apply-${other}-session`},{id:third,token:thirdToken,session:thirdSession}];
  const datasets=new Map<string,{accountId:string;resourceId:string;datasetId:string;uploadToken:string;deviceId:string;generation:number}>();
  const ownerMacCapture={...structuredClone(capture),outside:{...capture.outside,connection:{...capture.outside.connection,name:connectionName}}};
  grant.capture=ownerMacCapture;
  const ownerBinding={agent:'worker',incarnation,sessionId,memberId:owner,approverMemberId:owner,admissionNonce,policyRevision:2};
  await expect(store.acceptedRuntimeTools(ownerBinding,definitionHash,connectionName,deadline())).rejects.toThrow();
  expect(http.request).not.toHaveBeenCalled();
  for(const member of members){
    const account=member.id===owner?ownerDataset:await accountStore.createPersonalAccount(member.id,null,undefined,[null]);
    const resources=member.id===owner?ownerResources:await accountRepo.listResources(member.id,account.id,account.generation);
    expect(resources).toHaveLength(1);
    const memberCapture=member.id===owner?ownerMacCapture:{...structuredClone(capture),actor:{...capture.actor,memberId:member.id,role:'member'},
      outside:{...capture.outside,connection:{...capture.outside.connection,name:connectionName}},
      grant:{kind:'grant',id:`grant-${member.id}`,principal:{kind:'member',id:member.id},permission:'use',validUntil:null}};
    grant.capture=memberCapture;
    if(member.id===owner){
      const ownerBinding={agent:'worker',incarnation,sessionId,memberId:owner,approverMemberId:owner,admissionNonce,policyRevision:2};
      await expect(store.acceptedRuntimeTools(ownerBinding,definitionHash,connectionName,deadline())).rejects.toThrow();
      expect(await store.privateMetadataDeviceStatus(member.token,{agentName:'worker'},deadline())).toBeNull();
    }
    if(member.id===other){
      await expect(store.enrollPrivateMetadataDevice(member.token,{accountId:ownerDataset.id,resourceBindingId:ownerResources[0]!.id,
        agentName:'worker',connectionName,expectedDescriptorFingerprint:descriptor.fingerprint},deadline())).rejects.toThrow();
      expect((await custody.query(`SELECT account_id FROM outside_custody_accounts WHERE owner_member_id=$1 AND resource_id='worker'
        AND connection_name='mac-private-metadata-device' AND state='active'`,[member.id])).rows).toEqual([]);
      await expect(store.enrollPrivateMetadataDevice(member.token,{accountId:account.id,resourceBindingId:resources[0]!.id,
        agentName:'worker',connectionName,expectedDescriptorFingerprint:'f'.repeat(64)},deadline())).rejects.toThrow();
      expect((await custody.query(`SELECT account_id FROM outside_custody_accounts WHERE owner_member_id=$1 AND resource_id='worker'
        AND connection_name='mac-private-metadata-device' AND state='active'`,[member.id])).rows).toEqual([]);
    }
    const enrollment=await store.enrollPrivateMetadataDevice(member.token,{accountId:account.id,resourceBindingId:resources[0]!.id,
      agentName:'worker',connectionName,expectedDescriptorFingerprint:descriptor.fingerprint},deadline());
    const status=await store.privateMetadataDeviceStatus(member.token,{agentName:'worker'},deadline());
    expect(status).toMatchObject({accountId:account.id,resourceBindingId:resources[0]!.id,datasetId:resources[0]!.externalId,
      deviceId:enrollment.deviceId,state:'active'});
    expect(enrollment.uploadToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(enrollment)).not.toContain('readToken');
    datasets.set(member.id,{accountId:account.id,resourceId:resources[0]!.id,datasetId:resources[0]!.externalId,
      uploadToken:enrollment.uploadToken,deviceId:enrollment.deviceId,generation:enrollment.deviceGeneration});
    if(member.id===owner){
      expect((await custody.query(`SELECT state,active_revision FROM outside_custody_accounts WHERE owner_member_id=$1 AND resource_id='worker'
        AND connection_name='mac-private-metadata'`,[owner])).rows).toEqual([{state:'active',active_revision:'1'}]);
      expect((await custody.query(`SELECT account_id FROM outside_custody_accounts WHERE owner_member_id=$1 AND resource_id='worker'
        AND connection_name='mac-private-metadata-device' AND state='active'`,[owner])).rows).toHaveLength(1);
      expect(await store.previewPrivateMetadataTarget(member.token,{agentName:'worker'},deadline())).toMatchObject({descriptorFingerprint:descriptor.fingerprint});
    }
  }

  const peerRequests:{authorization:string|undefined;datasetId:string|undefined;method:string}[]=[];
  http.request.mockImplementation(async(_url:string,options:{body:Buffer;headers:Record<string,string>})=>{
    const message=JSON.parse(options.body.toString()) as {id?:number;method:string};
    const authorization=options.headers.authorization;
    let datasetId:string|undefined;
    if(message.method==='tools/call'){
      const bearer=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization??'')?.[1];
      if(!bearer)throw new Error('synthetic peer received no scoped bearer');
      datasetId=(await store.validatePrivateMetadataCredential(bearer,'read')).datasetId;
      peerRequests.push({authorization,datasetId,method:message.method});
    }
    const result=message.method==='initialize'?{protocolVersion:'2025-06-18',serverInfo:{name:'Fixture',version:'1'}}:
      message.method==='tools/list'?{tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'Fixture result'}]};
    return {statusCode:message.id===undefined?202:200,headers:{'content-type':'application/json','mcp-session-id':'fixture-session'},
      body:Readable.from(message.id===undefined?[]:[Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))])};
  });

  try{
    for(const member of members){
      const dataset=datasets.get(member.id)!;
      const memberCapture=member.id===owner?ownerMacCapture:{...structuredClone(capture),actor:{...capture.actor,memberId:member.id,role:'member'},
        outside:{...capture.outside,connection:{...capture.outside.connection,name:connectionName}},
        grant:{kind:'grant',id:`grant-${member.id}`,principal:{kind:'member',id:member.id},permission:'use',validUntil:null}};
      grant.capture=memberCapture;
      const binding={agent:'worker',incarnation,sessionId:member.session,memberId:member.id,approverMemberId:member.id,
        admissionNonce:macNonces.get(member.id)!,policyRevision:2};
      await expect(store.acceptedRuntimeTools(binding,definitionHash,connectionName,deadline()).catch(error=>{throw new Error(`member ${member.id}: ${String(error)}`)})).resolves.toEqual([{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}]);
      const request={callId:randomUUID(),connectionName,toolName:'lookup',input:{query:`for-${member.id}`}};
      const requestId=randomUUID();
      await store.approveExecution(binding,request,{requestId,definitionHash,expiresAt:Date.now()+60_000},deadline());
      const receipt=(await custody.query(`SELECT connection_name,account_id FROM outside_execution_approvals WHERE call_id=$1`,[request.callId])).rows[0];
      const scopedAccount=(await custody.query(`SELECT custody_account_id AS account_id FROM private_metadata_devices WHERE id=$1`,[dataset.deviceId])).rows[0];
      expect(receipt).toEqual({connection_name:connectionName,account_id:scopedAccount?.account_id});
      await expect(store.dispatchApproved(binding,request,{deadlineAtMs:Date.now()+10_000})).resolves.toMatchObject({content:[{text:'Fixture result'}]});
      const peer=peerRequests.at(-1)!;
      expect(peer.datasetId).toBe(dataset.datasetId);
      expect(peer.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    }
    expect(peerRequests).toHaveLength(3);
    expect(new Set(peerRequests.map(peer=>peer.authorization)).size).toBe(3);
    expect(new Set(peerRequests.map(peer=>peer.datasetId)).size).toBe(3);

    const first=members[1]!,second=members[2]!,ownerData=datasets.get(owner)!,firstData=datasets.get(first.id)!;
    const firstCapture={...structuredClone(capture),actor:{...capture.actor,memberId:first.id,role:'member'},
      outside:{...capture.outside,connection:{...capture.outside.connection,name:connectionName}},
      grant:{kind:'grant',id:`grant-${first.id}`,principal:{kind:'member',id:first.id},permission:'use',validUntil:null}};
    const firstBinding={agent:'worker',incarnation,sessionId:first.session,memberId:first.id,approverMemberId:first.id,
      admissionNonce:macNonces.get(first.id)!,policyRevision:2};
    grant.capture={...firstCapture,actor:{...firstCapture.actor,memberId:second.id}};
    await expect(store.acceptedRuntimeTools(firstBinding,definitionHash,connectionName,deadline())).rejects.toThrow();
    grant.capture=undefined;
    await expect(store.acceptedRuntimeTools(firstBinding,definitionHash,connectionName,deadline())).rejects.toThrow();
    grant.capture=firstCapture;
    await store.revokePrivateMetadataDevice(first.token,{deviceId:firstData.deviceId,expectedGeneration:firstData.generation},deadline());
    await expect(store.acceptedRuntimeTools(firstBinding,definitionHash,connectionName,deadline())).rejects.toThrow();
    await store.revokePrivateMetadataDevice(token,{deviceId:ownerData.deviceId,expectedGeneration:ownerData.generation},deadline());
    expect((await custody.query(`SELECT state,active_revision FROM outside_custody_accounts WHERE owner_member_id=$1 AND resource_id='worker'
      AND connection_name='mac-private-metadata'`,[owner])).rows).toEqual([{state:'active',active_revision:'1'}]);
    grant.capture={...structuredClone(capture),actor:{...capture.actor,memberId:second.id,role:'member'},
      outside:{...capture.outside,connection:{...capture.outside.connection,name:connectionName}},
      grant:{kind:'grant',id:`grant-${second.id}`,principal:{kind:'member',id:second.id},permission:'use',validUntil:null}};
    const secondBinding={agent:'worker',incarnation,sessionId:second.session,memberId:second.id,approverMemberId:second.id,
      admissionNonce:macNonces.get(second.id)!,policyRevision:2};
    const afterOwnerRevoke={callId:randomUUID(),connectionName,toolName:'lookup',input:{query:'after-owner-device-revoke'}};
    await store.approveExecution(secondBinding,afterOwnerRevoke,{requestId:randomUUID(),definitionHash,expiresAt:Date.now()+60_000},deadline());
    await expect(store.dispatchApproved(secondBinding,afterOwnerRevoke,{deadlineAtMs:Date.now()+10_000})).resolves.toMatchObject({content:[{text:'Fixture result'}]});
    expect(peerRequests).toHaveLength(4);
    expect(peerRequests.at(-1)?.datasetId).toBe(datasets.get(second.id)?.datasetId);
  }finally{http.request.mockReset();grant.capture=capture;}
});

it('removes held revisions under the runtime role, retains receipts, and reconnects above every old revision',async()=>{
  const binding={agent:'worker',incarnation,sessionId,memberId:owner,approverMemberId:owner,admissionNonce,policyRevision:2};
  const callBefore={callId:randomUUID(),connectionName:'connector',toolName:'lookup',input:{query:'before-removal'}};
  const staleCall={callId:randomUUID(),connectionName:'connector',toolName:'lookup',input:{query:'stale-after-removal'}};
  const newCall={callId:randomUUID(),connectionName:'connector',toolName:'lookup',input:{query:'after-reconnect'}};
  const approval=async(call:typeof callBefore,revision:number)=>admin.query(`INSERT INTO outside_execution_approvals(call_id,request_id,session_id,member_id,
    approver_member_id,agent,incarnation,definition_hash,connection_name,account_id,credential_revision,tool_name,payload_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp()+interval '1 minute')`,[call.callId,randomUUID(),sessionId,
    owner,owner,'worker',incarnation,Buffer.from('a'.repeat(64),'hex'),'connector',accountId,revision,'lookup',Buffer.from(outsidePayloadHash('lookup',call.input),'hex')]);
  await approval(callBefore,1);await approval(staleCall,1);
  let peerCalls=0;
  http.request.mockImplementation(async(_url:string,options:{body:Buffer})=>{
    peerCalls++;
    const message=JSON.parse(options.body.toString()) as {id?:number;method:string};
    let result:unknown;
    if(message.method==='initialize')result={protocolVersion:'2025-06-18',serverInfo:{name:'Fixture',version:'1'}};
    else if(message.method==='tools/list')result={tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}]};
    else result={content:[{type:'text',text:'Fixture result'}]};
    return {statusCode:message.id===undefined?202:200,headers:{'content-type':'application/json','mcp-session-id':'fixture-session'},
      body:Readable.from(message.id===undefined?[]:[Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))])};
  });
  try{
    await expect(store.dispatchApproved(binding,callBefore,{deadlineAtMs:Date.now()+10000})).resolves.toMatchObject({content:[{text:'Fixture result'}]});
    const before=await store.inspectHumanPendingApply(token,{agentName:'worker',connectionName:'connector'},deadline());
    const oldApply={...before,operationId:randomUUID()};
    await expect(store.removeHumanCredential(otherToken,{accountId,agentName:'worker',connectionName:'connector',expectedGeneration:1,
      operationId:randomUUID()},deadline())).rejects.toThrow();
    grant.capture={...capture,actor:{...capture.actor,memberId:other}};
    await expect(store.removeHumanCredential(otherToken,{accountId,agentName:'worker',connectionName:'connector',expectedGeneration:1,
      operationId:randomUUID()},deadline())).rejects.toThrow();
    grant.capture=capture;
    grant.capture=undefined;
    await expect(store.removeHumanCredential(token,{accountId,agentName:'worker',connectionName:'connector',expectedGeneration:1,
      operationId:randomUUID()},deadline())).rejects.toThrow();
    grant.capture=capture;
    await expect(store.removeHumanCredential(token,{accountId,agentName:'worker',connectionName:'connector',expectedGeneration:2,
      operationId:randomUUID()},deadline())).rejects.toThrow();
    await admin.query('REVOKE DELETE ON TABLE outside_custody_revisions FROM lares_outside_custody');
    await expect(store.removeHumanCredential(token,{accountId,agentName:'worker',connectionName:'connector',expectedGeneration:1,
      operationId:randomUUID()},deadline())).rejects.toThrow();
    expect((await admin.query('SELECT generation::text,state FROM outside_custody_accounts WHERE account_id=$1',[accountId])).rows[0])
      .toEqual({generation:'1',state:'active'});
    expect((await admin.query('SELECT count(*)::int AS count FROM outside_custody_revisions WHERE account_id=$1',[accountId])).rows[0]?.count).toBe(3);
    await admin.query('GRANT DELETE ON TABLE outside_custody_revisions TO lares_outside_custody');
    const removalOperationId=randomUUID();
    const removed=await store.removeHumanCredential(token,{accountId,agentName:'worker',connectionName:'connector',expectedGeneration:1,
      operationId:removalOperationId},deadline());
    expect(removed).toMatchObject({kind:'revoke',outcome:'revoked',generation:4,credentialRevision:3});
    expect((await custody.query('SELECT current_user')).rows[0]?.current_user).toBe('lares_outside_custody');
    expect((await app.query('SELECT current_user')).rows[0]?.current_user).toBe('lares_app');
    expect((await admin.query('SELECT count(*)::int AS count FROM outside_custody_revisions WHERE account_id=$1',[accountId])).rows[0]?.count).toBe(0);
    expect((await admin.query('SELECT count(*)::int AS count FROM outside_custody_operations WHERE account_id=$1',[accountId])).rows[0]?.count).toBeGreaterThan(4);
    expect((await admin.query('SELECT generation::text,state,active_revision,candidate_revision FROM outside_custody_accounts WHERE account_id=$1',[accountId])).rows[0])
      .toEqual({generation:'4',state:'revoked',active_revision:null,candidate_revision:null});
    await expect(store.removeHumanCredential(token,{accountId,agentName:'worker',connectionName:'connector',expectedGeneration:1,
      operationId:removalOperationId},deadline())).resolves.toMatchObject({generation:4,outcome:'revoked'});
    await expect(store.removeHumanCredential(token,{accountId,agentName:'worker',connectionName:'connector',expectedGeneration:1,
      operationId:randomUUID()},deadline())).rejects.toThrow();
    await expect(app.query('SELECT * FROM outside_custody_revisions WHERE account_id=$1',[accountId])).rejects.toThrow();
    await expect(app.query('DELETE FROM outside_custody_revisions WHERE account_id=$1',[accountId])).rejects.toThrow();
    await expect(store.dispatchApproved(binding,staleCall,{deadlineAtMs:Date.now()+10000})).rejects.toThrow();
    expect(peerCalls).toBe(3);
    await expect(store.apply(token,{...oldApply,expectedActivationReviewHash:before.activationReviewHash},deadline())).rejects.toThrow();
    await expect(store.stage(token,{...selectors,operationId:staged.operationId,activationReviewId:activation.reviewId,
      expectedActivationReviewHash:activation.reviewHash},deadline())).rejects.toThrow();

    const preview=await store.previewHumanDiscovery(token,{agentName:'worker',connectionName:'connector'},deadline());
    expect(preview).toMatchObject({accountId,expectedGeneration:4,expectedCandidateRevision:null,consentGeneration:4});
    const document=await store.consentAndDiscover(token,{requestId:preview.requestId,operationId:preview.claimOperationId,accountId,
      agentName:'worker',connectionName:'connector',expectedGeneration:preview.expectedGeneration,
      expectedCandidateRevision:preview.expectedCandidateRevision,expectedDefinitionHash:preview.definitionHash,
      expectedAccessRevision:preview.accessRevision,expectedDestinationHash:preview.destinationHash,
      expectedRoutePolicyHash:preview.routePolicyHash,consentGeneration:preview.consentGeneration,credential:Buffer.from('fresh-token')},deadline());
    expect(document.tools).toHaveLength(1);
    const review=await store.previewHumanDescriptorReview(token,{accountId,agentName:'worker',connectionName:'connector',requestId:preview.requestId,
      claimOperationId:preview.claimOperationId},deadline());
    const published=await store.publishDiscoveredDescriptorReview(token,{accountId,agentName:'worker',connectionName:'connector',requestId:preview.requestId,
      claimOperationId:preview.claimOperationId,operationId:randomUUID(),expectedGeneration:review.expectedGeneration,expectedDescriptorHash:review.descriptorHash},deadline());
    const accepted=await store.acceptPublishedDescriptorReview(token,{accountId,publicationId:published.publicationId,operationId:randomUUID(),
      expectedPublicationHash:published.publicationHash},deadline());
    const activationSelectors={accountId,agentName:'worker',connectionName:'connector',requestId:preview.requestId,claimOperationId:preview.claimOperationId,
      publicationId:published.publicationId,acceptanceId:accepted.acceptanceId,expectedGeneration:review.expectedGeneration,
      expectedCandidateRevision:review.expectedCandidateRevision,expectedConsentGeneration:review.expectedConsentGeneration,
      expectedDefinitionHash:review.expectedDefinitionHash,expectedAccessRevision:review.expectedAccessRevision,
      expectedPublicationHash:published.publicationHash,expectedAcceptanceHash:accepted.acceptanceHash};
    const freshActivation=await store.previewExecutableActivation(token,{...activationSelectors,operationId:randomUUID()},deadline());
    const freshStage=await store.stage(token,{...activationSelectors,operationId:randomUUID(),expectedPolicyHash:freshActivation.policyHash,
      activationReviewId:freshActivation.reviewId,expectedActivationReviewHash:freshActivation.reviewHash},deadline());
    const applyInput={...activationSelectors,operationId:randomUUID(),expectedPolicyHash:freshActivation.policyHash,
      activationReviewId:freshActivation.reviewId,expectedActivationReviewHash:freshActivation.reviewHash,
      stageOperationId:freshStage.operationId,candidateRevision:freshStage.credentialRevision!};
    await store.apply(token,applyInput,deadline());
    expect(freshStage.credentialRevision).toBeGreaterThan(3);
    expect((await admin.query('SELECT active_revision::text FROM outside_custody_accounts WHERE account_id=$1',[accountId])).rows[0]?.active_revision)
      .toBe(String(freshStage.credentialRevision));
    await expect(store.dispatchApproved(binding,staleCall,{deadlineAtMs:Date.now()+10000})).rejects.toThrow();
    expect(peerCalls).toBe(6);
    await approval(newCall,freshStage.credentialRevision!);
    await expect(store.dispatchApproved(binding,newCall,{deadlineAtMs:Date.now()+10000})).resolves.toMatchObject({content:[{text:'Fixture result'}]});
    expect(peerCalls).toBe(9);
    expect((await admin.query('SELECT count(*)::int AS count FROM outside_custody_operations WHERE account_id=$1',[accountId])).rows[0]?.count)
      .toBeGreaterThan(10);
  }finally{http.request.mockReset();}
});
