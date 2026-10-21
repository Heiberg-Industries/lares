import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { PgPersonalActionStore, PersonalActionError, PERSONAL_MAIL_SEND_TOOL, personalActionApprovalDescriptor,
  type TrustedPersonalActionEnvelope, type PersonalActionState, type PersonalActionReceipt } from '../../../packages/agent-kit/src/personal-action-store.js';
import { payloadFingerprint } from '../../../packages/agent-kit/src/approval-ledger.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';

const key='2'.repeat(64);
const crypto={encrypt:(s:string)=>encryptSecret(s,key),decrypt:(s:string)=>decryptSecret(s,key)};
const actionId='22222222-2222-4222-8222-222222222222';
const input=():TrustedPersonalActionEnvelope=>({actorMemberId:'member-a',agentId:'assistant',
  incarnation:'11111111-1111-4111-8111-111111111111',sessionId:'private-session',originalTurnId:'turn-1',
  originalCallId:'original-call',accountId:'account-a',accountGeneration:3,resourceBindingId:'mailbox-a',
  connectorId:'example',kind:'mail.send',payload:{to:['recipient@example.invalid'],subject:'Subject',body:'Body'}});
const notDispatched={state:'not_dispatched',code:'authority_changed'} as const;

/** Mock only the transaction boundary. Permits are minted through the public claim API and real
 * encryption helper; tests never reach into the store's private permit map or forge a permit. */
async function claimedFixture() {
  const {payload,...selection}=input(),payloadHash=payloadFingerprint('mail.send',payload);
  const created=new Date(),expires=new Date(created.getTime()+86_400_000);
  const ciphertext=crypto.encrypt(JSON.stringify({purpose:'lares.personal-action.v1',version:1,actionId,selection,payload}));
  const initial={id:actionId,payload_version:1,actor_member_id:selection.actorMemberId,agent:selection.agentId,
    incarnation:selection.incarnation,session_id:selection.sessionId,original_turn_id:selection.originalTurnId,
    original_call_id:selection.originalCallId,account_id:selection.accountId,account_generation:selection.accountGeneration,
    resource_binding_id:selection.resourceBindingId,connector_id:selection.connectorId,kind:selection.kind,
    payload_hash:payloadHash,payload_ciphertext:ciphertext,approval_call_id:'approval-call',approval_request_id:'request',
    created_at:created,expires_at:expires,state:'awaiting_dispatch' as PersonalActionState,
    attempt_id:null as string|null,claimed_at:null as Date|null,receipt:null as PersonalActionReceipt|null};
  let stored={...initial},snapshot:typeof stored|undefined;
  const approval={call_id:'approval-call',request_id:'request',agent:selection.agentId,tool:PERSONAL_MAIL_SEND_TOOL,
    payload_hash:payloadHash,acting_member_id:selection.actorMemberId,resolved_by_member_id:selection.actorMemberId,
    session_id:selection.sessionId,outcome:'approved',asked_at:created,answered_at:created,
    original_authority:personalActionApprovalDescriptor({actionId,payloadHash,expiresAt:expires.toISOString(),state:'awaiting_dispatch',attemptId:null,receipt:null},selection)};
  let failure:'none'|'connect'|'receipt'|'commit'='none';
  let holdConnection:Promise<void>|undefined;
  const query=vi.fn(async(text:string,params?:unknown[])=>{
    if(text==='BEGIN') {snapshot={...stored};return {rows:[]};}
    if(text==='COMMIT') {
      snapshot=undefined;
      if(failure==='commit') throw new Error('Commit acknowledgement lost');
      return {rows:[]};
    }
    if(text==='ROLLBACK') {if(snapshot) stored=snapshot;snapshot=undefined;return {rows:[]};}
    if(text.startsWith('SELECT * FROM personal_actions')) return {rows:[{...stored}]};
    if(text.startsWith('SELECT * FROM approval_asks')) return {rows:[{...approval}]};
    if(text.includes(' AS expired')) return {rows:[{expired:false}]};
    if(text.includes(' AS alive')) return {rows:[{alive:true}]};
    if(text.includes("SET state='claimed'")) {
      stored={...stored,state:'claimed',attempt_id:params![1] as string,claimed_at:new Date()};
      return {rows:[{...stored}]};
    }
    if(text.includes('SET state=$2,receipt=')) {
      if(failure==='receipt') throw new Error('Receipt transaction failed');
      stored={...stored,state:params![1] as PersonalActionState,receipt:JSON.parse(params![2] as string)};
      return {rows:[{...stored}]};
    }
    throw new Error('Unexpected fixture query');
  });
  const client={query,release:vi.fn()};
  const connect=vi.fn(async()=>{
    if(failure==='connect') throw new Error('Connection unavailable');
    if(holdConnection) await holdConnection;
    return client;
  });
  const store=new PgPersonalActionStore({connect} as unknown as Pool,crypto);
  const claim=await store.claimAction({actionId,payloadHash,approvalCallId:'approval-call',requestId:'request',
    resolvedByMemberId:selection.actorMemberId,selection});
  expect(claim.permit).toBeDefined();
  return {store,permit:claim.permit!,client,query,connect,setFailure:(next:typeof failure)=>{failure=next;},
    pauseConnection:()=>{
      let resume!:()=>void;
      holdConnection=new Promise<void>(resolve=>{resume=resolve;});
      return ()=>{holdConnection=undefined;resume();};
    },readStored:()=>stored};
}

