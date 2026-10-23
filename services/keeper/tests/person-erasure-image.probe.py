"""Root-only offline person-erasure CLI proof against the final Keeper image; CI only."""
import hashlib, json, pathlib, secrets, shutil, subprocess, sys, tempfile, time, uuid

repo = pathlib.Path(__file__).resolve().parents[3]
root = pathlib.Path(tempfile.mkdtemp(prefix='lares-person-erasure-image-')).resolve()
name = 'lares-person-erasure-' + uuid.uuid4().hex[:10]
network = name
image = sys.argv[1]
outside_fixture_policy = '{"fixture":"opaque-retention-fixture-not-authoritative","purpose":"discovery","version":1}'
outside_fixture_policy_hash = hashlib.sha256(outside_fixture_policy.encode()).hexdigest()
if outside_fixture_policy_hash != '8ad9a98376b0f385f230841d722ec3e95a3ee64abeecf2d57897bb19626033b0':
    raise RuntimeError('Opaque outside-custody fixture metadata hash changed')
password = 'disposable-erasure-image-probe'
application_password = secrets.token_urlsafe(32)
financial_password = secrets.token_urlsafe(32)
operator_password = secrets.token_urlsafe(32)
operator_source = pathlib.Path(tempfile.mkdtemp(prefix='lares-offline-operator-'))
operator_file = operator_source / 'operator-password'
operator_file.write_text(operator_password)
operator_file.chmod(0o600)
tsx = '/app/services/keeper/node_modules/.bin/tsx'

