"""Actual Linux kernel + PostgreSQL continuity/restore proof; CI only, disposable data."""
import json, pathlib, subprocess, sys, time, uuid

image = sys.argv[1]
repo = pathlib.Path(__file__).resolve().parents[3]
name = 'lares-continuity-proof-' + uuid.uuid4().hex[:10]
volume = name + '-custody'
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

def run(code, database='proof'):
    prefix = f"""import{{Pool}}from'pg';
import{{HostFinancialJournal}}from'{base}financial-journal.ts';
import{{prepareFinancialCustody,verifyFinancialContinuity,observeFinancialDatabase}}from'{base}financial-continuity.ts';
import{{JournalBudgetFinancialWriter}}from'{base}budget-financial-writer.ts';
import{{consoleSourceTransaction}}from'/app/packages/agent-kit/src/console-source-transaction.ts';
import{{readFileSync,writeFileSync}}from'node:fs';
const pool=new Pool({{host:'proof-db',database:{json.dumps(database)},user:'proof',password:'disposable-proof-only',max:1,connectionTimeoutMillis:1500}});
async function main(){{try{{{code}}}finally{{await pool.end();}}}}void main().catch(e=>{{console.error(e);process.exitCode=1;}});"""
    return command('docker', 'run', '--rm', '--network', name, '--mount',
                   'type=volume,src=' + volume + ',dst=/proof', '-w',
                   '/app/services/keeper', '--entrypoint', tsx, image, '-e', prefix).stdout.strip()

try:
    command('docker', 'network', 'create', name)
    command('docker', 'volume', 'create', volume)
    command('docker', 'run', '-d', '--name', name + '-db', '--network', name,
            '--network-alias', 'proof-db', '-e', 'POSTGRES_USER=proof', '-e',
            'POSTGRES_PASSWORD=disposable-proof-only', '-e', 'POSTGRES_DB=proof',
            'pgvector/pgvector:pg16')
    ready()
    for migration in sorted((repo / 'services/box/sql').glob('[0-9][0-9][0-9]_*.sql')):
        sql(migration.read_text())
    # Each scenario uses the real empty migrated schema, not guessed fixture tables.
    sql('CREATE DATABASE restoreproof TEMPLATE proof; CREATE DATABASE clusterproof TEMPLATE proof; CREATE DATABASE unknownproof TEMPLATE proof; CREATE DATABASE crashproof TEMPLATE proof;')
    for database, directory in [('proof', 'restart'), ('restoreproof', 'restore'), ('clusterproof', 'cluster'), ('unknownproof', 'unknown'), ('crashproof', 'crash')]:
        assert run(f"const db=await pool.connect();try{{await prepareFinancialCustody('/proof/{directory}',db);}}finally{{db.release();}}console.log('prepared');", database) == 'prepared'
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
    # Actual pool max=1: start check, checkpoint and pre-COMMIT check must use the owner.
    clean = """const j=HostFinancialJournal.openExisting('/proof/restart',{requirePrepared:true});
const db=await pool.connect();try{await verifyFinancialContinuity(j,db);}finally{db.release();}
const writer=new JournalBudgetFinancialWriter(j);
await writer.run('prepare',boundary=>consoleSourceTransaction(pool,async()=>42,boundary));
await j.drainForShutdown();j.close();console.log('clean');"""
    assert run(clean) == 'clean'
    # A new keeper process with the same actual running PostgreSQL resumes safely.
    assert run("const j=HostFinancialJournal.openExisting('/proof/restart',{requirePrepared:true});const db=await pool.connect();try{await verifyFinancialContinuity(j,db);}finally{db.release();}j.close();console.log('resumed');") == 'resumed'
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
    assert run("const j=HostFinancialJournal.openExisting('/proof/restart',{requirePrepared:true});const db=await pool.connect();let denied=false;try{await verifyFinancialContinuity(j,db);}catch{denied=true;}finally{db.release();j.close();}if(!denied)throw Error('PostgreSQL restart resumed');console.log('closed');") == 'closed'
    # Fresh cluster under the same hostname/database name also refuses old custody.
    command('docker', 'rm', '--force', name + '-db')
    command('docker', 'run', '-d', '--name', name + '-db', '--network', name,
            '--network-alias', 'proof-db', '-e', 'POSTGRES_USER=proof', '-e',
            'POSTGRES_PASSWORD=disposable-proof-only', '-e', 'POSTGRES_DB=proof',
            'pgvector/pgvector:pg16')
    ready()
    for migration in sorted((repo / 'services/box/sql').glob('[0-9][0-9][0-9]_*.sql')):
        sql(migration.read_text())
    sql('CREATE DATABASE clusterproof TEMPLATE proof;')
    assert run("const j=HostFinancialJournal.openExisting('/proof/cluster',{requirePrepared:true});const db=await pool.connect();let denied=false;try{await verifyFinancialContinuity(j,db);}catch{denied=true;}finally{db.release();j.close();}if(!denied)throw Error('fresh cluster resumed');console.log('closed');", 'clusterproof') == 'closed'
    print(json.dumps({'preparedWriterCrashPermanentFreeze': True, 'sameRunningPostgresCleanRestart': True, 'ownedPoolOneContinuity': True,
                      'supportedRestoreStaysFrozenWithoutPostgresRestart': True,
                      'unknownObservationPermanent': True, 'retainedDataPostgresRestartFrozen': True,
                      'freshClusterFrozen': True}))
finally:
    command('docker', 'rm', '--force', name + '-holder', check=False)
    command('docker', 'rm', '--force', name + '-db', check=False)
    command('docker', 'volume', 'rm', volume, check=False)
    command('docker', 'network', 'rm', name, check=False)
