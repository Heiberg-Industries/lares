import {describe,expect,it} from 'vitest';
import {assertPrivateConsoleEnvelope,assertPrivateConsoleRequest,assertVerifiedPrivateConsoleMessage,verifiedPrivateConsoleResponse,verifiedPrivateConsoleMessageReceipt,verifiedPrivateConsoleModelMessageReceipt,verifiedPrivateConsoleModelResponseReceipt,PRIVATE_CONSOLE_VAULT_CAPSULE_HEADER,PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER} from '../src/private-console-envelope.js';
const humanCapsule=(requestId='m'.repeat(43))=>`${Buffer.from(JSON.stringify({version:1,request:{requestId,purpose:'human'}})).toString('base64url')}.signature`;
describe('private console envelope',()=>{
 const path='/eve/v1/session/private';
 it('accepts current browser text, create operation IDs and exact card answers',()=>{
  expect(()=>assertPrivateConsoleEnvelope({message:'hello',operationId:'browser-operation'},'/eve/v1/session')).not.toThrow();
  expect(()=>assertPrivateConsoleEnvelope({message:'hello'},path)).not.toThrow();
  expect(()=>assertPrivateConsoleEnvelope({answers:[{interactionId:'card',optionId:'approve'}]},path)).not.toThrow();
  expect(()=>assertPrivateConsoleEnvelope({},'/eve/v1/session/private/cancel')).not.toThrow();
 });
 for(const extra of ['callback','activityObserver','clientContext','mode','outputSchema','capabilities','forwardedPrincipal','unknown'])it(`rejects ${extra} before dispatch`,()=>{
  expect(()=>assertPrivateConsoleEnvelope({message:'hello',[extra]:{}},path)).toThrow();
 });
 for(const message of [[{type:'text',text:'hello'}],[{type:'file',mediaType:'text/plain',data:'https://example.invalid/file'}],[{type:'file',mediaType:'text/plain',data:'internalref:secret'}],{text:'hello'}])it('refuses files, internal references and unsupported structured input',()=>{
  expect(()=>assertPrivateConsoleEnvelope({message},path)).toThrow();
 });
 it('rejects content on resolver/control routes and never accepts freeform approval payloads',async()=>{
  expect(()=>assertPrivateConsoleEnvelope({message:'hello',answers:[]},path)).toThrow();
  expect(()=>assertPrivateConsoleEnvelope({answers:[{interactionId:'card',optionId:'approve',text:'injected'}]},path)).toThrow();
  expect(()=>assertPrivateConsoleEnvelope({callback:{url:'https://example.invalid'},turnId:'turn'},path+'/cancel')).toThrow();
  await expect(assertPrivateConsoleRequest(new Request('https://example.invalid'+path,{method:'POST',body:JSON.stringify({message:'hello',callback:{url:'https://example.invalid'}})}))).rejects.toThrow();
 });
});

