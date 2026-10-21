import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {request as httpRequest} from 'node:http';
import {createConnection} from 'node:net';
import {mkdtemp,rm,stat,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serveGatewayBudget} from '../lib/gateway-budget-server.js';
import {GatewayBudgetAuthority,readGatewayServiceKey,type GatewayRpcReply} from '../lib/gateway-budget.js';
import {GATEWAY_ADMIT_PATH,GATEWAY_SETTLE_PATH,gatewayCanonical,gatewaySignature} from '@lares/agent-kit/gateway-admission-protocol';
let dir:string,stop:(()=>Promise<void>)|undefined;
const ownership={uid:process.getuid!(),gid:process.getgid!()},key=Buffer.alloc(32,7);
const handle=vi.fn(async(_path:string,_signature:string|undefined,_raw:Buffer):Promise<GatewayRpcReply>=>({status:200,headers:{'content-type':'application/json','x-lares-signature':'a'.repeat(64)},body:Buffer.from('{"state":"denied"}')}));
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'gate-'));handle.mockClear();});
afterEach(async()=>{await stop?.();stop=undefined;await rm(dir,{recursive:true,force:true});});
async function start(authority={handle} as unknown as GatewayBudgetAuthority){const socket=join(dir,'gate.sock');stop=await serveGatewayBudget({socket,authority,ownership});return socket;}
async function call(socket:string,body:Buffer,path=GATEWAY_ADMIT_PATH,headers:Record<string,string>={}){
  return new Promise<{status:number;body:Buffer}>((resolve,reject)=>{
    const req=httpRequest({socketPath:socket,path,method:'POST',agent:false,headers:{'content-type':'application/json','content-length':String(body.length),'x-lares-signature':gatewaySignature(key,'request',GATEWAY_ADMIT_PATH,body),...headers}},response=>{
      const parts:Buffer[]=[];response.on('data',v=>parts.push(v));response.on('end',()=>resolve({status:response.statusCode!,body:Buffer.concat(parts)}));response.on('error',reject);
    });req.on('error',reject);req.end(body);
  });
}
it('owns a restricted separate socket and delivers exact bytes without an actor',async()=>{
  const socket=await start(),body=gatewayCanonical({version:1});
  expect((await stat(socket)).mode&0o777).toBe(0o660);expect((await stat(dir)).mode&0o777).toBe(0o750);
  expect((await call(socket,body)).status).toBe(200);expect(handle).toHaveBeenCalledOnce();
  expect(handle.mock.calls[0].slice(0,3)).toEqual([GATEWAY_ADMIT_PATH,gatewaySignature(key,'request',GATEWAY_ADMIT_PATH,body),body]);
});
it.each(['/v1/gateway-budget/admit?x=1','/v1/gateway-budget/%61dmit','/v1/gateway-budget/admit/','/v1/gateway-budget/other'])('rejects alternate raw request targets %s',async path=>{
  const socket=await start();expect((await call(socket,Buffer.from('{}'),path)).status).toBe(503);expect(handle).not.toHaveBeenCalled();
});
it('bounds bodies, signatures and encodings before authority work',async()=>{
  const socket=await start();
  for(const [body,headers] of [[Buffer.alloc(8193),{}],[Buffer.from('{}'),{'x-lares-signature':'invalid'}],[Buffer.from('{}'),{'content-encoding':'gzip'}],[Buffer.from('{}'),{'content-type':'text/plain'}]] as const){
    const result=await call(socket,body,GATEWAY_ADMIT_PATH,headers).catch(error=>{if(['EPIPE','ECONNRESET'].includes(error.code))return {status:503};throw error;});
    expect(result.status).toBe(503);
  }
  expect(handle).not.toHaveBeenCalled();
});
it('real production absence of a recovery witness cannot allow a signed request',async()=>{
  const writer={run:vi.fn(async()=>{throw new Error('must not run without recovery witness');})};
  const socket=await start(new GatewayBudgetAuthority({} as never,key,writer));
  const raw=gatewayCanonical({version:1,nonce:'a'.repeat(64),ticket:'a'.repeat(43),requestHash:'b'.repeat(64),profileHash:'c'.repeat(64),endpointHash:'d'.repeat(64),keyFingerprint:'e'.repeat(64),purposeAlias:'example-brain'});
  expect((await call(socket,raw)).status).toBe(503);
  expect(writer.run).not.toHaveBeenCalled();
});
it('refuses signed settlement before database access when financial custody is absent',async()=>{
  const pool={query:vi.fn(),connect:vi.fn()};
  const authority=new GatewayBudgetAuthority(pool as never,key,undefined);
  const body=gatewayCanonical({version:1}),signature=gatewaySignature(key,'request',GATEWAY_SETTLE_PATH,body);
  expect((await authority.handle(GATEWAY_SETTLE_PATH,signature,body)).status).toBe(503);
  expect(pool.query).not.toHaveBeenCalled();expect(pool.connect).not.toHaveBeenCalled();
});
it('refuses regular-file replacement and leaves another live listener alone',async()=>{
  const path=join(dir,'gate.sock');await writeFile(path,'keep');
  await expect(serveGatewayBudget({socket:path,authority:{handle} as never,ownership})).rejects.toThrow('startup failed');expect(await readFile(path,'utf8')).toBe('keep');
  await rm(path);await start();await expect(serveGatewayBudget({socket:path,authority:{handle} as never,ownership})).rejects.toThrow('startup failed');
});
it('closes incomplete slow headers within the absolute connection lifetime',async()=>{
  const path=await start(),started=performance.now();
  await new Promise<void>((resolve,reject)=>{const socket=createConnection(path);socket.on('error',reject);socket.on('connect',()=>socket.write('POST /v1/gateway-budget/admit HTTP/1.1\r\n'));socket.on('close',()=>resolve());});
  expect(performance.now()-started).toBeLessThan(4000);expect(handle).not.toHaveBeenCalled();
},5000);
it('missing or unsafe service-key custody never creates a replacement key',()=>{
  expect(readGatewayServiceKey(undefined)).toBeUndefined();expect(readGatewayServiceKey(join(dir,'missing'))).toBeUndefined();expect(readGatewayServiceKey(dir)).toBeUndefined();
});
