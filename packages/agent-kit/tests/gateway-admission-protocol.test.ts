import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {GATEWAY_ADMIT_PATH,GATEWAY_SETTLE_PATH,gatewayCanonical,gatewayRawRequestHash,gatewaySignature,verifyGatewaySignature,parseGatewayDocument,gatewayAdmitSchema,gatewayGrantHash} from '../src/gateway-admission-protocol.js';
import {gatewayPricingSchema,gatewayMaximumLiability,gatewayActualAmount} from '../src/gateway-pricing.js';
const request={version:1 as const,nonce:'1'.repeat(64),requestHash:'2'.repeat(64),profileHash:'3'.repeat(64),endpointHash:'4'.repeat(64),keyFingerprint:'5'.repeat(64),purposeAlias:'example-brain',ticket:'a'.repeat(43)};
const key=Buffer.alloc(32,7);
describe('canonical signed gateway protocol',()=>{
  it('hashes the exact supported model method, path and final body bytes',()=>{
    const body=Buffer.from('{"messages":[]}'),path='/v1/messages';
    const expected=execFileSync('python3',['-c',`import hashlib,sys
print(hashlib.sha256(b'lares.gateway.raw-request.v1\\0POST\\0/v1/messages\\0'+sys.stdin.buffer.read()).hexdigest())`],{input:body,encoding:'utf8'}).trim();
    expect(gatewayRawRequestHash('POST',path,body)).toBe(expected);
    expect(()=>gatewayRawRequestHash('GET',path,body)).toThrow();
    expect(()=>gatewayRawRequestHash('POST','/v1/messages?x=1',body)).toThrow();
  });
  it('matches independent Python JSON/HMAC bytes including ASCII escaping',()=>{
    const document={...request,nested:['\u007f','\u00e6','\ud83d\ude00']};
    const expected=JSON.parse(execFileSync('python3',['-c',`import json,hashlib,hmac,sys
p=json.load(sys.stdin)
raw=json.dumps(p,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode()
envelope=json.dumps(['lares.gateway.rpc.v1','request','POST','/v1/gateway-budget/admit',hashlib.sha256(raw).hexdigest()],sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()
print(json.dumps({'body':raw.decode(),'signature':hmac.new(bytes([7])*32,envelope,hashlib.sha256).hexdigest()}))`],{input:JSON.stringify(document),encoding:'utf8'}));
    const raw=gatewayCanonical(document);expect(raw.toString()).toBe(expected.body);expect(gatewaySignature(key,'request',GATEWAY_ADMIT_PATH,raw)).toBe(expected.signature);
  });
  it('separates request, response, path and exact body',()=>{
    const raw=gatewayCanonical(request),signature=gatewaySignature(key,'request',GATEWAY_ADMIT_PATH,raw);
    expect(verifyGatewaySignature(key,signature,'request',GATEWAY_ADMIT_PATH,raw)).toBe(true);
    expect(verifyGatewaySignature(key,signature,'response',GATEWAY_ADMIT_PATH,raw)).toBe(false);
    expect(verifyGatewaySignature(key,signature,'request',GATEWAY_SETTLE_PATH,raw)).toBe(false);
    expect(verifyGatewaySignature(key,signature,'request',GATEWAY_ADMIT_PATH,Buffer.concat([raw,Buffer.from(' ')]))).toBe(false);
  });
  it.each(['{"version":1,"version":1}','{"a":{"b":1,"b":1}}','{"a":1e0}','{"a":NaN}','{"a":9007199254740992}','{}\n',' '.repeat(8193)])('rejects ambiguous or oversized bytes %#',raw=>{expect(()=>parseGatewayDocument(Buffer.from(raw))).toThrow();});
  it('rejects invalid UTF-8 and unrecognized/caller identity fields',()=>{
    expect(()=>parseGatewayDocument(Buffer.from([0xff]))).toThrow();
    expect(()=>gatewayAdmitSchema.parse({...request,agent:'helper'})).toThrow();
    expect(()=>gatewayAdmitSchema.parse({...request,nonce:'bad'})).toThrow();
    expect(gatewayAdmitSchema.parse(parseGatewayDocument(gatewayCanonical(request)))).toEqual(request);
  });
  it('commits to every echoed grant field without retaining its identity',()=>{
    const {ticket,...base}=request,grant={...base,attemptId:'11111111-1111-4111-8111-111111111111',bindingId:'22222222-2222-4222-8222-222222222222'};
    expect(gatewayGrantHash(grant)).not.toBe(gatewayGrantHash({...grant,purposeAlias:'example-writer'}));
    expect(gatewayGrantHash(grant)).not.toBe(gatewayGrantHash({...grant,nonce:'6'.repeat(64)}));
  });
});
describe('fixed reviewed pricing arithmetic',()=>{
  const profile=gatewayPricingSchema.parse({version:1,capabilityHash:'f'.repeat(64),format:'openai',limits:{inputTokens:1000,outputTokens:1000},usdPerMillionTokens:{input:'10',output:'90',cacheRead:'5',cacheWrite:'0'}});
  it('reserves the worst allowed input category plus the full output bound',()=>{
    expect(gatewayMaximumLiability(profile)).toBe('0.1');
    expect(gatewayMaximumLiability({...profile,format:'anthropic',usdPerMillionTokens:{...profile.usdPerMillionTokens,input:'10',output:'80',cacheWrite:'20'}})).toBe('0.1');
  });
  it('prices cached OpenAI input as a subset and Anthropic categories separately',()=>{
    const usage={inputTokens:100,outputTokens:10,cacheReadTokens:40,cacheWriteTokens:0};
    expect(gatewayActualAmount(profile,usage)).toBe('0.0017');
    expect(gatewayActualAmount({...profile,format:'anthropic',usdPerMillionTokens:{...profile.usdPerMillionTokens,cacheWrite:'20'}},{...usage,cacheWriteTokens:20})).toBe('0.0025');
    expect(()=>gatewayActualAmount(profile,{...usage,cacheReadTokens:101})).toThrow();
    expect(()=>gatewayActualAmount(profile,{...usage,cacheWriteTokens:1})).toThrow();
  });
  it('aggregates and rounds up once, including sub-ledger-unit positive usage',()=>{
    const tiny={...profile,usdPerMillionTokens:{input:'0.000000000000000001',output:'0.000000000000000001',cacheRead:'0.000000000000000001',cacheWrite:'0'}};
    expect(gatewayActualAmount(tiny,{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0})).toBe('0.000000000000000001');
    expect(gatewayActualAmount(tiny,{inputTokens:999999,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0})).toBe('0.000000000000000002');
    expect(gatewayMaximumLiability(tiny)).toBe('0.000000000000000001');
  });
  it('keeps financially valid observed overages and refuses unsupported profiles',()=>{
    expect(gatewayActualAmount(profile,{inputTokens:0,outputTokens:2000,cacheReadTokens:0,cacheWriteTokens:0})).toBe('0.18');
    for(const rates of [{input:'1e2'},{input:'1000001'},{cacheWrite:'1'}])expect(()=>gatewayPricingSchema.parse({...profile,usdPerMillionTokens:{...profile.usdPerMillionTokens,...rates}})).toThrow();
    expect(()=>gatewayMaximumLiability({...profile,usdPerMillionTokens:{input:'0',output:'0',cacheRead:'0',cacheWrite:'0'}})).toThrow();
  });
});
