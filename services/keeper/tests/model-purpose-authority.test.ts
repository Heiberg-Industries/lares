import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgGrantStore } from '@lares/agent-kit/grant-store';
import { bindConsoleSession, requireConsoleSessionBinding } from '@lares/agent-kit/console-turn-authority';
import { consoleSourceTransaction } from '@lares/agent-kit/console-source-transaction';
import { captureBudgetAuthorityReference, validateBudgetAuthorityReference } from '@lares/agent-kit/budget-model-authority';
import { assertPrivateConsoleRequest, PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER, verifiedPrivateConsoleModelMessageReceipt } from '@lares/agent-kit/private-console-envelope';
import { PgPersonalActionStore } from '@lares/agent-kit/personal-action-store';
import { serveModelPurposeBroker, modelPurposeDigest, modelPurposeMac, signModelPurposeRequest, type ModelPurposeRequest } from '../lib/model-purpose-broker.js';
import { modelPurposeRawBodyHash, signPrivateModelPurposeRequest } from '../../console/lib/model-purpose-capsule.js';

const incarnation = '11111111-1111-4111-8111-111111111111';
const nonce = 'a'.repeat(43);
const sessionId = 'wrun_budget_authority';
const env = { LARES_AGENT_NAME: 'helper', LARES_AGENT_INCARNATION: incarnation, AGENT_OWNER_USER_ID: 'Owner-ID' };
const binding = { agent: 'helper', incarnation, sessionId, memberId: 'Owner-ID', admissionNonce: nonce };
const auth = (purpose = 'human') => ({ authenticator: 'lares-console', attributes: {
  user_id: 'owner@example.invalid', lares_member_id: 'Owner-ID', lares_admission_nonce: nonce, lares_purpose: purpose,
} });
const humanContext = () => ({ session: { id: sessionId, turn: { id: 'eve-turn-7', sequence: 7 }, auth: { current: auth(), initiator: auth() } } });
const emptyDigest = createHash('sha256').update('').digest('hex');
function runtimeEnvelope(op:string,input:Record<string,unknown>,key:Buffer,overrides:Record<string,unknown>={}){
  const requestId = typeof overrides.requestId==='string'?overrides.requestId:randomBytes(32).toString('base64url');
  const unsigned={agent:'helper',incarnation,requestId,timestamp:Date.now(),op,input,outcomeDigest:emptyDigest,payloadDigest:modelPurposeDigest(input),...overrides};
  const requestDigest=modelPurposeDigest(unsigned);
  const mac=modelPurposeMac(key,{direction:'runtime-to-keeper',domain:'model-purpose-runtime',agent:'helper',incarnation,operation:op,requestId:String(unsigned.requestId),requestDigest,outcomeDigest:String(unsigned.outcomeDigest),payloadDigest:String(unsigned.payloadDigest)}).toString('base64url');
  return {...unsigned,mac};
}
async function socketRequest(path:string,request:unknown){
  return new Promise<Record<string,unknown>>((resolve,reject)=>{
    const socket=createConnection(path);let buffer='';const timer=setTimeout(()=>{socket.destroy();reject(new Error('socket timeout'));},2500);
    socket.setEncoding('utf8');socket.on('connect',()=>socket.write(JSON.stringify(request)+'\n'));
    socket.on('data',chunk=>{buffer+=chunk;const newline=buffer.indexOf('\n');if(newline>=0){clearTimeout(timer);socket.end();try{resolve(JSON.parse(buffer.slice(0,newline)));}catch(error){reject(error);}}});
    socket.on('error',error=>{clearTimeout(timer);reject(error);});
  });
}
function brokerFiles(){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'model-purpose-broker-')),secrets=join(root,'secrets');mkdirSync(secrets,{mode:0o700});
  const consoleKey=Buffer.alloc(32,7),runtimeKey=Buffer.alloc(32,9),consolePath=join(secrets,'console-key'),runtimePath=join(secrets,'helper-runtime-control');
  writeFileSync(consolePath,consoleKey.toString('hex')+'\n',{mode:0o440});writeFileSync(runtimePath,runtimeKey.toString('hex')+'\n',{mode:0o440});
  chmodSync(consolePath,0o440);chmodSync(runtimePath,0o440);chmodSync(secrets,0o700);
  return {root,secrets,consolePath,runtimePath,consoleKey,runtimeKey};
}
async function startBroker(pool:Pool,files:ReturnType<typeof brokerFiles>,source:unknown=pool,extras:{afterListenForTests?:(which:'console'|'runtime')=>void|Promise<void>;afterKeyOpenForTests?:(path:string)=>void|Promise<void>}={}){
  const consoleSocket=join(files.root,'console.sock'),runtimeSocket=join(files.root,'runtime.sock');
  const uid=process.getuid?.()??0,gid=process.getgid?.()??0;
  const stopBroker=await serveModelPurposeBroker(source as never,{consoleSigningKeyFile:files.consolePath,runtimeSecretsDir:files.secrets,consoleSocket,runtimeSocket,
    rootUid:uid,consoleKeyUid:uid,consoleKeyGid:gid,runtimeKeyUid:uid,runtimeKeyGid:gid,socketUid:uid,socketGid:gid,...extras});
  return {consoleSocket,runtimeSocket,stopBroker};
}
async function admittedRequest(consoleSocket:string,runtimeSocket:string,consoleKey:Buffer,runtimeKey:Buffer,request:ModelPurposeRequest){
  const challengeReply=await socketRequest(consoleSocket,{op:'request.challenge',input:request});
  expect(challengeReply.ok).toBe(true);
  const capsule=signModelPurposeRequest(consoleKey,request,String(challengeReply.challenge),String(challengeReply.challengeMac),Number(challengeReply.expiresAt));
  const receipt={method:request.method,path:request.path,rawBodyHash:request.rawBodyHash,requestId:request.requestId,purpose:request.purpose,...(request.resume?{resume:request.resume}:{})};
  const reply=await socketRequest(runtimeSocket,runtimeEnvelope('request.admit',{capsule,receipt},runtimeKey));
  expect(reply.ok).toBe(true);
  return String(reply.receipt);
}
function modelRequest(overrides:Partial<ModelPurposeRequest>={}):ModelPurposeRequest{
  return {agent:'helper',incarnation,session:sessionId,member:'Owner-ID',admissionNonce:nonce,method:'POST',path:'/eve/v1/session',rawBodyHash:'b'.repeat(64),policyRevision:2,definitionHash:'c'.repeat(64),purpose:'human',requestId:randomBytes(32).toString('base64url'),...overrides};
}
function resumeContext(requestId:string){
  return {session:{id:sessionId,turn:{id:'',sequence:0},auth:{current:{authenticator:'lares-console',attributes:{lares_resolver_member_id:'Owner-ID',lares_resume_request_id:requestId,lares_resume_option:'approve',lares_purpose:'resolver'}},initiator:auth()}}};
}
async function prepareApprovedResume(requestId:string){
  const policyHash='e'.repeat(64),callId=`original-${requestId}`;
  const actions=new PgPersonalActionStore(db,{encrypt:value=>Buffer.from(value).toString('base64'),decrypt:value=>Buffer.from(value,'base64').toString()});
  const action=await actions.prepareAction({actorMemberId:'Owner-ID',agentId:'helper',incarnation,sessionId,originalTurnId:'eve-turn-7',originalCallId:callId,
    accountId:'account-1',accountGeneration:1,resourceBindingId:'binding-1',connectorId:'mail',kind:'mail.send',payload:{to:['recipient@example.invalid'],subject:'Subject',body:'Body'}});
  await actions.reserveApproval(action.actionId,'Owner-ID',7,policyHash);
  await actions.attachApproval({actionId:action.actionId,actorMemberId:'Owner-ID',approvalCallId:callId,requestId});
  await db.query("UPDATE approval_asks SET outcome='approved',answered_at=clock_timestamp(),resolved_by_member_id='Owner-ID' WHERE request_id=$1",[requestId]);
  return action;
}
let db: Pool;
let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const uri = container.getConnectionUri();
  db = new Pool({ connectionString: uri });
  vi.stubEnv('DATABASE_URL', uri);
  vi.stubEnv('LARES_AGENT_NAME', env.LARES_AGENT_NAME);
  vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
  vi.stubEnv('AGENT_OWNER_USER_ID', env.AGENT_OWNER_USER_ID);
  stop = async () => { await db.end(); await container.stop(); vi.unstubAllEnvs(); };
}, 120_000);
afterAll(async () => { await stop?.(); });

