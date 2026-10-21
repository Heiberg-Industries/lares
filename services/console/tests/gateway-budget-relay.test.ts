import {afterEach,beforeEach,expect,it} from 'vitest';
import {createServer,type Server} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {relayGatewayBudget} from '../lib/gateway-budget-relay';
import {GATEWAY_ADMIT_PATH} from '@lares/agent-kit/gateway-admission-protocol';
let dir:string,server:Server|undefined,calls:number,seen:{body:Buffer;headers:Record<string,unknown>;url:string|undefined};
const signature='a'.repeat(64),reply=Buffer.from(' { "state": "synthetic" } ');
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'relay-'));calls=0;});
afterEach(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;await rm(dir,{recursive:true,force:true});});
async function start(status=200,wait=0,bytes=reply){
  const socketPath=join(dir,'gate.sock');
  server=createServer(async(request,response)=>{calls++;const parts:Buffer[]=[];for await(const chunk of request)parts.push(Buffer.from(chunk));seen={body:Buffer.concat(parts),headers:request.headers,url:request.url};
    if(wait)await new Promise(resolve=>setTimeout(resolve,wait));response.writeHead(status,{'content-type':'application/json','x-lares-signature':signature,'set-cookie':'forbidden'});response.end(bytes);
  });await new Promise<void>(resolve=>server!.listen(socketPath,resolve));return socketPath;
}
function request(body=' { "exact": "bytes" } ',path=GATEWAY_ADMIT_PATH,headers:Record<string,string>={}){
  return new Request('https://console.example.test'+path,{method:'POST',body,headers:{'content-type':'application/json','x-lares-signature':signature,...headers}});
}
it('forwards exact bytes and signature with no browser identity or response cookies',async()=>{
  const socketPath=await start(),body=' { "exact": "bytes" } ',response=await relayGatewayBudget(request(body,GATEWAY_ADMIT_PATH,{cookie:'untrusted',authorization:'untrusted',origin:'https://other.invalid'}),{socketPath});
  expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(reply);expect(response.headers.get('x-lares-signature')).toBe(signature);expect(response.headers.has('set-cookie')).toBe(false);
  expect(seen.body).toEqual(Buffer.from(body));expect(seen.headers.cookie).toBeUndefined();expect(seen.headers.authorization).toBeUndefined();expect(seen.headers.origin).toBeUndefined();expect(seen.url).toBe(GATEWAY_ADMIT_PATH);expect(calls).toBe(1);
});
it.each(['/v1/gateway-budget/admit?x=1','/v1/gateway-budget/%61dmit','/v1/gateway-budget/admit/','/v1/gateway-budget/other'])('refuses nonexact relay path %s',async path=>{
  const socketPath=await start();expect((await relayGatewayBudget(request('{}',path),{socketPath})).status).toBe(503);expect(calls).toBe(0);
});
it('bounds request and response bodies without retries',async()=>{
  const socketPath=await start(200,0,Buffer.alloc(8193));
  expect((await relayGatewayBudget(request('x'.repeat(8193)),{socketPath})).status).toBe(503);expect(calls).toBe(0);
  expect((await relayGatewayBudget(request(),{socketPath})).status).toBe(503);expect(calls).toBe(1);
});
it.each([302,503])('never follows or retries upstream status %s',async status=>{
  const socketPath=await start(status);expect((await relayGatewayBudget(request(),{socketPath})).status).toBe(503);expect(calls).toBe(1);
});
it('uses one deadline across forwarding and response without retry',async()=>{
  const socketPath=await start(200,100),before=performance.now();
  expect((await relayGatewayBudget(request(),{socketPath,timeoutMs:30})).status).toBe(503);expect(performance.now()-before).toBeLessThan(300);expect(calls).toBe(1);
});
it('cancels a never-completing incoming body at its deadline',async()=>{
  const socketPath=await start();let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([123]));},cancel(){cancelled=true;}});
  const req=new Request('https://console.example.test'+GATEWAY_ADMIT_PATH,{method:'POST',headers:{'content-type':'application/json','x-lares-signature':signature},body:stream,duplex:'half'} as RequestInit);
  expect((await relayGatewayBudget(req,{socketPath,timeoutMs:30})).status).toBe(503);expect(cancelled).toBe(true);expect(calls).toBe(0);
});
