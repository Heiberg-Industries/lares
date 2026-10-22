import {describe,expect,it} from 'vitest';
import {assertPrivateConsoleEnvelope,assertPrivateConsoleRequest,assertVerifiedPrivateConsoleMessage,verifiedPrivateConsoleResponse,verifiedPrivateConsoleMessageReceipt,PRIVATE_CONSOLE_VAULT_CAPSULE_HEADER} from '../src/private-console-envelope.js';
describe('private console envelope',()=>{
 const path='/eve/v1/session/private';
 it('accepts current browser text, create operation IDs and exact card answers',()=>{
  expect(()=>assertPrivateConsoleEnvelope({message:'hello',operationId:'browser-operation'},'/eve/v1/session')).not.toThrow();
  expect(()=>assertPrivateConsoleEnvelope({message:'hello'},path)).not.toThrow();
  expect(()=>assertPrivateConsoleEnvelope({inputResponses:[{requestId:'card',optionId:'approve'}]},path)).not.toThrow();
  expect(()=>assertPrivateConsoleEnvelope({},'/eve/v1/session/private/cancel')).not.toThrow();
 });
 for(const extra of ['callback','activityObserver','clientContext','mode','outputSchema','capabilities','forwardedPrincipal','unknown'])it(`rejects ${extra} before dispatch`,()=>{
  expect(()=>assertPrivateConsoleEnvelope({message:'hello',[extra]:{}},path)).toThrow();
 });
 for(const message of [[{type:'text',text:'hello'}],[{type:'file',mediaType:'text/plain',data:'https://example.invalid/file'}],[{type:'file',mediaType:'text/plain',data:'internalref:secret'}],{text:'hello'}])it('refuses files, internal references and unsupported structured input',()=>{
  expect(()=>assertPrivateConsoleEnvelope({message},path)).toThrow();
 });
 it('rejects content on resolver/control routes and never accepts freeform approval payloads',async()=>{
  expect(()=>assertPrivateConsoleEnvelope({message:'hello',inputResponses:[]},path)).toThrow();
  expect(()=>assertPrivateConsoleEnvelope({inputResponses:[{requestId:'card',optionId:'approve',text:'injected'}]},path)).toThrow();
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
 const request=new Request('https://example.invalid/eve/v1/session/existing',{method:'POST',body:JSON.stringify({inputResponses:[{requestId:'exact',optionId:'approve'}]})});
 await assertPrivateConsoleRequest(request);const copy=request.clone();await request.json();
 expect(verifiedPrivateConsoleResponse(request)).toEqual({requestId:'exact',optionId:'approve'});
 expect(Object.isFrozen(verifiedPrivateConsoleResponse(request))).toBe(true);
 expect(()=>verifiedPrivateConsoleResponse(copy)).toThrow();
 for(const body of [{message:'human'},{inputResponses:[{requestId:'exact',optionId:'other'}]},{inputResponses:[{requestId:'one',optionId:'approve'},{requestId:'two',optionId:'approve'}]}]){
  const invalid=new Request('https://example.invalid/eve/v1/session/existing',{method:'POST',body:JSON.stringify(body)});
  await assertPrivateConsoleRequest(invalid).catch(()=>undefined);expect(()=>verifiedPrivateConsoleResponse(invalid)).toThrow();
 }
});
