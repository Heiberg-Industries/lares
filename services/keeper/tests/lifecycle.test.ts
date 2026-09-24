import { mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { PostgreSqlContainer,type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { beforeAll,afterAll,beforeEach,it,expect,vi } from 'vitest';
import { AgentLifecycle } from '../lib/lifecycle.js';
import { WorkflowStorage } from '../lib/workflow-storage.js';
import type { LifecycleConfig } from '../lib/lifecycle-config.js';
import type { DockerBoundary } from '../lib/docker.js';
import { parse } from 'yaml';
const repo=resolve('../..'), image='example/image@sha256:'+'a'.repeat(64);
let pg:StartedPostgreSqlContainer,pool:Pool,root:string,config:LifecycleConfig,events:string[],started:string[],fail:string|undefined;
const definition:any={...JSON.parse(readFileSync(join(repo,'packages/agent-kit/templates/creative/agent.json'),'utf8')),name:'bookkeeper',role:'creative',doors:[],grants:[]};
const step=async(s:string)=>{events.push(s);if(fail===s)throw new Error('injected '+s);};
const docker:DockerBoundary={inventory:async()=>['172.18.0.1','172.18.0.20','172.18.0.21'],config:()=>step('config'),start:(n,address)=>{started.push(address);return step('start:'+n);},stop:n=>step('stop:'+n),remove:n=>step('remove:'+n),validateSquid:()=>step('parse-squid'),reloadSquid:()=>step('reload-squid'),firewall:(_s,check)=>step(check?'parse-nft':'apply-nft')};
const lifecycle=()=>new AgentLifecycle(pool,pool,config,{agentsDir:join(root,'agents'),secretsDir:join(root,'secrets')},docker,()=>{},()=>{});
beforeAll(async()=>{
 pg=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();pool=new Pool({connectionString:pg.getConnectionUri()});
 for(const f of ['001_init.sql','003_digest.sql','005_workflow_jobs.sql','008_ratchet.sql','031_schedule_heartbeat.sql','035_proactivity.sql','038_permissions_board.sql','039_agent_definitions.sql','040_keeper.sql','041_definition_retirement.sql','042_agent_resources.sql','043_agent_conversations.sql','044_agent_door_connections.sql','045_agent_runtime_control.sql'])await pool.query(readFileSync(join(repo,'services/box/sql',f),'utf8'));
 await pool.query('CREATE DATABASE empty_workflow');
 const template=new Pool({connectionString:pg.getConnectionUri().replace(/\/[^/]+$/,'/empty_workflow')});
 await template.query('CREATE SCHEMA workflow; CREATE TABLE workflow.memory(value text)');await template.end();
 await pool.query("CREATE TABLE standing_facts(value text); INSERT INTO standing_facts VALUES ('shared-owner')");
});
afterAll(async()=>{await pool?.end();await pg?.stop();if(root)rmSync(root,{recursive:true,force:true});});
beforeEach(async()=>{
 const rows=(await pool.query("SELECT datname FROM pg_database WHERE datname LIKE 'lares_%'")).rows;
 for(const row of rows)await pool.query(`DROP DATABASE "${row.datname}" WITH (FORCE)`);
 await pool.query('TRUNCATE agent_resources,agent_definitions,agent_doors,agent_door_connections,agent_door_claim_audit,ratchet,ratchet_audit,agent_registry,proactivity_settings,heartbeat,sessions,confirmations,reminders,trigger_schedules,workflow_jobs,digest_requests,digest_skips');
 if(root)rmSync(root,{recursive:true,force:true});root=mkdtempSync(join(tmpdir(),'lares-owned-'));
 for(const d of ['agents','secrets','egress'])mkdirSync(join(root,d));
 config={network:'test_default',subnet:'172.18.0.0/24',reservedAddresses:['172.18.0.22'],composeFile:join(root,'compose.lares-agents.yaml'),egressDir:join(root,'egress'),imageByRole:{creative:image,travel:image,'chief-of-staff':image},proxyContainer:'lares-egress-proxy',squidImage:image,firewallImage:image,adminDb:{host:'db',port:5432,user:pg.getUsername(),database:pg.getDatabase(),passwordFile:'/secret'},workflowTemplate:'empty_workflow',workflowOwner:pg.getUsername(),runtime:{schedulesLive:false,databaseUrl:'postgres://user@db/domain',workflowServer:'postgres://user@db/',gatewayUrl:'https://brain.example.com',proxyUrl:'http://proxy:8888',passwordFile:join(root,'secrets','db'),gatewayKeys:{bookkeeper:join(root,'secrets','key')}},egress:{endpoints:{},legacyConsumers:[{name:'sync',address:'172.18.0.23',hosts:['api.notion.com']}],internalNetworks:['172.18.0.0/24'],directDestinations:[],infrastructureHosts:['brain.example.com']},installationPrepared:true};
 await pool.query("INSERT INTO agent_definitions(name,hash,definition,valid_at,status) VALUES($1,'test',$2::jsonb,now(),'valid')",['bookkeeper',JSON.stringify(definition)]);
 events=[];started=[];fail=undefined;
});
it('clones an owned workflow database, seals before starting and reserves the whole network inventory',async()=>{
 const l=lifecycle();await l.create('bookkeeper',definition);
 const row=await l.storage.row('bookkeeper');expect(row.address).toBe('172.18.0.24');expect(row.workflow_database).toMatch(/^lares_[a-f0-9]{32}$/);
 const own=new Pool({connectionString:pg.getConnectionUri().replace(/\/[^/]+$/,`/${row.workflow_database}`)});
 await own.query("INSERT INTO workflow.memory VALUES ('owned')");expect((await own.query('SELECT * FROM workflow.memory')).rows).toEqual([{value:'owned'}]);await own.end();
 expect(events).toEqual(['config','stop:bookkeeper','parse-squid','parse-nft','apply-nft','reload-squid','start:bookkeeper']);
 expect(started).toEqual(['172.18.0.24']);
 const doc=parse(readFileSync(config.composeFile,'utf8'));expect(doc.services['lares-bookkeeper'].environment.WORKFLOW_POSTGRES_URL).toContain(row.workflow_database);
 expect(doc.services['lares-bookkeeper'].environment.LARES_AGENT_INCARNATION).toBe(row.ownership_token);
 expect(doc.services['lares-bookkeeper'].labels['lares.incarnation']).toBe(row.ownership_token);
 expect(doc.services['lares-bookkeeper'].secrets).toContainEqual({source:'bookkeeper-runtime-control',target:'runtime-control'});
 expect(readFileSync(join(root,'secrets/bookkeeper-runtime-control'),'utf8')).toMatch(/^[a-f0-9]{64}$/);
 expect(readFileSync(join(config.egressDir,'squid.conf'),'utf8')).toContain('src_sync');
 expect(await l.status('bookkeeper')).toEqual({pending:false,reason:null});
 await l.stop('bookkeeper');expect((await pool.query('SELECT * FROM standing_facts')).rows).toEqual([{value:'shared-owner'}]);
 const retained=new Pool({connectionString:pg.getConnectionUri().replace(/\/[^/]+$/,`/${row.workflow_database}`)});expect((await retained.query('SELECT * FROM workflow.memory')).rows).toEqual([{value:'owned'}]);await retained.end();
 await pool.query(`INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,principal)VALUES('bookkeeper','slack',$1,$1,'owner@example.test','U_OWNER')`,[row.ownership_token]);
 await pool.query(`INSERT INTO agent_door_claim_audit(agent,kind,incarnation,principal)VALUES('bookkeeper','slack',$1,'U_OWNER')`,[row.ownership_token]);
 const plan=await l.prepareDelete('bookkeeper');await plan.delete();await plan.delete();
 expect((await pool.query("SELECT * FROM agent_door_connections WHERE agent='bookkeeper'")).rows).toEqual([]);
 expect((await pool.query("SELECT principal FROM agent_door_claim_audit WHERE agent='bookkeeper'")).rows).toEqual([{principal:'U_OWNER'}]);
 expect((await pool.query('SELECT datname FROM pg_database WHERE datname=$1',[row.workflow_database])).rows).toEqual([]);
 expect((await pool.query('SELECT * FROM standing_facts')).rows).toEqual([{value:'shared-owner'}]);
});
it('preserves installation bindings on repeated reconciles and refuses missing data before stopping a runtime',async()=>{
 const atlas=join(root,'atlas');mkdirSync(atlas);writeFileSync(join(atlas,'note.md'),'existing data');
 const integrationKey=join(root,'secrets','notion');writeFileSync(integrationKey,'test-only');
 config.bindings={bookkeeper:{role:'creative',ownerId:'prior-owner',environment:{ATLAS_PATH:'/srv/atlas'},mounts:[{source:atlas,target:'/srv/atlas',readOnly:false}],secrets:{NOTION_TOKEN_FILE:integrationKey},workflowVolume:'preserved-workflow-files'}};
 const provisioned:string[]=[];
 const l=new AgentLifecycle(pool,pool,config,{agentsDir:join(root,'agents'),secretsDir:join(root,'secrets')},docker,p=>{provisioned.push(p);},()=>{});
 await l.create('bookkeeper',definition);const first=readFileSync(config.composeFile,'utf8');
 await l.reconcile('bookkeeper',definition);
 expect(readFileSync(config.composeFile,'utf8')).toBe(first);expect(provisioned).toContain(integrationKey);
 const s=parse(first).services['lares-bookkeeper'];expect(s.environment.ATLAS_PATH).toBe('/srv/atlas');expect(s.environment.AGENT_OWNER_USER_ID).toBe('prior-owner');
 expect(readFileSync(join(atlas,'note.md'),'utf8')).toBe('existing data');
 rmSync(atlas,{recursive:true});events=[];
 await expect(l.reconcile('bookkeeper',definition)).rejects.toThrow();
 expect(events).toEqual([]);expect(readFileSync(config.composeFile,'utf8')).toBe(first);
});
it('uses a role default for an arbitrary agent name and lets an exact name binding win',async()=>{
 const routePassword=join(root,'installer-route-password');writeFileSync(routePassword,'test-only');
 config.defaultBindings={creative:{role:'creative',ownerId:'fresh-owner',environment:{},mounts:[],secrets:{EVE_ROUTE_PASSWORD_FILE:routePassword}}};
 const l=lifecycle();await l.create('bookkeeper',definition);
 let service=parse(readFileSync(config.composeFile,'utf8')).services['lares-bookkeeper'];
 expect(service.environment.AGENT_OWNER_USER_ID).toBe('fresh-owner');
 expect(service.environment.EVE_ROUTE_PASSWORD_FILE).toBe('/run/secrets/eve-route-password');
 expect(service.secrets).toContainEqual({source:'bookkeeper-integration-eve-route-password',target:'eve-route-password'});
 expect(parse(readFileSync(config.composeFile,'utf8')).secrets['bookkeeper-integration-eve-route-password']).toEqual({file:routePassword});

 config.bindings={bookkeeper:{role:'creative',ownerId:'exact-owner',environment:{},mounts:[],secrets:{EVE_ROUTE_PASSWORD_FILE:routePassword}}};
 await l.reconcile('bookkeeper',definition);
 service=parse(readFileSync(config.composeFile,'utf8')).services['lares-bookkeeper'];
 expect(service.environment.AGENT_OWNER_USER_ID).toBe('exact-owner');
});
it('provisions an arbitrary agent key after durable storage and before its runtime starts',async()=>{
 const masterKeyFile=join(root,'installer-gateway-master');writeFileSync(masterKeyFile,'sk-test-master-key-only');
 config.runtime.gatewayKeys={};config.runtime.gatewayMasterKeyFile=masterKeyFile;
 await pool.query("INSERT INTO settings(key,value,updated_by) VALUES('models.alias_prefix','\"lares\"','test') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
 const provisioned:string[]=[];
 const ensure=vi.fn(async(options:{secretFile:string})=>{
  // The network mutation is not allowed until WorkflowStorage has durably reserved ownership.
  expect(await lifecycleRow()).toMatchObject({name:'bookkeeper',ownership:'owned'});
  writeFileSync(options.secretFile,'sk-test-agent-key-only');
 });
 const remove=vi.fn(async()=>{});
 const lifecycleRow=async()=>new WorkflowStorage(pool,pool,config.workflowTemplate,config.workflowOwner).row('bookkeeper');
 const l=new AgentLifecycle(pool,pool,config,{agentsDir:join(root,'agents'),secretsDir:join(root,'secrets')},docker,p=>{provisioned.push(p);},()=>{}, {ensure,remove});
 await l.create('bookkeeper',definition);
 expect(ensure).toHaveBeenCalledWith({gatewayUrl:'https://brain.example.com',masterKeyFile,secretFile:join(root,'secrets','bookkeeper-gateway-key'),name:'bookkeeper',aliasPrefix:'lares'});
 const service=parse(readFileSync(config.composeFile,'utf8')).services['lares-bookkeeper'];
 expect(service.environment.GATEWAY_KEY_FILE).toBe('/run/secrets/gateway-key');
 expect(parse(readFileSync(config.composeFile,'utf8')).secrets['bookkeeper-gateway-key']).toEqual({file:join(root,'secrets','bookkeeper-gateway-key')});
 expect(provisioned).toContain(masterKeyFile);expect(provisioned).toContain(join(root,'secrets','bookkeeper-gateway-key'));
 expect(l.ownedSecrets('bookkeeper')).toEqual(['bookkeeper-gateway-key']);
 expect(events.at(-1)).toBe('start:bookkeeper');
 await l.stop('bookkeeper');await (await l.prepareDelete('bookkeeper')).delete();
 expect(remove).toHaveBeenCalledWith({gatewayUrl:'https://brain.example.com',masterKeyFile,secretFile:join(root,'secrets','bookkeeper-gateway-key'),name:'bookkeeper'});
});
it('does not start an unsealed agent, persists pending failure, and permits explicit idempotent reconcile',async()=>{
 const l=lifecycle();fail='parse-nft';await expect(l.create('bookkeeper',definition)).rejects.toThrow('injected');
 expect(events).not.toContain('apply-nft');expect(events).not.toContain('start:bookkeeper');expect((await l.status('bookkeeper')).pending).toBe(true);
 fail=undefined;await l.reconcile('bookkeeper',definition);expect((await l.status('bookkeeper')).pending).toBe(false);
});
it('keeps a started-but-unhealthy agent pending until explicit reconciliation succeeds',async()=>{
 const l=lifecycle();fail='start:bookkeeper';await expect(l.create('bookkeeper',definition)).rejects.toThrow('injected');
 expect(events).toContain('apply-nft');expect(events.at(-1)).toBe('start:bookkeeper');
 expect(await l.status('bookkeeper')).toMatchObject({pending:true,reason:'Runtime reconciliation in progress'});
 fail=undefined;events=[];await l.reconcile('bookkeeper',definition);
 expect(events.at(-1)).toBe('start:bookkeeper');expect(await l.status('bookkeeper')).toEqual({pending:false,reason:null});
});
it('applies grant ACLs immediately without restart and defers changed mounts with a visible pending reason',async()=>{
 const l=lifecycle();await l.create('bookkeeper',definition);events=[];
 await l.saved('bookkeeper',{...definition,grants:[{capability:'notion',scope:'read'}]});
 expect(events).toEqual(['parse-squid','parse-nft','apply-nft','reload-squid']);expect(readFileSync(join(config.egressDir,'squid.conf'),'utf8')).toContain('api.notion.com');
 const changed={...definition,doors:[{kind:'slack',enabled:false,settings:{}}]};
 expect((await l.saved('bookkeeper',changed)).pending).toBe(true);expect(events).not.toContain('start:bookkeeper');
 events=[];fail='reload-squid';await expect(l.saved('bookkeeper',definition)).rejects.toThrow();expect(events.at(-1)).toBe('stop:bookkeeper');expect((await l.status('bookkeeper')).pending).toBe(true);
});
it('refuses legacy and mismatched ownership before any Docker or destructive database effect',async()=>{
 const l=lifecycle();await l.create('bookkeeper',definition);const row=await l.storage.row('bookkeeper');events=[];
 await pool.query("COMMENT ON DATABASE \""+row.workflow_database+"\" IS 'someone-else'");await expect(l.prepareDelete('bookkeeper')).rejects.toThrow('ownership');expect(events).toEqual([]);
 expect((await pool.query('SELECT datname FROM pg_database WHERE datname=$1',[row.workflow_database])).rows).toHaveLength(1);
 await pool.query("UPDATE agent_resources SET ownership='legacy',workflow_database=$1 WHERE name='bookkeeper'",[pg.getDatabase()]);
 await expect(l.prepareDelete('bookkeeper')).rejects.toThrow('ownership');expect(events).toEqual([]);
 expect((await pool.query('SELECT * FROM standing_facts')).rows).toEqual([{value:'shared-owner'}]);
});

it('deletion clears only owned current authority before slug reuse and retains attributed audit history',async()=>{
 const l=lifecycle();await l.create('bookkeeper',definition);
 await pool.query("INSERT INTO ratchet(agent,capability,level,updated_by) VALUES ('bookkeeper','notion','autonomous','owner'),('another','notion','autonomous','owner')");
 await pool.query("INSERT INTO agent_registry(name,display_name,grants,autonomy) VALUES ('bookkeeper','B','[]','{}'),('another','A','[]','{}')");
 await pool.query("INSERT INTO heartbeat(agent) VALUES ('bookkeeper/tick'),('bookkeeper-other/tick'),('another/tick')");
 await pool.query("INSERT INTO proactivity_settings(owner,agent) VALUES ('owner','bookkeeper'),('owner','*'),('owner','another')");
 await l.stop('bookkeeper');
 expect((await pool.query("SELECT level FROM ratchet WHERE agent='bookkeeper'")).rows).toEqual([{level:'autonomous'}]);
 await (await l.prepareDelete('bookkeeper','owner@example.com')).delete();
 expect((await pool.query('SELECT agent,level FROM ratchet')).rows).toEqual([{agent:'another',level:'autonomous'}]);
 expect((await pool.query('SELECT name FROM agent_registry')).rows).toEqual([{name:'another'}]);
 expect((await pool.query('SELECT agent FROM heartbeat ORDER BY agent')).rows).toEqual([{agent:'another/tick'},{agent:'bookkeeper-other/tick'}]);
 expect((await pool.query('SELECT agent FROM proactivity_settings ORDER BY agent')).rows).toEqual([{agent:'*'},{agent:'another'}]);
 expect((await pool.query("SELECT old_level,new_level,changed_by FROM ratchet_audit WHERE agent='bookkeeper' ORDER BY id DESC LIMIT 1")).rows).toEqual([{old_level:'autonomous',new_level:null,changed_by:'owner@example.com'}]);
 await l.deleted('bookkeeper');await l.create('bookkeeper',definition);
 expect((await pool.query("SELECT level FROM ratchet WHERE agent='bookkeeper'")).rows).toEqual([]);
 expect((await pool.query('SELECT * FROM standing_facts')).rows).toEqual([{value:'shared-owner'}]);
});

it.each(['parse-nft','reload-squid'])('retirement failure at %s stays visible and supports an explicit retry without save unsealing',async failure=>{
 const {registerDefinitionActions}=await import('../lib/definitions.js');
 const {resetActions,runAction}=await import('../lib/actions.js');
 const {deployedToolsFor}=await import('@lares/agent-kit/persona');
 const l=lifecycle();await l.create('bookkeeper',definition);
 const agentsDir=join(root,'agents'),retiredDir=join(root,'retired');mkdirSync(retiredDir);mkdirSync(join(agentsDir,'bookkeeper'));
 const valid={...definition,model:'test-writer',duties:'duties.md',autonomy:{}};
 writeFileSync(join(agentsDir,'bookkeeper','agent.json'),JSON.stringify(valid));writeFileSync(join(agentsDir,'bookkeeper','duties.md'),'Duties');writeFileSync(join(agentsDir,'bookkeeper','voice.md'),'Voice');
 resetActions();registerDefinitionActions({pool,agentsDir,retiredDir,secretsDir:join(root,'secrets'),ceiling:async()=>1,compose:l,storage:l,backup:{commit:async()=>{}},roleInfo:r=>({roleMd:readFileSync(join(repo,'packages/agent-kit/templates',r,'role.md'),'utf8'),deployedTools:deployedToolsFor(join(repo,'services',r))})});
 const ctx={actor:'owner@example.com',audit:async()=>{}};events=[];fail=failure;
 await expect(runAction('definition.retire',{name:'bookkeeper'},ctx)).rejects.toThrow();
 const pending={pending:true,reason:'Retirement pending; retry definition.retire'};
 expect((await runAction('definition.get',{name:'bookkeeper'},ctx) as any).runtime).toEqual(pending);
 expect((await runAction('definition.list',{},ctx) as any[])[0].runtime).toEqual(pending);
 expect((await l.storage.row('bookkeeper')).state).toBe('ready');
 expect((await pool.query("SELECT status FROM agent_definitions WHERE name='bookkeeper'")).rows[0].status).toBe('valid');
 fail=undefined;events=[];
 const token=join(root,'secrets','bookkeeper-slack-token');writeFileSync(token,'original-token');
 await pool.query("INSERT INTO agent_doors(agent,kind,secret_set_at) VALUES('bookkeeper','slack','2026-01-01T00:00:00Z')");
 const doorBefore=(await pool.query("SELECT * FROM agent_doors WHERE agent='bookkeeper' AND kind='slack'")).rows;
 await expect(runAction('door.connect',{name:'bookkeeper',kind:'slack',secret:'xoxb-replacement-token',signingSecret:'a'.repeat(32)},ctx)).rejects.toThrow('retirement');
 expect(readFileSync(token,'utf8')).toBe('original-token');
 expect((await pool.query("SELECT * FROM agent_doors WHERE agent='bookkeeper' AND kind='slack'")).rows).toEqual(doorBefore);
 const before=readFileSync(join(config.egressDir,'squid.conf'),'utf8');
 await expect(runAction('definition.save',{name:'bookkeeper',definition:valid,duties:'Duties',voice:'Voice'},ctx)).rejects.toThrow('retirement');
 await expect(l.saved('bookkeeper',valid)).rejects.toThrow('retirement');
 expect(events).toEqual([]);expect(readFileSync(join(config.egressDir,'squid.conf'),'utf8')).toBe(before);
 await expect(l.reconcile('bookkeeper',valid)).rejects.toThrow('retirement');
 await expect(l.secretChanged('bookkeeper')).rejects.toThrow('retirement');
 expect(await l.status('bookkeeper')).toEqual(pending);
 await expect(runAction('definition.retire',{name:'bookkeeper'},ctx)).resolves.toMatchObject({status:'retired'});
 expect((await l.storage.row('bookkeeper')).state).toBe('retired');
 expect(await l.status('bookkeeper')).toEqual({pending:false,reason:null});
 expect(events).toEqual(['stop:bookkeeper','parse-squid','parse-nft','apply-nft','reload-squid']);
});

it.each(['missing','invalid'])('refuses publication for a ready resource with %s definition before replacing any seal or compose',async corruption=>{
 const {readdirSync}=await import('node:fs');
 const l=lifecycle();await l.create('bookkeeper',definition);
 // The existing container's registry entry vanishes/corrupts while a separate valid agent reconciles.
 await pool.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,state,applied_definition,pending) VALUES('orphan','172.18.0.30','legacy_orphan','legacy',gen_random_uuid(),'ready',$1::jsonb,false)",[JSON.stringify({...definition,name:'orphan'})]);
 config.runtime.gatewayKeys.orphan=join(root,'secrets','orphan-key');
 await pool.query("INSERT INTO agent_definitions(name,hash,definition) VALUES('orphan','previous-valid',$1::jsonb)",[JSON.stringify({...definition,name:'orphan'})]);
 await l.saved('bookkeeper',definition);
 expect(readFileSync(join(config.egressDir,'squid.conf'),'utf8')).toContain('src_orphan');
 if(corruption==='invalid')await pool.query("UPDATE agent_definitions SET definition='{}' WHERE name='orphan'");
 else await pool.query("DELETE FROM agent_definitions WHERE name='orphan'");
 const before=readdirSync(config.egressDir).sort().map(n=>[n,readFileSync(join(config.egressDir,n),'utf8')]);
 const compose=readFileSync(config.composeFile,'utf8');events=[];
 await expect(l.saved('bookkeeper',definition)).rejects.toThrow('definition');
 expect(events).toEqual(['stop:bookkeeper']);
 expect(readdirSync(config.egressDir).sort().map(n=>[n,readFileSync(join(config.egressDir,n),'utf8')])).toEqual(before);
 events=[];await expect(l.reconcile('bookkeeper',definition)).rejects.toThrow('definition');expect(events).toEqual([]);
 expect(readFileSync(config.composeFile,'utf8')).toBe(compose);
});

it('recovers an interrupted owned provisioning row before applying connections',async()=>{
 const l=lifecycle();
 // Crash after the durable resource reservation, before database creation/comment/ready.
 await pool.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,pending) VALUES('bookkeeper','172.18.0.24','lares_11111111111141118111111111111111','owned','11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','provisioning',true)");
 await l.reconcile('bookkeeper',definition);
 const row=await l.storage.row('bookkeeper');expect(row.state).toBe('ready');expect(row.pending).toBe(false);
 expect((await pool.query('SELECT datname FROM pg_database WHERE datname=$1',[row.workflow_database])).rows).toHaveLength(1);
 expect(events.at(-1)).toBe('start:bookkeeper');
});
it.each(['retired','deleting','legacy'])('refuses %s reconciliation before any runtime effect',async state=>{
 const l=lifecycle();await l.create('bookkeeper',definition);events=[];
 await pool.query("UPDATE agent_resources SET state=$1,ownership=$2,runtime_control_token=CASE WHEN $2='legacy' THEN NULL ELSE ownership_token END WHERE name='bookkeeper'",[state==='legacy'?'ready':state,state==='legacy'?'legacy':'owned']);
 await expect(l.reconcile('bookkeeper',definition)).rejects.toThrow();expect(events).toEqual([]);
});

it('defaults legacy runtime control to denied; exact manual adoption retains storage and failure remains pending',async()=>{
 const l=lifecycle(),token='22222222-2222-4222-8222-222222222222';
 await pool.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,state)VALUES('bookkeeper','172.18.0.24',$1,'legacy',$2,'ready')",[pg.getDatabase(),token]);
 expect((await l.storage.row('bookkeeper')).runtime_control_token).toBeNull();
 await expect(l.reconcile('bookkeeper',definition)).rejects.toThrow();
 await expect(l.prepareSecretChange('bookkeeper')).rejects.toThrow();
 await expect(l.stop('bookkeeper')).rejects.toThrow();expect(events).toEqual([]);
 await expect(pool.query("UPDATE agent_resources SET runtime_control_token='33333333-3333-4333-8333-333333333333' WHERE name='bookkeeper'")).rejects.toThrow('runtime_control_current_incarnation');
 // The operator checks the entire retained mapping; a stale incarnation changes no row.
 const adopt=(inc:string)=>pool.query("UPDATE agent_resources SET runtime_control_token=ownership_token,pending=true,pending_reason='Manual runtime adoption requires reconcile' WHERE name='bookkeeper' AND ownership_token=$1 AND workflow_database=$2 AND address='172.18.0.24'::inet AND ownership='legacy' AND state='ready'",[inc,pg.getDatabase()]);
 expect((await adopt('33333333-3333-4333-8333-333333333333')).rowCount).toBe(0);
 expect((await adopt(token)).rowCount).toBe(1);
 await expect(l.storage.provision('bookkeeper','172.18.0.24')).rejects.toThrow('cannot be provisioned');
 fail='parse-nft';await expect(l.reconcile('bookkeeper',definition)).rejects.toThrow('injected');
 expect(events).not.toContain('start:bookkeeper');expect((await l.storage.row('bookkeeper')).pending).toBe(true);
 fail=undefined;events=[];await l.reconcile('bookkeeper',definition);
 const row=await l.storage.row('bookkeeper');expect(row).toMatchObject({ownership:'legacy',workflow_database:pg.getDatabase(),runtime_control_token:token,pending:false});
 const compose=parse(readFileSync(config.composeFile,'utf8'));expect(compose.services['lares-bookkeeper'].labels['lares.incarnation']).toBe(token);
 expect(compose.services['lares-bookkeeper'].environment.WORKFLOW_POSTGRES_URL).toContain(pg.getDatabase());
 expect(Object.keys(compose.services)).toEqual(['lares-bookkeeper']);
 await l.prepareSecretChange('bookkeeper');events=[];
 await expect(l.prepareDelete('bookkeeper')).rejects.toThrow('ownership');expect(events).toEqual([]);
 expect((await pool.query('SELECT * FROM standing_facts')).rows).toEqual([{value:'shared-owner'}]);
 await pool.query("UPDATE agent_resources SET runtime_control_token=NULL WHERE name='bookkeeper'");
 await expect(l.reconcile('bookkeeper',definition)).rejects.toThrow();await expect(l.prepareSecretChange('bookkeeper')).rejects.toThrow();expect(events).toEqual([]);
});

