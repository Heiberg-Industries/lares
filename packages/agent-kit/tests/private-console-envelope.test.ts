import {describe,expect,it} from 'vitest';
import {assertPrivateConsoleEnvelope,assertPrivateConsoleRequest,assertVerifiedPrivateConsoleMessage} from '../src/private-console-envelope.js';
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
