import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PgPersonalActionStore, PersonalActionError, PERSONAL_MAIL_SEND_TOOL, personalActionApprovalDescriptor,
  type TrustedPersonalActionEnvelope, type PersonalActionOutcome, type PersonalActionApprovedReference } from '../../../packages/agent-kit/src/personal-action-store.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { exportPerson } from '../lib/export-person.js';
import { erasePerson } from '../lib/erase-person.js';
import { APPROVAL_TTL_MS } from '../../../packages/agent-kit/src/approval-ledger.js';

const sqlDir=fileURLToPath(new URL('../sql/',import.meta.url));
const key='1'.repeat(64);
const crypto={encrypt:(s:string)=>encryptSecret(s,key),decrypt:(s:string)=>decryptSecret(s,key)};
let container:StartedPostgreSqlContainer,db:Pool,store:PgPersonalActionStore;
let sequence=0;
const input=():TrustedPersonalActionEnvelope=>({actorMemberId:'member-a',agentId:'assistant',
  incarnation:'11111111-1111-4111-8111-111111111111',sessionId:'private-session',originalTurnId:'turn-1',
  originalCallId:`call-${++sequence}`,accountId:'account-a',accountGeneration:3,resourceBindingId:'mailbox-a',
  connectorId:'example',kind:'mail.send',payload:{to:['recipient@example.invalid'],subject:'Private subject',body:'Private message\nSecond line'}});
function selection({payload:_payload,...s}:TrustedPersonalActionEnvelope) {return s;}
async function approve(s:TrustedPersonalActionEnvelope,a:PersonalActionOutcome):Promise<PersonalActionApprovedReference> {
  const call=`approval-${a.actionId}`,request=`request-${a.actionId}`;
  await db.query(`INSERT INTO approval_asks(call_id,request_id,agent,tool,payload_hash,original_authority,
    acting_member_id,resolved_by_member_id,session_id,outcome,answered_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$7,$8,'approved',clock_timestamp())`,
    [call,request,s.agentId,PERSONAL_MAIL_SEND_TOOL,a.payloadHash,
      JSON.stringify(personalActionApprovalDescriptor(a,selection(s))),s.actorMemberId,s.sessionId]);
  await store.attachApproval({actionId:a.actionId,actorMemberId:s.actorMemberId,approvalCallId:call,requestId:request});
  return {actionId:a.actionId,payloadHash:a.payloadHash,approvalCallId:call,requestId:request,
    resolvedByMemberId:s.actorMemberId,selection:selection(s)};
}
async function ready(s=input()) {
  const a=await store.prepareAction(s);return {s,a,ref:await approve(s,a)};
}
async function row(actionId:string) { return (await db.query('SELECT * FROM personal_actions WHERE id=$1',[actionId])).rows[0]; }
async function pastAction(s:TrustedPersonalActionEnvelope) {
  const a=await store.prepareAction(s),r=await row(a.actionId);
  // A new call namespace with valid old timestamps represents a genuinely aged stored proposal.
  const oldId=randomUUID(),oldCall=s.originalCallId+'-old';
  const oldSelection={...selection(s),originalCallId:oldCall};
  const sealed=crypto.encrypt(JSON.stringify({purpose:'lares.personal-action.v1',version:1,actionId:oldId,selection:oldSelection,payload:s.payload}));
  const inserted=await db.query(`INSERT INTO personal_actions(id,payload_version,actor_member_id,agent,incarnation,
    session_id,original_turn_id,original_call_id,original_call_hash,account_id,account_generation,resource_binding_id,
    connector_id,kind,payload_hash,payload_ciphertext,created_at,expires_at)
    SELECT $1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,t,t+interval '24 hours'
    FROM (SELECT clock_timestamp()-interval '2 days' AS t) clock RETURNING *`,
    [oldId,r.actor_member_id,r.agent,r.incarnation,r.session_id,r.original_turn_id,oldCall,r.original_call_hash,
      r.account_id,r.account_generation,r.resource_binding_id,r.connector_id,r.kind,r.payload_hash,sealed]);
  const old=inserted.rows[0];
  return {actionId:oldId,payloadHash:old.payload_hash,expiresAt:old.expires_at.toISOString(),state:old.state,attemptId:null,receipt:null} as PersonalActionOutcome;
}
beforeAll(async()=>{
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  db=new Pool({connectionString:container.getConnectionUri(),max:4});
  db.on('error',()=>undefined);
  for(const name of readdirSync(sqlDir).filter(n=>n.endsWith('.sql')).sort()) await db.query(readFileSync(join(sqlDir,name),'utf8'));
  // Existing export/erase inventories include these runtime-created, member-scoped tables.
  await db.query('CREATE TABLE dream_observations(id bigserial PRIMARY KEY,owner text); CREATE TABLE dream_preferences(id bigserial PRIMARY KEY,owner text)');
},120_000);
afterAll(async()=>{await db?.end();await container?.stop();});
beforeEach(async()=>{
  await db.query('DELETE FROM personal_actions');
  await db.query('DELETE FROM approval_asks');
  await db.query('DELETE FROM conversation_retention');
  await db.query("DELETE FROM users WHERE id IN ('member-a','member-b')");
  await db.query("INSERT INTO orgs(id,display_name) VALUES('org-test','Example') ON CONFLICT DO NOTHING");
  await db.query("INSERT INTO users(id,display_name,org_id,status) VALUES('member-a','Member A','org-test','active'),('member-b','Member B','org-test','active')");
  store=new PgPersonalActionStore(db,crypto);
});

