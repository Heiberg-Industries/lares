import { beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi } from 'vitest';
import { PostgreSqlContainer,type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync,readdirSync } from 'node:fs';
import { Pool } from 'pg';
import {MockAgent} from 'undici';
import { getPool,closePool } from '@lares/agent-kit/db';
import { PgAccountStore,type TrustedAccountAdapter } from '@lares/agent-kit/account-store';
import { PgGrantStore } from '@lares/agent-kit/grant-store';
import { bindConsoleSession } from '@lares/agent-kit/console-turn-authority';
import { encryptSecret,decryptSecret } from '@lares/agent-box/lib/crypto.js';
import {currentTaint,resetTaintForTests} from '@lares/agent-kit/origin-taint';
import {mountedPersonalReadRuntime} from '../lib/personal-read-runtime.js';
import mailboxAccounts from '../catalogue/personal_mailbox_accounts.js';
import calendarAccounts from '../catalogue/personal_calendar_accounts.js';
import mailboxRead from '../catalogue/personal_mailbox_read.js';
import mailboxList from '../catalogue/personal_mailbox_list.js';
import calendarEvents from '../catalogue/personal_calendar_events.js';
import { readPersonalResource } from '../lib/personal-reads.js';
import { PersonalReadError } from '../lib/personal-read-contract.js';
import { quiet } from './helpers/quiet-pool.js';
const tenantId='11111111-2222-4333-8444-555555555555',subject='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const issuer=`https://login.microsoftonline.com/${tenantId}/v2.0`,key='1'.repeat(64),incarnation='11111111-1111-4111-8111-111111111111',nonce='a'.repeat(43);
const scopes=['User.Read','Mail.Read','Calendars.Read'];
const offlineDispatcher=new MockAgent();offlineDispatcher.disableNetConnect();
const runtime={microsoft:()=>({settings:{tenantId,clientId:'data-client',clientSecret:'secret',tokenKeyHex:key},dispatcher:offlineDispatcher})};
const auth=(member='member-a',purpose='human')=>({authenticator:'lares-console',attributes:{user_id:'legacy@example.invalid',lares_member_id:member,lares_admission_nonce:nonce,lares_purpose:purpose}});
const ctx=(current=auth())=>({session:{id:'wrun_read',turn:{id:'read-turn',sequence:1},auth:{current,initiator:auth()}}}) as never;
const operation={kind:'readMail' as const,id:'mail'};
let container:StartedPostgreSqlContainer,store:PgAccountStore,calls:string[],providerFails:boolean,hold:(()=>Promise<void>)|undefined;
const fetcher=async(input:Request|string|URL,options?:RequestInit)=>{
  const url=new URL(String(input));calls.push(url.pathname);options?.signal?.throwIfAborted();
  if(url.pathname.endsWith('openid-configuration'))return Response.json({issuer,authorization_endpoint:`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,token_endpoint:`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,jwks_uri:`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256']});
  if(url.pathname.endsWith('/token'))return Response.json({access_token:'opaque',refresh_token:'rotated',token_type:'Bearer',scope:scopes.join(' ')});
  if(url.pathname==='/v1.0/me')return Response.json({id:subject,userType:'Member'});
  await hold?.();
  if(providerFails)return Response.json({error:{code:'fixture',message:'PRIVATE PROVIDER DETAILS'}},{status:503});
  if(url.pathname.endsWith('/messages'))return Response.json({value:[{id:'mail',receivedDateTime:'2026-10-01T01:00:00Z'}]});
  if(url.pathname.endsWith('/calendarView'))return Response.json({value:[{id:'event',start:{dateTime:'2026-10-01T01:00:00',timeZone:'UTC'},end:{dateTime:'2026-10-01T02:00:00',timeZone:'UTC'}}]});
  return Response.json({id:'mail',body:{contentType:'text',content:'x'.repeat(20_000)}});
};
async function connected(member='member-a',changed:{identity?:Record<string,string>;scopes?:string[];connector?:string;org?:string}={}){
  const adapter:TrustedAccountAdapter={connectorId:changed.connector??'microsoft',verifyAccount:async()=>({issuer,tenantId,subject,label:'Work account',...changed.identity}),
    verifyResource:async(_a,kind)=>({resourceKind:String(kind),externalId:kind==='calendar'?'selected/calendar':subject,providerLabel:'Private resource'})};
  const account=await store.forTrustedAdapter(adapter).createPersonalAccount(member,null,{persist:async(db,owner)=>{
    const {rows}=await db.query(`INSERT INTO oauth_tokens(principal,provider,org_id,email_address,scopes,refresh_token_enc) VALUES($1,$2,$3,'label@example.invalid',$4,$5) RETURNING id`,[member,owner.connectorId,changed.org??'microsoft',changed.scopes??scopes,encryptSecret('old-refresh',key)]);return rows[0].id;
  }},['mailbox','calendar']);
  const resources=await store.listResources(member,account.id,account.generation);
  return {account,resources,selection:{accountId:account.id,generation:account.generation,resourceBindingId:resources.find(r=>r.resourceKind==='mailbox')!.id}};
}
const ciphertext=async()=>(await getPool().query('SELECT refresh_token_enc FROM oauth_tokens ORDER BY id')).rows.map(r=>r.refresh_token_enc);
beforeAll(async()=>{
  container=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();vi.stubEnv('DATABASE_URL',container.getConnectionUri());quiet(getPool());
  const sql=new URL('../../box/sql/',import.meta.url);for(const name of readdirSync(sql).filter(n=>n.endsWith('.sql')).sort())await getPool().query(readFileSync(new URL(name,sql),'utf8'));
  store=new PgAccountStore(getPool());
},120_000);
afterAll(async()=>{await closePool();await container?.stop();await offlineDispatcher.close();});
beforeEach(async()=>{
  vi.stubEnv('EGRESS_PROXY_URL','http://proxy:8888');
  vi.stubEnv('AGENT_OWNER_USER_ID','member-a');vi.stubEnv('LARES_AGENT_NAME','helper');vi.stubEnv('LARES_AGENT_INCARNATION',incarnation);
  await getPool().query('DELETE FROM console_session_bindings; DELETE FROM connected_accounts; DELETE FROM oauth_tokens; DELETE FROM agent_resources; DELETE FROM agent_definitions');
  await getPool().query(`INSERT INTO orgs(id,display_name) VALUES('fixture-org','Fixture') ON CONFLICT DO NOTHING;
    INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('member-a','A','fixture-org','owner','active'),('member-b','B','fixture-org','owner','active') ON CONFLICT(id) DO UPDATE SET status='active',org_role='owner';
    INSERT INTO agent_definitions(name,definition,hash) VALUES('helper','{"grants":[]}','fixture');`);
  await getPool().query(`INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending) VALUES('helper','127.0.0.2','fixture','owned',$1,$1,'ready',false)`,[incarnation]);
  await getPool().query("INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES('member-a',NULL) ON CONFLICT(user_id) DO NOTHING");
  await new PgGrantStore(getPool()).adoptAgent('member-a',{agentName:'helper',expectedDefinitionHash:'fixture'},{designatedOwnerMemberId:'member-a'});
  await bindConsoleSession({agent:'helper',incarnation,sessionId:'wrun_read',memberId:'member-a',admissionNonce:nonce});
  calls=[];providerFails=false;hold=undefined;vi.stubGlobal('fetch',vi.fn(fetcher));
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();resetTaintForTests();});
describe('private neutral reads through real current authority and PostgreSQL custody',()=>{
  it('reads selected mail, bounds body and rotates exact encrypted row without reconnecting',async()=>{
    const own=await connected();const result=await readPersonalResource(ctx(),own.selection,operation,runtime);
    expect(result).toMatchObject({kind:'readMail',message:{id:'mail',bodyText:'x'.repeat(12_000),senderStanding:'I could not check'},bodyPage:{truncated:true,nextOffset:12_000}});
    expect((await ciphertext()).map(t=>decryptSecret(t,key))).toEqual(['rotated']);expect((await store.list('member-a'))[0].generation).toBe(own.account.generation);
    expect(calls.filter(p=>p.startsWith('/v1.0/'))).toEqual(['/v1.0/me','/v1.0/me/messages/mail']);
  });
  it('uses only selected calendar binding and no mailbox fallback',async()=>{
    const own=await connected();const selection={...own.selection,resourceBindingId:own.resources.find(r=>r.resourceKind==='calendar')!.id};
    expect(await readPersonalResource(ctx(),selection,{kind:'calendarWindow',window:{from:'2026-10-01T00:00:00Z',until:'2026-10-02T00:00:00Z',limit:1}},runtime)).toMatchObject({kind:'calendarWindow',truncated:false,items:[{id:'event'}]});
    expect(calls.at(-1)).toBe('/v1.0/me/calendars/selected%2Fcalendar/calendarView');
  });
  it.each(['other-member','generation','cross-resource','calendar','revoked','removed','session','custody','scope','tenant','oid','org','connector','runtime'])('refuses wrong %s before provider invocation',async kind=>{
    const own=await connected('member-a',kind==='scope'?{scopes:['User.Read']}:kind==='tenant'?{identity:{tenantId:'99999999-2222-4333-8444-555555555555'}}:kind==='oid'?{identity:{subject:'invalid'}}:kind==='org'?{org:'legacy'}:kind==='connector'?{connector:'other'}:{});
    let selection=own.selection;
    if(kind==='other-member')selection=(await connected('member-b')).selection;
    if(kind==='cross-resource')selection={...selection,resourceBindingId:(await connected('member-b')).selection.resourceBindingId};
    if(kind==='generation')selection={...selection,generation:99};
    if(kind==='calendar')selection={...selection,resourceBindingId:own.resources.find(r=>r.resourceKind==='calendar')!.id};
    if(kind==='revoked')await store.setStatus('member-a',await store.beginUpdate('member-a',own.account.id,0),'revoked');
    if(kind==='removed')await getPool().query("UPDATE users SET status='removed' WHERE id='member-a'");
    if(kind==='session')await getPool().query('UPDATE console_session_bindings SET revoked_at=now()');
    if(kind==='custody')await getPool().query('UPDATE connected_account_credentials SET account_generation=99');
    await expect(readPersonalResource(ctx(),selection,operation,kind==='runtime'?{}:runtime)).rejects.toThrow(PersonalReadError);expect(calls).toEqual([]);
  });
  it.each(['native','resolver','member'])('refuses %s turn before provider invocation',async kind=>{
    const own=await connected();const context=kind==='native'?{} as never:kind==='resolver'?ctx(auth('member-a','resolver')):ctx(auth('member-b'));
    await expect(readPersonalResource(context,own.selection,operation,runtime)).rejects.toThrow(PersonalReadError);expect(calls).toEqual([]);
  });
  it('rolls back rotated ciphertext on failed read and sanitizes database/provider errors',async()=>{
    const own=await connected(),before=await ciphertext();providerFails=true;
    await expect(readPersonalResource(ctx(),own.selection,operation,runtime)).rejects.toThrow('Selected private resource is unavailable or authority changed');expect(await ciphertext()).toEqual(before);
    calls=[];vi.spyOn(getPool(),'connect').mockRejectedValueOnce(new Error('PRIVATE DB DETAILS') as never);
    await expect(readPersonalResource(ctx(),own.selection,operation,runtime)).rejects.toThrow(PersonalReadError);expect(calls).toEqual([]);
  });
  it('rechecks authority using the same single pool connection',async()=>{
    const own=await connected();await closePool();const pool=quiet(getPool());pool.options.max=1;pool.options.connectionTimeoutMillis=300;store=new PgAccountStore(pool);
    try{await expect(readPersonalResource(ctx(),own.selection,operation,runtime)).resolves.toMatchObject({kind:'readMail'});}finally{pool.options.max=10;pool.options.connectionTimeoutMillis=0;}
  });
  it.each(['member-removal','reconnect'] as const)('serializes %s until read/rotation settle and refuses stale later access',async change=>{
    const own=await connected();let entered!:()=>void,release!:()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});hold=async()=>{entered();await wait;};
    const running=readPersonalResource(ctx(),own.selection,operation,runtime);const result=running.then(value=>({ok:true,value}),error=>({ok:false,error}));
    const otherPool=quiet(new Pool({connectionString:process.env.DATABASE_URL,application_name:'read-lock-proof',max:1}));let mutation:Promise<unknown>|undefined;
    try{
      await ready;
      mutation=change==='member-removal'?otherPool.query("UPDATE users SET status='removed' WHERE id='member-a'"):
        new PgAccountStore(otherPool).beginUpdate('member-a',own.account.id,own.account.generation).then(update=>new PgAccountStore(otherPool).setStatus('member-a',update,'needs_reconsent'));
      const changed=mutation.then(()=>({ok:true}),error=>({ok:false,error}));let blocked=false;
      for(let n=0;n<100;n++){blocked=(await getPool().query("SELECT 1 FROM pg_stat_activity WHERE application_name='read-lock-proof' AND wait_event_type='Lock'")).rows.length>0;if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));}
      expect(blocked).toBe(true);release();expect(await result).toMatchObject({ok:true});expect(await changed).toEqual({ok:true});
      calls=[];await expect(readPersonalResource(ctx(),own.selection,operation,runtime)).rejects.toThrow(PersonalReadError);expect(calls).toEqual([]);
    }finally{release();await running.catch(()=>undefined);await mutation?.catch(()=>undefined);await otherPool.end();}
  },10_000);
});

describe('catalogue tools through real current authority and PostgreSQL custody; provider HTTP remains mocked',()=>{
 const run=(tool:any,input:unknown,context=ctx())=>tool.execute(input,context);
 const window={from:'2026-10-01T00:00:00Z',until:'2026-10-02T00:00:00Z',limit:2};
 it('metadata lists only current member accounts and exact resource kinds for both connectors without provider calls',async()=>{
  const own=await connected(),other=await connected('member-b');
  const google=await connected('member-a',{connector:'google',identity:{issuer:'https://accounts.google.com'}});
  const mail=await run(mailboxAccounts,{}),cal=await run(calendarAccounts,{});
  expect(mail.map((a:any)=>a.accountId).sort()).toEqual([own.account.id,google.account.id].sort());expect(JSON.stringify(mail)).not.toContain(other.account.id);
  expect(mail.map((a:any)=>a.connectorId).sort()).toEqual(['google','microsoft']);
  for(const account of mail)expect(account.resources).toHaveLength(1);
  expect(mail.find((a:any)=>a.accountId===own.account.id).resources[0].resourceBindingId).toBe(own.selection.resourceBindingId);
  expect(cal.find((a:any)=>a.accountId===own.account.id).resources[0].resourceBindingId).toBe(own.resources.find(r=>r.resourceKind==='calendar')!.id);
  expect(JSON.stringify(mail)).not.toMatch(/issuer|subject|externalId|orgId|emailAddress|refresh|credential|tenant/);expect(calls).toEqual([]);
  expect(currentTaint({sessionId:'wrun_read',turnId:'read-turn'})).toBe('third_party');
 });
 it.each(['native','removed-member','retired-binding'])('metadata refuses %s before returning selections',async change=>{
  await connected();let context=ctx();
  if(change==='native')context={} as never;
  if(change==='removed-member')await getPool().query("UPDATE users SET status='removed' WHERE id='member-a'");
  if(change==='retired-binding')await getPool().query('UPDATE console_session_bindings SET revoked_at=now()');
  for(const tool of [mailboxAccounts,calendarAccounts])await expect(run(tool,{},context)).rejects.toThrow(PersonalReadError);
  expect(calls).toEqual([]);expect(currentTaint({sessionId:'wrun_read',turnId:'read-turn'})).toBeUndefined();
 });
 it('new mailbox and calendar tools use exact selection and official adapters, quote/page content and taint',async()=>{
  vi.spyOn(mountedPersonalReadRuntime,'microsoft').mockImplementation(runtime.microsoft);
  const own=await connected();
  expect(await run(mailboxList,{selection:own.selection,window})).toMatchObject({kind:'mailWindow',items:[{id:'mail'}]});
  const mail=await run(mailboxRead,{selection:own.selection,id:'mail',offset:0});expect(mail.message.bodyText).toContain("<<<SOMEONE ELSE'S WORDS");expect(mail.bodyPage.nextOffset).toBe(12000);
  const selection={...own.selection,resourceBindingId:own.resources.find(r=>r.resourceKind==='calendar')!.id};
  expect(await run(calendarEvents,{selection,window})).toMatchObject({kind:'calendarWindow',items:[{id:'event'}]});
  expect(calls).toContain('/v1.0/me/calendars/selected%2Fcalendar/calendarView');expect(currentTaint({sessionId:'wrun_read',turnId:'read-turn'})).toBe('third_party');
  calls=[];await store.setStatus('member-a',await store.beginUpdate('member-a',own.account.id,own.account.generation),'needs_reconsent');
  await expect(run(mailboxRead,{selection:own.selection,id:'mail',offset:0})).rejects.toThrow(PersonalReadError);expect(calls).toEqual([]);
 });
});
