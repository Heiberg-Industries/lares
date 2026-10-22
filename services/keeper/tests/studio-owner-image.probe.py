"""CI-only owner-capture proof against the final creative image and disposable PostgreSQL."""
import pathlib,subprocess,sys,uuid,time

repo=pathlib.Path(__file__).resolve().parents[3]
name='lares-studio-owner-proof-'+uuid.uuid4().hex[:10]
app_container=name+'-app'
image=sys.argv[1]
phase='setup'
failed=False

def cmd(*args,input=None,timeout=30):
 try:return subprocess.check_output(args,input=input,text=True,stderr=subprocess.STDOUT,timeout=timeout).strip()
 except Exception:raise RuntimeError('disposable studio proof command failed') from None

def sql(body):
 return cmd('docker','exec','-i',name+'-db','psql','-X','-v','ON_ERROR_STOP=1','-U','proof','-d','proof',input=body)

try:
 phase='database'
 cmd('docker','network','create',name)
 cmd('docker','run','-d','--name',name+'-db','--network',name,'--network-alias','proof-db',
     '-e','POSTGRES_USER=proof','-e','POSTGRES_PASSWORD=disposable-proof-only','-e','POSTGRES_DB=proof',
     'pgvector/pgvector:pg16')
 for _ in range(60):
  try:
   cmd('docker','exec','-e','PGPASSWORD=disposable-proof-only',name+'-db','psql','-h','127.0.0.1',
       '-U','proof','-d','proof','-Atc','SELECT 1',timeout=5)
   break
  except Exception:time.sleep(.5)
 else:raise RuntimeError('disposable database did not become ready')

 phase='migrations'
 applied=[]
 migrations=sorted((repo/'services/box/sql').glob('[0-9][0-9][0-9]_*.sql'))
 for migration in migrations:
  if migration.name=='028_studio_ownership.sql':
   # Recreate one row written by the former store before the ownership migration runs.
   sql("CREATE TABLE studio_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brief text NOT NULL, consensus text NOT NULL, spread jsonb NOT NULL, picks jsonb, principal text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()); INSERT INTO studio_runs(brief,consensus,spread,principal) VALUES('legacy fixture brief','legacy fixture grounding','[{\"title\":\"legacy fixture\"}]'::jsonb,'U_legacy_fixture')")
  applied.append(migration.name)
  sql(migration.read_text())
 on_disk={p.name for p in (repo/'services/box/sql').iterdir() if p.name[:3].isdigit() and p.name.endswith('.sql')}
 if set(applied)!=on_disk or '001_baseline.sql' not in applied:raise RuntimeError('numbered migration loop incomplete')
 sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM studio_runs WHERE principal='U_legacy_fixture' AND owner_member_id IS NULL AND brief='legacy fixture brief' AND consensus='legacy fixture grounding' AND spread='[{\"title\":\"legacy fixture\"}]'::jsonb) THEN RAISE EXCEPTION 'legacy studio row changed'; END IF; END $$")

 phase='fixture'
 sql("INSERT INTO orgs(id,display_name) VALUES('studio-fixture-org','Studio fixture'); INSERT INTO users(id,display_name,primary_email,org_id,org_role,status) VALUES('studio-fixture-owner','Fixture owner','owner@example.invalid','studio-fixture-org','owner','active'),('studio-fixture-other','Fixture member','other@example.invalid','studio-fixture-org','member','active'); INSERT INTO agent_definitions(name,definition,hash,status) VALUES('studio-fixture','{\"name\":\"studio-fixture\",\"doors\":[{\"kind\":\"slack\",\"enabled\":true}]}',repeat('a',64),'valid'); INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending,applied_definition) VALUES('studio-fixture','127.0.0.9','studio-fixture','owned','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ready',false,'{\"name\":\"studio-fixture\",\"doors\":[{\"kind\":\"slack\",\"enabled\":true}]}'); INSERT INTO agent_access(agent_name,owner_member_id,organisation_id) VALUES('studio-fixture','studio-fixture-owner','studio-fixture-org'); INSERT INTO agent_doors(agent,kind,enabled) VALUES('studio-fixture','slack',true); INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,principal,org,claimed_at,applied_revision,applied_connection) VALUES('studio-fixture','slack','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',' owner@example.invalid ','U_fixture','studio-fixture-org','2026-10-22T12:00:00Z','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',jsonb_build_object('kind','slack','principal','U_fixture','revision','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','owner_email',' owner@example.invalid ','org','studio-fixture-org','mailbox',NULL))")
 # PostgreSQL requires UPDATE on one column per FOR SHARE relation; keep those grants column-scoped.
 sql("CREATE ROLE studio_probe_app LOGIN PASSWORD 'disposable-studio-proof-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO studio_probe_app; GRANT SELECT ON TABLE users,orgs,agent_resources,agent_definitions,agent_doors,agent_door_connections TO studio_probe_app; GRANT UPDATE(display_name) ON TABLE users,orgs TO studio_probe_app; GRANT UPDATE(updated_at) ON TABLE agent_resources,agent_doors TO studio_probe_app; GRANT UPDATE(checked_at) ON TABLE agent_definitions TO studio_probe_app; GRANT UPDATE(webhook_set_at) ON TABLE agent_door_connections TO studio_probe_app; GRANT SELECT,INSERT,DELETE ON TABLE studio_runs TO studio_probe_app; GRANT UPDATE(brief,consensus,spread,picks,principal) ON TABLE studio_runs TO studio_probe_app")

 phase='production-store'
 store_probe="""import{Pool}from'pg';
import{makeStudioStore,ensureStudioTables}from'/app/services/creative/lib/studio/store.ts';
const app=new Pool({connectionString:process.env.STUDIO_PROOF_APP_URL,max:1,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:8000});
const admin=new Pool({connectionString:process.env.STUDIO_PROOF_ADMIN_URL,max:1,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:8000});
const env={LARES_AGENT_NAME:'studio-fixture',LARES_AGENT_INCARNATION:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',LARES_SLACK_PRINCIPAL:'U_fixture',LARES_SLACK_CLAIM_REVISION:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
const approver={authenticator:'slack-webhook',userId:'U_fixture'};
const run={brief:'fixed studio proof brief',consensus:'fixed studio proof grounding',spread:[{id:'fixture-idea',lens:'fixture',title:'Fixture idea',body:'Fixed fixture content',oddsTypical:0.2,coherence:0.9,novelty:0.8,relevance:0.7,kind:'outlier',rationale:'Fixture'}]};
const owner='studio-fixture-owner',legacyPrincipal='U_legacy_fixture';
async function main(){try{
const roles=await app.query(`SELECT current_user,session_user,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolinherit,r.rolreplication,r.rolbypassrls,
 (SELECT count(*) FROM pg_auth_members m WHERE m.member=r.oid)::int AS memberships,
 has_schema_privilege(current_user,'public','USAGE') AS schema_usage,has_schema_privilege(current_user,'public','CREATE') AS schema_create,
 has_column_privilege(current_user,'studio_runs','brief','UPDATE') AS run_content_update,
 has_column_privilege(current_user,'studio_runs','owner_member_id','UPDATE') AS run_owner_update,
 has_table_privilege(current_user,'studio_runs','SELECT') AS run_read,has_table_privilege(current_user,'studio_runs','INSERT') AS run_insert,has_table_privilege(current_user,'studio_runs','DELETE') AS run_delete,
 has_table_privilege(current_user,'users','SELECT') AS users_read,has_table_privilege(current_user,'users','UPDATE') AS users_update,
 has_table_privilege(current_user,'orgs','SELECT') AS orgs_read,has_table_privilege(current_user,'orgs','UPDATE') AS orgs_update,
 has_table_privilege(current_user,'agent_resources','SELECT') AS resources_read,has_table_privilege(current_user,'agent_resources','UPDATE') AS resources_update,
 has_table_privilege(current_user,'agent_definitions','SELECT') AS definitions_read,has_table_privilege(current_user,'agent_definitions','UPDATE') AS definitions_update,
 has_table_privilege(current_user,'agent_doors','SELECT') AS doors_read,has_table_privilege(current_user,'agent_doors','UPDATE') AS doors_update,
 has_table_privilege(current_user,'agent_door_connections','SELECT') AS claims_read,has_table_privilege(current_user,'agent_door_connections','UPDATE') AS claims_update
 FROM pg_roles r WHERE r.rolname=current_user`);
const x=roles.rows[0];if(!x||x.current_user!=='studio_probe_app'||x.session_user!=='studio_probe_app'||x.rolsuper||x.rolcreatedb||x.rolcreaterole||x.rolinherit||x.rolreplication||x.rolbypassrls||x.memberships!==0||!x.schema_usage||x.schema_create||!x.run_read||!x.run_insert||!x.run_delete||!x.run_content_update||x.run_owner_update)throw Error();
for(const table of ['users','orgs','resources','definitions','doors','claims'])if(!x[table+'_read']||x[table+'_update'])throw Error();
for(const [table,column] of [['users','display_name'],['orgs','display_name'],['agent_resources','updated_at'],['agent_definitions','checked_at'],['agent_doors','updated_at'],['agent_door_connections','webhook_set_at']])if(!(await app.query('SELECT has_column_privilege(current_user,$1,$2,$3) AS allowed',['public.'+table,column,'UPDATE'])).rows[0].allowed)throw Error();
for(const table of ['users','orgs','agent_resources','agent_definitions','agent_doors','agent_door_connections'])for(const column of ({users:['id','primary_email','status','org_id','org_role'],orgs:['id'],agent_resources:['name','ownership','ownership_token','runtime_control_token','state','pending','applied_definition'],agent_definitions:['definition','hash','status'],agent_doors:['enabled','settings'],agent_door_connections:['principal','revision','applied_revision','owner_email','org','mailbox','applied_connection','expires_at']}[table]))if(await app.query('SELECT has_column_privilege(current_user,$1,$2,$3) AS allowed',['public.'+table,column,'UPDATE']).then(r=>r.rows[0].allowed))throw Error();
await ensureStudioTables(app);
const store=makeStudioStore(app,env),capture=await store.captureOwner(approver),saved=await store.recordRun(run,capture);
const savedRow=await app.query('SELECT owner_member_id,principal,brief FROM studio_runs WHERE id=$1',[saved.id]);if(savedRow.rows.length!==1||savedRow.rows[0].owner_member_id!==owner||savedRow.rows[0].principal!=='U_fixture'||savedRow.rows[0].brief!==run.brief)throw Error();
await app.query("UPDATE studio_runs SET picks='[]'::jsonb WHERE id=$1",[saved.id]);
const rowsBeforeReplay=(await app.query('SELECT count(*)::int AS n FROM studio_runs')).rows[0].n;let replayDenied=false;try{await store.recordRun(run,capture);}catch{replayDenied=true;}if(!replayDenied||(await app.query('SELECT count(*)::int AS n FROM studio_runs')).rows[0].n!==rowsBeforeReplay)throw Error();
async function stale(change,restore){const before=(await app.query('SELECT count(*)::int AS n FROM studio_runs')).rows[0].n;const staleCapture=await store.captureOwner(approver);try{await change();let refused=false;try{await store.recordRun(run,staleCapture);}catch{refused=true;}if(!refused||(await app.query('SELECT count(*)::int AS n FROM studio_runs')).rows[0].n!==before)throw Error();}finally{await restore();}}
await stale(()=>admin.query("UPDATE agent_door_connections SET claimed_at='2026-10-22T12:01:00Z' WHERE agent='studio-fixture' AND kind='slack'"),()=>admin.query("UPDATE agent_door_connections SET claimed_at='2026-10-22T12:00:00Z' WHERE agent='studio-fixture' AND kind='slack'"));
await stale(()=>admin.query("UPDATE agent_door_connections SET revision='cccccccc-cccc-4ccc-8ccc-cccccccccccc',applied_revision='cccccccc-cccc-4ccc-8ccc-cccccccccccc' WHERE agent='studio-fixture' AND kind='slack'"),()=>admin.query("UPDATE agent_door_connections SET revision='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',applied_revision='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' WHERE agent='studio-fixture' AND kind='slack'"));
await stale(()=>admin.query("UPDATE users SET primary_email='changed@example.invalid' WHERE id=$1",[owner]),()=>admin.query("UPDATE users SET primary_email='owner@example.invalid' WHERE id=$1",[owner]));
let ownerlessDenied=false;try{await app.query("INSERT INTO studio_runs(brief,consensus,spread,principal) VALUES('fixture unowned','fixture grounding','[]'::jsonb,'U_fixture')");}catch(e){ownerlessDenied=e?.code==='23514';}if(!ownerlessDenied)throw Error();
let reassignmentDenied=false;try{await admin.query('UPDATE studio_runs SET owner_member_id=$1 WHERE id=$2',["studio-fixture-other",saved.id]);}catch(e){reassignmentDenied=e?.code==='23514';}if(!reassignmentDenied)throw Error();
for(const ddl of ['CREATE TABLE public.studio_owner_probe_ddl(id integer)','ALTER TABLE public.studio_runs ADD COLUMN studio_owner_probe_ddl integer','TRUNCATE TABLE public.studio_runs',...['users','orgs','agent_resources','agent_definitions','agent_doors','agent_door_connections'].flatMap(t=>['ALTER TABLE public.'+t+' ADD COLUMN studio_owner_probe_ddl integer','TRUNCATE TABLE public.'+t])]){let denied=false;try{await app.query(ddl);}catch(e){denied=e?.code==='42501';}if(!denied)throw Error();}
const legacy=await app.query("SELECT count(*)::int AS n FROM studio_runs WHERE principal=$1 AND owner_member_id IS NULL AND brief='legacy fixture brief'",[legacyPrincipal]);if(legacy.rows[0].n!==1)throw Error();
console.log('studio-owner-proof:complete');
}catch{console.log('studio-owner-proof:failed');process.exitCode=1;}finally{await Promise.all([app.end(),admin.end()]);}}
void main();"""
 app_url='postgresql://studio_probe_app:disposable-studio-proof-only@proof-db:5432/proof'
 admin_url='postgresql://proof:disposable-proof-only@proof-db:5432/proof'
 output=cmd('docker','run','--name',app_container,'--network',name,'--workdir','/app/services/creative',
     '-e','STUDIO_PROOF_APP_URL='+app_url,'-e','STUDIO_PROOF_ADMIN_URL='+admin_url,
     '--entrypoint','/app/services/creative/node_modules/.bin/tsx',image,'-e',store_probe,timeout=120)
 if output!='studio-owner-proof:complete':raise RuntimeError('production store ownership proof failed')

 phase='migration-reapply'
 sql((repo/'services/box/sql/028_studio_ownership.sql').read_text())
 sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM studio_runs WHERE principal='U_legacy_fixture' AND owner_member_id IS NULL AND brief='legacy fixture brief' AND consensus='legacy fixture grounding' AND spread='[{\"title\":\"legacy fixture\"}]'::jsonb) OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='studio_runs_owner_guard' AND NOT tgisinternal) THEN RAISE EXCEPTION 'studio owner migration reapply changed legacy row or guard'; END IF; END $$")
except Exception:
 failed=True
finally:
 cleanup_failed=False
 for container in (app_container,name+'-db'):
  try:subprocess.run(['docker','rm','-f',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
  except Exception:cleanup_failed=True
 try:
  if subprocess.run(['docker','network','rm',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20).returncode!=0:cleanup_failed=True
 except Exception:cleanup_failed=True
 if cleanup_failed and not failed:failed=True;phase='cleanup'

if failed:
 print('studio-owner-image-proof:failed:'+phase)
 raise SystemExit(1)
print('studio-owner-image-proof:complete')
