"""Actual Linux kernel/file-custody proof in the built keeper image; CI only."""
import json, subprocess, sys, time, uuid

image = sys.argv[1]
name = 'lares-journal-proof-' + uuid.uuid4().hex[:10]
volume = name + '-data'
module = '/app/services/keeper/lib/financial-journal.ts'
native_module = '/app/services/keeper/lib/budget-native-custody.ts'
native_name = name + '-native'
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
    def contender(path='/proof/journal/writer.lock'):
        return command('docker', 'run', '--rm', '--network', 'none', '--mount',
                       'type=volume,src=' + volume + ',dst=/proof', '--entrypoint', 'flock',
                       image, '--exclusive', '--nonblock', '--conflict-exit-code', '75',
                       path, 'true', check=False).returncode
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

    # The native custody owner uses the production root UID/GID, filesystem sync and
    # inherited Linux flock implementation. No unit-test seams enter this image proof.
    native_holder = f"import{{BudgetNativeCustodyStore}}from'{native_module}';const s=BudgetNativeCustodyStore.createNew('/proof/native-unclean');console.log('native-locked');setInterval(()=>{{}},1000);"
    command('docker', 'run', '--detach', '--rm', '--name', native_name, '--network', 'none',
            '--mount', 'type=volume,src=' + volume + ',dst=/proof', '--entrypoint', tsx,
            image, '-e', native_holder)
    for _ in range(50):
        if command('docker', 'logs', native_name).stdout.strip() == 'native-locked':
            break
        time.sleep(.1)
    else:
        raise RuntimeError('Native custody holder did not acquire its lock')
    assert contender('/proof/native-unclean/writer.lock') == 75, 'Native custody OFD lock did not survive acquisition child exit'
    command('docker', 'rm', '--force', native_name)
    assert contender('/proof/native-unclean/writer.lock') == 0, 'Native custody holder death did not release the kernel lock'
    native_refuses = f"import{{BudgetNativeCustodyStore}}from'{native_module}';try{{BudgetNativeCustodyStore.openExisting('/proof/native-unclean');process.exit(2)}}catch{{console.log('native-unclean-refused')}}"
    assert run(native_refuses) == 'native-unclean-refused', 'Unclean native custody was silently adopted'
    native_clean = f"""import{{BudgetNativeCustodyStore}}from'{native_module}';
import{{gatewayCanonical,gatewayHash}}from'/app/packages/agent-kit/src/gateway-admission-protocol.ts';
import{{randomUUID,randomBytes,createHash}}from'node:crypto';
async function main(){{
const capability={{version:1,provider:'openai',model:'synthetic-model',providerBaseUrl:'https://provider.invalid/v1',aliases:['lares-brain','lares-writer','lares-utility','lares-gate'],maxBodyBytes:1048576,maxOutputTokens:1000}};
const policy={{capability,pricing:{{version:1,capabilityHash:gatewayHash(gatewayCanonical(capability)),format:'openai',limits:{{inputTokens:1000,outputTokens:1000}},usdPerMillionTokens:{{input:'1',output:'2',cacheRead:'0',cacheWrite:'0'}}}},maximumLiability:'0.003',team:{{maxBudget:'100',models:capability.aliases,budgetDuration:'1d'}},user:{{maxBudget:'30',userRole:'internal_user',autoCreateKey:false}},membership:{{maxBudget:'20',allowedModels:capability.aliases,budgetDuration:'1d',role:'user'}},key:{{maxBudget:'10',models:['lares-brain'],budgetDuration:'1d',keyType:'llm_api',blocked:true}}}};
const installationId=randomUUID(),accountId=randomUUID(),key='sk-'+randomBytes(32).toString('base64url'),expectedFingerprint=createHash('sha256').update(key).digest('hex');
let expectedTeam,expectedUser,expectedOperation;
const first=BudgetNativeCustodyStore.createNew('/proof/native-clean');
await first.withGate(async gate=>{{
expectedTeam=gate.reserveTeam(installationId,{{origin:'http://gateway.invalid:4000',hash:'a'.repeat(64)}},policy);
expectedUser=gate.reserveUser(accountId,expectedTeam.ownershipId,policy);
expectedOperation=gate.prepareOperation({{bindingId:randomUUID(),credentialGeneration:'0',userOwnershipId:expectedUser.ownershipId,association:{{agent:'neutral-helper',incarnation:randomUUID(),definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'}},reviewedPolicy:policy}},key);
if(expectedOperation.keyFingerprint!==expectedFingerprint)throw new Error('Native custody fixture fingerprint mismatch');
}});await first.drainForShutdown();first.close();
const second=BudgetNativeCustodyStore.openExisting('/proof/native-clean');
await second.withGate(async gate=>{{
const team=gate.reserveTeam(installationId,{{origin:'http://gateway.invalid:4000',hash:'a'.repeat(64)}},policy),user=gate.reserveUser(accountId,team.ownershipId,policy),op=gate.readOperation(expectedOperation.operationId);
if(!gatewayCanonical(team).equals(gatewayCanonical(expectedTeam))||!gatewayCanonical(user).equals(gatewayCanonical(expectedUser))||!gatewayCanonical(op).equals(gatewayCanonical(expectedOperation))||createHash('sha256').update(gate.readKey(op.operationId)).digest('hex')!==expectedFingerprint)throw new Error('Native custody fixture identity changed');
}});await second.drainForShutdown();second.close();console.log('native-clean-stable');
}}void main().catch(()=>{{process.exitCode=2;}});"""
    assert run(native_clean) == 'native-clean-stable', 'Clean native custody did not retain exact ownership and key fingerprint'
    print(json.dumps({'linuxInheritedLock': True, 'independentWriterRefused': True,
                      'parentDeathReleasesKernelLock': True, 'uncleanWriterClosed': True,
                      'cleanFsyncLifecycle': True, 'nativeCustodyInheritedLock': True,
                      'nativeCustodyIndependentWriterRefused': True, 'nativeCustodyParentDeathReleasesKernelLock': True,
                      'nativeCustodyUncleanWriterRefused': True, 'nativeCustodyCleanOwnershipAndFingerprintStable': True}))
except Exception:
    # Docker/tsx exceptions can include the full evaluated fixture policy in argv.
    # Preserve a fixed failure only; native values and raw errors are not proof output.
    raise RuntimeError('Keeper financial/native custody image proof failed') from None
finally:
    command('docker', 'rm', '--force', name, check=False)
    command('docker', 'rm', '--force', native_name, check=False)
    command('docker', 'volume', 'rm', volume, check=False)
