import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {createConnection,type Socket} from 'node:net';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {chmod,chown,lstat,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join} from 'node:path';
import type {Pool} from 'pg';
import {PgBudgetAdmissionStore,type BudgetGatewayTicket} from '@lares/agent-kit/budget-admission-store';
import {gatewayRawRequestHash,GATEWAY_ANTHROPIC_MODEL_PATH,GATEWAY_OPENAI_MODEL_PATH,type GatewayModelPath} from '@lares/agent-kit/gateway-admission-protocol';
import {modelPurposeDispatchMac,MODEL_PURPOSE_DISPATCH_BODY_MAX,type ModelPurposeDispatchFields} from '@lares/agent-kit/model-purpose-protocol';
import {BudgetNativeCustodyStore,type NativeCustodyGate,type NativeOperation} from './budget-native-custody.js';
import {readModelPurposeRuntimeControlKey} from './model-purpose-broker.js';

export const DEFAULT_MODEL_PURPOSE_GATEWAY_SOCKET='/run/lares/model-purpose/gateway.sock';
export const MODEL_PURPOSE_TRANSPORT_BODY_MAX=MODEL_PURPOSE_DISPATCH_BODY_MAX;
const CLIENTS_MAX=8,QUEUE_MAX=4,NONCES_MAX=4096,HEADER_DEADLINE_MS=20_000,IDLE_TIMEOUT_MS=5_000,RESPONSE_BYTES_MAX=64*1024*1024;
const deny=()=>new Error('Model purpose dispatch is unavailable');
const deniedBody=Buffer.from('{"error":"Model purpose dispatch is unavailable"}');
const ROUTES=new Set<string>([GATEWAY_ANTHROPIC_MODEL_PATH,GATEWAY_OPENAI_MODEL_PATH]);
const REQUEST_HEADERS=new Set(['host','connection','content-length','content-type','accept','accept-encoding','anthropic-version','anthropic-beta',
  'x-lares-budget-intent','x-lares-purpose-agent','x-lares-purpose-incarnation','x-lares-purpose-request-hash','x-lares-purpose-nonce','x-lares-purpose-deadline','x-lares-purpose-mac']);
const RESPONSE_HEADERS=['content-type','content-length','content-encoding','cache-control','retry-after','anthropic-version','x-request-id'] as const;

type QueueEntry={resolve:()=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout};
class HeaderQueue {
  private active=false;
  private waiting:QueueEntry[]=[];
  async run<T>(deadline:number,work:()=>Promise<T>):Promise<T>{
    await this.acquire(deadline);
    try{return await work();}finally{this.release();}
  }
  private acquire(deadline:number):Promise<void>{
    if(!this.active){this.active=true;return Promise.resolve();}
    if(this.waiting.length>=QUEUE_MAX)return Promise.reject(deny());
    return new Promise((resolve,reject)=>{
      const entry:QueueEntry={resolve,reject,timer:setTimeout(()=>{
        const index=this.waiting.indexOf(entry);if(index>=0)this.waiting.splice(index,1);reject(deny());
      },Math.max(1,Math.min(HEADER_DEADLINE_MS,deadline-Date.now())))};
      this.waiting.push(entry);
    });
  }
  private release():void{
    const next=this.waiting.shift();
    if(!next){this.active=false;return;}
    clearTimeout(next.timer);next.resolve();
  }
}

class NonceLedger {
  private readonly values=new Map<string,number>();
  burn(nonce:string,deadline:number,now:number):boolean{
    for(const [value,until] of this.values)if(until<=now)this.values.delete(value);
    if(this.values.size>=NONCES_MAX||this.values.has(nonce))return false;
    this.values.set(nonce,deadline);return true;
  }
}
class TicketLedger {
  private readonly values=new Map<string,number>();
  burn(ticket:string,expiresAt:number,now:number):boolean{
    for(const [value,until] of this.values)if(until<=now)this.values.delete(value);
    const identity=createHash('sha256').update(ticket).digest('hex');
    if(this.values.size>=NONCES_MAX||this.values.has(identity))return false;
    this.values.set(identity,expiresAt);return true;
  }
}

