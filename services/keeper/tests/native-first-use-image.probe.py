"""CI-only end-to-end first-use proof: compiled Eve, production Keeper and local fixtures."""
import hashlib, json, os, pathlib, re, secrets, select, shutil, subprocess, sys, tempfile, time, uuid

if os.environ.get('CI') != 'true':
    raise SystemExit('Combined native first-use proof runs only in disposable CI')
if len(sys.argv) != 5:
    raise SystemExit('usage: native-first-use-image.probe.py <chief-image> <keeper-image> <source-sha> <proof.json>')

def re_full_sha(value):
    normalized = value.lower() if isinstance(value, str) else ''
    return len(normalized) == 40 and all(char in '0123456789abcdef' for char in normalized)

chief_image, keeper_image, source_sha, proof_path = sys.argv[1:]
if not re_full_sha(source_sha):
    raise SystemExit('Combined proof needs the checked-out source identity')

repo = pathlib.Path(__file__).resolve().parents[3]
root = pathlib.Path(tempfile.mkdtemp(prefix='lares-native-first-use-')).resolve()
root.chmod(0o755)
secrets_dir = root / 'secrets'; secrets_dir.mkdir(mode=0o755)
offline_dir = root / 'offline'; offline_dir.mkdir(mode=0o700)
config_dir = root / 'config'; config_dir.mkdir(mode=0o700)
run_dir = root / 'socket-host-path-that-differs'; run_dir.mkdir(mode=0o755)
model_dir = run_dir / 'model-purpose'; model_dir.mkdir(mode=0o755)
agent_dir = root / 'agent'; agent_dir.mkdir(mode=0o755)
network = 'lares-first-use-' + uuid.uuid4().hex[:10]
volume = network + '-state'
network_created = False
volume_created = False
root_protected = False
container_names = []
cases = {}
proof = {'format': 1, 'sourceCommit': source_sha, 'images': {}, 'cases': cases,
         'scope': 'compiled Chief runtime plus production Keeper and guarded gateway; Console signing helper is source, not a built Console UI'}
stage = 'fixture-setup'

