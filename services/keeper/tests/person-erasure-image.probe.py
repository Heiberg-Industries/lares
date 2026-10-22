"""Root-only offline person-erasure CLI proof against the final Keeper image; CI only."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile, time, uuid

repo = pathlib.Path(__file__).resolve().parents[3]
root = pathlib.Path(tempfile.mkdtemp(prefix='lares-person-erasure-image-')).resolve()
name = 'lares-person-erasure-' + uuid.uuid4().hex[:10]
network = name
image = sys.argv[1]
password = 'disposable-erasure-image-probe'
tsx = '/app/services/keeper/node_modules/.bin/tsx'

def command(*args, input=None, check=True, timeout=120):
    result = subprocess.run(args, input=input, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            check=check, timeout=timeout)
    return result.stdout.strip()

def sql(database, body):
    return command('docker', 'exec', '-i', name + '-db', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1',
                   '-U', 'proof', '-d', database, input=body)

def root_exists(path):
    return subprocess.run(['sudo','test','-e',str(path)]).returncode == 0

def cli(config, *args, user='0:0', with_custody=True, with_vault=False):
    run = ['docker', 'run', '--rm', '--platform', 'linux/amd64', '--network', network, '--read-only',
           '--user', user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp',
           '--mount', f'type=bind,src={root},dst=/probe,readonly', '--mount',
           f'type=bind,src={root}/secrets,dst=/probe/secrets,readonly', '--mount',
           f'type=bind,src={config},dst=/etc/lares/keeper.json,readonly']
    if with_custody:
        run += ['--mount', f'type=bind,src={root}/erase-state,dst=/var/lib/lares']
    if with_vault:
        run += ['--mount', f'type=bind,src={root}/erase-vault,dst=/vault']
    run += ['--entrypoint', tsx, image, '/app/services/box/bin/erase-person.ts', *args]
    return subprocess.run(run, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)

try:
    root.chmod(0o700)
    (root / 'secrets').mkdir()
    (root / 'secrets/password').write_text(password + '\n')
    command('docker', 'network', 'create', network)
    command('docker', 'run', '-d', '--name', name + '-db', '--network', network, '--network-alias', 'proof-db',
            '-e', 'POSTGRES_USER=proof', '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=proof',
            'pgvector/pgvector:pg16')
    for _ in range(90):
        try:
            command('docker', 'exec', '-e', 'PGPASSWORD=' + password, name + '-db', 'psql', '-h', '127.0.0.1',
                    '-U', 'proof', '-d', 'proof', '-Atc', 'SELECT 1')
            break
        except subprocess.CalledProcessError:
            time.sleep(.5)
    else:
        raise RuntimeError('Disposable PostgreSQL database did not become ready')

    sql('proof', 'CREATE DATABASE eraseproof')
    for migration in sorted((repo / 'services/box/sql').glob('[0-9][0-9][0-9]_*.sql')):
        sql('eraseproof', migration.read_text())
    sql('eraseproof', "INSERT INTO users(id,display_name) VALUES('erase-proof-member','Erase proof')")

    vault = root / 'erase-vault'
    (vault / 'people').mkdir(parents=True)
    note = vault / 'people/member.md'
    note.write_text('---\nowner: erase-proof-member\n---\nA disposable note.\n')
    command('git', '-C', str(vault), 'init', '-q')
    command('git', '-C', str(vault), 'config', 'user.name', 'Fixture Operator')
    command('git', '-C', str(vault), 'config', 'user.email', 'fixture@example.invalid')
    command('git', '-C', str(vault), 'add', '-A')
    command('git', '-C', str(vault), 'commit', '-q', '-m', 'before erase')

    state = root / 'erase-state'
    state.mkdir(mode=0o700)
    config_data = {'mode':'rendered','project':'probe','dir':'/probe','files':['agent.json'],'agentsDir':'/probe',
                   'retiredDir':'/probe/retired','secretsDir':'/probe/secrets','rolesDir':'/probe','templatesDir':'/probe',
                   'backupDir':'/probe','db':{'host':'proof-db','port':5432,'database':'eraseproof','user':'proof',
                   'passwordFile':'/probe/secrets/password'},'budgetFinancial':{'directory':'/var/lib/lares/budget-financial'}}
    config = root / 'erase-config.json'
    config.write_text(json.dumps(config_data))
    invalid = root / 'erase-invalid-db-config.json'
    invalid.write_text(json.dumps({**config_data,'db':{**config_data['db'],'host':'does-not-exist.invalid'}}))
    prepare = root / 'prepare-erase-custody.mts'
    prepare.write_text("import {loadKeeperConfig,keeperPool} from '/app/services/keeper/lib/config.ts';\n"
                       "import {ensureDreamTables} from '/app/services/chief-of-staff/lib/dream/store.ts';\n"
                       "import {prepareFinancialCustody} from '/app/services/keeper/lib/financial-continuity.ts';\n"
                       "const c=loadKeeperConfig();const p=keeperPool(c.db),db=await p.connect();"
                       "try{await ensureDreamTables(db);await prepareFinancialCustody(c.budgetFinancial.directory,db);}"
                       "finally{db.release();await p.end();}\n")

    # CI initializes this disposable tree as root so the real root-only CLI can meet the
    # repository's root-owned 0700/0600 custody checks even with all container capabilities dropped.
    holder = root / 'hold-erase-custody.mts'
    holder.write_text("import {writeFileSync} from 'node:fs';\n"
                      "import {HostFinancialJournal} from '/app/services/keeper/lib/financial-journal.ts';\n"
                      "const j=HostFinancialJournal.openExisting('/var/lib/lares/budget-financial',{requirePrepared:true});"
                      "writeFileSync('/probe/erase-lock-ready','ready');process.on('SIGTERM',()=>{j.close();process.exit(0)});"
                      "setInterval(()=>{},1000);\n")
    command('sudo', 'chown', '-R', '0:0', str(root))
    command('sudo', 'chmod', '0700', str(root), str(state))
    command('sudo', 'chmod', '0600', str(root / 'secrets/password'))
    prep = ['docker','run','--rm','--platform','linux/amd64','--network',network,'--read-only','--user','0:0',
            '--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp','--mount',
            f'type=bind,src={root},dst=/probe,readonly','--mount',
            f'type=bind,src={root}/secrets,dst=/probe/secrets,readonly','--mount',
            f'type=bind,src={config},dst=/etc/lares/keeper.json,readonly','--mount',
            f'type=bind,src={state},dst=/var/lib/lares','--entrypoint',tsx,image,str(prepare)]
    command(*prep[:-1], '/probe/prepare-erase-custody.mts')
    assert sql('eraseproof','SELECT count(*) FROM budget_accounts') == '0', 'Expected a zero-account erasure fixture'

    # The config points at an invalid database so each refusal proves it happened first.
    missing = cli(invalid,'erase-proof-member','--apply',with_custody=False)
    assert missing.returncode and 'Financial journal unavailable' in missing.stdout, missing.stdout
    nonroot = cli(config,'erase-proof-member','--apply',user='10001:10001')
    assert nonroot.returncode and 'requires root on Linux' in nonroot.stdout, nonroot.stdout

    # A second image process holds the real OFD lock. It closes the journal on SIGTERM and
    # reports exit only after the clean close has released custody.
    held = ['docker','run','-d','--name',name+'-lock','--platform','linux/amd64','--network',network,'--read-only',
            '--user','0:0','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp','--mount',
            f'type=bind,src={root},dst=/probe','--mount',f'type=bind,src={root}/secrets,dst=/probe/secrets,readonly',
            '--mount',f'type=bind,src={config},dst=/etc/lares/keeper.json,readonly','--mount',
            f'type=bind,src={state},dst=/var/lib/lares','--entrypoint',tsx,image,str(holder)]
    command(*held[:-1], '/probe/hold-erase-custody.mts')
    for _ in range(100):
        if root_exists(root/'erase-lock-ready'):
            break
        time.sleep(.1)
    assert root_exists(root/'erase-lock-ready'), 'Lock holder did not become ready'
    before_hash = command('sudo','sha256sum',str(note)).split()[0]
    before_head = command('sudo','git','-c',f'safe.directory={vault}','-C',str(vault),'rev-parse','HEAD')
    busy = cli(invalid,'erase-proof-member','--vault','/vault','--apply',with_vault=True)
    assert busy.returncode and 'Financial journal unavailable' in busy.stdout, busy.stdout
    assert command('sudo','sha256sum',str(note)).split()[0] == before_hash, 'Busy-lock refusal changed file bytes'
    assert command('sudo','git','-c',f'safe.directory={vault}','-C',str(vault),'rev-parse','HEAD') == before_head, 'Busy-lock refusal changed Git HEAD'
    command('docker','stop','--time','10',name+'-lock')
    code = command('docker','inspect','--format','{{.State.ExitCode}}',name+'-lock')
    assert code == '0', 'Journal lock holder did not acknowledge a clean close'
    command('docker','rm',name+'-lock')

    result = cli(config,'erase-proof-member','--vault','/vault','--apply',with_vault=True)
    assert result.returncode == 0, result.stdout
    assert not root_exists(note), 'Root CLI did not remove the selected vault note'
    assert sql('eraseproof',"SELECT count(*) FROM users WHERE id='erase-proof-member'") == '0', 'Root CLI did not erase the member'
    assert sql('eraseproof','SELECT count(*) FROM budget_accounts') == '0', 'Zero-account erasure created financial rows'
    print(json.dumps({'rootOnlyCli':True,'missingPreparedCustodyRefused':True,'liveKernelLockRefusedBeforeCheckout':True,
                      'zeroAccountErasure':True},sort_keys=True))
finally:
    command('docker','rm','-f',name+'-lock',check=False)
    command('docker','rm','-f',name+'-db',check=False)
    command('docker','network','rm',network,check=False)
    command('sudo','python3','-c','import shutil,sys;shutil.rmtree(sys.argv[1],ignore_errors=True)',str(root),check=False)
