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
 # LAR-73: a turn's client returns at session.waiting, but the runtime still has that turn's finishing
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
 # LAR-73: while `hold` is an Event, every reply waits on it and `held` says a request has arrived.
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
 d=json.loads((repo/'packages/agent-kit/templates/chief-of-staff/definition.json').read_text());d.update(name='canary',role='chief-of-staff',grants=[{'capability':'echo','scope':'write-with-confirm'},{'capability':'markets','scope':'read'}],autonomy={'echo':'gated'},skills=[{'name':'market-edge','requires':[{'capability':'markets','scope':'read'}]}],channels=[],duties='duties.md')
 (root/'definition/agent.json').write_text(json.dumps(d));(root/'definition/duties.md').write_text('UNIQUE_CI_MOUNTED_DUTIES');(root/'definition/voice.md').write_text('Be concise.')
 for n in ['password','gateway','route','control']:(root/'secrets'/n).write_text('disposable-fixture-only')
 cmd('docker','network','create',name)
 cmd('docker','run','-d','--name',name+'-db','--network',name,'--network-alias','proof-db','-e','POSTGRES_USER=proof','-e','POSTGRES_PASSWORD=disposable-fixture-only','-e','POSTGRES_DB=proof','postgres:16-alpine')
 for i in range(60):
  # The image's temporary initialization server accepts Unix-socket connections
  # before POSTGRES_DB exists. Wait for the final TCP server and a real query.
  try:cmd('docker','exec','-e','PGPASSWORD=disposable-fixture-only',name+'-db','psql','-h','127.0.0.1','-U','proof','-d','proof','-Atc','SELECT 1');break
  except subprocess.CalledProcessError:time.sleep(.5)
 else:raise RuntimeError('Disposable PostgreSQL database did not become ready')
 sql((repo/'services/chief-of-staff/sql/001-eve-workflow.sql').read_text())
 sql((repo/'services/chief-of-staff/sql/002-standing-facts.sql').read_text())
 sql((repo/'services/chief-of-staff/sql/003-facts-owner.sql').read_text())
 sql((repo/'services/chief-of-staff/sql/004-standing-facts-origin.sql').read_text())
 sql((repo/'services/chief-of-staff/sql/005-standing-facts-validity.sql').read_text())
 sql('CREATE TABLE heartbeat(agent text PRIMARY KEY)')
 sql((repo/'services/box/sql/035_proactivity.sql').read_text())
 # The loop below applies every migration from 039 up; the older tables those migrations ALTER
 # (048 → meeting_followup_sent from 027; 047 → deadlines from 036; 078 →
 # telegram_session_rotation from 020; 077 → ratchet from 008, approval_events from 038) have to
 # exist first.
 sql((repo/'services/box/sql/027_meeting_followup.sql').read_text())
 sql((repo/'services/box/sql/036_deadlines.sql').read_text())
 sql((repo/'services/box/sql/020_telegram_session_rotation.sql').read_text())
 # Exercise 088's principal-default removal against the pre-039 source tables too.
 sql((repo/'services/box/sql/021_outreach_threads.sql').read_text())
 sql((repo/'services/box/sql/022_email_triage.sql').read_text())
 sql((repo/'services/box/sql/023_schema_principal_scoping.sql').read_text())
 sql((repo/'services/box/sql/008_ratchet.sql').read_text())
 sql('CREATE TABLE'+(repo/'services/box/sql/038_permissions_board.sql').read_text().split('-- What the approval policy decided,',1)[1].split('CREATE TABLE',1)[1].split('-- One row per agent,')[0])
 sql('CREATE TABLE'+(repo/'services/box/sql/038_permissions_board.sql').read_text().split('-- One row per agent,')[1].split('CREATE TABLE',1)[1])
 # 083_owner_key_is_the_register_id.sql ALTERs sixteen tables, several created below 039, and
 # deliberately adds NO prerequisite here: every one of its statements is guarded by to_regclass
 # and is a no-op with a line in its report when the table is absent, because a real box may also
 # lack an optional table. Two things this database does NOT have, and 083 must keep tolerating:
 # `reminders` (001_init.sql, never applied here) and the identity register `users`/`user_aliases`
 # (014_identity.sql) — without the register 083 rewrites nothing at all and only adds its
 # non-empty CHECKs, which is exactly what this probe proves still applies cleanly.
 applied=[]
 for p in sorted((repo/'services/box/sql').glob('[0-9][0-9][0-9]_*.sql')):
  if int(p.name[:3])>=39:applied.append(p.name);sql(p.read_text())
 # Independent of the glob/filter above: a directory listing plus a plain string check, so a
 # future glob-pattern mistake (the old '0[34]*.sql' silently stopped matching at 049 — 050 was
 # never applied here, and nothing said so) fails the image build instead of skipping a file.
 on_disk={q.name for q in (repo/'services/box/sql').iterdir() if q.name[:3].isdigit() and q.name.endswith('.sql') and int(q.name[:3])>=39}
 assert set(applied)==on_disk,f'Probe applied {sorted(applied)} but disk has {sorted(on_disk)} — a box migration was silently skipped'
 sql("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,state,runtime_control_token,pending) VALUES('canary','172.30.0.99','proof','owned','11111111-1111-4111-8111-111111111111','ready','11111111-1111-4111-8111-111111111111',false)")
 env={'DATABASE_URL':'postgres://proof@proof-db/proof','WORKFLOW_POSTGRES_URL':'postgres://proof@proof-db/proof','DATABASE_PASSWORD_FILE':'/secrets/password','GATEWAY_URL':'http://host.docker.internal:'+str(server.server_port),'GATEWAY_KEY_FILE':'/secrets/gateway','EVE_SAGA_ROUTE_PASSWORD_FILE':'/secrets/route','LARES_AGENT_NAME':'canary','LARES_DEFINITION_DIR':'/definition','LARES_AGENT_INCARNATION':'11111111-1111-4111-8111-111111111111','LARES_RUNTIME_CONTROL_SECRET_FILE':'/secrets/control','AGENT_OWNER_USER_ID':'fixture-owner','EVE_SCHEDULES_LIVE':'0','EVE_DIGEST_LIVE':'0','EVE_DREAM_LIVE':'0'}
 # W8A-s4: the image refuses BEFORE it serves anything when a required setting is missing. One
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
 client=root/'client.mjs';client.write_text("import {Client,isCurrentTurnBoundaryEvent} from '/app/services/chief-of-staff/node_modules/eve/dist/src/client/index.js';\nconst c=new Client({host:'http://127.0.0.1:3000',auth:{basic:{username:'eve-saga',password:'disposable-fixture-only'}}});let id=process.argv[2],watch=process.argv[4]==='watch',r,s;if(watch){s=c.sessions.attach(id,{streamIndex:Number(process.argv[3])});r={};for await(const e of s.stream()){if(e.type==='message.completed'&&e.data.finishReason!=='tool-calls')r.message=e.data.message??undefined;if(isCurrentTurnBoundaryEvent(e)){r.status=e.type==='session.waiting'?'waiting':e.type;break;}}}else if(id){s=c.sessions.attach(id,{streamIndex:Number(process.argv[3])});r=await(await s.send('Return another greeting.')).result();}else{const first=await c.sessions.create({message:'Return a short greeting.'});s=first.session;r=await first.response.result();}console.log(JSON.stringify({...s.state,message:r.message,status:r.status}));process.exit((watch?r.status==='waiting':r.message==='CI_IMAGE_TURN_OK')?0:1);\n")
 # watch=True sends NOTHING: it reads the conversation from session['streamIndex'] to the next turn boundary.
 def turn(session=None,watch=False,timeout=120):
  return json.loads(cmd('docker','exec',name+'-runtime','node','/probe/client.mjs',*([session['sessionId'],str(session['streamIndex'])]+(['watch'] if watch else []) if session else []),timeout=timeout))
 first=turn();assert requests,'No gateway request';assert 'UNIQUE_CI_MOUNTED_DUTIES' in json.dumps(requests[-1]),'Mounted instructions missing'
 expected_tools={'echo_note','agent-kit__market_edge'}
 def tool_names():return {t['name'] for t in requests[-1].get('tools',[])}
 assert expected_tools<=tool_names(),'Initial dynamic tools missing'
 old_alias=d['model'];d['model']='installation-writer';d['grants']=[];d['autonomy']={};d['skills']=[];(root/'definition/agent.json').write_text(json.dumps(d));(root/'definition/duties.md').write_text('UNIQUE_CI_NEW_DUTIES')
 # Session model state must survive a real process restart, not merely a module map.
 # LAR-73: a QUIET restart. Turn 1 has fully finished first, so this case tests what it claims (what a
 # conversation keeps across a restart) and cannot land inside the turn's finishing work.
 wait_quiet('after turn 1')
 cmd('docker','restart',name+'-runtime')
 wait_healthy()
 request_count=len(requests);second=turn(first);assert len(requests)>request_count,'No new model call after restart';assert requests[-1]['model']==old_alias;assert 'UNIQUE_CI_MOUNTED_DUTIES' in json.dumps(requests[-1])
 assert expected_tools<=tool_names(),'Existing conversation lost its tools after restart'
 third=turn();assert third['sessionId']!=first['sessionId'];assert requests[-1]['model']=='installation-writer';assert 'UNIQUE_CI_NEW_DUTIES' in json.dumps(requests[-1])
 assert not expected_tools&tool_names(),'New conversation exposed a removed catalogue grant or skill tool'
 # LAR-73 regression: a restart that lands INSIDE a turn. The model's reply is held, the process is
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
 # LAR-73: on any failure, show where the workflow runs actually stopped — an orphaned inline
 # step, a job still locked by the dead process, and a ':backstop:' job ~860 s out are the
 # three fingerprints of a restart that landed inside a turn's finishing work.
 for q in ["SELECT id,name,status,created_at,updated_at FROM workflow.workflow_runs ORDER BY created_at","SELECT run_id,step_id,step_name,status,attempt,started_at,completed_at FROM workflow.workflow_steps WHERE status<>'completed' ORDER BY created_at","SELECT id,key,attempts,max_attempts,run_at,locked_at,locked_by,left(last_error,160) AS err,now() FROM graphile_worker.jobs ORDER BY id","SELECT run_id,type,correlation_id,created_at FROM workflow.workflow_events ORDER BY created_at DESC LIMIT 40"]:
  r=subprocess.run(['docker','exec','-i',name+'-db','psql','-X','-U','proof','-d','proof','-c',q],capture_output=True,text=True);print(q+'\n'+r.stdout+r.stderr,flush=True)
 raise
finally:
 (root/'runtime.log').write_text(subprocess.run(['docker','logs',name+'-runtime'],capture_output=True,text=True).stdout+subprocess.run(['docker','logs',name+'-runtime'],capture_output=True,text=True).stderr)
 for n in ['runtime','db']:subprocess.run(['docker','rm','-f',name+'-'+n],capture_output=True)
 subprocess.run(['docker','network','rm',name],capture_output=True);server.shutdown();print('Probe artifacts:',root)
