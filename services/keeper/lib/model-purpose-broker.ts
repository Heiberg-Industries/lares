import { createConnection, createServer, type Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, chown, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type {Pool} from 'pg';
import { captureBudgetAuthorityReference, validateBudgetAuthorityReference, type BudgetAuthorityReference } from '@lares/agent-kit/budget-model-authority';
import {PgBudgetAdmissionStore,type BudgetFinancialWriter,type GatewayModelRequestIdentity,type ModelPurposeClaimSource} from '@lares/agent-kit/budget-admission-store';
import {GATEWAY_ANTHROPIC_MODEL_PATH,GATEWAY_OPENAI_MODEL_PATH} from '@lares/agent-kit/gateway-admission-protocol';
import { checkConsoleSourceDeadlines, consoleSourceTransaction, retainSourceTransactionDeadline, type SourceDatabase, type SourcePool } from '@lares/agent-kit/console-source-transaction';
import { consoleAdmission, requireConsoleSessionBinding, type ConsoleAuthorityContext } from '@lares/agent-kit/console-turn-authority';
import { MODEL_PURPOSE_EMPTY_DIGEST, modelPurposeAckFields, modelPurposeChallengeFields, modelPurposeConsoleRequestFields, modelPurposeDigest, modelPurposeEqualMac, modelPurposeMac, modelPurposeRuntimeRequestFields, type ModelPurposeMacFields } from '@lares/agent-kit/model-purpose-protocol';

const DEFAULT_CONSOLE_SOCKET='/run/lares/model-purpose-console.sock';
const DEFAULT_RUNTIME_SOCKET='/run/lares/model-purpose/model-purpose.sock';
const FRAME_LIMIT=32_768,MAX_CLIENTS=32,MAX_LIVE=2048,CHALLENGE_MS=10_000,PENDING_MS=30_000,TURN_MS=5*60_000,CLAIM_MS=30_000,REQUEST_MS=60_000;
const EMPTY_DIGEST=MODEL_PURPOSE_EMPTY_DIGEST;
const deny=()=>new Error('Model purpose authority is not available');

export type ModelPurposeRequest={
  agent:string;incarnation:string;session:string;member:string;admissionNonce:string;
  method:'POST';path:string;rawBodyHash:string;policyRevision:number;definitionHash:string;
  purpose:'human'|'resume';requestId:string;resume?:{requestId:string;optionId:'approve'|'cancel'};
};
export type ModelPurposeReceipt=Pick<ModelPurposeRequest,'method'|'path'|'rawBodyHash'> & Partial<Pick<ModelPurposeRequest,'requestId'|'purpose'|'resume'>>;
export type ModelPurposeTurnInput={pendingReceipt:string;context:ConsoleAuthorityContext};
export type ModelPurposeStepInput={turnCapability:string;purposeAlias:string;event:unknown};
export interface ModelPurposeBrokerOptions {
  consoleSigningKeyFile:string;runtimeSecretsDir:string;consoleSocket?:string;runtimeSocket?:string;
  rootUid?:number;runtimeKeyUid?:number;runtimeKeyGid?:number;consoleKeyUid?:number;consoleKeyGid?:number;
  socketUid?:number;socketGid?:number;now?:()=>number;
  /** Test-only fault point for proving listener cleanup after a successful bind. */
  afterListenForTests?:(which:'console'|'runtime')=>void|Promise<void>;
  /** Test-only race point; key bytes must still come from the already-open descriptor. */
  afterKeyOpenForTests?:(path:string)=>void|Promise<void>;
}
type Challenge={request:ModelPurposeRequest;digest:string;challenge:string;expiresAt:number};
type Pending={request:ModelPurposeRequest;digest:string;expiresAt:number};
type Turn={request:ModelPurposeRequest;reference:BudgetAuthorityReference;turnId:string;sequence:number;definitionHash:string;purposeAlias:string;expiresAt:number;closed:boolean;steps:Set<string>};
type Claim={turn:Turn;stepId:string;event:{turnId:string;sequence:number;stepIndex:number};purposeAlias:string;expiresAt:number;handle:object;consumed:boolean};
type MacFields=ModelPurposeMacFields;
type RuntimeEnvelope={agent:unknown;incarnation:unknown;requestId:unknown;timestamp:unknown;op:unknown;input:unknown;outcomeDigest:unknown;payloadDigest:unknown;mac:unknown};

const canonical=(value:unknown):string=>JSON.stringify(value);
export { modelPurposeDigest, modelPurposeMac };
function equalMac(given:unknown,expected:Buffer):boolean{return modelPurposeEqualMac(given,expected);}
function requestIsValid(value:unknown):value is ModelPurposeRequest{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;const x=value as ModelPurposeRequest;
  return /^[a-z][a-z0-9-]{1,30}$/.test(x.agent)&&/^[a-f0-9-]{36}$/.test(x.incarnation)&&/^[A-Za-z0-9_-]{1,64}$/.test(x.session)&&typeof x.member==='string'&&/^[^\s,;\x00-\x1f\x7f]{1,256}$/.test(x.member)&&/^[A-Za-z0-9_-]{43}$/.test(x.admissionNonce)&&x.method==='POST'&&/^\/eve\/v1\/session(?:\/[A-Za-z0-9_-]{1,64})?$/.test(x.path)&&/^[a-f0-9]{64}$/.test(x.rawBodyHash)&&Number.isSafeInteger(x.policyRevision)&&x.policyRevision>0&&/^[a-f0-9]{64}$/.test(x.definitionHash)&&(x.purpose==='human'||x.purpose==='resume')&&/^[A-Za-z0-9_-]{32,64}$/.test(x.requestId)&&((x.purpose==='human'&&x.resume===undefined)||(x.purpose==='resume'&&!!x.resume&&typeof x.resume.requestId==='string'&&x.resume.requestId.length>0&&(x.resume.optionId==='approve'||x.resume.optionId==='cancel')));
}
function validDigest(value:unknown):value is string{return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw deny();return value as Record<string,unknown>;}
function parseContext(value:unknown):ConsoleAuthorityContext{
  const x=object(value),session=object(x.session),turn=object(session.turn),auth=object(session.auth);
  if(typeof session.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(session.id)||typeof turn.id!=='string'||(turn.id!==''&&!/^[A-Za-z0-9._:-]{1,128}$/.test(turn.id))||!Number.isSafeInteger(turn.sequence)||Number(turn.sequence)<0)throw deny();
  return {session:{id:session.id,turn:{id:turn.id,sequence:Number(turn.sequence)},auth:{current:auth.current,initiator:auth.initiator}}};
}
function stepEvent(value:unknown){const event=object(value),data=object(event.data);if(event.type!=='step.started'||typeof data.turnId!=='string'||(data.turnId!==''&&!/^[A-Za-z0-9._:-]{1,128}$/.test(data.turnId))||!Number.isSafeInteger(data.sequence)||Number(data.sequence)<0||!Number.isSafeInteger(data.stepIndex)||Number(data.stepIndex)<0)return undefined;return {turnId:data.turnId,sequence:Number(data.sequence),stepIndex:Number(data.stepIndex),digest:modelPurposeDigest(event),key:`${data.turnId}:${data.sequence}:${data.stepIndex}`};}
function resumeMatches(request:ModelPurposeRequest,reference:BudgetAuthorityReference){
  return request.purpose==='resume'?reference.kind==='resume'&&reference.resume?.requestId===request.resume?.requestId&&reference.resume?.optionId===request.resume?.optionId:reference.kind==='human';
}

/** Bounded, process-local replay and capability state. Instances are private to one broker. */
export class ModelPurposeBrokerState {
  private challenges=new Map<string,Challenge>();
  private pending=new Map<string,Pending>();
  private turns=new Map<string,Turn>();
  private claims=new Map<string,Claim>();
  private claimHandles=new WeakMap<object,Claim>();
  private requests=new Map<string,number>();

  constructor(private readonly clock:()=>number=Date.now,private readonly maximum=MAX_LIVE){}

  private prune(){
    const now=this.clock();
    for(const [key,value] of this.challenges)if(value.expiresAt<=now)this.challenges.delete(key);
    for(const [key,value] of this.pending)if(value.expiresAt<=now)this.pending.delete(key);
    for(const [key,value] of this.turns)if(value.expiresAt<=now||value.closed)this.turns.delete(key);
    for(const [key,value] of this.claims)if(value.expiresAt<=now||!this.turnsHas(value.turn))this.claims.delete(key);
    for(const [key,expiresAt] of this.requests)if(expiresAt<=now)this.requests.delete(key);
  }

  private turnsHas(turn:Turn){
    for(const value of this.turns.values())if(value===turn)return true;
    return false;
  }

  private capacity(...maps:Map<unknown,unknown>[]){
    this.prune();
    if(maps.some(map=>map.size>=this.maximum))throw deny();
  }

  challenge(request:ModelPurposeRequest){
    if(!requestIsValid(request))throw deny();
    this.capacity(this.challenges);
    const digest=modelPurposeDigest(request),challenge=randomBytes(32).toString('base64url'),expiresAt=this.clock()+CHALLENGE_MS;
    const stored={...request,...(request.resume?{resume:{...request.resume}}:{})};
    this.challenges.set(challenge,{request:stored,digest,challenge,expiresAt});
    return {challenge,requestDigest:digest,expiresAt};
  }

  consumeChallenge(challenge:string,request:ModelPurposeRequest,digest:string){
    this.prune();
    const entry=this.challenges.get(challenge);
    if(entry)this.challenges.delete(challenge);
    if(!entry||!requestIsValid(request)||entry.expiresAt<=this.clock()||entry.digest!==digest||
      digest!==modelPurposeDigest(request)||entry.digest!==modelPurposeDigest(entry.request)||canonical(entry.request)!==canonical(request))throw deny();
    return entry;
  }

  pendingReceipt(request:ModelPurposeRequest,digest:string){
    this.capacity(this.pending);
    const receipt=randomBytes(32).toString('base64url'),expiresAt=this.clock()+PENDING_MS;
    const stored={...request,...(request.resume?{resume:{...request.resume}}:{})};
    this.pending.set(receipt,{request:stored,digest,expiresAt});
    return {receipt,expiresAt};
  }

  consumePending(receipt:string,identity:{agent:string;incarnation:string;session:string;member:string;admissionNonce:string}){
    this.prune();
    const value=this.pending.get(receipt);
    if(value)this.pending.delete(receipt);
    if(!value||value.expiresAt<=this.clock()||value.request.agent!==identity.agent||
      value.request.incarnation!==identity.incarnation||value.request.session!==identity.session||
      value.request.member!==identity.member||value.request.admissionNonce!==identity.admissionNonce)throw deny();
    return value;
  }

  registerTurn(request:ModelPurposeRequest,reference:BudgetAuthorityReference,turnId:string,sequence:number,definitionHash:string,purposeAlias:string){
    this.capacity(this.turns);
    if(!resumeMatches(request,reference)||reference.turnId!==turnId||reference.turnSequence!==sequence||
      !Number.isSafeInteger(sequence)||sequence<0||(request.purpose==='human'&&turnId==='')||
      (turnId!==''&&!/^[A-Za-z0-9._:-]{1,128}$/.test(turnId))||definitionHash!==request.definitionHash||
      !/^[a-z][a-z0-9-]{1,63}$/.test(purposeAlias))throw deny();
    const capability=randomBytes(32).toString('base64url');
    const turn:Turn={request,reference,turnId,sequence,definitionHash,purposeAlias,
      expiresAt:this.clock()+TURN_MS,closed:false,steps:new Set()};
    this.turns.set(capability,turn);
    return {capability,expiresAt:turn.expiresAt};
  }

  closeTurn(capability:string,identity:{agent:string;incarnation:string},turnId:string,sequence:number){
    this.prune();
    const turn=this.turns.get(capability);
    if(!turn||turn.closed||turn.expiresAt<=this.clock()||turn.request.agent!==identity.agent||
      turn.request.incarnation!==identity.incarnation||turn.turnId!==turnId||turn.sequence!==sequence)throw deny();
    turn.closed=true;
    this.turns.delete(capability);
    for(const [token,claim] of this.claims)if(claim.turn===turn)this.claims.delete(token);
    return {closed:true};
  }

  reserveStep(capability:string,identity:{agent:string;incarnation:string},input:ModelPurposeStepInput){
    this.prune();
    const turn=this.turns.get(capability),event=stepEvent(input.event);
    if(!turn||!event||turn.closed||turn.expiresAt<=this.clock()||turn.request.agent!==identity.agent||
      turn.request.incarnation!==identity.incarnation||turn.turnId!==event.turnId||turn.sequence!==event.sequence||
      turn.purposeAlias!==input.purposeAlias||turn.steps.size>=64||turn.steps.has(event.key))throw deny();
    this.capacity(this.claims);
    // Reserve synchronously before the source-authority transaction can await.
    turn.steps.add(event.key);
    return {turn,event};
  }

  finishStep(reserved:{turn:Turn;event:NonNullable<ReturnType<typeof stepEvent>>},authorityDeadlineMs:number|null=null){
    this.prune();
    const {turn,event}=reserved,now=this.clock();
    if(turn.closed||turn.expiresAt<=now||!this.turnsHas(turn)||(authorityDeadlineMs!==null&&authorityDeadlineMs<=now))throw deny();
    this.capacity(this.claims);
    const expiresAt=Math.min(turn.expiresAt,now+CLAIM_MS,authorityDeadlineMs??Number.POSITIVE_INFINITY);
    const claim=randomBytes(32).toString('base64url'),handle=Object.freeze({});
    const record:Claim={turn,stepId:event.key,event:{turnId:event.turnId,sequence:event.sequence,stepIndex:event.stepIndex},purposeAlias:turn.purposeAlias,expiresAt,handle,consumed:false};
    this.claims.set(claim,record);this.claimHandles.set(handle,record);
    return {claim,expiresAt};
  }

  reserveClaimConsumption(token:string,identity:{agent:string;incarnation:string},request:GatewayModelRequestIdentity):object {
    this.prune();
    const claim=this.claims.get(token),turn=claim?.turn;
    if(!claim||claim.consumed||!turn||turn.closed||turn.expiresAt<=this.clock()||claim.expiresAt<=this.clock()||!this.turnsHas(turn)||
      turn.request.agent!==identity.agent||turn.request.incarnation!==identity.incarnation||
      request.method!=='POST'||!(/^[a-f0-9]{64}$/.test(request.requestHash))||
      (request.path!==GATEWAY_ANTHROPIC_MODEL_PATH&&request.path!==GATEWAY_OPENAI_MODEL_PATH))throw deny();
    // The claim is irreversibly consumed synchronously, before source or financial I/O.
    claim.consumed=true;this.claims.delete(token);
    return claim.handle;
  }

  resolveConsumedClaim(handle:object):ModelPurposeClaimSource|undefined {
    const claim=this.claimHandles.get(handle),turn=claim?.turn,now=this.clock();
    if(!claim||!claim.consumed||!turn||turn.closed||turn.expiresAt<=now||claim.expiresAt<=now||!this.turnsHas(turn))return undefined;
    return {agent:turn.request.agent,incarnation:turn.request.incarnation,reference:turn.reference,
      definitionHash:turn.definitionHash,purposeAlias:claim.purposeAlias,event:claim.event,expiresAt:claim.expiresAt,
      isActive:()=>{const current=this.claimHandles.get(handle);return current===claim&&claim.consumed&&!turn.closed&&turn.expiresAt>this.clock()&&claim.expiresAt>this.clock()&&this.turnsHas(turn);}};
  }

  burnRequest(requestId:string,expiresAt=this.clock()+REQUEST_MS){
    this.prune();
    if(!/^[A-Za-z0-9_-]{32,64}$/.test(requestId)||this.requests.has(requestId)||this.requests.size>=this.maximum)throw deny();
    this.requests.set(requestId,expiresAt);
  }

  get sizes(){
    this.prune();
    return {challenges:this.challenges.size,pending:this.pending.size,turns:this.turns.size,claims:this.claims.size,requests:this.requests.size};
  }
}

function challengeFields(request:ModelPurposeRequest,digest:string,challenge:string,expiresAt:number):MacFields{return modelPurposeChallengeFields(request,digest,challenge,expiresAt);}
function signedPayload(request:ModelPurposeRequest,challenge:string,challengeMac:string,expiresAt:number){return {version:1,request,requestDigest:modelPurposeDigest(request),challenge,challengeMac,expiresAt};}
export function signModelPurposeRequest(key:Buffer,request:ModelPurposeRequest,challenge:string,challengeMac:string,expiresAt:number):string{
  if(!requestIsValid(request)||!/^[A-Za-z0-9_-]{43}$/.test(challenge)||!/^[A-Za-z0-9_-]{43}$/.test(challengeMac)||!Number.isSafeInteger(expiresAt))throw deny();
  const expectedChallenge=modelPurposeMac(key,challengeFields(request,modelPurposeDigest(request),challenge,expiresAt));if(!equalMac(challengeMac,expectedChallenge))throw deny();
  const payload=signedPayload(request,challenge,challengeMac,expiresAt),fields=modelPurposeConsoleRequestFields(request,payload.requestDigest,modelPurposeDigest(payload));
  return `${Buffer.from(canonical(payload)).toString('base64url')}.${modelPurposeMac(key,fields).toString('base64url')}`;
}
function verifySignedRequest(key:Buffer,state:ModelPurposeBrokerState,capsule:unknown,receipt:unknown,identity:{agent:string;incarnation:string},currentTime=Date.now()){
  if(typeof capsule!=='string'||capsule.length>12_000)throw deny();const parts=capsule.split('.');if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0]!)||!/^[A-Za-z0-9_-]{43}$/.test(parts[1]!))throw deny();
  const payload=object(JSON.parse(Buffer.from(parts[0]!,'base64url').toString('utf8'))),request=payload.request as ModelPurposeRequest,digest=payload.requestDigest,challenge=payload.challenge,challengeMac=payload.challengeMac,expiresAt=payload.expiresAt;
  if(payload.version!==1||!requestIsValid(request)||typeof digest!=='string'||typeof challenge!=='string'||typeof challengeMac!=='string'||typeof expiresAt!=='number'||!Number.isSafeInteger(expiresAt))throw deny();const fields=modelPurposeConsoleRequestFields(request,digest,modelPurposeDigest(payload));
  if(!equalMac(parts[1],modelPurposeMac(key,fields))||!equalMac(challengeMac,modelPurposeMac(key,challengeFields(request,digest,challenge,expiresAt)))||request.agent!==identity.agent||request.incarnation!==identity.incarnation||digest!==modelPurposeDigest(request)||expiresAt<=currentTime)throw deny();
  const r=object(receipt);if(r.method!==request.method||r.path!==request.path||r.rawBodyHash!==request.rawBodyHash||r.requestId!==request.requestId||r.purpose!==request.purpose||canonical(r.resume??undefined)!==canonical(request.resume))throw deny();
  const consumed=state.consumeChallenge(challenge,request,digest);if(consumed.expiresAt!==expiresAt)throw deny();return {request,digest};
}

