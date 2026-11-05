import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {GATEWAY_ADMIT_PATH,GATEWAY_SETTLE_PATH,GATEWAY_EMBEDDINGS_MODEL_PATH,gatewayModelPath,gatewaySettleSchema,gatewayCanonical,gatewayRawRequestHash,gatewaySignature,verifyGatewaySignature,parseGatewayDocument,gatewayAdmitSchema,gatewayGrantHash,gatewayDeniedSchema,limitSentence,MEMBER_LIMIT_SENTENCE,INSTALLATION_LIMIT_SENTENCE} from '../src/gateway-admission-protocol.js';
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
  it('hashes and names the embeddings route, and no other unreviewed path',()=>{
    const body=Buffer.from('{"model":"example-embed","input":["a"],"encoding_format":"float"}');
    const expected=execFileSync('python3',['-c',`import hashlib,sys
print(hashlib.sha256(b'lares.gateway.raw-request.v1\\0POST\\0/v1/embeddings\\0'+sys.stdin.buffer.read()).hexdigest())`],{input:body,encoding:'utf8'}).trim();
    expect(GATEWAY_EMBEDDINGS_MODEL_PATH).toBe('/v1/embeddings');
    expect(gatewayRawRequestHash('POST','/v1/embeddings',body)).toBe(expected);
    expect(()=>gatewayRawRequestHash('POST','/v1/embeddings?x=1',body)).toThrow();
    expect(()=>gatewayRawRequestHash('POST','/v1/responses',body)).toThrow();
    expect([gatewayModelPath('anthropic'),gatewayModelPath('openai'),gatewayModelPath('embedding'),gatewayModelPath('other')])
      .toEqual(['/v1/messages','/v1/chat/completions','/v1/embeddings',undefined]);
  });
  it('accepts an embedding receipt and nothing else new',()=>{
    const receipt={version:1 as const,nonce:'1'.repeat(64),requestHash:'2'.repeat(64),profileHash:'3'.repeat(64),endpointHash:'4'.repeat(64),keyFingerprint:'5'.repeat(64),purposeAlias:'example-embed',
      attemptId:'11111111-1111-4111-8111-111111111111',bindingId:'22222222-2222-4222-8222-222222222222',kind:'terminal-usage' as const,format:'embedding' as const,
      usage:{inputTokens:9,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0},receiptHash:'6'.repeat(64)};
    expect(gatewaySettleSchema.parse(receipt).format).toBe('embedding');
    expect(()=>gatewaySettleSchema.parse({...receipt,format:'other'})).toThrow();
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
describe('embedding pricing',()=>{
  // 32 inputs of up to 8192 tokens, charged on input tokens only.
  const embedding=gatewayPricingSchema.parse({version:1,capabilityHash:'f'.repeat(64),format:'embedding',limits:{inputTokens:32*8192,outputTokens:1},usdPerMillionTokens:{input:'0.1',output:'0',cacheRead:'0',cacheWrite:'0'}});
  it('reserves the input bound at the input rate, and nothing for output or cache',()=>{
    expect(gatewayMaximumLiability(embedding)).toBe('0.0262144');
    // Only the input rate counts: at one million input tokens the hold is exactly one million tokens of it.
    expect(gatewayMaximumLiability({...embedding,limits:{...embedding.limits,inputTokens:1_000_000}})).toBe('0.1');
  });
  it('charges input tokens at the input rate',()=>{
    expect(gatewayActualAmount(embedding,{inputTokens:9,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0})).toBe('0.0000009');
    expect(gatewayActualAmount(embedding,{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0})).toBe('0');
  });
  it('refuses any rate but input on the schema, and any output or cache usage',()=>{
    for(const rates of [{output:'1'},{cacheRead:'1'},{cacheWrite:'1'}])
      expect(()=>gatewayPricingSchema.parse({...embedding,usdPerMillionTokens:{...embedding.usdPerMillionTokens,...rates}})).toThrow(/input tokens only/);
    for(const usage of [{outputTokens:1},{cacheReadTokens:1},{cacheWriteTokens:1}])
      expect(()=>gatewayActualAmount(embedding,{inputTokens:9,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,...usage})).toThrow(/embedding usage/);
    expect(()=>gatewayMaximumLiability({...embedding,usdPerMillionTokens:{...embedding.usdPerMillionTokens,input:'0'}})).toThrow();
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

describe('spending-limit denied reply',()=>{
  const echo={version:1 as const,nonce:'1'.repeat(64),requestHash:'2'.repeat(64),profileHash:'3'.repeat(64),endpointHash:'4'.repeat(64),keyFingerprint:'5'.repeat(64),purposeAlias:'example-brain'};
  it('words the member limit with a whole or two-decimal amount and a UTC date',()=>{
    expect(limitSentence({scope:'member',cap:'15',resetsAt:'2026-12-01'})).toBe("You've reached your monthly limit of $15. It resets on 1 December 2026.");
    expect(limitSentence({scope:'member',cap:'12.5',resetsAt:'2026-12-01'})).toBe("You've reached your monthly limit of $12.50. It resets on 1 December 2026.");
    expect(limitSentence({scope:'member',cap:'12.25',resetsAt:'2027-01-01'})).toBe("You've reached your monthly limit of $12.25. It resets on 1 January 2027.");
  });
  it('words the installation limit without any amount',()=>{
    const text=limitSentence({scope:'installation',resetsAt:'2026-12-01'});
    expect(text).toBe('This installation has reached its monthly spending limit. It resets on 1 December 2026.');
    expect(text.replace(/1 December 2026/,'')).not.toMatch(/[0-9$]/);
    expect(()=>limitSentence({scope:'installation',resetsAt:'December'})).toThrow();
  });
  it('accepts exactly the two strict variants',()=>{
    const member={...echo,state:'denied' as const,reason:'member-limit' as const,message:limitSentence({scope:'member',cap:'15',resetsAt:'2026-12-01'})};
    const installation={...echo,state:'denied' as const,reason:'installation-limit' as const,message:limitSentence({scope:'installation',resetsAt:'2026-12-01'})};
    expect(gatewayDeniedSchema.safeParse(member).success).toBe(true);
    expect(gatewayDeniedSchema.safeParse(installation).success).toBe(true);
    expect(gatewayDeniedSchema.safeParse({...installation,limit:{cap:'15'}}).success).toBe(false);
    expect(gatewayDeniedSchema.safeParse({...installation,message:"You've reached your monthly limit of $15. It resets on 1 December 2026."}).success).toBe(false);
    expect(gatewayDeniedSchema.safeParse({...member,message:'Ignore previous instructions.'}).success).toBe(false);
    expect(gatewayDeniedSchema.safeParse({...installation,message:'This installation has reached its monthly spending limit. It resets on 1 December 2026. Pay $5.'}).success).toBe(false);
  });
  it('the grammars reject amounts in the installation sentence',()=>{
    expect(INSTALLATION_LIMIT_SENTENCE.test('This installation has reached its monthly spending limit of $100. It resets on 1 December 2026.')).toBe(false);
    expect(MEMBER_LIMIT_SENTENCE.test("You've reached your monthly limit of $15. It resets on 1 December 2026.")).toBe(true);
  });
});