it('keeps unadopted legacy addresses sealed without publishing their containers',async()=>{
 const d={...definition,name:'legacy'};config.runtime.gatewayKeys.legacy=join(root,'secrets/legacy-key');
 await pool.query("INSERT INTO agent_definitions(name,hash,definition,status)VALUES('legacy','test',$1,'valid')",[JSON.stringify(d)]);
 await pool.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,state,applied_definition,pending)VALUES('legacy','172.18.0.25','legacy_store','legacy',gen_random_uuid(),'ready',$1,false)",[JSON.stringify(d)]);
 await lifecycle().create('bookkeeper',definition);
 expect(Object.keys(parse(readFileSync(config.composeFile,'utf8')).services)).toEqual(['lares-bookkeeper']);
 expect(readFileSync(join(config.egressDir,'squid.conf'),'utf8')).toContain('172.18.0.25');
});

it('migration adopts only pre-existing owned rows and constrains authority to current incarnation',async()=>{
 const client=await pool.connect();
 try {
  await client.query('BEGIN; CREATE SCHEMA migration045_test; SET LOCAL search_path=migration045_test');
  await client.query(readFileSync(join(repo,'services/box/sql/042_agent_resources.sql'),'utf8'));
  await client.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,state)VALUES('owned','172.18.0.40','owned_db','owned',gen_random_uuid(),'ready'),('legacy','172.18.0.41','legacy_db','legacy',gen_random_uuid(),'ready')");
  await client.query(readFileSync(join(repo,'services/box/sql/045_agent_runtime_control.sql'),'utf8'));
  const rows=(await client.query('SELECT ownership,ownership_token,runtime_control_token FROM agent_resources ORDER BY ownership')).rows;
  expect(rows[0].runtime_control_token).toBeNull();expect(rows[1].runtime_control_token).toBe(rows[1].ownership_token);
 } finally {await client.query('ROLLBACK');client.release();}
});