describe('personal action settlement boundary without PostgreSQL',()=>{
  it('burns dispatch synchronously before settlement can await a connection',async()=>{
    const f=await claimedFixture(),resume=f.pauseConnection();
    const recording=f.store.recordOutcome(f.permit,notDispatched);
    expect(()=>f.store.consumeClaimPermit(f.permit)).toThrow(PersonalActionError);
    expect(f.readStored().state).toBe('claimed');
    resume();
    expect((await recording).state).toBe('not_dispatched');
    expect((await f.store.recordOutcome(f.permit,notDispatched)).state).toBe('not_dispatched');
  });
  it.each(['connect','receipt','commit'] as const)('never revives dispatch after a %s failure, but permits receipt retries',async failure=>{
    const f=await claimedFixture();f.setFailure(failure);
    const recording=f.store.recordOutcome(f.permit,notDispatched);
    expect(()=>f.store.consumeClaimPermit(f.permit)).toThrow(PersonalActionError);
    await expect(recording).rejects.toThrow();
    expect(()=>f.store.consumeClaimPermit(f.permit)).toThrow(PersonalActionError);
    expect(f.readStored().state).toBe(failure==='commit'?'not_dispatched':'claimed');
    f.setFailure('none');
    expect((await f.store.recordOutcome(f.permit,notDispatched)).state).toBe('not_dispatched');
    expect(()=>f.store.consumeClaimPermit(f.permit)).toThrow(PersonalActionError);
  });
  it('validates a receipt before burning dispatch eligibility',async()=>{
    const f=await claimedFixture();
    await expect(f.store.recordOutcome(f.permit,{...notDispatched,rawError:'private'} as never)).rejects.toThrow();
    expect(f.store.consumeClaimPermit(f.permit).payload.body).toBe('Body');
  });
});

/** A minimal insert fixture lets accepted boundary cases exercise real serialization/encryption
 * through prepareAction. Oversized cases assert no connection or encryption was even attempted. */
function preparationFixture() {
  const encrypt=vi.fn(crypto.encrypt);
  const ciphertexts:string[]=[];
  const query=vi.fn(async(text:string,params?:unknown[])=>{
    if(text==='BEGIN'||text==='COMMIT'||text==='ROLLBACK'||text.includes('pg_advisory_xact_lock')) return {rows:[]};
    if(text.includes(' FROM users ')) return {rows:[{id:'member-a',org_id:'org-test',org_role:'member',status:'active',automation_mode:'draft-and-ask'}]};
    if(text.startsWith('SELECT * FROM personal_actions')||text.startsWith('SELECT 1 FROM personal_action_calls')) return {rows:[],rowCount:0};
    if(text.includes('INSERT INTO personal_actions')) {
      const p=params!;ciphertexts.push(p[14] as string);
      return {rows:[{id:p[0],payload_hash:p[13],payload_ciphertext:p[14],state:'awaiting_approval',
        attempt_id:null,receipt:null,expires_at:new Date(Date.now()+86_400_000)}]};
    }
    throw new Error('Unexpected fixture query');
  });
  const connect=vi.fn(async()=>({query,release:vi.fn()}));
  return {store:new PgPersonalActionStore({connect} as unknown as Pool,{encrypt,decrypt:crypto.decrypt}),encrypt,connect,query,ciphertexts};
}
function envelopeBytes(s:TrustedPersonalActionEnvelope):number {
  const {payload,...selection}=s;
  return Buffer.byteLength(JSON.stringify({purpose:'lares.personal-action.v1',version:1,actionId,selection,payload}),'utf8');
}
const MAX_ENVELOPE_BYTES=262_144/4*3-12-16;

