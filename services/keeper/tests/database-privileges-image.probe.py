"""CI-only proof of fixed PostgreSQL roles against the final Keeper image."""
import pathlib, re, secrets, subprocess, sys, time, uuid

repo=pathlib.Path(__file__).resolve().parents[3]
name='lares-database-role-proof-'+uuid.uuid4().hex[:10]
db_container=name+'-db'
proof_container=name+'-keeper'
image=sys.argv[1]
app_password=secrets.token_urlsafe(32)
financial_password=secrets.token_urlsafe(32)
outside_custody_password=secrets.token_urlsafe(32)
phase='setup'
failed=False
role_diagnostic=None

def cmd(*args,input=None,timeout=45):
 try:return subprocess.check_output(args,input=input,text=True,stderr=subprocess.STDOUT,timeout=timeout).strip()
 except Exception:raise RuntimeError('disposable database-role proof command failed') from None

def sql(body):
 return cmd('docker','exec','-i',db_container,'psql','-X','-v','ON_ERROR_STOP=1','-U','proof','-d','proof',input=body)

try:
 phase='database'
 cmd('docker','network','create',name)
 cmd('docker','run','-d','--name',db_container,'--network',name,'--network-alias','proof-db',
     '-e','POSTGRES_USER=proof','-e','POSTGRES_PASSWORD=disposable-proof-only','-e','POSTGRES_DB=proof',
     'pgvector/pgvector:pg16')
 for _ in range(60):
  try:
   cmd('docker','exec','-e','PGPASSWORD=disposable-proof-only',db_container,'psql','-h','127.0.0.1',
       '-U','proof','-d','proof','-Atc','SELECT 1',timeout=5)
   break
  except Exception:time.sleep(.5)
 else:raise RuntimeError('disposable database did not become ready')

 phase='migrations'
 applied=[]
 migrations=sorted((repo/'services/box/sql').glob('[0-9][0-9][0-9]_*.sql'))
 for migration in migrations:
  applied.append(migration.name)
  sql(migration.read_text())
 on_disk={p.name for p in (repo/'services/box/sql').iterdir() if p.name[:3].isdigit() and p.name.endswith('.sql')}
 if set(applied)!=on_disk or '001_baseline.sql' not in applied:raise RuntimeError('numbered migration loop incomplete')

 phase='neutral-fixture'
 sql("INSERT INTO orgs(id,display_name) VALUES('database-role-proof-org','Database role proof'); INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('database-role-proof-member','Fixture member','database-role-proof-org','owner','active'),('database-role-delete-proof','Delete fixture','database-role-proof-org','member','active'),('database-role-policy-proof','Policy fixture','database-role-proof-org','member','active')")

 phase='actual-roles'
 role_probe=r"""import{Pool}from'pg';import{randomUUID,createHash}from'node:crypto';
import{provisionEngineDatabasePrivileges}from'/app/services/box/lib/database-privileges.ts';
import{OutsideCustodyStore}from'/app/services/keeper/lib/outside-custody.ts';
import{PgGrantStore}from'/app/packages/agent-kit/src/grant-store.ts';
import{bindConsoleSession}from'/app/packages/agent-kit/src/console-turn-authority.ts';
import{consoleSourceTransaction,gateConsoleOrganisation}from'/app/packages/agent-kit/src/console-source-transaction.ts';
import{observeFinancialDatabase,observeFinancialCheckpoint}from'/app/services/keeper/lib/financial-continuity.ts';
const admin=new Pool({connectionString:process.env.PROOF_ADMIN_URL,max:1,connectionTimeoutMillis:3000,statement_timeout:7000,query_timeout:10000});
const app=new Pool({connectionString:process.env.PROOF_APP_URL,max:1,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:8000});
const financial=new Pool({connectionString:process.env.PROOF_FINANCIAL_URL,max:1,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:8000});
const outside=new Pool({connectionString:process.env.PROOF_OUTSIDE_CUSTODY_URL,max:1,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:8000});
const financeTables=['budget_accounts','budget_windows','budget_gateway_bindings','budget_attempts','budget_gateway_grants','budget_financial_checkpoints'];
let proofAssertion='startup';
let outsideStageOutcome='not-reached',outsideStageReason='none',outsideStageRevisionPresent=false;
let outsideStageInputShape='not-evaluated';
async function denied42501(pool,sql,values){let code;try{await pool.query(sql,values);}catch(error){code=error?.code;}if(code!=='42501')throw Error();}
async function main(){try{
proofAssertion='database-role-provisioning';
const passwords={application:Buffer.from(process.env.PROOF_APP_PASSWORD),financial:Buffer.from(process.env.PROOF_FINANCIAL_PASSWORD),outsideCustody:Buffer.from(process.env.PROOF_OUTSIDE_CUSTODY_PASSWORD)};
const operator=await admin.connect();let first,second;try{first=await provisionEngineDatabasePrivileges(operator,{expectedDatabase:'proof',passwords});second=await provisionEngineDatabasePrivileges(operator,{expectedDatabase:'proof',passwords});}finally{operator.release();}
proofAssertion='database-role-provisioning-result';
if(first?.status!=='applied'||second?.status!=='verified')throw Error();
proofAssertion='fixed-role-attributes';
const fixedRoles=await admin.query("SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,(SELECT count(*) FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)::int AS memberships FROM pg_roles r WHERE rolname=ANY($1::text[])",[['lares_schema_owner','lares_app','lares_financial','lares_outside_custody']]);
if(fixedRoles.rows.length!==4||fixedRoles.rows.some(role=>role.rolsuper||role.rolcreatedb||role.rolcreaterole||role.rolinherit||role.rolreplication||role.rolbypassrls||role.memberships!==0)||fixedRoles.rows.find(role=>role.rolname==='lares_schema_owner')?.rolcanlogin||!fixedRoles.rows.find(role=>role.rolname==='lares_app')?.rolcanlogin||!fixedRoles.rows.find(role=>role.rolname==='lares_financial')?.rolcanlogin||!fixedRoles.rows.find(role=>role.rolname==='lares_outside_custody')?.rolcanlogin)throw Error();
for(const [pool,expected]of[[app,'lares_app'],[financial,'lares_financial']]){
proofAssertion=expected==='lares_app'?'application-login-and-relation-privileges':'financial-login-and-relation-privileges';
const result=await pool.query(`SELECT current_user,session_user,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolinherit,r.rolreplication,r.rolbypassrls,
 (SELECT count(*) FROM pg_auth_members m WHERE m.member=r.oid)::int AS memberships,
 has_database_privilege(current_user,current_database(),'CONNECT') AS db_connect,has_database_privilege(current_user,current_database(),'TEMP') AS db_temp,
 has_schema_privilege(current_user,'public','USAGE') AS schema_usage,has_schema_privilege(current_user,'public','CREATE') AS schema_create,
 has_table_privilege(current_user,'settings','SELECT') AS settings_read,has_table_privilege(current_user,'settings','INSERT') AS settings_insert,
 has_table_privilege(current_user,'settings','UPDATE') AS settings_update,has_table_privilege(current_user,'settings','DELETE') AS settings_delete,
 has_table_privilege(current_user,'schema_migrations','SELECT') AS ledger_read,
 has_table_privilege(current_user,'schema_migrations','INSERT') AS ledger_insert,
 has_table_privilege(current_user,'schema_migrations','UPDATE') AS ledger_update,
 has_any_column_privilege(current_user,'public.schema_migrations','SELECT') AS ledger_any_read_column,
 has_any_column_privilege(current_user,'public.schema_migrations','INSERT') AS ledger_any_insert_column,
 has_any_column_privilege(current_user,'public.schema_migrations','UPDATE') AS ledger_any_update_column
 FROM pg_roles r WHERE r.rolname=current_user`);
const role=result.rows[0];if(!role||role.current_user!==expected||role.session_user!==expected||!role.rolcanlogin||role.rolsuper||role.rolcreatedb||role.rolcreaterole||role.rolinherit||role.rolreplication||role.rolbypassrls||role.memberships!==0||!role.db_connect||role.db_temp||!role.schema_usage||role.schema_create||!role.settings_read||!role.settings_insert||!role.settings_update||!role.settings_delete||role.ledger_read||role.ledger_insert||role.ledger_update||role.ledger_any_read_column||role.ledger_any_insert_column||role.ledger_any_update_column)throw Error();
for(const table of financeTables){
proofAssertion=expected==='lares_app'?'application-finance-table-denials':'financial-table-grants';
const privileges=await pool.query("SELECT has_table_privilege(current_user,$1,'SELECT') AS can_read,has_table_privilege(current_user,$1,'INSERT') AS can_insert,has_table_privilege(current_user,$1,'UPDATE') AS can_update,has_table_privilege(current_user,$1,'DELETE') AS can_delete,has_table_privilege(current_user,$1,'TRUNCATE') AS can_truncate,has_any_column_privilege(current_user,$1,'SELECT') AS any_read_column,has_any_column_privilege(current_user,$1,'INSERT') AS any_insert_column,has_any_column_privilege(current_user,$1,'UPDATE') AS any_update_column",['public.'+table]);
const p=privileges.rows[0];if(expected==='lares_app'?(p.can_read||p.can_insert||p.can_update||p.can_delete||p.can_truncate):(!p.can_read||!p.can_insert||p.can_update||p.can_delete||p.can_truncate))throw Error();
if(expected==='lares_app'&&(p.any_read_column||p.any_insert_column||p.any_update_column))throw Error();
}
const custodyIdentity=await outside.query("SELECT current_user,session_user,has_table_privilege(current_user,'outside_custody_accounts','SELECT') AS custody_read,has_table_privilege(current_user,'outside_custody_accounts','INSERT') AS custody_insert,has_table_privilege(current_user,'outside_custody_accounts','DELETE') AS account_delete,has_table_privilege(current_user,'outside_custody_revisions','DELETE') AS revision_delete,has_table_privilege(current_user,'outside_custody_operations','DELETE') AS receipt_delete,has_table_privilege(current_user,'outside_execution_approvals','DELETE') AS approval_delete,has_table_privilege(current_user,'oauth_tokens','SELECT') AS oauth_read,has_table_privilege(current_user,'budget_accounts','SELECT') AS financial_read,has_column_privilege(current_user,'org_member_policy','outside_custody_lock','UPDATE') AS lock_update,has_column_privilege(current_user,'org_member_policy','allowed_capabilities','UPDATE') AS authority_update");
proofAssertion='outside-custody-role-boundary';
if(custodyIdentity.rows[0]?.current_user!=='lares_outside_custody'||custodyIdentity.rows[0]?.session_user!=='lares_outside_custody'||!custodyIdentity.rows[0]?.custody_read||!custodyIdentity.rows[0]?.custody_insert||custodyIdentity.rows[0]?.account_delete||!custodyIdentity.rows[0]?.revision_delete||custodyIdentity.rows[0]?.receipt_delete||custodyIdentity.rows[0]?.approval_delete||custodyIdentity.rows[0]?.oauth_read||custodyIdentity.rows[0]?.financial_read||!custodyIdentity.rows[0]?.lock_update||custodyIdentity.rows[0]?.authority_update)throw Error();
for(const table of [...financeTables,'oauth_tokens','connected_accounts','connected_account_credentials','schema_migrations'])await denied42501(outside,'SELECT * FROM public.'+table);
await denied42501(outside,'SET ROLE lares_app');
if(expected==='lares_financial'){
proofAssertion='financial-column-privilege-boundary';
for(const [table,column]of[['budget_accounts','state'],['budget_windows','live_member_id'],['budget_gateway_bindings','state'],['budget_attempts','state'],['budget_gateway_grants','attempt_id']])if(!(await pool.query('SELECT has_column_privilege(current_user,$1,$2,$3) AS allowed',['public.'+table,column,'UPDATE'])).rows[0].allowed)throw Error();
for(const [table,column]of[['budget_accounts','installation_id'],['budget_windows','id'],['budget_gateway_bindings','id'],['budget_attempts','id'],['budget_gateway_grants','grant_hash'],['budget_financial_checkpoints','operation_id']])if((await pool.query('SELECT has_column_privilege(current_user,$1,$2,$3) AS allowed',['public.'+table,column,'UPDATE'])).rows[0].allowed)throw Error();
}
}
proofAssertion='application-settings-audit';
await app.query("INSERT INTO settings(key,value,updated_by) VALUES('database-role-proof','{\"phase\":\"before\"}'::jsonb,'database-role-proof')");
await app.query("UPDATE settings SET value='{\"phase\":\"after\"}'::jsonb,updated_by='database-role-proof' WHERE key='database-role-proof'");
const settings=await app.query("SELECT value FROM settings WHERE key='database-role-proof' FOR SHARE");
const audits=await app.query("SELECT id,key,old_value,new_value,changed_by FROM settings_audit WHERE key='database-role-proof' ORDER BY id");
if(settings.rows.length!==1||settings.rows[0].value.phase!=='after'||audits.rows.length!==2||audits.rows[0].id===audits.rows[1].id||audits.rows.some(row=>row.changed_by!=='database-role-proof'))throw Error();
await consoleSourceTransaction(app,db=>gateConsoleOrganisation(db,'database-role-proof-member'));
for(const roleName of ['lares_schema_owner','lares_financial'])await denied42501(app,'SET ROLE '+roleName);
for(const query of [
 'CREATE TEMP TABLE database_role_temp_probe(id integer)',
 'CREATE TABLE public.database_role_ddl_probe(id integer)',
 'ALTER TABLE public.settings ADD COLUMN database_role_ddl_probe integer',
 'TRUNCATE TABLE public.settings',
 'ALTER TABLE public.settings DISABLE TRIGGER settings_audit_trg',
 'ALTER TABLE public.budget_accounts DISABLE TRIGGER ALL',
 'SELECT * FROM public.schema_migrations',
 "INSERT INTO public.schema_migrations(filename,number,checksum,how,took_ms) VALUES('database-role-proof.sql',999,'a','applied',0)",
 'INSERT INTO public.org_member_policy(user_id,spend_cap_usd_month) VALUES($1,1)',
 'DELETE FROM public.users WHERE id=$1'
]){
if(query.includes('org_member_policy'))await denied42501(app,query,['database-role-policy-proof']);
else if(query.includes('DELETE FROM public.users'))await denied42501(app,query,['database-role-delete-proof']);
else await denied42501(app,query);
}
for(const table of financeTables){
await denied42501(app,'INSERT INTO public.'+table+' DEFAULT VALUES');
const identityColumn=table==='budget_financial_checkpoints'?'proposal_sequence':table==='budget_gateway_grants'?'attempt_id':'id';
await denied42501(app,'UPDATE public.'+table+' SET '+identityColumn+'='+identityColumn);
await denied42501(app,'DELETE FROM public.'+table);
await denied42501(app,'TRUNCATE TABLE public.'+table);
}
const surviving=await admin.query("SELECT (SELECT count(*)::int FROM org_member_policy WHERE user_id='database-role-policy-proof') AS policy,(SELECT count(*)::int FROM users WHERE id='database-role-delete-proof') AS user_row,(SELECT count(*)::int FROM budget_accounts) AS accounts");
proofAssertion='application-denials-and-postconditions';
if(surviving.rows[0].policy!==0||surviving.rows[0].user_row!==1||surviving.rows[0].accounts!==0)throw Error();
if((await app.query('SELECT current_user,session_user')).rows[0].current_user!=='lares_app'||(await app.query('SELECT current_user,session_user')).rows[0].session_user!=='lares_app')throw Error();
const account='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
proofAssertion='financial-observation-and-checkpoint';
await financial.query('INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id) VALUES($1,$2,$3,$1)',[account,'database-role-proof-install','installation']);
const locked=await financial.query('SELECT id FROM budget_accounts WHERE id=$1 FOR SHARE',[account]);if(locked.rows.length!==1)throw Error();
const database=await observeFinancialDatabase(financial);if(!database.systemIdentifier||!database.postmasterStartedAt||!database.databaseOid)throw Error();
const operation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',journal='cccccccc-cccc-4ccc-8ccc-cccccccccccc',digest='a'.repeat(64);
await financial.query('INSERT INTO budget_financial_checkpoints(operation_id,journal_id,proposal_sequence,proposal_digest) VALUES($1,$2,1,$3)',[operation,journal,digest]);
const checkpoint=await observeFinancialCheckpoint(financial);if(!checkpoint||checkpoint.operationId!==operation||checkpoint.journalId!==journal||checkpoint.sequence!==1||checkpoint.digest!==digest)throw Error();
await denied42501(financial,'UPDATE public.budget_financial_checkpoints SET proposal_sequence=2 WHERE operation_id=$1',[operation]);
let immutableCode;try{await admin.query('UPDATE public.budget_financial_checkpoints SET proposal_sequence=2 WHERE operation_id=$1',[operation]);}catch(error){immutableCode=error?.code;}if(immutableCode!=='P0001')throw Error();
const outsideOrg='outside-custody-proof-org',outsideMember='outside-custody-proof-member',outsideOther='outside-custody-proof-other',outsideAgent='outside-custody-proof-agent',incarnation='11111111-1111-4111-8111-111111111111';
proofAssertion='outside-custody-fixture-setup';
await admin.query("INSERT INTO orgs(id,display_name) VALUES($1,'Fixture')",[outsideOrg]);
await admin.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES($1,'Fixture owner',$3,'owner','active'),($2,'Fixture member',$3,'member','active')",[outsideMember,outsideOther,outsideOrg]);
await admin.query('INSERT INTO org_member_policy(user_id,allowed_capabilities) VALUES($1,NULL),($2,NULL)',[outsideMember,outsideOther]);
await admin.query("INSERT INTO agent_definitions(name,definition,hash) VALUES($1,'{\"grants\":[]}'::jsonb,'outside-proof-definition')",[outsideAgent]);
await admin.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending) VALUES($1,'127.0.0.2',$1,'owned',$2,$2,'ready',false)",[outsideAgent,incarnation]);
const grants=new PgGrantStore(),adopted=await grants.adoptAgent(outsideMember,{agentName:outsideAgent,expectedDefinitionHash:'outside-proof-definition'},{designatedOwnerMemberId:outsideMember,db:app});
await grants.updateAgentAccess(outsideMember,{agentName:outsideAgent,expectedRevision:adopted.accessRevision,grants:[{principal:{kind:'organisation',id:outsideOrg},permission:'use',expiresAt:null}]},{db:app});
const env={LARES_AGENT_NAME:outsideAgent,LARES_AGENT_INCARNATION:incarnation,AGENT_OWNER_USER_ID:outsideMember};
async function bindingFor(member,session){const nonce=createHash('sha256').update(member+':'+session).digest('base64url');return bindConsoleSession({agent:outsideAgent,incarnation,memberId:member,admissionNonce:nonce,sessionId:session},app,env);}
const binding=await bindingFor(outsideMember,'outside-custody-session'),otherBinding=await bindingFor(outsideOther,'outside-custody-other-session');
const custody=new OutsideCustodyStore(outside,Buffer.alloc(32,7)),accountId=randomUUID();
async function assertNoCustodyAccount(){const result=await admin.query('SELECT count(*)::int AS total FROM outside_custody_accounts WHERE account_id=$1',[accountId]);if(result.rows[0].total!==0)throw Error();}
try{
proofAssertion='outside-custody-stage-closed-gate-refusal';
const stageInput={accountId,operationId:randomUUID(),expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('disposable-outside-credential')};
const stagedCredential=stageInput.credential;
let stageRefused=false;
try{await custody.stage(binding,stageInput,{deadlineAtMs:Date.now()+5000});}catch(error){stageRefused=error instanceof Error&&error.message==='Outside credential change could not be confirmed';}
if(!stageRefused||stagedCredential.some(byte=>byte!==0))throw Error();
await assertNoCustodyAccount();
proofAssertion='outside-custody-apply-closed-gate-refusal';
let applyRefused=false;
try{await custody.apply(binding,{accountId,operationId:randomUUID(),expectedGeneration:1,candidateRevision:1,consentGeneration:binding.agentAccessRevision},{deadlineAtMs:Date.now()+5000});}
catch(error){applyRefused=error instanceof Error&&error.message==='Outside credential change could not be confirmed';}
if(!applyRefused)throw Error();
await assertNoCustodyAccount();
proofAssertion='outside-custody-owner-use-closed-gate-refusal';
let ownerUseCalled=false;
await custody.withCredential(binding,{accountId},async()=>{ownerUseCalled=true;}).then(()=>{throw Error('credential delivery must remain closed');},()=>{});
if(ownerUseCalled)throw Error();
await assertNoCustodyAccount();
proofAssertion='outside-custody-other-binding-closed-gate-refusal';
let otherUseCalled=false;
await custody.withCredential(otherBinding,{accountId},async()=>{otherUseCalled=true;}).then(()=>{throw Error('credential delivery must remain closed');},()=>{});
if(otherUseCalled)throw Error();
proofAssertion='outside-custody-after-policy-change-closed-gate-refusal';
await admin.query("UPDATE org_member_policy SET allowed_capabilities=ARRAY['outside-proof-revoked'] WHERE user_id=$1",[outsideMember]);
let postPolicyUseCalled=false;
await custody.withCredential(binding,{accountId},async()=>{postPolicyUseCalled=true;}).then(()=>{throw Error('credential delivery must remain closed');},()=>{});
if(postPolicyUseCalled)throw Error();
}finally{custody.close();}
console.log('database-role-proof:complete');
}catch(error){const stack=error&&typeof error==='object'&&'stack'in error&&typeof error.stack==='string'?error.stack:'';
const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[0-9A-Z]{5}$/.test(error.code)?error.code:null;
const frame=stack.split('\n').find(line=>/\[eval[0-9]*\]:[0-9]+:[0-9]+/.test(line));
const location=frame?.match(/\[eval[0-9]*\]:([0-9]+):([0-9]+)/);
const assertion=typeof proofAssertion==='string'&&/^[a-z0-9-]{1,64}$/.test(proofAssertion)?proofAssertion:'unknown';
console.log('database-role-proof:failed:'+(code?'sqlstate-'+code:'assertion-'+assertion)+(location?'-line-'+location[1]:'-location-unavailable'));process.exitCode=1;
}finally{await Promise.all([app.end(),financial.end(),outside.end(),admin.end()]);}}
void main();"""
 app_url='postgresql://lares_app:'+app_password+'@proof-db:5432/proof'
 financial_url='postgresql://lares_financial:'+financial_password+'@proof-db:5432/proof'
 outside_url='postgresql://lares_outside_custody:'+outside_custody_password+'@proof-db:5432/proof'
 admin_url='postgresql://proof:disposable-proof-only@proof-db:5432/proof'
 role_result=subprocess.run(['docker','run','--name',proof_container,'--network',name,'--workdir','/app/services/keeper',
     '-e','PROOF_ADMIN_URL='+admin_url,'-e','PROOF_APP_URL='+app_url,'-e','PROOF_FINANCIAL_URL='+financial_url,
     '-e','PROOF_APP_PASSWORD='+app_password,'-e','PROOF_FINANCIAL_PASSWORD='+financial_password,
     '-e','PROOF_OUTSIDE_CUSTODY_PASSWORD='+outside_custody_password,'-e','PROOF_OUTSIDE_CUSTODY_URL='+outside_url,
     '--entrypoint','/app/services/keeper/node_modules/.bin/tsx',image,'-e',role_probe],
     text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=120)
 output=role_result.stdout.strip()
 if role_result.returncode!=0 or output!='database-role-proof:complete':
  match=re.fullmatch(r'database-role-proof:failed:(sqlstate-[A-Z0-9]{5}(?:-line-[0-9]+)?|assertion-(?:database-role-provisioning-result|fixed-role-attributes|application-login-and-relation-privileges|financial-login-and-relation-privileges|application-finance-table-denials|financial-table-grants|outside-custody-role-boundary|financial-column-privilege-boundary|application-settings-audit|application-denials-and-postconditions|financial-observation-and-checkpoint|outside-custody-fixture-setup|outside-custody-stage-closed-gate-refusal|outside-custody-apply-closed-gate-refusal|outside-custody-owner-use-closed-gate-refusal|outside-custody-other-binding-closed-gate-refusal|outside-custody-after-policy-change-closed-gate-refusal|unknown)(?:-line-[0-9]+|-location-unavailable)?)',output)
  role_diagnostic=match.group(1) if match else 'diagnostic-unavailable'
  raise RuntimeError('actual database role proof failed: '+role_diagnostic)

 phase='postconditions'
 sql("DO $$ BEGIN IF EXISTS(SELECT 1 FROM org_member_policy WHERE user_id='database-role-policy-proof') OR NOT EXISTS(SELECT 1 FROM users WHERE id='database-role-delete-proof') OR NOT EXISTS(SELECT 1 FROM budget_financial_checkpoints WHERE operation_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' AND journal_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc' AND proposal_sequence=1 AND proposal_digest=repeat('a',64)) THEN RAISE EXCEPTION 'Database role proof postconditions changed'; END IF; END $$")
except Exception:
 failed=True
finally:
 cleanup_failed=False
 for container in (proof_container,db_container):
  try:subprocess.run(['docker','rm','--force',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
  except Exception:cleanup_failed=True
 try:
  if subprocess.run(['docker','network','rm',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20).returncode!=0:cleanup_failed=True
 except Exception:cleanup_failed=True
 if cleanup_failed and not failed:failed=True;phase='cleanup'

if failed:
 print('database-privileges-image-proof:failed:'+phase+(':'+role_diagnostic if phase=='actual-roles' and role_diagnostic else ''))
 raise SystemExit(1)
print('database-privileges-image-proof:complete')