beforeEach(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(`CREATE TABLE orgs(id text PRIMARY KEY,display_name text NOT NULL);
    CREATE TABLE users(id text PRIMARY KEY,display_name text NOT NULL,primary_email text,status text,org_role text,org_id text REFERENCES orgs(id),created_at timestamptz DEFAULT now());
    CREATE TABLE org_member_policy(user_id text PRIMARY KEY REFERENCES users(id),allowed_capabilities text[]);
    CREATE TABLE agent_definitions(name text PRIMARY KEY,status text,hash text,definition jsonb);
    CREATE TABLE agent_conversations(agent text,incarnation uuid,session_id text,door text,observed_at timestamptz DEFAULT now(),terminal boolean DEFAULT false,PRIMARY KEY(agent,incarnation,session_id));
    CREATE TABLE connected_accounts(id text PRIMARY KEY,owner_member_id text,generation integer,status text);
    CREATE TABLE agent_resources(name text PRIMARY KEY,ownership_token uuid,runtime_control_token uuid,state text,pending boolean);
    CREATE TABLE approval_asks(request_id text,call_id text NOT NULL,agent text NOT NULL,tool text NOT NULL,payload_hash text NOT NULL,asked_at timestamptz DEFAULT now() NOT NULL,answered_at timestamptz,outcome text,answered_via text,used_at timestamptz,use_count integer DEFAULT 0 NOT NULL,
      CHECK ((answered_at IS NULL)=(outcome IS NULL)),CHECK (outcome IS NULL OR outcome IN ('approved','cancelled','ignored','invalid','expired','payload-changed')));
    INSERT INTO orgs VALUES('org','Example');
    INSERT INTO users(id,display_name,status,org_role,org_id) VALUES('Owner-ID','Owner','active','owner','org');
    INSERT INTO org_member_policy VALUES('Owner-ID',NULL);
    INSERT INTO agent_definitions VALUES('helper','valid','${'c'.repeat(64)}','{"model":"lares-brain","grants":[]}');
    INSERT INTO agent_resources VALUES('helper','${incarnation}','${incarnation}','ready',false);`);
  for (const file of [
    '006_approval_session.sql', '007_member_identity_sessions.sql', '009_vault_areas.sql', '013_console_turn_authority.sql', '014_agent_access_grants.sql',
    '015_exact_approval_execution.sql', '016_console_agent_access_capture.sql', '017_private_console_surface_capture.sql',
    '018_private_account_history.sql', '019_personal_actions.sql', '022_console_vault_source_history.sql',
  ]) await db.query(readFileSync(new URL(`../../../services/box/sql/${file}`, import.meta.url), 'utf8'));
  await new PgGrantStore(db).adoptAgent('Owner-ID', { agentName: 'helper', expectedDefinitionHash: 'c'.repeat(64) }, { designatedOwnerMemberId: 'Owner-ID' });
  await bindConsoleSession(binding, db, env);
});