function header(req:IncomingMessage,name:string):string|undefined{
  const value=req.headers[name];return typeof value==='string'?value:undefined;
}
function headersAreStrict(req:IncomingMessage):boolean{
  const seen=new Set<string>();
  for(let i=0;i<req.rawHeaders.length;i+=2){
    const name=req.rawHeaders[i]!.toLowerCase();
    if(!REQUEST_HEADERS.has(name)||seen.has(name))return false;
    seen.add(name);
  }
  return true;
}
function dispatchFields(req:IncomingMessage):ModelPurposeDispatchFields|undefined{
  const method=req.method,path=req.url,requestHash=header(req,'x-lares-purpose-request-hash'),ticket=header(req,'x-lares-budget-intent'),
    agent=header(req,'x-lares-purpose-agent'),incarnation=header(req,'x-lares-purpose-incarnation'),nonce=header(req,'x-lares-purpose-nonce'),deadlineRaw=header(req,'x-lares-purpose-deadline');
  if(method!=='POST'||typeof path!=='string'||!ROUTES.has(path)||!requestHash||!ticket||!agent||!incarnation||!nonce||!deadlineRaw||
    !/^[a-f0-9]{64}$/.test(requestHash)||!/^[A-Za-z0-9_-]{43}$/.test(ticket)||!/^[a-z][a-z0-9-]{1,30}$/.test(agent)||
    !/^[a-f0-9-]{36}$/.test(incarnation)||!/^[A-Za-z0-9_-]{43}$/.test(nonce)||!/^(0|[1-9][0-9]{0,15})$/.test(deadlineRaw))return undefined;
  const deadline=Number(deadlineRaw);if(!Number.isSafeInteger(deadline))return undefined;
  return {method:'POST',path:path as GatewayModelPath,requestHash,ticket,agent,incarnation,nonce,deadline};
}
function reply(res:ServerResponse,status:number,body=deniedBody):void{
  if(res.headersSent){res.destroy();return;}
  res.writeHead(status,{'content-type':'application/json','content-length':String(body.length),'cache-control':'no-store','connection':'close'});res.end(body);
}
function waitForDrain(res:ServerResponse,signal:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    const finish=(error?:Error)=>{clearTimeout(timer);res.off('drain',drained);res.off('close',closed);res.off('error',failed);signal.removeEventListener('abort',aborted);error?reject(error):resolve();};
    const drained=()=>finish(),closed=()=>finish(deny()),failed=()=>finish(deny()),aborted=()=>finish(deny());
    const timer=setTimeout(()=>finish(deny()),30_000);
    res.once('drain',drained);res.once('close',closed);res.once('error',failed);signal.addEventListener('abort',aborted,{once:true});
  });
}
function validBodyModel(raw:Buffer,alias:string):boolean{
  try{const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)) as {model?:unknown};return !!body&&typeof body==='object'&&!Array.isArray(body)&&body.model===alias;}catch{return false;}
}
function matchNative(gate:NativeCustodyGate,ticket:BudgetGatewayTicket,path:GatewayModelPath,bodyBytes:number):{endpoint:string;key:string;format:'anthropic'|'openai'}|undefined{
  const snapshot=gate.inventory();
  const matches=snapshot.operations.filter((value):value is NativeOperation=>value.kind==='operation'&&value.phase==='active'&&
    value.plaintext==='present'&&value.bindingReceipt!==null&&value.activationReceipt!==null&&value.bindingReceipt.journalId===value.activationReceipt.journalId&&value.bindingId===ticket.bindingId&&value.credentialGeneration===ticket.credentialGeneration&&
    value.association.agent===ticket.agent&&value.association.incarnation===ticket.incarnation&&value.association.purposeAlias===ticket.purposeAlias&&
    value.keyFingerprint===ticket.keyFingerprint&&value.reviewedPolicy.pricing.capabilityHash===ticket.profileHash&&
    bodyBytes<=value.reviewedPolicy.capability.maxBodyBytes&&
    value.reviewedPolicy.key.blocked===true&&value.reviewedPolicy.capability.aliases.includes(ticket.purposeAlias));
  if(matches.length!==1)return undefined;
  const operation=matches[0]!,user=snapshot.users.find(value=>value.kind==='user'&&value.ownershipId===operation.userOwnershipId);
  if(!user||user.kind!=='user')return undefined;
  const team=snapshot.teams.find(value=>value.kind==='team'&&value.ownershipId===user.teamOwnershipId);
  if(!team||team.kind!=='team'||user.installationAccountId!==ticket.installationAccountId||team.installationAccountId!==ticket.installationAccountId||
    user.endpoint.hash!==ticket.endpointHash||team.endpoint.hash!==ticket.endpointHash||
    team.capabilityHash!==ticket.profileHash||user.endpoint.origin!==team.endpoint.origin)return undefined;
  const expectedFormat=path===GATEWAY_ANTHROPIC_MODEL_PATH?'anthropic':'openai';
  if(operation.reviewedPolicy.pricing.format!==expectedFormat)return undefined;
  const key=gate.readKey(operation.operationId);
  if(createHash('sha256').update(key).digest('hex')!==ticket.keyFingerprint)return undefined;
  return {endpoint:user.endpoint.origin,key,format:expectedFormat};
}

