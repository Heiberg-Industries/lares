"""Disposable CI-image runtime proof. No production data or provider credentials."""
import subprocess,json,pathlib,tempfile,time,urllib.request,http.server,threading,os,shutil,sys,uuid,secrets,importlib.util
repo=pathlib.Path(__file__).resolve().parents[3]
root=pathlib.Path(tempfile.mkdtemp(prefix='lares-image-proof-'));root.chmod(0o755)
custody_spec=importlib.util.spec_from_file_location('maintenance_custody',repo/'services/box/ops/maintenance-custody.py')
custody=importlib.util.module_from_spec(custody_spec);sys.modules[custody_spec.name]=custody;custody_spec.loader.exec_module(custody)
runtime_secrets=pathlib.Path(tempfile.mkdtemp(prefix='lares-runtime-secrets-'));runtime_secrets.chmod(0o755)
offline_secrets=pathlib.Path(tempfile.mkdtemp(prefix='lares-offline-secrets-'));offline_secrets.chmod(0o700)
name='lares-image-proof-'+uuid.uuid4().hex[:10];image=sys.argv[1]
operator_password=secrets.token_urlsafe(32)
def cmd(*a,input=None,timeout=120):
 try:return subprocess.check_output(a,input=input,text=True,stderr=subprocess.STDOUT,timeout=timeout).strip()
 except subprocess.CalledProcessError as e:print(e.output,flush=True);raise
def sql(body,database='proof'):return cmd('docker','exec','-i',name+'-db','psql','-X','-v','ON_ERROR_STOP=1','-U','proof','-d',database,input=body)
def wait_healthy():
 # Docker can allocate a new ephemeral published port on restart.
 port=cmd('docker','port',name+'-runtime','3000').rsplit(':',1)[1]
 host='http://127.0.0.1:'+port
 last_error=None
 for i in range(120):
  try:
   with urllib.request.urlopen(host+'/eve/v1/health',timeout=2) as r:
    assert r.status==200
    return
  except Exception as e:
   last_error=e
   if cmd('docker','inspect','--format','{{.State.Running}}',name+'-runtime')!='true':raise RuntimeError('Container exited before health') from e
   time.sleep(.5)
 raise RuntimeError(f'Health failed at {host}: {last_error}')
def wait_quiet(what):
 # : a turn's client returns at session.waiting, but the runtime still has that turn's finishing
 # work to do. "Finished" = no workflow step running and no queue job locked, twice in a row (a job
 # between two steps is unlocked for milliseconds; two looks half a second apart do not both hit that).
 q="SELECT (SELECT count(*) FROM workflow.workflow_steps WHERE status='running')+(SELECT count(*) FROM graphile_worker.jobs WHERE locked_at IS NOT NULL)"
 calm=0
 for i in range(60):
  calm=calm+1 if cmd('docker','exec',name+'-db','psql','-X','-U','proof','-d','workflowproof','-Atc',q)=='0' else 0
  if calm==2:return
  time.sleep(.5)
 raise RuntimeError('Workflow work never went quiet '+what)
requests=[]
app_password=secrets.token_urlsafe(32)
financial_password=secrets.token_urlsafe(32)
workflow_provisioner_password=secrets.token_urlsafe(32)
workflow_password=secrets.token_urlsafe(32)
class Model(http.server.BaseHTTPRequestHandler):
 # : while `hold` is an Event, every reply waits on it and `held` says a request has arrived.
 hold=None;held=threading.Event()
 def log_message(self,*a):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['content-length'])));requests.append(body)
  gate=Model.hold
  if gate is not None:Model.held.set();gate.wait(300)
  content='CI_IMAGE_TURN_OK'
  events=[('message_start',{'type':'message_start','message':{'id':'msg_fixture','type':'message','role':'assistant','model':body['model'],'content':[],'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':12,'output_tokens':0}}}),('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':content}}),('content_block_stop',{'type':'content_block_stop','index':0}),('message_delta',{'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':4}}),('message_stop',{'type':'message_stop'})]
  if body.get('stream'):
   result=''.join('event: '+kind+'\ndata: '+json.dumps(data)+'\n\n' for kind,data in events);kind='text/event-stream'
  else:result=json.dumps({'id':'msg_fixture','type':'message','role':'assistant','model':body['model'],'content':[{'type':'text','text':content}],'stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':12,'output_tokens':4}});kind='application/json'
  try:self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(result.encode())));self.end_headers();self.wfile.write(result.encode())
  except OSError:pass # a held reply's caller died with the restarted process