describe('private immutable personal actions',()=>{
  it('encrypts strict canonical mail, preserves the original expiry and refuses conflicting original calls',async()=>{
    const s=input(),a=await store.prepareAction(s);
    const r=await row(a.actionId);
    expect(r.payload_ciphertext).not.toContain('Private');
    expect(JSON.stringify(a)).not.toMatch(/recipient|Private|credential|token/);
    const sealed=JSON.parse(crypto.decrypt(r.payload_ciphertext));
    expect(sealed).toMatchObject({purpose:'lares.personal-action.v1',version:1,actionId:a.actionId,selection:selection(s),payload:s.payload});
    expect(r.expires_at.getTime()-r.created_at.getTime()).toBe(APPROVAL_TTL_MS);
    expect(await store.prepareAction({...s,payload:{body:s.payload.body,subject:s.payload.subject,to:s.payload.to}})).toEqual(a);
    await expect(store.prepareAction({...s,payload:{...s.payload,body:'Changed'}})).rejects.toThrow(PersonalActionError);
    await expect(store.prepareAction({...s,actorMemberId:'member-b'})).rejects.toThrow(PersonalActionError);
    await expect(store.prepareAction({...s,accountGeneration:4})).rejects.toThrow(PersonalActionError);
    await expect(store.prepareAction({...s,resourceBindingId:'mailbox-b'})).rejects.toThrow(PersonalActionError);
  });
  it('serialises simultaneous preparations to one immutable action',async()=>{
    const s=input();const results=await Promise.all(Array.from({length:8},()=>store.prepareAction(s)));
    expect(new Set(results.map(r=>r.actionId)).size).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM personal_actions')).rows[0].n).toBe(1);
  });
  it.each([
    {to:['bad\r\nBcc: victim@example.invalid'],subject:'Hi',body:'Text'},
    {to:['recipient@example.invalid'],subject:'Hi\nBcc: other',body:'Text'},
    {to:['recipient@example.invalid'],subject:'Hi\u0085Bcc: other',body:'Text'},
    {to:['recipient@example.invalid'],subject:'Hi',body:'é'.repeat(50_001)},
    {to:['recipient@example.invalid'],subject:'Hi',body:'Text\u0000'},
    {to:['recipient@example.invalid'],subject:'Hi',body:'Text',from:'other@example.invalid'},
    {to:['recipient@example.invalid'],subject:'Hi',body:'Text',html:'<b>Text</b>'},
    {to:[],subject:'Hi',body:'Text'},
    {to:['recipient@example.invalid'],subject:'Hi',body:'x'.repeat(100_001)},
  ])('refuses unsafe or unsupported mail fields',async payload=>{
    await expect(store.prepareAction({...input(),payload} as TrustedPersonalActionEnvelope)).rejects.toThrow();
    expect((await db.query('SELECT count(*)::int AS n FROM personal_actions')).rows[0].n).toBe(0);
  });
  it('enforces immutable selection, ciphertext, expiry and linkage in the database',async()=>{
    const {a,ref}=await ready();
    for(const [field,value] of [['payload_ciphertext','changed'],['payload_hash','b'.repeat(64)],['account_generation',4],
      ['actor_member_id','member-b'],['original_turn_id','other'],['expires_at',new Date(Date.now()+1000)],
      ['approval_request_id','other'],['approval_call_id','other']] as const) {
      await expect(db.query(`UPDATE personal_actions SET ${field}=$2 WHERE id=$1`,[a.actionId,value])).rejects.toThrow(/immutable/);
    }
    await expect(store.attachApproval({actionId:a.actionId,actorMemberId:'member-a',approvalCallId:ref.approvalCallId,requestId:'other'})).rejects.toThrow();
    await db.query(readFileSync(join(sqlDir,'019_personal_actions.sql'),'utf8'));
    expect((await row(a.actionId)).approval_request_id).toBe(ref.requestId);
  });
  it('compares every approved reference field before any claim and refuses missing actions',async()=>{
    const {a,ref}=await ready();
    const wrong=[{...ref,actionId:randomUUID()},{...ref,payloadHash:'b'.repeat(64)},
      {...ref,approvalCallId:'other'},{...ref,requestId:'other'},{...ref,resolvedByMemberId:'member-b'},
      {...ref,selection:{...ref.selection,accountGeneration:4}},{...ref,selection:{...ref.selection,actorMemberId:'member-b'}}];
    for(const x of wrong) await expect(store.claimAction(x)).rejects.toThrow(PersonalActionError);
    expect((await row(a.actionId)).state).toBe('awaiting_dispatch');
  });
  it('does not accept legacy or mismatched approval evidence',async()=>{
    const {a,ref}=await ready();
    // Immutable exact evidence cannot be edited, so replace the fixture ledger row deliberately.
    await db.query('DELETE FROM approval_asks WHERE call_id=$1',[ref.approvalCallId]);
    await db.query(`INSERT INTO approval_asks(request_id,call_id,agent,tool,payload_hash,acting_member_id,resolved_by_member_id,outcome,answered_at)
      VALUES($1,$2,'assistant',$3,$4,'member-a','member-a','approved',now())`,[ref.requestId,ref.approvalCallId,PERSONAL_MAIL_SEND_TOOL,a.payloadHash]);
    await expect(store.claimAction(ref)).rejects.toThrow(PersonalActionError);
  });
  it.each(['tool','payload_hash','acting_member_id','resolved_by_member_id','outcome','original_authority','request_id','agent','session_id'] as const)(
    'refuses changed approval ledger %s even with an otherwise exact reference',async field=>{
      const {ref}=await ready(),ledger=(await db.query('SELECT * FROM approval_asks WHERE call_id=$1',[ref.approvalCallId])).rows[0];
      await db.query('DELETE FROM approval_asks WHERE call_id=$1',[ref.approvalCallId]);
      ledger[field]=field==='outcome'?'cancelled':field==='original_authority'?{...ledger.original_authority,selection:{...ref.selection,accountGeneration:4}}:
        field==='payload_hash'?'b'.repeat(64):field==='acting_member_id'||field==='resolved_by_member_id'?'member-b':'changed';
      const fields=Object.keys(ledger);
      await db.query(`INSERT INTO approval_asks(${fields.join(',')}) VALUES(${fields.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(ledger));
      await expect(store.claimAction(ref)).rejects.toThrow(PersonalActionError);
      expect((await row(ref.actionId)).attempt_id).toBeNull();
    });
  it('refuses an expired approval ledger TTL according to database time',async()=>{
    const {ref}=await ready(),ledger=(await db.query('SELECT * FROM approval_asks WHERE call_id=$1',[ref.approvalCallId])).rows[0];
    await db.query('DELETE FROM approval_asks WHERE call_id=$1',[ref.approvalCallId]);
    ledger.asked_at=(await db.query("SELECT clock_timestamp()-interval '25 hours' AS old")).rows[0].old;
    const fields=Object.keys(ledger);
    await db.query(`INSERT INTO approval_asks(${fields.join(',')}) VALUES(${fields.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(ledger));
    await expect(store.claimAction(ref)).rejects.toThrow(PersonalActionError);
    expect((await row(ref.actionId)).attempt_id).toBeNull();
  });
  it('one concurrent claimant gets one permit; every replay and restarted process only reads state',async()=>{
    const {ref}=await ready();
    const results=await Promise.all(Array.from({length:12},()=>store.claimAction(ref)));
    const winners=results.filter(r=>r.permit);
    expect(winners).toHaveLength(1);
    expect(new Set(results.map(r=>r.outcome.attemptId)).size).toBe(1);
    expect(Object.keys(winners[0].permit!)).toEqual([]);
    const payload=store.consumeClaimPermit(winners[0].permit!);
    expect(payload.payload.subject).toBe('Private subject');
    expect(payload.attemptId).toBe(winners[0].outcome.attemptId);
    expect(()=>store.consumeClaimPermit(winners[0].permit!)).toThrow(PersonalActionError);
    expect(()=>store.consumeClaimPermit({} as never)).toThrow(PersonalActionError);
    const restarted=new PgPersonalActionStore(db,crypto);
    expect(await restarted.claimAction(ref)).toMatchObject({outcome:{state:'claimed'}});
    expect((await restarted.claimAction(ref)).permit).toBeUndefined();
  });
  it('commits the permanent attempt before exposing its permit, even with a pool of one',async()=>{
    const {ref}=await ready(),single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:2000});
    try {
      const one=new PgPersonalActionStore(single,crypto),won=await one.claimAction(ref);
      expect(won.permit).toBeDefined();
      expect((await row(ref.actionId)).state).toBe('claimed');
      expect((await one.readOutcome('member-a',ref.actionId)).attemptId).toBe(won.outcome.attemptId);
      expect((await one.claimAction(ref)).permit).toBeUndefined();
    } finally {await single.end();}
  });
  it('never exposes a permit when COMMIT succeeds but its acknowledgement is lost',async()=>{
    const {ref}=await ready();
    const uncertain={connect:async()=>{
      const client=await db.connect();
      return new Proxy(client,{get(target,property){
        if(property==='query') return async(text:string,params?:unknown[])=>{
          const result=await target.query(text,params);
          if(text==='COMMIT') throw new Error('Commit acknowledgement lost');
          return result;
        };
        const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
      }});
    }} as unknown as Pool;
    await expect(new PgPersonalActionStore(uncertain,crypto).claimAction(ref)).rejects.toThrow('acknowledgement');
    expect((await row(ref.actionId)).state).toBe('claimed');
    expect((await store.claimAction(ref)).permit).toBeUndefined();
  });
  it('keeps the committed claim when receipt recording rolls back',async()=>{
    const {ref}=await ready(),won=await store.claimAction(ref);
    await db.query(`CREATE FUNCTION refuse_fixture_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fixture receipt failure'; END $$;
      CREATE TRIGGER refuse_fixture_receipt BEFORE UPDATE ON personal_actions FOR EACH ROW WHEN (NEW.state='accepted') EXECUTE FUNCTION refuse_fixture_receipt()`);
    try {
      await expect(store.recordOutcome(won.permit!,{state:'accepted',providerReceiptId:'message-123'})).rejects.toThrow('Fixture');
      expect(await row(ref.actionId)).toMatchObject({state:'claimed',attempt_id:won.outcome.attemptId,receipt:null});
      expect((await store.claimAction(ref)).permit).toBeUndefined();
    } finally {await db.query('DROP TRIGGER refuse_fixture_receipt ON personal_actions; DROP FUNCTION refuse_fixture_receipt()');}
    const done=await store.recordOutcome(won.permit!,{state:'accepted',providerReceiptId:'message-123'});
    expect(done.state).toBe('accepted');
    expect(await store.recordOutcome(won.permit!,{state:'accepted',providerReceiptId:'message-123'})).toEqual(done);
    await expect(store.recordOutcome(won.permit!,{state:'unknown',code:'transport_uncertain'})).rejects.toThrow();
    await expect(db.query("UPDATE personal_actions SET state='awaiting_dispatch',attempt_id=NULL,claimed_at=NULL,receipt=NULL,completed_at=NULL WHERE id=$1",[ref.actionId])).rejects.toThrow();
    await expect(db.query('UPDATE personal_actions SET attempt_id=$2 WHERE id=$1',[ref.actionId,randomUUID()])).rejects.toThrow(/immutable/);
  });
  it.each(['not_dispatched','rejected','unknown'] as const)('records a safe %s outcome without releasing the attempt',async state=>{
    const {ref}=await ready(),won=await store.claimAction(ref);
    const receipt=state==='not_dispatched'?{state,code:'authority_changed' as const}:state==='rejected'?{state,code:'provider_refused' as const}:{state,code:'transport_uncertain' as const};
    const finished=await store.recordOutcome(won.permit!,receipt);
    expect(finished).toMatchObject({state,attemptId:won.outcome.attemptId,receipt});
    expect(()=>store.consumeClaimPermit(won.permit!)).toThrow(PersonalActionError);
    expect((await store.claimAction(ref)).permit).toBeUndefined();
  });
  it('refuses raw error text and unsafe receipt fields',async()=>{
    const {ref}=await ready(),won=await store.claimAction(ref);
    await expect(store.recordOutcome(won.permit!,{state:'unknown',code:'transport_uncertain',error:'secret'} as never)).rejects.toThrow();
    await expect(store.recordOutcome(won.permit!,{state:'accepted',providerReceiptId:'mail\nsecret'})).rejects.toThrow();
    await expect(db.query("UPDATE personal_actions SET state='unknown',receipt=$2::jsonb,completed_at=now() WHERE id=$1",[ref.actionId,JSON.stringify({state:'unknown',code:'transport_uncertain',error:'secret'})])).rejects.toThrow();
    await expect(db.query("UPDATE personal_actions SET state='unknown',receipt=$2::jsonb,completed_at=now() WHERE id=$1",[ref.actionId,JSON.stringify({state:'unknown',code:null})])).rejects.toThrow();
    expect((await row(ref.actionId)).state).toBe('claimed');
  });
  it('uses the database clock for expiry and never extends a stored proposal on replay',async()=>{
    const s=input(),a=await store.prepareAction(s),spy=vi.spyOn(Date,'now').mockReturnValue(Date.now()+7*86_400_000);
    try {
      expect(await store.prepareAction(s)).toEqual(a);
      expect((await store.claimAction(await approve(s,a))).permit).toBeDefined();
    } finally {spy.mockRestore();}
    const old=await pastAction(input()),r=await row(old.actionId),oldSelection={
      actorMemberId:r.actor_member_id,agentId:r.agent,incarnation:r.incarnation,sessionId:r.session_id,
      originalTurnId:r.original_turn_id,originalCallId:r.original_call_id,accountId:r.account_id,
      accountGeneration:r.account_generation,resourceBindingId:r.resource_binding_id,connectorId:r.connector_id,kind:'mail.send' as const};
    // Attach while expired is refused; a genuinely expired pending row cannot be made executable.
    await expect(store.attachApproval({actionId:old.actionId,actorMemberId:'member-a',approvalCallId:'old',requestId:'old'})).rejects.toThrow();
    await db.query("UPDATE personal_actions SET approval_call_id='old',approval_request_id='old',state='awaiting_dispatch' WHERE id=$1",[old.actionId]);
    const expired=await store.claimAction({actionId:old.actionId,payloadHash:old.payloadHash,approvalCallId:'old',requestId:'old',resolvedByMemberId:'member-a',selection:oldSelection});
    expect(expired).toMatchObject({outcome:{state:'expired'}});expect(expired.permit).toBeUndefined();
  });
  it('refuses ciphertext swaps and envelope metadata mismatches on decryption',async()=>{
    const s=input(),a=await store.prepareAction(s),other=await store.prepareAction(input());
    // Simulate storage corruption below the immutable trigger, then restore the trigger immediately.
    await db.query('ALTER TABLE personal_actions DISABLE TRIGGER personal_action_guard');
    try {await db.query('UPDATE personal_actions SET payload_ciphertext=(SELECT payload_ciphertext FROM personal_actions WHERE id=$2) WHERE id=$1',[a.actionId,other.actionId]);}
    finally {await db.query('ALTER TABLE personal_actions ENABLE TRIGGER personal_action_guard');}
    await expect(store.prepareAction(s)).rejects.toThrow(PersonalActionError);
    await expect(store.claimAction(await approve(s,a))).rejects.toThrow(PersonalActionError);
    expect((await row(a.actionId)).state).toBe('awaiting_dispatch');
  });
  it('only the current actor can read or cancel and a cancelled action never claims',async()=>{
    const {a,ref}=await ready();
    await expect(store.readOutcome('member-b',a.actionId)).rejects.toThrow(PersonalActionError);
    await expect(store.cancelUnclaimedAction('member-b',a.actionId)).rejects.toThrow(PersonalActionError);
    expect((await store.cancelUnclaimedAction('member-a',a.actionId)).state).toBe('cancelled');
    expect((await store.claimAction(ref)).permit).toBeUndefined();
    await db.query("UPDATE users SET status='removed' WHERE id='member-a'");
    await expect(store.readOutcome('member-a',a.actionId)).rejects.toThrow(PersonalActionError);
  });
  it('retention uses the existing default/override, removes only that member and prevents resurrection',async()=>{
    const s=input(),a=await store.prepareAction(s),other=await store.prepareAction({...input(),actorMemberId:'member-b'});
    const future=new Date();future.setUTCMonth(future.getUTCMonth()+13);
    await db.query("INSERT INTO conversation_retention(owner,months,updated_by) VALUES('member-a',NULL,'member-a')");
    expect(await store.pruneForMember('member-a',future)).toBe(0);
    await db.query("UPDATE conversation_retention SET months=1 WHERE owner='member-a'");
    expect(await store.pruneForMember('member-a',future)).toBe(1);
    expect((await row(other.actionId)).actor_member_id).toBe('member-b');
    await expect(store.prepareAction(s)).rejects.toThrow(PersonalActionError);
    await expect(store.claimAction({actionId:a.actionId,payloadHash:a.payloadHash,approvalCallId:'missing',requestId:'missing',resolvedByMemberId:'member-a',selection:selection(s)})).rejects.toThrow(PersonalActionError);
    const b=input(),fresh=await store.prepareAction(b);
    await db.query("DELETE FROM conversation_retention WHERE owner='member-a'");
    const before=new Date();before.setUTCMonth(before.getUTCMonth()+11);
    expect(await store.pruneForMember('member-a',before)).toBe(0);
    expect(await store.pruneForMember('member-a',future)).toBe(1);
    expect(await row(fresh.actionId)).toBeUndefined();
  });
  it('member export/erasure inventories reach the action, withhold ciphertext and preserve only suppression',async()=>{
    const {s,a,ref}=await ready(),other=await store.prepareAction({...input(),actorMemberId:'member-b'});
    const root=mkdtempSync(join(tmpdir(),'personal-actions-export-'));
    try {
      const report=await exportPerson(db,{person:'member-a',outDir:join(root,'export'),vaults:[]});
      expect(report.refusals).toEqual([]);
      const tables=report.tables;
      const actions=tables.find(t=>t.table==='personal_actions');
      expect(actions?.rows).toBe(1);
      expect(tables.some(t=>t.table==='personal_action_calls')).toBe(false);
      const content=readFileSync(join(root,'export',actions!.file!),'utf8');
      expect(content).toContain('[withheld]');expect(content).not.toContain((await row(a.actionId)).payload_ciphertext);
      expect(content).not.toContain('Private message');
      const erased=await erasePerson(db,{person:'member-a',dryRun:false});
      expect(erased.refusals).toEqual([]);
      expect(await row(a.actionId)).toBeUndefined();
      expect(await row(other.actionId)).toBeDefined();
      await expect(store.claimAction(ref)).rejects.toThrow(PersonalActionError);
      await db.query("INSERT INTO users(id,display_name,org_id,status) VALUES('member-a','Member A','org-test','active')");
      await expect(store.prepareAction(s)).rejects.toThrow(PersonalActionError);
    } finally {rmSync(root,{recursive:true,force:true});}
  });
  it('a direct delete and reinsert cannot reset the original call or suppression hash',async()=>{
    const s=input(),a=await store.prepareAction(s),r=await row(a.actionId);
    await db.query('DELETE FROM personal_actions WHERE id=$1',[a.actionId]);
    await expect(store.prepareAction(s)).rejects.toThrow(PersonalActionError);
    await expect(db.query('DELETE FROM personal_action_calls WHERE original_call_hash=$1',[r.original_call_hash])).rejects.toThrow(/permanent/);
    await expect(db.query(`INSERT INTO personal_actions(id,payload_version,actor_member_id,agent,incarnation,session_id,
      original_turn_id,original_call_id,original_call_hash,account_id,account_generation,resource_binding_id,connector_id,
      kind,payload_hash,payload_ciphertext,created_at,expires_at) SELECT $1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,t,t+interval '24 hours'
      FROM (SELECT clock_timestamp() AS t) clock`,[randomUUID(),r.actor_member_id,r.agent,r.incarnation,r.session_id,
      r.original_turn_id,r.original_call_id,'f'.repeat(64),r.account_id,r.account_generation,r.resource_binding_id,
      r.connector_id,r.kind,r.payload_hash,r.payload_ciphertext])).rejects.toThrow(/already reserved/);
  });
});