it('requires the exact validated Request and scalar text after Eve consumes its body',async()=>{
 const request=new Request('https://example.invalid/eve/v1/session',{method:'POST',body:JSON.stringify({message:' exact text \n'})});
 await assertPrivateConsoleRequest(request);const other=request.clone();const parsed=await request.json();
 expect(request.bodyUsed).toBe(true);
 expect(()=>assertVerifiedPrivateConsoleMessage(request,parsed.message)).not.toThrow();
 for(const message of ['changed',[{type:'text',text:parsed.message}],undefined])expect(()=>assertVerifiedPrivateConsoleMessage(request,message)).toThrow();
 expect(()=>assertVerifiedPrivateConsoleMessage(other,parsed.message)).toThrow();
});
it('binds an opaque broker capsule to the exact validated raw request and parsed message',async()=>{
 const body=JSON.stringify({message:'vault question'}),capsule='signed_capsule_v1';
 const request=new Request('https://example.invalid/eve/v1/session/existing',{method:'POST',headers:{[PRIVATE_CONSOLE_VAULT_CAPSULE_HEADER]:capsule},body});
 await assertPrivateConsoleRequest(request);const parsed=await request.json();
 expect(verifiedPrivateConsoleMessageReceipt(request,parsed.message)).toEqual({
  method:'POST',path:'/eve/v1/session/existing',
  rawBodyHash:await import('node:crypto').then(({createHash})=>createHash('sha256').update(body).digest('hex')),
  vaultCapsule:capsule,
 });
 expect(()=>verifiedPrivateConsoleMessageReceipt(request,'changed')).toThrow();
 expect(()=>verifiedPrivateConsoleMessageReceipt(request.clone(),'vault question')).toThrow();
 const noCapsule=new Request('https://example.invalid/eve/v1/session/existing',{method:'POST',body});
 await assertPrivateConsoleRequest(noCapsule);const noCapsuleBody=await noCapsule.json();
 expect(()=>verifiedPrivateConsoleMessageReceipt(noCapsule,noCapsuleBody.message)).toThrow();
});
it('rejects malformed or oversized opaque capsules before recording a message receipt',async()=>{
 for(const capsule of ['not base64!', 'x'.repeat(8193)]){
  const request=new Request('https://example.invalid/eve/v1/session/existing',{method:'POST',headers:{[PRIVATE_CONSOLE_VAULT_CAPSULE_HEADER]:capsule},body:JSON.stringify({message:'hello'})});
  await expect(assertPrivateConsoleRequest(request)).rejects.toThrow();
  expect(()=>assertVerifiedPrivateConsoleMessage(request,'hello')).toThrow();
 }
});
it('does not issue receipts for empty creates, controls, non-POST requests or failed raw validation',async()=>{
 for(const [path,method,body,message]of [
  ['/eve/v1/session','POST',{},'fabricated'],
  ['/eve/v1/session/existing/cancel','POST',{},'fabricated'],
  ['/eve/v1/session','GET',undefined,'fabricated'],
  ['/eve/v1/session','POST',{message:'hello',callback:{}},'hello'],
 ]as const){
  const request=new Request('https://example.invalid'+path,{method,...(body?{body:JSON.stringify(body)}:{})});
  await assertPrivateConsoleRequest(request).catch(()=>undefined);
  expect(()=>assertVerifiedPrivateConsoleMessage(request,message)).toThrow();
 }
 const request=new Request('https://example.invalid/eve/v1/session',{method:'POST',body:JSON.stringify({message:'hello'})});
 assertPrivateConsoleEnvelope({message:'hello'},'/eve/v1/session');
 expect(()=>assertVerifiedPrivateConsoleMessage(request,'hello')).toThrow();
});

it('issues one bounded response receipt only for the same validated Request',async()=>{
 const body=JSON.stringify({answers:[{interactionId:'exact',optionId:'approve'}]});
 const request=new Request('https://example.invalid/eve/v1/session/existing',{method:'POST',body});
 await assertPrivateConsoleRequest(request);const copy=request.clone();await request.json();
 expect(verifiedPrivateConsoleResponse(request)).toEqual({interactionId:'exact',optionId:'approve',method:'POST',path:'/eve/v1/session/existing',
  rawBodyHash:await import('node:crypto').then(({createHash})=>createHash('sha256').update(body).digest('hex'))});
 expect(Object.isFrozen(verifiedPrivateConsoleResponse(request))).toBe(true);
 expect(()=>verifiedPrivateConsoleResponse(copy)).toThrow();
 for(const body of [{message:'human'},{answers:[{interactionId:'exact',optionId:'other'}]},{answers:[{interactionId:'exact',optionId:'cancel'}]},{answers:[{interactionId:'one',optionId:'approve'},{interactionId:'two',optionId:'approve'}]}]){
  const invalid=new Request('https://example.invalid/eve/v1/session/existing',{method:'POST',body:JSON.stringify(body)});
  await assertPrivateConsoleRequest(invalid).catch(()=>undefined);expect(()=>verifiedPrivateConsoleResponse(invalid)).toThrow();
 }
});

