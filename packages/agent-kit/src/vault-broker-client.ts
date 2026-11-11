import { createConnection } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DEFAULT_SOCKET='/run/lares-vault/read.sock',MAX_FRAME=256*1024;
/** The refusal codes keeper may put in a failed reply, as `{"ok":false,"reason":"deadline"}`. One closed
 * list for both ends: keeper sends a reason only when it is on it, and this client names a reason only when
 * it is on it. Keeper's codes for a request it could not authenticate (`identity`, `signature`) and for a note
 * the reader may not see (`not found`) are left off on purpose: the reply must not tell those apart. */
export const VAULT_BROKER_REFUSAL_REASONS:ReadonlySet<string>=new Set(['approval','area','areas','authority','capacity','capsule','challenge','deadline',
 'definition','expired','grant','inventory','listing','member','operation','outside','owner','policy','read','receipt','replay','runtime','tracks','turn']);
/** Why a request failed, in plain words. Closed: the message reaches the model, so nothing an error or
 * keeper's reply carries is ever copied into it. */
const FAILURES={identity:'this agent has no keeper identity',request:'the request was too large',connection:'the connection to the keeper failed',
 deadline:'the keeper did not answer in time',eof:'the connection closed early',close:'the connection closed early',size:'the reply was too large',
 trailing:'the reply was not understood',response:'the reply was not understood',refused:'the keeper refused'} as const;
type Failure=keyof typeof FAILURES;
/** Always contains `Vault reader unavailable`: callers and tests match on that. */
function unavailable(failure:Failure,reason?:unknown):Error{
 const named=failure==='refused'&&typeof reason==='string'&&VAULT_BROKER_REFUSAL_REASONS.has(reason)?`: ${reason}`:'';
 return new Error(`Vault reader unavailable (${FAILURES[failure]}${named})`);
}
function identity(){
 const agent=process.env.LARES_AGENT_NAME,incarnation=process.env.LARES_AGENT_INCARNATION,path=process.env.LARES_RUNTIME_CONTROL_SECRET_FILE??'/run/secrets/runtime-control';
 if(!agent||!/^[a-z][a-z0-9-]{1,30}$/.test(agent)||!incarnation||!/^[a-f0-9-]{36}$/.test(incarnation))throw unavailable('identity');
 const token=readFileSync(path,'utf8').trim();if(!/^[a-f0-9]{64}$/.test(token))throw unavailable('identity');
 return {agent,incarnation,key:Buffer.from(token,'hex')};
}
async function request<T>(op:string,input:unknown,timeoutMs:number):Promise<T>{
 const {agent,incarnation,key}=identity(),requestId=randomBytes(24).toString('base64url'),timestamp=Date.now(),body={agent,incarnation,requestId,timestamp,op,input};
 const mac=createHmac('sha256',key).update(JSON.stringify(body)).digest('base64url');
 const frame=JSON.stringify({...body,mac})+'\n';if(Buffer.byteLength(frame)>MAX_FRAME)throw unavailable('request');
 return new Promise((resolve,reject)=>{
  const socket=createConnection(process.env.LARES_VAULT_RUNTIME_SOCKET??DEFAULT_SOCKET);let data=Buffer.alloc(0),settled=false;
  const finish=(error?:Error,result?:T)=>{if(settled)return;settled=true;clearTimeout(deadline);socket.destroy();if(error)reject(error);else resolve(result!);};
  const fail=(failure:Failure,reason?:unknown)=>finish(unavailable(failure,reason));
  const deadline=setTimeout(()=>fail('deadline'),timeoutMs);
  socket.once('error',()=>fail('connection'));socket.once('end',()=>fail('eof'));socket.once('close',()=>fail('close'));
  socket.once('connect',()=>socket.write(frame));
  socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length>MAX_FRAME){fail('size');return;}const end=data.indexOf(10);if(end<0)return;if(end!==data.length-1){fail('trailing');return;}
   let result:{ok?:unknown;reason?:unknown}|null;try{result=JSON.parse(data.subarray(0,end).toString('utf8'));}catch{fail('response');return;}
   if(result&&result.ok===true)finish(undefined,result as T);else if(result&&typeof result==='object'&&result.ok===false)fail('refused',result.reason);else fail('response');
  });
 });
}

/** `timeoutMs` defaults to the 2 s every read and approved write is held to. Only an operation that
 * makes a commit with nobody waiting (a scheduled Vault write) asks for more. Keeper's own deadline
 * for it is shorter than this, so keeper answers or refuses before the client gives up. */
export async function vaultBrokerRequest<T>(op:string,input:unknown,timeoutMs=2000):Promise<T>{return request<T>(op,input,timeoutMs)}
export const SCHEDULED_VAULT_TIMEOUT_MS=10_000;/** Trusted server caller only. Coordinates come from the authenticated session, never tool input.
 * Keeper issues a dedicated one-use capability from the exact approved ask and rechecks it at execution.
 * This is an explicit execution seam, not an Eve MCP execution override. */
export async function executeApprovedOutsideCall<T>(turn:{outsideCapability:string;sessionId:string;memberId:string;admissionNonce:string},
 call:{callId:string;connectionName:string;toolName:string;input:unknown}):Promise<T>{
 const response=await request<{result:T}>('outside.execute',{...turn,call},10_000);
 return response.result;
}