export interface ModelPurposeTransportOptions {
  socket:string;
  runtimeSecretsDir:string;
  custody:BudgetNativeCustodyStore;
  ticketPool:Pool;
  rootUid?:number;
  socketUid?:number;
  socketGid?:number;
  runtimeKeyUid?:number;
  runtimeKeyGid?:number;
  now?:()=>number;
}

/** Starts a Keeper-only dispatch proxy. Tickets are revalidated against SQL and native
 * custody on every request; this listener never changes the intentionally blocked key. */
export async function serveModelPurposeTransport(options:ModelPurposeTransportOptions):Promise<()=>Promise<void>>{
  if(!isAbsolute(options.socket)||!isAbsolute(options.runtimeSecretsDir))throw deny();
  const rootUid=options.rootUid??0,socketUid=options.socketUid??rootUid,socketGid=options.socketGid??10_001,now=options.now??Date.now;
  const directory=dirname(options.socket),dir=await lstat(directory);
  if(dir.isSymbolicLink()||!dir.isDirectory()||dir.uid!==rootUid||dir.gid!==socketGid||(dir.mode&0o777)!==0o750)throw deny();
  try{
    const stale=await lstat(options.socket);
    if(!stale.isSocket()||stale.uid!==rootUid)throw deny();
    const live=await new Promise<boolean>(resolve=>{const socket=createConnection(options.socket);socket.setTimeout(250,()=>{socket.destroy();resolve(false);});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',(error:NodeJS.ErrnoException)=>resolve(error.code!=='ECONNREFUSED'));});
    if(live)throw deny();await unlink(options.socket);
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw deny();}
  const tickets=new PgBudgetAdmissionStore(options.ticketPool),nonces=new NonceLedger(),dispatchTickets=new TicketLedger(),queue=new HeaderQueue();let clients=0;
  const sockets=new Set<Socket>();
  const server=createServer((req,res)=>{
    clients++;if(clients>CLIENTS_MAX){clients--;reply(res,503);return;}
    res.once('close',()=>{clients=Math.max(0,clients-1);});
    void handle(req,res).catch(()=>reply(res,503));
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  server.maxConnections=CLIENTS_MAX;server.headersTimeout=5_000;server.requestTimeout=15_000;server.keepAliveTimeout=1_000;
  async function handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
    if(!headersAreStrict(req)||header(req,'content-encoding')!==undefined||header(req,'transfer-encoding')!==undefined||
      header(req,'content-type')?.split(';',1)[0]?.trim().toLowerCase()!=='application/json'||req.url?.includes('?')||req.url?.includes('#')){reply(res,400);return;}
    const fields=dispatchFields(req),mac=header(req,'x-lares-purpose-mac'),lengthRaw=header(req,'content-length');
    if(!fields||!mac||!lengthRaw||!/^(0|[1-9][0-9]{0,8})$/.test(lengthRaw)){reply(res,400);return;}
    const length=Number(lengthRaw);if(!Number.isSafeInteger(length)||length<1||length>MODEL_PURPOSE_TRANSPORT_BODY_MAX){reply(res,413);return;}
    const timestamp=now();if(fields.deadline<=timestamp||fields.deadline>timestamp+30_000){reply(res,408);return;}
    const key=await readModelPurposeRuntimeControlKey(options.runtimeSecretsDir,fields.agent,{rootUid,runtimeKeyUid:options.runtimeKeyUid,runtimeKeyGid:options.runtimeKeyGid});
    let authenticated=false;
    try{authenticated=equalMac(mac,modelPurposeDispatchMac(key,fields));}finally{key.fill(0);}
    // Burn nonce immediately after authenticating the complete request metadata and before
    // body reads, SQL lookups, native custody or queue waits.
    if(!authenticated||!nonces.burn(fields.nonce,fields.deadline,timestamp)){reply(res,401);return;}
    const ticket=await tickets.discoverGatewayTicket(fields.ticket);
    if(!ticket||ticket.agent!==fields.agent||ticket.incarnation!==fields.incarnation||ticket.requestHash!==fields.requestHash||
      ticket.expiresAt<=now()||fields.deadline>ticket.expiresAt||ticket.expiresAt-timestamp>30_000){reply(res,403);return;}
    req.socket.setTimeout(IDLE_TIMEOUT_MS,()=>req.destroy());
    const chunks:Buffer[]=[];let bytes=0;
    for await(const part of req){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=chunk.length;if(bytes>MODEL_PURPOSE_TRANSPORT_BODY_MAX||bytes>length){req.destroy();reply(res,413);return;}chunks.push(chunk);}
    req.socket.setTimeout(0);
    if(bytes!==length){reply(res,400);return;}
    const raw=Buffer.concat(chunks,bytes);
    if(gatewayRawRequestHash(fields.method,fields.path,raw)!==ticket.requestHash||fields.requestHash!==ticket.requestHash){reply(res,403);return;}
    const format=fields.path===GATEWAY_ANTHROPIC_MODEL_PATH?'anthropic':'openai';
    try{if((ticket.pricingProfile as {format?:unknown})?.format!==format||!validBodyModel(raw,ticket.purposeAlias)){reply(res,403);return;}}catch{reply(res,403);return;}
    // One host dispatch is reserved per ticket even if the same authenticated runtime
    // retries with a fresh nonce while gateway admission is in flight or uncertain.
    if(!dispatchTickets.burn(fields.ticket,ticket.expiresAt,now())){reply(res,409);return;}
    const controller=new AbortController();
    const headerDeadline=setTimeout(()=>controller.abort(),Math.max(1,fields.deadline-now()));
    const disconnect=()=>{if(!res.writableEnded)controller.abort();};
    res.once('close',disconnect);
    let upstream:Response|undefined;
    try{
      upstream=await queue.run(fields.deadline,()=>options.custody.withGate(async gate=>{
        if(controller.signal.aborted||now()>=fields.deadline)return undefined;
        const native=matchNative(gate,ticket,fields.path as GatewayModelPath,raw.length);if(!native)return undefined;
        const url=new URL(fields.path,native.endpoint);
        const headers=new Headers({'content-type':'application/json','accept-encoding':'identity','x-lares-budget-intent':fields.ticket});
        for(const name of ['accept','anthropic-version','anthropic-beta'] as const){const value=header(req,name);if(value)headers.set(name,value);}
        if(native.format==='anthropic')headers.set('x-api-key',native.key);else headers.set('authorization',`Bearer ${native.key}`);
        try{
          const response=await globalThis.fetch(url,{method:'POST',headers,body:raw,signal:controller.signal,redirect:'error'});
          if(controller.signal.aborted||now()>=fields.deadline){await response.body?.cancel();return undefined;}
          return response;
        }catch{return undefined;}
      }));
    }finally{clearTimeout(headerDeadline);res.off('close',disconnect);}
    if(!upstream){reply(res,503);return;}
    if(upstream.status<200||upstream.status>=300){
      try{await upstream.body?.cancel();}catch{}
      reply(res,upstream.status>=400&&upstream.status<=599?upstream.status:502);return;
    }
    if(upstream.headers.has('content-encoding')){try{await upstream.body?.cancel();}catch{}reply(res,502);return;}
    const out:Record<string,string>={'connection':'close'};
    for(const name of RESPONSE_HEADERS){if(name==='content-length'||name==='content-encoding')continue;const value=upstream.headers.get(name);if(value&&value.length<=2_048)out[name]=value;}
    res.writeHead(upstream.status,out);
    res.flushHeaders();
    if(!upstream.body){res.end();return;}
    const reader=upstream.body.getReader();
    const cancel=()=>{controller.abort();void reader.cancel().catch(()=>{});};
    res.once('close',()=>{if(!res.writableEnded)cancel();});
    try{
      let streamed=0;
      for(;;){
        let idle:NodeJS.Timeout|undefined;
        const part=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{idle=setTimeout(()=>{controller.abort();reject(deny());},30_000);})]);
        if(idle)clearTimeout(idle);
        if(part.done)break;
        streamed+=part.value.byteLength;if(streamed>RESPONSE_BYTES_MAX)throw deny();
        if(!res.write(Buffer.from(part.value)))await waitForDrain(res,controller.signal);
      }
      res.end();
    }catch{cancel();res.destroy();}
    finally{reader.releaseLock();}
  }
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.socket,()=>{server.off('error',reject);resolve();});});
    await chown(options.socket,socketUid,socketGid);await chmod(options.socket,0o660);
    const socket=await lstat(options.socket);if(!socket.isSocket()||socket.uid!==socketUid||socket.gid!==socketGid||(socket.mode&0o777)!==0o660)throw deny();
  }catch(error){await new Promise<void>(resolve=>server.close(()=>resolve()));throw error;}
  return async()=>{
    for(const socket of sockets)socket.destroy();
    await new Promise<void>(resolve=>{server.close(()=>resolve());});
    try{const socket=await lstat(options.socket);if(socket.isSocket()&&socket.uid===socketUid)await unlink(options.socket);}catch{}
  };
}

function equalMac(given:string,expected:Buffer):boolean{
  if(!/^[A-Za-z0-9_-]{43}$/.test(given))return false;
  const bytes=Buffer.from(given,'base64url');return bytes.length===expected.length&&expected.length===32&&timingSafeEqual(bytes,expected);
}