describe('budget model authority source proof', () => {
  it('captures and revalidates real human authority, then refuses a revoked grant', async () => {
    const reference = await consoleSourceTransaction(db, client => captureBudgetAuthorityReference(client as never, humanContext(), env));
    expect(reference).toMatchObject({ kind: 'human', binding, turnId: 'eve-turn-7', turnSequence: 7 });
    await expect(consoleSourceTransaction(db, client => validateBudgetAuthorityReference(client as never, reference, env))).resolves.toBeNull();

    const grants = new PgGrantStore(db), access = await grants.agentAccess('Owner-ID', 'helper');
    await grants.updateAgentAccess('Owner-ID', { agentName: 'helper', expectedRevision: access!.accessRevision, grants: [] });
    await expect(consoleSourceTransaction(db, client => validateBudgetAuthorityReference(client as never, reference, env))).rejects.toThrow();
  });

  it('captures and revalidates an approved resume with its exact empty runtime turn', async () => {
    const policyHash = 'e'.repeat(64), callId = 'original-call-7', requestId = 'approval-request-7';
    const actions = new PgPersonalActionStore(db, { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() });
    const action = await actions.prepareAction({
      actorMemberId: 'Owner-ID', agentId: 'helper', incarnation, sessionId, originalTurnId: 'eve-turn-7', originalCallId: callId,
      accountId: 'account-1', accountGeneration: 1, resourceBindingId: 'binding-1', connectorId: 'mail', kind: 'mail.send',
      payload: { to: ['recipient@example.invalid'], subject: 'Subject', body: 'Body' },
    });
    await actions.reserveApproval(action.actionId, 'Owner-ID', 7, policyHash);
    await actions.attachApproval({ actionId: action.actionId, actorMemberId: 'Owner-ID', approvalCallId: callId, requestId });
    await db.query("UPDATE approval_asks SET outcome='approved',answered_at=clock_timestamp(),resolved_by_member_id='Owner-ID' WHERE request_id=$1", [requestId]);

    const resumeAuth = { authenticator: 'lares-console', attributes: {
      lares_resolver_member_id: 'Owner-ID', lares_resume_request_id: requestId, lares_resume_option: 'approve', lares_purpose: 'resolver',
    } };
    const context = { session: { id: sessionId, turn: { id: '', sequence: 0 }, auth: { current: resumeAuth, initiator: auth() } } };
    const reference = await consoleSourceTransaction(db, client => captureBudgetAuthorityReference(client as never, context, env));
    expect(reference).toMatchObject({ kind: 'resume', binding, turnId: '', turnSequence: 0, resume: { requestId, optionId: 'approve' } });
    expect(reference.binding).toMatchObject({ agent: 'helper', incarnation, sessionId, memberId: 'Owner-ID', admissionNonce: nonce });
    expect(await consoleSourceTransaction(db, client => validateBudgetAuthorityReference(client as never, reference, env))).toEqual(expect.any(String));

    await db.query("UPDATE approval_asks SET outcome='cancelled' WHERE request_id=$1", [requestId]);
    await expect(consoleSourceTransaction(db, client => validateBudgetAuthorityReference(client as never, reference, env))).rejects.toThrow();
  });
});