type SocketState={clients:Set<Socket>;inFlight:number};
export function createBoundedModelPurposeServer(handler:(line:string,signal:AbortSignal)=>Promise<Record<string,unknown>>,state:SocketState,limit=FRAME_LIMIT){
  return createServer(socket=>{if(state.clients.size>=MAX_CLIENTS||state.inFlight>=MAX_CLIENTS){socket.destroy();return;}state.clients.add(socket);let handled=false,buffer=Buffer.alloc(0);const controller=new AbortController(),deadline=setTimeout(()=>{controller.abort();socket.destroy();},2000);socket.on('error',()=>{});socket.on('close',()=>{controller.abort();clearTimeout(deadline);state.clients.delete(socket);});socket.on('data',chunk=>{if(handled){socket.destroy();return;}buffer=Buffer.concat([buffer,chunk]);if(buffer.length>limit){socket.destroy();return;}const end=buffer.indexOf(10);if(end<0)return;if(end!==buffer.length-1){socket.destroy();return;}handled=true;state.inFlight++;const line=buffer.subarray(0,end).toString('utf8');void handler(line,controller.signal).then(result=>{if(!controller.signal.aborted&&!socket.destroyed)socket.end(JSON.stringify({ok:true,...result})+'\n');}).catch(()=>{if(!controller.signal.aborted&&!socket.destroyed)socket.end('{"ok":false}\n');}).finally(()=>{state.inFlight--;});});});
}

