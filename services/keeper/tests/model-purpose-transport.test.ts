import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomBytes} from 'node:crypto';
import {request as httpRequest,IncomingMessage} from 'node:http';
import {chmod,mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gatewayRawRequestHash} from '@lares/agent-kit/gateway-admission-protocol';
import {modelPurposeDispatchMac,type ModelPurposeDispatchFields} from '@lares/agent-kit/model-purpose-protocol';
import type {Pool} from 'pg';
import type {BudgetNativeCustodyStore,NativeCustodyGate} from '../lib/budget-native-custody.js';

const fixture=vi.hoisted(()=>({key:Buffer.from('runtime-control-fixture-key-32bytes!'.padEnd(32,'x').slice(0,32)),
  runtimeKey:vi.fn(),fetch:vi.fn()}));
vi.mock('../lib/model-purpose-broker.js',()=>({readModelPurposeRuntimeControlKey:fixture.runtimeKey}));

import {serveModelPurposeTransport,MODEL_PURPOSE_TRANSPORT_BODY_MAX} from '../lib/model-purpose-transport.js';

const uid=process.getuid?.()??0,gid=process.getgid?.()??0;
const ticket='T'.repeat(43),agent='neutral-helper',incarnation='123e4567-e89b-42d3-a456-426614174000';
const nativeKey='native-secret-fixture';
const keyFingerprint=createHash('sha256').update(nativeKey).digest('hex');
const profileHash='a'.repeat(64),endpointHash='b'.repeat(64),bindingId='123e4567-e89b-42d3-a456-426614174001';
let root:string,socketPath:string,stop:(()=>Promise<void>)|undefined,gateBusy=false;
let calls:Array<{url:string;headers:Headers;body:Buffer}>;
let responseMode:'ok'|'credential-error'|'bad-request'|'held-stream'|'compressed'|'backpressure'='ok';
let heldStream:ReadableStreamDefaultController<Uint8Array>|undefined;
let upstreamCancelled=false;
async function readFirstRequestDiagnostic(path:string){
  const deadline=Date.now()+1_000;
  while(Date.now()<deadline){
    try{const value=JSON.parse(await readFile(path,'utf8'));if(value.requestCount===1)return value;}catch{}
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('first-request diagnostic was not persisted');
}
const operation={kind:'operation',operationId:'123e4567-e89b-42d3-a456-426614174002',bindingId,credentialGeneration:'4',
  association:{agent,incarnation,definitionHash:'c'.repeat(64),purposeAlias:'fixture-brain'},phase:'active' as string,plaintext:'present',
  bindingReceipt:{operationId:'x',journalId:'j'},activationReceipt:{operation:'native-activation',journalId:'j'},keyFingerprint,reviewedPolicy:{pricing:{capabilityHash:profileHash,format:'anthropic'},
    capability:{aliases:['fixture-brain','other-a','other-b','other-c'],maxBodyBytes:1_048_576},key:{blocked:true}},userOwnershipId:'123e4567-e89b-42d3-a456-426614174003'};
const installationAccountId='123e4567-e89b-42d3-a456-426614174005';
const snapshot={operations:[operation],users:[{kind:'user',ownershipId:operation.userOwnershipId,teamOwnershipId:'123e4567-e89b-42d3-a456-426614174004',installationAccountId,endpoint:{origin:'https://gateway.fixture.invalid',hash:endpointHash}}],
  teams:[{kind:'team',ownershipId:'123e4567-e89b-42d3-a456-426614174004',installationAccountId,capabilityHash:profileHash,endpoint:{origin:'https://gateway.fixture.invalid',hash:endpointHash}}]};
const gate={inventory:()=>snapshot,readKey:()=>nativeKey} as unknown as NativeCustodyGate;
const custody={withGate:async<T>(work:(value:NativeCustodyGate)=>Promise<T>):Promise<T>=>{
  if(gateBusy)throw new Error('Native custody unavailable; explicit reconciliation is required');
  gateBusy=true;try{return await work(gate);}finally{gateBusy=false;}
}} as BudgetNativeCustodyStore;

function send(path='/v1/messages',body=Buffer.from('{"model":"fixture-brain"}'),nonce=randomBytes(32).toString('base64url'),headersOnly=false,
  extraHeaders:Record<string,string>={},omitHeader?:string){
  const signedPath=path.split('?',1)[0]??path;
  const safePath=(signedPath==='/v1/messages'||signedPath==='/v1/chat/completions'?signedPath:'/v1/messages') as '/v1/messages'|'/v1/chat/completions';
  const deadline=Date.now()+10_000,requestHash=gatewayRawRequestHash('POST',safePath,body);
  const fields:ModelPurposeDispatchFields={method:'POST',path:safePath,requestHash,ticket,agent,incarnation,nonce,deadline};
  const headers:Record<string,string>={'content-type':'application/json','content-length':String(body.length),
    'x-lares-budget-intent':ticket,'x-lares-purpose-agent':agent,'x-lares-purpose-incarnation':incarnation,
    'x-lares-purpose-request-hash':requestHash,'x-lares-purpose-nonce':nonce,'x-lares-purpose-deadline':String(deadline),
    'x-lares-purpose-mac':modelPurposeDispatchMac(fixture.key,fields).toString('base64url')};
  Object.assign(headers,extraHeaders);if(omitHeader)delete headers[omitHeader];
  return new Promise<{status:number;headers:IncomingMessage['headers'];body:Buffer;incoming:IncomingMessage}>((resolve,reject)=>{
    const request=httpRequest({socketPath,method:'POST',path,headers},incoming=>{
      if(headersOnly){resolve({status:incoming.statusCode??0,headers:incoming.headers,body:Buffer.alloc(0),incoming});return;}
      const chunks:Buffer[]=[];incoming.on('data',chunk=>chunks.push(Buffer.from(chunk)));
      incoming.on('end',()=>resolve({status:incoming.statusCode??0,headers:incoming.headers,body:Buffer.concat(chunks),incoming}));
    });request.once('error',error=>{if((error as NodeJS.ErrnoException).code!=='EPIPE')reject(error);});request.end(body);
  });
}

beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'lares-model-purpose-transport-'));await chmod(root,0o750);socketPath=join(root,'gateway.sock');
  vi.stubEnv('CI','true');vi.stubEnv('LARES_GATEWAY_PROBE_DIAGNOSTICS','1');vi.stubEnv('TMPDIR',root);
  operation.phase='active';gateBusy=false;calls=[];responseMode='ok';heldStream=undefined;upstreamCancelled=false;
  fixture.runtimeKey.mockImplementation(async()=>Buffer.from(fixture.key));
  fixture.fetch.mockImplementation(async(input:URL,init:RequestInit)=>{
    const headers=new Headers(init.headers);const body=Buffer.from(init.body as Uint8Array);
    calls.push({url:input.href,headers,body});
    if(gateBusy!==true)throw new Error('native gate was not held during response headers');
    if(responseMode==='credential-error')return new Response(`secret=${nativeKey}`,{status:401,headers:{'set-cookie':nativeKey,'x-api-key':nativeKey}});
    if(responseMode==='bad-request')return new Response(`private=${nativeKey}`,{status:400,headers:{'x-api-key':nativeKey}});
    if(responseMode==='held-stream')return new Response(new ReadableStream<Uint8Array>({start(controller){heldStream=controller;}}),{status:200,headers:{'content-type':'text/event-stream'}});
    if(responseMode==='compressed')return new Response(`secret=${nativeKey}`,{status:200,headers:{'content-type':'application/json','content-encoding':'gzip','content-length':'64'}});
    if(responseMode==='backpressure')return new Response(new ReadableStream<Uint8Array>({
      pull(controller){controller.enqueue(new Uint8Array(512*1024));},
      cancel(){upstreamCancelled=true;},
    }),{status:200,headers:{'content-type':'text/event-stream'}});
    return new Response('stream-ok',{status:200,headers:{'content-type':'text/event-stream','cache-control':'no-store'}});
  });
  vi.stubGlobal('fetch',fixture.fetch);
  const pool={query:vi.fn(async()=>({rows:[{agent,incarnation,credential_generation:'4',installation_account_id:'123e4567-e89b-42d3-a456-426614174005',
    recovery_epoch:'epoch-1',endpoint_generation:'2',binding_id:bindingId,request_hash:gatewayRawRequestHash('POST','/v1/messages',Buffer.from('{"model":"fixture-brain"}')),
    profile_hash:profileHash,endpoint_hash:endpointHash,key_fingerprint:keyFingerprint,purpose_alias:'fixture-brain',expires_at_ms:String(Date.now()+20_000),
    maximum_liability:'3',pricing_profile:{format:'anthropic',capabilityHash:profileHash}}]}))} as unknown as Pool;
  stop=await serveModelPurposeTransport({socket:socketPath,runtimeSecretsDir:root,custody,ticketPool:pool,rootUid:uid,socketUid:uid,socketGid:gid});
});
afterEach(async()=>{if(stop)await stop();stop=undefined;vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});