describe('personal action serialized storage budget without PostgreSQL',()=>{
  it.each(['"','\\','\n'])('accepts the exact escaped %j boundary and refuses one more escaped character before encryption or DB work',async character=>{
    const s=input(),overhead=envelopeBytes({...s,payload:{...s.payload,body:''}});
    const count=Math.floor((MAX_ENVELOPE_BYTES-overhead)/2);
    s.payload.body=character.repeat(count)+'x'.repeat((MAX_ENVELOPE_BYTES-overhead)%2);
    expect(envelopeBytes(s)).toBe(MAX_ENVELOPE_BYTES);
    const accepted=preparationFixture();
    await accepted.store.prepareAction(s);
    expect(accepted.ciphertexts[0].length).toBe(262_144);
    expect(JSON.parse(crypto.decrypt(accepted.ciphertexts[0])).payload.body).toBe(s.payload.body);
    const refused=preparationFixture();
    const tooBig={...s,payload:{...s.payload,body:s.payload.body+character}};
    await expect(refused.store.prepareAction(tooBig)).rejects.toEqual(new PersonalActionError());
    expect(refused.encrypt).not.toHaveBeenCalled();expect(refused.connect).not.toHaveBeenCalled();
  });
  it('refuses the full 100000-byte quote body with a generic error before any database call',async()=>{
    const s=input();s.payload.body='"'.repeat(100_000);
    const f=preparationFixture();
    await expect(f.store.prepareAction(s)).rejects.toEqual(new PersonalActionError());
    expect(f.connect).not.toHaveBeenCalled();expect(f.encrypt).not.toHaveBeenCalled();
  });
  it('accepts a normal 100000-byte body without reserving a smaller blanket body limit',async()=>{
    const s=input();s.payload.body='x'.repeat(100_000);
    const f=preparationFixture();await f.store.prepareAction(s);
    expect(f.ciphertexts[0].length).toBeLessThan(262_144);
    expect(JSON.parse(crypto.decrypt(f.ciphertexts[0])).payload.body).toBe(s.payload.body);
  });
});


describe('caller-owned personal action transaction',()=>{
  it('revalidates action then approval and does not acquire another connection',async()=>{
    const f=await claimedFixture(),before=f.connect.mock.calls.length;f.query.mockClear();
    await f.store.validateClaimInTransaction(f.permit,f.client as never);
    expect(f.connect).toHaveBeenCalledTimes(before);
    expect(f.query.mock.calls[0][0]).toContain('FROM personal_actions');
    expect(f.query.mock.calls[1][0]).toContain('FROM approval_asks');
    await f.store.recordOutcomeInTransaction(f.permit,{state:'accepted',providerStatus:202},f.client as never);
    expect(f.connect).toHaveBeenCalledTimes(before);
    expect(()=>f.store.consumeClaimPermit(f.permit)).toThrow();
    await expect(f.store.validateClaimInTransaction(f.permit,f.client as never)).rejects.toThrow();
  });
  it('burns the caller-owned permit synchronously even if settlement fails',async()=>{
    const f=await claimedFixture();f.setFailure('receipt');
    const recording=f.store.recordOutcomeInTransaction(f.permit,notDispatched,f.client as never);
    expect(()=>f.store.consumeClaimPermit(f.permit)).toThrow();await expect(recording).rejects.toThrow();
  });
  it.each([{state:'accepted',providerStatus:200},{state:'accepted'},{state:'accepted',providerStatus:202,providerReceiptId:''},
    {state:'accepted',providerStatus:202,body:'private'}])('refuses an invalid or non-closed receipt %s',async receipt=>{
    const f=await claimedFixture();await expect(f.store.recordOutcome(f.permit,receipt as never)).rejects.toThrow();
    expect(f.store.consumeClaimPermit(f.permit).payload.body).toBe('Body');
  });
});
