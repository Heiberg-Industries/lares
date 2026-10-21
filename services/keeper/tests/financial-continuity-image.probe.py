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
import{{provisionBudgetAccounts}}from'{base}budget-account-provisioning.ts';
import{{consoleSourceTransaction}}from'/app/packages/agent-kit/src/console-source-transaction.ts';
import{{budgetAccountProvisionPlanSchema}}from'{base}budget-account-provisioning.ts';
import{{registerAction}}from'{base}actions.ts';
import{{serve}}from'{base}socket-server.ts';
import{{PgBudgetAdmissionStore,budgetIdentitySuppression,canonicalBudgetMoney}}from'/app/packages/agent-kit/src/budget-admission-store.ts';
import{{captureModelInvocation,runModelInvocation}}from'/app/packages/agent-kit/src/model-invocation.ts';
import{{bindConsoleSession}}from'/app/packages/agent-kit/src/console-turn-authority.ts';
import{{PgGrantStore}}from'/app/packages/agent-kit/src/grant-store.ts';
import{{GatewayBudgetAuthority}}from'{base}gateway-budget.ts';
import{{GATEWAY_ADMIT_PATH,GATEWAY_SETTLE_PATH,gatewayCanonical,gatewaySignature,gatewayHash,verifyGatewaySignature}}from'/app/packages/agent-kit/src/gateway-admission-protocol.ts';
import{{readFileSync,writeFileSync}}from'node:fs';
import{{createHash,randomUUID}}from'node:crypto';
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
    sql('CREATE DATABASE restoreproof TEMPLATE proof; CREATE DATABASE clusterproof TEMPLATE proof; CREATE DATABASE unknownproof TEMPLATE proof; CREATE DATABASE crashproof TEMPLATE proof; CREATE DATABASE provisionproof TEMPLATE proof; CREATE DATABASE gatewayproof TEMPLATE proof;')
    for database, directory in [('proof', 'restart'), ('restoreproof', 'restore'), ('clusterproof', 'cluster'), ('unknownproof', 'unknown'), ('crashproof', 'crash'), ('provisionproof', 'provision'), ('gatewayproof', 'gateway')]:
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
    # Real PostgreSQL provisioning at pool max=1 covers closed state, durable projection,
    # exact retries, explicit cap changes and UTC month rollover.
    sql("INSERT INTO orgs(id,display_name) VALUES('provision-proof-org','Provision proof'); INSERT INTO users(id,display_name,org_id,org_role,status) VALUES('provision-proof-a','A','provision-proof-org','owner','active'),('provision-proof-b','B','provision-proof-org','member','active'); INSERT INTO member_provider_identities(member_id,issuer,subject,tenant_id) VALUES('provision-proof-a','https://identity.example.invalid','subject-a','tenant'),('provision-proof-b','https://identity.example.invalid','subject-b','tenant'); INSERT INTO org_member_policy(user_id,spend_cap_usd_month) VALUES('provision-proof-a',25),('provision-proof-b',40);", 'provisionproof')
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
writeFileSync(configPath,JSON.stringify({mode:'overlay',project:'proof',dir:'/tmp',files:['config'],agentsDir:'/tmp',retiredDir:'/tmp',secretsDir:'/tmp',rolesDir:'/tmp',templatesDir:'/tmp',backupDir:'/tmp',db:{host:'proof-db',port:5432,database:'provisionproof',user:'proof',passwordFile:'/tmp/disposable-proof-password'},budgetFinancial:{directory:'/var/lib/lares/budget-financial'}}));
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
    print(run(provision, 'provisionproof'))
    # Actual signed gateway requests drive admission, grant and settlement through the
    # prepared Keeper journal and the same one-connection PostgreSQL pool.
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
await pool.query("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,installation_cap,selected_endpoint,recovery_epoch) VALUES($1,'installation','installation',$1,1,$2,'epoch-1')",[installation,endpoint]);
await pool.query("INSERT INTO budget_windows(id,account_id,live_member_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision) VALUES($1,$2,NULL,clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 day',0,1,0)",[installationWindow,installation]);
await pool.query("UPDATE budget_accounts SET active_window_id=$2,state='open',reason='approved' WHERE id=$1",[installation,installationWindow]);
await pool.query("INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,live_member_id,organisation_id,canonical_suppression_hash,provider_suppression_hashes) VALUES($1,'installation','member',$2,'member-a','org',$3,$4)",[member,installation,suppression.canonicalSuppressionHash,suppression.providerSuppressionHashes]);
await pool.query("INSERT INTO budget_windows(id,account_id,live_member_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision) VALUES($1,$2,'member-a',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 day',0,1,0)",[memberWindow,member]);
await pool.query("UPDATE budget_accounts SET active_window_id=$2,state='open',reason='approved' WHERE id=$1",[member,memberWindow]);
const pricing={version:1,capabilityHash:profile,format:'openai',limits:{inputTokens:1000,outputTokens:1000},usdPerMillionTokens:{input:'10',output:'90',cacheRead:'5',cacheWrite:'0'}};
await pool.query("INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,key_fingerprint,agent,incarnation,purpose_alias,profile_hash,maximum_liability,pricing_profile,state) VALUES($1,$2,$3,'member-a',$4,0,$5,'helper',$6,'standard',$7,0.1,$8::jsonb,'active')",[binding,installation,member,endpoint,fingerprint,incarnation,profile,JSON.stringify(pricing)]);
const store=new PgBudgetAdmissionStore(pool,env),requestHash=hash('request'),invocation=captureModelInvocation({type:'step.started',data:{turnId:'turn-1',sequence:0,stepIndex:0}},context.session,'standard');
const ticket=await runModelInvocation(invocation,()=>store.prepareIntent({bindingId:binding,requestHash,profileHash:profile}));
const key=Buffer.alloc(32,9),witness={observe:async()=>({installationAccountId:installation,epoch:'epoch-1',endpointGeneration:'0',state:'reconciled'})};
const authority=new GatewayBudgetAuthority(pool,key,new JournalBudgetFinancialWriter(journal),witness);
const document={version:1,nonce:hash('nonce'),ticket,requestHash,profileHash:profile,endpointHash:endpoint,keyFingerprint:fingerprint,purposeAlias:'standard'},raw=gatewayCanonical(document);
const admitted=await authority.handle(GATEWAY_ADMIT_PATH,gatewaySignature(key,'request',GATEWAY_ADMIT_PATH,raw),raw);
if(admitted.status!==200||!verifyGatewaySignature(key,admitted.headers['x-lares-signature'],'response',GATEWAY_ADMIT_PATH,admitted.body))throw Error('signed gateway admission failed');
const grant=JSON.parse(admitted.body.toString()),settlement={version:1,nonce:grant.nonce,requestHash:grant.requestHash,profileHash:grant.profileHash,endpointHash:grant.endpointHash,keyFingerprint:grant.keyFingerprint,purposeAlias:grant.purposeAlias,attemptId:grant.attemptId,bindingId:grant.bindingId,kind:'terminal-usage',format:'openai',usage:{inputTokens:100,outputTokens:100,cacheReadTokens:40,cacheWriteTokens:0}};
settlement.receiptHash=gatewayHash(gatewayCanonical(settlement));const terminal=gatewayCanonical(settlement),reply=await authority.handle(GATEWAY_SETTLE_PATH,gatewaySignature(key,'request',GATEWAY_SETTLE_PATH,terminal),terminal);
if(reply.status!==200||JSON.parse(reply.body.toString()).state!=='settled')throw Error('signed gateway settlement failed');
const frames=readFileSync('/proof/gateway/journal.jsonl','utf8').trimEnd().split('\n').map(line=>JSON.parse(line)),records=frames.map(frame=>frame.record),proposals=frames.filter(frame=>frame.record.kind==='proposal');
if(JSON.stringify(records.filter(record=>record.kind==='begin').map(record=>record.operation))!==JSON.stringify(['admit','grant','settle'])||proposals.length!==3||records.filter(record=>record.kind==='commit').length!==3)throw Error('gateway journal operations incomplete');
for(const frame of proposals){const record=frame.record,row=(await pool.query('SELECT journal_id,proposal_sequence::text,proposal_digest FROM budget_financial_checkpoints WHERE operation_id=$1',[record.operationId])).rows[0];if(!row||row.journal_id!==records.find(value=>value.kind==='control').control.journalId||row.proposal_sequence!==String(record.sequence)||row.proposal_digest!==frame.digest)throw Error('gateway journal checkpoint mismatch');}
for(const frame of proposals){for(const atom of frame.record.atoms.filter(value=>value.kind==='account')){const generation=(await pool.query('SELECT policy_generation::text FROM budget_accounts WHERE id=$1',[atom.id])).rows[0]?.policy_generation;if(atom.policyGeneration!==generation)throw Error('journal account policy generation mismatch');}}
const attempt=(await pool.query('SELECT state,actual_amount FROM budget_attempts WHERE id=$1',[grant.attemptId])).rows[0];if(attempt.state!=='settled'||canonicalBudgetMoney(String(attempt.actual_amount))!=='0.0098')throw Error('gateway source state mismatch');
console.log('gateway journaled');
}finally{await journal.drainForShutdown();journal.close();}"""
    assert run(gateway, 'gatewayproof') == 'gateway journaled'
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
