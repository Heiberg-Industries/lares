import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {cleanupOneNativeCredential,recordCommittedNativeRetirement} from '../lib/budget-native-cleanup.js';
import type {CommittedFinancialReceipt} from '../lib/financial-journal.js';
import type {NativeCustodyGate,NativeOperation} from '../lib/budget-native-custody.js';

// The master-key file must be owned by root, which a test cannot be; this stands in for one protected file only.
vi.mock('node:fs',async importOriginal=>{
  const real=await importOriginal<typeof import('node:fs')>();
  const path='/protected-master-key-fixture',fd=987654,text=Buffer.from('sk-master-key-fixture-0123456789');
  const stat={isFile:()=>true,nlink:1,uid:0,gid:0,size:text.length,mode:0o100600,dev:1,ino:2,mtimeMs:3};
  let consumed=false;
  return {...real,
    openSync:((target:any,...rest:any[])=>{if(target===path){consumed=false;return fd;}return (real.openSync as any)(target,...rest);}) as typeof real.openSync,
    fstatSync:((descriptor:any,...rest:any[])=>descriptor===fd?stat:(real.fstatSync as any)(descriptor,...rest)) as typeof real.fstatSync,
    lstatSync:((target:any,...rest:any[])=>target===path?stat:(real.lstatSync as any)(target,...rest)) as typeof real.lstatSync,
    readSync:((descriptor:any,buffer:Buffer,offset:number,...rest:any[])=>{
      if(descriptor!==fd)return (real.readSync as any)(descriptor,buffer,offset,...rest);
      if(consumed)return 0;consumed=true;text.copy(buffer,offset);return text.length;}) as typeof real.readSync,
    closeSync:((descriptor:any)=>descriptor===fd?undefined:(real.closeSync as any)(descriptor)) as typeof real.closeSync,
  };
});
const operation={kind:'operation',operationId:'operation-fixture',keyFingerprint:'a'.repeat(64),phase:'revoke-pending',revocationReceipt:{journalId:'journal-fixture'},nativeDeletion:'unverified'} as NativeOperation;
const receipt={journalId:'journal-fixture'} as CommittedFinancialReceipt;
afterEach(()=>vi.unstubAllGlobals());

it('locally retires every account operation, including one without an SQL binding, before reporting pending',()=>{
  const events:string[]=[],gate={
    accountOperations:vi.fn(accountId=>accountId==='account-fixture'?[operation]:[]),
    recordRevocation:vi.fn(()=>events.push('revoke')),
    removePlaintext:vi.fn(()=>events.push('remove')),
    eraseAccountAssociation:vi.fn(()=>events.push('erase')),
    inventory:vi.fn(()=>({operations:[operation]})),
  } as unknown as NativeCustodyGate;
  const status=recordCommittedNativeRetirement(gate,['account-fixture'],receipt,false);
  expect(events).toEqual(['revoke','remove']);
  expect(gate.accountOperations).toHaveBeenCalledWith('account-fixture');
  expect(status).toEqual({status:'pending',remaining:1});
});

it('records erased cleanup only after local key removal and redacts account association',()=>{
  const events:string[]=[],gate={
    accountOperations:()=>[operation],
    recordRevocation:()=>events.push('revoke'),
    removePlaintext:()=>events.push('remove'),
    eraseAccountAssociation:()=>events.push('erase-account'),
    inventory:()=>({operations:[{...operation,kind:'cleanup'}]}),
  } as unknown as NativeCustodyGate;
  const status=recordCommittedNativeRetirement(gate,['account-fixture'],receipt,true);
  expect(events).toEqual(['remove','erase-account']);
  expect(status).toEqual({status:'pending',remaining:1});
});

it('leaves old-origin cleanup blocked before reading the configured key or contacting a gateway',async()=>{
  const fetcher=vi.fn(),record=vi.fn();vi.stubGlobal('fetch',fetcher);
  const gate={
    inventory:()=>({operations:[operation]}),
    prepareNativeAbsence:()=>({origin:'https://old-gateway.invalid',fingerprint:operation.keyFingerprint,challenge:'b'.repeat(64)}),
    recordNativeAbsence:record,
  } as unknown as NativeCustodyGate;
  const result=await cleanupOneNativeCredential(gate,{gatewayUrl:'https://current-gateway.invalid',masterKeyFile:'/does-not-exist'});
  expect(result).toEqual({status:'blocked',remaining:1});
  expect(fetcher).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});

it('does not turn a retained plaintext-removal failure into complete cleanup',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  const gate={
    inventory:()=>({operations:[operation]}),
    prepareNativeAbsence:()=>{throw new Error('Native custody operation refused');},
  } as unknown as NativeCustodyGate;
  const result=await cleanupOneNativeCredential(gate,{gatewayUrl:'https://current-gateway.invalid',masterKeyFile:'/does-not-exist'});
  expect(result).toEqual({status:'blocked',remaining:1});
  expect(fetcher).not.toHaveBeenCalled();
});