describe('Keeper model-purpose dispatch transport',()=>{
  it('records only the first local-socket refusal stage and starts at zero requests',async()=>{
    const marker=join(root,'lares-model-purpose-transport.json');
    const before=JSON.parse(await readFile(marker,'utf8'));
    expect(before).toEqual({schema:1,requestCount:0,stage:'idle',statusCode:0,
      checks:{headersAccepted:false,fieldsAccepted:false,bodyLengthMatches:false,upstreamResponseSeen:false}});
    const response=await send('/v1/messages?x=1');
    expect(response.status).toBe(400);
    const after=await readFirstRequestDiagnostic(marker);
    expect(after.requestCount).toBe(1);expect(after.stage).toBe('headers');expect(after.statusCode).toBe(400);
    expect(Object.keys(after).sort()).toEqual(['checks','requestCount','schema','stage','statusCode']);
    expect(JSON.stringify(after)).not.toContain(nativeKey);
  });

  it('writes no marker when the existing diagnostic opt-in is absent',async()=>{
    await stop!();stop=undefined;
    const marker=join(root,'lares-model-purpose-transport.json');await rm(marker,{force:true});
    vi.stubEnv('LARES_GATEWAY_PROBE_DIAGNOSTICS','0');
    stop=await serveModelPurposeTransport({socket:socketPath,runtimeSecretsDir:root,custody,ticketPool:{} as Pool,
      rootUid:uid,socketUid:uid,socketGid:gid});
    expect((await send('/v1/messages?x=1')).status).toBe(400);
    await expect(readFile(marker,'utf8')).rejects.toMatchObject({code:'ENOENT'});
  });

  it('does not let a later sequential request replace the first request record',async()=>{
    expect((await send('/v1/messages?x=1')).status).toBe(400);
    const marker=join(root,'lares-model-purpose-transport.json');
    await readFirstRequestDiagnostic(marker);
    const firstRaw=await readFile(marker,'utf8');
    expect((await send()).status).toBe(200);
    expect(await readFile(marker,'utf8')).toBe(firstRaw);
  });

  it('does not let an overlapping second request replace the first request record',async()=>{
    responseMode='held-stream';
    const first=await send('/v1/messages',undefined,randomBytes(32).toString('base64url'),true);
    expect(first.status).toBe(200);
    const finished=new Promise<void>(resolve=>{first.incoming.once('end',()=>resolve());first.incoming.resume();});
    expect((await send('/v1/messages?x=1')).status).toBe(400);
    const marker=join(root,'lares-model-purpose-transport.json');
    expect(JSON.parse(await readFile(marker,'utf8')).requestCount).toBe(0);
    heldStream!.enqueue(Buffer.from('stream-ok'));heldStream!.close();
    await finished;
    const record=await readFirstRequestDiagnostic(marker);
    expect(record.stage).toBe('upstream');expect(record.statusCode).toBe(200);
  });

  it('keeps a first-request close record after a later refusal',async()=>{
    responseMode='held-stream';
    const first=await send('/v1/messages',undefined,randomBytes(32).toString('base64url'),true);
    expect(first.status).toBe(200);
    const marker=join(root,'lares-model-purpose-transport.json');
    first.incoming.destroy();
    const record=await readFirstRequestDiagnostic(marker);
    expect(record.stage).toBe('upstream');expect(record.statusCode).toBe(200);
    const raw=await readFile(marker,'utf8');
    expect((await send('/v1/messages?x=1')).status).toBe(400);
    expect(await readFile(marker,'utf8')).toBe(raw);
  });

  it('identifies a missing dispatch field without retaining request values',async()=>{
    const response=await send('/v1/messages',undefined,randomBytes(32).toString('base64url'),false,{},'x-lares-purpose-mac');
    expect(response.status).toBe(400);
    const after=await readFirstRequestDiagnostic(join(root,'lares-model-purpose-transport.json'));
    expect(after.stage).toBe('fields');expect(after.statusCode).toBe(400);
    expect(after.checks.headersAccepted).toBe(true);expect(after.checks.fieldsAccepted).toBe(false);
    expect(JSON.stringify(after)).not.toContain(ticket);
  });

  it('marks a sanitized upstream 400 after reaching the native dispatch path',async()=>{
    responseMode='bad-request';
    const response=await send();
    expect(response.status).toBe(400);expect(response.body.toString()).not.toContain(nativeKey);
    const after=await readFirstRequestDiagnostic(join(root,'lares-model-purpose-transport.json'));
    expect(after.stage).toBe('upstream');expect(after.statusCode).toBe(400);
    expect(after.checks).toEqual({headersAccepted:true,fieldsAccepted:true,bodyLengthMatches:true,upstreamResponseSeen:true});
    expect(JSON.stringify(after)).not.toContain(nativeKey);
  });

  it('authenticates exact body and identity, resolves only stored destination/key, and streams the response',async()=>{
    const response=await send();
    expect(response.status).toBe(200);expect(response.body.toString()).toBe('stream-ok');
    expect(calls).toHaveLength(1);expect(calls[0]!.url).toBe('https://gateway.fixture.invalid/v1/messages');
    expect(calls[0]!.headers.get('x-api-key')).toBe(nativeKey);expect(calls[0]!.headers.get('x-lares-budget-intent')).toBe(ticket);
    expect(calls[0]!.body.toString()).toBe('{"model":"fixture-brain"}');
  });

  it('refuses transport while the native binding is still blocked and awaiting activation',async()=>{
    operation.phase='bound-closed';
    const response=await send();
    expect(response.status).toBe(503);expect(calls).toHaveLength(0);
  });

  it('refuses transport while native activation is pending',async()=>{
    operation.phase='activation-pending';
    expect((await send()).status).toBe(503);expect(calls).toHaveLength(0);
  });

  it('refuses transport while native activation is uncertain',async()=>{
    operation.phase='uncertain';
    expect((await send()).status).toBe(503);expect(calls).toHaveLength(0);
  });

  it('burns a valid nonce once and never retries an uncertain or duplicate request',async()=>{
    const nonce=randomBytes(32).toString('base64url');
    expect((await send('/v1/messages',undefined,nonce)).status).toBe(200);
    expect((await send('/v1/messages',undefined,nonce)).status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it('burns the prepared ticket once even when the runtime signs a fresh nonce',async()=>{
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it('rejects body changes, alternate routes, and oversized bodies before upstream dispatch',async()=>{
    const changed=await send('/v1/messages',Buffer.from('{"model":"other"}'));
    expect(changed.status).toBe(403);
    const alternate=await send('/v1/messages?x=1');expect(alternate.status).toBe(400);
    const tooLarge=Buffer.alloc(0),largeLength=MODEL_PURPOSE_TRANSPORT_BODY_MAX+1;
    const large=await new Promise<number>((resolve,reject)=>{
      const request=httpRequest({socketPath,method:'POST',path:'/v1/messages',headers:{'content-type':'application/json','content-length':String(largeLength),
        'x-lares-budget-intent':ticket,'x-lares-purpose-agent':agent,'x-lares-purpose-incarnation':incarnation,
        'x-lares-purpose-request-hash':gatewayRawRequestHash('POST','/v1/messages',tooLarge),
        'x-lares-purpose-nonce':randomBytes(32).toString('base64url'),'x-lares-purpose-deadline':String(Date.now()+10_000),
        'x-lares-purpose-mac':Buffer.alloc(32).toString('base64url')}} ,incoming=>{
        incoming.resume();incoming.once('end',()=>resolve(incoming.statusCode??0));
      });
      request.once('error',error=>{if((error as NodeJS.ErrnoException).code!=='ECONNRESET')reject(error);});request.flushHeaders();
    });
    expect(large).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('uses the same native gate for dispatch and lets an already-held mutation fail dispatch closed',async()=>{
    gateBusy=true;
    const response=await send();
    expect(response.status).toBe(503);expect(calls).toHaveLength(0);
    gateBusy=false;
    // The host burns the ticket before attempting the native-gated dispatch, so a busy-gate
    // refusal cannot be retried with the same ticket after mutation completes.
    expect((await send()).status).toBe(409);
    expect(gateBusy).toBe(false);
  });

  it('releases the native gate after response headers so a later mutation can proceed while streaming',async()=>{
    responseMode='held-stream';
    const delivered=await send('/v1/messages',undefined,randomBytes(32).toString('base64url'),true);
    expect(delivered.status).toBe(200);expect(gateBusy).toBe(false);
    await expect(custody.withGate(async()=>{gateBusy=false;return 'mutation-ok';})).resolves.toBe('mutation-ok');
    heldStream!.enqueue(Buffer.from('stream-ok'));heldStream!.close();
    const text=await new Promise<string>((resolve,reject)=>{
      const chunks:Buffer[]=[];delivered.incoming.on('data',chunk=>chunks.push(Buffer.from(chunk)));
      delivered.incoming.once('end',()=>resolve(Buffer.concat(chunks).toString()));delivered.incoming.once('error',reject);
    });
    expect(text).toBe('stream-ok');expect(calls).toHaveLength(1);
  });

  it('returns generic non-success errors without upstream credential headers or body',async()=>{
    responseMode='credential-error';
    const response=await send();
    expect(response.status).toBe(401);expect(response.body.toString()).not.toContain(nativeKey);
    expect(response.headers['set-cookie']).toBeUndefined();expect(response.headers['x-api-key']).toBeUndefined();
  });

  it('rejects compressed upstream responses without forwarding stale encoding or length metadata',async()=>{
    responseMode='compressed';
    const response=await send();
    expect(response.status).toBe(502);expect(response.body.toString()).not.toContain(nativeKey);
    expect(response.headers['content-encoding']).toBeUndefined();expect(response.headers['content-length']).toBe(String(response.body.length));
  });

  it('cancels the upstream stream when a disconnected client is blocked by backpressure',async()=>{
    responseMode='backpressure';
    const delivered=await send('/v1/messages',undefined,randomBytes(32).toString('base64url'),true);
    expect(delivered.status).toBe(200);
    delivered.incoming.destroy();
    const deadline=Date.now()+1_000;
    while(!upstreamCancelled&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    expect(upstreamCancelled).toBe(true);
  });
});