type KeyPolicy={uid:number;gid:number;mode:number};
async function verifyProtectedParents(path:string,ownerUid:number){
  if(!isAbsolute(path))throw deny();
  const parts=path.split('/').filter(Boolean);let current='/';
  for(const part of parts){
    current=join(current,part);const st=await lstat(current);
    const rootSticky=st.uid===0&&(st.mode&0o1000)!==0;
    const writableByOthers=(st.mode&0o022)!==0;
    if(st.isSymbolicLink()||!st.isDirectory()||(st.uid!==ownerUid&&st.uid!==0)||(writableByOthers&&!rootSticky))throw deny();
  }
}
async function protectedKey(path:string,parentUid:number,policy:KeyPolicy,afterOpen?:()=>void|Promise<void>){
  await verifyProtectedParents(dirname(path),parentUid);
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    await afterOpen?.();
    const st=await handle.stat();
    if(!st.isFile()||st.nlink!==1||st.uid!==policy.uid||st.gid!==policy.gid||(st.mode&0o777)!==policy.mode||st.size>1024)throw deny();
    const value=(await handle.readFile('utf8')).trim();
    if(!/^[a-f0-9]{64}$/.test(value))throw deny();
    return Buffer.from(value,'hex');
  }finally{await handle.close();}
}
/** Keeper-internal access to the same protected per-agent key used by runtime control.
 * The path is derived from the configured secrets directory and a validated runtime name. */