const several=(erased:boolean)=>['1','2','3'].map(digit=>({kind:erased?'cleanup':'operation',operationId:`operation-${digit}`,keyFingerprint:createHash('sha256').update(`key-${digit}`).digest('hex'),
  phase:'revoke-pending',revocationReceipt:{journalId:'journal-fixture'},nativeDeletion:'unverified'}) as unknown as NativeOperation);

it('revokes and removes every key of one person, and erases their account link once, before reporting how many remain',()=>{
  for(const erased of [false,true]){
    const rows=several(erased),events:string[]=[];
    const gate={
      accountOperations:vi.fn(()=>rows.map(row=>({...row,kind:'operation'}))),
      recordRevocation:vi.fn((id:string)=>events.push(`revoke:${id}`)),
      removePlaintext:vi.fn((id:string)=>events.push(`remove:${id}`)),
      eraseAccountAssociation:vi.fn(()=>events.push('erase')),
      inventory:()=>({operations:rows}),
    } as unknown as NativeCustodyGate;
    const status=recordCommittedNativeRetirement(gate,['account-fixture'],receipt,erased);
    expect(events).toEqual(erased
      ?['remove:operation-1','remove:operation-2','remove:operation-3','erase']
      :['revoke:operation-1','remove:operation-1','revoke:operation-2','remove:operation-2','revoke:operation-3','remove:operation-3']);
    expect(status).toEqual({status:'pending',remaining:3});
  }
});

/** A stateful stand-in for the local key store plus a gateway that holds the same keys. */
function drainFixture(erased:boolean){
  const rows=several(erased),present=new Set(rows.map(row=>(row as {keyFingerprint:string}).keyFingerprint)),deleted:string[]=[],challenges=new Map<string,string>();
  const pending=()=>rows.filter(row=>(row as {nativeDeletion:string}).nativeDeletion==='unverified');
  const prepare=(key:string)=>{const challenge=createHash('sha256').update(`challenge-${key}-${challenges.size}`).digest('hex');challenges.set(key,challenge);
    return {origin:'https://current-gateway.invalid',fingerprint:key,challenge};};
  const settle=(key:string)=>{const row=rows.find(item=>(item as {keyFingerprint:string}).keyFingerprint===key)!;(row as {nativeDeletion:string}).nativeDeletion='verified';};
  const gate={
    inventory:()=>({operations:pending()}),
    prepareNativeAbsence:(id:string)=>prepare((rows.find(row=>row.operationId===id) as {keyFingerprint:string}).keyFingerprint),
    prepareErasedNativeAbsence:(key:string)=>prepare(key),
    recordNativeAbsence:(id:string)=>settle((rows.find(row=>row.operationId===id) as {keyFingerprint:string}).keyFingerprint),
    recordErasedNativeAbsence:(key:string)=>settle(key),
  } as unknown as NativeCustodyGate;
  vi.stubGlobal('fetch',vi.fn(async(url:string,init:{body:string})=>{
    const keys=JSON.parse(init.body).keys as string[];
    if(url.endsWith('/v2/key/info'))return new Response(JSON.stringify({key:keys,info:present.has(keys[0]!)?[{}]:[]}),{status:200,headers:{'content-type':'application/json'}});
    if(url.endsWith('/key/delete')){for(const key of keys){present.delete(key);deleted.push(key);}return new Response('{}',{status:200,headers:{'content-type':'application/json'}});}
    return new Response('{}',{status:404});
  }));
  return {gate,deleted,present,rows};
}

it.each([false,true])('drains several keys of one person one call at a time, counting down to complete (erased: %s)',async erased=>{
  const {gate,deleted,present,rows}=drainFixture(erased),options={gatewayUrl:'https://current-gateway.invalid',masterKeyFile:'/protected-master-key-fixture'};
  await expect(cleanupOneNativeCredential(gate,options)).resolves.toEqual({status:'pending',remaining:2});
  expect(deleted).toHaveLength(1);
  await expect(cleanupOneNativeCredential(gate,options)).resolves.toEqual({status:'pending',remaining:1});
  expect(deleted).toHaveLength(2);
  await expect(cleanupOneNativeCredential(gate,options)).resolves.toEqual({status:'complete',remaining:0});
  // Each key is deleted from the gateway exactly once, and every one of them is gone.
  expect([...deleted].sort()).toEqual(rows.map(row=>(row as {keyFingerprint:string}).keyFingerprint).sort());
  expect(present.size).toBe(0);
  // Nothing is left to do, and a further call touches nothing.
  const calls=(fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
  await expect(cleanupOneNativeCredential(gate,options)).resolves.toEqual({status:'complete',remaining:0});
  expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
});

it('keeps counting the other keys of a person when one key cannot be reached',async()=>{
  const {gate,rows}=drainFixture(false),options={gatewayUrl:'https://current-gateway.invalid',masterKeyFile:'/protected-master-key-fixture'};
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('gateway unreachable');}));
  await expect(cleanupOneNativeCredential(gate,options)).resolves.toEqual({status:'pending',remaining:3});
  expect(rows.every(row=>(row as {nativeDeletion:string}).nativeDeletion==='unverified')).toBe(true);
});