describe('Keeper model-purpose socket handlers',()=>{
  it('admits the Console-signed human raw receipt and rejects mismatched receipt purpose or request id',async()=>{
    const files=brokerFiles();let stopBroker:(()=>Promise<void>)|undefined;
    try{
      const running=await startBroker(db,files);stopBroker=running.stopBroker;
      const createHumanEvidence=async()=>{
        const body=JSON.stringify({message:'exact human request'});
        const request=modelRequest({path:`/eve/v1/session/${sessionId}`,rawBodyHash:modelPurposeRawBodyHash(body)});
        const capsule=await signPrivateModelPurposeRequest(request,{socketPath:running.consoleSocket,keyFile:files.consolePath,
          expectedUid:process.getuid?.()??0,expectedGid:process.getgid?.()??0});
        const rawRequest=new Request(`https://example.invalid${request.path}`,{method:'POST',
          headers:{[PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER]:capsule},body});
        await assertPrivateConsoleRequest(rawRequest);
        const parsed=await rawRequest.json();
        const receipt=verifiedPrivateConsoleModelMessageReceipt(rawRequest,parsed.message);
        return {request,capsule,receipt};
      };
      const submit=async(capsule:string,receipt:Record<string,unknown>)=>socketRequest(running.runtimeSocket,
        runtimeEnvelope('request.admit',{capsule,receipt},files.runtimeKey));

      const wrongId=await createHumanEvidence();
      expect(wrongId.receipt.requestId).toBe(wrongId.request.requestId);
      expect(wrongId.receipt.purpose).toBe('human');
      expect((await submit(wrongId.capsule,{...wrongId.receipt,requestId:randomBytes(32).toString('base64url')})).ok).toBe(false);
      expect((await submit(wrongId.capsule,wrongId.receipt)).ok).toBe(true);

      const wrongPurpose=await createHumanEvidence();
      expect((await submit(wrongPurpose.capsule,{...wrongPurpose.receipt,purpose:'resume'})).ok).toBe(false);
      expect((await submit(wrongPurpose.capsule,wrongPurpose.receipt)).ok).toBe(true);
    }finally{await stopBroker?.();rmSync(files.root,{recursive:true,force:true});}
  });

  it('reads runtime keys in the provisioned 0440 mode and keeps the opened key across path replacement',async()=>{
    const files=brokerFiles();let stopBroker:(()=>Promise<void>)|undefined,replaced=false;
    try{
      const running=await startBroker(db,files,db,{afterKeyOpenForTests:path=>{
        if(path!==files.consolePath||replaced)return;replaced=true;
        renameSync(files.consolePath,`${files.consolePath}.opened`);
        writeFileSync(files.consolePath,Buffer.alloc(32,8).toString('hex')+'\n',{mode:0o440});chmodSync(files.consolePath,0o440);
      }});stopBroker=running.stopBroker;
      const request=modelRequest(),pending=await admittedRequest(running.consoleSocket,running.runtimeSocket,files.consoleKey,files.runtimeKey,request);
      expect(pending).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(replaced).toBe(true);
    }finally{await stopBroker?.();rmSync(files.root,{recursive:true,force:true});}
  });

  it('rejects a symlinked key parent and closes listeners after a post-bind setup failure',async()=>{
    const files=brokerFiles(),linked=join(files.root,'linked'),uid=process.getuid?.()??0,gid=process.getgid?.()??0;
    try{
      symlinkSync(files.secrets,linked);
      await expect(serveModelPurposeBroker(db as never,{consoleSigningKeyFile:join(linked,'console-key'),runtimeSecretsDir:files.secrets,
        consoleSocket:join(files.root,'reject-console.sock'),runtimeSocket:join(files.root,'reject-runtime.sock'),rootUid:uid,consoleKeyUid:uid,consoleKeyGid:gid,runtimeKeyUid:uid,runtimeKeyGid:gid,socketUid:uid,socketGid:gid})).rejects.toThrow();
      await expect(startBroker(db,files,db,{afterListenForTests:which=>{if(which==='console')throw new Error('injected listener setup failure');}})).rejects.toThrow('injected listener setup failure');
      expect(existsSync(join(files.root,'console.sock'))).toBe(false);expect(existsSync(join(files.root,'runtime.sock'))).toBe(false);
    }finally{rmSync(files.root,{recursive:true,force:true});}
  });

  it('admits a real human request, opens its actual turn and issues one event-bound claim',async()=>{
    const files=brokerFiles();let stopBroker:(()=>Promise<void>)|undefined;
    try{
      await expect(requireConsoleSessionBinding({agent:binding.agent,incarnation,sessionId,memberId:binding.memberId,admissionNonce:nonce},db as never)).resolves.toMatchObject({policyRevision:2});
      const running=await startBroker(db,files);stopBroker=running.stopBroker;
      const request=modelRequest(),pending=await admittedRequest(running.consoleSocket,running.runtimeSocket,files.consoleKey,files.runtimeKey,request);
      const open=runtimeEnvelope('turn.open',{pendingReceipt:pending,context:humanContext()},files.runtimeKey);
      const opened=await socketRequest(running.runtimeSocket,open);expect(opened.ok).toBe(true);
      const capability=String(opened.capability);
      const event={type:'step.started',data:{turnId:'eve-turn-7',sequence:7,stepIndex:0}};
      const claim=await socketRequest(running.runtimeSocket,runtimeEnvelope('step.claim',{turnCapability:capability,purposeAlias:'lares-brain',event},files.runtimeKey,{payloadDigest:modelPurposeDigest(event)}));
      expect(claim.ok).toBe(true);expect(claim.claim).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const close=runtimeEnvelope('turn.close',{turnCapability:capability,turnId:'eve-turn-7',sequence:7},files.runtimeKey);
      expect((await socketRequest(running.runtimeSocket,{...close,timestamp:Number(close.timestamp)+1})).ok).toBe(false);
      expect((await socketRequest(running.runtimeSocket,close)).ok).toBe(true);
      expect((await socketRequest(running.runtimeSocket,close)).ok).toBe(false);
    }finally{await stopBroker?.();rmSync(files.root,{recursive:true,force:true});}
  });

  it('opens and claims the exact empty approval-resume turn, including a delayed-close race',async()=>{
    await prepareApprovedResume('approval-resume-socket');
    let blocked=false,entered!:()=>void,proceed!:()=>void;
    const reached=new Promise<void>(resolve=>{entered=resolve;}),release=new Promise<void>(resolve=>{proceed=resolve;});
    const source={query:db.query.bind(db),connect:async()=>{const client=await db.connect();return {release:(error?:boolean)=>client.release(error),query:async(sql:unknown,values?:unknown[])=>{const text=typeof sql==='string'?sql:String((sql as {text?:unknown})?.text??'');if(blocked&&text.includes('FROM personal_actions WHERE approval_request_id')){blocked=false;entered();await release;}return client.query(sql as never,values as never);}};}};
    const files=brokerFiles();let stopBroker:(()=>Promise<void>)|undefined;
    try{
      const running=await startBroker(db,files,source);stopBroker=running.stopBroker;
      const request=modelRequest({purpose:'resume',resume:{requestId:'approval-resume-socket',optionId:'approve'}});
      const pending=await admittedRequest(running.consoleSocket,running.runtimeSocket,files.consoleKey,files.runtimeKey,request);
      const open=await socketRequest(running.runtimeSocket,runtimeEnvelope('turn.open',{pendingReceipt:pending,context:resumeContext('approval-resume-socket')},files.runtimeKey));
      expect(open.ok).toBe(true);const capability=String(open.capability);
      const reference=await consoleSourceTransaction(db,client=>captureBudgetAuthorityReference(client as never,resumeContext('approval-resume-socket'),env));
      const authorityDeadline=await consoleSourceTransaction(db,client=>validateBudgetAuthorityReference(client as never,reference,env));
      const firstEvent={type:'step.started',data:{turnId:'',sequence:0,stepIndex:0}};
      const firstClaim=await socketRequest(running.runtimeSocket,runtimeEnvelope('step.claim',{turnCapability:capability,purposeAlias:'lares-brain',event:firstEvent},files.runtimeKey,{payloadDigest:modelPurposeDigest(firstEvent)}));
      expect(firstClaim.ok).toBe(true);expect(firstClaim.claim).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Number(firstClaim.expiresAt)).toBeLessThanOrEqual(Date.parse(authorityDeadline!));
      const event={type:'step.started',data:{turnId:'',sequence:0,stepIndex:1}};
      blocked=true;
      const claimPromise=socketRequest(running.runtimeSocket,runtimeEnvelope('step.claim',{turnCapability:capability,purposeAlias:'lares-brain',event},files.runtimeKey,{payloadDigest:modelPurposeDigest(event)}));
      await reached;
      const close=await socketRequest(running.runtimeSocket,runtimeEnvelope('turn.close',{turnCapability:capability,turnId:'',sequence:0},files.runtimeKey));
      expect(close.ok).toBe(true);proceed();
      expect((await claimPromise).ok).toBe(false);
    }finally{if(blocked)proceed();await stopBroker?.();rmSync(files.root,{recursive:true,force:true});}
  },10_000);

  it('withholds a claim when approved-resume authority expires during validation',async()=>{
    await prepareApprovedResume('approval-resume-expiry');
    await db.query('ALTER TABLE personal_actions DISABLE TRIGGER personal_action_guard');
    await db.query('ALTER TABLE approval_asks DISABLE TRIGGER exact_approval_authority_guard');
    const expiresAt=(await db.query("UPDATE personal_actions SET expires_at=clock_timestamp()+interval '1100 milliseconds' RETURNING expires_at")).rows[0].expires_at.toISOString();
    await db.query("UPDATE approval_asks SET original_authority=jsonb_set(original_authority,'{expiresAt}',to_jsonb($2::text),true) WHERE request_id=$1",['approval-resume-expiry',expiresAt]);
    await db.query('ALTER TABLE approval_asks ENABLE TRIGGER exact_approval_authority_guard');
    await db.query('ALTER TABLE personal_actions ENABLE TRIGGER personal_action_guard');
    let delayCommit=false;
    const source={query:db.query.bind(db),connect:async()=>{const client=await db.connect();return {release:(error?:boolean)=>client.release(error),query:async(sql:unknown,values?:unknown[])=>{const text=typeof sql==='string'?sql:String((sql as {text?:unknown})?.text??'');if(delayCommit&&/^\s*COMMIT\b/i.test(text)){delayCommit=false;await new Promise(resolve=>setTimeout(resolve,1250));}return client.query(sql as never,values as never);}};}};
    const files=brokerFiles();let stopBroker:(()=>Promise<void>)|undefined;
    try{
      const running=await startBroker(db,files,source);stopBroker=running.stopBroker;
      const request=modelRequest({purpose:'resume',resume:{requestId:'approval-resume-expiry',optionId:'approve'}});
      const pending=await admittedRequest(running.consoleSocket,running.runtimeSocket,files.consoleKey,files.runtimeKey,request);
      const open=await socketRequest(running.runtimeSocket,runtimeEnvelope('turn.open',{pendingReceipt:pending,context:resumeContext('approval-resume-expiry')},files.runtimeKey));
      expect(open.ok).toBe(true);const capability=String(open.capability);
      const event={type:'step.started',data:{turnId:'',sequence:0,stepIndex:0}};delayCommit=true;
      const claim=await socketRequest(running.runtimeSocket,runtimeEnvelope('step.claim',{turnCapability:capability,purposeAlias:'lares-brain',event},files.runtimeKey,{payloadDigest:modelPurposeDigest(event)}));
      expect(claim.ok).toBe(false);
      const retry=await socketRequest(running.runtimeSocket,runtimeEnvelope('step.claim',{turnCapability:capability,purposeAlias:'lares-brain',event},files.runtimeKey,{payloadDigest:modelPurposeDigest(event)}));
      expect(retry.ok).toBe(false);
    }finally{await stopBroker?.();rmSync(files.root,{recursive:true,force:true});}
  },10_000);
});