server=http.server.ThreadingHTTPServer(('0.0.0.0',0),Model);threading.Thread(target=server.serve_forever,daemon=True).start()
try:
 (root/'definition').mkdir();(root/'blobs').mkdir();(root/'blobs').chmod(0o777)
 d=json.loads((repo/'packages/agent-kit/templates/chief-of-staff/definition.json').read_text());d.update(name='canary',role='chief-of-staff',grants=[{'capability':'echo','scope':'write-with-confirm'}],autonomy={'echo':'gated'},skills=[],channels=[],duties='duties.md')
 (root/'definition/agent.json').write_text(json.dumps(d));(root/'definition/duties.md').write_text('UNIQUE_CI_MOUNTED_DUTIES');(root/'definition/voice.md').write_text('Be concise.')
 for n in ['gateway','route','control']:
  path=runtime_secrets/n;path.write_text('disposable-fixture-only');path.chmod(0o600)
 for n,value in [('app-password',app_password),('workflow-password',workflow_password)]:
  path=runtime_secrets/n;path.write_text(value);path.chmod(0o600)
 for n,value in [('operator-password',operator_password),('financial-password',financial_password),('workflow-provisioner-password',workflow_provisioner_password)]:
  path=offline_secrets/n;path.write_text(value);path.chmod(0o600)
 cmd('docker','run','--rm','--platform','linux/amd64','--user','0:0','--mount',f'type=bind,src={runtime_secrets},dst=/runtime-secrets','--entrypoint','chown',image,'10001:10001','/runtime-secrets/gateway','/runtime-secrets/route','/runtime-secrets/control','/runtime-secrets/app-password','/runtime-secrets/workflow-password')
 cmd('docker','network','create',name)
 # initdb defaults host entries to trust; the image entrypoint appends its configured rule after
 # those loopback entries. Set host authentication during initdb so loopback and network clients
 # both exercise password checks.
 cmd('docker','run','-d','--name',name+'-db','--network',name,'--network-alias','proof-db','-e','POSTGRES_USER=proof','-e','POSTGRES_PASSWORD='+operator_password,'-e','POSTGRES_DB=proof','-e','POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256','-e','POSTGRES_HOST_AUTH_METHOD=scram-sha-256','pgvector/pgvector:pg16')
 for i in range(60):
  # The image's temporary initialization server accepts Unix-socket connections
  # before POSTGRES_DB exists. Wait for the final TCP server and a real query.
  try:cmd('docker','exec','-e','PGPASSWORD='+operator_password,name+'-db','psql','-h','127.0.0.1','-U','proof','-d','proof','-Atc','SELECT 1');break
  except subprocess.CalledProcessError:time.sleep(.5)
 else:raise RuntimeError('Disposable PostgreSQL database did not become ready')
 # The box schema is one baseline file today and any later numbered file after it. Apply every
 # file in number order, from an empty database, exactly as `migrate` does on a fresh install.
 applied=[]
 for p in sorted((repo/'services/box/sql').glob('[0-9][0-9][0-9]_*.sql')):
  applied.append(p.name);sql(p.read_text())
 # standing_facts is box/sql/002_standing_facts.sql, so a fresh install gets it from this loop alone.
 # Independent of the glob above: a directory listing plus a plain string check, so a future
 # glob-pattern mistake fails the image build instead of silently skipping a file.
 on_disk={q.name for q in (repo/'services/box/sql').iterdir() if q.name[:3].isdigit() and q.name.endswith('.sql')}
 assert set(applied)==on_disk and '001_baseline.sql' in applied,f'Probe applied {sorted(applied)} but disk has {sorted(on_disk)} — a box migration was silently skipped'
 # Apply the production privilege helper to the exact migrated engine inventory. Its source is
 # mounted read-only into the existing crypto directory in this neutral role image.
 engine_privileges=root/'prepare-engine-privileges.mts'
 engine_privileges.write_text("import {readFileSync} from 'node:fs';\nimport {Pool} from 'pg';\nimport {provisionEngineDatabasePrivileges} from '/app/services/box/lib/database-privileges.ts';\n"
   "const pool=new Pool({host:'proof-db',database:'proof',user:'proof',password:readFileSync('/offline-secrets/operator-password','utf8'),max:1});try{const client=await pool.connect();try{const result=await provisionEngineDatabasePrivileges(client,{expectedDatabase:'proof',passwords:{application:readFileSync('/secrets/app-password'),financial:readFileSync('/offline-secrets/financial-password'),outsideCustody:Buffer.from('outside-custody-proof-password-123456')}});if(!['applied','verified'].includes(result.status))throw Error();}finally{client.release();}console.log('engine-privileges-ready');}finally{await pool.end();}\n")
 helper_mount=['--mount',f'type=bind,src={repo}/services/box/lib/database-privileges.ts,dst=/app/services/box/lib/database-privileges.ts,readonly']
 privilege_run=['docker','run','--rm','--user','0:0','--network',name,'--mount',f'type=bind,src={runtime_secrets},dst=/secrets,readonly','--mount',f'type=bind,src={offline_secrets},dst=/offline-secrets,readonly','--mount',f'type=bind,src={engine_privileges},dst=/app/services/chief-of-staff/prepare-engine-privileges.mts,readonly']+helper_mount+['--workdir','/app/services/chief-of-staff','--entrypoint','/app/services/chief-of-staff/node_modules/.bin/tsx',image,'/app/services/chief-of-staff/prepare-engine-privileges.mts']
 assert cmd(*privilege_run)=='engine-privileges-ready','Production engine database privileges were not prepared'
 # Build the pinned workflow template offline as the narrow provisioner, with its fixed owner
 # role active for setupDatabase. The online worker login receives ACLs only after setup.
 sql("CREATE ROLE lares_workflow_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE lares_workflow_provisioner LOGIN NOINHERIT CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"+workflow_provisioner_password+"'; CREATE ROLE lares_workflow LOGIN NOINHERIT NOCREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"+workflow_password+"'; GRANT lares_workflow_owner TO lares_workflow_provisioner; CREATE DATABASE empty_workflow OWNER lares_workflow_owner")
 workflow_setup=root/'prepare-workflow-template.mts'
 workflow_setup.write_text("import {readFileSync} from 'node:fs';\nimport {Pool} from 'pg';\nimport {setupDatabase} from '@workflow/world-postgres/cli';\n"
   "process.env.PGPASSWORD=readFileSync('/offline-secrets/workflow-provisioner-password','utf8');process.env.PGOPTIONS='-c role=lares_workflow_owner';process.env.WORKFLOW_POSTGRES_URL='postgres://lares_workflow_provisioner@proof-db:5432/empty_workflow';\n"
   "const pool=new Pool({connectionString:process.env.WORKFLOW_POSTGRES_URL,max:1});try{const id=await pool.query('SELECT current_user,session_user,current_database()');if(id.rows[0]?.current_user!=='lares_workflow_owner'||id.rows[0]?.session_user!=='lares_workflow_provisioner'||id.rows[0]?.current_database!=='empty_workflow')throw Error();}finally{await pool.end();}await setupDatabase();\n")
 workflow_helper_mount=['--mount',f'type=bind,src={repo}/services/box/lib/workflow-database-privileges.ts,dst=/app/services/box/lib/workflow-database-privileges.ts,readonly']
 workflow_run=['docker','run','--rm','--user','0:0','--network',name,'--mount',f'type=bind,src={runtime_secrets},dst=/secrets,readonly','--mount',f'type=bind,src={offline_secrets},dst=/offline-secrets,readonly','--mount',f'type=bind,src={workflow_setup},dst=/app/services/chief-of-staff/prepare-workflow-template.mts,readonly']+workflow_helper_mount+['--workdir','/app/services/chief-of-staff','--entrypoint','/app/services/chief-of-staff/node_modules/.bin/tsx',image,'/app/services/chief-of-staff/prepare-workflow-template.mts']
 cmd(*workflow_run)
 workflow_acl_setup=root/'prepare-workflow-template-acls.mts'
 workflow_acl_setup.write_text("import {readFileSync} from 'node:fs';\nimport {Pool} from 'pg';\nimport {applyWorkflowRuntimePrivileges,verifyWorkflowRuntimePrivileges} from '/app/services/box/lib/workflow-database-privileges.ts';\n"
   "process.env.PGPASSWORD=readFileSync('/offline-secrets/workflow-provisioner-password','utf8');process.env.PGOPTIONS='-c role=lares_workflow_owner';process.env.WORKFLOW_POSTGRES_URL='postgres://lares_workflow_provisioner@proof-db:5432/empty_workflow';\n"
   "const ownerPool=new Pool({connectionString:process.env.WORKFLOW_POSTGRES_URL,max:1});try{const client=await ownerPool.connect();try{const id=await client.query('SELECT current_user,session_user');if(id.rows[0]?.current_user!=='lares_workflow_owner'||id.rows[0]?.session_user!=='lares_workflow_provisioner')throw Error();await applyWorkflowRuntimePrivileges(client);await client.query('RESET ROLE');}finally{client.release();}}finally{await ownerPool.end();}delete process.env.PGOPTIONS;const runtime=new Pool({host:'proof-db',database:'empty_workflow',user:'lares_workflow',password:readFileSync('/secrets/workflow-password','utf8'),max:1});try{const client=await runtime.connect();try{const id=await client.query('SELECT current_user,session_user');if(id.rows[0]?.current_user!=='lares_workflow'||id.rows[0]?.session_user!=='lares_workflow')throw Error();await verifyWorkflowRuntimePrivileges(client);const empty=await client.query(\"SELECT (SELECT count(*)::int FROM workflow.workflow_event_slots) AS event_slots,(SELECT count(*)::int FROM workflow.workflow_events) AS events,(SELECT count(*)::int FROM workflow.workflow_hooks) AS hooks,(SELECT count(*)::int FROM workflow.workflow_runs) AS runs,(SELECT count(*)::int FROM workflow.workflow_steps) AS steps,(SELECT count(*)::int FROM workflow.workflow_stream_chunks) AS stream_chunks,(SELECT count(*)::int FROM workflow.workflow_waits) AS waits,(SELECT count(*)::int FROM graphile_worker._private_job_queues) AS queues,(SELECT count(*)::int FROM graphile_worker._private_jobs) AS jobs,(SELECT count(*)::int FROM graphile_worker._private_known_crontabs) AS crontabs,(SELECT count(*)::int FROM graphile_worker._private_tasks) AS tasks\");if(Object.values(empty.rows[0]).some(value=>value!==0))throw Error();}finally{client.release();}}finally{await runtime.end();}console.log('workflow-template-ready');\n")
 workflow_acl_run=['docker','run','--rm','--user','0:0','--network',name,'--mount',f'type=bind,src={runtime_secrets},dst=/secrets,readonly','--mount',f'type=bind,src={offline_secrets},dst=/offline-secrets,readonly','--mount',f'type=bind,src={workflow_acl_setup},dst=/app/services/chief-of-staff/prepare-workflow-template-acls.mts,readonly']+workflow_helper_mount+['--workdir','/app/services/chief-of-staff','--entrypoint','/app/services/chief-of-staff/node_modules/.bin/tsx',image,'/app/services/chief-of-staff/prepare-workflow-template-acls.mts']
 assert cmd(*workflow_acl_run).splitlines()[-1]=='workflow-template-ready','Pinned workflow template ACLs were not prepared'
 assert cmd('docker','exec',name+'-db','psql','-X','-v','ON_ERROR_STOP=1','-U','proof','-d','proof','-c','ALTER DATABASE empty_workflow IS_TEMPLATE true')
 provisioner_password=workflow_provisioner_password
 clone_result=subprocess.run(['docker','exec','-e','PGPASSWORD='+provisioner_password,name+'-db','psql','-h','127.0.0.1','-U','lares_workflow_provisioner','-d','postgres','-v','ON_ERROR_STOP=1','-c','CREATE DATABASE workflowproof OWNER lares_workflow_owner TEMPLATE empty_workflow'],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
 assert clone_result.returncode==0,'Provisioner could not clone the verified workflow template'
 workflow_clone_setup=root/'prepare-workflow-clone.mts'
 workflow_clone_setup.write_text("import {readFileSync} from 'node:fs';\nimport {Pool} from 'pg';\nimport {applyWorkflowRuntimePrivileges,verifyWorkflowRuntimePrivileges} from '/app/services/box/lib/workflow-database-privileges.ts';\n"
   "process.env.PGPASSWORD=readFileSync('/offline-secrets/workflow-provisioner-password','utf8');process.env.PGOPTIONS='-c role=lares_workflow_owner';const provisioner=new Pool({connectionString:'postgres://lares_workflow_provisioner@proof-db:5432/workflowproof',max:1});try{const client=await provisioner.connect();try{const id=await client.query('SELECT current_user,session_user,current_database()');if(id.rows[0]?.current_user!=='lares_workflow_owner'||id.rows[0]?.session_user!=='lares_workflow_provisioner'||id.rows[0]?.current_database!=='workflowproof')throw Error();await applyWorkflowRuntimePrivileges(client);}finally{client.release();}}finally{await provisioner.end();}delete process.env.PGOPTIONS;const runtime=new Pool({host:'proof-db',database:'workflowproof',user:'lares_workflow',password:readFileSync('/secrets/workflow-password','utf8'),max:1});try{const client=await runtime.connect();try{const id=await client.query('SELECT current_user,session_user');if(id.rows[0]?.current_user!=='lares_workflow'||id.rows[0]?.session_user!=='lares_workflow')throw Error();await verifyWorkflowRuntimePrivileges(client);}finally{client.release();}}finally{await runtime.end();}console.log('workflow-clone-ready');\n")
 workflow_clone_run=['docker','run','--rm','--user','0:0','--network',name,'--mount',f'type=bind,src={runtime_secrets},dst=/secrets,readonly','--mount',f'type=bind,src={offline_secrets},dst=/offline-secrets,readonly','--mount',f'type=bind,src={workflow_clone_setup},dst=/app/services/chief-of-staff/prepare-workflow-clone.mts,readonly']+workflow_helper_mount+['--workdir','/app/services/chief-of-staff','--entrypoint','/app/services/chief-of-staff/node_modules/.bin/tsx',image,'/app/services/chief-of-staff/prepare-workflow-clone.mts']
 assert cmd(*workflow_clone_run).splitlines()[-1]=='workflow-clone-ready','Cloned workflow database privileges or runtime identity were not verified'
 workflow_auth_probe="""import{Client}from'pg';import{readFileSync}from'node:fs';
async function check(passwordFile,expectedFailure){const client=new Client({host:'proof-db',port:5432,database:'workflowproof',user:'lares_workflow',password:readFileSync(passwordFile,'utf8'),connectionTimeoutMillis:3000});try{await client.connect();if(expectedFailure)throw new Error('invalid credential unexpectedly connected');const result=await client.query('SELECT current_user AS user');if(result.rows[0]?.user!=='lares_workflow')throw new Error('valid credential selected an unexpected identity');console.log('workflow-valid-credential:connected');}catch(error){if(expectedFailure&&error?.code==='28P01'){console.log('workflow-invalid-credential:28P01');return;}console.log('workflow-credential-probe:unexpected-'+String(error?.code??'no-code'));process.exitCode=1;}finally{await client.end().catch(()=>{});}}
await check('/secrets/workflow-password',false);await check('/secrets/app-password',true);
"""
 workflow_auth=subprocess.run(['docker','run','--rm','--platform','linux/amd64','--network',name,'--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges:true','--mount',f'type=bind,src={runtime_secrets},dst=/secrets,readonly','--workdir','/app/services/chief-of-staff','--entrypoint','node',image,'--input-type=module','-e',workflow_auth_probe],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=20)
 assert workflow_auth.returncode==0 and workflow_auth.stdout.strip().splitlines()[-2:]==['workflow-valid-credential:connected','workflow-invalid-credential:28P01'],'Workflow network-path credentials did not produce the expected PostgreSQL identities'
 memory_access_probe = """import{Pool}from'pg';import{readFileSync}from'node:fs';
import{ensureDreamTables,makeDreamStore}from'/app/services/chief-of-staff/lib/dream/store.ts';
import{ensureObligationsTable,upsertSeen,dismissedThreads,dismissObligation}from'/app/services/chief-of-staff/lib/obligations-store.ts';
import{makePgSeenStore}from'/app/services/chief-of-staff/lib/karakeep.ts';
import{ensureRouteTables,makeRouteStore}from'/app/services/chief-of-staff/lib/route-store.ts';
const databaseUrl=new URL(process.env.MEMORY_PROOF_DATABASE_URL);
const db=new Pool({host:databaseUrl.hostname,port:Number(databaseUrl.port||5432),database:decodeURIComponent(databaseUrl.pathname.slice(1)),user:decodeURIComponent(databaseUrl.username),password:readFileSync('/secrets/app-password','utf8'),max:1,connectionTimeoutMillis:3000});
async function main(){let stage='role privileges';try{
const role=await db.query(`SELECT current_user,session_user,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolinherit,r.rolreplication,r.rolbypassrls,
 (SELECT count(*) FROM pg_auth_members m WHERE m.member=r.oid)::int AS memberships,
 has_schema_privilege(current_user,'public','USAGE') AS schema_usage,has_schema_privilege(current_user,'public','CREATE') AS schema_create,
 has_table_privilege(current_user,'public.dream_observations','SELECT') AS observation_read,
 has_table_privilege(current_user,'public.dream_observations','INSERT') AS observation_insert,
 has_table_privilege(current_user,'public.dream_observations','UPDATE') AS observation_update,
 has_table_privilege(current_user,'public.dream_observations','DELETE') AS observation_delete,
 has_table_privilege(current_user,'public.dream_observations','TRUNCATE') AS observation_truncate,
 has_table_privilege(current_user,'public.dream_preferences','SELECT') AS preference_read,
 has_table_privilege(current_user,'public.dream_preferences','INSERT') AS preference_insert,
 has_table_privilege(current_user,'public.dream_preferences','UPDATE') AS preference_update,
 has_table_privilege(current_user,'public.dream_preferences','DELETE') AS preference_delete,
 has_table_privilege(current_user,'public.dream_preferences','TRUNCATE') AS preference_truncate,
 has_table_privilege(current_user,'public.obligation_threads','SELECT') AS obligation_read,
 has_table_privilege(current_user,'public.obligation_threads','INSERT') AS obligation_insert,
 has_table_privilege(current_user,'public.obligation_threads','UPDATE') AS obligation_update,
 has_table_privilege(current_user,'public.obligation_threads','DELETE') AS obligation_delete,
 has_table_privilege(current_user,'public.obligation_threads','TRUNCATE') AS obligation_truncate,
 has_table_privilege(current_user,'public.karakeep_seen','SELECT') AS seen_read,
 has_table_privilege(current_user,'public.karakeep_seen','INSERT') AS seen_insert,
 has_table_privilege(current_user,'public.karakeep_seen','UPDATE') AS seen_update,
 has_table_privilege(current_user,'public.karakeep_seen','DELETE') AS seen_delete,
 has_table_privilege(current_user,'public.karakeep_seen','TRUNCATE') AS seen_truncate,
 has_table_privilege(current_user,'public.route_cursor','SELECT') AS cursor_read,
 has_table_privilege(current_user,'public.route_cursor','INSERT') AS cursor_insert,
 has_table_privilege(current_user,'public.route_cursor','UPDATE') AS cursor_update,
 has_table_privilege(current_user,'public.route_cursor','DELETE') AS cursor_delete,
 has_table_privilege(current_user,'public.route_cursor','TRUNCATE') AS cursor_truncate,
 has_table_privilege(current_user,'public.route_proposals','SELECT') AS route_read,
 has_table_privilege(current_user,'public.route_proposals','INSERT') AS route_insert,
 has_table_privilege(current_user,'public.route_proposals','UPDATE') AS route_update,
 has_table_privilege(current_user,'public.route_proposals','DELETE') AS route_delete,
 has_table_privilege(current_user,'public.route_proposals','TRUNCATE') AS route_truncate
 FROM pg_roles r WHERE r.rolname=current_user`);
stage='role identity constraints';const identity=role.rows[0];if(!identity||identity.current_user!=='lares_app'||identity.session_user!=='lares_app'||identity.rolsuper||identity.rolcreatedb||identity.rolcreaterole||identity.rolinherit||identity.rolreplication||identity.rolbypassrls||identity.memberships!==0||!identity.schema_usage||identity.schema_create)throw Error();
stage='ordinary CRUD grants';
for(const table of ['observation','preference','obligation'])for(const action of ['read','insert','update','delete'])if(!identity[table+'_'+action])throw Error();
for(const table of ['seen','cursor','route'])for(const action of ['read','insert','update','delete'])if(!identity[table+'_'+action])throw Error();
stage='truncate denied';
if(identity.observation_truncate||identity.preference_truncate||identity.obligation_truncate||identity.seen_truncate||identity.cursor_truncate||identity.route_truncate)throw Error();
stage='memory schema readiness';
await ensureDreamTables(db);await ensureObligationsTable(db);
stage='dream observation and recurrence';
const dream=makeDreamStore(db,'fixture-owner'),observation=await dream.record({text:'prefers concise status updates',kind:'preference',subject:'communication',confidence:0.5,evidenceRefs:[]},'runtime-image-proof','owner');
if(observation.origin!=='owner'||observation.owner!=='fixture-owner'||await dream.ownerRecurrenceCount('PREFERS concise status updates!')!==1)throw Error();
stage='preference lifecycle';const old=await dream.addPreference({text:'prefers weekly updates',kind:'preference',subject:'communication',confidence:0.6,origin:'owner'});
const current=await dream.addPreference({text:'prefers brief weekly updates',kind:'preference',subject:'communication',confidence:0.8,origin:'owner'});
await dream.supersede(old.id,current.id);const active=await dream.activePreferences();if(active.length!==1||active[0].id!==current.id||active[0].owner!=='fixture-owner')throw Error();
stage='obligation write';const threadId='runtime-image-obligation-proof',now=new Date('2026-10-22T12:00:00Z'),obligation={threadId,subject:'fixture only',counterpartyName:'Fixture peer',counterpartyAddress:'peer@example.invalid',lastMessageAt:now,ageHours:2,isRePing:false,unansweredCount:1,source:'gmail'};
await upsertSeen(db,obligation,now,'fixture-principal');if((await dismissedThreads(db)).has(threadId))throw Error();
stage='obligation dismissal';const dismissal=await dismissObligation(db,threadId,now);if(!dismissal.dismissed||dismissal.counterpartyAddress!=='peer@example.invalid'||!(await dismissedThreads(db)).has(threadId))throw Error();
stage='bookmark seen store';const seen=makePgSeenStore(db);await seen.ensure();if(await seen.isSeen('runtime-image-bookmark-proof'))throw Error();await seen.markSeen('runtime-image-bookmark-proof');await seen.markSeen('runtime-image-bookmark-proof');if(!await seen.isSeen('runtime-image-bookmark-proof'))throw Error();
stage='route cursor';const routes=makeRouteStore(db);await ensureRouteTables(db);if(await routes.getCursor()!==null)throw Error();
const cursor='2026-10-22T12:00:00.000Z';await routes.setCursor(cursor);if(await routes.getCursor()!==cursor)throw Error();
stage='route proposal persistence';
const proposalArgs={personId:'runtime-image-person-proof',opportunityId:'runtime-image-opportunity-proof',home:'twenty',trackId:'runtime-image-track-proof',proposedStage:'QUALIFIED',signalRef:'runtime-image-signal-proof',confidence:0.75};
if(await routes.alreadyProposed({personId:proposalArgs.personId,signalRef:proposalArgs.signalRef})||await routes.proposedSince({personId:proposalArgs.personId,home:proposalArgs.home,trackId:proposalArgs.trackId,sinceIso:'2000-01-01T00:00:00.000Z'}))throw Error();
const proposal=await routes.recordProposal(proposalArgs);if(!proposal.id||!await routes.alreadyProposed({personId:proposalArgs.personId,signalRef:proposalArgs.signalRef})||!await routes.proposedSince({personId:proposalArgs.personId,home:proposalArgs.home,trackId:proposalArgs.trackId,sinceIso:'2000-01-01T00:00:00.000Z'}))throw Error();
await routes.markResolved(proposal.id,'skipped');if(!await routes.alreadyProposed({personId:proposalArgs.personId,signalRef:proposalArgs.signalRef}))throw Error();
stage='memory row cleanup';const deleted=await db.query('DELETE FROM dream_observations WHERE id=$1',[observation.id]);if(deleted.rowCount!==1)throw Error();
await db.query('DELETE FROM dream_preferences WHERE id=ANY($1::uuid[])',[[old.id,current.id]]);await db.query('DELETE FROM obligation_threads WHERE thread_id=$1',[threadId]);
for(const [index,ddl] of ['CREATE TABLE public.memory_probe_ddl (id integer)','ALTER TABLE public.dream_observations ADD COLUMN memory_probe_ddl integer','TRUNCATE TABLE public.dream_observations','TRUNCATE TABLE public.dream_preferences','TRUNCATE TABLE public.obligation_threads','ALTER TABLE public.karakeep_seen ADD COLUMN memory_probe_ddl integer','TRUNCATE TABLE public.karakeep_seen','ALTER TABLE public.route_cursor ADD COLUMN memory_probe_ddl integer','TRUNCATE TABLE public.route_cursor','ALTER TABLE public.route_proposals ADD COLUMN memory_probe_ddl integer','TRUNCATE TABLE public.route_proposals'].entries()){stage='denied DDL '+index;let denied=false;try{await db.query(ddl);}catch(error){denied=error?.code==='42501';}if(!denied)throw Error();}
console.log('memory-schema-proof:complete');
}catch(error){const code=typeof error?.code==='string'&&/^[0-9A-Z]{5}$/.test(error.code)?error.code:'none';console.log('memory-schema-proof:failed stage='+stage+' sqlstate='+code);process.exitCode=1;}finally{await db.end();}}
void main();"""
 try:
  memory_access_output=cmd('docker','run','--rm','--user','10001:10001','--network',name,'--mount',f'type=bind,src={runtime_secrets},dst=/secrets,readonly','--workdir','/app/services/chief-of-staff','-e','MEMORY_PROOF_DATABASE_URL=postgresql://lares_app@proof-db:5432/proof','--entrypoint','/app/services/chief-of-staff/node_modules/.bin/tsx',image,'-e',memory_access_probe)
 except subprocess.CalledProcessError as e:
  print(e.output,flush=True)
  raise
 assert memory_access_output=='memory-schema-proof:complete','Fresh migration schema failed the nonowner readiness and store proof'
 # Reapplying the fixed schema migration must retain the existing shared cursor and dedup rows.
 sql((repo/'services/box/sql/027_shared_sync_schema.sql').read_text())
 sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM karakeep_seen WHERE id='runtime-image-bookmark-proof') OR (SELECT cursor_at FROM route_cursor WHERE id=1) IS DISTINCT FROM '2026-10-22T12:00:00Z'::timestamptz OR NOT EXISTS(SELECT 1 FROM route_proposals WHERE person_id='runtime-image-person-proof' AND signal_ref='runtime-image-signal-proof' AND status='skipped') OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='route_cursor'::regclass AND conname='route_cursor_singleton' AND contype='c') THEN RAISE EXCEPTION 'Shared sync migration reapply changed durable cursor, dedup state, or constraints'; END IF; END $$")
 # Inactive budget storage is additive, defaults closed, and retains evidence on reapply.
 sql("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id) VALUES('b1111111-1111-4111-8111-111111111111','probe-installation','installation','b1111111-1111-4111-8111-111111111111'); INSERT INTO budget_windows(id,account_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision) VALUES('b2222222-2222-4222-8222-222222222222','b1111111-1111-4111-8111-111111111111',clock_timestamp(),clock_timestamp()+interval '1 day',0,1,0)")
 sql((repo/'services/box/sql/011_budget_admission.sql').read_text())
 sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM budget_accounts WHERE state='closed' AND policy_generation=0 AND installation_cap IS NULL AND recovery_epoch IS NULL) THEN RAISE EXCEPTION 'Budget default/reapply changed'; END IF; BEGIN UPDATE budget_windows SET opening_liability=0.1; RAISE EXCEPTION 'Budget window changed'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Budget window is immutable' THEN RAISE; END IF; END; BEGIN PERFORM 'NaN'::budget_money; RAISE EXCEPTION 'Nonfinite budget accepted'; EXCEPTION WHEN check_violation THEN NULL; END; END $$")
 sql((repo/'services/box/sql/023_budget_invocation_suppression.sql').read_text())
 sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='budget_attempts' AND column_name='invocation_hash' AND is_nullable='YES') OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='budget_invocation_insert_guard') THEN RAISE EXCEPTION 'Durable invocation guard missing'; END IF; END $$")
 sql((repo/'services/box/sql/024_gateway_budget_grants.sql').read_text())
 sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='budget_gateway_bindings' AND column_name='pricing_profile' AND is_nullable='YES') OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='budget_gateway_grant_immutable') OR EXISTS(SELECT 1 FROM budget_gateway_grants) THEN RAISE EXCEPTION 'Inactive gateway grant/pricing support changed'; END IF; END $$")
 sql((repo/'services/box/sql/025_budget_financial_checkpoints.sql').read_text())
 sql("INSERT INTO budget_financial_checkpoints VALUES('b3333333-3333-4333-8333-333333333333','b4444444-4444-4444-8444-444444444444',1,repeat('a',64)); DO $$ BEGIN BEGIN UPDATE budget_financial_checkpoints SET proposal_sequence=2; RAISE EXCEPTION 'Checkpoint rewrite accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Financial checkpoint is immutable' THEN RAISE; END IF; END; END $$")
 # Action suppression and the unclaimed default survive migration reapplication.
 sql("INSERT INTO users(id,display_name) VALUES('action-proof-member','Action proof'); INSERT INTO personal_actions(id,payload_version,actor_member_id,agent,incarnation,session_id,original_turn_id,original_call_id,original_call_hash,account_id,account_generation,resource_binding_id,connector_id,kind,payload_hash,payload_ciphertext,created_at,expires_at) SELECT '33333333-3333-4333-8333-333333333333',1,'action-proof-member','probe-agent','11111111-1111-4111-8111-111111111111','proof-session','proof-turn','proof-call',repeat('0',64),'proof-account',0,'proof-resource','example','mail.send',repeat('a',64),'opaque-fixture',t,t+interval '24 hours' FROM (SELECT clock_timestamp() AS t) clock")
 sql((repo/'services/box/sql/019_personal_actions.sql').read_text())
 sql((repo/'services/box/sql/021_personal_action_acceptance.sql').read_text())
 sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM personal_actions WHERE state='awaiting_approval' AND attempt_id IS NULL) THEN RAISE EXCEPTION 'Action migration changed pending evidence'; END IF; BEGIN UPDATE personal_actions SET account_generation=1; RAISE EXCEPTION 'Action selection changed'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Personal action is immutable' THEN RAISE; END IF; END; END $$")
 sql("UPDATE personal_actions SET state='awaiting_dispatch',approval_call_id='proof-approval',approval_request_id='proof-request'; UPDATE personal_actions SET state='claimed',attempt_id='44444444-4444-4444-8444-444444444444',claimed_at=clock_timestamp(); UPDATE personal_actions SET state='accepted',receipt='{\"state\":\"accepted\",\"providerStatus\":202}'::jsonb,completed_at=clock_timestamp(); DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM personal_actions WHERE receipt='{\"state\":\"accepted\",\"providerStatus\":202}'::jsonb) THEN RAISE EXCEPTION 'Graph acceptance receipt requires a fabricated ID'; END IF; END $$")
 sql("DELETE FROM users WHERE id='action-proof-member'; DO $$ BEGIN IF EXISTS(SELECT 1 FROM personal_actions) OR NOT EXISTS(SELECT 1 FROM personal_action_calls) THEN RAISE EXCEPTION 'Action erasure lost replay suppression'; END IF; END $$")
 # Durable console authority survives reapply and cannot silently change its audience.
 sql("INSERT INTO orgs(id,display_name) VALUES('console-proof','Console proof'); INSERT INTO users(id,display_name,org_id,org_role) VALUES('console-proof-member','Member','console-proof','owner'); INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id,agent_access_revision,private_surface_revision,policy_revision) VALUES('probe-agent','11111111-1111-1111-1111-111111111111','probe-session','console-proof-member',repeat('a',43),'probe-place',1,2,2)")
 sql((repo/'services/box/sql/013_console_turn_authority.sql').read_text())
 sql("DO $$ BEGIN IF (SELECT member_id FROM console_session_bindings WHERE session_id='probe-session')<>'console-proof-member' THEN RAISE EXCEPTION 'Conversation binding changed on reapply'; END IF; BEGIN UPDATE console_session_bindings SET place_id='changed' WHERE session_id='probe-session'; RAISE EXCEPTION 'Conversation audience changed'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Conversation authority is immutable' THEN RAISE; END IF; END; END $$")
 sql((repo/'services/box/sql/016_console_agent_access_capture.sql').read_text())
 sql("DO $$ BEGIN IF (SELECT agent_access_revision FROM console_session_bindings WHERE session_id='probe-session')<>1 OR (SELECT revoked_at FROM console_session_bindings WHERE session_id='probe-session') IS NOT NULL THEN RAISE EXCEPTION 'Agent access capture changed on reapply'; END IF; BEGIN UPDATE console_session_bindings SET agent_access_revision=2 WHERE session_id='probe-session'; RAISE EXCEPTION 'Agent access capture changed'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Conversation authority is immutable' THEN RAISE; END IF; END; BEGIN INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id) VALUES('probe-agent','11111111-1111-1111-1111-111111111111','missing-capture','console-proof-member',repeat('b',43),'missing-capture'); RAISE EXCEPTION 'Missing active access capture accepted'; EXCEPTION WHEN check_violation THEN NULL; END; END $$")
 sql((repo/'services/box/sql/017_private_console_surface_capture.sql').read_text())
 sql((repo/'services/box/sql/018_private_account_history.sql').read_text())
 sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM console_session_bindings WHERE session_id='probe-session' AND private_surface_revision=2 AND revoked_at IS NULL) THEN RAISE EXCEPTION 'Private surface capture changed on reapply'; END IF; BEGIN UPDATE console_session_bindings SET private_surface_revision=0 WHERE session_id='probe-session'; RAISE EXCEPTION 'Private surface capture changed'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Conversation authority is immutable' THEN RAISE; END IF; END; BEGIN INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id,agent_access_revision) VALUES('probe-agent','11111111-1111-1111-1111-111111111111','old-runtime','console-proof-member',repeat('c',43),'old-runtime',1); RAISE EXCEPTION 'Old runtime active capture accepted'; EXCEPTION WHEN check_violation THEN NULL; END; END $$")
 # Agent ownership is explicit and additive; reapply preserves grants and revisions.
 sql("INSERT INTO agent_definitions(name,definition,hash) VALUES('grant-probe','{\"grants\":[]}'::jsonb,'grant-probe-hash'); INSERT INTO agent_access(agent_name,owner_member_id,organisation_id) VALUES('grant-probe','console-proof-member','console-proof'); INSERT INTO resource_grants(id,resource_kind,resource_id,principal_member_id,permission,grantor_member_id,issued_access_revision) SELECT '22222222-2222-4222-8222-222222222222','agent',agent_name,'console-proof-member','use','console-proof-member',revision FROM agent_access WHERE agent_name='grant-probe'")
 sql((repo/'services/box/sql/014_agent_access_grants.sql').read_text())
 sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM agent_access WHERE agent_name='grant-probe' AND owner_member_id='console-proof-member') OR NOT EXISTS(SELECT 1 FROM resource_grants WHERE resource_id='grant-probe' AND revoked_at IS NULL) THEN RAISE EXCEPTION 'Agent grants changed on reapply'; END IF; END $$")
 sql("DELETE FROM agent_definitions WHERE name='grant-probe'")
 # Vault authority is metadata only, uses the same registry, and survives migration replay.
 sql("INSERT INTO vault_backing_stores(id,organisation_id,kind) VALUES('vault-proof','console-proof','git'); INSERT INTO vault_areas(id,organisation_id,kind,owner_organisation_id,backing_store_id,relative_path) VALUES('vault-area-proof','console-proof','shared','console-proof','vault-proof','shared'); INSERT INTO resource_grants(id,resource_kind,resource_id,principal_member_id,permission,grantor_member_id,issued_access_revision) SELECT '33333333-3333-4333-8333-333333333333','vault-area',id,'console-proof-member','use','console-proof-member',revision FROM vault_areas WHERE id='vault-area-proof'")
 sql((repo/'services/box/sql/009_vault_areas.sql').read_text())
 sql((repo/'services/box/sql/014_agent_access_grants.sql').read_text())
 sql((repo/'services/box/sql/020_vault_resource_grants.sql').read_text())
 sql("UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE resource_kind='vault-area' AND resource_id='vault-area-proof'")
 sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM vault_areas WHERE id='vault-area-proof' AND status='active') OR NOT EXISTS(SELECT 1 FROM resource_grants WHERE resource_kind='vault-area' AND vault_area_id='vault-area-proof' AND agent_resource_id IS NULL AND revoked_at IS NOT NULL) THEN RAISE EXCEPTION 'Vault metadata or grant replay failed'; END IF; BEGIN UPDATE resource_grants SET revoked_at=NULL WHERE resource_kind='vault-area'; RAISE EXCEPTION 'Vault grant restored'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Resource grant is immutable' THEN RAISE; END IF; END; END $$")
 # Retained source dependencies require the current guard marker and survive reapplication.
 sql("INSERT INTO console_session_bindings(agent,incarnation,session_id,member_id,admission_nonce,place_id,agent_access_revision,private_surface_revision,source_history_guard_revision,policy_revision) VALUES('probe-agent','11111111-1111-1111-1111-111111111111','source-proof-session','console-proof-member',repeat('s',43),'source-proof-place',1,2,1,2); INSERT INTO console_vault_source_captures(agent,incarnation,session_id,member_id,admission_nonce,area_id,access_revision,session_definition_hash) SELECT 'probe-agent','11111111-1111-1111-1111-111111111111','source-proof-session','console-proof-member',repeat('s',43),id,revision,repeat('a',64) FROM vault_areas WHERE id='vault-area-proof'")
 sql((repo/'services/box/sql/022_console_vault_source_history.sql').read_text())
 sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM console_vault_source_captures WHERE session_id='source-proof-session' AND session_definition_hash=repeat('a',64)) THEN RAISE EXCEPTION 'Source history lost on reapply'; END IF; BEGIN UPDATE console_vault_source_captures SET original_valid_until=clock_timestamp(); RAISE EXCEPTION 'Source history changed'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Conversation source history is immutable' THEN RAISE; END IF; END; BEGIN DELETE FROM console_session_bindings WHERE session_id='source-proof-session'; RAISE EXCEPTION 'Source dependency silently removed'; EXCEPTION WHEN foreign_key_violation THEN NULL; END; END $$")
 # SQL008 is additive, preserves rows on reapply, and enforces same-owner resource bindings.
 sql("INSERT INTO users(id,display_name) VALUES ('account-probe-a','Fixture A'),('account-probe-b','Fixture B')")
 sql("INSERT INTO connected_accounts(id,owner_member_id,connector_id,provider_issuer,provider_subject,provider_label,status) VALUES ('account-probe','account-probe-a','example','https://provider.example','subject','Fixture','ok')")
 sql("INSERT INTO connected_resource_bindings(id,owner_member_id,connected_account_id,resource_kind,external_id,provider_label) VALUES ('resource-probe','account-probe-a','account-probe','mailbox','inbox','Inbox')")
 sql((repo/'services/box/sql/008_connected_accounts.sql').read_text())
 sql("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM connected_accounts WHERE id='account-probe' AND generation=0 AND lifecycle_revision=0) OR NOT EXISTS (SELECT 1 FROM connected_resource_bindings WHERE id='resource-probe') THEN RAISE EXCEPTION 'Account metadata changed on migration reapply'; END IF; BEGIN INSERT INTO connected_resource_bindings(id,owner_member_id,connected_account_id,resource_kind,external_id,provider_label) VALUES ('wrong-owner-probe','account-probe-b','account-probe','mailbox','other','Other'); RAISE EXCEPTION 'Cross-owner binding accepted'; EXCEPTION WHEN foreign_key_violation THEN NULL; END; END $$")
 # SQL012 only associates an explicit canonical custody row, never legacy labels or aliases.
 sql("INSERT INTO oauth_tokens(principal,provider,org_id,email_address,refresh_token_enc) VALUES ('account-probe-a','example','fixture','fixture@example.invalid','unchanged-fixture'),('account-probe-b','example','fixture','fixture@example.invalid','other-fixture')")
 sql("INSERT INTO connected_account_credentials(account_id,owner_member_id,connector_id,account_generation,oauth_token_id) SELECT 'account-probe','account-probe-a','example',0,id FROM oauth_tokens WHERE principal='account-probe-a'")
 sql((repo/'services/box/sql/012_connected_account_credentials.sql').read_text())
 sql("DO $$ BEGIN IF (SELECT count(*) FROM connected_account_credentials WHERE account_id='account-probe')<>1 OR (SELECT refresh_token_enc FROM oauth_tokens WHERE principal='account-probe-a')<>'unchanged-fixture' THEN RAISE EXCEPTION 'Credential association migration changed existing data'; END IF; BEGIN UPDATE connected_account_credentials SET oauth_token_id=(SELECT id FROM oauth_tokens WHERE principal='account-probe-b') WHERE account_id='account-probe'; RAISE EXCEPTION 'Cross-member custody accepted'; EXCEPTION WHEN foreign_key_violation THEN NULL; END; END $$")
 sql("DELETE FROM users WHERE id IN ('account-probe-a','account-probe-b')")
 sql("DELETE FROM oauth_tokens WHERE principal IN ('account-probe-a','account-probe-b')")
 # Strict reservations precede request IDs; legacy cards retain their unique identities.
 sql("INSERT INTO approval_asks(request_id,call_id,agent,tool,payload_hash) VALUES('legacy-proof','legacy-proof','canary','fixture','h'); INSERT INTO approval_asks(call_id,agent,tool,payload_hash) VALUES('reserved-proof','canary','deadline_dismiss','h')")
 sql((repo/'services/box/sql/015_exact_approval_execution.sql').read_text())
 sql("DO $$ BEGIN IF (SELECT request_id FROM approval_asks WHERE call_id='legacy-proof')<>'legacy-proof' OR NOT EXISTS(SELECT 1 FROM approval_asks WHERE call_id='reserved-proof' AND request_id IS NULL) THEN RAISE EXCEPTION 'Exact approval migration lost ledger evidence'; END IF; END $$")
 sql("DELETE FROM approval_asks WHERE call_id IN ('legacy-proof','reserved-proof')")
 # The credential journal is part of the baseline.
 sql("DO $$ BEGIN IF to_regclass('standing_facts') IS NULL OR (SELECT count(*) FROM information_schema.columns WHERE table_name='standing_facts' AND column_name IN ('user_id','origin','recorded_at','source','superseded_by'))<>5 THEN RAISE EXCEPTION 'standing_facts missing or not in its final shape'; END IF; END $$")
 sql("DO $$ BEGIN IF to_regclass('keeper_credentials') IS NULL THEN RAISE EXCEPTION 'Credential journal migration missing'; END IF; END $$")
 # Admission schema must exist on a fresh pgvector database, without baseline rewrites.
 sql("DO $$ BEGIN IF (SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name IN ('status','automation_mode'))<>2 OR to_regclass('member_invitations') IS NULL OR to_regclass('member_provider_identities') IS NULL OR to_regclass('member_sessions') IS NULL THEN RAISE EXCEPTION 'Member admission schema missing'; END IF; END $$")
 # Prove re-running the additive migration preserves statuses and identity/session hashes.
 sql("INSERT INTO orgs(id,display_name) VALUES('admission-proof','Admission proof'); INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('admission-owner','Owner','admission-proof','owner','active'),('admission-invited','Invited','admission-proof','member','invited'),('admission-removed','Removed','admission-proof','member','removed'); INSERT INTO member_provider_identities(member_id,issuer,subject) VALUES('admission-owner','https://identity.example.invalid','owner'); INSERT INTO member_sessions(id,member_id,token_hash,expires_at) VALUES('admission-session','admission-owner',repeat('a',64),now()+interval '1 day')")
 sql((repo/'services/box/sql/007_member_identity_sessions.sql').read_text())
 sql("DO $$ BEGIN IF (SELECT status FROM users WHERE id='admission-invited')<>'invited' OR (SELECT status FROM users WHERE id='admission-removed')<>'removed' OR (SELECT count(*) FROM member_provider_identities WHERE member_id='admission-owner')<>1 OR (SELECT token_hash FROM member_sessions WHERE id='admission-session')<>repeat('a',64) THEN RAISE EXCEPTION 'Member migration changed existing data'; END IF; END $$")
 sql("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,state,runtime_control_token,pending) VALUES('canary','172.30.0.99','proof','owned','11111111-1111-4111-8111-111111111111','ready','11111111-1111-4111-8111-111111111111',false)")
 env={'DATABASE_URL':'postgres://lares_app@proof-db:5432/proof','WORKFLOW_POSTGRES_URL':'postgres://lares_workflow@proof-db:5432/workflowproof','DATABASE_PASSWORD_FILE':'/secrets/app-password','WORKFLOW_POSTGRES_PASSWORD_FILE':'/secrets/workflow-password','GATEWAY_URL':'http://host.docker.internal:'+str(server.server_port),'GATEWAY_KEY_FILE':'/secrets/gateway','EVE_ROUTE_PASSWORD_FILE':'/secrets/route','LARES_AGENT_NAME':'canary','LARES_DEFINITION_DIR':'/definition','LARES_AGENT_INCARNATION':'11111111-1111-4111-8111-111111111111','LARES_RUNTIME_CONTROL_SECRET_FILE':'/secrets/control','AGENT_OWNER_USER_ID':'fixture-owner','EVE_SCHEDULES_LIVE':'0','EVE_DIGEST_LIVE':'0','EVE_DREAM_LIVE':'0'}
 admission_prefix=root/'admission-installation';admission_prefix.mkdir(mode=0o755)
 admission_subnet=f"172.30.{int(uuid.uuid4().hex[:2],16)}.0/24"
 custody.prepare_fresh(admission_prefix,admission_subnet)
 admission_identity=custody.validate(admission_prefix,admission_subnet)
 admission_dir=admission_prefix/'var/lib/lares-maintenance/admission'
 # The image refuses BEFORE it serves anything when a required setting is missing. One
 # throwaway container with the validated admission receipt and secrets mounted, ~1 s: every name
 # above except GATEWAY_URL, so the refusal has to name exactly that one, exit 78 (EX_CONFIG) and
 # print no secret. The *_FILE probe ([ -r ], [ -s ]) must PASS on those secrets as user 10001
 # against a read-only bind mount — only GATEWAY_URL may be named.
 short=[x for k,v in env.items() if k!='GATEWAY_URL' for x in ('-e',k+'='+v)]
 refusal=subprocess.run(['docker','run','--rm','--platform','linux/amd64','--read-only','--user','10001:10001','--mount',f'type=bind,src={runtime_secrets},dst=/secrets,readonly','--mount',f'type=bind,src={admission_dir},dst=/run/lares-maintenance/admission,readonly']+short+[image,'/run/lares-maintenance/admission',admission_identity['installationId'],str(admission_identity['epoch']),'--','/usr/local/bin/lares-start'],capture_output=True,text=True,timeout=120)
 said=refusal.stdout+refusal.stderr
 assert refusal.returncode==78,f'A missing required setting exited {refusal.returncode}, not 78 (EX_CONFIG): {said}'
 assert 'GATEWAY_URL' in refusal.stderr,f'The refusal did not name the missing setting: {said}'
 assert 'DATABASE_PASSWORD_FILE' not in said,f'The guard failed a secret file that is mounted and readable: {said}'
 assert 'disposable-fixture-only' not in said,'The refusal printed a secret'
 args=['docker','run','-d','--platform','linux/amd64','--name',name+'-runtime','--network',name,'--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:uid=10001,gid=10001,mode=1770','--tmpfs','/app/services/chief-of-staff/.eve/sandbox-cache:uid=10001,gid=10001,mode=0700,size=256m','--tmpfs','/app/services/chief-of-staff/node_modules/.cache:uid=10001,gid=10001,mode=0700,size=384m','--tmpfs','/app/packages/agent-kit/node_modules/.cache:uid=10001,gid=10001,mode=0700,size=64m','-p','127.0.0.1::3000','--mount',f'type=bind,src={root}/definition,dst=/definition,readonly','--mount',f'type=bind,src={runtime_secrets},dst=/secrets,readonly','--mount',f'type=bind,src={admission_dir},dst=/run/lares-maintenance/admission,readonly','--mount',f'type=bind,src={root}/blobs,dst=/app/services/chief-of-staff/.eve/.workflow-data']
 args+=['--mount',f'type=bind,src={root},dst=/probe,readonly']
 if sys.platform!='darwin':args+=['--add-host','host.docker.internal:host-gateway']
 for k,v in env.items():args+=['-e',k+'='+v]
 cmd(*args,image,'/run/lares-maintenance/admission',admission_identity['installationId'],str(admission_identity['epoch']),'--','/usr/local/bin/lares-start')
 wait_healthy()
 # Exercise the shipped ordinary-tool factory without a token mount or provider network call.
 outside_proof=root/'outside-tools.mts'
 outside_proof.write_text("import {existsSync} from 'node:fs';import {resolveOutsideTools} from '/app/packages/agent-kit/src/outside-connections.ts';\n"
  "const tools=await resolveOutsideTools({name:'canary',grants:[{capability:'outside',scope:'read'}],autonomy:{outside:'gated'},outsideTools:[{name:'registry',url:'https://tools.example.org/mcp',description:'Fixture',token:true,trusted:false,tools:{allow:['lookup'],read:['lookup']}}]},{acceptedTools:async()=>[{name:'lookup',inputSchema:{type:'object'}}],executor:()=>async()=>({content:[]})});if(!tools?.registry__lookup||typeof tools.registry__lookup.execute!=='function'||existsSync('/run/secrets/outside-registry'))throw Error('Outside tool or custody boundary missing');console.log('outside-tool-without-token');\n")
 assert cmd('docker','exec',name+'-runtime','/app/services/chief-of-staff/node_modules/.bin/tsx','/probe/outside-tools.mts')=='outside-tool-without-token','Ordinary outside tool requires an agent token mount'
 client=root/'client.mjs';client.write_text("import {Client,isCurrentTurnBoundaryEvent} from '/app/services/chief-of-staff/node_modules/eve/dist/src/client/index.js';\nconst c=new Client({host:'http://127.0.0.1:3000',auth:{basic:{username:'eve',password:'disposable-fixture-only'}}});let id=process.argv[2],watch=process.argv[4]==='watch',r,s;if(watch){s=c.sessions.attach(id,{streamIndex:Number(process.argv[3])});r={};for await(const e of s.stream()){if(e.type==='message.completed'&&e.data.finishReason!=='tool-calls')r.message=e.data.message??undefined;if(isCurrentTurnBoundaryEvent(e)){r.status=e.type==='session.waiting'?'waiting':e.type;break;}}}else if(id){s=c.sessions.attach(id,{streamIndex:Number(process.argv[3])});r=await(await s.send('Return another greeting.')).result();}else{const first=await c.sessions.create({message:'Return a short greeting.'});s=first.session;r=await first.response.result();}console.log(JSON.stringify({...s.state,message:r.message,status:r.status}));process.exit((watch?r.status==='waiting':r.message==='CI_IMAGE_TURN_OK')?0:1);\n")
 # watch=True sends NOTHING: it reads the conversation from session['streamIndex'] to the next turn boundary.
 def turn(session=None,watch=False,timeout=120):
  return json.loads(cmd('docker','exec',name+'-runtime','node','/probe/client.mjs',*([session['sessionId'],str(session['streamIndex'])]+(['watch'] if watch else []) if session else []),timeout=timeout))
 first=turn();assert requests,'No gateway request';assert 'UNIQUE_CI_MOUNTED_DUTIES' in json.dumps(requests[-1]),'Mounted instructions missing'
 expected_tools={'echo_note'}
 def tool_names():return {t['name'] for t in requests[-1].get('tools',[])}
 assert expected_tools<=tool_names(),'Initial dynamic tools missing'
 old_alias=d['model'];d['model']='installation-writer';d['grants']=[];d['autonomy']={};d['skills']=[];(root/'definition/agent.json').write_text(json.dumps(d));(root/'definition/duties.md').write_text('UNIQUE_CI_NEW_DUTIES')
 # Session model state must survive a real process restart, not merely a module map.
 # : a QUIET restart. Turn 1 has fully finished first, so this case tests what it claims (what a
 # conversation keeps across a restart) and cannot land inside the turn's finishing work.
 wait_quiet('after turn 1')
 cmd('docker','restart',name+'-runtime')
 wait_healthy()
 request_count=len(requests);second=turn(first);assert len(requests)>request_count,'No new model call after restart';assert requests[-1]['model']==old_alias;assert 'UNIQUE_CI_MOUNTED_DUTIES' in json.dumps(requests[-1])
 assert expected_tools<=tool_names(),'Existing conversation lost its tools after restart'
 third=turn();assert third['sessionId']!=first['sessionId'];assert requests[-1]['model']=='installation-writer';assert 'UNIQUE_CI_NEW_DUTIES' in json.dumps(requests[-1])
 assert not expected_tools&tool_names(),'New conversation exposed a removed catalogue grant or skill tool'
 #  regression: a restart that lands INSIDE a turn. The model's reply is held, the process is
 # restarted mid-step, and the interrupted turn has to finish by itself. Without the boot-time unlock
 # (agent-kit release-stale-workflow-locks) the dead process's job lock keeps this conversation silent
 # for ~860 s; with it, seconds.
 wait_quiet('after turn 3')
 Model.held.clear();gate=threading.Event();Model.hold=gate
 interrupted=subprocess.Popen(['docker','exec',name+'-runtime','node','/probe/client.mjs',third['sessionId'],str(third['streamIndex'])],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 assert Model.held.wait(60),'Held model request never arrived'
 request_count=len(requests)
 cmd('docker','restart',name+'-runtime')
 Model.hold=None;gate.set();interrupted.kill();interrupted.wait()
 wait_healthy()
 # Read from where the interrupted turn BEGAN (turn 3's closing index), sending nothing. The held reply
 # never reached the old process, so no boundary can sit at or after that index until the restarted
 # process re-runs the step: the first one seen is the recovery, and its text needs a NEW model call.
 fourth=turn(third,watch=True,timeout=60)
 assert fourth['status']=='waiting' and fourth['message']=='CI_IMAGE_TURN_OK','Interrupted turn did not finish after restart'
 assert len(requests)>request_count,'No new model call for the interrupted turn after restart'
 wait_quiet('after the recovered turn')
 request_count=len(requests);fifth=turn(fourth);assert fifth['sessionId']==third['sessionId'];assert len(requests)>request_count,'Recovered conversation did not answer a new message'
 print(json.dumps({'status':'PASS','mountedPersonaReachedModel':True,'aliasPinnedAcrossRestart':True,'dynamicCatalogueAndSkillToolsRetainedAcrossRestart':True,'newSessionHonorsRemovedCatalogueGrant':True,'newSessionHonorsRemovedSkill':True,'newSessionReadsNewAliasAndDuties':True,'restartMidTurnRecovers':True,'separateApplicationLogin':True,'applicationCredentialRejectedByWorkflow':True,'workflowSchemaPreparedOffline':True,'gatewayIsLocalFixture':True}))
except Exception:
 logs=subprocess.run(['docker','logs',name+'-runtime'],capture_output=True,text=True)
 print((logs.stdout+logs.stderr)[-24000:],flush=True)
 print(subprocess.run(['docker','inspect','--format','{{json .State}} {{json .NetworkSettings.Ports}}',name+'-runtime'],capture_output=True,text=True).stdout,flush=True)
 # : on any failure, show where the workflow runs actually stopped — an orphaned inline
 # step, a job still locked by the dead process, and a ':backstop:' job ~860 s out are the
 # three fingerprints of a restart that landed inside a turn's finishing work.
 for q in ["SELECT id,name,status,created_at,updated_at FROM workflow.workflow_runs ORDER BY created_at","SELECT run_id,step_id,step_name,status,attempt,started_at,completed_at FROM workflow.workflow_steps WHERE status<>'completed' ORDER BY created_at","SELECT id,key,attempts,max_attempts,run_at,locked_at,locked_by,left(last_error,160) AS err,now() FROM graphile_worker.jobs ORDER BY id","SELECT run_id,type,correlation_id,created_at FROM workflow.workflow_events ORDER BY created_at DESC LIMIT 40"]:
  r=subprocess.run(['docker','exec','-i',name+'-db','psql','-X','-U','proof','-d','workflowproof','-c',q],capture_output=True,text=True);print(q+'\n'+r.stdout+r.stderr,flush=True)
 raise
finally:
 (root/'runtime.log').write_text(subprocess.run(['docker','logs',name+'-runtime'],capture_output=True,text=True).stdout+subprocess.run(['docker','logs',name+'-runtime'],capture_output=True,text=True).stderr)
 for n in ['runtime','db']:subprocess.run(['docker','rm','-f',name+'-'+n],capture_output=True)
 subprocess.run(['docker','network','rm',name],capture_output=True);server.shutdown()
 shutil.rmtree(runtime_secrets,ignore_errors=True);shutil.rmtree(offline_secrets,ignore_errors=True)
 print('Probe artifacts:',root)
