"""Actual Linux kernel/file-custody proof in the built keeper image; CI only."""
import json, subprocess, sys, time, uuid

image = sys.argv[1]
name = 'lares-journal-proof-' + uuid.uuid4().hex[:10]
volume = name + '-data'
module = '/app/services/keeper/lib/financial-journal.ts'
tsx = '/app/services/keeper/node_modules/.bin/tsx'

def command(*args, check=True):
    return subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          check=check, timeout=45)

def run(code):
    return command('docker', 'run', '--rm', '--network', 'none', '--mount',
                   'type=volume,src=' + volume + ',dst=/proof', '--entrypoint', tsx,
                   image, '-e', code).stdout.strip()

create = f"""import{{financialJournalFrame}}from'{module}';
import{{mkdirSync,writeFileSync,openSync,fsyncSync,closeSync}}from'node:fs';
import{{createHash,randomUUID}}from'node:crypto';
for(const name of ['journal','clean']){{const dir='/proof/'+name;mkdirSync(dir,{{mode:0o700}});
const key=Buffer.alloc(32,13),frame=financialJournalFrame({{version:1,sequence:0,operationId:randomUUID(),previousDigest:'0'.repeat(64),kind:'genesis',journalId:randomUUID(),suppressionKeyFingerprint:createHash('sha256').update(key).digest('hex')}});
for(const [file,bytes]of[['writer.lock',Buffer.alloc(0)],['suppression.key',key],['journal.jsonl',frame.bytes]]){{writeFileSync(dir+'/'+file,bytes,{{flag:'wx',mode:0o600}});const fd=openSync(dir+'/'+file,'r');fsyncSync(fd);closeSync(fd);}}
const fd=openSync(dir,'r');fsyncSync(fd);closeSync(fd);}}
const fd=openSync('/proof','r');fsyncSync(fd);closeSync(fd);console.log('created');"""
try:
    command('docker', 'volume', 'create', volume)
    assert run(create) == 'created'
    holder = f"import{{HostFinancialJournal}}from'{module}';const j=HostFinancialJournal.openExisting('/proof/journal');console.log('locked');setInterval(()=>{{}},1000);"
    command('docker', 'run', '--detach', '--rm', '--name', name, '--network', 'none',
            '--mount', 'type=volume,src=' + volume + ',dst=/proof', '--entrypoint', tsx,
            image, '-e', holder)
    for _ in range(50):
        if 'locked' in command('docker', 'logs', name).stdout:
            break
        time.sleep(.1)
    else:
        raise RuntimeError('Journal holder did not acquire its lock')
    def contender():
        return command('docker', 'run', '--rm', '--network', 'none', '--mount',
                       'type=volume,src=' + volume + ',dst=/proof', '--entrypoint', 'flock',
                       image, '--exclusive', '--nonblock', '--conflict-exit-code', '75',
                       '/proof/journal/writer.lock', 'true', check=False).returncode
    # The acquisition child has exited. A truly independent process must still fail.
    assert contender() == 75, 'Inherited open-file-description lock did not survive child exit'
    command('docker', 'rm', '--force', name)
    assert contender() == 0, 'Parent death did not release the kernel lock'
    refuses = f"import{{HostFinancialJournal}}from'{module}';try{{HostFinancialJournal.openExisting('/proof/journal');process.exit(2)}}catch{{console.log('closed')}}"
    assert run(refuses) == 'closed', 'Unclean writer was silently adopted'
    clean = f"import{{HostFinancialJournal}}from'{module}';for(let i=0;i<2;i++){{const j=HostFinancialJournal.openExisting('/proof/clean');await j.operation('admit',async id=>{{j.propose(id,[]);j.committed(id)}});j.close()}}console.log('clean');"
    # tsx -e uses CJS; keep asynchronous fixture execution inside an explicit main.
    clean = clean.replace("for(let i=0;", "async function main(){for(let i=0;").replace("console.log('clean');", "console.log('clean');}void main();")
    assert run(clean) == 'clean'
    print(json.dumps({'linuxInheritedLock': True, 'independentWriterRefused': True,
                      'parentDeathReleasesKernelLock': True, 'uncleanWriterClosed': True,
                      'cleanFsyncLifecycle': True}))
finally:
    command('docker', 'rm', '--force', name, check=False)
    command('docker', 'volume', 'rm', volume, check=False)
