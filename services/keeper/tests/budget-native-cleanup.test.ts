import {afterEach,expect,it,vi} from 'vitest';
import {cleanupOneNativeCredential,recordCommittedNativeRetirement} from '../lib/budget-native-cleanup.js';
import type {CommittedFinancialReceipt} from '../lib/financial-journal.js';
import type {NativeCustodyGate,NativeOperation} from '../lib/budget-native-custody.js';

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
