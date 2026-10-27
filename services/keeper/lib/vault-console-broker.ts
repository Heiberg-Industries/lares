import { createConnection, createServer, type Socket } from 'node:net';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { chmod, chown, lstat, mkdir, unlink, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { authorityTransaction, requireConsoleSessionBinding, type AuthorityPool } from '@lares/agent-kit/console-turn-authority';
import { consoleSourceTransaction } from '@lares/agent-kit/console-source-transaction';
import { captureConsoleVaultSources, withConsoleVaultSourceRead } from '@lares/agent-kit/console-turn-authority';
import { definitionSchema, hashOf, parseDefinition } from '@lares/agent-kit/definition';
import { canWriteVaultArea, grantedVaultAreas } from '@lares/agent-kit/manifest';
import { currentMember } from '@lares/agent-kit/member-store';
import { PgGrantStore } from '@lares/agent-kit/grant-store';
import { PgVaultStore } from '@lares/agent-kit/vault-area-store';
import { GuardedVaultFiles, type VaultFilesBackings } from '@lares/agent-kit/vault-files';
import { NoteNotFoundError, visibleTo, type Reader, type StoreName } from '@lares/agent-kit/notes-store';
import { boundText, DEFAULT_READ_LIMIT } from '@lares/agent-kit/bounded-text';
import { payloadFingerprint } from '@lares/agent-kit/approval-ledger';
import { turnAuthoritySchema, vaultWriteBindingSchema } from '@lares/agent-kit/authority-contract';
import { VaultTracksHome, type TrackFileWriter } from '@lares/agent-kit/tracks';
import type { OutsideCustodyStore, OutsideToolCallInput } from './outside-custody.js';
import { loadVaultStorageInventory, verifyVaultStorageMetadata } from '@lares/agent-box/lib/vault-storage.js';

const SOCKET='/run/lares/vault-console.sock', CONSOLE_LIMIT=16_384, RUNTIME_LIMIT=256*1024, CHALLENGE_MS=10_000, PENDING_MS=30_000, MAX_LIVE=4096;
type Input={agent:string;incarnation:string;session:string;member:string;admissionNonce:string;method:string;path:string;rawBodyHash:string;policyRevision:number;definitionHash:string};
type Challenge={input:Input;challenge:string;expiry:number};
type Pending={input:Input;expiry:number};
type Capsule=Input & {version:1;purpose:'human';challenge:string;nonce:string;expiry:number};
type SessionDefinitionMaterial={definition:ReturnType<typeof definitionSchema.parse>;dutiesMd:string;voiceMd:string;hash:string};
type Turn={input:Input;turnId:string;sequence:number;definition:SessionDefinitionMaterial;areaIds:string[];expiry:number};
export interface VaultBrokerSocketOptions {consoleSocket?:string;rootUid?:number;socketUid?:number;socketGid?:number;turnClockForTests?:()=>number;
 vaultFilesForTests?:{root:string;originRoot:string};outsideCustody?:Pick<OutsideCustodyStore,'dispatchApproved'>}
const challenges=new Map<string,Challenge>(),pending=new Map<string,Pending>(),runtimeRequests=new Map<string,number>();
const turns=new Map<string,Turn>();
function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error();return v as Record<string,unknown>}
type SocketState={clients:Set<Socket>;inFlight:number};
export function createBoundedVaultBrokerServer(handler:(line:string,signal:AbortSignal)=>Promise<Record<string,unknown>>,state:SocketState,limit=CONSOLE_LIMIT,timeoutMs=2000){
 return createServer(socket=>{if(state.clients.size>=32||state.inFlight>=32){socket.destroy();return;}state.clients.add(socket);let handled=false,buffer=Buffer.alloc(0);const controller=new AbortController(),deadline=setTimeout(()=>{controller.abort();socket.destroy()},timeoutMs);socket.on('error',()=>{});socket.on('close',()=>{controller.abort();clearTimeout(deadline);state.clients.delete(socket)});socket.on('data',chunk=>{
  if(handled){socket.destroy();return;}buffer=Buffer.concat([buffer,chunk]);if(buffer.length>limit){socket.destroy();return;}const end=buffer.indexOf(10);if(end<0)return;if(end!==buffer.length-1){socket.destroy();return;}handled=true;state.inFlight++;const line=buffer.subarray(0,end).toString('utf8');void handler(line,controller.signal).then(result=>{if(!controller.signal.aborted&&!socket.destroyed)socket.end(JSON.stringify({ok:true,...result})+'\n')}).catch(()=>{if(!controller.signal.aborted&&!socket.destroyed)socket.end('{"ok":false}\n')}).finally(()=>{state.inFlight--;});
 });});
}
function isInput(v:unknown):v is Input {
 const x=v as Input;return !!x&&typeof x==='object'&&/^[a-z][a-z0-9-]{1,30}$/.test(x.agent)&&/^[a-f0-9-]{36}$/.test(x.incarnation)&&/^[A-Za-z0-9_-]{1,64}$/.test(x.session)&&typeof x.member==='string'&&x.member.length>0&&x.member.length<=256&&/^[A-Za-z0-9_-]{43}$/.test(x.admissionNonce)&&x.method==='POST'&&/^\/eve\/v1\/session\/[A-Za-z0-9_-]{1,64}$/.test(x.path)&&/^[a-f0-9]{64}$/.test(x.rawBodyHash)&&Number.isSafeInteger(x.policyRevision)&&x.policyRevision>0&&/^[a-f0-9]{64}$/.test(x.definitionHash);
}
function prune(now=Date.now(),turnNow=Date.now()){for(const [k,v] of challenges)if(v.expiry<=now)challenges.delete(k);for(const [k,v] of pending)if(v.expiry<=now)pending.delete(k);for(const [k,v] of turns)if(v.expiry<=turnNow)turns.delete(k);for(const [k,v] of runtimeRequests)if(v<=now)runtimeRequests.delete(k);if(challenges.size>MAX_LIVE||pending.size>MAX_LIVE||turns.size>MAX_LIVE||runtimeRequests.size>MAX_LIVE)throw new Error('capacity');}
async function keyFile(path:string):Promise<Buffer>{const value=(await readFile(path,'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(value))throw new Error('key');return Buffer.from(value,'hex')}
/** Prepare only Keeper's exact, dedicated socket directory. It is safe to create empty even
 *  without signing-key custody: agents then start normally and their Vault calls fail closed. */
export async function prepareVaultRuntimeDirectory(path:string,rootUid=0,socketGid=10001):Promise<void>{
 if(!isAbsolute(path))throw new Error('keeper: Vault runtime directory unavailable');
 let cursor='/';
 for(const part of path.split('/').filter(Boolean)){
  cursor=join(cursor,part);
  try{const ancestor=await lstat(cursor);if(ancestor.isSymbolicLink()||!ancestor.isDirectory())throw new Error('keeper: Vault runtime directory unavailable');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw new Error('keeper: Vault runtime directory unavailable');}
 }
 try{await mkdir(path,{recursive:true,mode:0o750});}catch{throw new Error('keeper: Vault runtime directory unavailable');}
 cursor='/';
 for(const part of path.split('/').filter(Boolean)){cursor=join(cursor,part);const ancestor=await lstat(cursor);if(ancestor.isSymbolicLink()||!ancestor.isDirectory())throw new Error('keeper: Vault runtime directory unavailable');}
 const st=await lstat(path);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==rootUid)throw new Error('keeper: Vault runtime directory unavailable');
 await chown(path,rootUid,socketGid);await chmod(path,0o750);
 const verified=await lstat(path);if(!verified.isDirectory()||verified.isSymbolicLink()||verified.uid!==rootUid||(verified.mode&0o777)!==0o750)throw new Error('keeper: Vault runtime directory unavailable');
}
function mac(key:Buffer,text:string){return createHmac('sha256',key).update(text).digest()}
async function current(pool:AuthorityPool,input:Input,deadlineAtMs:number):Promise<boolean>{
 return authorityTransaction(pool,async db=>{
  const binding=await requireConsoleSessionBinding({agent:input.agent,incarnation:input.incarnation,sessionId:input.session,memberId:input.member,admissionNonce:input.admissionNonce},db);
  if(binding.policyRevision!==input.policyRevision)return false;
  const row=await db.query("SELECT hash FROM agent_definitions WHERE name=$1 AND status='valid'",[input.agent]);
  return row.rows.length===1&&row.rows[0]!.hash===input.definitionHash;
 },{deadlineAtMs});
}
function same(a:Input,b:Input){return Object.keys(a).every(k=>(a as any)[k]===(b as any)[k])}
const TRACK_WRITE_TOOLS = new Set(['track_add_item','track_move_item','track_create','track_set_steps']);
function trackHomePath(path:unknown):path is string{return typeof path==='string'&&/^tracks\/[a-z0-9][a-z0-9-]{0,62}\/(?:track\.md|items\/[a-z0-9][a-z0-9-]{0,62}\.md)$/.test(path)}
function trackTargetPath(tool:string,raw:unknown,reserved:unknown):string{
 const target=object(reserved),i=object(raw),path=target.id;
 if(typeof path!=='string'||!trackHomePath(path)||typeof target.ownerMemberId!=='string')throw new Error('approval');
 if((tool==='track_create'||tool==='track_set_steps'||tool==='track_add_item')&&path!==`tracks/${String(i.trackId)}/track.md`)throw new Error('approval');
 if(tool==='track_move_item'&&path!==`tracks/${String(i.trackId)}/items/${String(i.itemId)}.md`)throw new Error('approval');
 if(tool==='track_add_item'||tool==='track_move_item'){
  if(typeof i.home!=='string'||!/^vault:[A-Za-z0-9_-]{1,128}$/.test(i.home)||typeof i.trackId!=='string'||! /^[a-z0-9][a-z0-9-]{0,62}$/.test(i.trackId))throw new Error('approval');
 }
 return path;
}
async function trackArea(db:AuthorityPool,agent:string,incarnation:string,proof:Record<string,unknown>,operation:string,rawInput:unknown,
 lockApproval=false,claimed=false,use?:(client:any,meta:any)=>Promise<unknown>):Promise<any>{
 const sessionId=proof.sessionId,memberId=proof.memberId,nonce=proof.admissionNonce,approval=object(proof.approval),requestId=approval.requestId,callId=approval.callId,tool=approval.toolName;
 if(typeof sessionId!=='string'||typeof memberId!=='string'||typeof nonce!=='string'||typeof requestId!=='string'||typeof callId!=='string'||typeof tool!=='string'||
   !TRACK_WRITE_TOOLS.has(tool)||tool!==operation||payloadFingerprint(tool,rawInput)!==approval.payloadHash||payloadFingerprint(tool,rawInput)!==payloadFingerprint(tool,approval.input))throw new Error('approval');
 const target=object(approval.target),path=trackTargetPath(tool,rawInput,target);
 const raw=object(rawInput),requestedArea=tool==='track_add_item'||tool==='track_move_item'?String(raw.home).slice('vault:'.length):undefined;
 const execution=await authorityTransaction(db,async client=>{
  const rows=await client.query(`SELECT call_id,request_id,agent,tool,payload_hash,original_authority,acting_member_id,resolved_by_member_id,session_id,outcome,used_at
    FROM approval_asks WHERE call_id=$1 ${lockApproval?'FOR UPDATE':''}`,[callId]);
  if(rows.rows.length!==1)throw new Error('approval');const row=rows.rows[0] as Record<string,any>;
  const reservation=object(row.original_authority),original=turnAuthoritySchema.parse(reservation.original),storedTarget=object(reservation.target);
  const suppliedAuthority=turnAuthoritySchema.parse(approval.authority),expectedAuthority=turnAuthoritySchema.parse({...original,origin:'approval-resume',
   actingMemberId:memberId,resolvedByMemberId:memberId,requestId});
  const expiry=Date.parse(String(reservation.expiresAt)),admissionHash=payloadFingerprint('admission',nonce);
  if(row.request_id!==requestId||row.agent!==agent||row.tool!==tool||row.payload_hash!==payloadFingerprint(tool,rawInput)||row.outcome!=='approved'||
     row.resolved_by_member_id!==memberId||row.acting_member_id!==memberId||row.session_id!==sessionId||original.origin!=='human'||
     original.agentId!==agent||original.sessionId!==sessionId||original.actingMemberId!==memberId||original.spokenByMemberId!==memberId||storedTarget.ownerMemberId!==memberId||
     payloadFingerprint('authority',suppliedAuthority)!==payloadFingerprint('authority',expectedAuthority)||
     payloadFingerprint('approval-target',storedTarget)!==payloadFingerprint('approval-target',target)||reservation.incarnation!==incarnation||
     reservation.admissionHash!==admissionHash||!Number.isFinite(expiry)||expiry<=Date.now()||
     (lockApproval&&row.used_at!==null)||(!lockApproval&&!claimed&&row.used_at!==null)||(claimed&&row.used_at===null))throw new Error('approval');
  const currentBinding=await requireConsoleSessionBinding({agent,incarnation,sessionId,memberId,admissionNonce:nonce},client);
  if(currentBinding.placeId!==original.placeId||currentBinding.audienceRevision!==original.audience.revision||currentBinding.policyRevision!==original.policyRevision)throw new Error('approval');
  const defRows=await client.query(`SELECT r.applied_definition,a.hash FROM agent_resources r JOIN agent_definitions a ON a.name=r.name
    WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token AND r.state='ready' AND NOT r.pending
    AND a.status='valid' AND r.applied_definition IS NOT NULL FOR SHARE OF r,a`,[agent,incarnation]);
  if(defRows.rows.length!==1)throw new Error('policy');const definition=parseDefinition(defRows.rows[0]!.applied_definition);
  if(!canWriteVaultArea(definition,'shared')||payloadFingerprint('tracks-write-policy-v1',{definition,hash:defRows.rows[0]!.hash})!==reservation.policyHash)throw new Error('policy');
  if(!['agent','synced','third_party'].includes(String(storedTarget.approvedOrigin)))throw new Error('approval');
  const member=await currentMember(client as never,memberId);if(!member)throw new Error('member');
  const inventory=loadVaultStorageInventory();await verifyVaultStorageMetadata(client as never,inventory,true);
  const areaRows=await client.query("SELECT id,revision FROM vault_areas WHERE organisation_id=$1 AND kind='shared' AND status='active' ORDER BY id LIMIT 513",[member.organisationId]);
  if(areaRows.rows.length>512)throw new Error('areas');const vault=new PgVaultStore(),matches=[] as {areaId:string;revision:number}[];
  for(const area of areaRows.rows){if(!inventory.areas.some(x=>x.areaId===area.id&&x.kind==='shared'))throw new Error('inventory');
   const binding=await vault.vaultAreaBinding(memberId,{areaId:String(area.id),expectedRevision:Number(area.revision),permission:'edit'},{db:client as never,requiredBackingKind:'git'});
   if(binding)matches.push({areaId:String(area.id),revision:Number(area.revision)});
  }
  if(matches.length!==1||(requestedArea!==undefined&&matches[0]!.areaId!==requestedArea))throw new Error('area');
  if(lockApproval){const used=await client.query("UPDATE approval_asks SET used_at=clock_timestamp(),use_count=use_count+1 WHERE call_id=$1 AND request_id=$2 AND outcome='approved' AND used_at IS NULL RETURNING call_id",[callId,requestId]);if(used.rows.length!==1)throw new Error('replay');}
  const authority={...original,origin:'approval-resume',actingMemberId:memberId,resolvedByMemberId:memberId,requestId};
  const meta={sessionId,memberId,authority,targetPath:path,areaId:matches[0]!.areaId,revision:matches[0]!.revision,inventory};
  return use ? await use(client,meta) : meta;
 });
 return execution;
}
export async function serveConsoleVaultBroker(pool:AuthorityPool,consoleSigningKeyFile:string,runtimeSecretsDir:string,runtimeSocket:string,socketOptions:VaultBrokerSocketOptions={}):Promise<()=>Promise<void>>{
 if(socketOptions.vaultFilesForTests){const temporary=tmpdir()+sep,paths=[socketOptions.vaultFilesForTests.root,socketOptions.vaultFilesForTests.originRoot];
  if(process.env.NODE_ENV!=='test'||paths.some(path=>!isAbsolute(path)||!path.startsWith(temporary)||relative(temporary,path).startsWith('..')||path==='/srv'||path==='/var/lib'))throw new Error('test Vault paths refused');}
 const consoleSocket=socketOptions.consoleSocket??SOCKET,rootUid=socketOptions.rootUid??0,socketUid=socketOptions.socketUid??0,socketGid=socketOptions.socketGid??10001;
 const turnNow=socketOptions.turnClockForTests??Date.now;
 const clients=new Set<Socket>(),secret=await keyFile(consoleSigningKeyFile),socketState:SocketState={clients,inFlight:0};
 async function handle(line:string,signal:AbortSignal):Promise<Record<string,unknown>>{
  const deadlineAtMs=Date.now()+1700,assertLive=()=>{if(signal.aborted||Date.now()>=deadlineAtMs)throw new Error('deadline')};assertLive();const req=object(JSON.parse(line));prune();
  if(req.op==='challenge'){
   const input=req.input;if(!isInput(input)||!await current(pool,input,deadlineAtMs))throw new Error('authority');assertLive();
   const challenge=randomBytes(32).toString('base64url'),expiry=Date.now()+CHALLENGE_MS;
   prune();if(challenges.size>=MAX_LIVE)throw new Error('capacity');challenges.set(challenge,{input,challenge,expiry});return {challenge,expiry};
  }
  throw new Error('operation');
 }
 async function runtimeHandle(line:string,signal:AbortSignal):Promise<Record<string,unknown>>{
  const operation=object(JSON.parse(line)).op;
  const requestDeadline=Date.now()+(operation==='outside.execute'?8000:1700),transactionDeadline={deadlineAtMs:requestDeadline};
  const assertNotAborted=()=>{if(signal.aborted||Date.now()>=requestDeadline)throw new Error('deadline')};assertNotAborted();
  const req=object(JSON.parse(line)),agent=req.agent,incarnation=req.incarnation,requestId=req.requestId,timestamp=req.timestamp,op=req.op,input=object(req.input);
  if(typeof agent!=='string'||!/^[a-z][a-z0-9-]{1,30}$/.test(agent)||typeof incarnation!=='string'||!/^[a-f0-9-]{36}$/.test(incarnation)||typeof requestId!=='string'||!/^[A-Za-z0-9_-]{32,64}$/.test(requestId)||!Number.isSafeInteger(timestamp)||Math.abs(Date.now()-Number(timestamp))>30_000||typeof op!=='string'||typeof req.mac!=='string')throw new Error('identity');
  const token=(await readFile(join(runtimeSecretsDir,`${agent}-runtime-control`),'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(token))throw new Error('identity');
  const body=JSON.stringify({agent,incarnation,requestId,timestamp,op,input}),expected=mac(Buffer.from(token,'hex'),body),given=Buffer.from(req.mac,'base64url');
  prune(Date.now(),turnNow());if(given.length!==expected.length||!timingSafeEqual(given,expected)||runtimeRequests.has(requestId)||runtimeRequests.size>=MAX_LIVE)throw new Error('signature');
  runtimeRequests.set(requestId,Date.now()+60_000);
  const active=await authorityTransaction(pool,async db=>{await db.query("SELECT set_config('statement_timeout','1000ms',true)");await db.query("SELECT set_config('lock_timeout','500ms',true)");return db.query("SELECT 1 FROM agent_resources r JOIN agent_definitions d ON d.name=r.name WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token AND r.state='ready' AND NOT r.pending AND d.status='valid'",[agent,incarnation])},transactionDeadline);assertNotAborted();if(active.rows.length!==1)throw new Error('runtime');
  if(op==='outside.execute'){
   // The signed runtime identifies the agent; Keeper's admitted turn identifies the human.
   // Model arguments and copied receipt fields confer neither identity nor authority.
   const cap=input.turnCapability,turn=typeof cap==='string'?turns.get(cap):undefined;
   if(!turn||turn.input.agent!==agent||turn.input.incarnation!==incarnation||
      turn.turnId!==input.turnId||turn.sequence!==input.sequence||turn.input.session!==input.sessionId||
      turn.input.member!==input.memberId||turn.input.admissionNonce!==input.admissionNonce)throw new Error('turn');
   const assertCurrent=()=>{assertNotAborted();if(turns.get(cap as string)!==turn||turn.expiry<=turnNow())throw new Error('turn')};
   assertCurrent();
   const admitted=turn.input;
   if(!await current(pool,admitted,requestDeadline))throw new Error('authority');
   assertCurrent();
   const call=object(input.call) as unknown as OutsideToolCallInput;
   if(call.definitionHash!==admitted.definitionHash||!socketOptions.outsideCustody)throw new Error('outside');
   const result=await socketOptions.outsideCustody.dispatchApproved({agent:admitted.agent,incarnation:admitted.incarnation,
    sessionId:admitted.session,memberId:admitted.member,approverMemberId:admitted.member,admissionNonce:admitted.admissionNonce,policyRevision:admitted.policyRevision},call,{deadlineAtMs:requestDeadline,assertCurrent});
   assertCurrent();return {result};
  }
  if(op==='tracks.list-scheduled'){
   const expectedOwner=input.ownerMemberId,personId=input.personId;
   if(typeof expectedOwner!=='string'||expectedOwner.length<1||expectedOwner.length>256||
      (personId!==undefined&&(typeof personId!=='string'||personId.length<1||personId.length>256)))throw new Error('owner');
   return await authorityTransaction(pool,async db=>{
    await db.query("SELECT set_config('statement_timeout','1000ms',true)");await db.query("SELECT set_config('lock_timeout','500ms',true)");assertNotAborted();
    const rows=await db.query(`SELECT a.owner_member_id,a.organisation_id,r.applied_definition,d.status
      FROM agent_resources r JOIN agent_definitions d ON d.name=r.name JOIN agent_access a ON a.agent_name=r.name
      WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token
        AND r.state='ready' AND NOT r.pending AND d.status='valid' AND r.applied_definition IS NOT NULL
      FOR SHARE OF r,d,a`,[agent,incarnation]);
    if(rows.rows.length!==1||rows.rows[0]!.owner_member_id!==expectedOwner)throw new Error('owner');
    const ownerId=String(rows.rows[0]!.owner_member_id),member=await currentMember(db as never,ownerId);
    if(!member||member.organisationId!==rows.rows[0]!.organisation_id)throw new Error('member');
    if(!await new PgGrantStore().captureUse(ownerId,agent as string,{db:db as never}))throw new Error('grant');
    let definition;try{definition=parseDefinition(rows.rows[0]!.applied_definition);}catch{throw new Error('definition');}
    if(!grantedVaultAreas(definition).includes('shared'))throw new Error('vault read grant');
    const inventory=loadVaultStorageInventory();await verifyVaultStorageMetadata(db as never,inventory,true);assertNotAborted();
    const areaRows=await db.query("SELECT id,revision FROM vault_areas WHERE organisation_id=$1 AND kind='shared' AND status='active' ORDER BY id LIMIT 513",[member.organisationId]);
    if(areaRows.rows.length>512)throw new Error('areas');
    const vault=new PgVaultStore(),backingPaths=socketOptions.vaultFilesForTests;
    const backings:VaultFilesBackings=new Map([[inventory.backing.id,{kind:'git',root:backingPaths?.root??'/srv',areas:new Map(inventory.areas.map(a=>[a.areaId,{origin:backingPaths?join(backingPaths.originRoot,`${a.areaId}.git`):a.origin}]))}]]);
    const files=new GuardedVaultFiles(vault,backings),reader:Reader={userId:ownerId,store:'atlas'},homes=[] as Array<{home:string;tracks:Array<{track:unknown;items:unknown[]}>}>;
    for(const area of areaRows.rows){
     assertNotAborted();const areaId=String(area.id),revision=Number(area.revision);
     if(!inventory.areas.some(a=>a.areaId===areaId&&a.kind==='shared'))throw new Error('inventory');
     const binding=await vault.vaultAreaBinding(ownerId,{areaId,expectedRevision:revision,permission:'use'},{db:db as never,requiredBackingKind:'git'});
     assertNotAborted();if(!binding)continue;
     const ctx={memberId:ownerId,areaId,expectedRevision:revision,db:db as never};
     const writer:TrackFileWriter={
      async list(){const listed=await files.list(ctx);return listed.paths.filter(path=>/^tracks\/[a-z0-9][a-z0-9-]{0,62}\/(?:track\.md|items\/[a-z0-9][a-z0-9-]{0,62}\.md)$/.test(path));},
      async read(path){if(!/^tracks\/[a-z0-9][a-z0-9-]{0,62}\/(?:track\.md|items\/[a-z0-9][a-z0-9-]{0,62}\.md)$/.test(path))throw new Error('track path');
       try{const note=await files.read(ctx,path);if(!visibleTo(note.content,reader))return undefined;return {path,content:note.content,contentRevision:note.contentRevision};}
       catch(error){if(error instanceof NoteNotFoundError)return undefined;throw error;}},
      async write(){throw new Error('scheduled Vault tracks are read-only');},
     };
     const home=new VaultTracksHome(writer),tracks=await home.listTracks(),withItems=[];
     for(const track of tracks){assertNotAborted();withItems.push({track,items:personId?await home.listItems(track.id,{personId}):[]});}
     homes.push({home:`vault:${areaId}`,tracks:withItems});
    }
    assertNotAborted();return {ownerMemberId:ownerId,homes};
   },transactionDeadline);
  }
  if(op==='request.admit'){
   const capsule=input.capsule,receipt=object(input.receipt);if(typeof capsule!=='string'||typeof receipt.method!=='string'||typeof receipt.path!=='string'||typeof receipt.rawBodyHash!=='string')throw new Error('receipt');
   const parts=capsule.split('.');if(parts.length!==2||!/^[-_A-Za-z0-9]+$/.test(parts[0]!)||!/^[-_A-Za-z0-9]+$/.test(parts[1]!))throw new Error('capsule');
   const expectedCapsule=mac(secret,parts[0]!),givenCapsule=Buffer.from(parts[1]!,'base64url');if(givenCapsule.length!==expectedCapsule.length||!timingSafeEqual(givenCapsule,expectedCapsule))throw new Error('capsule');
   const parsed=object(JSON.parse(Buffer.from(parts[0]!,'base64url').toString('utf8'))) as unknown as Capsule,challenge=challenges.get(parsed.challenge);
   if(parsed.version!==1||parsed.purpose!=='human'||!isInput(parsed)||!challenge||challenge.expiry!==parsed.expiry||challenge.expiry<=Date.now()||!same(challenge.input,parsed)||parsed.agent!==agent||parsed.incarnation!==incarnation||parsed.method!==receipt.method||parsed.path!==receipt.path||parsed.rawBodyHash!==receipt.rawBodyHash)throw new Error('challenge');
   challenges.delete(parsed.challenge);if(!await current(pool,parsed,requestDeadline))throw new Error('authority');assertNotAborted();if(pending.size>=MAX_LIVE)throw new Error('capacity');
   const handle=randomBytes(32).toString('base64url'),expiry=Date.now()+PENDING_MS;pending.set(handle,{input:parsed,expiry});return {pendingReceipt:handle,expiry};
  }
  if(op==='turn.open'){
   const handle=input.pendingReceipt,sessionId=input.sessionId,memberId=input.memberId,admissionNonce=input.admissionNonce,turnId=input.turnId,sequence=input.sequence,definition=object(input.definition);
   if(typeof handle!=='string'||typeof sessionId!=='string'||typeof memberId!=='string'||typeof admissionNonce!=='string'||typeof turnId!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(turnId)||!Number.isSafeInteger(sequence)||typeof definition.hash!=='string'||typeof definition.dutiesMd!=='string'||typeof definition.voiceMd!=='string'||!('definition'in definition))throw new Error('turn');
   const admitted=consumePendingVaultReceipt(handle,{agent,incarnation,session:sessionId,member:memberId,admissionNonce});if(!admitted)throw new Error('receipt');
   const sessionDefinition={definition:definitionSchema.parse(definition.definition),dutiesMd:definition.dutiesMd,voiceMd:definition.voiceMd,hash:definition.hash};
   if(!/^[a-f0-9]{64}$/.test(sessionDefinition.hash)||hashOf(sessionDefinition as never)!==sessionDefinition.hash||sessionDefinition.hash!==admitted.input.definitionHash)throw new Error('definition');
   const authority=await authorityTransaction(pool,client=>requireConsoleSessionBinding({agent,incarnation,sessionId,memberId,admissionNonce},client),transactionDeadline);
   if(authority.policyRevision!==admitted.input.policyRevision)throw new Error('authority');
   const inventory=loadVaultStorageInventory(),store=new PgVaultStore();
   const grantedAreas=grantedVaultAreas(sessionDefinition.definition).filter(area=>area==='private'||area==='shared');
   const areaIds=await consoleSourceTransaction(pool as never,async client=>{
    await client.query("SET LOCAL statement_timeout='900ms'");await client.query("SET LOCAL lock_timeout='500ms'");await verifyVaultStorageMetadata(client as never,inventory,true);assertNotAborted();
    const member=await currentMember(client as never,memberId);assertNotAborted();if(!member)throw new Error('member');
    const rows=await client.query("SELECT id,revision FROM vault_areas WHERE organisation_id=$1 AND kind=ANY($2::text[]) AND status='active' ORDER BY id LIMIT 513",[member.organisationId,grantedAreas]);assertNotAborted();if(rows.rows.length>512)throw new Error('areas');const allowed:string[]=[];
    for(const row of rows.rows){assertNotAborted();if(!inventory.areas.some(a=>a.areaId===row.id))throw new Error('inventory');const binding=await store.vaultAreaBinding(memberId,{areaId:String(row.id),expectedRevision:Number(row.revision),permission:'use'},{db:client as never,requiredBackingKind:'git'});assertNotAborted();if(binding)allowed.push(String(row.id));}
    return allowed;
   },undefined,{deadlineAtMs:requestDeadline,beforeCommit:assertNotAborted,afterCommit:assertNotAborted});
   if(!areaIds.length)throw new Error('areas');
   assertNotAborted();await captureConsoleVaultSources({agent,incarnation,sessionId,memberId,admissionNonce},{sessionDefinition,areaIds},pool as never,process.env,transactionDeadline);assertNotAborted();
   assertNotAborted();const turnCapability=randomBytes(32).toString('base64url'),expiry=turnNow()+5*60_000;
   if(turns.size>=MAX_LIVE)throw new Error('capacity');turns.set(turnCapability,{input:admitted.input,turnId,sequence:sequence as number,definition:sessionDefinition,areaIds,expiry});return {turnCapability,expiresAt:expiry};
  }
  if(op==='turn.close'){
   const cap=input.turnCapability,turnId=input.turnId,sequence=input.sequence;if(typeof cap!=='string')throw new Error('turn');const turn=turns.get(cap);if(!turn||turn.turnId!==turnId||turn.sequence!==sequence||turn.input.agent!==agent||turn.input.incarnation!==incarnation)throw new Error('turn');turns.delete(cap);return {closed:true};
  }
  if(op==='vault.read'){
   const cap=input.turnCapability,turnId=input.turnId,sequence=input.sequence,sessionId=input.sessionId,memberId=input.memberId,admissionNonce=input.admissionNonce,operation=input.operation,area=input.area,path=input.path,offset=input.offset,requestedHome=input.home;
   if(typeof cap!=='string'||typeof turnId!=='string'||!Number.isSafeInteger(sequence)||typeof sessionId!=='string'||typeof memberId!=='string'||typeof admissionNonce!=='string'||(operation!=='list'&&operation!=='read')||(area!=='private'&&area!=='shared')||(operation==='read'&&typeof path!=='string')||(offset!==undefined&&(!Number.isSafeInteger(offset)||Number(offset)<0))||(requestedHome!==undefined&&(area!=='shared'||typeof requestedHome!=='string'||!/^vault:[A-Za-z0-9_-]{1,128}$/.test(requestedHome))))throw new Error('read');
   const turn=turns.get(cap);if(!turn||turn.expiry<=turnNow()||turn.turnId!==turnId||turn.sequence!==sequence||turn.input.agent!==agent||turn.input.incarnation!==incarnation||turn.input.session!==sessionId||turn.input.member!==memberId||turn.input.admissionNonce!==admissionNonce)throw new Error('turn');
   const assertLive=()=>{assertNotAborted();if(turns.get(cap)!==turn||turn.expiry<=turnNow())throw new Error('turn')};assertLive();
   const sourceReadOptions={deadlineAtMs:requestDeadline,beforeCommit:assertLive,afterCommit:assertLive};
   const result=await withConsoleVaultSourceRead({agent,incarnation,sessionId,memberId,admissionNonce},{sessionDefinition:turn.definition,areaIds:turn.areaIds},async(db)=>{
    assertLive();await db.query("SELECT set_config('statement_timeout','1000ms',true)");await db.query("SELECT set_config('lock_timeout','500ms',true)");
    const inventory=loadVaultStorageInventory();await verifyVaultStorageMetadata(db as never,inventory,true);assertLive();
    const member=await currentMember(db as never,memberId);assertLive();if(!member)throw new Error('member');
    const kind=area==='private'?'private':'shared',candidates=inventory.areas.filter(a=>a.kind===kind),vault=new PgVaultStore(),matches=[] as {areaId:string;revision:number}[];
    for(const candidate of candidates){if(!turn.areaIds.includes(candidate.areaId))continue;const result=await db.query('SELECT revision FROM vault_areas WHERE id=$1 AND status=\'active\'',[candidate.areaId]);if(result.rows.length!==1)continue;const revision=Number(result.rows[0]!.revision);const binding=await vault.vaultAreaBinding(memberId,{areaId:candidate.areaId,expectedRevision:revision,permission:'use'},{db:db as never,requiredBackingKind:'git'});if(binding)matches.push({areaId:candidate.areaId,revision});}
    if(matches.length!==1||(requestedHome!==undefined&&matches[0]!.areaId!==requestedHome.slice('vault:'.length)))throw new Error('area');const selected=matches[0]!,testPaths=socketOptions.vaultFilesForTests,backings=new Map([[inventory.backing.id,{kind:'git' as const,root:testPaths?.root??'/srv',areas:new Map(inventory.areas.map(a=>[a.areaId,{origin:testPaths?join(testPaths.originRoot,`${a.areaId}.git`):a.origin}]))}]]),files=new GuardedVaultFiles(vault,backings),ctx={memberId,areaId:selected.areaId,expectedRevision:selected.revision,db:db as never},reader:Reader={userId:memberId,store:kind==='private'?'brain':'atlas' as StoreName};
    if(operation==='list'){
     const listed=await files.list(ctx);if(listed.paths.length>512)throw new Error('listing');const notes:string[]=[];
     for(const notePath of listed.paths){assertLive();const note=await files.read(ctx,notePath);assertLive();if(visibleTo(note.content,reader))notes.push(notePath);}
     assertLive();
     return {notes,files:notes.length};
    }
    assertLive();const note=await files.read(ctx,path as string);assertLive();if(!visibleTo(note.content,reader))throw new Error('not found');const page=boundText(note.content,{limit:DEFAULT_READ_LIMIT,offset:Number(offset??0)});
    if(!page.truncated&&page.note===undefined&&(offset??0)===0)return note;
    return {...note,content:page.text,totalChars:page.totalChars,...(page.truncated?{truncated:true,nextOffset:page.nextOffset}:{}),...(page.note!==undefined?{note:page.note}:{})};
   },pool as never,process.env,sourceReadOptions) as Record<string,unknown>;assertLive();return result;
  }
  if(op==='tracks.write'){
   const action=input.operation,rawInput=input.input,approval=object(input.approval);
   if(typeof action!=='string'||!TRACK_WRITE_TOOLS.has(action)||!rawInput||typeof rawInput!=='object'||Array.isArray(rawInput))throw new Error('tracks');
   const proof={sessionId:input.sessionId,memberId:input.memberId,admissionNonce:input.admissionNonce,approval};
   const target=object(approval.target),targetPath=trackTargetPath(action,rawInput,target),prefix=`tracks/${targetPath.split('/')[1]}/`;
   const context=async<T>(claimed:boolean,write:boolean,use:(db:any,files:GuardedVaultFiles,ctx:{memberId:string;areaId:string;expectedRevision:number;db:any})=>Promise<T>)=>
    await trackArea(pool,agent as string,incarnation as string,proof,action,rawInput,write&&!claimed,claimed,async(db:any,meta:any)=>{
     assertNotAborted();const testPaths=socketOptions.vaultFilesForTests;
     const backings:VaultFilesBackings=new Map([[meta.inventory.backing.id,{kind:'git',root:testPaths?.root??'/srv',areas:new Map<string,{origin:string}>(meta.inventory.areas.map((a:any)=>[a.areaId,{origin:testPaths?join(testPaths.originRoot,`${a.areaId}.git`):a.origin}]))}]]);
     const files=new GuardedVaultFiles(new PgVaultStore(),backings),ctx={memberId:meta.memberId,areaId:meta.areaId,expectedRevision:meta.revision,db};
     return await use(db,files,ctx);
    });
   const fileWriter:TrackFileWriter={
    async list(){return await context(false,false,async(_db,files,ctx)=>(await files.list(ctx)).paths.filter(path=>path.startsWith(prefix)));},
    async read(path){if(!path.startsWith(prefix)||!trackHomePath(path))throw new Error('track path');return await context(false,false,async(_db,files,ctx)=>{
     try{const note=await files.read(ctx,path);return {path,content:note.content,contentRevision:note.contentRevision};}
     catch(error){if(error instanceof NoteNotFoundError)return undefined;throw error;}
    });},
    async write(change){
     if(!trackHomePath(change.path)||!change.path.startsWith(prefix))throw new Error('track path');
     const related=change.relatedContentRevisions??{};
     if(change.path!==targetPath&&related[targetPath]===undefined)throw new Error('track target revision');
     const before=await context(false,false,async(_db,files,ctx)=>{
      try{return await files.read(ctx,targetPath);}catch(error){if(error instanceof NoteNotFoundError)return undefined;throw error;}
     });
     if(payloadFingerprint('tracks-vault-target-v1',before?.content??null)!==target.fingerprint)throw new Error('track target changed');
     const targetRevision=before?.contentRevision??null;
     if(change.path===targetPath?change.expectedContentRevision!==targetRevision:related[targetPath]!==targetRevision)throw new Error('track target changed');
     await context(false,true,async()=>undefined); // Durable one-use claim. A failed commit needs a new approval.
     await context(true,false,async(_db,files,ctx)=>{
      const binding=vaultWriteBindingSchema.parse({areaId:ctx.areaId,relativePath:change.path,expectedContentRevision:change.expectedContentRevision,
       accessRevision:ctx.expectedRevision,approvedOrigin:target.approvedOrigin,authority:(approval.authority as Record<string,unknown>)});
      await files.write(ctx,{binding,frontmatter:change.frontmatter,body:change.body,
       expectedRelatedContentRevisions:related});
     });
    },
   };
   const home=new VaultTracksHome(fileWriter);
   const actionInput=rawInput as Record<string,any>;
   let result:unknown;
   if(action==='track_create')result=await home.createTrack({id:actionInput.trackId,name:actionInput.name,purpose:actionInput.purpose,steps:actionInput.steps,closingSteps:actionInput.closingSteps});
   else if(action==='track_set_steps')result=await home.setSteps(actionInput.trackId,actionInput.steps,actionInput.closingSteps);
   else if(action==='track_add_item')result=await home.addItem(actionInput.trackId,actionInput.who,actionInput.step,actionInput.note,actionInput.sourceSignal);
   else result=await home.moveItem(actionInput.itemId,actionInput.step,actionInput.note,actionInput.sourceSignal);
   assertNotAborted();return {result,origin:target.approvedOrigin};
  }
  throw new Error('operation');
 }
 await mkdir(dirname(consoleSocket),{recursive:true,mode:0o750});
 try{const st=await lstat(consoleSocket);if(!st.isSocket()||st.uid!==rootUid)throw new Error('path');const stale=await new Promise<boolean>(resolve=>{const c=createConnection(consoleSocket);c.setTimeout(500,()=>{c.destroy();resolve(false)});c.once('connect',()=>{c.destroy();resolve(false)});c.once('error',(e:NodeJS.ErrnoException)=>resolve(e.code==='ECONNREFUSED'));});if(!stale)throw new Error('active');await unlink(consoleSocket);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('keeper: vault console socket unavailable');}
 const server=createBoundedVaultBrokerServer(handle,socketState),runtimeServer=createBoundedVaultBrokerServer(runtimeHandle,socketState,RUNTIME_LIMIT,10_000);
 try{
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(consoleSocket,()=>{server.off('error',reject);resolve()})});await chown(consoleSocket,socketUid,socketGid);await chmod(consoleSocket,0o660);
 await prepareVaultRuntimeDirectory(dirname(runtimeSocket),rootUid,socketGid);
 try{const st=await lstat(runtimeSocket);if(!st.isSocket()||st.uid!==rootUid)throw new Error('path');const stale=await new Promise<boolean>(resolve=>{const c=createConnection(runtimeSocket);c.setTimeout(500,()=>{c.destroy();resolve(false)});c.once('connect',()=>{c.destroy();resolve(false)});c.once('error',(e:NodeJS.ErrnoException)=>resolve(e.code==='ECONNREFUSED'));});if(!stale)throw new Error('active');await unlink(runtimeSocket);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('keeper: Vault runtime socket unavailable');}
 await new Promise<void>((resolve,reject)=>{runtimeServer.once('error',reject);runtimeServer.listen(runtimeSocket,()=>{runtimeServer.off('error',reject);resolve()})});await chown(runtimeSocket,socketUid,socketGid);await chmod(runtimeSocket,0o660);
 }catch(error){for(const client of clients)client.destroy();await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>runtimeServer.close(()=>resolve()))]);throw error;}
 return async()=>{for(const client of clients)client.destroy();await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>runtimeServer.close(()=>resolve()))]);challenges.clear();pending.clear();turns.clear();runtimeRequests.clear()};
}
export function consumePendingVaultReceipt(handle:string,input:Pick<Input,'agent'|'incarnation'|'session'|'member'|'admissionNonce'>):Pending|undefined{
 prune();const value=pending.get(handle);if(!value)return undefined;pending.delete(handle);if(value.expiry<=Date.now()||value.input.agent!==input.agent||value.input.incarnation!==input.incarnation||value.input.session!==input.session||value.input.member!==input.member||value.input.admissionNonce!==input.admissionNonce)return undefined;return value;
}