it.each([[undefined,true,false],[false,true,false],[true,false,false],[true,true,true]])('packages schedule master %s and definition %s as effective %s',async(master,on,expected)=>{
 const {lifecycleSchema}=await import('../lib/lifecycle-config.js');
 const {scheduleEnabled}=await import('@lares/agent-kit/schedule-switch');
 config=lifecycleSchema.parse({...config,runtime:{...config.runtime,schedulesLive:master}});
 expect(config.runtime.schedulesLive).toBe(master===true);
 await lifecycle().create('bookkeeper',definition);
 const env=parse(readFileSync(config.composeFile,'utf8')).services['lares-bookkeeper'].environment;
 expect(env.EVE_SCHEDULES_LIVE).toBe(master===true?'1':'0');
 expect(scheduleEnabled({...definition,schedules:{tick:{on}}},'tick',env)).toBe(expected);
 expect(()=>lifecycleSchema.parse({...config,runtime:{...config.runtime,schedulesLive:'true'}})).toThrow();
});
it('owned retire/delete/recreate rotates runtime control while ordinary reconcile preserves it and legacy deletion refuses',async()=>{
 const {registerDefinitionActions}=await import('../lib/definitions.js');
 const {resetActions,runAction}=await import('../lib/actions.js');
 const {deployedToolsFor}=await import('@lares/agent-kit/persona');
 const {conversationResetRoute}=await import('@lares/agent-kit/conversation-route');
 const l=lifecycle(),agentsDir=join(root,'agents'),retiredDir=join(root,'retired');mkdirSync(retiredDir);
 await pool.query("DELETE FROM agent_definitions WHERE name='bookkeeper'");
 resetActions();registerDefinitionActions({pool,agentsDir,retiredDir,secretsDir:join(root,'secrets'),ceiling:async()=>1,compose:l,storage:l,backup:{commit:async()=>{}},roleInfo:r=>({roleMd:readFileSync(join(repo,'packages/agent-kit/templates',r,'role.md'),'utf8'),deployedTools:deployedToolsFor(join(repo,'services',r))})});
 const ctx={actor:'owner@example.test',audit:async()=>{}},valid={...definition,model:'test-writer',duties:'duties.md',autonomy:{}};
 const create=()=>runAction('definition.create',{name:'bookkeeper',startingPoint:'creative',definition:valid,duties:'Duties',voice:'Voice'},ctx);
 const secretFile=join(root,'secrets/bookkeeper-runtime-control');
 await create();const oldSecret=readFileSync(secretFile,'utf8'),oldRow=await l.storage.row('bookkeeper');
 await l.reconcile('bookkeeper',valid);expect(readFileSync(secretFile,'utf8')).toBe(oldSecret);
 await runAction('definition.retire',{name:'bookkeeper'},ctx);
 await pool.query("UPDATE agent_resources SET ownership='legacy' WHERE name='bookkeeper'");
 await expect(runAction('definition.delete',{name:'bookkeeper',confirm:true},ctx)).rejects.toThrow('ownership');
 expect(readFileSync(secretFile,'utf8')).toBe(oldSecret);
 await pool.query("UPDATE agent_resources SET ownership='owned' WHERE name='bookkeeper'");
 await runAction('definition.delete',{name:'bookkeeper',confirm:true},ctx);
 await create();const newSecret=readFileSync(secretFile,'utf8');
 expect((await l.storage.row('bookkeeper')).ownership_token).not.toBe(oldRow.ownership_token);
 expect(newSecret).not.toBe(oldSecret);
 vi.stubEnv('LARES_RUNTIME_CONTROL_SECRET_FILE',secretFile);
 try {
  const request=(secret:string)=>new Request('http://localhost/lares/runtime/conversations/reset',{method:'POST',headers:{authorization:'Basic '+Buffer.from('keeper:'+secret).toString('base64')},body:'{}'});
  const attachSession=vi.fn();
  expect((await conversationResetRoute(request(oldSecret),{attachSession})).status).toBe(401);
  expect((await conversationResetRoute(request(newSecret),{attachSession})).status).toBe(400);
  expect(attachSession).not.toHaveBeenCalled();
 }finally{vi.unstubAllEnvs();}
});
