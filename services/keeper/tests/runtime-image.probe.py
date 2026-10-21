"""Disposable CI-image runtime proof. No production data or provider credentials."""
import subprocess,json,pathlib,tempfile,time,urllib.request,http.server,threading,os,shutil,sys,uuid
repo=pathlib.Path(__file__).resolve().parents[3]
root=pathlib.Path(tempfile.mkdtemp(prefix='lares-image-proof-'));root.chmod(0o755)
name='lares-image-proof-'+uuid.uuid4().hex[:10];image=sys.argv[1]
def cmd(*a,input=None,timeout=120):
 try:return subprocess.check_output(a,input=input,text=True,stderr=subprocess.STDOUT,timeout=timeout).strip()
 except subprocess.CalledProcessError as e:print(e.output,flush=True);raise
def sql(body):return cmd('docker','exec','-i',name+'-db','psql','-X','-v','ON_ERROR_STOP=1','-U','proof','-d','proof',input=body)
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
  calm=calm+1 if cmd('docker','exec',name+'-db','psql','-X','-U','proof','-d','proof','-Atc',q)=='0' else 0
  if calm==2:return
  time.sleep(.5)
 raise RuntimeError('Workflow work never went quiet '+what)
requests=[]
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
 (root/'definition').mkdir();(root/'secrets').mkdir();(root/'blobs').mkdir();(root/'blobs').chmod(0o777)
 d=json.loads((repo/'packages/agent-kit/templates/chief-of-staff/definition.json').read_text());d.update(name='canary',role='chief-of-staff',grants=[{'capability':'echo','scope':'write-with-confirm'}],autonomy={'echo':'gated'},skills=[],channels=[],duties='duties.md')
 (root/'definition/agent.json').write_text(json.dumps(d));(root/'definition/duties.md').write_text('UNIQUE_CI_MOUNTED_DUTIES');(root/'definition/voice.md').write_text('Be concise.')
 for n in ['password','gateway','route','control']:(root/'secrets'/n).write_text('disposable-fixture-only')
 cmd('docker','network','create',name)
 cmd('docker','run','-d','--name',name+'-db','--network',name,'--network-alias','proof-db','-e','POSTGRES_USER=proof','-e','POSTGRES_PASSWORD=disposable-fixture-only','-e','POSTGRES_DB=proof','pgvector/pgvector:pg16')
 for i in range(60):
  # The image's temporary initialization server accepts Unix-socket connections
  # before POSTGRES_DB exists. Wait for the final TCP server and a real query.
  try:cmd('docker','exec','-e','PGPASSWORD=disposable-fixture-only',name+'-db','psql','-h','127.0.0.1','-U','proof','-d','proof','-Atc','SELECT 1');break
  except subprocess.CalledProcessError:time.sleep(.5)
 else:raise RuntimeError('Disposable PostgreSQL database did not become ready')
 sql((repo/'services/chief-of-staff/sql/001-eve-workflow.sql').read_text())
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
 env={'DATABASE_URL':'postgres://proof@proof-db/proof','WORKFLOW_POSTGRES_URL':'postgres://proof@proof-db/proof','DATABASE_PASSWORD_FILE':'/secrets/password','GATEWAY_URL':'http://host.docker.internal:'+str(server.server_port),'GATEWAY_KEY_FILE':'/secrets/gateway','EVE_ROUTE_PASSWORD_FILE':'/secrets/route','LARES_AGENT_NAME':'canary','LARES_DEFINITION_DIR':'/definition','LARES_AGENT_INCARNATION':'11111111-1111-4111-8111-111111111111','LARES_RUNTIME_CONTROL_SECRET_FILE':'/secrets/control','AGENT_OWNER_USER_ID':'fixture-owner','EVE_SCHEDULES_LIVE':'0','EVE_DIGEST_LIVE':'0','EVE_DREAM_LIVE':'0'}
 # The image refuses BEFORE it serves anything when a required setting is missing. One
 # throwaway container, no mounts, ~1 s: every name above except GATEWAY_URL, so the refusal has
 # to name exactly that one, exit 78 (EX_CONFIG) and print no secret.
 # The secrets are mounted exactly as below, so the *_FILE probe ([ -r ], [ -s ]) has to PASS on
 # them as user 10001 against a read-only bind mount — only GATEWAY_URL may be named.
 short=[x for k,v in env.items() if k!='GATEWAY_URL' for x in ('-e',k+'='+v)]
 refusal=subprocess.run(['docker','run','--rm','--platform','linux/amd64','--read-only','--user','10001:10001','--mount',f'type=bind,src={root}/secrets,dst=/secrets,readonly']+short+[image],capture_output=True,text=True,timeout=120)
 said=refusal.stdout+refusal.stderr
 assert refusal.returncode==78,f'A missing required setting exited {refusal.returncode}, not 78 (EX_CONFIG): {said}'
 assert 'GATEWAY_URL' in refusal.stderr,f'The refusal did not name the missing setting: {said}'
 assert 'DATABASE_PASSWORD_FILE' not in said,f'The guard failed a secret file that is mounted and readable: {said}'
 assert 'disposable-fixture-only' not in said,'The refusal printed a secret'
 args=['docker','run','-d','--platform','linux/amd64','--name',name+'-runtime','--network',name,'--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:uid=10001,gid=10001,mode=1770','--tmpfs','/app/services/chief-of-staff/.eve/sandbox-cache:uid=10001,gid=10001,mode=0700,size=256m','--tmpfs','/app/services/chief-of-staff/node_modules/.cache:uid=10001,gid=10001,mode=0700,size=384m','--tmpfs','/app/packages/agent-kit/node_modules/.cache:uid=10001,gid=10001,mode=0700,size=64m','-p','127.0.0.1::3000','--mount',f'type=bind,src={root}/definition,dst=/definition,readonly','--mount',f'type=bind,src={root}/secrets,dst=/secrets,readonly','--mount',f'type=bind,src={root}/blobs,dst=/app/services/chief-of-staff/.eve/.workflow-data']
 args+=['--mount',f'type=bind,src={root},dst=/probe,readonly']
 if sys.platform!='darwin':args+=['--add-host','host.docker.internal:host-gateway']
 for k,v in env.items():args+=['-e',k+'='+v]
 cmd(*args,image)
 wait_healthy()
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
 print(json.dumps({'status':'PASS','image':image,'turns':[first,second,third,fourth,fifth],'mountedPersonaReachedModel':True,'aliasPinnedAcrossRestart':True,'dynamicCatalogueAndSkillToolsRetainedAcrossRestart':True,'newSessionHonorsRemovedCatalogueGrant':True,'newSessionHonorsRemovedSkill':True,'newSessionReadsNewAliasAndDuties':True,'restartMidTurnRecovers':True,'gateway':'local Anthropic protocol fixture; no provider call','projection':sql('SELECT count(*) FROM agent_conversations'),'root':str(root)},indent=2))
