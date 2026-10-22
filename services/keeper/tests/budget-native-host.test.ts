import {chmodSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it} from 'vitest';
import {BudgetNativeProvisioner,nativeProvisioningDeadline} from '../lib/budget-native-provisioning.js';
import {BudgetNativeCredentialClient} from '../lib/budget-native-client.js';
import {createNativeCredentialClient,parseBudgetNativePolicyDocument,readBudgetNativePolicyDocument,selectBudgetNativeReviewedPolicy,registerBudgetNativeHostActions} from '../lib/budget-native-host.js';
import {resetActions,runAction} from '../lib/actions.js';
import {requestNativeActivation,requestNativeProvision} from '../bin/budget-financial.js';
import {nativeTestPolicy,nativeTestTarget} from './helpers/native-cleanup.js';
import type {HostFinancialJournal} from '../lib/financial-journal.js';
import type {SourcePool} from '@lares/agent-kit/console-source-transaction';
import type {BudgetNativeCustodyStore} from '../lib/budget-native-custody.js';

const roots:string[]=[];
afterEach(()=>{resetActions();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const request={bindingId:'11111111-1111-4111-8111-111111111111',credentialGeneration:'0',memberId:'member-1',agent:'neutral-helper',
  incarnation:'22222222-2222-4222-8222-222222222222',purposeAlias:'lares-brain'};

it('enforces the native provisioning deadline at the 20-second boundary',()=>{
  const deadline=nativeProvisioningDeadline(1_000);
  expect(deadline.deadlineAtMs).toBe(21_000);
  expect(()=>deadline.check(20_999)).not.toThrow();
  expect(()=>deadline.check(21_000)).toThrow('Native budget provisioning refused');
});

it('rejects duplicate JSON keys, extra policy fields, duplicate aliases and unmatched aliases',()=>{
  const document={endpointHash:nativeTestTarget.hash,policies:[nativeTestPolicy()]};
  expect(parseBudgetNativePolicyDocument(JSON.stringify(document)).endpointHash).toBe(nativeTestTarget.hash);
  expect(()=>parseBudgetNativePolicyDocument(`{"endpointHash":"${nativeTestTarget.hash}","endpointHash":"${nativeTestTarget.hash}","policies":[]}`)).toThrow('unavailable or invalid');
  expect(()=>parseBudgetNativePolicyDocument(JSON.stringify({...document,unexpected:'value'}))).toThrow('unavailable or invalid');
  expect(()=>parseBudgetNativePolicyDocument(JSON.stringify({...document,policies:[...document.policies,...document.policies]}))).toThrow('unavailable or invalid');
  expect(()=>selectBudgetNativeReviewedPolicy(document,'unknown-alias')).toThrow('unavailable or invalid');
});

it('opens reviewed policy only from a stable root-only regular file',()=>{
  const root=mkdtempSync(join(tmpdir(),'native-policy-'));roots.push(root);
  const path=join(root,'policy.json'),link=join(root,'policy-link.json');
  writeFileSync(path,JSON.stringify({endpointHash:nativeTestTarget.hash,policies:[nativeTestPolicy()]}),{mode:0o600});chmodSync(path,0o600);
  if(process.getuid?.()===0)expect(readBudgetNativePolicyDocument(path).endpointHash).toBe(nativeTestTarget.hash);
  else expect(()=>readBudgetNativePolicyDocument(path)).toThrow('unavailable or invalid');
  symlinkSync(path,link);
  expect(()=>readBudgetNativePolicyDocument(link)).toThrow('unavailable or invalid');
});

it('reuses the protected master-key reader and refuses untrusted configured origins',()=>{
  const root=mkdtempSync(join(tmpdir(),'native-master-'));roots.push(root);
  const path=join(root,'master-key'),link=join(root,'master-key-link');
  writeFileSync(path,`sk-${'b'.repeat(43)}\n`,{mode:0o600});chmodSync(path,0o600);symlinkSync(path,link);
  if(process.getuid?.()===0)expect(createNativeCredentialClient('https://gateway.invalid',path).gatewayOrigin).toBe('https://gateway.invalid');
  else expect(()=>createNativeCredentialClient('https://gateway.invalid',path)).toThrow('unavailable');
  expect(()=>createNativeCredentialClient('https://gateway.invalid',link)).toThrow('unavailable');
  expect(()=>createNativeCredentialClient('https://user:secret@gateway.invalid','/missing')).toThrow('unavailable');
});

it('constructs the real provisioner with the exact reviewed alias, endpoint and native client',()=>{
  const policy=nativeTestPolicy(),native=new BudgetNativeCredentialClient(nativeTestTarget.origin,`sk-${'a'.repeat(43)}`);
  const service=new BudgetNativeProvisioner({} as SourcePool,{prepared:true} as HostFinancialJournal,{} as BudgetNativeCustodyStore,native,nativeTestTarget,policy);
  expect(service).toBeInstanceOf(BudgetNativeProvisioner);
  expect(()=>new BudgetNativeProvisioner({} as SourcePool,{prepared:true} as HostFinancialJournal,{} as BudgetNativeCustodyStore,
    new BudgetNativeCredentialClient('https://other.invalid',`sk-${'a'.repeat(43)}`),nativeTestTarget,policy)).toThrow('Native budget provisioning refused');
});

it('keeps native provisioning and activation on the root host socket and redacts member identity',async()=>{
  const calls:string[]=[],audits:unknown[]=[];
  registerBudgetNativeHostActions({provision:async input=>{calls.push(`provision:${input.bindingId}`);return {state:'bound-closed',bindingId:input.bindingId,credentialGeneration:input.credentialGeneration};},
    activate:async input=>{calls.push(`activate:${input.bindingId}`);return {state:'active',bindingId:input.bindingId,credentialGeneration:input.credentialGeneration};}});
  const context={actor:'host',audit:async(record:unknown)=>{audits.push(record);}};
  await expect(runAction('budget.provision-native',request,context,{host:false})).rejects.toThrow('reachable only from the host command');
  await expect(runAction('budget.activate-native',{bindingId:request.bindingId,credentialGeneration:'0',extra:true},context,{host:true})).rejects.toThrow('invalid input');
  expect(calls).toEqual([]);
  await expect(runAction('budget.provision-native',request,context,{host:true})).resolves.toEqual({state:'bound-closed',bindingId:request.bindingId,credentialGeneration:'0'});
  await expect(runAction('budget.activate-native',{bindingId:request.bindingId,credentialGeneration:'0'},context,{host:true})).resolves.toEqual({state:'active',bindingId:request.bindingId,credentialGeneration:'0'});
  expect(calls).toEqual([`provision:${request.bindingId}`,`activate:${request.bindingId}`]);
  expect(JSON.stringify(audits)).not.toContain(request.memberId);
});

async function withSocket(handler:(socket:import('node:net').Socket,request:Record<string,unknown>)=>void):Promise<{path:string;close:()=>Promise<void>}> {
  const root=mkdtempSync(join(tmpdir(),'native-host-socket-'));roots.push(root);const path=join(root,'keeper.sock');
  const server=createServer(socket=>{let text='';socket.on('data',chunk=>{text+=chunk.toString();if(text.includes('\n')){try{handler(socket,JSON.parse(text.slice(0,text.indexOf('\n'))));}catch{socket.destroy();}}});});
  await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(path,resolve));
  return {path,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}

it('sends one exact host action and accepts only the matching closed binding acknowledgement',async()=>{
  const seen:Record<string,unknown>[]=[];
  const server=await withSocket((socket,message)=>{seen.push(message);socket.end(JSON.stringify({ok:true,result:{state:'bound-closed',bindingId:request.bindingId,credentialGeneration:request.credentialGeneration}})+'\n');});
  try{
    await expect(requestNativeProvision(server.path,request)).resolves.toEqual({state:'bound-closed',bindingId:request.bindingId,credentialGeneration:'0'});
    expect(seen).toEqual([{action:'budget.provision-native',input:request}]);
  }finally{await server.close();}
});

it('accepts only an exact active acknowledgement for the requested native binding',async()=>{
  const seen:Record<string,unknown>[]=[];
  const input={bindingId:request.bindingId,credentialGeneration:'0'};
  const server=await withSocket((socket,message)=>{seen.push(message);socket.end(JSON.stringify({ok:true,result:{state:'active',...input}})+'\n');});
  try{
    await expect(requestNativeActivation(server.path,input)).resolves.toEqual({state:'active',...input});
    expect(seen).toEqual([{action:'budget.activate-native',input}]);
  }finally{await server.close();}
});

it('does not retry after malformed or missing host acknowledgement',async()=>{
  for(const reply of ['wrong-state','eof','timeout'] as const){
    let calls=0;
    const server=await withSocket((socket)=>{calls++;if(reply==='wrong-state')socket.end(JSON.stringify({ok:true,result:{state:'active',bindingId:request.bindingId,credentialGeneration:'0'}})+'\n');
      else if(reply==='eof')socket.end();});
    try{
      const pending=requestNativeProvision(server.path,request,reply==='timeout'?20:2_000);
      await expect(pending).rejects.toThrow('Native budget');
      expect(calls).toBe(1);
    }finally{await server.close();}
  }
});

it('refuses activation acknowledgements with another state or binding and does not retry',async()=>{
  const input={bindingId:request.bindingId,credentialGeneration:'0'};
  for(const result of [{state:'bound-closed',...input},{state:'active',bindingId:'33333333-3333-4333-8333-333333333333',credentialGeneration:'0'}]){
    let calls=0;
    const server=await withSocket(socket=>{calls++;socket.end(JSON.stringify({ok:true,result})+'\n');});
    try{await expect(requestNativeActivation(server.path,input)).rejects.toThrow('Native budget');expect(calls).toBe(1);}
    finally{await server.close();}
  }
});
