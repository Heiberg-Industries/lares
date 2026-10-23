"""Actual Linux kernel + PostgreSQL continuity/restore proof; CI only, disposable data."""
import json, os, pathlib, secrets, shutil, subprocess, sys, tempfile, time, uuid

image = sys.argv[1]
repo = pathlib.Path(__file__).resolve().parents[3]
if os.environ.get('CI') != 'true':
    raise SystemExit('Keeper image proof runs only in disposable CI')
name = 'lares-continuity-proof-' + uuid.uuid4().hex[:10]
volume = name + '-custody'
native_admin = name + '-native-admin'
native_temp = pathlib.Path(tempfile.mkdtemp(prefix='lares-native-provision-proof-'))
native_fixture = native_temp / 'fixture'
native_fixture.mkdir(mode=0o700)
db_fixture = native_temp / 'database-credentials'
db_fixture.mkdir(mode=0o700)
offline_fixture = native_temp / 'offline-operator-credentials'
offline_fixture.mkdir(mode=0o700)
application_password = secrets.token_urlsafe(32)
financial_password = secrets.token_urlsafe(32)
operator_password = secrets.token_urlsafe(32)
for filename, value in [('application-password', application_password), ('financial-password', financial_password)]:
    path = db_fixture / filename
    path.write_text(value)
    path.chmod(0o600)
operator_path = offline_fixture / 'operator-password'
operator_path.write_text(operator_password)
operator_path.chmod(0o600)
native_custody = native_temp / 'budget-native'
managed_databases = []
tsx = '/app/services/keeper/node_modules/.bin/tsx'
base = '/app/services/keeper/lib/'

def command(*args, input=None, check=True):
    result = subprocess.run(args, input=input, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=90)
    if check and result.returncode:
        raise RuntimeError(result.stdout)
    return result

def sql(body, database='proof'):
    return command('docker', 'exec', '-i', name + '-db', 'psql', '-X', '-v',
                   'ON_ERROR_STOP=1', '-U', 'proof', '-d', database, input=body).stdout

def ready():
    for _ in range(90):
        result = command('docker', 'exec', '-e', 'PGPASSWORD=disposable-proof-only',
                         name + '-db', 'psql', '-h', '127.0.0.1', '-U', 'proof',
                         '-d', 'proof', '-Atc', 'SELECT 1', check=False)
        if result.returncode == 0:
            return
        time.sleep(.2)
    raise RuntimeError('Disposable PostgreSQL did not become ready')

def offline_prepare_fresh(database, journal_directory, host='proof-db'):
    """Run the production root-only ceremony with a one-shot operator secret mount."""
    config = offline_fixture / f'financial-setup-{journal_directory}.json'
    config.write_text(json.dumps({'mode':'overlay','project':'proof','dir':'/tmp','files':['config'],
        'agentsDir':'/tmp','retiredDir':'/tmp','secretsDir':'/tmp','rolesDir':'/tmp',
        'templatesDir':'/tmp','backupDir':'/tmp','db':{'host':host,'port':5432,'database':database,
        'user':'lares_app','passwordFile':'/fixtures/application-password'}}))
    invocation = ('set -eu; cp /operator-source/operator-password /operator-secrets/operator-password; '
        'chmod 600 /operator-secrets/operator-password; '
        '/app/services/keeper/node_modules/.bin/tsx /app/services/keeper/bin/budget-financial.ts '
        'prepare-fresh --confirm-fresh-installation --operator-password-file '
        f'/operator-secrets/operator-password /operator-source/{config.name}; '
        f'test ! -e /var/lib/lares/{journal_directory}; '
        f'mv /var/lib/lares/budget-financial /var/lib/lares/{journal_directory}')
    args = ['docker','run','--rm','--network',name,'--mount',
        f'type=volume,src={volume},dst=/var/lib/lares',
        '--mount',f'type=bind,src={db_fixture},dst=/fixtures,readonly',
        '--mount',f'type=bind,src={offline_fixture},dst=/operator-source,readonly',
        '--tmpfs','/operator-secrets:rw,noexec,nosuid,nodev,mode=0700',
        '--entrypoint','sh',image,'-c',invocation]
    result = command(*args)
    lines = result.stdout.strip().splitlines()
    try:
        binding = json.loads(lines[-1])['budgetFinancial']
    except (IndexError, KeyError, json.JSONDecodeError):
        raise RuntimeError('Production fresh-custody command did not return its binding') from None
    if not lines[-2].startswith('Fresh financial custody prepared.') or binding['directory'] != '/var/lib/lares/budget-financial' or binding['db']['user'] != 'lares_financial':
        raise RuntimeError('Production fresh-custody command returned an unexpected binding')