it('binds a resume receipt to the model request id and the distinct approval interaction id',async()=>{
 const payload={version:1,request:{requestId:'model-request-id-12345678901234567890',purpose:'resume',resume:{requestId:'eve-approval-card',optionId:'approve'}}};
 const capsule=`${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
 const body=JSON.stringify({answers:[{interactionId:'eve-approval-card',optionId:'approve'}]});
 const request=new Request('https://example.invalid/eve/v1/session/existing',{method:'POST',headers:{[PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER]:capsule},body});
 await assertPrivateConsoleRequest(request);
 expect(verifiedPrivateConsoleModelResponseReceipt(request)).toEqual({method:'POST',path:'/eve/v1/session/existing',
  rawBodyHash:await import('node:crypto').then(({createHash})=>createHash('sha256').update(body).digest('hex')),
  requestId:payload.request.requestId,purpose:'resume',resume:{requestId:'eve-approval-card',optionId:'approve'},modelCapsule:capsule});
 const forgedPayload={...payload,request:{...payload.request,resume:{requestId:'different-card',optionId:'approve'}}};
 const forged=`${Buffer.from(JSON.stringify(forgedPayload)).toString('base64url')}.signature`;
 const forgedRequest=new Request('https://example.invalid/eve/v1/session/existing',{method:'POST',headers:{[PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER]:forged},body});
 await assertPrivateConsoleRequest(forgedRequest);
 expect(()=>verifiedPrivateConsoleModelResponseReceipt(forgedRequest)).toThrow();
});

it('keeps the human message capsule receipt tied to the exact request and raw body',async()=>{
 const capsule=humanCapsule();const body=JSON.stringify({message:'question'});
 const request=new Request('https://example.invalid/eve/v1/session/existing',{method:'POST',headers:{[PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER]:capsule},body});
 await assertPrivateConsoleRequest(request);const parsed=await request.json();
 expect(verifiedPrivateConsoleModelMessageReceipt(request,parsed.message)).toEqual({method:'POST',path:'/eve/v1/session/existing',
  rawBodyHash:await import('node:crypto').then(({createHash})=>createHash('sha256').update(body).digest('hex')),
  requestId:'m'.repeat(43),purpose:'human',modelCapsule:capsule});
});

it('requires the captured human capsule to carry a valid model request id and no resume authority',async()=>{
 for(const requestPart of [
  {requestId:'m'.repeat(43),purpose:'resume',resume:{requestId:'card',optionId:'approve'}},
  {requestId:'short',purpose:'human'},
  {purpose:'human'},
  {requestId:'m'.repeat(43),purpose:'human',resume:{requestId:'card',optionId:'approve'}},
 ]){
  const capsule=`${Buffer.from(JSON.stringify({version:1,request:requestPart})).toString('base64url')}.signature`;
  const request=new Request('https://example.invalid/eve/v1/session/existing',{method:'POST',headers:{[PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER]:capsule},body:JSON.stringify({message:'question'})});
  await assertPrivateConsoleRequest(request);const parsed=await request.json();
  expect(()=>verifiedPrivateConsoleModelMessageReceipt(request,parsed.message)).toThrow();
 }
});

it('hashes the original request bytes even when text decoding would replace invalid UTF-8',async()=>{
 const raw=Buffer.concat([Buffer.from('{"message":"'),Buffer.from([0xff]),Buffer.from('"}')]);
 const request=new Request('https://example.invalid/eve/v1/session/existing',{method:'POST',body:raw,
  headers:{[PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER]:humanCapsule()}});
 await assertPrivateConsoleRequest(request);const parsed=await request.json();
 const receipt=verifiedPrivateConsoleModelMessageReceipt(request,parsed.message);
 expect(receipt.requestId).toBe('m'.repeat(43));expect(receipt.purpose).toBe('human');
 expect(receipt.rawBodyHash).toBe(await import('node:crypto').then(({createHash})=>createHash('sha256').update(raw).digest('hex')));
 expect(receipt.rawBodyHash).not.toBe(await import('node:crypto').then(({createHash})=>createHash('sha256').update(raw.toString('utf8')).digest('hex')));
});

describe('eve 1.0 wire shapes',()=>{
 const path='/eve/v1/session/private';
 it('accepts an approve or a deny answer: the exact body eve 1.0 clients send',async()=>{
  for(const optionId of ['approve','deny']){
   const body=JSON.stringify({answers:[{interactionId:'int_1',optionId}]});
   const request=new Request('https://example.invalid'+path,{method:'POST',body});
   await expect(assertPrivateConsoleRequest(request)).resolves.toBeUndefined();
   expect(verifiedPrivateConsoleResponse(request)).toMatchObject({interactionId:'int_1',optionId});
  }
 });
 it('refuses a deny written the old way, an old-shape body, free text and any extra field',async()=>{
  const bodies=[
   {inputResponses:[{requestId:'card',optionId:'approve'}]},
   {inputResponses:[{requestId:'card',optionId:'cancel'}]},
   {answers:[{requestId:'card',optionId:'approve'}]},
   {answers:[{interactionId:'card',optionId:'cancel'}]},
   {answers:[{interactionId:'card'}]},
   {answers:[{interactionId:'card',text:'yes please'}]},
   {answers:[{interactionId:'card',optionId:'deny',text:'x'}]},
   {answers:[]},
   {answers:'approve'},
   {answers:[{interactionId:'card',optionId:'approve'}],message:'hello'},
   {answers:[{interactionId:'card',optionId:'approve'}],idempotencyKey:'k'},
   {answers:[{interactionId:'card',optionId:'approve'}],inbox:'x'},
   {answers:[{interactionId:'card',optionId:'approve'}],turnPolicy:{}},
  ];
  for(const body of bodies){
   expect(()=>assertPrivateConsoleEnvelope(body,path),JSON.stringify(body)).toThrow();
   const request=new Request('https://example.invalid'+path,{method:'POST',body:JSON.stringify(body)});
   await assertPrivateConsoleRequest(request).catch(()=>undefined);
   expect(()=>verifiedPrivateConsoleResponse(request),JSON.stringify(body)).toThrow();
  }
 });
 it('answers are only taken on an existing session, never on create',()=>{
  expect(()=>assertPrivateConsoleEnvelope({answers:[{interactionId:'card',optionId:'approve'}]},'/eve/v1/session')).toThrow();
 });
 it('accepts the end control beside reset, with only a reason; clear and compact take nothing',()=>{
  for(const control of ['end','reset']){
   expect(()=>assertPrivateConsoleEnvelope({},path+'/'+control)).not.toThrow();
   expect(()=>assertPrivateConsoleEnvelope({reason:'owner asked'},path+'/'+control)).not.toThrow();
   expect(()=>assertPrivateConsoleEnvelope({reason:''},path+'/'+control)).toThrow();
   expect(()=>assertPrivateConsoleEnvelope({turnId:'t'},path+'/'+control)).toThrow();
   expect(()=>assertPrivateConsoleEnvelope({callback:{}},path+'/'+control)).toThrow();
  }
  expect(()=>assertPrivateConsoleEnvelope({turnId:'t'},path+'/cancel')).not.toThrow();
  for(const control of ['clear','compact'])expect(()=>assertPrivateConsoleEnvelope({reason:'x'},path+'/'+control)).toThrow();
 });
 it('validates the end control through the raw request check too, without issuing a message receipt',async()=>{
  const request=new Request('https://example.invalid'+path+'/end',{method:'POST',body:JSON.stringify({reason:'done'})});
  await expect(assertPrivateConsoleRequest(request)).resolves.toBeUndefined();
  expect(()=>assertVerifiedPrivateConsoleMessage(request,'done')).toThrow();
  const bad=new Request('https://example.invalid'+path+'/end',{method:'POST',body:JSON.stringify({reason:'done',extra:1})});
  await expect(assertPrivateConsoleRequest(bad)).rejects.toThrow();
 });
 it('a resume capsule that says cancel is no longer a valid resume',async()=>{
  const payload={version:1,request:{requestId:'model-request-id-12345678901234567890',purpose:'resume',resume:{requestId:'int_1',optionId:'cancel'}}};
  const capsule=`${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
  const request=new Request('https://example.invalid'+path,{method:'POST',headers:{[PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER]:capsule},body:JSON.stringify({answers:[{interactionId:'int_1',optionId:'deny'}]})});
  await assertPrivateConsoleRequest(request);
  expect(()=>verifiedPrivateConsoleModelResponseReceipt(request)).toThrow();
  const ok={...payload,request:{...payload.request,resume:{requestId:'int_1',optionId:'deny'}}};
  const okCapsule=`${Buffer.from(JSON.stringify(ok)).toString('base64url')}.signature`;
  const good=new Request('https://example.invalid'+path,{method:'POST',headers:{[PRIVATE_CONSOLE_MODEL_CAPSULE_HEADER]:okCapsule},body:JSON.stringify({answers:[{interactionId:'int_1',optionId:'deny'}]})});
  await assertPrivateConsoleRequest(good);
  expect(verifiedPrivateConsoleModelResponseReceipt(good).resume).toEqual({requestId:'int_1',optionId:'deny'});
 });
});

describe('session create accepts exactly these bodies',()=>{
 const create='/eve/v1/session';
 it('{}, {message}, {operationId} and {message, operationId} are accepted; nothing else',()=>{
  for(const body of [{},{message:'hello'},{operationId:'op-1'},{message:'hello',operationId:'op-1'}])expect(()=>assertPrivateConsoleEnvelope(body,create),JSON.stringify(body)).not.toThrow();
  for(const body of [{message:''},{operationId:''},{message:'hello',operationId:''},{message:'hello',answers:[{interactionId:'i',optionId:'approve'}]},{answers:[{interactionId:'i',optionId:'approve'}]},{message:'hello',extra:1},{clientContext:'x'},{callback:{}}])expect(()=>assertPrivateConsoleEnvelope(body,create),JSON.stringify(body)).toThrow();
 });
 it('a message-free create gets no message receipt, so it cannot carry a message later',async()=>{
  const request=new Request('https://example.invalid'+create,{method:'POST',body:JSON.stringify({})});
  await expect(assertPrivateConsoleRequest(request)).resolves.toBeUndefined();
  expect(()=>assertVerifiedPrivateConsoleMessage(request,'anything')).toThrow();
 });
});