export async function readModelPurposeRuntimeControlKey(
  runtimeSecretsDir:string, agent:string,
  options:{rootUid?:number;runtimeKeyUid?:number;runtimeKeyGid?:number}={},
):Promise<Buffer>{
  if(!/^[a-z][a-z0-9-]{1,30}$/.test(agent))throw deny();
  const rootUid=options.rootUid??0;
  return protectedKey(join(runtimeSecretsDir,`${agent}-runtime-control`),rootUid,
    {uid:options.runtimeKeyUid??rootUid,gid:options.runtimeKeyGid??10001,mode:0o440});
}
async function prepareSocketDirectory(path:string,rootUid:number,socketGid:number){if(!isAbsolute(path))throw deny();let cursor='/';for(const part of path.split('/').filter(Boolean)){cursor=join(cursor,part);try{const st=await lstat(cursor);if(st.isSymbolicLink()||!st.isDirectory())throw deny();}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')break;throw deny();}}await mkdir(path,{recursive:true,mode:0o750});cursor='/';for(const part of path.split('/').filter(Boolean)){cursor=join(cursor,part);const st=await lstat(cursor);if(st.isSymbolicLink()||!st.isDirectory())throw deny();}let st=await lstat(path);if(st.uid!==rootUid)throw deny();await chown(path,rootUid,socketGid);await chmod(path,0o750);st=await lstat(path);if(st.uid!==rootUid||(st.mode&0o777)!==0o750)throw deny();}
async function removeStaleSocket(path:string,rootUid:number){try{const st=await lstat(path);if(!st.isSocket()||st.uid!==rootUid)throw deny();const live=await new Promise<boolean>(resolve=>{const c=createConnection(path);c.setTimeout(300,()=>{c.destroy();resolve(false);});c.once('connect',()=>{c.destroy();resolve(true);});c.once('error',(e:NodeJS.ErrnoException)=>resolve(e.code!=='ECONNREFUSED'));});if(live)throw deny();await unlink(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw deny();}}
async function listen(server:ReturnType<typeof createServer>,path:string,uid:number,gid:number){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{server.off('error',reject);resolve();});});await chown(path,uid,gid);await chmod(path,0o660);const st=await lstat(path);if(!st.isSocket()||st.uid!==uid||st.gid!==gid||(st.mode&0o777)!==0o660)throw deny();}
async function closeServer(server:ReturnType<typeof createServer>){
  if(!server.listening)return;
  await new Promise<void>(resolve=>{try{server.close(()=>resolve());}catch{resolve();}});
}
function runtimeFields(req:RuntimeEnvelope,_input:Record<string,unknown>):MacFields{
  if(typeof req.agent!=='string'||!/^[a-z][a-z0-9-]{1,30}$/.test(req.agent)||typeof req.incarnation!=='string'||!/^[a-f0-9-]{36}$/.test(req.incarnation)||typeof req.requestId!=='string'||!/^[A-Za-z0-9_-]{32,64}$/.test(req.requestId)||typeof req.op!=='string'||!validDigest(req.outcomeDigest)||!validDigest(req.payloadDigest))throw deny();
  try{return modelPurposeRuntimeRequestFields(req);}catch{throw deny();}
}
function signedAck(key:Buffer,req:RuntimeEnvelope,input:Record<string,unknown>,result:Record<string,unknown>){runtimeFields(req,input);const fields=modelPurposeAckFields(req,result);return {...result,responseMac:modelPurposeMac(key,fields).toString('base64url'),responseRequestDigest:fields.requestDigest,responseOutcomeDigest:fields.outcomeDigest,responsePayloadDigest:fields.payloadDigest};}

