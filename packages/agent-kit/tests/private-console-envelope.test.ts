import {describe,expect,it} from 'vitest';
import {assertPrivateConsoleEnvelope,assertPrivateConsoleRequest} from '../src/private-console-envelope.js';
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
