import {request as httpRequest} from 'node:http';
import {GATEWAY_RPC_BYTES,GATEWAY_RPC_MS,gatewayRpcPath} from '@lares/agent-kit/gateway-admission-protocol';
const SOCKET='/run/lares/gateway-budget.sock';
const unavailable=()=>new Response('Gateway admission unavailable',{status:503,headers:{'cache-control':'no-store'}});
/** Exact byte relay only. It has no signing key, cookie authentication, claimed actor,
 * endpoint supplied by the caller, retry, redirect or JSON reserialization. */
export async function relayGatewayBudget(request:Request,options:{socketPath?:string;timeoutMs?:number}={}):Promise<Response> {
  const timeoutMs=options.timeoutMs??GATEWAY_RPC_MS;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>GATEWAY_RPC_MS)return unavailable();
  const url=new URL(request.url),signature=request.headers.get('x-lares-signature');
  if(request.method!=='POST'||!gatewayRpcPath(url.pathname)||url.search||url.hash||request.headers.get('content-type')!=='application/json'||request.headers.has('content-encoding')||!signature||! /^[a-f0-9]{64}$/.test(signature))return unavailable();
  const declared=request.headers.get('content-length');
  if(declared!==null&&(!/^[1-9][0-9]{0,3}$/.test(declared)||Number(declared)>GATEWAY_RPC_BYTES))return unavailable();
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(timeoutMs)]);
  try {
    const body=await bounded(request.body,signal);
    if(!body.length||declared!==null&&Number(declared)!==body.length)return unavailable();
    const reply=await new Promise<{body:Buffer;signature:string}>((resolve,reject)=>{
      const upstream=httpRequest({socketPath:options.socketPath??SOCKET,path:url.pathname,method:'POST',agent:false,signal,headers:{'content-type':'application/json','content-length':String(body.length),'x-lares-signature':signature,'connection':'close'}},response=>{
        const received:Buffer[]=[];let length=0;
        const sig=response.headers['x-lares-signature'];
        if(response.statusCode!==200||typeof sig!=='string'||! /^[a-f0-9]{64}$/.test(sig)||response.headers['content-type']!=='application/json'||response.headers['content-encoding']!==undefined){response.destroy();reject(new Error('Gateway unavailable'));return;}
        response.on('data',chunk=>{length+=chunk.length;if(length>GATEWAY_RPC_BYTES){response.destroy();reject(new Error('Gateway reply too large'));}else received.push(Buffer.from(chunk));});
        response.on('error',reject);response.on('aborted',()=>reject(new Error('Incomplete gateway reply')));
        response.on('end',()=>{if(!response.complete||signal.aborted||length===0)reject(new Error('Incomplete gateway reply'));else resolve({body:Buffer.concat(received,length),signature:sig});});
      });
      upstream.on('error',reject);upstream.end(body);
    });
    if(signal.aborted)return unavailable();
    return new Response(new Uint8Array(reply.body),{status:200,headers:{'content-type':'application/json','cache-control':'no-store','x-lares-signature':reply.signature}});
  }catch{return unavailable();}
}
async function bounded(stream:ReadableStream<Uint8Array>|null,signal:AbortSignal):Promise<Buffer> {
  if(!stream)return Buffer.alloc(0);
  const reader=stream.getReader(),parts:Buffer[]=[];let size=0;
  const abort=()=>void reader.cancel().catch(()=>{});signal.addEventListener('abort',abort,{once:true});
  try {
    while(true){if(signal.aborted)throw new Error('Gateway deadline');const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>GATEWAY_RPC_BYTES)throw new Error('Body too large');parts.push(Buffer.from(value));}
    if(signal.aborted)throw new Error('Gateway deadline');return Buffer.concat(parts,size);
  }finally{signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
