import { createConnection, createServer, type Socket } from 'node:net';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { chmod, chown, lstat, mkdir, unlink, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { authorityTransaction, requireConsoleSessionBinding, type AuthorityPool } from '@lares/agent-kit/console-turn-authority';
import { consoleSourceTransaction } from '@lares/agent-kit/console-source-transaction';
import { captureConsoleVaultSources, withConsoleVaultSourceRead } from '@lares/agent-kit/console-turn-authority';
import { definitionSchema, hashOf } from '@lares/agent-kit/definition';
import { grantedVaultAreas } from '@lares/agent-kit/manifest';
import { currentMember } from '@lares/agent-kit/member-store';
import { PgVaultStore } from '@lares/agent-kit/vault-area-store';
import { GuardedVaultFiles } from '@lares/agent-kit/vault-files';
import { visibleTo, type Reader, type StoreName } from '@lares/agent-kit/notes-store';
import { boundText, DEFAULT_READ_LIMIT } from '@lares/agent-kit/bounded-text';
import { loadVaultStorageInventory, verifyVaultStorageMetadata } from '@lares/agent-box/lib/vault-storage.js';

const SOCKET='/run/lares/vault-console.sock', CONSOLE_LIMIT=16_384, RUNTIME_LIMIT=256*1024, CHALLENGE_MS=10_000, PENDING_MS=30_000, MAX_LIVE=4096;
type Input={agent:string;incarnation:string;session:string;member:string;admissionNonce:string;method:string;path:string;rawBodyHash:string;policyRevision:number;definitionHash:string};
type Challenge={input:Input;challenge:string;expiry:number};
type Pending={input:Input;expiry:number};
type Capsule=Input & {version:1;purpose:'human';challenge:string;nonce:string;expiry:number};
type SessionDefinitionMaterial={definition:ReturnType<typeof definitionSchema.parse>;dutiesMd:string;voiceMd:string;hash:string};
type Turn={input:Input;turnId:string;sequence:number;definition:SessionDefinitionMaterial;areaIds:string[];expiry:number};
export interface VaultBrokerSocketOptions {consoleSocket?:string;rootUid?:number;socketUid?:number;socketGid?:number;turnClockForTests?:()=>number}
const challenges=new Map<string,Challenge>(),pending=new Map<string,Pending>(),runtimeRequests=new Map<string,number>();
const turns=new Map<string,Turn>();
function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error();return v as Record<string,unknown>}
type SocketState={clients:Set<Socket>;inFlight:number};
export function createBoundedVaultBrokerServer(handler:(line:string,signal:AbortSignal)=>Promise<Record<string,unknown>>,state:SocketState,limit=CONSOLE_LIMIT){
 return createServer(socket=>{if(state.clients.size>=32||state.inFlight>=32){socket.destroy();return;}state.clients.add(socket);let handled=false,buffer=Buffer.alloc(0);const controller=new AbortController(),deadline=setTimeout(()=>{controller.abort();socket.destroy()},2000);socket.on('error',()=>{});socket.on('close',()=>{controller.abort();clearTimeout(deadline);state.clients.delete(socket)});socket.on('data',chunk=>{
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
export async function serveConsoleVaultBroker(pool:AuthorityPool,consoleSigningKeyFile:string,runtimeSecretsDir:string,runtimeSocket:string,socketOptions:VaultBrokerSocketOptions={}):Promise<()=>Promise<void>>{
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
  const requestDeadline=Date.now()+1700,transactionDeadline={deadlineAtMs:requestDeadline};
  const assertNotAborted=()=>{if(signal.aborted||Date.now()>=requestDeadline)throw new Error('deadline')};assertNotAborted();
  const req=object(JSON.parse(line)),agent=req.agent,incarnation=req.incarnation,requestId=req.requestId,timestamp=req.timestamp,op=req.op,input=object(req.input);
  if(typeof agent!=='string'||!/^[a-z][a-z0-9-]{1,30}$/.test(agent)||typeof incarnation!=='string'||!/^[a-f0-9-]{36}$/.test(incarnation)||typeof requestId!=='string'||!/^[A-Za-z0-9_-]{32,64}$/.test(requestId)||!Number.isSafeInteger(timestamp)||Math.abs(Date.now()-Number(timestamp))>30_000||typeof op!=='string'||typeof req.mac!=='string')throw new Error('identity');
  const token=(await readFile(join(runtimeSecretsDir,`${agent}-runtime-control`),'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(token))throw new Error('identity');
  const body=JSON.stringify({agent,incarnation,requestId,timestamp,op,input}),expected=mac(Buffer.from(token,'hex'),body),given=Buffer.from(req.mac,'base64url');
  prune(Date.now(),turnNow());if(given.length!==expected.length||!timingSafeEqual(given,expected)||runtimeRequests.has(requestId)||runtimeRequests.size>=MAX_LIVE)throw new Error('signature');
  runtimeRequests.set(requestId,Date.now()+60_000);
  const active=await authorityTransaction(pool,async db=>{await db.query("SELECT set_config('statement_timeout','1000ms',true)");await db.query("SELECT set_config('lock_timeout','500ms',true)");return db.query("SELECT 1 FROM agent_resources r JOIN agent_definitions d ON d.name=r.name WHERE r.name=$1 AND r.ownership_token=$2::uuid AND r.runtime_control_token=r.ownership_token AND r.state='ready' AND NOT r.pending AND d.status='valid'",[agent,incarnation])},transactionDeadline);assertNotAborted();if(active.rows.length!==1)throw new Error('runtime');
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
   const cap=input.turnCapability,turnId=input.turnId,sequence=input.sequence,sessionId=input.sessionId,memberId=input.memberId,admissionNonce=input.admissionNonce,operation=input.operation,area=input.area,path=input.path,offset=input.offset;
   if(typeof cap!=='string'||typeof turnId!=='string'||!Number.isSafeInteger(sequence)||typeof sessionId!=='string'||typeof memberId!=='string'||typeof admissionNonce!=='string'||(operation!=='list'&&operation!=='read')||(area!=='private'&&area!=='shared')||(operation==='read'&&typeof path!=='string')||(offset!==undefined&&(!Number.isSafeInteger(offset)||Number(offset)<0)))throw new Error('read');
   const turn=turns.get(cap);if(!turn||turn.expiry<=turnNow()||turn.turnId!==turnId||turn.sequence!==sequence||turn.input.agent!==agent||turn.input.incarnation!==incarnation||turn.input.session!==sessionId||turn.input.member!==memberId||turn.input.admissionNonce!==admissionNonce)throw new Error('turn');
   const assertLive=()=>{assertNotAborted();if(turns.get(cap)!==turn||turn.expiry<=turnNow())throw new Error('turn')};assertLive();
   const sourceReadOptions={deadlineAtMs:requestDeadline,beforeCommit:assertLive,afterCommit:assertLive};
   const result=await withConsoleVaultSourceRead({agent,incarnation,sessionId,memberId,admissionNonce},{sessionDefinition:turn.definition,areaIds:turn.areaIds},async(db)=>{
    assertLive();await db.query("SELECT set_config('statement_timeout','1000ms',true)");await db.query("SELECT set_config('lock_timeout','500ms',true)");
    const inventory=loadVaultStorageInventory();await verifyVaultStorageMetadata(db as never,inventory,true);assertLive();
    const member=await currentMember(db as never,memberId);assertLive();if(!member)throw new Error('member');
    const kind=area==='private'?'private':'shared',candidates=inventory.areas.filter(a=>a.kind===kind),vault=new PgVaultStore(),matches=[] as {areaId:string;revision:number}[];
    for(const candidate of candidates){if(!turn.areaIds.includes(candidate.areaId))continue;const result=await db.query('SELECT revision FROM vault_areas WHERE id=$1 AND status=\'active\'',[candidate.areaId]);if(result.rows.length!==1)continue;const revision=Number(result.rows[0]!.revision);const binding=await vault.vaultAreaBinding(memberId,{areaId:candidate.areaId,expectedRevision:revision,permission:'use'},{db:db as never,requiredBackingKind:'git'});if(binding)matches.push({areaId:candidate.areaId,revision});}
    if(matches.length!==1)throw new Error('area');const selected=matches[0]!,backings=new Map([[inventory.backing.id,{kind:'git' as const,root:'/srv',areas:new Map(inventory.areas.map(a=>[a.areaId,{origin:a.origin}]))}]]),files=new GuardedVaultFiles(vault,backings),ctx={memberId,areaId:selected.areaId,expectedRevision:selected.revision,db:db as never},reader:Reader={userId:memberId,store:kind==='private'?'brain':'atlas' as StoreName};
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
  throw new Error('operation');
 }
 await mkdir(dirname(consoleSocket),{recursive:true,mode:0o750});
 try{const st=await lstat(consoleSocket);if(!st.isSocket()||st.uid!==rootUid)throw new Error('path');const stale=await new Promise<boolean>(resolve=>{const c=createConnection(consoleSocket);c.setTimeout(500,()=>{c.destroy();resolve(false)});c.once('connect',()=>{c.destroy();resolve(false)});c.once('error',(e:NodeJS.ErrnoException)=>resolve(e.code==='ECONNREFUSED'));});if(!stale)throw new Error('active');await unlink(consoleSocket);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('keeper: vault console socket unavailable');}
 const server=createBoundedVaultBrokerServer(handle,socketState),runtimeServer=createBoundedVaultBrokerServer(runtimeHandle,socketState,RUNTIME_LIMIT);
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