/** Start the independent Keeper broker for Console receipts and chief runtime claims. */
export async function serveModelPurposeBroker(pool:SourcePool,options:ModelPurposeBrokerOptions,consumer?:{pool:Pool;writer:BudgetFinancialWriter}):Promise<()=>Promise<void>>{
  const rootUid=options.rootUid??0,socketUid=options.socketUid??rootUid,socketGid=options.socketGid??10001,now=options.now??Date.now;
  const consoleSocket=options.consoleSocket??DEFAULT_CONSOLE_SOCKET,runtimeSocket=options.runtimeSocket??DEFAULT_RUNTIME_SOCKET;
  const consoleKeyPolicy={uid:options.consoleKeyUid??rootUid,gid:options.consoleKeyGid??10001,mode:0o440};
  const signingKey=await protectedKey(options.consoleSigningKeyFile,rootUid,consoleKeyPolicy,()=>options.afterKeyOpenForTests?.(options.consoleSigningKeyFile));
  const runtimeKeyPolicy={uid:options.runtimeKeyUid??rootUid,gid:options.runtimeKeyGid??10001,mode:0o440};
  const state=new ModelPurposeBrokerState(now),clients=new Set<Socket>(),socketState:SocketState={clients,inFlight:0};
  // Resolver is bound once to this broker's private claim registry. No per-request
  // callback or remote object can establish source authority.
  const purposeStore=consumer?new PgBudgetAdmissionStore(consumer.pool,process.env,30_000,consumer.writer,handle=>state.resolveConsumedClaim(handle)):undefined;
  async function runtimeKey(agent:string){const path=join(options.runtimeSecretsDir,`${agent}-runtime-control`);return protectedKey(path,rootUid,runtimeKeyPolicy,()=>options.afterKeyOpenForTests?.(path));}
  async function assertCurrentDefinition(db:SourceDatabase,request:ModelPurposeRequest){
    const row=await db.query("SELECT d.hash,d.definition->>'model' AS purpose_alias FROM agent_resources r JOIN agent_definitions d ON d.name=r.name WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token AND r.state='ready' AND NOT r.pending AND d.status='valid' FOR SHARE OF r,d",[request.agent,request.incarnation]);
    const alias=row.rows[0]?.purpose_alias;
    if(row.rows.length!==1||row.rows[0]!.hash!==request.definitionHash||typeof alias!=='string'||! /^[a-z][a-z0-9-]{1,63}$/.test(alias))throw deny();
    return alias as string;
  }
  const runtimeEnv=(agent:string,incarnation:string):NodeJS.ProcessEnv=>({...process.env,LARES_AGENT_NAME:agent,LARES_AGENT_INCARNATION:incarnation});
  async function consoleHandle(line:string,signal:AbortSignal){
    const req=object(JSON.parse(line));
    if(req.op!=='request.challenge'||!requestIsValid(req.input)||signal.aborted)throw deny();
    const request=req.input,deadlineAtMs=now()+1500;
    await consoleSourceTransaction(pool,async db=>{
      const binding=await requireConsoleSessionBinding({agent:request.agent,incarnation:request.incarnation,sessionId:request.session,memberId:request.member,admissionNonce:request.admissionNonce},db as never);
      if(binding.policyRevision!==request.policyRevision)throw deny();
      await assertCurrentDefinition(db as SourceDatabase,request);
    },undefined,{deadlineAtMs});
    if(signal.aborted)throw deny();
    const issued=state.challenge(request);
    return {...issued,challengeMac:modelPurposeMac(signingKey,challengeFields(request,issued.requestDigest,issued.challenge,issued.expiresAt)).toString('base64url')};
  }
  async function runtimeHandle(line:string,signal:AbortSignal){
    const deadlineAtMs=now()+1700,req=object(JSON.parse(line)) as unknown as RuntimeEnvelope,input=object(req.input),fields=runtimeFields(req,input);
    const key=await runtimeKey(String(req.agent));
    const signed=equalMac(req.mac,modelPurposeMac(key,fields));
    const fresh=typeof req.timestamp==='number'&&Number.isSafeInteger(req.timestamp)&&Math.abs(now()-req.timestamp)<=30_000;
    if(!signed||!fresh)throw deny();
    state.burnRequest(String(req.requestId));
    if(signal.aborted)throw deny();
    if(req.op==='request.admit'){
      const admitted=verifySignedRequest(signingKey,state,input.capsule,input.receipt,{agent:String(req.agent),incarnation:String(req.incarnation)},now());
      await consoleSourceTransaction(pool,async db=>{
        const binding=await requireConsoleSessionBinding({agent:admitted.request.agent,incarnation:admitted.request.incarnation,sessionId:admitted.request.session,memberId:admitted.request.member,admissionNonce:admitted.request.admissionNonce},db as never);
        if(binding.policyRevision!==admitted.request.policyRevision)throw deny();
        await assertCurrentDefinition(db as SourceDatabase,admitted.request);
      },undefined,{deadlineAtMs});
      if(signal.aborted)throw deny();
      return signedAck(key,req,input,state.pendingReceipt(admitted.request,admitted.digest));
    }
    if(req.op==='turn.open'){
      const handle=input.pendingReceipt;
      if(typeof handle!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(handle))throw deny();
      const context=parseContext(input.context),session=context.session!;
      const admission=consoleAdmission(session.auth?.current)??consoleAdmission(session.auth?.initiator);
      if(!admission)throw deny();
      const pending=state.consumePending(handle,{agent:String(req.agent),incarnation:String(req.incarnation),session:String(session.id),member:admission.memberId,admissionNonce:admission.admissionNonce});
      if(session.id!==pending.request.session||admission.memberId!==pending.request.member||admission.admissionNonce!==pending.request.admissionNonce)throw deny();
      const turnId=session.turn!.id!,sequence=session.turn!.sequence!;
      if(pending.request.purpose==='human'&&turnId==='')throw deny();
      let reference!:BudgetAuthorityReference,purposeAlias='';
      const env=runtimeEnv(String(req.agent),String(req.incarnation));
      await consoleSourceTransaction(pool,async db=>{
        reference=await captureBudgetAuthorityReference(db as SourceDatabase,context,env);
        if(reference.binding.agent!==pending.request.agent||reference.binding.incarnation!==pending.request.incarnation||reference.binding.sessionId!==pending.request.session||reference.binding.memberId!==pending.request.member||reference.binding.admissionNonce!==pending.request.admissionNonce||!resumeMatches(pending.request,reference))throw deny();
        purposeAlias=await assertCurrentDefinition(db as SourceDatabase,pending.request);
      },undefined,{deadlineAtMs});
      if(signal.aborted)throw deny();
      return signedAck(key,req,input,state.registerTurn(pending.request,reference,turnId,sequence,pending.request.definitionHash,purposeAlias));
    }
    if(req.op==='step.claim'){
      const step={turnCapability:input.turnCapability,purposeAlias:input.purposeAlias,event:input.event} as ModelPurposeStepInput;
      if(typeof step.turnCapability!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(step.turnCapability)||req.outcomeDigest!==EMPTY_DIGEST||req.payloadDigest!==modelPurposeDigest(step.event))throw deny();
      const reserved=state.reserveStep(step.turnCapability,{agent:String(req.agent),incarnation:String(req.incarnation)},step);
      const env=runtimeEnv(String(req.agent),String(req.incarnation));let authorityDeadlineMs:number|null=null;
      await consoleSourceTransaction(pool,async db=>{
        const validUntil=await validateBudgetAuthorityReference(db as SourceDatabase,reserved.turn.reference,env);
        const purposeAlias=await assertCurrentDefinition(db as SourceDatabase,reserved.turn.request);
        if(purposeAlias!==reserved.turn.purposeAlias||purposeAlias!==step.purposeAlias)throw deny();
        if(validUntil!==null){
          retainSourceTransactionDeadline(db,validUntil);
          await checkConsoleSourceDeadlines(db);
          const deadline=(await db.query('SELECT floor(extract(epoch from $1::timestamptz)*1000)::bigint AS ms',[validUntil])).rows[0]?.ms;
          authorityDeadlineMs=Number(deadline);
          if(!Number.isSafeInteger(authorityDeadlineMs))throw deny();
        }
      },undefined,{deadlineAtMs});
      if(signal.aborted)throw deny();
      return signedAck(key,req,input,state.finishStep(reserved,authorityDeadlineMs));
    }
    if(req.op==='step.consume'){
      if(req.outcomeDigest!==EMPTY_DIGEST||req.payloadDigest!==modelPurposeDigest(input)||
        typeof input.claim!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.claim))throw deny();
      const request=object(input.request);
      if(Object.keys(request).sort().join(',')!=='method,path,requestHash'||request.method!=='POST'||typeof request.path!=='string'||!validDigest(request.requestHash))throw deny();
      const handle=state.reserveClaimConsumption(input.claim,{agent:String(req.agent),incarnation:String(req.incarnation)},request as unknown as GatewayModelRequestIdentity);
      if(!purposeStore)throw deny();
      const prepared=await purposeStore.prepareModelPurposeIntent(handle,request as unknown as GatewayModelRequestIdentity,signal);
      if(signal.aborted||prepared.expiresAt<=now()||!state.resolveConsumedClaim(handle))throw deny();
      return signedAck(key,req,input,prepared);
    }
    if(req.op==='turn.close'){
      if(typeof input.turnCapability!=='string'||typeof input.turnId!=='string'||!Number.isSafeInteger(input.sequence))throw deny();
      const result=state.closeTurn(input.turnCapability,{agent:String(req.agent),incarnation:String(req.incarnation)},input.turnId,Number(input.sequence));
      return signedAck(key,req,input,result);
    }
    throw deny();
  }
  const consoleServer=createBoundedModelPurposeServer(consoleHandle,socketState,16_384),runtimeServer=createBoundedModelPurposeServer(runtimeHandle,socketState,FRAME_LIMIT);
  try{
    await prepareSocketDirectory(dirname(consoleSocket),rootUid,socketGid);
    await removeStaleSocket(consoleSocket,rootUid);
    await listen(consoleServer,consoleSocket,socketUid,socketGid);
    await options.afterListenForTests?.('console');
    await prepareSocketDirectory(dirname(runtimeSocket),rootUid,socketGid);
    await removeStaleSocket(runtimeSocket,rootUid);
    await listen(runtimeServer,runtimeSocket,socketUid,socketGid);
    await options.afterListenForTests?.('runtime');
  }catch(error){
    for(const client of clients)client.destroy();
    await Promise.all([closeServer(consoleServer),closeServer(runtimeServer)]);
    throw error;
  }
  return async()=>{for(const client of clients)client.destroy();await Promise.all([new Promise<void>(resolve=>consoleServer.close(()=>resolve())),new Promise<void>(resolve=>runtimeServer.close(()=>resolve()))]);};
}
