import { createConnection } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OutsideExecutionApproval } from './outside-execution-receipts.js';

const DEFAULT_SOCKET='/run/lares-vault/read.sock',MAX_FRAME=256*1024;
function identity(){
 const agent=process.env.LARES_AGENT_NAME,incarnation=process.env.LARES_AGENT_INCARNATION,path=process.env.LARES_RUNTIME_CONTROL_SECRET_FILE??'/run/secrets/runtime-control';
 if(!agent||!/^[a-z][a-z0-9-]{1,30}$/.test(agent)||!incarnation||!/^[a-f0-9-]{36}$/.test(incarnation))throw new Error('Vault reader unavailable');
 const token=readFileSync(path,'utf8').trim();if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Vault reader unavailable');
 return {agent,incarnation,key:Buffer.from(token,'hex')};
}
async function request<T>(op:string,input:unknown,timeoutMs:number):Promise<T>{
 const {agent,incarnation,key}=identity(),requestId=randomBytes(24).toString('base64url'),timestamp=Date.now(),body={agent,incarnation,requestId,timestamp,op,input};
 const mac=createHmac('sha256',key).update(JSON.stringify(body)).digest('base64url');
 const frame=JSON.stringify({...body,mac})+'\n';if(Buffer.byteLength(frame)>MAX_FRAME)throw new Error('Vault reader unavailable');
 return new Promise((resolve,reject)=>{
  const socket=createConnection(process.env.LARES_VAULT_RUNTIME_SOCKET??DEFAULT_SOCKET);let data=Buffer.alloc(0),settled=false;
  const finish=(error?:Error,result?:T)=>{if(settled)return;settled=true;clearTimeout(deadline);socket.destroy();if(error)reject(new Error('Vault reader unavailable'));else resolve(result!);};
  const deadline=setTimeout(()=>finish(new Error('deadline')),timeoutMs);
  socket.once('error',error=>finish(error));socket.once('end',()=>{if(!settled)finish(new Error('eof'));});socket.once('close',()=>{if(!settled)finish(new Error('close'));});
  socket.once('connect',()=>socket.write(frame));
  socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length>MAX_FRAME){finish(new Error('size'));return;}const end=data.indexOf(10);if(end<0)return;if(end!==data.length-1){finish(new Error('trailing'));return;}
   try{const result=JSON.parse(data.subarray(0,end).toString('utf8'));if(result.ok!==true)throw new Error();finish(undefined,result as T);}catch{finish(new Error('response'));}
  });
 });
}

export async function vaultBrokerRequest<T>(op:string,input:unknown):Promise<T>{return request<T>(op,input,2000)}
/** Trusted server caller only. Coordinates come from the real admitted turn, never tool input.
 * The existing broker authenticates the runtime; Keeper rechecks the turn and exact receipt.
 * This is an explicit execution seam, not an Eve MCP execution override. */
export async function executeApprovedOutsideCall<T>(turn:{turnCapability:string;turnId:string;sequence:number;sessionId:string;memberId:string;admissionNonce:string},
 call:Omit<OutsideExecutionApproval,'expiresAt'|'payloadHash'> & {input:unknown}):Promise<T>{
 const response=await request<{result:T}>('outside.execute',{...turn,call},10_000);
 return response.result;
}
