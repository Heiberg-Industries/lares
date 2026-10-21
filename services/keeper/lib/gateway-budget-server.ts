import {createServer,type IncomingMessage} from 'node:http';
import type {Socket} from 'node:net';
import {chmod,chown,lstat,mkdir,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {performance} from 'node:perf_hooks';
import {GATEWAY_RPC_BYTES,GATEWAY_RPC_MS,gatewayRpcPath} from '@lares/agent-kit/gateway-admission-protocol';
import {removeStaleSocket} from './socket-server.js';
import type {GatewayBudgetAuthority} from './gateway-budget.js';

/** Separate machine-authenticated HTTP socket; never a generic action or email actor. */
export async function serveGatewayBudget(options:{socket:string;authority:GatewayBudgetAuthority;ownership?:{uid:number;gid:number}}):Promise<()=>Promise<void>> {
  const uid=options.ownership?.uid??0,gid=options.ownership?.gid??10001;
  const clients=new Set<Socket>(),used=new WeakSet<Socket>(),work=new Set<Promise<void>>();
  let ready=false;
  const server=createServer({maxHeaderSize:2048,headersTimeout:GATEWAY_RPC_MS,requestTimeout:GATEWAY_RPC_MS},(request,response)=>{
    const deadline=performance.now()+GATEWAY_RPC_MS;
    const run=async()=>{
      const reject=()=>{response.writeHead(503,{'connection':'close','cache-control':'no-store'});response.end();};
      if(!ready||used.has(request.socket)){reject();return;}
      used.add(request.socket);
      const signature=request.headers['x-lares-signature'];
      const length=request.headers['content-length'];
      if(request.method!=='POST'||!gatewayRpcPath(request.url??'')||typeof signature!=='string'||! /^[a-f0-9]{64}$/.test(signature)||request.headers['content-type']!=='application/json'||request.headers['content-encoding']!==undefined||request.headers['transfer-encoding']!==undefined||typeof length!=='string'||! /^[1-9][0-9]{0,3}$/.test(length)||Number(length)>GATEWAY_RPC_BYTES){reject();return;}
      const body=await readBody(request,Number(length));
      const reply=await options.authority.handle(request.url!,signature,body,deadline);
      if(response.destroyed||performance.now()>=deadline)return;
      response.writeHead(reply.status,{...reply.headers,'connection':'close','content-length':String(reply.body.length)});response.end(reply.body);
    };
    const pending=run().catch(()=>{if(!response.destroyed){response.writeHead(503,{'connection':'close'});response.end();}});
    work.add(pending);void pending.finally(()=>work.delete(pending));
  });
  server.on('connection',socket=>{
    if(clients.size>=64){socket.destroy();return;}
    clients.add(socket);
    // Absolute lifetime includes slow headers/body, pool wait, database work and reply.
    const timer=setTimeout(()=>socket.destroy(),GATEWAY_RPC_MS);
    socket.on('error',()=>{});socket.on('close',()=>{clearTimeout(timer);clients.delete(socket);});
  });
  server.on('clientError',(_error,socket)=>socket.destroy());
  try {
    await mkdir(dirname(options.socket),{recursive:true,mode:0o750});
    await chown(dirname(options.socket),uid,gid);await chmod(dirname(options.socket),0o750);
    await removeStaleSocket(options.socket,uid);
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.socket,()=>{server.off('error',reject);resolve();});});
    await chown(options.socket,uid,gid);await chmod(options.socket,0o660);ready=true;
  }catch{
    for(const client of clients)client.destroy();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
    throw new Error('keeper: gateway budget socket startup failed');
  }
  const owned=await lstat(options.socket);
  return async()=>{
    ready=false;const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
    for(const client of clients)client.destroy();await Promise.allSettled([...work]);await closed;
    try{const current=await lstat(options.socket);if(current.ino===owned.ino&&current.dev===owned.dev)await unlink(options.socket);}catch{}
  };
}
async function readBody(request:IncomingMessage,length:number):Promise<Buffer> {
  const parts:Buffer[]=[];let size=0;
  for await(const part of request){const bytes=Buffer.from(part);size+=bytes.length;if(size>GATEWAY_RPC_BYTES||size>length)throw new Error('Body too large');parts.push(bytes);}
  if(size!==length)throw new Error('Incomplete body');return Buffer.concat(parts,size);
}
