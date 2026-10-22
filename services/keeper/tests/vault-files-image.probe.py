"""Disposable CI proof of the real Keeper broker reading a prepared managed Git store."""
import json, pathlib, shutil, subprocess, sys, tempfile, time, uuid

repo = pathlib.Path(__file__).resolve().parents[3]
root = pathlib.Path(tempfile.mkdtemp(prefix='lares-vault-files-image-')).resolve()
name = 'lares-vault-files-' + uuid.uuid4().hex[:10]
network = name
image = sys.argv[1]
tsx = '/app/services/keeper/node_modules/.bin/tsx'
script = '/app/services/keeper/tests/vault-files-image.probe.ts'
password = 'disposable-vault-image-probe'
url = f'postgres://proof:{password}@proof-db:5432/proof'

def command(*args, input=None, check=True, timeout=90):
    result = subprocess.run(args, input=input, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            check=check, timeout=timeout)
    return result.stdout.strip()

def sql(body):
    command('docker', 'exec', '-i', name + '-db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'proof', '-d', 'proof', input=body)

def keeper(mode, timeout=90, managed=False, runtime_user=False):
    args = ['docker', 'run', '--rm', '--network', network, '--mount', f'type=bind,src={root},dst=/proof-root']
    if managed:
        args += ['--mount', f'type=bind,src={root}/srv,dst=/srv', '--mount',
                 f'type=bind,src={root}/var/lib/lares-vault-git,dst=/var/lib/lares-vault-git']
    args += ['--mount', f'type=bind,src={root}/opt/lares,dst=/opt/lares', '--mount',
             f'type=bind,src={root}/etc/systemd/system,dst=/etc/systemd/system']
    args += ['--mount', f'type=bind,src={root}/secrets,dst=/etc/lares/secrets,readonly', '--mount',
             f'type=bind,src={root}/managed-secrets,dst=/srv/lares/secrets,readonly']
    if runtime_user:
        args += ['--user', '10001:10001']
    args += ['-e', 'VAULT_PROBE_DATABASE_URL=' + url, '--entrypoint', tsx, image, script, mode]
    return command(*args, timeout=timeout)

try:
    root.chmod(0o755)
    for relative in ['opt/lares', 'etc/systemd/system', 'secrets', 'managed-secrets']:
        (root / relative).mkdir(parents=True, exist_ok=True)
    command('docker', 'network', 'create', network)
    command('docker', 'run', '-d', '--name', name + '-db', '--network', network, '--network-alias', 'proof-db',
            '-e', 'POSTGRES_USER=proof', '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=proof', 'pgvector/pgvector:pg16')
    for _ in range(90):
        try:
            command('docker', 'exec', '-e', 'PGPASSWORD=' + password, name + '-db', 'psql', '-h', '127.0.0.1', '-U', 'proof', '-d', 'proof', '-Atc', 'SELECT 1')
            break
        except subprocess.CalledProcessError:
            time.sleep(.5)
    else:
        raise RuntimeError('Disposable PostgreSQL database did not become ready')

    applied = []
    for migration in sorted((repo / 'services/box/sql').glob('[0-9][0-9][0-9]_*.sql')):
        sql(migration.read_text())
        applied.append(migration.name)
    on_disk = {p.name for p in (repo / 'services/box/sql').iterdir() if p.name[:3].isdigit() and p.name.endswith('.sql')}
    assert set(applied) == on_disk and '001_baseline.sql' in applied, 'The probe did not apply the full current box schema'

    # Preview runs before the managed roots exist; their presence is a refusal condition.
    plan = json.loads(keeper('setup'))['inventory']
    prepare = 'source "$1"; vault_storage_prepare "$2" "$3"'
    command('sudo', 'bash', '-c', prepare, 'vault-proof', str(repo / 'services/box/ops/vault-storage.sh'), str(root), json.dumps(plan))
    applied_inventory = json.loads(keeper('apply', managed=True, runtime_user=True))
    assert applied_inventory == plan, 'The real storage initializer changed its reviewed plan'
    publish = 'source "$1"; vault_storage_publish "$2" "$3"'
    command('sudo', 'bash', '-c', publish, 'vault-proof', str(repo / 'services/box/ops/vault-storage.sh'), str(root), json.dumps(plan))
    keeper('canary', managed=True, runtime_user=True)
    result = json.loads(keeper('broker', timeout=90, managed=True))
    assert result['status'] == 'PASS' and result['providerCalls'] == 0
    print(json.dumps({'status': 'PASS', 'keeperImage': image, 'schemaMigrations': len(applied), **result}, sort_keys=True))
finally:
    command('docker', 'rm', '-f', name + '-db', check=False)
    command('docker', 'network', 'rm', network, check=False)
    subprocess.run(['sudo', 'python3', '-c', 'import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)', str(root)], check=False)