def command(*args, input=None, check=True, timeout=120):
    result = subprocess.run(args, input=input, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            check=False, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError('Disposable image proof command failed')
    return result.stdout.strip()

def sql(database, body):
    return command('docker', 'exec', '-i', name + '-db', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1',
                   '-U', 'proof', '-d', database, input=body)

def root_exists(path):
    return subprocess.run(['sudo','test','-e',str(path)]).returncode == 0

def cli(config, *args, user='0:0', with_custody=True, with_vault=False, vault_root=None, state_root=None):
    run = ['docker', 'run', '--rm', '--platform', 'linux/amd64', '--network', network, '--read-only',
           '--user', user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp',
           '--mount', f'type=bind,src={root},dst=/probe,readonly', '--mount',
           f'type=bind,src={root}/secrets,dst=/probe/secrets,readonly', '--mount',
           f'type=bind,src={config},dst=/etc/lares/keeper.json,readonly']
    if with_custody:
        run += ['--mount', f'type=bind,src={state_root or root / "erase-state"},dst=/var/lib/lares']
    if with_vault:
        run += ['--mount', f'type=bind,src={vault_root or root / "erase-vault"},dst=/vault']
    run += ['--entrypoint', tsx, image, '/app/services/box/bin/erase-person.ts', *args]
    return subprocess.run(run, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)

try:
    root.chmod(0o700)
    (root / 'secrets').mkdir()
    (root / 'secrets/password').write_text(password + '\n')
    for filename, value in [('app-password', application_password), ('financial-password', financial_password)]:
        path = root / 'secrets' / filename
        path.write_text(value)
        path.chmod(0o600)
    command('docker', 'network', 'create', network)
    command('docker', 'run', '-d', '--name', name + '-db', '--network', network, '--network-alias', 'proof-db',
            '-e', 'POSTGRES_USER=proof', '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=proof',
            'pgvector/pgvector:pg16')
    for _ in range(90):
        try:
            command('docker', 'exec', '-e', 'PGPASSWORD=' + password, name + '-db', 'psql', '-h', '127.0.0.1',
                    '-U', 'proof', '-d', 'proof', '-Atc', 'SELECT 1')
            break
        except RuntimeError:
            time.sleep(.5)
    else:
        raise RuntimeError('Disposable PostgreSQL database did not become ready')

    sql('proof', 'CREATE DATABASE eraseproof')
    for migration in sorted((repo / 'services/box/sql').glob('[0-9][0-9][0-9]_*.sql')):
        sql('eraseproof', migration.read_text())
    privilege_setup = root / 'prepare-engine-privileges.mts'
    privilege_setup.write_text("import {readFileSync} from 'node:fs';\nimport {Pool} from 'pg';\nimport {provisionEngineDatabasePrivileges} from '/app/services/box/lib/database-privileges.ts';\n"
        "const pool=new Pool({host:'proof-db',database:'eraseproof',user:'proof',password:'" + password + "',max:1});try{const client=await pool.connect();try{const result=await provisionEngineDatabasePrivileges(client,{expectedDatabase:'eraseproof',passwords:{application:readFileSync('/probe/secrets/app-password'),financial:readFileSync('/probe/secrets/financial-password'),outsideCustody:Buffer.from('outside-custody-proof-password-123456')}});if(!['applied','verified'].includes(result.status))throw Error();}finally{client.release();}console.log('engine-privileges-ready');}finally{await pool.end();}\n")
    privilege_run = ['docker','run','--rm','--platform','linux/amd64','--network',network,'--read-only','--user','0:0',
                     '--tmpfs','/tmp','--mount',f'type=bind,src={root},dst=/probe,readonly','--mount',
                     f'type=bind,src={root}/secrets,dst=/probe/secrets,readonly','--mount',
                     f'type=bind,src={privilege_setup},dst=/app/services/keeper/prepare-engine-privileges.mts,readonly',
                     '--workdir','/app/services/keeper','--entrypoint',tsx,image,'/app/services/keeper/prepare-engine-privileges.mts']
    assert command(*privilege_run) == 'engine-privileges-ready', 'Production engine database privileges were not prepared'
    sql('eraseproof', f"CREATE ROLE lares_operator LOGIN SUPERUSER PASSWORD '{operator_password}';")
    sql('eraseproof', "INSERT INTO orgs(id,display_name) VALUES('erase-proof-org','Erase proof'),('erase-proof-other-org','Erase proof other'); INSERT INTO users(id,display_name) VALUES('legacy-proof-member','Legacy proof'); INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('erase-proof-owner','Owner','erase-proof-org','owner','active'),('erase-proof-member','Member','erase-proof-org','owner','active'),('erase-proof-other','Other','erase-proof-other-org','owner','active'); INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES('erase-proof-owner','https://identity.example.invalid','owner-subject','tenant'),('erase-proof-member','https://identity.example.invalid','member-subject','tenant'); INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES('erase-proof-owner',40),('erase-proof-member',30); INSERT INTO agent_definitions(name,definition,hash) VALUES('erase-proof-member-agent','{\"grants\":[]}'::jsonb,repeat('a',64)),('erase-proof-owner-agent','{\"grants\":[]}'::jsonb,repeat('b',64)); INSERT INTO agent_access(agent_name,owner_member_id,organisation_id) VALUES('erase-proof-member-agent','erase-proof-member','erase-proof-org'),('erase-proof-owner-agent','erase-proof-owner','erase-proof-org'); INSERT INTO outside_custody_accounts(account_id,owner_member_id,resource_id,connection_name,generation,active_revision,candidate_revision,consent_generation,state) VALUES('40000000-0000-4000-8000-000000000001','erase-proof-member','erase-proof-member-agent','erase-member-agent',1,1,NULL,1,'active'),('40000000-0000-4000-8000-000000000002','erase-proof-member','erase-proof-owner-agent','erase-member-owner-agent',1,1,NULL,1,'active'),('40000000-0000-4000-8000-000000000003','erase-proof-other','erase-proof-member-agent','erase-foreign-agent',1,NULL,NULL,1,'revoked'),('40000000-0000-4000-8000-000000000004','erase-proof-owner','erase-proof-owner-agent','erase-owner-agent',1,1,NULL,1,'active'); INSERT INTO outside_custody_revisions(account_id,owner_member_id,credential_revision,generation,consent_generation,revision_purpose,policy_json,policy_hash,operation_id,nonce,ciphertext) VALUES('40000000-0000-4000-8000-000000000001','erase-proof-member',1,1,1,'discovery','{\"fixture\":\"opaque-retention-fixture-not-authoritative\",\"purpose\":\"discovery\",\"version\":1}'::jsonb,decode('8ad9a98376b0f385f230841d722ec3e95a3ee64abeecf2d57897bb19626033b0','hex'),'40000000-1111-4111-8111-000000000001',decode(repeat('07',12),'hex'),decode(repeat('09',24),'hex')),('40000000-0000-4000-8000-000000000002','erase-proof-member',1,1,1,'discovery','{\"fixture\":\"opaque-retention-fixture-not-authoritative\",\"purpose\":\"discovery\",\"version\":1}'::jsonb,decode('8ad9a98376b0f385f230841d722ec3e95a3ee64abeecf2d57897bb19626033b0','hex'),'40000000-1111-4111-8111-000000000002',decode(repeat('08',12),'hex'),decode(repeat('0a',24),'hex')),('40000000-0000-4000-8000-000000000004','erase-proof-owner',1,1,1,'discovery','{\"fixture\":\"opaque-retention-fixture-not-authoritative\",\"purpose\":\"discovery\",\"version\":1}'::jsonb,decode('8ad9a98376b0f385f230841d722ec3e95a3ee64abeecf2d57897bb19626033b0','hex'),'40000000-1111-4111-8111-000000000004',decode(repeat('0b',12),'hex'),decode(repeat('0c',24),'hex')); INSERT INTO outside_custody_operations(operation_id,account_id,owner_member_id,operation_kind,request_hash,expected_generation,result_generation,credential_revision,outcome) VALUES('40000000-1111-4111-8111-000000000001','40000000-0000-4000-8000-000000000001','erase-proof-member','stage',decode(repeat('01',32),'hex'),0,1,1,'staged'),('40000000-1111-4111-8111-000000000002','40000000-0000-4000-8000-000000000002','erase-proof-member','stage',decode(repeat('02',32),'hex'),0,1,1,'staged'),('40000000-1111-4111-8111-000000000004','40000000-0000-4000-8000-000000000004','erase-proof-owner','stage',decode(repeat('04',32),'hex'),0,1,1,'staged')")

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
    command('sudo', 'chown', '0:0', str(state))
    command('sudo', 'chmod', '0700', str(state))
    config_data = {'mode':'rendered','project':'probe','dir':'/probe','files':['agent.json'],'agentsDir':'/probe',
                   'retiredDir':'/probe/retired','secretsDir':'/probe/secrets','rolesDir':'/probe','templatesDir':'/probe',
                   'backupDir':'/probe','db':{'host':'proof-db','port':5432,'database':'eraseproof','user':'lares_app',
                   'passwordFile':'/probe/secrets/app-password'},'budgetFinancial':{'directory':'/var/lib/lares/budget-financial',
                   'db':{'host':'proof-db','port':5432,'database':'eraseproof','user':'lares_financial',
                   'passwordFile':'/probe/secrets/financial-password'}},
                   'budgetNative':{'directory':'/var/lib/lares/budget-native'}}
    config = root / 'erase-config.json'
    config.write_text(json.dumps(config_data))
    setup_config_data = {**config_data}
    setup_config_data.pop('budgetFinancial')
    setup_config_data.pop('budgetNative')
    setup_config = root / 'erase-financial-setup-config.json'
    setup_config.write_text(json.dumps(setup_config_data))
    setup_command = ['docker','run','--rm','--platform','linux/amd64','--network',network,'--read-only',
        '--user','0:0','--security-opt','no-new-privileges:true','--tmpfs','/tmp',
        '--tmpfs','/operator-secrets:rw,noexec,nosuid,nodev,mode=0700','--mount',
        f'type=bind,src={root},dst=/probe,readonly','--mount',
        f'type=bind,src={root}/secrets,dst=/probe/secrets,readonly','--mount',
        f'type=bind,src={operator_source},dst=/operator-source,readonly','--mount',
        f'type=bind,src={state},dst=/var/lib/lares','--entrypoint','sh',image,'-c',
        'set -eu; cp /operator-source/operator-password /operator-secrets/operator-password; chmod 600 /operator-secrets/operator-password; '
        f'exec {tsx} /app/services/keeper/bin/budget-financial.ts prepare-fresh --confirm-fresh-installation '
        '--operator-password-file /operator-secrets/operator-password /probe/erase-financial-setup-config.json']
    setup_output = command(*setup_command)
    setup_lines = setup_output.splitlines()
    if len(setup_lines) != 2 or not setup_lines[0].startswith('Fresh financial custody prepared.'):
        raise RuntimeError('Production fresh-custody command did not complete the offline ceremony')
    if json.loads(setup_lines[1])['budgetFinancial']['directory'] != '/var/lib/lares/budget-financial':
        raise RuntimeError('Production fresh-custody command returned an unexpected binding')
    legacy_config_data = {**config_data}
    legacy_config_data.pop('budgetNative')
    legacy_state = state
    unclean_state = root / 'unclean-state'
    unclean_state.mkdir(mode=0o700)
    legacy_config = root / 'legacy-erase-config.json'
    legacy_config.write_text(json.dumps(legacy_config_data))
    legacy_invalid = root / 'legacy-erase-invalid-db-config.json'
    legacy_invalid.write_text(json.dumps({**legacy_config_data,'db':{**legacy_config_data['db'],'host':'does-not-exist.invalid'},'budgetFinancial':{**legacy_config_data['budgetFinancial'],'db':{**legacy_config_data['budgetFinancial']['db'],'host':'does-not-exist.invalid'}}}))
    invalid = root / 'erase-invalid-db-config.json'
    invalid.write_text(json.dumps({**config_data,'db':{**config_data['db'],'host':'does-not-exist.invalid'},'budgetFinancial':{**config_data['budgetFinancial'],'db':{**config_data['budgetFinancial']['db'],'host':'does-not-exist.invalid'}}}))
    prepare = root / 'prepare-erase-custody.mts'
    prepare.write_text("import {loadKeeperConfig,keeperFinancialPool,keeperPool} from '/app/services/keeper/lib/config.ts';\n"
                       "import {ensureDreamTables} from '/app/services/chief-of-staff/lib/dream/store.ts';\n"
                       "import {HostFinancialJournal} from '/app/services/keeper/lib/financial-journal.ts';\n"
                       "import {verifyFinancialContinuity} from '/app/services/keeper/lib/financial-continuity.ts';\n"
                       "const c=loadKeeperConfig(),p=keeperPool(c.db),fp=keeperFinancialPool(c),j=HostFinancialJournal.openExisting(c.budgetFinancial.directory,{requirePrepared:true}),db=await p.connect(),fdb=await fp.connect();"
                       "try{await ensureDreamTables(db);await verifyFinancialContinuity(j,fdb);}"
                       "finally{db.release();fdb.release();j.close();await Promise.all([p.end(),fp.end()]);}\n")
    provision = root / 'provision-erase-accounts.mts'
    provision.write_text("import {loadKeeperConfig,keeperFinancialPool} from '/app/services/keeper/lib/config.ts';\n"
                         "import {HostFinancialJournal} from '/app/services/keeper/lib/financial-journal.ts';\n"
                         "import {provisionBudgetAccounts} from '/app/services/keeper/lib/budget-account-provisioning.ts';\n"
                         "const c=loadKeeperConfig(),p=keeperFinancialPool(c),j=HostFinancialJournal.openExisting(c.budgetFinancial.directory,{requirePrepared:true});"
                         "try{const r=await provisionBudgetAccounts(p,j,{installationCap:'100',memberIds:['erase-proof-owner','erase-proof-member']});"
                         "if(r.state!=='closed'||r.members!==2||r.accountsCreated!==3||r.windowsCreated!==3)throw Error('proof provisioning mismatch');}"
                         "finally{j.close();await p.end();}\n")
    prepare_native = root / 'prepare-erase-native.mts'
    prepare_native.write_text("import {createHash,randomBytes} from 'node:crypto';\n"
                              "import {writeFileSync} from 'node:fs';\n"
                              "import {loadKeeperConfig,keeperFinancialPool} from '/app/services/keeper/lib/config.ts';\n"
                              "import {BudgetNativeCustodyStore} from '/app/services/keeper/lib/budget-native-custody.ts';\n"
                              "import {gatewayCanonical,gatewayHash} from '/app/packages/agent-kit/src/gateway-admission-protocol.ts';\n"
                              "const c=loadKeeperConfig(),p=keeperFinancialPool(c),store=BudgetNativeCustodyStore.openExisting(c.budgetNative.directory);"
                              "const policy=(()=>{const capability={version:1,provider:'openai',model:'synthetic-model',providerBaseUrl:'https://provider.invalid/v1',aliases:['lares-brain','lares-writer','lares-utility','lares-gate'],maxBodyBytes:1048576,maxOutputTokens:1000};"
                              "return {capability,pricing:{version:1,capabilityHash:gatewayHash(gatewayCanonical(capability)),format:'openai',limits:{inputTokens:1000,outputTokens:1000},usdPerMillionTokens:{input:'1',output:'2',cacheRead:'0',cacheWrite:'0'}},maximumLiability:'0.003',team:{maxBudget:'100',models:capability.aliases,budgetDuration:'1d'},user:{maxBudget:'30',userRole:'internal_user',autoCreateKey:false},membership:{maxBudget:'20',allowedModels:capability.aliases,budgetDuration:'1d',role:'user'},key:{maxBudget:'10',models:['lares-brain'],budgetDuration:'1d',keyType:'llm_api',blocked:true}}})();"
                              "try{const installation=(await p.query(\"SELECT id FROM budget_accounts WHERE kind='installation'\")).rows[0]?.id;"
                              "const account=(await p.query(\"SELECT id FROM budget_accounts WHERE live_member_id='erase-proof-member'\")).rows[0]?.id;"
                              "if(!installation||!account)throw Error('proof accounts missing');"
                              "await store.withGate(async gate=>{const target={origin:'https://gateway.invalid',hash:'a'.repeat(64)};"
                              "const team=gate.reserveTeam(installation,target,policy),user=gate.reserveUser(account,team.ownershipId,policy);"
                              "const key='sk-'+randomBytes(32).toString('base64url');gate.prepareOperation({bindingId:'d632f974-3690-456b-8b86-7ee77f6de216',credentialGeneration:'0',userOwnershipId:user.ownershipId,association:{agent:'neutral-helper',incarnation:'4d32b13a-21d7-4c14-a26c-65c64b726c58',definitionHash:'c'.repeat(64),purposeAlias:'lares-brain'},reviewedPolicy:policy},key);writeFileSync('/probe/expected-native-fingerprint',createHash('sha256').update(key).digest('hex')+'\\n',{mode:0o600});console.log('prepared');});}"
                              "finally{store.close();await p.end();}\n")
    native_holder = root / 'hold-erase-native.mts'
    native_holder.write_text("import {writeFileSync} from 'node:fs';\n"
                             "import {BudgetNativeCustodyStore} from '/app/services/keeper/lib/budget-native-custody.ts';\n"
                              "const store=BudgetNativeCustodyStore.openExisting('/var/lib/lares/budget-native');"
                             "writeFileSync('/probe/native-lock-ready','ready');process.on('SIGTERM',async()=>{await store.drainForShutdown();store.close();process.exit(0)});"
                             "setInterval(()=>{},1000);\n")
    verify_native = root / 'verify-erase-native.mts'
    verify_native.write_text("import {readFileSync} from 'node:fs';\n"
                             "import {BudgetNativeCustodyStore} from '/app/services/keeper/lib/budget-native-custody.ts';\n"
                             "const store=BudgetNativeCustodyStore.openExisting('/var/lib/lares/budget-native');"
                             "try{const snapshot=await store.withGate(async gate=>gate.inventory()),rows=snapshot.operations;"
                             "const cleanup=rows.length===1&&rows[0].kind==='cleanup'?rows[0]:undefined,raw=JSON.stringify(snapshot);"
                             "const result={singleErasedUser:snapshot.users.length===1&&snapshot.users[0]?.kind==='erased-user',"
                             "singleCleanupRecord:!!cleanup&&cleanup.phase==='revoke-pending'&&cleanup.plaintext==='removed'&&cleanup.nativeDeletion==='unverified',"
                             "exactFingerprintRetained:!!cleanup&&cleanup.keyFingerprint===readFileSync('/probe/expected-native-fingerprint','utf8').trim(),"
                             "originAndHashesRetained:!!cleanup&&cleanup.endpoint.origin==='https://gateway.invalid'&&/^[a-f0-9]{64}$/.test(cleanup.endpoint.hash)&&/^[a-f0-9]{64}$/.test(cleanup.policyDigest)&&/^[a-f0-9]{64}$/.test(cleanup.revocationReceiptHash)&&/^[a-f0-9]{64}$/.test(cleanup.erasureReceiptHash)&&/^[a-f0-9]{64}$/.test(cleanup.accountCommitment)&&/^[a-f0-9]{64}$/.test(cleanup.coordinateCommitment)&&/^[a-f0-9]{64}$/.test(cleanup.operationCommitment),"
                             "privateAssociationsRemoved:!!cleanup&&!('bindingId'in cleanup)&&!('userOwnershipId'in cleanup)&&!raw.includes('d632f974-3690-456b-8b86-7ee77f6de216')&&!raw.includes('neutral-helper')&&!raw.includes('4d32b13a-21d7-4c14-a26c-65c64b726c58'),"
                             "plaintextRemoved:!!cleanup&&cleanup.plaintext==='removed'};"
                             "if(Object.values(result).some(value=>value!==true))throw Error('native custody cleanup proof mismatch');console.log(JSON.stringify(result));}"
                             "finally{store.close();}\n")

    # CI initializes this disposable tree as root so the real root-only CLI can meet the
    # repository's root-owned 0700/0600 custody checks even with all container capabilities dropped.
    holder = root / 'hold-erase-custody.mts'
    holder.write_text("import {writeFileSync} from 'node:fs';\n"
                      "import {HostFinancialJournal} from '/app/services/keeper/lib/financial-journal.ts';\n"
                      "const j=HostFinancialJournal.openExisting('/var/lib/lares/budget-financial',{requirePrepared:true});"
                      "writeFileSync('/probe/erase-lock-ready','ready');process.on('SIGTERM',()=>{j.close();process.exit(0)});"
                      "setInterval(()=>{},1000);\n")
    legacy_vault = root / 'legacy-vault'
    (legacy_vault / 'people').mkdir(parents=True)
    legacy_note = legacy_vault / 'people/member.md'
    legacy_note.write_text('---\nowner: legacy-proof-member\n---\nA disposable legacy note.\n')
    command('git','-C',str(legacy_vault),'init','-q')
    command('git','-C',str(legacy_vault),'config','user.name','Fixture Operator')
    command('git','-C',str(legacy_vault),'config','user.email','fixture@example.invalid')
    command('git','-C',str(legacy_vault),'add','-A')
    command('git','-C',str(legacy_vault),'commit','-q','-m','before legacy erase')
    native_setup_config_data = {**config_data}
    native_setup_config_data.pop('budgetNative')
    native_setup_config = root / 'erase-native-setup-config.json'
    native_setup_config.write_text(json.dumps(native_setup_config_data))
    command('sudo', 'chown', '-R', '0:0', str(root))
    command('sudo', 'chmod', '0700', str(root), str(state), str(legacy_state), str(unclean_state))
    command('sudo', 'chmod', '0600', str(root / 'secrets/password'))
    prep = ['docker','run','--rm','--platform','linux/amd64','--network',network,'--read-only','--user','0:0',
            '--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp','--mount',
            f'type=bind,src={root},dst=/probe,readonly','--mount',
            f'type=bind,src={root}/secrets,dst=/probe/secrets,readonly','--mount',
            f'type=bind,src={config},dst=/etc/lares/keeper.json,readonly','--mount',
            f'type=bind,src={state},dst=/var/lib/lares','--entrypoint',tsx,image,str(prepare)]
    command(*prep[:-1], '/probe/prepare-erase-custody.mts')
    provision_run = ['docker','run','--rm','--platform','linux/amd64','--network',network,'--read-only','--user','0:0',
                     '--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp','--mount',
                     f'type=bind,src={root},dst=/probe,readonly','--mount',
                     f'type=bind,src={root}/secrets,dst=/probe/secrets,readonly','--mount',
                     f'type=bind,src={config},dst=/etc/lares/keeper.json,readonly','--mount',
                     f'type=bind,src={state},dst=/var/lib/lares','--entrypoint',tsx,image,'/probe/provision-erase-accounts.mts']
    command(*provision_run)
    command('sudo','cp','-a',str(state / 'budget-financial'),str(unclean_state / 'budget-financial'))
    command('sudo','chmod','0700',str(unclean_state / 'budget-financial'))
    native_setup = ['docker','run','--rm','--platform','linux/amd64','--network',network,'--read-only',
        '--user','0:0','--security-opt','no-new-privileges:true','--tmpfs','/tmp',
        '--tmpfs','/operator-secrets:rw,noexec,nosuid,nodev,mode=0700','--mount',
        f'type=bind,src={root},dst=/probe,readonly','--mount',
        f'type=bind,src={root}/secrets,dst=/probe/secrets,readonly','--mount',
        f'type=bind,src={operator_source},dst=/operator-source,readonly','--mount',
        f'type=bind,src={state},dst=/var/lib/lares','--entrypoint','sh',image,'-c',
        'set -eu; cp /operator-source/operator-password /operator-secrets/operator-password; chmod 600 /operator-secrets/operator-password; '
        f'exec {tsx} /app/services/keeper/bin/budget-financial.ts prepare-native --confirm-fresh-native-custody '
        '--operator-password-file /operator-secrets/operator-password /probe/erase-native-setup-config.json']
    native_run = ['docker','run','--rm','--platform','linux/amd64','--network',network,'--read-only','--user','0:0',
                  '--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp','--mount',
                  f'type=bind,src={root},dst=/probe','--mount',
                  f'type=bind,src={root}/secrets,dst=/probe/secrets,readonly','--mount',
                  f'type=bind,src={config},dst=/etc/lares/keeper.json,readonly','--mount',
                  f'type=bind,src={state},dst=/var/lib/lares','--entrypoint',tsx,image,'/probe/prepare-erase-native.mts']
    assert sql('eraseproof','SELECT count(*) FROM budget_gateway_bindings') == '0', 'Native pending fixture unexpectedly has a SQL binding'

    # The config points at an invalid database so each refusal proves it happened first.
    missing = cli(legacy_invalid,'legacy-proof-member','--apply',with_custody=False)
    assert missing.returncode and 'Financial journal unavailable' in missing.stdout, 'Missing financial custody did not refuse'
    before_hash = command('sudo','sha256sum',str(note)).split()[0]
    before_head = command('sudo','git','-c',f'safe.directory={vault}','-C',str(vault),'rev-parse','HEAD')
    missing_native_result = cli(invalid,'erase-proof-member','--vault','/vault','--apply',with_vault=True)
    assert missing_native_result.returncode != 0 and 'Native custody unavailable' in missing_native_result.stdout, 'Missing configured native custody did not refuse before database access'
    native_directory = unclean_state / 'budget-native'
    command('sudo','mkdir','-m','0700',str(native_directory))
    unclean_native_result = cli(invalid,'erase-proof-member','--vault','/vault','--apply',with_vault=True,state_root=unclean_state)
    assert unclean_native_result.returncode != 0 and 'Native custody unavailable' in unclean_native_result.stdout, 'Unclean configured native custody did not refuse before database access'
    command('sudo','rmdir',str(native_directory))
    assert command('sudo','sha256sum',str(note)).split()[0] == before_hash, 'Native custody refusal changed file bytes'
    assert command('sudo','git','-c',f'safe.directory={vault}','-C',str(vault),'rev-parse','HEAD') == before_head, 'Native custody refusal changed Git HEAD'
    legacy_result = cli(legacy_config,'legacy-proof-member','--vault','/vault','--apply',with_vault=True,vault_root=legacy_vault,state_root=legacy_state)
    assert legacy_result.returncode == 0, 'Zero-account legacy erase failed'
    assert not root_exists(legacy_note), 'Legacy root CLI did not remove the selected vault note'
    assert sql('eraseproof',"SELECT count(*) FROM users WHERE id='legacy-proof-member'") == '0', 'Zero-account legacy apply did not erase the member'
    assert sql('eraseproof',"SELECT count(*) FROM budget_accounts WHERE live_member_id='legacy-proof-member'") == '0', 'Zero-account legacy apply created financial rows'
    native_setup_output = command(*native_setup)
    if native_setup_output != 'Fresh native custody prepared. Set budgetNative.directory to /var/lib/lares/budget-native in root-owned keeper.json, then restart keeper.':
        raise RuntimeError('Production native-custody command did not complete the offline ceremony')
    if command(*native_run) != 'prepared':
        raise RuntimeError('Native image fixture did not prepare custody')
    nonroot = cli(config,'erase-proof-member','--apply',user='10001:10001')
    assert nonroot.returncode and 'requires root on Linux' in nonroot.stdout, 'Non-root image CLI did not refuse'

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
    busy = cli(invalid,'erase-proof-member','--vault','/vault','--apply',with_vault=True)
    assert busy.returncode and 'Financial journal unavailable' in busy.stdout, 'Held financial custody did not refuse'
    assert command('sudo','sha256sum',str(note)).split()[0] == before_hash, 'Busy-lock refusal changed file bytes'
    assert command('sudo','git','-c',f'safe.directory={vault}','-C',str(vault),'rev-parse','HEAD') == before_head, 'Busy-lock refusal changed Git HEAD'
    command('docker','stop','--time','10',name+'-lock')
    code = command('docker','inspect','--format','{{.State.ExitCode}}',name+'-lock')
    assert code == '0', 'Journal lock holder did not acknowledge a clean close'
    command('docker','rm',name+'-lock')

    native_held = ['docker','run','-d','--name',name+'-native-lock','--platform','linux/amd64','--network',network,'--read-only',
                   '--user','0:0','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp','--mount',
                   f'type=bind,src={root},dst=/probe','--mount',f'type=bind,src={root}/secrets,dst=/probe/secrets,readonly',
                   '--mount',f'type=bind,src={config},dst=/etc/lares/keeper.json,readonly','--mount',
                   f'type=bind,src={state},dst=/var/lib/lares','--entrypoint',tsx,image,str(native_holder)]
    command(*native_held[:-1], '/probe/hold-erase-native.mts')
    for _ in range(100):
        if root_exists(root/'native-lock-ready'):
            break
        time.sleep(.1)
    assert root_exists(root/'native-lock-ready'), 'Native lock holder did not become ready'
    before_hash = command('sudo','sha256sum',str(note)).split()[0]
    before_head = command('sudo','git','-c',f'safe.directory={vault}','-C',str(vault),'rev-parse','HEAD')
    native_busy = cli(invalid,'erase-proof-member','--vault','/vault','--apply',with_vault=True)
    assert native_busy.returncode != 0 and 'Native custody unavailable' in native_busy.stdout, 'Held native custody did not refuse before database access'
    assert command('sudo','sha256sum',str(note)).split()[0] == before_hash, 'Held native refusal changed file bytes'
    assert command('sudo','git','-c',f'safe.directory={vault}','-C',str(vault),'rev-parse','HEAD') == before_head, 'Held native refusal changed Git HEAD'
    command('docker','stop','--time','10',name+'-native-lock')
    code = command('docker','inspect','--format','{{.State.ExitCode}}',name+'-native-lock')
    assert code == '0', 'Native lock holder did not acknowledge a clean close'
    command('docker','rm',name+'-native-lock')

    # The financial-only root CLI must refuse a revoked, empty cross-organisation custody
    # dependency before touching the target's note. Once explicitly removed by the proof operator,
    # the target's own accounts can cascade through either its own agent or the surviving agent.
    before_hash = command('sudo','sha256sum',str(note)).split()[0]
    before_head = command('sudo','git','-c',f'safe.directory={vault}','-C',str(vault),'rev-parse','HEAD')
    shared = cli(config,'erase-proof-member','--vault','/vault','--apply',with_vault=True)
    assert shared.returncode != 0 and 'Another member still holds outside credentials' in shared.stdout, 'Cross-organisation shared-agent custody did not refuse before files'
    assert command('sudo','sha256sum',str(note)).split()[0] == before_hash, 'Shared-agent custody refusal changed file bytes'
    assert command('sudo','git','-c',f'safe.directory={vault}','-C',str(vault),'rev-parse','HEAD') == before_head, 'Shared-agent custody refusal changed Git HEAD'
    assert sql('eraseproof',"SELECT count(*) FROM outside_custody_accounts WHERE owner_member_id='erase-proof-other' AND state='revoked'") == '1', 'Refusal changed the foreign revoked account'
    sql('eraseproof',"DELETE FROM outside_custody_accounts WHERE account_id='40000000-0000-4000-8000-000000000003'")
    assert sql('eraseproof',"SELECT count(*) FROM outside_custody_accounts WHERE owner_member_id='erase-proof-member'") == '2', 'Target custody fixture was not populated'

    result = cli(config,'erase-proof-member','--vault','/vault','--apply',with_vault=True)
    assert result.returncode == 1 and 'Native credential cleanup remains pending' in result.stdout, 'Image CLI did not report committed erase with pending native cleanup'
    assert not root_exists(note), 'Root CLI did not remove the selected vault note'
    assert sql('eraseproof',"SELECT count(*) FROM users WHERE id='erase-proof-member'") == '0', 'Root CLI did not erase the member'
    assert sql('eraseproof',"SELECT count(*) FROM member_provider_identities WHERE member_id='erase-proof-member'") == '0', 'Root CLI retained provider identity'
    assert sql('eraseproof',"SELECT count(*) FROM org_member_policy WHERE user_id='erase-proof-member'") == '0', 'Root CLI retained member policy'
    assert sql('eraseproof',"SELECT count(*) FROM budget_accounts WHERE live_member_id='erase-proof-member'") == '0', 'Root CLI retained member account linkage'
    assert sql('eraseproof',"SELECT count(*) FROM budget_accounts WHERE kind='member' AND state='retired' AND reason='member_erased' AND canonical_suppression_hash IS NOT NULL AND cardinality(provider_suppression_hashes)>0") == '1', 'Root CLI did not retain minimal financial erasure proof'
    assert sql('eraseproof',"SELECT count(*) FROM outside_custody_accounts WHERE owner_member_id='erase-proof-member'") == '0', 'Root CLI retained erased member custody accounts'
    assert sql('eraseproof',"SELECT count(*) FROM outside_custody_revisions WHERE owner_member_id='erase-proof-member'") == '0', 'Root CLI retained erased member custody revisions'
    assert sql('eraseproof',"SELECT count(*) FROM outside_custody_operations WHERE owner_member_id='erase-proof-member'") == '0', 'Root CLI retained erased member custody operations'
    assert sql('eraseproof',"SELECT count(*) FROM outside_custody_accounts WHERE owner_member_id='erase-proof-owner'") == '1', 'Root CLI removed another member custody account'
    assert sql('eraseproof',"SELECT encode(ciphertext,'hex') FROM outside_custody_revisions WHERE owner_member_id='erase-proof-owner'") == '0c' * 24, 'Root CLI changed another member ciphertext'
    assert sql('eraseproof','SELECT count(*) FROM budget_gateway_bindings') == '0', 'Root CLI left a SQL binding for native cleanup'
    verify_run = ['docker','run','--rm','--platform','linux/amd64','--network',network,'--read-only','--user','0:0',
                  '--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp','--mount',
                  f'type=bind,src={root},dst=/probe,readonly','--mount',
                  f'type=bind,src={root}/secrets,dst=/probe/secrets,readonly','--mount',
                  f'type=bind,src={config},dst=/etc/lares/keeper.json,readonly','--mount',
                  f'type=bind,src={state},dst=/var/lib/lares','--entrypoint',tsx,image,'/probe/verify-erase-native.mts']
    native_state = json.loads(command(*verify_run))
    assert all(native_state.values()), 'Reopened native custody did not prove minimal pending cleanup'
    print(json.dumps({'rootOnlyCli':True,'missingPreparedCustodyRefused':True,'liveKernelLockRefusedBeforeCheckout':True,
                      'zeroAccountLegacyErasure':True,'configuredNativeRefusalBeforeCheckout':True,
                      'nativeHeldLockRefusedBeforeCheckout':True,'nativeCleanupPendingReported':True,
                      'nativeAssociationsErasedAndExactHashOriginRetained':True},sort_keys=True))
except subprocess.TimeoutExpired:
    raise RuntimeError('Disposable image proof timed out') from None
finally:
    command('docker','rm','-f',name+'-lock',check=False)
    command('docker','rm','-f',name+'-native-lock',check=False)
    command('docker','rm','-f',name+'-db',check=False)
    command('docker','network','rm',network,check=False)
    command('sudo','python3','-c','import shutil,sys;shutil.rmtree(sys.argv[1],ignore_errors=True)',str(root),check=False)
    shutil.rmtree(operator_source,ignore_errors=True)