def run(*args, input=None, timeout=120, check=True, text=True):
    try:
        result = subprocess.run(args, input=input, text=text, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Disposable first-use fixture exceeded its time bound') from None
    if check and result.returncode:
        raise RuntimeError('Disposable first-use fixture command failed: ' + pathlib.Path(args[0]).name)
    return result

def output(*args, **kwargs): return run(*args, **kwargs).stdout.strip()
def docker(*args, **kwargs): return output('docker', *args, **kwargs)
def write_secret(name, value, mode=0o600):
    path = secrets_dir / name; path.write_text(value + '\n'); path.chmod(mode); return path
def write_raw_secret(name, value):
    path=secrets_dir/name;path.write_bytes(value if isinstance(value,bytes) else value.encode());path.chmod(0o600);return path
def write_offline(name, value):
    path = offline_dir / name; path.write_text(value + '\n'); path.chmod(0o600); return path
def neutral_first_use_definition(template_path, agent, alias):
    definition = json.loads(pathlib.Path(template_path).read_text())
    # The first-use fixture deliberately grants no capabilities. The role template's autonomy
    # entries are meaningful only alongside matching grants, so remove them with the grants.
    definition.update({'name':agent,'model':alias,'grants':[],'skills':[],'channels':[],'autonomy':{}})
    return definition
def sql(database, statement):
    return docker('exec', '-i', network + '-db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'proof', '-d', database, input=statement)
def wait_sql():
    for _ in range(120):
        result = run('docker','exec','-e','PGPASSWORD=disposable-first-use',network+'-db','psql','-h','127.0.0.1','-U','proof','-d','proof','-Atc','SELECT 1',check=False)
        if result.returncode == 0: return
        time.sleep(.25)
    raise RuntimeError('Disposable database did not become ready')
def keeper_run(*args, mount_state=True, timeout=120):
    cmd = ['docker','run','--rm','--network',network,'--read-only','--tmpfs','/tmp:rw,noexec,nosuid,nodev,mode=1777',
           '--mount',f'type=bind,src={secrets_dir},dst=/etc/lares/secrets,readonly',
           '--mount',f'type=bind,src={config_dir}/keeper.json,dst=/etc/lares/keeper.json,readonly',
           '--mount',f'type=bind,src={install_root},dst=/fixture-install']
    if mount_state: cmd += ['--mount',f'type=volume,src={volume},dst=/var/lib/lares']
    cmd += ['--mount',f'type=bind,src={offline_dir},dst=/offline,readonly','--entrypoint','/app/services/keeper/node_modules/.bin/tsx',keeper_image,*args]
    return output(*cmd,timeout=timeout)
def tsx_keeper(code, *, user='0:0', mounts=(), timeout=45):
    cmd=['docker','run','--rm','--network',network,'--read-only','--tmpfs','/tmp:rw,noexec,nosuid,nodev,mode=1777','--user',user,
         '--mount',f'type=bind,src={secrets_dir},dst=/etc/lares/secrets,readonly']
    cmd.extend(mounts)
    wrapped='void (async()=>{'+code+'})().catch(()=>{process.exitCode=2})'
    cmd += ['--entrypoint','/app/services/keeper/node_modules/.bin/tsx',keeper_image,'-e',wrapped]
    return output(*cmd,timeout=timeout)

FINANCIAL_OBSERVER_SQL = {
    'native': """SELECT i.state,i.reason,i.selected_endpoint,i.recovery_epoch,i.endpoint_generation,
      (SELECT count(*)::int FROM budget_attempts) AS attempts,
      (SELECT count(*)::int FROM budget_gateway_grants) AS grants,
      (SELECT count(*)::int FROM budget_attempts WHERE state='settled') AS settled,
      (SELECT json_build_object(
        'prepared',count(*) FILTER (WHERE state='prepared')::int,
        'retired',count(*) FILTER (WHERE state='retired')::int,
        'admitted',count(*) FILTER (WHERE state='admitted')::int,
        'unknown',count(*) FILTER (WHERE state='unknown')::int,
        'conflict',count(*) FILTER (WHERE state='conflict')::int,
        'settled',count(*) FILTER (WHERE state='settled')::int)
       FROM budget_attempts) AS attempt_states,
      (SELECT coalesce(sum(actual_amount),0)::text FROM budget_attempts WHERE state='settled') AS liability
      FROM budget_accounts i WHERE i.kind='installation'""",
    'bindings': """SELECT coalesce(json_agg(json_build_object('id',id,'state',state,
      'credentialGeneration',credential_generation) ORDER BY id),'[]'::json) AS bindings
      FROM budget_gateway_bindings""",
    'members': """SELECT coalesce(json_agg(json_build_object('memberId',live_member_id,'state',state)
      ORDER BY live_member_id),'[]'::json) AS members FROM budget_accounts WHERE kind='member'""",
}

def financial_observer(summary, financial_db):
    query = FINANCIAL_OBSERVER_SQL.get(summary)
    if query is None:
        raise RuntimeError('Unknown fixed financial observer summary')
    if (financial_db.get('user') != 'lares_financial' or
        financial_db.get('passwordFile') != '/etc/lares/secrets/financial-database-password'):
        raise RuntimeError('Financial observer requires the configured financial role')
    connection = {key: financial_db[key] for key in ('host','port','database','user')}
    wrapper = "import{Pool}from'pg';import{readFileSync}from'node:fs';" \
      + 'const c=' + json.dumps(connection) + ";const p=new Pool({...c,password:readFileSync('/etc/lares/secrets/financial-database-password','utf8').trim(),max:1,connectionTimeoutMillis:3000,options:'-c default_transaction_read_only=on'});" \
      + "try{const db=await p.connect();try{await db.query('BEGIN READ ONLY');const r=await db.query(" + json.dumps(query) + ");await db.query('COMMIT');console.log(JSON.stringify(r.rows[0]??null));}finally{db.release();}}finally{await p.end();}"
    script=root/'financial-observer.mts';script.write_text(wrapper)
    password_file=secrets_dir/'financial-database-password'
    return output('docker','run','--rm','--network',network,'--user','0:0','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,nodev,mode=1777',
      '--mount',f'type=bind,src={password_file},dst=/etc/lares/secrets/financial-database-password,readonly',
      '--mount',f'type=bind,src={script},dst=/app/services/keeper/financial-observer.mts,readonly',
      '--entrypoint','/app/services/keeper/node_modules/.bin/tsx',keeper_image,'/app/services/keeper/financial-observer.mts')

def compiled_chief_start_args(*, chief_name, network, agent_dir, run_dir, capsule_source,
                              client_script, chief_image, secrets_dir, agent, incarnation, owner,
                              definition_hash, workflow_database):
    runtime_environment={
      'DATABASE_URL':'postgres://lares_app@proof-db:5432/proof',
      'WORKFLOW_POSTGRES_URL':f'postgres://lares_workflow@proof-db:5432/{workflow_database}',
      'DATABASE_PASSWORD_FILE':'/run/secrets/app-password',
      'WORKFLOW_POSTGRES_PASSWORD_FILE':'/run/secrets/workflow-password',
      'GATEWAY_URL':'http://native-gateway:4000',
      'EVE_ROUTE_PASSWORD_FILE':'/run/secrets/route-password',
      'LARES_AGENT_NAME':agent,
      'LARES_DEFINITION_DIR':'/definition',
      'LARES_AGENT_INCARNATION':incarnation,
      'LARES_RUNTIME_CONTROL_SECRET_FILE':'/run/secrets/runtime-control',
      'LARES_MODEL_PURPOSE_RUNTIME_SOCKET':'/run/lares/model-purpose/model-purpose.sock',
      'AGENT_OWNER_USER_ID':owner,
      'EVE_SCHEDULES_LIVE':'0','EVE_DIGEST_LIVE':'0','EVE_DREAM_LIVE':'0',
      'FIRST_USE_DEFINITION_HASH':definition_hash,
    }
    args=['run','-d','--name',chief_name,'--network',network,'--read-only','--user','10001:10001',
      '--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:uid=10001,gid=10001,mode=1770',
      '--tmpfs','/app/services/chief-of-staff/.eve/sandbox-cache:uid=10001,gid=10001,mode=0700,size=256m',
      '--tmpfs','/app/services/chief-of-staff/.eve/.workflow-data:uid=10001,gid=10001,mode=0700,size=64m',
      '--tmpfs','/app/services/chief-of-staff/node_modules/.cache:uid=10001,gid=10001,mode=0700,size=384m',
      '--mount',f'type=bind,src={agent_dir},dst=/definition,readonly',
      '--mount',f'type=bind,src={run_dir},dst=/run/lares,readonly',
      '--mount',f'type=bind,src={secrets_dir}/app-password,dst=/run/secrets/app-password,readonly',
      '--mount',f'type=bind,src={secrets_dir}/workflow-password,dst=/run/secrets/workflow-password,readonly',
      '--mount',f'type=bind,src={secrets_dir}/route-password,dst=/run/secrets/route-password,readonly',
      '--mount',f'type=bind,src={secrets_dir}/proof-agent-runtime-control,dst=/run/secrets/runtime-control,readonly',
      '--mount',f'type=bind,src={secrets_dir}/console-model-purpose-signing-key,dst=/run/secrets/console-model-purpose-signing-key,readonly',
      '--mount',f'type=bind,src={capsule_source},dst=/app/services/chief-of-staff/model-purpose-capsule.ts,readonly',
      '--mount',f'type=bind,src={client_script},dst=/app/services/chief-of-staff/first-use-client.mts,readonly']
    for key,value in runtime_environment.items():args.extend(['-e',key+'='+value])
    args.append(chief_image)
    return args

def safe_startup_container_state(*, found, status='', running=False, exit_code=None, oom_killed=False):
    allowed_statuses={'created','restarting','running','removing','paused','exited','dead'}
    try: parsed_exit_code=int(exit_code)
    except (TypeError,ValueError): parsed_exit_code=None
    if parsed_exit_code is not None and not 0<=parsed_exit_code<=255: parsed_exit_code=None
    return {'found':found is True,'status':status if status in allowed_statuses else 'unknown',
      'running':running is True,'exitCode':parsed_exit_code,'oomKilled':oom_killed is True}

def safe_startup_log_categories(log_text):
    # Inspect only a bounded tail and return fixed booleans. Never place log bytes in proof output.
    text=str(log_text)[-32768:].lower()
    # These names and line prefixes match the committed generated guard. Anchor at the line
    # start and include its punctuation so longer identifiers and quoted log text cannot match.
    file_settings=('DATABASE_PASSWORD_FILE','WORKFLOW_POSTGRES_PASSWORD_FILE','GATEWAY_KEY_FILE')
    value_settings=('DATABASE_URL','WORKFLOW_POSTGRES_URL','GATEWAY_URL',
                    'LARES_AGENT_NAME','LARES_DEFINITION_DIR')
    patterns={'missingSettings':r'(?m)^lares: (?:'+'|'.join(
      name.lower() for name in value_settings + file_settings)+r') is not set\. '}
    for name in value_settings + file_settings:
      patterns['unset_'+name]=rf'(?m)^lares: {name.lower()} is not set\. '
    for name in file_settings:
      patterns['unreadable_'+name]=rf'(?m)^lares: {name.lower()} points to a file that does not exist or cannot be read \('
      patterns['empty_'+name]=rf'(?m)^lares: {name.lower()} points to a file that exists but is empty \('
    patterns.update({
      'managedIncarnationInvalid':r'(?m)^lares: managed incarnation is invalid$',
      'managedSocketNotConfigured':r'(?m)^lares: managed model-purpose socket is not configured$',
      'runtimeControlFileUnavailable':r'(?m)^lares: runtime-control file is missing, unreadable, or empty$',
      'modelPurposeSocketUnavailable':r'(?m)^lares: model-purpose runtime socket is unavailable$',
      'gatewayRuntimeSocketUnavailable':r'(?m)^lares: model-purpose gateway socket is unavailable$',
      'workflowCredentialsUnavailable':r'(?m)^lares: workflow database credentials are unavailable\.$',
      'invalidConfiguration':r'invalid config|configuration error|failed to load config',
      'moduleResolution':r'err_module_not_found|cannot find (?:package|module)',
      'permissionDenied':r'eacces|permission denied',
      'readOnlyFilesystem':r'erofs|read-only file system',
      'databaseUnavailable':r'econnrefused|database connection|password authentication failed',
      'addressInUse':r'eaddrinuse|address already in use',
      'memoryExhaustion':r'heap out of memory|out of memory|oomkilled',
    })
    return {name:re.search(pattern,text) is not None for name,pattern in patterns.items()}

COMPILED_CLIENT_PHASES={'imports','session-create','session-bind','capsule-sign','send','stream-auth','turn-result','refusalchecks','complete'}
COMPILED_CLIENT_PHASE_FILE='/tmp/first-use-phase-first'
COMPILED_CLIENT_RESULT_FILE='/tmp/first-use-result-diagnostic-first'
COMPILED_CLIENT_RESULT_EVENTS={'step.failed','turn.failed','session.failed'}
COMPILED_CLIENT_RESULT_CODES={'budget_admission_refused','budget_exceeded','model_purpose_dispatch_unavailable',
    'invalid_request','request_policy_rejected','body_too_large','unsupported_request_field','timeout','aborted',
    'ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT','unknown'}
COMPILED_CLIENT_RESULT_CATEGORIES={'localDispatchUnavailable','nativeAdmissionRefused','timeoutAbort',
    'socketUnavailable','requestPolicyRejected','unknown'}
COMPILED_CLIENT_RESULT_STATUSES={'completed','failed','waiting','unknown'}
MODEL_REQUEST_DIAGNOSTIC_STAGES={'runtime-check','headers','body','profile','native-dispatch','native-response'}
MODEL_REQUEST_DIAGNOSTIC_CHECKS={'anthropicBetaPresent','authorizationPresent','apiKeyPresent','ticketPresent','contentTypeJson',
    'modelAliasAllowed','messagesIsList','maxTokensAllowed','physicalDispatchObserved'}

def validated_model_request_diagnostic(raw):
    if len(raw)>2048:return 'unknown'
    try:parsed=json.loads(raw)
    except (TypeError,ValueError):return 'unknown'
    expected={'schema','requestCount','stage','statusCode','checks','unknownHeaderCount','duplicateHeaderCount','unknownBodyFieldCount'}
    if (type(parsed) is not dict or set(parsed)!=expected or type(parsed.get('schema')) is not int or parsed['schema']!=1 or
        type(parsed.get('requestCount')) is not int or parsed['requestCount'] not in (0,1) or
        parsed.get('stage') not in MODEL_REQUEST_DIAGNOSTIC_STAGES or
        type(parsed.get('statusCode')) is not int or not 0<=parsed['statusCode']<=599 or
        any(type(parsed.get(name)) is not int or not 0<=parsed[name]<=31 for name in ('unknownHeaderCount','duplicateHeaderCount','unknownBodyFieldCount')) or
        type(parsed.get('checks')) is not dict or set(parsed['checks'])!=MODEL_REQUEST_DIAGNOSTIC_CHECKS or
        any(type(value) is not bool for value in parsed['checks'].values())):return 'unknown'
    return parsed

def gateway_model_request_diagnostic(name):
    path=root/'gateway-model-request-diagnostic.json'
    try:
        copied=run('docker','cp',name+':/tmp/lares-gateway-model-request.json',str(path),check=False,timeout=5)
        if copied.returncode!=0 or not path.is_file() or path.stat().st_size>2048:return 'unknown'
        return validated_model_request_diagnostic(path.read_bytes())
    except Exception:return 'unknown'

def invoke_first_use_and_capture(invoke, collect, proof):
    """Collect bounded gateway metadata on both success and failure, before fixture cleanup."""
    try:
        result=invoke()
    except Exception:
        try:proof['gatewayModelRequestDiagnostic']=collect()
        except Exception:proof['gatewayModelRequestDiagnostic']='unknown'
        raise
    try:proof['gatewayModelRequestDiagnostic']=collect()
    except Exception:proof['gatewayModelRequestDiagnostic']='unknown'
    return result

def unknown_compiled_client_result_summary():
    return {'markerValid':False,'outcome':'unknown','resultStatus':'unknown','expectedMessage':None,
      'failureEventCount':0,'failureEvents':{'step':False,'turn':False,'session':False},'events':[],
      'categories':{'localDispatchUnavailable':False,'nativeAdmissionRefused':False,'timeoutAbort':False,
        'socketUnavailable':False,'requestPolicyRejected':False,'unknown':True},'clientStatus':None}

def safe_compiled_client_result_summary(stdout, returncode):
    invalid=unknown_compiled_client_result_summary()
    if returncode!=0 or not isinstance(stdout,str) or len(stdout.encode('utf-8'))>2048:return invalid
    try:parsed=json.loads(stdout)
    except (TypeError,ValueError):return invalid
    expected={'schema','outcome','resultStatus','expectedMessage','failureEventCount','failureEvents','events','categories','clientStatus'}
    if (not isinstance(parsed,dict) or set(parsed)!=expected or type(parsed.get('schema')) is not int or parsed.get('schema')!=1 or
        not isinstance(parsed.get('outcome'),str) or parsed['outcome'] not in {'returned','thrown'} or
        not isinstance(parsed.get('resultStatus'),str) or parsed['resultStatus'] not in COMPILED_CLIENT_RESULT_STATUSES):return invalid
    if (type(parsed.get('failureEventCount')) is not int or not 0<=parsed['failureEventCount']<=1000000 or
        not isinstance(parsed.get('failureEvents'),dict) or set(parsed['failureEvents'])!={'step','turn','session'} or
        any(type(value) is not bool for value in parsed['failureEvents'].values())):return invalid
    if not isinstance(parsed.get('events'),list) or len(parsed['events'])>8:return invalid
    event_keys={'event','code','statusCode','upstreamStatusCode'}
    for item in parsed['events']:
        if (not isinstance(item,dict) or set(item)!=event_keys or not isinstance(item.get('event'),str) or
            item['event'] not in COMPILED_CLIENT_RESULT_EVENTS or not isinstance(item.get('code'),str) or
            item['code'] not in COMPILED_CLIENT_RESULT_CODES):return invalid
        for key in ('statusCode','upstreamStatusCode'):
            value=item.get(key)
            if value is not None and (type(value) is not int or not 100<=value<=599):return invalid
    categories=parsed.get('categories')
    if (not isinstance(categories,dict) or set(categories)!=COMPILED_CLIENT_RESULT_CATEGORIES or
        any(type(value) is not bool for value in categories.values())):return invalid
    if parsed.get('clientStatus') is not None and (type(parsed['clientStatus']) is not int or not 100<=parsed['clientStatus']<=599):return invalid
    if parsed['outcome']=='returned':
        if type(parsed.get('expectedMessage')) is not bool or parsed['clientStatus'] is not None:return invalid
    elif parsed.get('expectedMessage') is not None or parsed['resultStatus']!='unknown' or parsed['events'] or parsed['failureEventCount'] or any(parsed['failureEvents'].values()):return invalid
    return {'markerValid':True,**{key:parsed[key] for key in expected if key!='schema'}}

def safe_compiled_client_phase_summary(stdout, returncode):
    invalid={'phase':'unknown','markerValid':False}
    if returncode!=0 or not isinstance(stdout,str) or len(stdout)>128:return invalid
    try:parsed=json.loads(stdout)
    except (TypeError,ValueError):return invalid
    if (not isinstance(parsed,dict) or set(parsed)!={'phase','valid'} or parsed.get('valid') is not True or
        not isinstance(parsed.get('phase'),str) or parsed['phase'] not in COMPILED_CLIENT_PHASES):return invalid
    return {'phase':parsed['phase'],'markerValid':True}

def initialize_compiled_client_phase(chief_name):
    script="const fs=require('node:fs');fs.writeFileSync("+json.dumps(COMPILED_CLIENT_PHASE_FILE)+",'{\"phase\":\"imports\"}',{mode:0o600});try{fs.unlinkSync("+json.dumps(COMPILED_CLIENT_RESULT_FILE)+")}catch{}"
    try:result=run('docker','exec',chief_name,'node','-e',script,check=False,timeout=5)
    except Exception:return False
    return result.returncode==0

def compiled_client_phase_summary(chief_name):
    reader="""const fs=require('node:fs');const allowed=['imports','session-create','session-bind','capsule-sign','send','stream-auth','turn-result','refusalchecks','complete'];let out={phase:'unknown',valid:false};try{const s=fs.statSync(MARKER);if(!s.isFile()||s.size>128)throw Error();const x=JSON.parse(fs.readFileSync(MARKER,'utf8'));if(x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===1&&Object.keys(x)[0]==='phase'&&allowed.includes(x.phase))out={phase:x.phase,valid:true};}catch{}process.stdout.write(JSON.stringify(out));""".replace('MARKER',json.dumps(COMPILED_CLIENT_PHASE_FILE))
    try:result=run('docker','exec',chief_name,'node','-e',reader,check=False,timeout=5)
    except Exception:return {'phase':'unknown','markerValid':False}
    return safe_compiled_client_phase_summary(result.stdout,result.returncode)

def compiled_client_result_summary(chief_name):
    reader="""const fs=require('node:fs');let out={unknown:true};try{const s=fs.statSync(MARKER);if(!s.isFile()||s.size>2048)throw Error();out=JSON.parse(fs.readFileSync(MARKER,'utf8'));}catch{}process.stdout.write(JSON.stringify(out));""".replace('MARKER',json.dumps(COMPILED_CLIENT_RESULT_FILE))
    try:result=run('docker','exec',chief_name,'node','-e',reader,check=False,timeout=5)
    except Exception:return unknown_compiled_client_result_summary()
    return safe_compiled_client_result_summary(result.stdout,result.returncode)

ADMISSION_BRIDGE_STATUS_BUCKETS={'200','400','401','403','408','409','413','429','500','502','503','504','other'}
ADMISSION_BRIDGE_ROUTES={'admit','settle'}

def unknown_admission_bridge_summary():
    return {'markerValid':False,'routes':{route:None for route in sorted(ADMISSION_BRIDGE_ROUTES)}}

def safe_admission_bridge_summary(stdout, returncode):
    invalid=unknown_admission_bridge_summary()
    if returncode!=0 or not isinstance(stdout,str) or len(stdout.encode('utf-8'))>2048:return invalid
    try:parsed=json.loads(stdout)
    except (TypeError,ValueError):return invalid
    if not isinstance(parsed,dict) or set(parsed)!={'schema','routes'} or type(parsed.get('schema')) is not int or parsed['schema']!=1:return invalid
    routes=parsed.get('routes')
    if not isinstance(routes,dict) or set(routes)!=ADMISSION_BRIDGE_ROUTES:return invalid
    safe={}
    for route,entry in routes.items():
        if not isinstance(entry,dict) or set(entry)!={'requests','statuses'}:return invalid
        if type(entry.get('requests')) is not int or not 0<=entry['requests']<=1000000:return invalid
        statuses=entry.get('statuses')
        if (not isinstance(statuses,dict) or set(statuses)!=ADMISSION_BRIDGE_STATUS_BUCKETS or
            any(type(value) is not int or not 0<=value<=1000000 for value in statuses.values()) or
            sum(statuses.values())>entry['requests']):return invalid
        safe[route]={'requests':entry['requests'],'statuses':statuses}
    return {'markerValid':True,'routes':safe}

def admission_bridge_summary():
    reader="const https=require('node:https');const q=https.get({hostname:'127.0.0.1',port:8443,path:'/__diagnostics',rejectUnauthorized:false,timeout:1500},r=>{let s='';r.setEncoding('utf8');r.on('data',x=>{if(s.length<2049)s+=x});r.on('end',()=>{process.stdout.write(JSON.stringify({status:r.statusCode,body:s}));});});q.on('timeout',()=>q.destroy());q.on('error',()=>process.exitCode=1);"
    try:result=run('docker','exec',network+'-admission-bridge','node','-e',reader,check=False,timeout=3)
    except Exception:return unknown_admission_bridge_summary()
    if result.returncode!=0:return unknown_admission_bridge_summary()
    try:wrapper=json.loads(result.stdout)
    except (TypeError,ValueError):return unknown_admission_bridge_summary()
    if not isinstance(wrapper,dict) or set(wrapper)!={'status','body'} or wrapper.get('status')!=200 or not isinstance(wrapper.get('body'),str):
        return unknown_admission_bridge_summary()
    return safe_admission_bridge_summary(wrapper['body'],0)

def admission_bridge_delta(before, after):
    if not before.get('markerValid') or not after.get('markerValid'):return unknown_admission_bridge_summary()
    routes={}
    for route in sorted(ADMISSION_BRIDGE_ROUTES):
        old=before['routes'].get(route);new=after['routes'].get(route)
        if old is None or new is None or new['requests']<old['requests']:return unknown_admission_bridge_summary()
        requests=new['requests']-old['requests'];statuses={}
        for bucket in ADMISSION_BRIDGE_STATUS_BUCKETS:
            if new['statuses'][bucket]<old['statuses'][bucket]:return unknown_admission_bridge_summary()
            statuses[bucket]=new['statuses'][bucket]-old['statuses'][bucket]
        if sum(statuses.values())>requests:return unknown_admission_bridge_summary()
        routes[route]={'requests':requests,'statuses':statuses}
    return {'markerValid':True,'routes':routes}

def bounded_compiled_runtime_logs(name):
    process=None
    try:
        process=subprocess.Popen(['docker','logs','--tail','40',name],stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        captured=bytearray()
        deadline=time.monotonic()+5
        if process.stdout is not None:
            while True:
                remaining=deadline-time.monotonic()
                if remaining<=0:break
                ready,_,_=select.select([process.stdout],[],[],remaining)
                if not ready:break
                chunk=os.read(process.stdout.fileno(),4096)
                if not chunk:break
                captured.extend(chunk)
                if len(captured)>32768:del captured[:-32768]
        return captured[-32768:].decode('utf-8','replace')
    except Exception:
        return ''
    finally:
        if process is not None:
            try:
                if process.poll() is None:process.kill()
            except Exception:pass
            try:process.wait(timeout=2)
            except Exception:
                try:
                    process.kill()
                    process.wait(timeout=2)
                except Exception:pass

def compiled_startup_diagnostics(name, *, failed_stage, launch_result=None, launch_timed_out=False):
    state_result=run('docker','inspect','--format',
      '{{.State.Status}}|{{.State.Running}}|{{.State.ExitCode}}|{{.State.OOMKilled}}',
      name,check=False,timeout=10)
    state_fields=state_result.stdout.strip().split('|') if state_result.returncode==0 else []
    state=safe_startup_container_state(
      found=state_result.returncode==0,
      status=state_fields[0] if len(state_fields)==4 else '',
      running=len(state_fields)==4 and state_fields[1]=='true',
      exit_code=state_fields[2] if len(state_fields)==4 else None,
      oom_killed=len(state_fields)==4 and state_fields[3]=='true')
    bounded_logs=bounded_compiled_runtime_logs(name) if state['found'] else ''
    if launch_result is not None:
        bounded_logs=(bounded_logs+'\n'+launch_result.stdout[-32768:])[-32768:]
    return {'stage':failed_stage,
      'dockerRunExitCode':launch_result.returncode if launch_result is not None else None,
      'dockerRunTimedOut':launch_timed_out is True,
      'container':state,
      'startupCategories':safe_startup_log_categories(bounded_logs)}

def register_compiled_chief_container(name, container_names, *, created_by_success=False):
    if name!=network+'-chief':return False
    if created_by_success:
        if name not in container_names:container_names.append(name)
        return True
    inspected=run('docker','inspect','--format','{{.State.Status}}',name,check=False,timeout=10)
    if inspected.returncode!=0:return False
    if name not in container_names:container_names.append(name)
    return True

def initial_budget_client_args(*, network, run_dir, token_file, client_source,
                               client_script, keeper_image):
    return ['docker','run','--rm','--network',network,'--read-only','--user','0:0',
      '--tmpfs','/tmp:rw,noexec,nosuid,nodev,mode=1777,size=16m',
      '--mount',f'type=bind,src={run_dir},dst=/run/lares,readonly',
      '--mount',f'type=bind,src={token_file},dst=/fixture/owner-session-token,readonly',
      '--mount',f'type=bind,src={client_source},dst=/app/services/console/lib/keeper-client.ts,readonly',
      '--mount',f'type=bind,src={client_script},dst=/app/services/keeper/initial-budget-client.mts,readonly',
      '--entrypoint','/app/services/keeper/node_modules/.bin/tsx',keeper_image,
      '/app/services/keeper/initial-budget-client.mts']

def selected_members_match_first_activation(selected, member_ids):
    return (len(selected)==2 and
      selected[0].get('memberId')==member_ids[0] and selected[0].get('state')=='open' and
      selected[1].get('memberId')==member_ids[1] and selected[1].get('state')=='closed')

def image_identity(image):
    value=docker('image','inspect','--format','{{.Id}}',image)
    if not value.startswith('sha256:') or len(value)!=71: raise RuntimeError('Image identity was unavailable')
    return value

try:
    stage = 'image-identity'
    proof['images']={'chief':image_identity(chief_image),'keeper':image_identity(keeper_image)}
    application_password=secrets.token_urlsafe(32);financial_password=secrets.token_urlsafe(32)
    operator_password=secrets.token_urlsafe(32);workflow_provisioner_password=secrets.token_urlsafe(32)
    workflow_password=secrets.token_urlsafe(32);route_password=secrets.token_urlsafe(32)
    gateway_master='sk-'+secrets.token_urlsafe(32)
    console_signing=secrets.token_hex(32)
    incarnation=str(uuid.uuid4())
    owner='first-use-owner';members=['first-use-member-a','first-use-member-b'];agent='proof-agent';alias='lares-brain'
    owner_session_token=secrets.token_urlsafe(32)
    if len(owner_session_token)!=43:raise RuntimeError('Fixture owner session token was not canonical')
    owner_token_dir=root/'owner-session';owner_token_dir.mkdir(mode=0o700)
    owner_token_file=owner_token_dir/'token';owner_token_file.write_text(owner_session_token);owner_token_file.chmod(0o600)
    owner_session_token_hash=hashlib.sha256(owner_session_token.encode()).hexdigest()
    del owner_session_token
    write_raw_secret('app-password',application_password);write_raw_secret('financial-database-password',financial_password)
    write_secret('workflow-password',workflow_password);write_secret('route-password',route_password)
    (secrets_dir/'workflow-provisioner-password').write_text(workflow_provisioner_password+'\n')
    (secrets_dir/'workflow-provisioner-password').chmod(0o600)
    write_raw_secret('gateway-master',gateway_master)
    write_offline('operator-password',operator_password);write_offline('workflow-provisioner-password',workflow_provisioner_password)
    # Console's production signer requires root-owned, group-readable 0440 key custody.
    signer=secrets_dir/'console-model-purpose-signing-key';signer.write_text(console_signing+'\n');signer.chmod(0o440)
    stage = 'isolated-network-create'
    docker('network','create','--internal',network)
    network_created = True
    stage = 'isolated-volume-create'
    docker('volume','create',volume)
    volume_created = True
    stage = 'isolated-postgres-start'
    docker('run','-d','--name',network+'-db','--network',network,'--network-alias','proof-db',
           '-e','POSTGRES_USER=proof','-e','POSTGRES_PASSWORD=disposable-first-use','-e','POSTGRES_DB=proof','pgvector/pgvector:pg16')
    container_names.append(network+'-db')
    stage = 'isolated-postgres-readiness'
    wait_sql()
    migrations=sorted((repo/'services/box/sql').glob('[0-9][0-9][0-9]_*.sql'))
    for migration in migrations:
        stage = 'isolated-migration-' + migration.name
        sql('proof',migration.read_text())
    stage = 'isolated-migration-inventory'
    on_disk={p.name for p in (repo/'services/box/sql').iterdir() if p.name[:3].isdigit() and p.name.endswith('.sql')}
    if {p.name for p in migrations}!=on_disk or '001_baseline.sql' not in on_disk: raise RuntimeError('Engine schema migration inventory was incomplete')
    stage = 'isolated-operator-role-create'
    sql('proof',f"CREATE ROLE lares_operator LOGIN SUPERUSER PASSWORD '{operator_password}'")
    privilege=root/'engine-privileges.mts'
    stage = 'isolated-engine-privilege-script'
    privilege.write_text("import{Pool}from'pg';import{readFileSync}from'node:fs';import{provisionEngineDatabasePrivileges}from'/app/services/box/lib/database-privileges.ts';const p=new Pool({host:'proof-db',database:'proof',user:'lares_operator',password:readFileSync('/offline/operator-password','utf8').trim(),max:1});try{const c=await p.connect();try{const r=await provisionEngineDatabasePrivileges(c,{expectedDatabase:'proof',passwords:{application:readFileSync('/etc/lares/secrets/app-password'),financial:readFileSync('/etc/lares/secrets/financial-database-password')}});if(!['applied','verified'].includes(r.status))throw Error();}finally{c.release()}console.log('ready')}finally{await p.end()}\n")
    stage = 'isolated-engine-privilege-helper'
    result=run('docker','run','--rm','--network',network,'--user','0:0','--mount',f'type=bind,src={secrets_dir},dst=/etc/lares/secrets,readonly','--mount',f'type=bind,src={offline_dir},dst=/offline,readonly','--mount',f'type=bind,src={privilege},dst=/app/services/keeper/engine-privileges.mts,readonly','--entrypoint','/app/services/keeper/node_modules/.bin/tsx',keeper_image,'/app/services/keeper/engine-privileges.mts')
    stage = 'isolated-engine-privilege-result'
    if result.stdout.strip()!='ready': raise RuntimeError('Engine role grants were not prepared by the production helper')
    cases['schemaAndRestrictedEngineRoles']=True

    stage = 'workflow-readiness-fixture'
    # Real workflow template, cloned database owner marker and runtime ACL, as the existing
    # compiled-runtime image fixture does. This leaves a single complete ready row for Keeper.
    sql('proof',f"CREATE ROLE lares_workflow_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE lares_workflow_provisioner LOGIN NOINHERIT CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{workflow_provisioner_password}'; CREATE ROLE lares_workflow LOGIN NOINHERIT NOCREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{workflow_password}'; GRANT lares_workflow_owner TO lares_workflow_provisioner; CREATE DATABASE empty_workflow OWNER lares_workflow_owner")
    template_setup=root/'workflow-template.mts'
    template_setup.write_text("import{Pool}from'pg';import{readFileSync}from'node:fs';import{setupDatabase}from'@workflow/world-postgres/cli';process.env.PGPASSWORD=readFileSync('/offline/workflow-provisioner-password','utf8').trim();process.env.PGOPTIONS='-c role=lares_workflow_owner';process.env.WORKFLOW_POSTGRES_URL='postgres://lares_workflow_provisioner@proof-db:5432/empty_workflow';const p=new Pool({connectionString:process.env.WORKFLOW_POSTGRES_URL,max:1});try{const r=await p.query('select current_user,session_user');if(r.rows[0].current_user!=='lares_workflow_owner'||r.rows[0].session_user!=='lares_workflow_provisioner')throw Error()}finally{await p.end()}await setupDatabase();\n")
    # Mount fixture source at its required path in the compiled Chief dependency tree.
    run('docker','run','--rm','--network',network,'--user','0:0','--mount',f'type=bind,src={offline_dir},dst=/offline,readonly','--mount',f'type=bind,src={template_setup},dst=/app/services/chief-of-staff/workflow-template.mts,readonly','--entrypoint','/app/services/chief-of-staff/node_modules/.bin/tsx',chief_image,'/app/services/chief-of-staff/workflow-template.mts')
    sql('proof','ALTER DATABASE empty_workflow IS_TEMPLATE true')
    workflow_database='lares_'+uuid.uuid4().hex
    sql('proof',f'CREATE DATABASE "{workflow_database}" OWNER lares_workflow_owner TEMPLATE empty_workflow')
    workflow_owner=incarnation
    sql('proof',f"COMMENT ON DATABASE \"{workflow_database}\" IS 'lares-owned:{workflow_owner}'")
    acl=root/'workflow-acl.mts'
    acl.write_text("import{Pool}from'pg';import{readFileSync}from'node:fs';import{applyWorkflowRuntimePrivileges,verifyWorkflowRuntimePrivileges}from'/app/services/box/lib/workflow-database-privileges.ts';process.env.PGPASSWORD=readFileSync('/offline/workflow-provisioner-password','utf8').trim();process.env.PGOPTIONS='-c role=lares_workflow_owner';const p=new Pool({connectionString:'postgres://lares_workflow_provisioner@proof-db:5432/"+workflow_database+"',max:1});try{const c=await p.connect();try{await applyWorkflowRuntimePrivileges(c);await c.query('RESET ROLE')}finally{c.release()}}finally{await p.end()}delete process.env.PGOPTIONS;const r=new Pool({host:'proof-db',database:'"+workflow_database+"',user:'lares_workflow',password:readFileSync('/etc/lares/secrets/workflow-password','utf8').trim(),max:1});try{const c=await r.connect();try{await verifyWorkflowRuntimePrivileges(c)}finally{c.release()}}finally{await r.end()}console.log('ready')\n")
    run('docker','run','--rm','--network',network,'--user','0:0','--mount',f'type=bind,src={offline_dir},dst=/offline,readonly','--mount',f'type=bind,src={secrets_dir},dst=/etc/lares/secrets,readonly','--mount',f'type=bind,src={acl},dst=/app/services/chief-of-staff/workflow-acl.mts,readonly','--mount',f'type=bind,src={repo}/services/box/lib/workflow-database-privileges.ts,dst=/app/services/box/lib/workflow-database-privileges.ts,readonly','--entrypoint','/app/services/chief-of-staff/node_modules/.bin/tsx',chief_image,'/app/services/chief-of-staff/workflow-acl.mts')
    cases['completeWorkflowOwnershipAndAcl']=True

    stage = 'pinned-production-gateway-and-local-upstream'
    # The only provider is a deterministic TLS server on this internal fixture network.
    # Its one model route is the actual Anthropic route used by the production adapter.
    tls_dir=root/'tls';tls_dir.mkdir(mode=0o700)
    ca_key=tls_dir/'ca-key.pem';ca=tls_dir/'ca.pem';server_key=tls_dir/'server-key.pem';csr=tls_dir/'server.csr';cert=tls_dir/'server.pem';ext=tls_dir/'server.ext'
    ext.write_text('subjectAltName=DNS:synthetic-provider,DNS:admission-bridge\nextendedKeyUsage=serverAuth\n')
    run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(ca_key),'-out',str(ca),'-days','1','-subj','/CN=Lares disposable first-use CA',timeout=30)
    run('openssl','req','-newkey','rsa:2048','-nodes','-keyout',str(server_key),'-out',str(csr),'-subj','/CN=synthetic-provider',timeout=30)
    run('openssl','x509','-req','-in',str(csr),'-CA',str(ca),'-CAkey',str(ca_key),'-CAcreateserial','-out',str(cert),'-days','1','-extfile',str(ext),timeout=30)
    for path in (ca_key,server_key):path.chmod(0o440)
    for path in (ca,cert,csr,ext):path.chmod(0o444)
    tls_runtime=root/'tls-runtime';tls_runtime.mkdir(mode=0o755)
    for source,name in ((ca,'ca.pem'),(server_key,'server-key.pem'),(cert,'server.pem')):
        shutil.copyfile(source,tls_runtime/name)
    (tls_runtime/'ca.pem').chmod(0o444);(tls_runtime/'server.pem').chmod(0o444);(tls_runtime/'server-key.pem').chmod(0o440)
    root_protected=True
    tls_protection='chown 0:10001 /fixture/server-key.pem && chmod 440 /fixture/server-key.pem && test "$(stat -c %u:%g:%a /fixture/server-key.pem)" = 0:10001:440'
    run('docker','run','--rm','--network','none','--user','0:0','--mount',f'type=bind,src={tls_runtime},dst=/fixture',
      '--entrypoint','sh',keeper_image,'-c',tls_protection,timeout=30)
    upstream=root/'upstream.mjs';upstream.write_text("""import https from'node:https';import http from'node:http';import{readFileSync}from'node:fs';
let calls=0;const max=1048576;
const tls={key:readFileSync('/fixture/tls/server-key.pem'),cert:readFileSync('/fixture/tls/server.pem')};
https.createServer(tls,(q,s)=>{if(q.method!=='POST'||q.url!=='/v1/messages'){s.writeHead(404,{'content-length':'0'}).end();return}let size=0,parts=[];q.on('data',x=>{size+=x.length;if(size>max){s.destroy();return}parts.push(x)});q.on('end',()=>{if(size>max)return;let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{s.writeHead(400,{'content-length':'0'}).end();return}calls++;const message={id:'msg_first_use',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'FIRST_USE_OK'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:12,output_tokens:4}};if(!body.stream){const raw=Buffer.from(JSON.stringify(message));s.writeHead(200,{'content-type':'application/json','content-length':String(raw.length)});s.end(raw);return}const start={...message,content:[],stop_reason:null,usage:{input_tokens:12,output_tokens:0}};const events=[['message_start',{type:'message_start',message:start}],['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'FIRST_USE_OK'}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:4}}],['message_stop',{type:'message_stop'}]];const raw=Buffer.from(events.map(([kind,data])=>'event: '+kind+'\\ndata: '+JSON.stringify(data)+'\\n\\n').join(''));s.writeHead(200,{'content-type':'text/event-stream','content-length':String(raw.length)});s.end(raw)})}).listen(8443,'0.0.0.0');
http.createServer((q,s)=>{if(q.method!=='GET'||q.url!=='/control'){s.writeHead(404,{'content-length':'0'}).end();return}const raw=Buffer.from(JSON.stringify({calls}));s.writeHead(200,{'content-type':'application/json','content-length':String(raw.length)});s.end(raw)}).listen(8081,'127.0.0.1');
""")
    docker('run','-d','--name',network+'-upstream','--network',network,'--network-alias','synthetic-provider','--user','10001:10001',
      '--mount',f'type=bind,src={tls_runtime},dst=/fixture/tls,readonly','--mount',f'type=bind,src={upstream},dst=/fixture/upstream.mjs,readonly','--entrypoint','node',chief_image,'/fixture/upstream.mjs');container_names.append(network+'-upstream')
    native_dir=root/'native';native_dir.mkdir(mode=0o755)
    native_password='disposable-first-use'
    gateway_service_key=secrets.token_bytes(32);(secrets_dir/'gateway-budget-service-key').write_bytes(gateway_service_key);(secrets_dir/'gateway-budget-service-key').chmod(0o600)
    write_raw_secret('model-provider-key','fixture-model-provider-key')
    write_raw_secret('native-litellm-password',native_password)
    root_protected=True
    gateway_secret_protection='chown 0:0 /secrets/gateway-master /secrets/gateway-budget-service-key /secrets/model-provider-key /secrets/native-litellm-password && chmod 600 /secrets/gateway-master /secrets/gateway-budget-service-key /secrets/model-provider-key /secrets/native-litellm-password && test "$(stat -c %u:%g:%a /secrets/gateway-budget-service-key)" = 0:0:600'
    run('docker','run','--rm','--network','none','--user','0:0','--mount',f'type=bind,src={secrets_dir},dst=/secrets',
      '--entrypoint','sh',keeper_image,'-c',gateway_secret_protection,timeout=30)
    profile_script=root/'render-gateway-profile.mts';profile_script.write_text("""import{createRequire}from'node:module';
const{renderGatewayConfig,gatewayAdmissionProfile}=await import('/app/services/box/lib/gateway-config.ts');
const{gatewayMaximumLiability}=await import('/app/packages/agent-kit/src/gateway-pricing.ts');
const{gatewayCanonical,gatewayHash}=await import('/app/packages/agent-kit/src/gateway-admission-protocol.ts');
const{parse}=createRequire('/app/services/box/package.json')('yaml');
const options={alias:'lares-brain',providerModel:'anthropic/claude-sonnet-4-5',providerBaseUrl:'https://synthetic-provider:8443'};
const profile=gatewayAdmissionProfile(options),config=parse(renderGatewayConfig(options));
const aliases=profile.aliases,rendered=config.model_list.map((row:any)=>row.model_name).sort();
if(JSON.stringify([...aliases].sort())!==JSON.stringify(rendered)||config.model_list.some((row:any)=>row.litellm_params.model!==options.providerModel||row.litellm_params.api_base!==profile.providerBaseUrl)||profile.maxOutputTokens!==16384||profile.providerBaseUrl!==options.providerBaseUrl)throw Error('production rendered profile mismatch');
const pricing={version:1,capabilityHash:gatewayHash(gatewayCanonical(profile)),format:'anthropic',limits:{inputTokens:100000,outputTokens:profile.maxOutputTokens},usdPerMillionTokens:{input:'1',output:'2',cacheRead:'0',cacheWrite:'0'}};
console.log(JSON.stringify({profile,config,pricing,maximumLiability:gatewayMaximumLiability(pricing)}));
""")
    profile_mounts=[
      '--mount',f'type=bind,src={repo}/services/box/lib/gateway-config.ts,dst=/app/services/box/lib/gateway-config.ts,readonly',
      '--mount',f'type=bind,src={repo}/packages/agent-kit/src/gateway-pricing.ts,dst=/app/packages/agent-kit/src/gateway-pricing.ts,readonly',
      '--mount',f'type=bind,src={repo}/packages/agent-kit/src/gateway-admission-protocol.ts,dst=/app/packages/agent-kit/src/gateway-admission-protocol.ts,readonly',
      '--mount',f'type=bind,src={profile_script},dst=/app/services/keeper/render-gateway-profile.mts,readonly']
    profile_result=output('docker','run','--rm','--network',network,'--user','0:0','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,nodev,mode=1777',*profile_mounts,
      '--entrypoint','/app/services/keeper/node_modules/.bin/tsx',keeper_image,'/app/services/keeper/render-gateway-profile.mts',timeout=45)
    rendered=json.loads(profile_result)
    capability=rendered['profile'];pricing=rendered['pricing'];maximum_liability=rendered['maximumLiability'];gateway_config=rendered['config']
    if (capability['provider']!='anthropic' or capability['model']!='claude-sonnet-4-5' or
        capability['providerBaseUrl']!='https://synthetic-provider:8443' or alias not in capability['aliases'] or
        capability['maxOutputTokens']!=16384 or pricing['limits']['outputTokens']!=capability['maxOutputTokens'] or
        maximum_liability!='0.132768'):
        raise RuntimeError('Production gateway profile and reviewed financial bound did not match')
    (native_dir/'config.yaml').write_text(json.dumps(gateway_config,separators=(',',':'))+'\n')
    (native_dir/'profile.json').write_text(json.dumps(capability,sort_keys=True,separators=(',',':'))+'\n')
    (native_dir/'config.yaml').chmod(0o444);(native_dir/'profile.json').chmod(0o444)
    admission_bridge=root/'admission-bridge.mts';admission_bridge.write_text("""import https from'node:https';import{readFileSync}from'node:fs';
import{relayGatewayBudget}from'/app/services/keeper/lib/gateway-budget-relay.ts';
import{GATEWAY_RPC_BYTES,GATEWAY_RPC_MS,gatewayRpcPath}from'/app/packages/agent-kit/src/gateway-admission-protocol.ts';
const statusBuckets=['200','400','401','403','408','409','413','429','500','502','503','504','other'];
const counters={admit:{requests:0,statuses:Object.fromEntries(statusBuckets.map(value=>[value,0]))},settle:{requests:0,statuses:Object.fromEntries(statusBuckets.map(value=>[value,0]))}};
const boundedIncrement=value=>Math.min(1000000,value+1),bucket=status=>statusBuckets.includes(String(status))?String(status):'other';
const server=https.createServer({key:readFileSync('/fixture/tls/server-key.pem'),cert:readFileSync('/fixture/tls/server.pem'),maxHeaderSize:2048},(incoming,outgoing)=>{
 if(incoming.method==='GET'&&incoming.url==='/__diagnostics'){const raw=Buffer.from(JSON.stringify({schema:1,routes:counters}));outgoing.writeHead(200,{'content-type':'application/json','cache-control':'no-store','content-length':String(raw.length),'connection':'close'});outgoing.end(raw);return}
 const started=Date.now(),path=incoming.url??'',routePath=path.split('?')[0],route=routePath==='/v1/gateway-budget/admit'?'admit':routePath==='/v1/gateway-budget/settle'?'settle':null;
 if(route)counters[route].requests=boundedIncrement(counters[route].requests);
 let responseCounted=false;const recordStatus=status=>{if(route&&!responseCounted){const key=bucket(status);counters[route].statuses[key]=boundedIncrement(counters[route].statuses[key]);responseCounted=true}};
 const fail=()=>{recordStatus(503);if(!outgoing.headersSent){outgoing.writeHead(503,{'content-type':'text/plain','cache-control':'no-store','content-length':'0','connection':'close'});outgoing.end()}else outgoing.destroy()};
 const length=incoming.headers['content-length'],signature=incoming.headers['x-lares-signature'];
 if(incoming.method!=='POST'||!gatewayRpcPath(path.split('?')[0]??'')||incoming.headers['transfer-encoding']!==undefined||incoming.headers['content-encoding']!==undefined||incoming.headers.expect!==undefined||incoming.headers['content-type']!=='application/json'||typeof signature!=='string'||! /^[a-f0-9]{64}$/.test(signature)||length!==undefined&&(typeof length!=='string'||!/^[1-9][0-9]{0,3}$/.test(length)||Number(length)>GATEWAY_RPC_BYTES)){fail();return}
 let size=0;const chunks:Buffer[]=[];const bodyTimer=setTimeout(()=>{incoming.destroy();fail()},GATEWAY_RPC_MS);incoming.on('data',chunk=>{size+=chunk.length;if(size>GATEWAY_RPC_BYTES||length!==undefined&&size>Number(length)){clearTimeout(bodyTimer);incoming.destroy();fail();return}chunks.push(Buffer.from(chunk))});incoming.on('aborted',()=>{clearTimeout(bodyTimer);fail()});incoming.on('end',()=>{clearTimeout(bodyTimer);if(size<1||length!==undefined&&size!==Number(length)){fail();return}const remaining=GATEWAY_RPC_MS-(Date.now()-started);if(remaining<1){fail();return}const raw=Buffer.concat(chunks,size);void(async()=>{try{const request=new Request('https://admission-bridge:8443'+path,{method:'POST',headers:{'content-type':'application/json','content-length':String(raw.length),'x-lares-signature':signature},body:raw,duplex:'half'} as RequestInit);const response=await relayGatewayBudget(request,{socketPath:'/run/lares/gateway-budget.sock',timeoutMs:remaining});const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>GATEWAY_RPC_BYTES||outgoing.destroyed)return;const headers:Record<string,string>={'connection':'close','content-length':String(bytes.length)};for(const name of ['content-type','cache-control','x-lares-signature']){const value=response.headers.get(name);if(value)headers[name]=value}recordStatus(response.status);outgoing.writeHead(response.status,headers);outgoing.end(bytes)}catch{fail()}})()});
});server.maxConnections=16;server.headersTimeout=GATEWAY_RPC_MS;server.requestTimeout=GATEWAY_RPC_MS;server.keepAliveTimeout=1000;server.on('clientError',(_e,s)=>s.destroy());server.listen(8443,'0.0.0.0');
""")
    docker('run','-d','--name',network+'-admission-bridge','--network',network,'--network-alias','admission-bridge','--user','10001:10001',
      '--mount',f'type=bind,src={tls_runtime},dst=/fixture/tls,readonly','--mount',f'type=bind,src={run_dir},dst=/run/lares,readonly',
      '--mount',f'type=bind,src={admission_bridge},dst=/app/services/keeper/admission-bridge.mts,readonly',
      '--mount',f'type=bind,src={repo}/services/console/lib/gateway-budget-relay.ts,dst=/app/services/keeper/lib/gateway-budget-relay.ts,readonly',
      '--entrypoint','/app/services/keeper/node_modules/.bin/tsx',keeper_image,'/app/services/keeper/admission-bridge.mts');container_names.append(network+'-admission-bridge')
    sql('proof',"CREATE DATABASE native_litellm")
    manifest=json.loads((repo/'releases/2026-10-21-rc.12.json').read_text())
    gateway=manifest['images']['lares-gateway']
    endpoint_origin='http://native-gateway:4000'
    endpoint_hash=hashlib.sha256(('lares.native-endpoint.v1\0'+endpoint_origin+'\0'+capability['providerBaseUrl']).encode()).hexdigest()
    gateway_args=['run','-d','--name',network+'-gateway','--network',network,'--network-alias','native-gateway',
      '--tmpfs','/tmp:rw,noexec,nosuid,nodev,mode=1777','--mount',f'type=bind,src={repo}/images/gateway-runtime,dst=/opt/lares-gateway,readonly',
      '--mount',f'type=bind,src={native_dir},dst=/etc/litellm,readonly',
      '--mount',f'type=bind,src={secrets_dir},dst=/run/secrets,readonly','--mount',f'type=bind,src={tls_runtime},dst=/fixture/tls,readonly',
      '-e','MODEL_PROVIDER_KEY_FILE=/run/secrets/model-provider-key','-e','GATEWAY_MASTER_KEY_FILE=/run/secrets/gateway-master',
      '-e','DATABASE_PASSWORD_FILE=/run/secrets/native-litellm-password','-e','PGHOST=proof-db','-e','PGPORT=5432','-e','PGDATABASE=native_litellm','-e','PGUSER=proof',
      '-e','LARES_GATEWAY_ADMISSION_URL=https://admission-bridge:8443','-e','LARES_GATEWAY_SERVICE_KEY_FILE=/run/secrets/gateway-budget-service-key',
      '-e','LARES_GATEWAY_ENDPOINT_HASH='+endpoint_hash,'-e','LARES_GATEWAY_PROFILE_FILE=/etc/litellm/profile.json','-e','SSL_CERT_FILE=/fixture/tls/ca.pem',
      '-e','LITELLM_LOCAL_MODEL_COST_MAP=True','-e','LITELLM_TELEMETRY=False','-e','PYTHONDONTWRITEBYTECODE=1','-e','CI=true',
      '-e','LARES_GATEWAY_PROBE_DIAGNOSTICS=1',
      '--entrypoint','/bin/sh',gateway,'/opt/lares-gateway/start.sh']
    stage = 'pinned-production-gateway-start'
    docker(*gateway_args);container_names.append(network+'-gateway')
    proof['images']['nativeGatewayRef']=gateway
    proof['images']['nativeGateway']=image_identity(gateway)
    proof['images']['syntheticUpstream']=proof['images']['chief']
    proof['adapter']={name:hashlib.sha256((repo/'images/gateway-runtime'/name).read_bytes()).hexdigest() for name in ('start.sh','lares_gateway.py','admission_contract.py')}
    proof['productionRelaySha256']=hashlib.sha256((repo/'services/console/lib/gateway-budget-relay.ts').read_bytes()).hexdigest()
    proof['internalTlsFrontSha256']=hashlib.sha256(admission_bridge.read_bytes()).hexdigest()
    proof['syntheticProviderSha256']=hashlib.sha256(upstream.read_bytes()).hexdigest()
    proof['productionProfileSha256']=hashlib.sha256((native_dir/'profile.json').read_bytes()).hexdigest()
    proof['productionConfigSha256']=hashlib.sha256((native_dir/'config.yaml').read_bytes()).hexdigest()
    proof['profileCapabilityHash']=pricing['capabilityHash']
    proof['reviewedMaximumLiability']=maximum_liability
    proof['endpointHash']=endpoint_hash
    proof['gatewayEndpointOrigin']=endpoint_origin
    stage = 'pinned-production-gateway-readiness'
    gateway_ready="const fs=await import('node:fs/promises');const key=(await fs.readFile('/etc/lares/secrets/gateway-master','utf8')).trim();let ok=false;for(let i=0;i<240;i++){try{const r=await fetch('http://native-gateway:4000/health/readiness',{headers:{authorization:'Bearer '+key},signal:AbortSignal.timeout(1000)});if(r.status===200){ok=true;break}}catch{}await new Promise(r=>setTimeout(r,250))}if(!ok)process.exit(2);"
    tsx_keeper(gateway_ready,timeout=90);cases['productionGuardedGatewayAndTrustedInternalProvider']=True
    stage = 'pinned-production-relay-refusal'
    relay_refusal="const https=await import('node:https');const fs=await import('node:fs/promises');const ca=await fs.readFile('/fixture/tls/ca.pem');let refused=false;for(let i=0;i<40;i++){try{const status=await new Promise((resolve,reject)=>{const q=https.request({hostname:'admission-bridge',port:8443,path:'/v1/gateway-budget/admit',method:'POST',ca,timeout:1000,headers:{'content-type':'application/json','content-length':'2','x-lares-signature':'0'.repeat(64)}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode))});q.on('timeout',()=>q.destroy(new Error('timeout')));q.on('error',reject);q.end('{}')});if(status===503){refused=true;break}}catch{}await new Promise(r=>setTimeout(r,250))}if(!refused)process.exit(2);"
    tsx_keeper(relay_refusal,mounts=['--mount',f'type=bind,src={tls_runtime},dst=/fixture/tls,readonly'],timeout=20)
    cases['productionConsoleRelayRefusesBeforeKeeperAuthorityExists']=True
    proof['serviceKeyMode']='0:0:600'
    cases['renderedAliasesEndpointProfileAndLiabilityAgree']=True

    # Prepare financial and native custody only through their production root CLI. The final
    # Keeper config is written after both one-time ceremonies, exactly as the host setup flow.
    install_root=root/'install';
    for d in ('agents','retired','backup','egress','run','roles','templates'):(install_root/d).mkdir(parents=True,exist_ok=True)
    (install_root/'compose.yaml').write_text('services: {}\n')
    (install_root/'agents'/agent).mkdir()
    definition=neutral_first_use_definition(repo/'packages/agent-kit/templates/chief-of-staff/definition.json',agent,alias)
    (agent_dir/'agent.json').write_text(json.dumps(definition));(agent_dir/'duties.md').write_text('Neutral first-use proof.');(agent_dir/'voice.md').write_text('Be concise.')
    for filename in ('agent.json','duties.md','voice.md'):
        shutil.copy2(agent_dir/filename,install_root/'agents'/agent/filename)
    incarnation_file=secrets_dir/(agent+'-runtime-control');incarnation_file.write_text(secrets.token_hex(32)+'\n');incarnation_file.chmod(0o440)
    route_file=secrets_dir/'route-password';
    (secrets_dir/'native-policy.json').write_text('{}\n')
    base_config={'mode':'overlay','project':network,'dir':'/fixture-install','files':['keeper.json'],'agentsDir':'/fixture-install/agents',
      'designatedOwnerId':'first-use-owner',
      'retiredDir':'/fixture-install/retired','secretsDir':'/etc/lares/secrets','rolesDir':'/app/services','templatesDir':'/app/packages/agent-kit/templates',
      'backupDir':'/fixture-install/backup','db':{'host':'proof-db','port':5432,'database':'proof','user':'lares_app','passwordFile':'/etc/lares/secrets/app-password'},
      'lifecycle':{'network':network,'subnet':'172.16.0.0/12','reservedAddresses':[],'composeFile':'/fixture-install/compose.yaml','egressDir':'/fixture-install/egress',
        'imageByRole':{'chief-of-staff':'fixture@'+proof['images']['chief'],'creative':'fixture@'+proof['images']['chief']},
        'proxyContainer':'lares-egress-proxy','squidImage':'fixture@'+proof['images']['keeper'],'firewallImage':'fixture@'+proof['images']['keeper'],
        'adminDb':{'host':'proof-db','port':5432,'database':'postgres','user':'lares_workflow_provisioner','passwordFile':'/etc/lares/secrets/workflow-provisioner-password'},
        'workflowTemplate':'empty_workflow','workflowOwner':'lares_workflow_owner','installationPrepared':True,
        'egress':{'endpoints':{},'legacyConsumers':[],'internalNetworks':['172.16.0.0/12'],'directDestinations':[],'infrastructureHosts':[]},
        'runtime':{'databaseUrl':'postgres://lares_app@proof-db:5432/proof','workflowServer':'postgres://lares_workflow@proof-db:5432',
          'gatewayUrl':'http://native-gateway:4000','proxyUrl':'http://egress-proxy:8888','passwordFile':'/etc/lares/secrets/app-password',
          'workflowPasswordFile':'/etc/lares/secrets/workflow-password','gatewayKeys':{},'gatewayMasterKeyFile':'/etc/lares/secrets/gateway-master'}},
      'gatewayBudget':{'serviceKeyFile':'/etc/lares/secrets/gateway-budget-service-key'},
      'modelPurposeConsoleSigningKeyFile':'/etc/lares/secrets/console-model-purpose-signing-key','modelPurposeRuntimeDir':'/fixture-install/run/model-purpose'}
    config_dir_path=config_dir/'keeper.json';config_dir_path.write_text(json.dumps(base_config));config_dir_path.chmod(0o600)
    stage = 'production-financial-and-native-preparation'
    # The production operator-file check requires root ownership. Keep this credential in
    # the offline fixture mount; only the distinct workflow-provisioner credential is online.
    operator_protection=(
      "chown 0:0 /offline/operator-password /offline/workflow-provisioner-password /secrets/workflow-provisioner-password && "
      "chmod 600 /offline/operator-password /offline/workflow-provisioner-password /secrets/workflow-provisioner-password && "
      "test \"$(stat -c %u:%g:%a /offline/operator-password)\" = 0:0:600 && "
      "test \"$(stat -c %u:%g:%a /offline/workflow-provisioner-password)\" = 0:0:600 && "
      "test \"$(stat -c %u:%g:%a /secrets/workflow-provisioner-password)\" = 0:0:600"
    )
    root_protected = True
    run('docker','run','--rm','--network','none','--user','0:0',
      '--mount',f'type=bind,src={offline_dir},dst=/offline',
      '--mount',f'type=bind,src={secrets_dir},dst=/secrets',
      '--entrypoint','sh',keeper_image,'-c',operator_protection,timeout=30)
    # Prepare financial journal against the new database using the offline operator account.
    prepare=keeper_run('/app/services/keeper/bin/budget-financial.ts','prepare-fresh','--confirm-fresh-installation','--operator-password-file','/offline/operator-password')
    if 'Fresh financial custody prepared.' not in prepare: raise RuntimeError('Financial preparation did not complete through the production CLI')
    prepared_binding=json.loads(prepare.splitlines()[-1])
    if not isinstance(prepared_binding.get('budgetFinancial'),dict):raise RuntimeError('Fresh financial CLI did not return its prepared database binding')
    base_config.update(prepared_binding)
    config_dir_path.write_text(json.dumps(base_config));config_dir_path.chmod(0o600)
    prepare_native=keeper_run('/app/services/keeper/bin/budget-financial.ts','prepare-native','--confirm-fresh-native-custody','--operator-password-file','/offline/operator-password')
    if 'Fresh native custody prepared.' not in prepare_native: raise RuntimeError('Native custody preparation did not complete through the production CLI')
    cases['productionFinancialAndNativePreparation']=True

    # Root-reviewed policy and exact protected mode; runtime-control and Console keys are
    # separately group-readable by the non-root compiled agent.
    policy={'capability':capability,'pricing':pricing,'maximumLiability':maximum_liability,'team':{'maxBudget':'100','models':capability['aliases'],'budgetDuration':'1d'},
      'user':{'maxBudget':'30','userRole':'internal_user','autoCreateKey':False},'membership':{'maxBudget':'20','allowedModels':capability['aliases'],'budgetDuration':'1d','role':'user'},
      'key':{'maxBudget':'10','models':[alias],'budgetDuration':'1d','keyType':'llm_api','blocked':True}}
    policy_file=secrets_dir/'native-policy.json';policy_file.write_text(json.dumps({'endpointHash':endpoint_hash,'policies':[policy]}));policy_file.chmod(0o600)
    base_config['budgetNative']={'directory':'/var/lib/lares/budget-native','reviewedPolicyFile':'/etc/lares/secrets/native-policy.json'}
    config_dir_path.write_text(json.dumps(base_config));config_dir_path.chmod(0o600)
    stage = 'source-rows-and-readiness'
    # Seed source rows under the production application role, then let real Keeper actions
    # write closed accounts and native keys.
    source_code="""import{Pool}from'pg';import{readFileSync}from'node:fs';import{definitionSchema,hashOf}from'/app/packages/agent-kit/src/definition.ts';import{randomUUID}from'node:crypto';
const p=new Pool({host:'proof-db',database:'proof',user:'lares_app',password:readFileSync('/etc/lares/secrets/app-password','utf8').trim(),max:1});
const owner='first-use-owner',members=['first-use-member-a','first-use-member-b'],org='first-use-org',agent='proof-agent',inc=process.env.FIXTURE_INCARNATION,alias='lares-brain';
try{await p.query("INSERT INTO orgs(id,display_name) VALUES($1,'Neutral first-use organization')",[org]);await p.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES($1,'Owner',$2,'owner','active'),($3,'Member A',$2,'member','active'),($4,'Member B',$2,'member','active')",[owner,org,members[0],members[1]]);for(const id of [owner,...members])await p.query("INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES($1,'https://identity.example.invalid',$2,'fixture-tenant')",[id,'subject-'+id]);await p.query("INSERT INTO member_sessions(id,member_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[randomUUID(),owner,process.env.FIXTURE_OWNER_SESSION_TOKEN_HASH]);
const definition=definitionSchema.parse({...JSON.parse(readFileSync('/definition/agent.json','utf8')),name:agent,model:alias});const duties=readFileSync('/definition/duties.md','utf8'),voice=readFileSync('/definition/voice.md','utf8'),hash=hashOf({definition,dutiesMd:duties,voiceMd:voice});await p.query("INSERT INTO agent_definitions(name,definition,duties,voice,hash,status) VALUES($1,$2::jsonb,$3,$4,$5,'valid')",[agent,JSON.stringify(definition),duties,voice,hash]);await p.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,applied_definition,pending) VALUES($1,'172.20.0.10',$2,'owned',$3,$3,'ready',$4::jsonb,false)",[agent,process.env.FIXTURE_WORKFLOW_DB,inc,JSON.stringify(definition)]);const denied=await p.query('SELECT id FROM budget_accounts LIMIT 1').then(()=>false,error=>error.code==='42501');if(!denied)throw Error();console.log(JSON.stringify({definitionHash:hash,financialAccessDenied:true}));}finally{await p.end()}"""
    source_fixture=root/'source-fixture.mts';source_fixture.write_text(source_code)
    source_result=run('docker','run','--rm','--network',network,'--user','0:0','-e','FIXTURE_INCARNATION='+incarnation,'-e','FIXTURE_WORKFLOW_DB='+workflow_database,
      '-e','FIXTURE_OWNER_SESSION_TOKEN_HASH='+owner_session_token_hash,
      '--mount',f'type=bind,src={secrets_dir},dst=/etc/lares/secrets,readonly','--mount',f'type=bind,src={agent_dir},dst=/definition,readonly',
      '--mount',f'type=bind,src={source_fixture},dst=/app/services/keeper/source-fixture.mts,readonly','--entrypoint','/app/services/keeper/node_modules/.bin/tsx',keeper_image,'/app/services/keeper/source-fixture.mts')
    source_identity=json.loads(source_result.stdout.strip())
    definition_hash=source_identity['definitionHash']
    if source_identity.get('financialAccessDenied') is not True:raise RuntimeError('Ordinary application role could read financial account rows')
    cases['ordinaryApplicationFinancialAccessDenied']=True
    # Root-owned secret/custody modes match the production contract; do not expose either to CI artifacts.
    protect='chown -R 0:0 /var/lib/lares /secrets && chmod 700 /var/lib/lares/budget-financial /var/lib/lares/budget-native && chmod 600 /var/lib/lares/budget-financial/* /var/lib/lares/budget-native/* /secrets/gateway-master /secrets/gateway-budget-service-key /secrets/native-policy.json /secrets/model-provider-key /secrets/native-litellm-password && chown 0:10001 /secrets/console-model-purpose-signing-key /secrets/proof-agent-runtime-control /run/lares /run/lares/model-purpose && chmod 440 /secrets/console-model-purpose-signing-key /secrets/proof-agent-runtime-control && chmod 750 /run/lares /run/lares/model-purpose && chown 10001:10001 /secrets/route-password /secrets/app-password /secrets/workflow-password && test "$(stat -c %u:%g:%a /secrets/native-policy.json)" = 0:0:600 && test "$(stat -c %u:%g:%a /secrets/gateway-master)" = 0:0:600 && test "$(stat -c %u:%g:%a /secrets/gateway-budget-service-key)" = 0:0:600 && test "$(stat -c %u:%g:%a /secrets/console-model-purpose-signing-key)" = 0:10001:440 && test "$(stat -c %u:%g:%a /secrets/proof-agent-runtime-control)" = 0:10001:440 && test "$(stat -c %u:%g:%a /run/lares)" = 0:10001:750 && test "$(stat -c %u:%g:%a /run/lares/model-purpose)" = 0:10001:750 && test "$(stat -c %u:%g:%a /var/lib/lares/budget-native)" = 0:0:700'
    docker('run','--rm','--network','none','--mount',f'type=volume,src={volume},dst=/var/lib/lares','--mount',f'type=bind,src={secrets_dir},dst=/secrets',
      '--mount',f'type=bind,src={run_dir},dst=/run/lares','--entrypoint','sh',keeper_image,'-c',protect)
    cases['protectedCustodyAndSocketModesVerified']=True

    stage = 'production-keeper-startup'
    # Pre-provision both members before either activation. The root CLI talks only to the real
    # host-only socket; no direct provisioner/activator construction is used.
    host_socket_dir=root/'host-socket';host_socket_dir.mkdir(mode=0o755)
    lares_dir=root/'run-sockets';lares_dir.mkdir(mode=0o755)
    keeper_name=network+'-keeper'
    keeper_cmd=['run','-d','--name',keeper_name,'--network',network,'--mount',f'type=volume,src={volume},dst=/var/lib/lares',
      '--mount',f'type=bind,src={secrets_dir},dst=/etc/lares/secrets,readonly','--mount',f'type=bind,src={config_dir_path},dst=/etc/lares/keeper.json,readonly',
      '--mount',f'type=bind,src={install_root},dst=/fixture-install',
      '--mount',f'type=bind,src={host_socket_dir},dst=/run/lares-host','--mount',f'type=bind,src={run_dir},dst=/run/lares',
      '--tmpfs','/tmp:rw,noexec,nosuid,nodev,mode=1777',keeper_image]
    docker(*keeper_cmd);container_names.append(keeper_name)
    def wait_socket(path,container=keeper_name):
        for _ in range(120):
            state=run('docker','exec',container,'test','-S',path,check=False)
            if state.returncode==0:return
            if docker('inspect','--format','{{.State.Running}}',container)!='true':raise RuntimeError('Production Keeper exited before its sockets became ready')
            time.sleep(.25)
        raise RuntimeError('Production Keeper sockets did not become ready')
    wait_socket('/run/lares-host/keeper.sock');wait_socket('/run/lares/keeper.sock');wait_socket('/run/lares/model-purpose-console.sock');wait_socket('/run/lares/model-purpose/gateway.sock');wait_socket('/run/lares/gateway-budget.sock')
    cases['productionKeeperStartupAndSockets']=True
    cases['productionRelayCanWaitForActualKeeperAuthoritySocket']=True

    stage = 'initial-budget-actions-through-console-client'
    initial_budget_client=root/'initial-budget-client.mts'
    initial_budget_client.write_text("""import { readFileSync } from 'node:fs';
import { keeper } from '/app/services/console/lib/keeper-client.ts';
const sessionToken=readFileSync('/fixture/owner-session-token','utf8').trim();
const expected=['first-use-owner','first-use-member-a','first-use-member-b'].sort();
const status=await keeper<Array<{memberId:string;eligible:boolean;setupComplete:boolean}>>('member.initial-budget-status',{sessionToken},'first-use-owner@example.invalid');
if(!Array.isArray(status)||status.length!==expected.length)throw new Error();
const actual=status.map(row=>row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).sort().join(',')==='eligible,memberId,setupComplete'&&typeof row.memberId==='string'&&typeof row.eligible==='boolean'&&typeof row.setupComplete==='boolean'?row:null);
if(actual.some(row=>row===null)||actual.map(row=>row!.memberId).sort().join(',')!==expected.join(',')||actual.some(row=>row!.eligible!==true||row!.setupComplete!==false))throw new Error();
for(const targetMemberId of expected){const saved=await keeper<{saved:true}>('member.set-initial-budget',{sessionToken,targetMemberId,monthlyLimit:'50'},'first-use-owner@example.invalid');if(!saved||Object.keys(saved).sort().join(',')!=='saved'||saved.saved!==true)throw new Error();}
console.log(JSON.stringify({statusCount:status.length,capsSaved:expected.length}));
""")
    budget_client_result=run(*initial_budget_client_args(network=network,run_dir=run_dir,token_file=owner_token_file,
      client_source=repo/'services/console/lib/keeper-client.ts',client_script=initial_budget_client,keeper_image=keeper_image),timeout=45)
    budget_client_identity=json.loads(budget_client_result.stdout.strip())
    if budget_client_identity!={'statusCount':3,'capsSaved':3}:raise RuntimeError('Keeper initial budget actions did not return strict expected acknowledgements')
    cases['initialMemberBudgetsSetThroughActualConsoleKeeperClient']=True

    stage = 'source-adoption-after-initial-budgets'
    source_adoption_code="""import{Pool}from'pg';import{readFileSync}from'node:fs';import{PgGrantStore}from'/app/packages/agent-kit/src/grant-store.ts';import{definitionSchema,hashOf}from'/app/packages/agent-kit/src/definition.ts';
const p=new Pool({host:'proof-db',database:'proof',user:'lares_app',password:readFileSync('/etc/lares/secrets/app-password','utf8').trim(),max:1});const owner='first-use-owner',org='first-use-org',agent='proof-agent',alias='lares-brain';
try{const definition=definitionSchema.parse({...JSON.parse(readFileSync('/definition/agent.json','utf8')),name:agent,model:alias});const duties=readFileSync('/definition/duties.md','utf8'),voice=readFileSync('/definition/voice.md','utf8'),hash=hashOf({definition,dutiesMd:duties,voiceMd:voice});const grants=new PgGrantStore(p),adopted=await grants.adoptAgent(owner,{agentName:agent,expectedDefinitionHash:hash},{designatedOwnerMemberId:owner});const current=await grants.updateAgentAccess(owner,{agentName:agent,expectedRevision:adopted.accessRevision,grants:[{principal:{kind:'organisation',id:org},permission:'use',expiresAt:null}]});if(current.accessRevision<=adopted.accessRevision)throw Error();console.log(JSON.stringify({definitionHash:hash,accessRevision:current.accessRevision}));}finally{await p.end()}"""
    source_adoption=root/'source-adoption.mts';source_adoption.write_text(source_adoption_code)
    adoption_result=run('docker','run','--rm','--network',network,'--user','0:0',
      '--mount',f'type=bind,src={secrets_dir}/app-password,dst=/etc/lares/secrets/app-password,readonly',
      '--mount',f'type=bind,src={agent_dir},dst=/definition,readonly',
      '--mount',f'type=bind,src={source_adoption},dst=/app/services/keeper/source-adoption.mts,readonly',
      '--entrypoint','/app/services/keeper/node_modules/.bin/tsx',keeper_image,'/app/services/keeper/source-adoption.mts')
    source_identity=json.loads(adoption_result.stdout.strip())
    if source_identity.get('definitionHash')!=definition_hash or not isinstance(source_identity.get('accessRevision'),int):
        raise RuntimeError('Post-cap source adoption did not return current source identity')
    cases['ordinarySourceAdoptionAndShareFollowInitialBudgetActions']=True

    def host_cli(command_name,payload=None):
        args=['docker','run','--rm','--network',network,'--user','0:0','--mount',f'type=volume,src={volume},dst=/var/lib/lares',
          '--mount',f'type=bind,src={secrets_dir},dst=/etc/lares/secrets,readonly','--mount',f'type=bind,src={config_dir_path},dst=/etc/lares/keeper.json,readonly',
          '--mount',f'type=bind,src={install_root},dst=/fixture-install',
          '--mount',f'type=bind,src={host_socket_dir},dst=/run/lares-host',
          '-i',
          '--entrypoint','/app/services/keeper/node_modules/.bin/tsx',keeper_image,'/app/services/keeper/bin/budget-financial.ts',command_name,'--host']
        result=run(*args,input=json.dumps(payload) if payload is not None else None,timeout=45)
        return result.stdout.strip()
    stage = 'host-only-provisioning'
    accounts=json.loads(host_cli('provision-accounts',{'installationCap':'100','memberIds':members}))
    if accounts.get('state')!='closed' or accounts.get('members')!=2:raise RuntimeError('Closed account provisioning was not acknowledged')
    cases['closedAccountsProvisionedBeforeActivation']=True
    binding_ids=[str(uuid.uuid4()),str(uuid.uuid4())]
    for member,binding_id in zip(members,binding_ids):
        result=json.loads(host_cli('provision-native',{'bindingId':binding_id,'credentialGeneration':'0','memberId':member,'agent':agent,'incarnation':incarnation,'purposeAlias':alias}))
        if result!={'state':'bound-closed','bindingId':binding_id,'credentialGeneration':'0'}:raise RuntimeError('Closed native binding was not acknowledged')
    cases['bothNativeMembersBoundClosedBeforeActivation']=True

    def native_snapshot():
        return json.loads(financial_observer('native',base_config['budgetFinancial']['db']))

    def upstream_calls():
        return json.loads(output('docker','exec',network+'-upstream','node','-e',
          "fetch('http://127.0.0.1:8081/control').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))"))['calls']

    stage = 'ordinary-socket-host-only-refusal'
    before_denial_state=native_snapshot()
    before_denial_bindings=json.loads(financial_observer('bindings',base_config['budgetFinancial']['db']))['bindings']
    denial_source="import{createConnection}from'node:net';const requests=JSON.parse(process.env.PROBE_REQUESTS);const expected='keeper: reachable only from the host command';let index=0;function next(){if(index>=requests.length){console.log('ordinary-denied');return}const item=requests[index++],s=createConnection('/run/lares/keeper.sock');let b='';s.once('connect',()=>s.end(JSON.stringify({...item,actor:'probe-ordinary-caller@example.invalid'})+'\\n'));s.on('data',x=>b+=x);s.on('end',()=>{let r;try{r=JSON.parse(b)}catch{process.exit(2);return}if(r.ok!==false||r.outcome!=='refused'||r.error!==expected){process.exit(3);return}next()});s.on('error',()=>process.exit(4))}next();"
    denial_requests=[
      {'action':'budget.provision-native','input':{'bindingId':binding_ids[0],'credentialGeneration':'0','memberId':members[0],'agent':agent,'incarnation':incarnation,'purposeAlias':alias}},
      {'action':'budget.activate-native','input':{'bindingId':binding_ids[0],'credentialGeneration':'0'}},
    ]
    denial_env=json.dumps(denial_requests,separators=(',',':'))
    denied=output('docker','run','--rm','--network',network,'--user','10001:10001','-e','PROBE_REQUESTS='+denial_env,
      '--mount',f'type=bind,src={run_dir},dst=/run/lares','--entrypoint','node',chief_image,'-e',denial_source)
    if denied!='ordinary-denied':raise RuntimeError('Ordinary Keeper socket did not return the host-only refusal for both native actions')
    after_denial_state=native_snapshot()
    after_denial_bindings=json.loads(financial_observer('bindings',base_config['budgetFinancial']['db']))['bindings']
    if before_denial_state!=after_denial_state or before_denial_bindings!=after_denial_bindings or upstream_calls()!=0:
        raise RuntimeError('Ordinary host-only refusals changed financial or native state')
    cases['ordinarySocketCannotProvisionOrActivate']=True

    stage = 'first-member-activation'
    before_activation=native_snapshot()
    if (before_activation['state']!='closed' or before_activation['reason']!='unreconciled' or
        before_activation['selected_endpoint'] is not None or before_activation['recovery_epoch'] is not None or
        str(before_activation['endpoint_generation'])!='0'):
        raise RuntimeError('Fresh account did not begin in the expected closed state')
    first_activation=json.loads(host_cli('activate-native',{'bindingId':binding_ids[0],'credentialGeneration':'0'}))
    if first_activation.get('state')!='active':raise RuntimeError('First native activation was not acknowledged')
    cases['firstNativeMemberActivated']=True
    first_state=native_snapshot()
    if (first_state['state']!='open' or first_state['reason']!='approved' or
        first_state['selected_endpoint']!=endpoint_hash or
        not isinstance(first_state['recovery_epoch'],str) or len(first_state['recovery_epoch'])!=43 or
        not all(c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_' for c in first_state['recovery_epoch']) or
        str(first_state['endpoint_generation'])!='1' or
        first_state['attempts']!=before_activation['attempts'] or
        first_state['liability']!=before_activation['liability']):
        raise RuntimeError('First activation did not establish the reviewed endpoint and fresh epoch without usage')
    selected=json.loads(financial_observer('members',base_config['budgetFinancial']['db']))['members']
    if not selected_members_match_first_activation(selected,members):
        raise RuntimeError('First activation did not open only the selected member account')
    cases['firstActivationPreservesEndpointEpochAndOpensOnlySelectedMember']=True
    if upstream_calls()!=0:raise RuntimeError('Upstream received traffic before the first model request')

    # Start the built Chief runtime with the real mounted definition and protected identity.
    stage = 'runtime-create'
    chief_name=network+'-chief'
    capsule_source=repo/'services/console/lib/model-purpose-capsule.ts'
    client_script=root/'first-use-client.mts'
    client_script.write_text("""const fs=await import('node:fs');
const phaseFile=process.env.FIRST_USE_PHASE_FILE;
const resultFile=process.env.FIRST_USE_RESULT_FILE;
const phases=['imports','session-create','session-bind','capsule-sign','send','stream-auth','turn-result','refusalchecks','complete'];
const fixedCodes=['budget_admission_refused','budget_exceeded','model_purpose_dispatch_unavailable','invalid_request',
  'request_policy_rejected','body_too_large','unsupported_request_field','timeout','aborted','ECONNREFUSED',
  'ECONNRESET','EHOSTUNREACH','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT','unknown'];
const failureTypes=['step.failed','turn.failed','session.failed'];
let phase='imports';
function mark(next){if(!phases.includes(next))return;phase=next;try{if(phaseFile!=='/tmp/first-use-phase-first')return;const temp=phaseFile+'.tmp';fs.writeFileSync(temp,JSON.stringify({phase}),{mode:0o600});fs.renameSync(temp,phaseFile);}catch{}}
function validStatus(value){return Number.isInteger(value)&&value>=100&&value<=599?value:null;}
function fixedCategoryFlags(rows,error){
  const flags={localDispatchUnavailable:false,nativeAdmissionRefused:false,timeoutAbort:false,socketUnavailable:false,requestPolicyRejected:false,unknown:false};
  const texts=[];let codes=[];
  for(const row of rows){const data=row?.data;if(!data||typeof data!=='object')continue;codes.push(data.code);
    if(typeof data.message==='string'&&data.message.length<=2048)texts.push(data.message);
    const details=data.details;if(details&&typeof details==='object')for(const key of ['apiErrorMessage','responseBodySnippet'])
      if(typeof details[key]==='string'&&details[key].length<=2048)texts.push(details[key]);}
  if(error){codes.push(error.code);if(typeof error.name==='string')texts.push(error.name);
    if(typeof error.message==='string'&&error.message.length<=2048)texts.push(error.message);}
  const hasBodyValue=(text,value)=>{if(text===value)return true;try{const parsed=JSON.parse(text);return parsed?.error===value||parsed?.message===value;}catch{return false;}};
  flags.localDispatchUnavailable=codes.includes('model_purpose_dispatch_unavailable')||texts.some(text=>hasBodyValue(text,'Model purpose dispatch is unavailable'));
  flags.nativeAdmissionRefused=codes.includes('budget_admission_refused')||texts.some(text=>hasBodyValue(text,'I could not verify permission to spend. Please check the gateway setup.'));
  flags.timeoutAbort=codes.some(code=>code==='timeout'||code==='aborted')||texts.some(text=>text==='TimeoutError'||text==='AbortError'||text==='Request timed out');
  flags.socketUnavailable=codes.some(code=>['ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT'].includes(code));
  flags.requestPolicyRejected=codes.some(code=>['invalid_request','request_policy_rejected','body_too_large','unsupported_request_field'].includes(code));
  flags.unknown=!Object.entries(flags).some(([key,value])=>key!=='unknown'&&value);
  return flags;
}
function writeResultDiagnostic(value){try{if(resultFile!=='/tmp/first-use-result-diagnostic-first')return;const raw=JSON.stringify(value);if(Buffer.byteLength(raw,'utf8')>2048)return;const temp=resultFile+'.tmp';fs.writeFileSync(temp,raw,{mode:0o600});fs.renameSync(temp,resultFile);}catch{}}
function recordReturnedResult(result){
  const flags={step:false,turn:false,session:false},events=[],rows=Array.isArray(result?.events)?result.events:[];let count=0;
  for(const event of rows){if(!event||!failureTypes.includes(event.type))continue;count=Math.min(1000000,count+1);
    const name=event.type==='step.failed'?'step':event.type==='turn.failed'?'turn':'session';flags[name]=true;
    if(events.length<8){const data=event.data&&typeof event.data==='object'?event.data:{},details=data.details&&typeof data.details==='object'?data.details:{};
      events.push({event:event.type,code:fixedCodes.includes(data.code)?data.code:'unknown',statusCode:validStatus(details.statusCode),upstreamStatusCode:validStatus(details.upstreamStatusCode)});}}
  const resultStatus=['completed','failed','waiting'].includes(result?.status)?result.status:'unknown';
  writeResultDiagnostic({schema:1,outcome:'returned',resultStatus,expectedMessage:result?.message==='FIRST_USE_OK',
    failureEventCount:count,failureEvents:flags,events,categories:fixedCategoryFlags(rows.filter(event=>event&&failureTypes.includes(event.type)).slice(0,8)),clientStatus:null});
}
function recordThrownResult(error){
  writeResultDiagnostic({schema:1,outcome:'thrown',resultStatus:'unknown',expectedMessage:null,failureEventCount:0,
    failureEvents:{step:false,turn:false,session:false},events:[],categories:fixedCategoryFlags([],error),
    clientStatus:error?.name==='ClientError'?validStatus(error.status):null});
}
mark('imports');
void(async()=>{let resultObserved=false;try{
const { Client } = await import('/app/services/chief-of-staff/node_modules/eve/dist/src/client/index.js');
const { randomBytes } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const { bindConsoleSession } = await import('/app/packages/agent-kit/src/console-turn-authority.ts');
const { modelPurposeRawBodyHash, signPrivateModelPurposeRequest } = await import('./model-purpose-capsule.ts');
const agent='proof-agent',incarnation=process.env.LARES_AGENT_INCARNATION!,member='first-use-member-a';
mark('session-create');
const nonce=randomBytes(32).toString('base64url'),password=readFileSync('/run/secrets/route-password','utf8').trim();
process.env.PGPASSWORD=readFileSync('/run/secrets/app-password','utf8').trim();
let headers={authorization:'Basic '+Buffer.from('eve:'+password).toString('base64'),
  'x-lares-member-id':member,'x-lares-admission':nonce,'x-lares-purpose':'human'};
const client=new Client({host:'http://127.0.0.1:3000',headers:()=>headers});
const {session}=await client.sessions.create();
mark('session-bind');
const binding=await bindConsoleSession({agent,incarnation,sessionId:session.state.sessionId,memberId:member,admissionNonce:nonce});
const message='Return exactly FIRST_USE_OK';
const body=JSON.stringify({message}),path='/eve/v1/session/'+session.state.sessionId;
const request={agent,incarnation,session:session.state.sessionId,member,admissionNonce:nonce,method:'POST',path,
  rawBodyHash:modelPurposeRawBodyHash(body),policyRevision:binding.policyRevision,
  definitionHash:process.env.FIRST_USE_DEFINITION_HASH!,purpose:'human',requestId:randomBytes(32).toString('base64url')};
mark('capsule-sign');
const capsule=await signPrivateModelPurposeRequest(request);
headers={...headers,'content-type':'application/json','x-lares-model-purpose-required':'1','x-lares-model-capsule':capsule};
mark('send');
const pending=await session.send(message);
headers={authorization:'Basic '+Buffer.from('eve:'+password).toString('base64'),
  'x-lares-member-id':member,'x-lares-admission':nonce,'x-lares-purpose':'read'};
mark('stream-auth');
mark('turn-result');
const result=await pending.result();
resultObserved=true;recordReturnedResult(result);
if(result.message!=='FIRST_USE_OK')throw new Error();
mark('refusalchecks');
const replay=await client.fetch(path,{method:'POST',headers:{...headers,'x-lares-purpose':'human','content-type':'application/json',
  'x-lares-model-purpose-required':'1','x-lares-model-capsule':capsule},body});
if(replay.ok)throw new Error();
const staleBody=JSON.stringify({message:'changed request'});
const staleRequest={...request,requestId:randomBytes(32).toString('base64url')};
const staleCapsule=await signPrivateModelPurposeRequest(staleRequest);
const stale=await client.fetch(path,{method:'POST',headers:{...headers,'x-lares-purpose':'human','content-type':'application/json',
  'x-lares-model-purpose-required':'1','x-lares-model-capsule':staleCapsule},body:staleBody});
if(stale.ok)throw new Error();
const memberRequest={...request,requestId:randomBytes(32).toString('base64url')};
const memberCapsule=await signPrivateModelPurposeRequest(memberRequest);
const wrongMember=await client.fetch(path,{method:'POST',headers:{...headers,'x-lares-purpose':'human','content-type':'application/json',
  'x-lares-model-purpose-required':'1','x-lares-model-capsule':memberCapsule,'x-lares-member-id':'first-use-member-b'},body});
if(wrongMember.ok)throw new Error();
mark('complete');
console.log(JSON.stringify({sessionId:session.state.sessionId,response:result.message,
  replayStatus:replay.status,staleStatus:stale.status,wrongMemberStatus:wrongMember.status}));
}catch(error){if(!resultObserved)recordThrownResult(error);process.exitCode=1}})();
""")

    def fixed_client_failure_observations():
        observations={'upstreamDispatchCount':None,'financialDurableCounts':None}
        try:
            count=upstream_calls()
            if type(count) is int and 0<=count<=1000000:observations['upstreamDispatchCount']=count
        except Exception:pass
        try:
            state=native_snapshot()
            counts={key:state.get(source) for key,source in (
              ('attempts','attempts'),('grants','grants'),('settled','settled'))}
            attempt_states=state.get('attempt_states')
            allowed_states={'prepared','retired','admitted','unknown','conflict','settled'}
            if all(type(value) is int and 0<=value<=1000000 for value in counts.values()):
                if (isinstance(attempt_states,dict) and set(attempt_states)==allowed_states and
                    all(type(value) is int and 0<=value<=1000000 for value in attempt_states.values())):
                    counts['attemptStates']=attempt_states
                observations['financialDurableCounts']=counts
        except Exception:pass
        return observations

    def invoke_compiled_client():
        try:initialize_compiled_client_phase(chief_name)
        except Exception:pass
        bridge_before=admission_bridge_summary()
        timed_out=False
        try:result=run('docker','exec','-e','FIRST_USE_PHASE_FILE='+COMPILED_CLIENT_PHASE_FILE,
          '-e','FIRST_USE_RESULT_FILE='+COMPILED_CLIENT_RESULT_FILE,chief_name,
          '/app/services/chief-of-staff/node_modules/.bin/tsx','/app/services/chief-of-staff/first-use-client.mts',
          check=False,timeout=90)
        except RuntimeError:
            timed_out=True;result=None
        except Exception:
            result=None
        if timed_out or result is None or result.returncode!=0:
            summary=compiled_client_phase_summary(chief_name)
            result_summary=compiled_client_result_summary(chief_name)
            bridge_after=admission_bridge_summary()
            exit_code=None if result is None or not 0<=result.returncode<=255 else result.returncode
            proof['firstUseClientDiagnostics']={'phase':summary['phase'],'markerValid':summary['markerValid'],
              'timedOut':timed_out,'exitCode':exit_code,'firstResult':result_summary,
              'admissionBridge':admission_bridge_delta(bridge_before,bridge_after),
              **fixed_client_failure_observations()}
            if timed_out:raise RuntimeError('Compiled signed request exceeded its time bound')
            raise RuntimeError('Compiled signed request failed')
        summary=compiled_client_phase_summary(chief_name)
        result_summary=compiled_client_result_summary(chief_name)
        bridge_after=admission_bridge_summary()
        proof['firstUseClientDiagnostics']={'phase':summary['phase'],'markerValid':summary['markerValid'],
          'timedOut':False,'exitCode':0,'firstResult':result_summary,
          'admissionBridge':admission_bridge_delta(bridge_before,bridge_after),
          **fixed_client_failure_observations()}
        return result.stdout.strip()

    before_request_state=native_snapshot()
    args=compiled_chief_start_args(chief_name=chief_name,network=network,agent_dir=agent_dir,run_dir=run_dir,
      capsule_source=capsule_source,client_script=client_script,chief_image=chief_image,secrets_dir=secrets_dir,agent=agent,
      incarnation=incarnation,owner=owner,definition_hash=definition_hash,workflow_database=workflow_database)
    try:launch_result=run('docker',*args,check=False,timeout=120)
    except RuntimeError:
        register_compiled_chief_container(chief_name,container_names)
        proof['compiledRuntimeDiagnostics']=compiled_startup_diagnostics(
          chief_name,failed_stage=stage,launch_timed_out=True)
        raise RuntimeError('Compiled Chief runtime container creation exceeded its time bound') from None
    if launch_result.returncode!=0:
        register_compiled_chief_container(chief_name,container_names)
        proof['compiledRuntimeDiagnostics']=compiled_startup_diagnostics(
          chief_name,failed_stage=stage,launch_result=launch_result)
        raise RuntimeError('Compiled Chief runtime container creation failed')
    register_compiled_chief_container(chief_name,container_names,created_by_success=True)
    stage = 'runtime-health'
    for _ in range(120):
        health=run('docker','exec',chief_name,'node','-e',"fetch('http://127.0.0.1:3000/eve/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",check=False)
        if health.returncode==0:break
        if docker('inspect','--format','{{.State.Running}}',chief_name)!='true':
            proof['compiledRuntimeDiagnostics']=compiled_startup_diagnostics(chief_name,failed_stage=stage)
            raise RuntimeError('Compiled Chief runtime exited before health check')
        time.sleep(.25)
    else:
        proof['compiledRuntimeDiagnostics']=compiled_startup_diagnostics(chief_name,failed_stage=stage)
        raise RuntimeError('Compiled Chief runtime did not become healthy')
    stage = 'runtime-config'
    runtime_environment=json.loads(docker('inspect','--format','{{json .Config.Env}}',chief_name))
    runtime_mounts=json.loads(docker('inspect','--format','{{json .Mounts}}',chief_name))
    env_values={entry.split('=',1)[0]:entry.split('=',1)[1] for entry in runtime_environment if '=' in entry}
    env_names=set(env_values)
    forbidden_keys={'GATEWAY_KEY_FILE','GATEWAY_MASTER_KEY_FILE','LITELLM_MASTER_KEY',
      'ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY'}
    if (env_names & forbidden_keys or any(name.endswith(('_API_KEY','_KEY_FILE')) for name in env_names) or
        'GATEWAY_URL' not in env_names or
        env_values.get('LARES_MODEL_PURPOSE_RUNTIME_SOCKET')!='/run/lares/model-purpose/model-purpose.sock' or
        env_values.get('LARES_AGENT_INCARNATION')!=incarnation or
        env_values.get('LARES_RUNTIME_CONTROL_SECRET_FILE')!='/run/secrets/runtime-control'):
        proof['compiledRuntimeDiagnostics']=compiled_startup_diagnostics(chief_name,failed_stage=stage)
        raise RuntimeError('Compiled Chief runtime environment did not match the managed-keyless contract')
    stage = 'runtime-secret-mounts'
    actual_secret_mounts=[mount for mount in runtime_mounts if mount.get('Destination','').startswith('/run/secrets/')]
    expected_secret_sources={
      '/run/secrets/app-password':str(secrets_dir/'app-password'),
      '/run/secrets/workflow-password':str(secrets_dir/'workflow-password'),
      '/run/secrets/route-password':str(secrets_dir/'route-password'),
      '/run/secrets/runtime-control':str(secrets_dir/'proof-agent-runtime-control'),
      '/run/secrets/console-model-purpose-signing-key':str(secrets_dir/'console-model-purpose-signing-key')}
    actual_secret_sources={mount.get('Destination'):mount.get('Source') for mount in actual_secret_mounts}
    if actual_secret_sources!=expected_secret_sources or any(mount.get('RW') for mount in actual_secret_mounts):
        proof['compiledRuntimeDiagnostics']=compiled_startup_diagnostics(chief_name,failed_stage=stage)
        raise RuntimeError('Compiled Chief runtime secret mounts did not match the narrow fixture')
    stage = 'runtime-protected-paths'
    protected_fixture_secrets={str(secrets_dir/name) for name in (
      'gateway-master','gateway-budget-service-key','native-policy.json','model-provider-key',
      'native-litellm-password','financial-database-password')}
    if (any(mount.get('Source')==str(secrets_dir) for mount in runtime_mounts) or
        any(mount.get('Source') in protected_fixture_secrets for mount in runtime_mounts)):
        proof['compiledRuntimeDiagnostics']=compiled_startup_diagnostics(chief_name,failed_stage=stage)
        raise RuntimeError('Compiled Chief runtime received protected fixture secret material')
    check_secret_paths=['/run/secrets/gateway-key','/run/secrets/gateway-master',
      '/run/secrets/gateway-budget-service-key','/run/secrets/native-policy.json',
      '/run/secrets/model-provider-key','/run/secrets/native-litellm-password',
      '/run/secrets/financial-database-password']
    for secret_path in check_secret_paths:
        result=run('docker','exec',chief_name,'test','!','-r',secret_path,check=False)
        if result.returncode:
            proof['compiledRuntimeDiagnostics']=compiled_startup_diagnostics(chief_name,failed_stage=stage)
            raise RuntimeError('Compiled Chief runtime could read a fixture-only protected secret')
    absent_gateway_path=run('docker','exec',chief_name,'test','!','-e','/run/secrets/gateway-key',check=False)
    if absent_gateway_path.returncode:
        proof['compiledRuntimeDiagnostics']=compiled_startup_diagnostics(chief_name,failed_stage=stage)
        raise RuntimeError('Legacy default gateway-key path exists in the compiled Chief runtime')
    cases['compiledChiefHasNoLegacyGatewayKeyAndOnlyNarrowSecretMounts']=True
    cases['compiledChiefRuntimeReady']=True

    stage = 'console-signature-and-first-model-request'
    client_result=invoke_first_use_and_capture(invoke_compiled_client,
      lambda:gateway_model_request_diagnostic(network+'-gateway'),proof)
    request_result=json.loads(client_result)
    if request_result.get('response')!='FIRST_USE_OK' or request_result.get('replayStatus',200)<400 or request_result.get('staleStatus',200)<400 or request_result.get('wrongMemberStatus',200)<400:
        raise RuntimeError('Signed first-use or refusal checks did not match the expected result')
    if upstream_calls()!=1:raise RuntimeError('Native upstream dispatch count was not exactly one')
    settlement_deadline=time.monotonic()+30
    settled=native_snapshot()
    while (settled['attempts']!=before_request_state['attempts']+1 or
           settled['grants']!=before_request_state['grants']+1 or
           settled['settled']!=before_request_state['settled']+1):
        if time.monotonic()>=settlement_deadline:break
        time.sleep(.25);settled=native_snapshot()
    if (settled['attempts']!=before_request_state['attempts']+1 or
        settled['grants']!=before_request_state['grants']+1 or
        settled['settled']!=before_request_state['settled']+1 or
        float(settled['liability'])<=float(before_request_state['liability'])):
        raise RuntimeError('The first native request did not produce durable settled liability')
    after_refusals=native_snapshot()
    if after_refusals!=settled or upstream_calls()!=1:
        raise RuntimeError('Replay, stale-body or wrong-member refusal changed durable usage or dispatched again')
    proof['settlement']={'upstreamDispatches':1,'attempts':settled['attempts'],'settled':settled['settled'],
      'settledLiability':settled['liability'],'endpointGeneration':settled['endpoint_generation']}
    proof['response']='FIRST_USE_OK'
    cases['oneConsoleSignedModelRequestSettled']=True
    cases['replayStaleBodyAndWrongMemberRefusedWithoutDispatch']=True

    stage = 'second-member-activation'
    second_activation=json.loads(host_cli('activate-native',{'bindingId':binding_ids[1],'credentialGeneration':'0'}))
    if second_activation.get('state')!='active':raise RuntimeError('Second native activation was not acknowledged')
    after_state=native_snapshot()
    if (after_state['selected_endpoint']!=settled['selected_endpoint'] or after_state['recovery_epoch']!=settled['recovery_epoch'] or
        after_state['endpoint_generation']!=settled['endpoint_generation'] or after_state['attempts']!=settled['attempts'] or
        after_state['grants']!=settled['grants'] or after_state['settled']!=settled['settled'] or after_state['liability']!=settled['liability']):
        raise RuntimeError('Second activation changed the endpoint, epoch, existing usage or liability')
    active_members=json.loads(financial_observer('members',base_config['budgetFinancial']['db']))['members']
    if len(active_members)!=2 or any(row['state']!='open' for row in active_members):raise RuntimeError('Second activation did not open both preprovisioned members')
    if upstream_calls()!=1:raise RuntimeError('Second activation caused an additional upstream dispatch')
    proof['secondActivation']={'bothMembersOpen':True,'endpointGeneration':after_state['endpoint_generation'],
      'attempts':after_state['attempts'],'settled':after_state['settled'],'settledLiability':after_state['liability']}
    cases['secondActivationPreservesEndpointEpochAndLiability']=True
    cases['bothMembersActiveAfterSecondActivation']=True
    proof['status']='passed'
    proof['failedStage']=None
except Exception:
    proof['status']='failed'
    proof['failedStage']=stage
    if stage in {'runtime-create','runtime-health','runtime-config','runtime-secret-mounts','runtime-protected-paths'} and 'compiledRuntimeDiagnostics' not in proof:
        try:proof['compiledRuntimeDiagnostics']=compiled_startup_diagnostics(chief_name,failed_stage=stage)
        except Exception:proof['compiledRuntimeDiagnostics']={'stage':stage,'container':safe_startup_container_state(found=False),'startupCategories':safe_startup_log_categories('')}
    raise SystemExit('Combined first-use proof failed at '+stage)
finally:
    cleanup_failed=False
    containers_stopped=True
    for name in reversed(container_names):
        try:
            if run('docker','rm','-f',name,check=False,timeout=30).returncode!=0:
                cleanup_failed=True
                containers_stopped=False
        except Exception:
            cleanup_failed=True
            containers_stopped=False
    for created,args in ((volume_created,('volume','rm',volume)),(network_created,('network','rm',network))):
        if not created:continue
        try:
            if run('docker',*args,check=False,timeout=30).returncode!=0:cleanup_failed=True
        except Exception:
            cleanup_failed=True
    ownership_restored=False
    if root.exists() and containers_stopped and not root_protected:
        try:
            shutil.rmtree(root)
            ownership_restored=not root.exists()
        except Exception:
            cleanup_failed=True
    elif root.exists() and containers_stopped:
        try:
            owner=f'{os.getuid()}:{os.getgid()}'
            restored=run('docker','run','--rm','--network','none','--user','0:0',
                '--mount',f'type=bind,src={root},dst=/fixture',
                '--entrypoint','sh',keeper_image,'-c',f'chown -R {owner} /fixture && chmod -R u+rwX /fixture',
                check=False,timeout=30)
            if restored.returncode!=0:cleanup_failed=True
            else:ownership_restored=True
        except Exception:
            cleanup_failed=True
        if ownership_restored:
            try:
                shutil.rmtree(root)
            except Exception:
                cleanup_failed=True
    elif root.exists():
        cleanup_failed=True
    if root.exists():cleanup_failed=True
    proof['cleanupState']='failed' if cleanup_failed else 'complete'
    if cleanup_failed:
        proof['status']='failed'
        if not proof.get('failedStage'):
            proof['failedStage']='cleanup'
    try:
        proof_file=pathlib.Path(proof_path)
        proof_file.parent.mkdir(parents=True,exist_ok=True)
        proof_file.write_text(json.dumps(proof,sort_keys=True,indent=2)+'\n')
    except Exception:
        raise SystemExit('Combined first-use proof artifact could not be written')
    if cleanup_failed:
        raise SystemExit('Combined first-use proof cleanup failed')