def bounded_native_command(*args, timeout=120):
    """Native-provisioning helpers never return raw process output or request data."""
    try:
        result = subprocess.run(args, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Native provisioning fixture timed out') from None
    if len(result.stdout.encode('utf-8', errors='replace')) > 8192:
        raise RuntimeError('Native provisioning fixture output exceeded its bound')
    if result.returncode:
        raise RuntimeError('Native provisioning fixture failed')
    return result.stdout.strip()


def initialize_native_custody():
    initializer = name + '-native-custody-init'
    code = f"""import{{mkdirSync}}from'node:fs';
import{{BudgetNativeCustodyStore}}from'{base}budget-native-custody.ts';
mkdirSync('/var/lib/lares',{{recursive:true,mode:0o755}});
const store=BudgetNativeCustodyStore.createNew('/var/lib/lares/budget-native');store.close();console.log('custody-ready');"""
    bounded_native_command('docker', 'create', '--name', initializer, '--network', 'none',
                           '--entrypoint', tsx, image, '-e', code)
    try:
        output = bounded_native_command('docker', 'start', '--attach', initializer, timeout=30)
        if output != 'custody-ready':
            raise RuntimeError('Native custody initializer returned an unexpected result')
        # The production store is initialized in Keeper itself, then staged as a closed,
        # protected fixture and mounted at its exact runtime path for the proof process.
        bounded_native_command('docker', 'cp', initializer + ':/var/lib/lares/budget-native',
                               str(native_temp))
        bounded_native_command('docker', 'run', '--rm', '--network', 'none',
                               '--mount', f'type=bind,src={native_custody},dst=/native-custody',
                               '--entrypoint', 'sh', image, '-c',
                               'chown -R 0:0 /native-custody && chmod 700 /native-custody && chmod 600 /native-custody/*')
    finally:
        bounded_native_command('docker', 'rm', '--force', initializer, timeout=30)


def start_native_admin():
    master = 'sk-' + secrets.token_urlsafe(32)
    # Match the isolated disposable PostgreSQL fixture role created by this probe.
    password = 'disposable-proof-only'
    (native_fixture / 'master').write_text(master)
    (native_fixture / 'password').write_text(password)
    for filename in ('master', 'password'):
        (native_fixture / filename).chmod(0o600)
    config = {
        'model_list': [],
        'litellm_settings': {'telemetry': False, 'disable_aiohttp_transport': True},
        'general_settings': {'master_key': 'os.environ/LARES_GATEWAY_MASTER_KEY',
                             'background_health_checks': False},
    }
    (native_fixture / 'native-config.yaml').write_text(json.dumps(config))
    (native_fixture / 'native-admin-start.sh').write_text("""#!/bin/sh
set -eu
LARES_GATEWAY_MASTER_KEY=$(cat /fixture/master); export LARES_GATEWAY_MASTER_KEY
LARES_DATABASE_PASSWORD=$(cat /fixture/password)
DATABASE_URL=\"postgresql://proof:${LARES_DATABASE_PASSWORD}@proof-db:5432/native_litellm\"; export DATABASE_URL
LARES_DATABASE_PASSWORD=
CONFIG_FILE_PATH=/fixture/native-config.yaml; export CONFIG_FILE_PATH
LITELLM_RUST=False; DISABLE_AIOHTTP_TRANSPORT=True; LITELLM_TELEMETRY=False; export LITELLM_RUST DISABLE_AIOHTTP_TRANSPORT LITELLM_TELEMETRY
litellm --config \"$CONFIG_FILE_PATH\" --skip_server_startup --enforce_prisma_migration_check
exec litellm --config \"$CONFIG_FILE_PATH\"
""")
    (native_fixture / 'native-admin-start.sh').chmod(0o700)
    bounded_native_command('docker', 'run', '-d', '--name', native_admin,
                           '--network', name, '--network-alias', 'native-admin',
                           '--mount', f'type=bind,src={native_fixture},dst=/fixture,readonly',
                           '--entrypoint', '/bin/sh',
                           '-e', 'PGHOST=proof-db', '-e', 'PGPORT=5432', '-e', 'PGUSER=proof',
                           '-e', 'PGDATABASE=native_litellm', '-e', 'LITELLM_TELEMETRY=False',
                           '-e', 'LITELLM_LOCAL_MODEL_COST_MAP=True',
                           json.loads((repo / 'releases/2026-10-21-rc.12.json').read_text())['images']['lares-gateway'],
                           '/fixture/native-admin-start.sh')
    ready_script = """let ready=false;for(let i=0;i<360;i++){try{const r=await fetch('http://native-admin:4000/health/liveliness',{signal:AbortSignal.timeout(1000)});if(r.status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}if(!ready)process.exit(2);console.log('native-ready');"""
    output = bounded_native_command('docker', 'run', '--rm', '--network', name,
                                    '--entrypoint', 'node', image, '-e', ready_script, timeout=120)
    if output != 'native-ready':
        raise RuntimeError('Pinned native listener did not become ready')
    version = bounded_native_command('docker', 'exec', native_admin, 'python', '-c',
                                     "import importlib.metadata;print(importlib.metadata.version('litellm'))")
    if version != '1.101.6':
        raise RuntimeError('Pinned native listener has an unexpected LiteLLM version')


def run_native_provisioning(code):
    container = name + '-native-provision'
    args = ('docker', 'run', '--name', container, '--network', name,
            '--mount', 'type=volume,src=' + volume + ',dst=/proof',
            '--mount', f'type=bind,src={db_fixture},dst=/db-fixture,readonly',
            '--mount', f'type=bind,src={native_custody},dst=/var/lib/lares/budget-native',
            '--mount', f'type=bind,src={native_fixture},dst=/native-fixture,readonly',
            '-w', '/app/services/keeper', '--entrypoint', tsx, image, '-e', code)
    try:
        output = bounded_native_command(*args, timeout=120)
    finally:
        bounded_native_command('docker', 'rm', '--force', container, timeout=30)
    if output != 'native-provisioning-proof:complete':
        raise RuntimeError('Native provisioning proof returned an unexpected result')


def run(code, database='proof', host='proof-db'):
    prefix = f"""import{{Pool}}from'pg';
import{{HostFinancialJournal}}from'{base}financial-journal.ts';
import{{verifyFinancialContinuity,observeFinancialDatabase}}from'{base}financial-continuity.ts';
import{{JournalBudgetFinancialWriter}}from'{base}budget-financial-writer.ts';
import{{provisionBudgetAccounts}}from'{base}budget-account-provisioning.ts';
import{{consoleSourceTransaction,noteBudgetFinancialChange}}from'/app/packages/agent-kit/src/console-source-transaction.ts';
import{{budgetAccountProvisionPlanSchema}}from'{base}budget-account-provisioning.ts';
import{{registerAction}}from'{base}actions.ts';
import{{serve}}from'{base}socket-server.ts';
import{{PgBudgetAdmissionStore,budgetIdentitySuppression,canonicalBudgetMoney}}from'/app/packages/agent-kit/src/budget-admission-store.ts';
import{{captureModelInvocation,runModelInvocation}}from'/app/packages/agent-kit/src/model-invocation.ts';
import{{bindConsoleSession}}from'/app/packages/agent-kit/src/console-turn-authority.ts';
import{{PgGrantStore}}from'/app/packages/agent-kit/src/grant-store.ts';
import{{productionGatewayBudgetAuthority}}from'{base}gateway-budget.ts';
import{{GATEWAY_ADMIT_PATH,GATEWAY_SETTLE_PATH,gatewayCanonical,gatewaySignature,gatewayHash,verifyGatewaySignature}}from'/app/packages/agent-kit/src/gateway-admission-protocol.ts';
import{{chmodSync,readFileSync,writeFileSync}}from'node:fs';
import{{createHash,randomUUID}}from'node:crypto';
const pool=new Pool({{host:{json.dumps(host)},database:{json.dumps(database)},user:'lares_financial',password:readFileSync('/db-fixture/financial-password','utf8'),max:1,connectionTimeoutMillis:1500}});
async function main(){{try{{{code}}}finally{{await pool.end();}}}}void main().catch(e=>{{console.error(e);process.exitCode=1;}});"""
    return command('docker', 'run', '--rm', '--network', name, '--mount',
                   'type=volume,src=' + volume + ',dst=/proof', '--mount',
                   f'type=bind,src={db_fixture},dst=/db-fixture,readonly', '-w',
                   '/app/services/keeper', '--entrypoint', tsx, image, '-e', prefix).stdout.strip()


def setup_managed_cluster(label, host, journal_directory):
    """Prepare one isolated positive engine database under the production helper contract."""
    container = name + '-' + label + '-db'
    managed_databases.append(container)
    command('docker','run','-d','--name',container,'--network',name,'--network-alias',host,
        '-e','POSTGRES_USER=proof','-e','POSTGRES_PASSWORD=disposable-proof-only','-e','POSTGRES_DB=proof','pgvector/pgvector:pg16')
    for _ in range(90):
        ready_result = command('docker','exec','-e','PGPASSWORD=disposable-proof-only',container,'psql','-h','127.0.0.1','-U','proof','-d','proof','-Atc','SELECT 1',check=False)
        if ready_result.returncode == 0:
            break
        time.sleep(.2)
    else:
        raise RuntimeError('Isolated positive PostgreSQL did not become ready')
    for migration in sorted((repo / 'services/box/sql').glob('[0-9][0-9][0-9]_*.sql')):
        command('docker','exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','proof','-d','proof',input=migration.read_text())
    privilege_setup = native_temp / f'prepare-{label}-engine-privileges.mts'
    privilege_setup.write_text("import {readFileSync} from 'node:fs';\nimport {Pool} from 'pg';\nimport {provisionEngineDatabasePrivileges} from '/app/services/box/lib/database-privileges.ts';\n"
        f"const pool=new Pool({{host:{json.dumps(host)},database:'proof',user:'proof',password:'disposable-proof-only',max:1}});try{{const client=await pool.connect();try{{const result=await provisionEngineDatabasePrivileges(client,{{expectedDatabase:'proof',passwords:{{application:readFileSync('/db-fixture/application-password'),financial:readFileSync('/db-fixture/financial-password')}}}});if(!['applied','verified'].includes(result.status))throw Error();}}finally{{client.release();}}console.log('engine-privileges-ready');}}finally{{await pool.end();}}\n")
    result = command('docker','run','--rm','--network',name,'--mount',f'type=bind,src={db_fixture},dst=/db-fixture,readonly',
        '--mount',f'type=bind,src={privilege_setup},dst=/app/services/keeper/{privilege_setup.name},readonly',
        '--workdir','/app/services/keeper','--entrypoint',tsx,image,f'/app/services/keeper/{privilege_setup.name}')
    if result.stdout.strip() != 'engine-privileges-ready':
        raise RuntimeError('Isolated positive engine privileges were not prepared')
    command('docker','exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','proof','-d','proof',
        input=f"CREATE ROLE lares_operator LOGIN SUPERUSER PASSWORD '{operator_password}';")
    assert run("const db=await pool.connect();let code='';try{await db.query('BEGIN');try{await db.query('LOCK TABLE budget_accounts,budget_windows,budget_gateway_bindings,budget_attempts,budget_gateway_grants,budget_financial_checkpoints IN ACCESS EXCLUSIVE MODE');}catch(error){code=error.code;}finally{await db.query('ROLLBACK');}}finally{db.release();}if(code!=='42501')throw Error('online financial role unexpectedly acquired exclusive custody locks');console.log('financial-lock-denied:42501');", host=host) == 'financial-lock-denied:42501'
    offline_prepare_fresh('proof',journal_directory,host)
    prepared = run(f"const j=HostFinancialJournal.openExisting('/proof/{journal_directory}',{{requirePrepared:true}});j.close();console.log('prepared');", host=host)
    if prepared != 'prepared':
        raise RuntimeError('Production offline command did not prepare isolated financial custody')


def discard_managed_cluster(label):
    container = name + '-' + label + '-db'
    command('docker', 'rm', '--force', container, check=False)
    if container in managed_databases:
        managed_databases.remove(container)


try:
    command('docker', 'network', 'create', '--internal', name)
    command('docker', 'volume', 'create', volume)
    command('docker', 'run', '-d', '--name', name + '-db', '--network', name,
            '--network-alias', 'proof-db', '-e', 'POSTGRES_USER=proof', '-e',
            'POSTGRES_PASSWORD=disposable-proof-only', '-e', 'POSTGRES_DB=proof',
            'pgvector/pgvector:pg16')
    ready()
    for migration in sorted((repo / 'services/box/sql').glob('[0-9][0-9][0-9]_*.sql')):
        sql(migration.read_text())
    privilege_setup = native_temp / 'prepare-engine-privileges.mts'
    privilege_setup.write_text("import {readFileSync} from 'node:fs';\nimport {Pool} from 'pg';\nimport {provisionEngineDatabasePrivileges} from '/app/services/box/lib/database-privileges.ts';\n"
        "const pool=new Pool({host:'proof-db',database:'proof',user:'proof',password:'disposable-proof-only',max:1});try{const client=await pool.connect();try{const result=await provisionEngineDatabasePrivileges(client,{expectedDatabase:'proof',passwords:{application:readFileSync('/db-fixture/application-password'),financial:readFileSync('/db-fixture/financial-password')}});if(!['applied','verified'].includes(result.status))throw Error();}finally{client.release();}console.log('engine-privileges-ready');}finally{await pool.end();}\n")
    privilege_result = command('docker','run','--rm','--network',name,'--mount',f'type=bind,src={db_fixture},dst=/db-fixture,readonly',
        '--mount',f'type=bind,src={privilege_setup},dst=/app/services/keeper/prepare-engine-privileges.mts,readonly',
        '--workdir','/app/services/keeper','--entrypoint',tsx,image,'/app/services/keeper/prepare-engine-privileges.mts')
    assert privilege_result.stdout.strip() == 'engine-privileges-ready', 'Production engine database privileges were not prepared'
    sql(f"CREATE ROLE lares_operator LOGIN SUPERUSER PASSWORD '{operator_password}';")
    # Each scenario uses the real empty migrated schema, not guessed fixture tables.
    sql('CREATE DATABASE restoreproof TEMPLATE proof; CREATE DATABASE clusterproof TEMPLATE proof; CREATE DATABASE unknownproof TEMPLATE proof; CREATE DATABASE crashproof TEMPLATE proof; CREATE DATABASE native_litellm;')
    for database, directory in [('proof', 'restart'), ('restoreproof', 'restore'), ('clusterproof', 'cluster'), ('unknownproof', 'unknown'), ('crashproof', 'crash')]:
        if database == 'proof':
            assert run("const db=await pool.connect();let code='';try{await db.query('BEGIN');try{await db.query('LOCK TABLE budget_accounts,budget_windows,budget_gateway_bindings,budget_attempts,budget_gateway_grants,budget_financial_checkpoints IN ACCESS EXCLUSIVE MODE');}catch(error){code=error.code;}finally{await db.query('ROLLBACK');}}finally{db.release();}if(code!=='42501')throw Error('online financial role unexpectedly acquired exclusive custody locks');console.log('financial-lock-denied:42501');", database) == 'financial-lock-denied:42501'
        offline_prepare_fresh(database,directory)
        assert run(f"const j=HostFinancialJournal.openExisting('/proof/{directory}',{{requirePrepared:true}});j.close();console.log('prepared');", database) == 'prepared'
    # Actual killed prepared writer: no caller explicitly freezes it before death.
    holder = f"import{{HostFinancialJournal}}from'{base}financial-journal.ts';const j=HostFinancialJournal.openExisting('/proof/crash',{{requirePrepared:true}});console.log('locked');setInterval(()=>{{}},1000);"
    command('docker', 'run', '--detach', '--rm', '--name', name + '-holder', '--network', 'none', '--mount',
            'type=volume,src=' + volume + ',dst=/proof', '--entrypoint', tsx, image, '-e', holder)
    for _ in range(60):
        if 'locked' in command('docker', 'logs', name + '-holder').stdout:
            break
        time.sleep(.1)
    else:
        raise RuntimeError('Prepared custody holder did not acquire ownership')
    assert run("let denied=false;try{HostFinancialJournal.openExisting('/proof/crash',{requirePrepared:true});}catch{denied=true;}if(!denied)throw Error('competing prepared owner acquired lock');console.log('excluded');", 'crashproof') == 'excluded'
    command('docker', 'rm', '--force', name + '-holder')
    assert run("const records=()=>readFileSync('/proof/crash/journal.jsonl','utf8').trimEnd().split('\\n').map(line=>JSON.parse(line).record);if(records().at(-1).kind!=='writer-open'||records().some(r=>r.kind==='freeze'))throw Error('writer was not abandoned');const j=HostFinancialJournal.openExisting('/proof/crash',{requirePrepared:true});if(records().at(-1).kind!=='freeze')throw Error('abandoned writer was not durably frozen');const db=await pool.connect();let denied=false;try{await verifyFinancialContinuity(j,db);}catch{denied=true;}finally{db.release();j.close();}if(!denied)throw Error('abandoned writer resumed');console.log('frozen');", 'crashproof') == 'frozen'
    # Real PostgreSQL provisioning at pool max=1 covers closed state, durable projection,
    # exact retries, explicit cap changes and UTC month rollover.
    setup_managed_cluster('provision', 'provision-proof-db', 'provision')
    command('docker','exec','-i',name+'-provision-db','psql','-X','-v','ON_ERROR_STOP=1','-U','proof','-d','proof',input="INSERT INTO orgs(id,display_name) VALUES('provision-proof-org','Provision proof'); INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('provision-proof-a','A','provision-proof-org','owner','active'),('provision-proof-b','B','provision-proof-org','member','active'); INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES('provision-proof-a','https://identity.example.invalid','subject-a','tenant'),('provision-proof-b','https://identity.example.invalid','subject-b','tenant'); INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES('provision-proof-a',25),('provision-proof-b',40);")
    provision = """const j=HostFinancialJournal.openExisting('/proof/provision',{requirePrepared:true});
const plan={installationCap:'100',memberIds:['provision-proof-a','provision-proof-b']};
const first=await provisionBudgetAccounts(pool,j,plan);
if(first.state!=='closed'||first.reason!=='unreconciled'||first.members!==2||first.accountsCreated!==3||first.windowsCreated!==3)throw Error('fresh provisioning projection changed');
const rows=(await pool.query('SELECT kind,state,reason,policy_generation,active_window_id,installation_cap,selected_endpoint,recovery_epoch FROM budget_accounts ORDER BY kind,id')).rows;
if(rows.length!==3||rows.some(a=>a.state!=='closed'||a.reason!=='unreconciled'||a.selected_endpoint!==null||a.recovery_epoch!==null||a.policy_generation!=='1'||!a.active_window_id))throw Error('new financial accounts were not closed with trigger generation');
const exact=await provisionBudgetAccounts(pool,j,plan);
if(exact.accountsCreated!==0||exact.windowsCreated!==0)throw Error('exact retry was not idempotent');
const changed=await provisionBudgetAccounts(pool,j,{...plan,installationCap:'120'});
if(changed.accountsCreated!==0||changed.windowsCreated!==0)throw Error('same-month cap change created an account or window');
const count=(await pool.query('SELECT count(*)::int AS n FROM budget_windows')).rows[0].n;
if(count!==3||(await pool.query(\"SELECT installation_cap::text FROM budget_accounts WHERE kind='installation'\")).rows[0].installation_cap!=='120')throw Error('same-month cap update changed immutable window count');
await j.drainForShutdown();j.close();
const cliJournal=HostFinancialJournal.openExisting('/proof/provision',{requirePrepared:true});
registerAction({name:'budget.provision-accounts',hostOnly:true,input:budgetAccountProvisionPlanSchema,secretFields:['memberIds'],run:input=>provisionBudgetAccounts(pool,cliJournal,input)});
const stop=await serve({socket:'/run/lares-host/keeper.sock',host:true,context:{actor:'host',audit:async()=>{}}});
const configPath='/tmp/budget-financial-cli-proof.json';
writeFileSync(configPath,JSON.stringify({mode:'overlay',project:'proof',dir:'/tmp',files:['config'],agentsDir:'/tmp',retiredDir:'/tmp',secretsDir:'/tmp',rolesDir:'/tmp',templatesDir:'/tmp',backupDir:'/tmp',db:{host:'provision-proof-db',port:5432,database:'proof',user:'lares_app',passwordFile:'/db-fixture/application-password'},budgetFinancial:{directory:'/var/lib/lares/budget-financial',db:{host:'provision-proof-db',port:5432,database:'proof',user:'lares_financial',passwordFile:'/db-fixture/financial-password'}}}));
const runCli=async(input)=>{
  const {spawn}=await import('node:child_process');
  const child=spawn('/app/services/keeper/node_modules/.bin/tsx',['/app/services/keeper/bin/budget-financial.ts','provision-accounts','--host',configPath],{stdio:['pipe','pipe','pipe']});
  const maxOutputBytes=4096;let stdout='',stdoutBytes=0,stderrBytes=0,overflow=false,timedOut=false;
  child.stdin.on('error',()=>{});
  const collect=(stream,target)=>stream.on('data',chunk=>{
    if(target==='stdout'){
      stdoutBytes+=chunk.length;
      if(stdoutBytes<=maxOutputBytes)stdout+=chunk.toString('utf8');
      else overflow=true;
    }else stderrBytes+=chunk.length;
    if((stdoutBytes>maxOutputBytes||stderrBytes>maxOutputBytes)&&!child.killed)child.kill('SIGKILL');
  });
  collect(child.stdout,'stdout');collect(child.stderr,'stderr');
  let timer;
  try{
    const result=await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
      timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},7000);
      timer.unref();
      child.stdin.end(JSON.stringify(input));
    });
    if(timedOut)throw Error('root financial CLI timed out');
    if(overflow)throw Error('root financial CLI output exceeded its bound');
    return {...result,stdout};
  }finally{if(timer)clearTimeout(timer);}
};
try{
  const cli=await runCli({...plan,installationCap:'120'});
  if(cli.code!==0)throw Error('root financial CLI did not complete through the host socket');
  const ack=JSON.parse(cli.stdout.trim());if(ack.state!=='closed'||ack.reason!=='unreconciled'||ack.members!==2||ack.accountsCreated!==0||ack.windowsCreated!==0||cli.stdout.includes('provision-proof-a'))throw Error('root financial CLI acknowledgement exposed unexpected state');
}finally{try{await stop();}finally{try{await cliJournal.drainForShutdown();}finally{cliJournal.close();}}}
const rolloverJournal=HostFinancialJournal.openExisting('/proof/provision',{requirePrepared:true});
const rolloverStart=(await pool.query('SELECT max(ends_at) AS start FROM budget_windows')).rows[0].start;
const rolloverEnd=new Date(Date.UTC(rolloverStart.getUTCFullYear(),rolloverStart.getUTCMonth()+1,1));
const databaseTime=(value)=>value.toISOString().replace('.000Z','.000000Z');
try{
  const rollover=await provisionBudgetAccounts(pool,rolloverJournal,{...plan,installationCap:'120'},async()=>({startsAt:databaseTime(rolloverStart),endsAt:databaseTime(rolloverEnd)}));
  if(rollover.accountsCreated!==0||rollover.windowsCreated!==3||(await pool.query('SELECT count(*)::int AS n FROM budget_windows')).rows[0].n!==6)throw Error('UTC rollover did not retain old windows and create the new month');
  const projection=readFileSync('/proof/provision/journal.jsonl','utf8').trimEnd().split('\\n').map(line=>JSON.parse(line).record).filter(r=>r.kind==='proposal').flatMap(r=>r.atoms);
  if(projection.filter(a=>a.kind==='account').some(a=>typeof a.policyGeneration!=='string'))throw Error('account policy generation missing from durable projection');
}finally{try{await rolloverJournal.drainForShutdown();}finally{rolloverJournal.close();}}
console.log(JSON.stringify({fresh:true,exactRetry:true,members:2,policyGeneration:true,sameMonthCapChange:true,actualRootCliHostSocket:true,utcRollover:true}));"""
    print(run(provision, host='provision-proof-db'))
    discard_managed_cluster('provision')
    # Actual signed gateway requests drive admission, grant and settlement through the
    # prepared Keeper journal and the same one-connection PostgreSQL pool.
    setup_managed_cluster('gateway', 'gateway-proof-db', 'gateway')
    gateway = r"""const journal=HostFinancialJournal.openExisting('/proof/gateway',{requirePrepared:true});
try{
const hash=value=>createHash('sha256').update(value).digest('hex'),env={LARES_AGENT_NAME:'helper',LARES_AGENT_INCARNATION:'11111111-1111-4111-8111-111111111111',AGENT_OWNER_USER_ID:'member-a'};
const memberNonce=createHash('sha256').update('member-a:gateway-proof').digest('base64url'),sessionId='gateway-proof';
const auth={authenticator:'lares-console',attributes:{lares_member_id:'member-a',lares_admission_nonce:memberNonce,lares_purpose:'human'}};
const context={session:{id:sessionId,turn:{id:'turn-1',sequence:0},auth:{current:auth,initiator:auth}}};
const grants=new PgGrantStore(pool),incarnation=env.LARES_AGENT_INCARNATION,endpoint=hash('endpoint'),profile=hash('profile'),fingerprint=hash('key');
await pool.query("INSERT INTO orgs(id,display_name) VALUES('org','Example')");
await pool.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('member-a','A','org','owner','active')");
await pool.query("INSERT INTO org_member_policy(user_id,allowed_capabilities,spend_cap_usd_month) VALUES('member-a',NULL,1)");
await pool.query("INSERT INTO agent_definitions(name,definition,hash) VALUES('helper','{\"grants\":[]}','fixture')");
await pool.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending) VALUES('helper','127.0.0.2','helper','owned',$1,$1,'ready',false)",[incarnation]);
const adopted=await grants.adoptAgent('member-a',{agentName:'helper',expectedDefinitionHash:'fixture'},{designatedOwnerMemberId:'member-a'});
await grants.updateAgentAccess('member-a',{agentName:'helper',expectedRevision:adopted.accessRevision,grants:[{principal:{kind:'organisation',id:'org'},permission:'use',expiresAt:null}]});
await bindConsoleSession({agent:'helper',incarnation,memberId:'member-a',admissionNonce:memberNonce,sessionId},pool,env);
const installation=randomUUID(),member=randomUUID(),installationWindow=randomUUID(),memberWindow=randomUUID(),binding=randomUUID();
const suppression=budgetIdentitySuppression(Buffer.alloc(32,1),{canonicalMemberId:'member-a',providers:[{issuer:'https://issuer.invalid',subject:'member-a',tenantId:'tenant'}]});
const writer=new JournalBudgetFinancialWriter(journal);
await writer.run('provision',boundary=>consoleSourceTransaction(pool,async source=>{
await source.query("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,installation_cap,selected_endpoint,recovery_epoch) VALUES($1,'installation','installation',$1,1,$2,'epoch-1')",[installation,endpoint]);noteBudgetFinancialChange(source,'budget_accounts',installation);
await source.query("INSERT INTO budget_windows(id,account_id,live_member_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision) VALUES($1,$2,NULL,clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 day',0,1,0)",[installationWindow,installation]);noteBudgetFinancialChange(source,'budget_windows',installationWindow);
await source.query("UPDATE budget_accounts SET active_window_id=$2,state='open',reason='approved' WHERE id=$1",[installation,installationWindow]);noteBudgetFinancialChange(source,'budget_accounts',installation);
await source.query("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,live_member_id,organisation_id,canonical_suppression_hash,provider_suppression_hashes) VALUES($1,'installation','member',$2,'member-a','org',$3,$4)",[member,installation,suppression.canonicalSuppressionHash,suppression.providerSuppressionHashes]);noteBudgetFinancialChange(source,'budget_accounts',member);
await source.query("INSERT INTO budget_windows(id,account_id,live_member_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision) VALUES($1,$2,'member-a',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 day',0,1,0)",[memberWindow,member]);noteBudgetFinancialChange(source,'budget_windows',memberWindow);
await source.query("UPDATE budget_accounts SET active_window_id=$2,state='open',reason='approved' WHERE id=$1",[member,memberWindow]);noteBudgetFinancialChange(source,'budget_accounts',member);
const pricing={version:1,capabilityHash:profile,format:'openai',limits:{inputTokens:1000,outputTokens:1000},usdPerMillionTokens:{input:'10',output:'90',cacheRead:'5',cacheWrite:'0'}};
await source.query("INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,key_fingerprint,agent,incarnation,purpose_alias,profile_hash,maximum_liability,pricing_profile,state) VALUES($1,$2,$3,'member-a',$4,0,$5,'helper',$6,'standard',$7,0.1,$8::jsonb,'active')",[binding,installation,member,endpoint,fingerprint,incarnation,profile,JSON.stringify(pricing)]);noteBudgetFinancialChange(source,'budget_gateway_bindings',binding);
},boundary));
const store=new PgBudgetAdmissionStore(pool,env,30_000,writer),requestHash=hash('request'),invocation=captureModelInvocation({type:'step.started',data:{turnId:'turn-1',sequence:0,stepIndex:0}},context.session,'standard');
const ticket=await runModelInvocation(invocation,()=>store.prepareIntent({bindingId:binding,requestHash,profileHash:profile}));
const key=Buffer.alloc(32,9),serviceKey='/proof/gateway-service-key';writeFileSync(serviceKey,key,{mode:0o600});chmodSync(serviceKey,0o600);
const authority=productionGatewayBudgetAuthority(pool,serviceKey,journal);
const document={version:1,nonce:hash('nonce'),ticket,requestHash,profileHash:profile,endpointHash:endpoint,keyFingerprint:fingerprint,purposeAlias:'standard'},raw=gatewayCanonical(document);
const admitted=await authority.handle(GATEWAY_ADMIT_PATH,gatewaySignature(key,'request',GATEWAY_ADMIT_PATH,raw),raw);
if(admitted.status!==200||!verifyGatewaySignature(key,admitted.headers['x-lares-signature'],'response',GATEWAY_ADMIT_PATH,admitted.body))throw Error('signed gateway admission failed');
const grant=JSON.parse(admitted.body.toString()),settlement={version:1,nonce:grant.nonce,requestHash:grant.requestHash,profileHash:grant.profileHash,endpointHash:grant.endpointHash,keyFingerprint:grant.keyFingerprint,purposeAlias:grant.purposeAlias,attemptId:grant.attemptId,bindingId:grant.bindingId,kind:'terminal-usage',format:'openai',usage:{inputTokens:100,outputTokens:100,cacheReadTokens:40,cacheWriteTokens:0}};
settlement.receiptHash=gatewayHash(gatewayCanonical(settlement));const terminal=gatewayCanonical(settlement),reply=await authority.handle(GATEWAY_SETTLE_PATH,gatewaySignature(key,'request',GATEWAY_SETTLE_PATH,terminal),terminal);
if(reply.status!==200||JSON.parse(reply.body.toString()).state!=='settled')throw Error('signed gateway settlement failed');
const frames=readFileSync('/proof/gateway/journal.jsonl','utf8').trimEnd().split('\n').map(line=>JSON.parse(line)),records=frames.map(frame=>frame.record),proposals=frames.filter(frame=>frame.record.kind==='proposal');
const observations=frames.filter(frame=>frame.record.kind==='observation'),control=records.find(value=>value.kind==='control')?.control;
if(JSON.stringify(records.filter(record=>record.kind==='begin').map(record=>record.operation))!==JSON.stringify(['provision','prepare','admit','grant','settle'])||proposals.length!==5||records.filter(record=>record.kind==='commit').length!==5||observations.length!==5)throw Error('gateway journal operations incomplete');
for(const frame of proposals){const record=frame.record,row=(await pool.query('SELECT journal_id,proposal_sequence::text,proposal_digest FROM budget_financial_checkpoints WHERE operation_id=$1',[record.operationId])).rows[0],commitIndex=records.findIndex(value=>value.kind==='commit'&&value.operationId===record.operationId),observationIndex=records.findIndex(value=>value.kind==='observation'&&value.operationId===record.operationId),observation=records[observationIndex]?.observation;
if(!row||!control||row.journal_id!==control.journalId||row.proposal_sequence!==String(record.sequence)||row.proposal_digest!==frame.digest||commitIndex<0||observationIndex<=commitIndex||!observation||observation.checkpoint.operationId!==record.operationId||observation.checkpoint.journalId!==control.journalId||observation.checkpoint.sequence!==record.sequence||observation.checkpoint.digest!==frame.digest||JSON.stringify(observation.database)!==JSON.stringify(control.database))throw Error('gateway journal observation mismatch');}
for(const frame of proposals){for(const atom of frame.record.atoms.filter(value=>value.kind==='account')){const generation=(await pool.query('SELECT policy_generation::text FROM budget_accounts WHERE id=$1',[atom.id])).rows[0]?.policy_generation;if(atom.policyGeneration!==generation)throw Error('journal account policy generation mismatch');}}
const attempt=(await pool.query('SELECT state,actual_amount FROM budget_attempts WHERE id=$1',[grant.attemptId])).rows[0];if(attempt.state!=='settled'||canonicalBudgetMoney(String(attempt.actual_amount))!=='0.0098')throw Error('gateway source state mismatch');
const staleRequestHash=hash('request-after-sql-drift'),nextInvocation=captureModelInvocation({type:'step.started',data:{turnId:'turn-2',sequence:0,stepIndex:0}},context.session,'standard');
const staleTicket=await runModelInvocation(nextInvocation,()=>store.prepareIntent({bindingId:binding,requestHash:staleRequestHash,profileHash:profile}));
await pool.query('UPDATE budget_accounts SET endpoint_generation=1 WHERE id=$1',[installation]);
const staleDocument={...document,nonce:hash('nonce-after-sql-drift'),ticket:staleTicket,requestHash:staleRequestHash},staleRaw=gatewayCanonical(staleDocument);
const staleReply=await authority.handle(GATEWAY_ADMIT_PATH,gatewaySignature(key,'request',GATEWAY_ADMIT_PATH,staleRaw),staleRaw);
const staleState=(await pool.query('SELECT state FROM budget_attempts WHERE ticket_hash=$1',[hash(staleTicket)])).rows[0]?.state;
if(staleReply.status===200||staleState!=='prepared'||journal.observeGatewayRecoveryReference({installationAccountId:installation,epoch:'epoch-1',endpointGeneration:'0'})!==undefined)throw Error('SQL-only financial drift did not fail closed');
console.log('gateway journaled; SQL-only drift refused and journal frozen');
}finally{await journal.drainForShutdown();journal.close();}"""
    assert run(gateway, host='gateway-proof-db') == 'gateway journaled; SQL-only drift refused and journal frozen'
    discard_managed_cluster('gateway')
    # Exercise the production closed provisioner against real Keeper custody, real engine
    # PostgreSQL/journal, and the exact digest-pinned native LiteLLM admin API. No provider
    # route is configured or called. The one dropped key response follows an actual write.
    setup_managed_cluster('native', 'native-proof-db', 'native-provision')
    initialize_native_custody()
    start_native_admin()
    native_provision = r"""import{Pool}from'pg';
import{HostFinancialJournal}from'/app/services/keeper/lib/financial-journal.ts';
import{provisionBudgetAccounts}from'/app/services/keeper/lib/budget-account-provisioning.ts';
import{BudgetNativeCustodyStore,NATIVE_CUSTODY_DIRECTORY}from'/app/services/keeper/lib/budget-native-custody.ts';
import{BudgetNativeProvisioner}from'/app/services/keeper/lib/budget-native-provisioning.ts';
import{BudgetNativeCredentialClient}from'/app/services/keeper/lib/budget-native-client.ts';
import{PgGrantStore}from'/app/packages/agent-kit/src/grant-store.ts';
import{definitionSchema,hashOf}from'/app/packages/agent-kit/src/definition.ts';
import{gatewayCanonical,gatewayHash}from'/app/packages/agent-kit/src/gateway-admission-protocol.ts';
import{gatewayMaximumLiability}from'/app/packages/agent-kit/src/gateway-pricing.ts';
import{readFileSync}from'node:fs';
import{createHash}from'node:crypto';
const pool=new Pool({host:'native-proof-db',database:'proof',user:'lares_financial',password:readFileSync('/db-fixture/financial-password','utf8'),max:1,connectionTimeoutMillis:1500});
const owner='native-proof-owner',member='native-proof-member',org='native-proof-org',agent='helper',alias='lares-brain';
const bindingId='c6c32c7a-4a25-4d25-8b0b-79b83a137440',incarnation='f9c463e1-8e7b-4dd9-b9fa-1f6586631cc1',generation='0';
const origin='http://native-admin:4000',endpoint={origin,hash:createHash('sha256').update('native-provision-proof-endpoint').digest('hex')};
const capability={version:1,provider:'openai',model:'synthetic-model',providerBaseUrl:'https://provider.invalid/v1',aliases:['lares-brain','lares-writer','lares-utility','lares-gate'],maxBodyBytes:1048576,maxOutputTokens:1000};
const pricing={version:1,capabilityHash:gatewayHash(gatewayCanonical(capability)),format:'openai',limits:{inputTokens:1000,outputTokens:1000},usdPerMillionTokens:{input:'1',output:'2',cacheRead:'0',cacheWrite:'0'}};
const policy={capability,pricing,maximumLiability:gatewayMaximumLiability(pricing),team:{maxBudget:'100',models:capability.aliases,budgetDuration:'1d'},
  user:{maxBudget:'30',userRole:'internal_user',autoCreateKey:false},membership:{maxBudget:'20',allowedModels:capability.aliases,budgetDuration:'1d',role:'user'},
  key:{maxBudget:'10',models:[alias],budgetDuration:'1d',keyType:'llm_api',blocked:true}};
const definition=definitionSchema.parse({name:agent,model:alias,grants:[]}),duties='',voice='Neutral CI fixture voice.';
const definitionHash=hashOf({definition,dutiesMd:duties,voiceMd:voice});
let journal, custody;
async function main(){
  try{
    await pool.query("INSERT INTO orgs(id,display_name) VALUES($1,'Neutral proof organization')",[org]);
    await pool.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES($1,'Neutral proof owner',$2,'owner','active'),($3,'Neutral proof member',$2,'member','active')",[owner,org,member]);
    await pool.query("INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES($1,'https://identity.example.invalid','subject','tenant')",[member]);
    await pool.query("INSERT INTO org_member_policy(user_id,allowed_capabilities,spend_cap_usd_month) VALUES($1,NULL,20),($2,NULL,20)",[member,owner]);
    await pool.query("INSERT INTO agent_definitions(name,definition,duties,voice,hash,status) VALUES($1,$2::jsonb,$3,$4,$5,'valid')",
      [agent,JSON.stringify(definition),duties,voice,definitionHash]);
    await pool.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,applied_definition,pending) VALUES($1,'127.0.0.2',$1,'owned',$2,$2,'ready',$3::jsonb,false)",
      [agent,incarnation,JSON.stringify(definition)]);
    const grants=new PgGrantStore(pool),adopted=await grants.adoptAgent(owner,{agentName:agent,expectedDefinitionHash:definitionHash},{designatedOwnerMemberId:owner});
    await grants.updateAgentAccess(owner,{agentName:agent,expectedRevision:adopted.accessRevision,
      grants:[{principal:{kind:'organisation',id:org},permission:'use',expiresAt:null}]});
    journal=HostFinancialJournal.openExisting('/proof/native-provision',{requirePrepared:true});
    const accounts=await provisionBudgetAccounts(pool,journal,{installationCap:'100',memberIds:[member]});
    if(accounts.state!=='closed'||accounts.reason!=='unreconciled'||accounts.members!==1||accounts.accountsCreated!==2||accounts.windowsCreated!==2)throw new Error();
    custody=BudgetNativeCustodyStore.openExisting(NATIVE_CUSTODY_DIRECTORY);
    const master=readFileSync('/native-fixture/master','utf8');
    let keyCreateRequests=0,lostResponseObserved=false;
    const actualFetch=globalThis.fetch.bind(globalThis);
    const observeActualFetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
      if(url.origin===origin&&url.pathname==='/key/generate'){
        keyCreateRequests++;
        if(keyCreateRequests!==1)throw new Error();
        const response=await actualFetch(input,init);
        if(response.body){
          const reader=response.body.getReader();let size=0;
          try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
            if(size>65536){await reader.cancel().catch(()=>{});throw new Error();}}}
          finally{reader.releaseLock();}
        }
        lostResponseObserved=true;
        throw new Error('Native response was lost after the actual write');
      }
      return actualFetch(input,init);
    };
    const native=new BudgetNativeCredentialClient(origin,master,observeActualFetch);
    const service=new BudgetNativeProvisioner(pool,journal,custody,native,endpoint,policy);
    const result=await service.provision({bindingId,credentialGeneration:generation,memberId:member,agent,incarnation,purposeAlias:alias});
    if(result.state!=='bound-closed'||result.bindingId!==bindingId||result.credentialGeneration!==generation||keyCreateRequests!==1||!lostResponseObserved)throw new Error();
    const binding=(await pool.query(`SELECT b.state AS binding_state,b.key_fingerprint,i.state AS install_state,i.reason AS install_reason,
      i.selected_endpoint AS install_endpoint,i.recovery_epoch AS install_recovery,m.state AS member_state,m.reason AS member_reason,
      m.selected_endpoint AS member_endpoint,m.recovery_epoch AS member_recovery
      FROM budget_gateway_bindings b JOIN budget_accounts i ON i.id=b.installation_account_id
      JOIN budget_accounts m ON m.id=b.member_account_id WHERE b.id=$1`,[bindingId])).rows;
    if(binding.length!==1||binding[0].binding_state!=='active'||binding[0].install_state!=='closed'||binding[0].install_reason!=='unreconciled'||
      binding[0].install_endpoint!==null||binding[0].install_recovery!==null||binding[0].member_state!=='closed'||binding[0].member_reason!=='unreconciled'||
      binding[0].member_endpoint!==null||binding[0].member_recovery!==null)throw new Error();
    const custodyProof=await custody.withGate(gate=>{
      const op=gate.inventory().operations.find(o=>o.kind==='operation'&&o.bindingId===bindingId&&o.credentialGeneration===generation);
      if(!op)return undefined;
      return {op,key:gate.readKey(op.operationId)};
    });
    if(!custodyProof||custodyProof.op.phase!=='bound-closed'||custodyProof.op.keyCreateAttempt!=='verified'||
      !custodyProof.op.bindingReceipt||custodyProof.op.bindingReceipt.operation!=='provision'||
      custodyProof.op.financialJournalId!==journal.id||custodyProof.op.financialOperationId!==custodyProof.op.bindingReceipt.operationId||
      binding[0].key_fingerprint!==custodyProof.op.keyFingerprint||createHash('sha256').update(custodyProof.key).digest('hex')!==custodyProof.op.keyFingerprint)throw new Error();
    const frames=readFileSync('/proof/native-provision/journal.jsonl','utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
    const receipt=custodyProof.op.bindingReceipt,proposal=frames.find(frame=>frame.record.kind==='proposal'&&frame.record.operationId===receipt.operationId);
    const commit=frames.find(frame=>frame.record.kind==='commit'&&frame.record.operationId===receipt.operationId);
    const checkpoint=(await pool.query('SELECT journal_id,proposal_sequence::text,proposal_digest FROM budget_financial_checkpoints WHERE operation_id=$1',[receipt.operationId])).rows;
    if(!proposal||!commit||proposal.record.sequence!==receipt.proposalSequence||proposal.digest!==receipt.proposalDigest||
      commit.record.proposalDigest!==receipt.proposalDigest||checkpoint.length!==1||checkpoint[0].journal_id!==receipt.journalId||
      checkpoint[0].proposal_sequence!==String(receipt.proposalSequence)||checkpoint[0].proposal_digest!==receipt.proposalDigest)throw new Error();
    const auth=await actualFetch(origin+'/v1/models',{headers:{authorization:'Bearer '+custodyProof.key},redirect:'manual',signal:AbortSignal.timeout(5000)});
    await auth.body?.cancel().catch(()=>{});
    if(auth.status!==401&&auth.status!==403)throw new Error();
    console.log('native-provisioning-proof:complete');
  }catch{
    console.log('native-provisioning-proof:failed');process.exitCode=1;
  }finally{
    try{if(custody)custody.close();}catch{}
    try{if(journal){await journal.drainForShutdown();journal.close();}}catch{}
    await pool.end();
  }
}
void main();"""
    run_native_provisioning(native_provision)
    discard_managed_cluster('native')
    # Actual pool max=1: start check, checkpoint and pre-COMMIT check must use the owner.
    clean = """const j=HostFinancialJournal.openExisting('/proof/restart',{requirePrepared:true});
const db=await pool.connect();try{await verifyFinancialContinuity(j,db);}finally{db.release();}
const writer=new JournalBudgetFinancialWriter(j);
await writer.run('prepare',boundary=>consoleSourceTransaction(pool,async()=>42,boundary));
await j.drainForShutdown();j.close();console.log('clean');"""
    assert run(clean) == 'clean'
    # A new keeper process holds the journal lock for continuity, then publishes its
    # writer lease only after the same running PostgreSQL is verified.
    assert run("const j=HostFinancialJournal.openExistingForStartupVerification('/proof/restart',{requirePrepared:true});const db=await pool.connect();try{await verifyFinancialContinuity(j,db);}finally{db.release();}j.acquireWriterLease();j.close();console.log('resumed');") == 'resumed'
    # Supported restore path freezes while PG stays running; database drop/recreate never
    # clears that custody. Root host/fallback both call this same lock-owning method.
    before = sql('SELECT pg_postmaster_start_time()::text;', 'restoreproof')
    assert run("const j=HostFinancialJournal.openExisting('/proof/restore',{requirePrepared:true});await j.freezeForRestore();j.close();console.log('frozen');", 'restoreproof') == 'frozen'
    sql('DROP DATABASE restoreproof; CREATE DATABASE restoreproof TEMPLATE clusterproof;')
    assert sql('SELECT pg_postmaster_start_time()::text;', 'restoreproof') == before
    assert run("const j=HostFinancialJournal.openExisting('/proof/restore',{requirePrepared:true});const db=await pool.connect();let denied=false;try{await verifyFinancialContinuity(j,db);}catch{denied=true;}finally{db.release();j.close();}if(!denied)throw Error('restore cleared freeze');console.log('closed');", 'restoreproof') == 'closed'
    # Ambiguous observation is permanently frozen even after a fresh matching connection.
    assert run("const j=HostFinancialJournal.openExisting('/proof/unknown',{requirePrepared:true});try{await verifyFinancialContinuity(j,{query:async()=>{throw Error('unobserved');}});}catch{}j.close();console.log('unknown');", 'unknownproof') == 'unknown'
    assert run("const j=HostFinancialJournal.openExisting('/proof/unknown',{requirePrepared:true});const db=await pool.connect();let denied=false;try{await verifyFinancialContinuity(j,db);}catch{denied=true;}finally{db.release();j.close();}if(!denied)throw Error('unknown cleared');console.log('closed');", 'unknownproof') == 'closed'
    # Restart PostgreSQL retaining its data: even the exact same committed checkpoint is
    # insufficient because the full-precision postmaster start changed.
    command('docker', 'restart', name + '-db')
    ready()
    assert run("const path='/proof/restart',records=()=>readFileSync(path+'/journal.jsonl','utf8').trimEnd().split('\\n').map(line=>JSON.parse(line).record),before=records().length,j=HostFinancialJournal.openExistingForStartupVerification(path,{requirePrepared:true}),db=await pool.connect();let denied=false;try{await verifyFinancialContinuity(j,db);}catch{denied=true;}finally{db.release();}let leaseDenied=false;try{j.acquireWriterLease();}catch{leaseDenied=true;}j.close();const tail=records().slice(before);if(!denied||!leaseDenied||tail.at(-1)?.kind!=='freeze'||tail.at(-1)?.reason!=='continuity'||tail.some(r=>r.kind==='writer-open'||r.kind==='writer-close'))throw Error('restart refusal wrote writer lease');console.log('closed');") == 'closed'
    # Fresh cluster under the same hostname/database name also refuses old custody.
    command('docker', 'rm', '--force', name + '-db')
    command('docker', 'run', '-d', '--name', name + '-db', '--network', name,
            '--network-alias', 'proof-db', '-e', 'POSTGRES_USER=proof', '-e',
            'POSTGRES_PASSWORD=disposable-proof-only', '-e', 'POSTGRES_DB=proof',
            'pgvector/pgvector:pg16')
    ready()
    for migration in sorted((repo / 'services/box/sql').glob('[0-9][0-9][0-9]_*.sql')):
        sql(migration.read_text())
    privilege_setup = native_temp / 'prepare-engine-privileges-fresh.mts'
    privilege_setup.write_text("import {readFileSync} from 'node:fs';\nimport {Pool} from 'pg';\nimport {provisionEngineDatabasePrivileges} from '/app/services/box/lib/database-privileges.ts';\n"
        "const pool=new Pool({host:'proof-db',database:'proof',user:'proof',password:'disposable-proof-only',max:1});try{const client=await pool.connect();try{const result=await provisionEngineDatabasePrivileges(client,{expectedDatabase:'proof',passwords:{application:readFileSync('/db-fixture/application-password'),financial:readFileSync('/db-fixture/financial-password')}});if(!['applied','verified'].includes(result.status))throw Error();}finally{client.release();}console.log('engine-privileges-ready');}finally{await pool.end();}\n")
    privilege_result = command('docker','run','--rm','--network',name,'--mount',f'type=bind,src={db_fixture},dst=/db-fixture,readonly',
        '--mount',f'type=bind,src={privilege_setup},dst=/app/services/keeper/prepare-engine-privileges-fresh.mts,readonly',
        '--workdir','/app/services/keeper','--entrypoint',tsx,image,'/app/services/keeper/prepare-engine-privileges-fresh.mts')
    assert privilege_result.stdout.strip() == 'engine-privileges-ready', 'Fresh-cluster engine roles were not prepared'
    sql(f"CREATE ROLE lares_operator LOGIN SUPERUSER PASSWORD '{operator_password}';")
    sql('CREATE DATABASE clusterproof TEMPLATE proof;')
    assert run("const j=HostFinancialJournal.openExisting('/proof/cluster',{requirePrepared:true});const db=await pool.connect();let denied=false;try{await verifyFinancialContinuity(j,db);}catch{denied=true;}finally{db.release();j.close();}if(!denied)throw Error('fresh cluster resumed');console.log('closed');", 'clusterproof') == 'closed'
    print(json.dumps({'preparedWriterCrashPermanentFreeze': True, 'sameRunningPostgresCleanRestart': True, 'ownedPoolOneContinuity': True,
                      'supportedRestoreStaysFrozenWithoutPostgresRestart': True,
                      'unknownObservationPermanent': True, 'retainedDataPostgresRestartFrozen': True,
                      'freshClusterFrozen': True, 'nativeProvisioningBoundClosed': True,
                      'nativeFinancialReceiptVerified': True, 'nativeAccountsRemainClosed': True,
                      'nativeKeyBlockedAuth': True, 'nativeLostReplyReconciledOriginalKey': True}))
finally:
    command('docker', 'rm', '--force', name + '-holder', check=False)
    command('docker', 'rm', '--force', name + '-native-provision', check=False)
    command('docker', 'rm', '--force', name + '-native-custody-init', check=False)
    for container in managed_databases:
        command('docker', 'rm', '--force', container, check=False)
    command('docker', 'rm', '--force', native_admin, check=False)
    if native_custody.exists():
        command('docker', 'run', '--rm', '--network', 'none',
                '--mount', f'type=bind,src={native_custody},dst=/native-custody',
                '--entrypoint', 'chown', image, '-R', f'{os.getuid()}:{os.getgid()}',
                '/native-custody', check=False)
    command('docker', 'rm', '--force', name + '-db', check=False)
    command('docker', 'volume', 'rm', volume, check=False)
    command('docker', 'network', 'rm', name, check=False)
    shutil.rmtree(native_temp, ignore_errors=True)
