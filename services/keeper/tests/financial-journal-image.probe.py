"""Actual Linux kernel/file-custody proof in the built keeper image; CI only."""
import json, subprocess, sys, time, uuid

image = sys.argv[1]
name = 'lares-journal-proof-' + uuid.uuid4().hex[:10]
volume = name + '-data'
module = '/app/services/keeper/lib/financial-journal.ts'
native_module = '/app/services/keeper/lib/budget-native-custody.ts'
native_name = name + '-native'
tsx = '/app/services/keeper/node_modules/.bin/tsx'
stage = 'journal-fixture'

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
    stage = 'journal-create'
    command('docker', 'volume', 'create', volume)
    assert run(create) == 'created'
    stage = 'journal-holder-start'
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
    stage = 'journal-lock-contender'
    def contender(path='/proof/journal/writer.lock'):
        return command('docker', 'run', '--rm', '--network', 'none', '--mount',
                       'type=volume,src=' + volume + ',dst=/proof', '--entrypoint', 'flock',
                       image, '--exclusive', '--nonblock', '--conflict-exit-code', '75',
                       path, 'true', check=False).returncode
    # The acquisition child has exited. A truly independent process must still fail.
    assert contender() == 75, 'Inherited open-file-description lock did not survive child exit'
    stage = 'journal-lock-release'
    command('docker', 'rm', '--force', name)
    assert contender() == 0, 'Parent death did not release the kernel lock'
    stage = 'journal-unclean-open'
    refuses = f"import{{HostFinancialJournal}}from'{module}';try{{HostFinancialJournal.openExisting('/proof/journal');process.exit(2)}}catch{{console.log('closed')}}"
    assert run(refuses) == 'closed', 'Unclean writer was silently adopted'
    stage = 'journal-clean-reopen'
    clean = f"import{{HostFinancialJournal}}from'{module}';for(let i=0;i<2;i++){{const j=HostFinancialJournal.openExisting('/proof/clean');await j.operation('admit',async id=>{{j.propose(id,[]);j.committed(id)}});j.close()}}console.log('clean');"
    # tsx -e uses CJS; keep asynchronous fixture execution inside an explicit main.
    clean = clean.replace("for(let i=0;", "async function main(){for(let i=0;").replace("console.log('clean');", "console.log('clean');}void main();")
    assert run(clean) == 'clean'

    # The native custody owner uses the production root UID/GID, filesystem sync and
    # inherited Linux flock implementation. No unit-test seams enter this image proof.
    stage = 'native-holder-start'
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
    stage = 'native-lock-contender'
    assert contender('/proof/native-unclean/writer.lock') == 75, 'Native custody OFD lock did not survive acquisition child exit'
    stage = 'native-lock-release'
    command('docker', 'rm', '--force', native_name)
    assert contender('/proof/native-unclean/writer.lock') == 0, 'Native custody holder death did not release the kernel lock'
    stage = 'native-unclean-open'
    native_refuses = f"import{{BudgetNativeCustodyStore}}from'{native_module}';try{{BudgetNativeCustodyStore.openExisting('/proof/native-unclean');process.exit(2)}}catch{{console.log('native-unclean-refused')}}"
    assert run(native_refuses) == 'native-unclean-refused', 'Unclean native custody was silently adopted'
    stage = 'native-clean-fixture'
    native_clean = f"""import{{BudgetNativeCustodyStore}}from'{native_module}';
import{{gatewayCanonical,gatewayHash}}from'/app/packages/agent-kit/src/gateway-admission-protocol.ts';
import{{randomUUID,randomBytes,createHash}}from'node:crypto';
import{{readdirSync}}from'node:fs';
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
}});await second.drainForShutdown();second.close();
if(readdirSync('/proof/native-clean').some(name=>name==='publication-intent.json'||name.endsWith('.partial')))throw new Error('Clean publication retained intent');
console.log('native-clean-stable');
}}void main().catch(()=>{{process.exitCode=2;}});"""
    stage = 'native-clean-reopen'
    assert run(native_clean) == 'native-clean-stable', 'Clean native custody did not retain exact ownership and key fingerprint'

    # Seed two real native stores. The first makes claimTeamCreate a deterministic
    # snapshot change; the second prepares a user so key creation can be interrupted
    # at its durable sidecar boundary.
    stage = 'native-intent-seed'
    native_intent_seed = f"""import{{BudgetNativeCustodyStore}}from'{native_module}';
import{{gatewayCanonical,gatewayHash}}from'/app/packages/agent-kit/src/gateway-admission-protocol.ts';
const capability={{version:1,provider:'openai',model:'synthetic-model',providerBaseUrl:'https://provider.invalid/v1',aliases:['lares-brain','lares-writer','lares-utility','lares-gate'],maxBodyBytes:1048576,maxOutputTokens:1000}};
const policy={{capability,pricing:{{version:1,capabilityHash:gatewayHash(gatewayCanonical(capability)),format:'openai',limits:{{inputTokens:1000,outputTokens:1000}},usdPerMillionTokens:{{input:'1',output:'2',cacheRead:'0',cacheWrite:'0'}}}},maximumLiability:'0.003',team:{{maxBudget:'100',models:capability.aliases,budgetDuration:'1d'}},user:{{maxBudget:'30',userRole:'internal_user',autoCreateKey:false}},membership:{{maxBudget:'20',allowedModels:capability.aliases,budgetDuration:'1d',role:'user'}},key:{{maxBudget:'10',models:['lares-brain'],budgetDuration:'1d',keyType:'llm_api',blocked:true}}}};
async function seed(directory,withUser){{const store=BudgetNativeCustodyStore.createNew(directory);await store.withGate(async gate=>{{
const team=gate.reserveTeam('22222222-2222-4222-8222-222222222222',{{origin:'http://gateway.invalid:4000',hash:'a'.repeat(64)}},policy);
if(withUser){{gate.claimTeamCreate(team.ownershipId);gate.verifyTeamCreated(team.ownershipId);const user=gate.reserveUser('33333333-3333-4333-8333-333333333333',team.ownershipId,policy);gate.claimUserCreate(user.ownershipId);gate.verifyUserCreated(user.ownershipId);gate.claimMembershipCreate(user.ownershipId);gate.verifyMembershipCreated(user.ownershipId);}}
}});store.close();}}
async function main(){{await seed('/proof/native-intent-snapshot',false);await seed('/proof/native-intent-key',true);await seed('/proof/native-intent-close',true);console.log('native-intent-seeds-ready');}}
void main().catch(()=>{{process.exitCode=2;}});"""
    assert run(native_intent_seed) == 'native-intent-seeds-ready', 'Native publication intent fixtures were not prepared'

    def run_intent_child(directory, mode, expected=86):
        code = f"""import{{BudgetNativeCustodyStore}}from'{native_module}';
import{{fsyncSync,fstatSync,existsSync,readFileSync}}from'node:fs';
import{{gatewayCanonical,gatewayHash}}from'/app/packages/agent-kit/src/gateway-admission-protocol.ts';
const capability={{version:1,provider:'openai',model:'synthetic-model',providerBaseUrl:'https://provider.invalid/v1',aliases:['lares-brain','lares-writer','lares-utility','lares-gate'],maxBodyBytes:1048576,maxOutputTokens:1000}};
const policy={{capability,pricing:{{version:1,capabilityHash:gatewayHash(gatewayCanonical(capability)),format:'openai',limits:{{inputTokens:1000,outputTokens:1000}},usdPerMillionTokens:{{input:'1',output:'2',cacheRead:'0',cacheWrite:'0'}}}},maximumLiability:'0.003',team:{{maxBudget:'100',models:capability.aliases,budgetDuration:'1d'}},user:{{maxBudget:'30',userRole:'internal_user',autoCreateKey:false}},membership:{{maxBudget:'20',allowedModels:capability.aliases,budgetDuration:'1d',role:'user'}},key:{{maxBudget:'10',models:['lares-brain'],budgetDuration:'1d',keyType:'llm_api',blocked:true}}}};
const directory='{directory}',mode='{mode}';
async function main(){{
const sync=fd=>{{fsyncSync(fd);if(!fstatSync(fd).isDirectory())return;const path=directory+'/publication-intent.json';if(!existsSync(path))return;
let intent;try{{intent=JSON.parse(readFileSync(path,'utf8'));}}catch{{return;}}
const targetKind=directory.endsWith('snapshot')?'snapshot':'key-create';if(intent.kind!==targetKind)return;
if(mode==='exit')process.exit(86);throw new Error('durable intent boundary');}};
const store=BudgetNativeCustodyStore.openExisting(directory,{{sync}});
try{{await store.withGate(async gate=>{{
if(directory.endsWith('snapshot')){{const team=gate.inventory().teams[0];gate.claimTeamCreate(team.ownershipId);}}
else{{const user=gate.inventory().users[0],key='sk-'+'x'.repeat(43);gate.prepareOperation({{bindingId:'44444444-4444-4444-8444-444444444444',credentialGeneration:'0',userOwnershipId:user.ownershipId,association:{{agent:'neutral-helper',incarnation:'55555555-5555-4555-8555-555555555555',definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'}},reviewedPolicy:policy}},key);}}
}});}}catch{{}}
if(mode==='close'){{try{{store.close();}}catch{{}}if(!existsSync(directory+'/publication-intent.json'))process.exit(3);console.log('intent-retained-after-close');}}
}}
void main().catch(()=>{{process.exitCode=4;}});"""
        result = command('docker', 'run', '--rm', '--network', 'none', '--mount',
                         'type=volume,src=' + volume + ',dst=/proof', '--entrypoint', tsx,
                         image, '-e', code, check=False)
        if result.returncode != expected:
            raise RuntimeError('Native publication intent child did not stop at its expected boundary')
        return result.stdout.strip()

    stage = 'native-snapshot-intent-boundary'
    run_intent_child('/proof/native-intent-snapshot', 'exit')
    stage = 'native-key-intent-boundary'
    run_intent_child('/proof/native-intent-key', 'exit')
    stage = 'native-close-intent-boundary'
    close_output = run_intent_child('/proof/native-intent-close', 'close', expected=0)
    if close_output != 'intent-retained-after-close':
        raise RuntimeError('Closing after an uncertain publication cleared its intent')

    inspect_intent = f"""import{{BudgetNativeCustodyStore}}from'{native_module}';
import{{readFileSync,readdirSync,existsSync}}from'node:fs';import{{join}}from'node:path';
import{{createHash}}from'node:crypto';import{{gatewayCanonical,gatewayHash}}from'/app/packages/agent-kit/src/gateway-admission-protocol.ts';
const directory='__DIRECTORY__',kind='__KIND__',hash=value=>createHash('sha256').update(value).digest('hex');
const read=name=>readFileSync(join(directory,name)),capture=()=>new Map(readdirSync(directory).sort().map(name=>[name,read(name)]));
const sameFiles=(a,b)=>a.size===b.size&&[...a].every(([name,bytes])=>b.has(name)&&bytes.equals(b.get(name)));
const controlBytes=read('control.json'),snapshotBytes=read('snapshot.json'),control=JSON.parse(controlBytes),snapshot=JSON.parse(snapshotBytes),intent=JSON.parse(read('publication-intent.json'));
if(intent.kind!==kind||intent.storeId!==snapshot.storeId||intent.version!==1)throw Error();
const previous={{controlDigest:hash(controlBytes),controlState:control.state,revision:snapshot.revision,snapshotDigest:hash(snapshotBytes)}};
if(!gatewayCanonical(intent.previous).equals(gatewayCanonical(previous)))throw Error();
const nextSnapshot={{...snapshot,revision:snapshot.revision+1}};
let key=null;
if(kind==='snapshot'){{const team=snapshot.teams[0];if(!team||team.createAttempt!=='not-attempted')throw Error();nextSnapshot.teams=snapshot.teams.map(value=>value.ownershipId===team.ownershipId?{{...value,createAttempt:'attempted'}}:value);}}
else{{
const fingerprint=hash(Buffer.from('sk-'+'x'.repeat(43))),user=snapshot.users.find(value=>value.kind==='user');
if(!user||intent.key?.keyFingerprint!==fingerprint||!intent.key.operationId)throw Error();key={{operationId:intent.key.operationId,keyFingerprint:fingerprint}};
const capability={{version:1,provider:'openai',model:'synthetic-model',providerBaseUrl:'https://provider.invalid/v1',aliases:['lares-brain','lares-writer','lares-utility','lares-gate'],maxBodyBytes:1048576,maxOutputTokens:1000}};
const policy={{capability,pricing:{{version:1,capabilityHash:gatewayHash(gatewayCanonical(capability)),format:'openai',limits:{{inputTokens:1000,outputTokens:1000}},usdPerMillionTokens:{{input:'1',output:'2',cacheRead:'0',cacheWrite:'0'}}}},maximumLiability:'0.003',team:{{maxBudget:'100',models:capability.aliases,budgetDuration:'1d'}},user:{{maxBudget:'30',userRole:'internal_user',autoCreateKey:false}},membership:{{maxBudget:'20',allowedModels:capability.aliases,budgetDuration:'1d',role:'user'}},key:{{maxBudget:'10',models:['lares-brain'],budgetDuration:'1d',keyType:'llm_api',blocked:true}}}};
const association={{agent:'neutral-helper',incarnation:'55555555-5555-4555-8555-555555555555',definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'}};
const operation={{kind:'operation',operationId:intent.key.operationId,bindingId:'44444444-4444-4444-8444-444444444444',credentialGeneration:'0',userOwnershipId:user.ownershipId,association,reviewedPolicy:policy,policyDigest:gatewayHash(gatewayCanonical(policy)),keyFingerprint:fingerprint,phase:'prepared',keyCreateAttempt:'not-attempted',financialOperationId:null,financialJournalId:null,bindingReceipt:null,revocationReceipt:null,activationIntent:null,activationReceipt:null,plaintext:'present',nativeDeletion:'unverified'}};
nextSnapshot.operations=[...snapshot.operations,operation];
if(existsSync(join(directory,intent.key.operationId+'.key')))throw Error();
}}
const nextSnapshotBytes=gatewayCanonical(nextSnapshot),nextControl={{...control,revision:nextSnapshot.revision,snapshotDigest:hash(nextSnapshotBytes)}};
const next={{controlDigest:hash(gatewayCanonical(nextControl)),revision:nextSnapshot.revision,snapshotDigest:hash(nextSnapshotBytes)}};
if(!gatewayCanonical(intent.next).equals(gatewayCanonical(next))||!gatewayCanonical(intent.key).equals(gatewayCanonical(key)))throw Error();
if(intent.kind==='snapshot'&&snapshotBytes.equals(nextSnapshotBytes))throw Error();
const before=capture();let refused=false;try{{const store=BudgetNativeCustodyStore.openExisting(directory);store.close();}}catch{{refused=true;}}
if(!refused||!sameFiles(before,capture()))throw Error();console.log('intent-exact-and-refused');""".replace('__DIRECTORY__','/proof/native-intent-snapshot').replace('__KIND__','snapshot')
    stage = 'native-snapshot-intent-inspection'
    assert run(inspect_intent) == 'intent-exact-and-refused', 'Snapshot intent was not exact or open modified it'
    inspect_key = inspect_intent.replace('/proof/native-intent-snapshot','/proof/native-intent-key').replace("kind='snapshot'","kind='key-create'").replace("if(intent.kind==='snapshot'&&snapshotBytes.equals(nextSnapshotBytes))throw Error();", "if(intent.kind==='key-create'&&snapshotBytes.equals(nextSnapshotBytes))throw Error();")
    stage = 'native-key-intent-inspection'
    assert run(inspect_key) == 'intent-exact-and-refused', 'Key intent was not exact or open modified it'
    stage = 'native-close-intent-inspection'
    inspect_close = inspect_key.replace('/proof/native-intent-key','/proof/native-intent-close')
    assert run(inspect_close) == 'intent-exact-and-refused', 'Close after uncertain publication changed the durable intent'
    print(json.dumps({'linuxInheritedLock': True, 'independentWriterRefused': True,
                      'parentDeathReleasesKernelLock': True, 'uncleanWriterClosed': True,
                      'cleanFsyncLifecycle': True, 'nativeCustodyInheritedLock': True,
                      'nativeCustodyIndependentWriterRefused': True, 'nativeCustodyParentDeathReleasesKernelLock': True,
                      'nativeCustodyUncleanWriterRefused': True, 'nativeCustodyCleanOwnershipAndFingerprintStable': True,
                      'nativeSnapshotIntentCrashExactAndRefused': True, 'nativeKeyIntentCrashExactAndRefused': True,
                      'nativeIntentRetainedAfterClose': True}))
except Exception:
    # Docker/tsx exceptions can include the full evaluated fixture policy in argv.
    # Preserve a fixed failure only; native values and raw errors are not proof output.
    print('probe-stage:' + stage, file=sys.stderr)
    raise RuntimeError('Keeper financial/native custody image proof failed') from None
finally:
    command('docker', 'rm', '--force', name, check=False)
    command('docker', 'rm', '--force', native_name, check=False)
    command('docker', 'volume', 'rm', volume, check=False)