except Exception:
 logs=subprocess.run(['docker','logs',name+'-runtime'],capture_output=True,text=True)
 print((logs.stdout+logs.stderr)[-24000:],flush=True)
 print(subprocess.run(['docker','inspect','--format','{{json .State}} {{json .NetworkSettings.Ports}}',name+'-runtime'],capture_output=True,text=True).stdout,flush=True)
 # : on any failure, show where the workflow runs actually stopped — an orphaned inline
 # step, a job still locked by the dead process, and a ':backstop:' job ~860 s out are the
 # three fingerprints of a restart that landed inside a turn's finishing work.
 for q in ["SELECT id,name,status,created_at,updated_at FROM workflow.workflow_runs ORDER BY created_at","SELECT run_id,step_id,step_name,status,attempt,started_at,completed_at FROM workflow.workflow_steps WHERE status<>'completed' ORDER BY created_at","SELECT id,key,attempts,max_attempts,run_at,locked_at,locked_by,left(last_error,160) AS err,now() FROM graphile_worker.jobs ORDER BY id","SELECT run_id,type,correlation_id,created_at FROM workflow.workflow_events ORDER BY created_at DESC LIMIT 40"]:
  r=subprocess.run(['docker','exec','-i',name+'-db','psql','-X','-U','proof','-d','proof','-c',q],capture_output=True,text=True);print(q+'\n'+r.stdout+r.stderr,flush=True)
 raise
finally:
 (root/'runtime.log').write_text(subprocess.run(['docker','logs',name+'-runtime'],capture_output=True,text=True).stdout+subprocess.run(['docker','logs',name+'-runtime'],capture_output=True,text=True).stderr)
 for n in ['runtime','db']:subprocess.run(['docker','rm','-f',name+'-'+n],capture_output=True)
 subprocess.run(['docker','network','rm',name],capture_output=True);server.shutdown();print('Probe artifacts:',root)
