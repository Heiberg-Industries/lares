import { mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { PostgreSqlContainer,type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { quiet } from './helpers/quiet-pool.js';
import { beforeAll,afterAll,beforeEach,it,expect,vi } from 'vitest';
import { AgentLifecycle } from '../lib/lifecycle.js';
import { WorkflowStorage } from '../lib/workflow-storage.js';
import type { LifecycleConfig } from '../lib/lifecycle-config.js';
import { AgentNotHealthyError, NoOwnedContainerError, type DockerBoundary } from '../lib/docker.js';
import { parse } from 'yaml';
import { initialCredentialRecord } from '../lib/credential-state.js';
const repo=resolve('../..'), image='example/image@sha256:'+'a'.repeat(64);
let pg:StartedPostgreSqlContainer,pool:Pool,root:string,config:LifecycleConfig,events:string[],started:string[],fail:string|undefined;
const definition:any={...JSON.parse(readFileSync(join(repo,'packages/agent-kit/templates/creative/agent.json'),'utf8')),name:'bookkeeper',role:'creative',doors:[],grants:[]};
const step=async(s:string)=>{events.push(s);if(fail===s)throw new Error('injected '+s);};
const docker:DockerBoundary={inventory:async()=>['172.18.0.1','172.18.0.20','172.18.0.21'],config:()=>step('config'),start:(n,address)=>{started.push(address);return step('start:'+n);},stop:n=>step('stop:'+n),remove:n=>step('remove:'+n),validateSquid:()=>step('parse-squid'),reloadSquid:()=>step('reload-squid'),firewall:(_s,check)=>step(check?'parse-nft':'apply-nft')};
const lifecycle=()=>new AgentLifecycle(pool,pool,config,{agentsDir:join(root,'agents'),secretsDir:join(root,'secrets')},docker,()=>{},()=>{});
it('credential reconciliation preserves applied definitions, grants, unrelated bindings and durable disconnect', async () => {
 const l=lifecycle(); await l.create('bookkeeper',definition);
 const notion=join(root,'secrets/notion-token'), other=join(root,'secrets/other-key');
 writeFileSync(notion,'synthetic-notion');writeFileSync(other,'unrelated');
 writeFileSync(config.runtime.passwordFile,'synthetic-db');writeFileSync(config.runtime.gatewayKeys.bookkeeper!,'synthetic-gateway');
 config.bindings={bookkeeper:{role:'creative',environment:{},mounts:[],secrets:{NOTION_TOKEN_FILE:notion,EVE_ROUTE_PASSWORD_FILE:other}}};
 const revision='11111111-1111-4111-8111-111111111111';
 let state:any={...initialCredentialRecord(),activeRevision:revision,effectiveRevision:revision,activationIntent:{targetRevision:revision}};
 l.setCredentialState(async()=>state); const before=await l.storage.row('bookkeeper');
 const start=vi.spyOn(docker,'start'); events=[];
 await l.credentialPreflight(['bookkeeper']); await l.reconcileCredential('bookkeeper',revision);
 expect(start).toHaveBeenLastCalledWith('bookkeeper',before.address,true);
 let service=parse(readFileSync(config.composeFile,'utf8')).services['lares-bookkeeper'];
 expect(service.labels['lares.notion-revision']).toBe(revision);
 expect(service.environment.NOTION_TOKEN_FILE).toBe('/run/secrets/notion-token');
 state={...state,effectiveRevision:null,activationIntent:{targetRevision:null}};
 await l.reconcileCredential('bookkeeper',null); rmSync(notion);
 state={...initialCredentialRecord(),phase:'disconnected',effectiveRevision:null};
 await l.prepare('bookkeeper',definition,false); await l.reconcile('bookkeeper',definition);
 service=parse(readFileSync(config.composeFile,'utf8')).services['lares-bookkeeper'];
 expect(service.labels['lares.notion-revision']).toBe('disconnected'); expect(service.environment.NOTION_TOKEN_FILE).toBeUndefined();
 expect(service.environment.EVE_ROUTE_PASSWORD_FILE).toBe('/run/secrets/eve-route-password');
 expect((await l.storage.row('bookkeeper')).applied_definition).toEqual(before.applied_definition);
 expect(readFileSync(other,'utf8')).toBe('unrelated'); start.mockRestore();
});
it('mounts the managed key only into a granted chief of staff, only when a key revision exists, and never invents a binding',async()=>{
 const chief:any={...JSON.parse(readFileSync(join(repo,'packages/agent-kit/templates/chief-of-staff/agent.json'),'utf8')),name:'bookkeeper',role:'chief-of-staff',doors:[],grants:[]};
 const notion=join(root,'secrets/notion-token'); writeFileSync(notion,'synthetic-notion');
 writeFileSync(config.runtime.passwordFile,'synthetic-db');writeFileSync(config.runtime.gatewayKeys.bookkeeper!,'synthetic-gateway');
 const revision='22222222-2222-4222-8222-222222222222';
 const record=(over:any)=>({...initialCredentialRecord(),phase:'applied',activeRevision:revision,...over});
 const grants=[{agent:'bookkeeper',purposes:['clipping']}];
 const compose=()=>parse(readFileSync(config.composeFile,'utf8')).services['lares-bookkeeper'];
 // No base binding at all: refuse rather than invent one.
 let l=lifecycle(); l.setCredentialState(async()=>record({grants}));
 await expect(l.create('bookkeeper',chief)).rejects.toThrow('runtime binding');
 await pool.query('UPDATE agent_definitions SET definition=$1::jsonb WHERE name=$2',[JSON.stringify(chief),'bookkeeper']);
 config.bindings={bookkeeper:{role:'chief-of-staff',environment:{},mounts:[],secrets:{}}};
 // Not granted: no key.
 l=lifecycle(); l.setCredentialState(async()=>record({})); await l.create('bookkeeper',chief);
 expect(compose().environment.NOTION_TOKEN_FILE).toBeUndefined();
 // Granted with a revision: the managed active file is mounted.
 l=lifecycle(); l.setCredentialState(async()=>record({grants,effectiveRevision:revision}));
 await l.reconcile('bookkeeper',chief);
 expect(compose().environment.NOTION_TOKEN_FILE).toBe('/run/secrets/notion-token'); expect(compose().labels['lares.notion-revision']).toBe(revision);
 // The effective view wins during a change: effectiveGrants empty means no key even though grants say yes.
 l=lifecycle(); l.setCredentialState(async()=>record({grants,effectiveGrants:[],activationIntent:{previousRevision:revision,targetRevision:revision,inventoryRevision:'a'.repeat(64),prepared:true,finishing:false,grantChange:{agent:'bookkeeper',purpose:'clipping',to:false},grantsBefore:grants,grantsAfter:[]}}));
 await l.reconcile('bookkeeper',chief); expect(compose().environment.NOTION_TOKEN_FILE).toBeUndefined();
 // Granted but no key revision (disconnected): nothing to mount.
 l=lifecycle(); l.setCredentialState(async()=>record({grants,phase:'disconnected',activeRevision:null,effectiveRevision:null}));
 await l.reconcile('bookkeeper',chief); expect(compose().environment.NOTION_TOKEN_FILE).toBeUndefined();
 // Installation configuration wins and is never removed by a missing grant.
 config.bindings={bookkeeper:{role:'chief-of-staff',environment:{},mounts:[],secrets:{NOTION_TOKEN_FILE:notion}}};
 l=lifecycle(); l.setCredentialState(async()=>record({effectiveRevision:revision}));
 await l.reconcile('bookkeeper',chief); expect(compose().environment.NOTION_TOKEN_FILE).toBe('/run/secrets/notion-token');
 expect(l.installationBindsNotion('bookkeeper')).toBe(true);
});
beforeAll(async()=>{
 pg=await new PostgreSqlContainer('pgvector/pgvector:pg16').start();pool=quiet(new Pool({connectionString:pg.getConnectionUri()}));
 for(const name of ['001_baseline.sql','008_connected_accounts.sql','012_connected_account_credentials.sql']) await pool.query(readFileSync(join(repo,'services/box/sql',name),'utf8'));
 await pool.query('CREATE DATABASE empty_workflow');
 const template=quiet(new Pool({connectionString:pg.getConnectionUri().replace(/\/[^/]+$/,'/empty_workflow')}));
 await template.query('CREATE SCHEMA workflow; CREATE TABLE workflow.memory(value text)');await template.end();
 await pool.query("CREATE TABLE standing_facts(value text); INSERT INTO standing_facts VALUES ('shared-owner')");
});
afterAll(async()=>{await pool?.end();await pg?.stop();if(root)rmSync(root,{recursive:true,force:true});});
beforeEach(async()=>{
 const rows=(await pool.query("SELECT datname FROM pg_database WHERE datname LIKE 'lares_%'")).rows;
 for(const row of rows)await pool.query(`DROP DATABASE "${row.datname}" WITH (FORCE)`);
 await pool.query('TRUNCATE agent_resources,agent_avatars,agent_definitions,agent_doors,agent_door_connections,agent_door_claim_audit,ratchet,ratchet_audit,agent_registry,proactivity_settings,heartbeat,sessions,confirmations,reminders,trigger_schedules,workflow_jobs,digest_requests,digest_skips');
 await pool.query("INSERT INTO settings(key,value,updated_by) VALUES('models.alias_prefix','\"lares\"','test') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
 if(root)rmSync(root,{recursive:true,force:true});root=mkdtempSync(join(tmpdir(),'lares-owned-'));
 for(const d of ['agents','secrets','egress'])mkdirSync(join(root,d));
 config={network:'test_default',subnet:'172.18.0.0/24',reservedAddresses:['172.18.0.22'],composeFile:join(root,'compose.lares-agents.yaml'),egressDir:join(root,'egress'),imageByRole:{creative:image,'chief-of-staff':image},proxyContainer:'lares-egress-proxy',squidImage:image,firewallImage:image,adminDb:{host:'db',port:5432,user:pg.getUsername(),database:pg.getDatabase(),passwordFile:'/secret'},workflowTemplate:'empty_workflow',workflowOwner:pg.getUsername(),runtime:{schedulesLive:false,databaseUrl:'postgres://user@db/domain',workflowServer:'postgres://user@db/',gatewayUrl:'https://brain.example.com',proxyUrl:'http://proxy:8888',passwordFile:join(root,'secrets','db'),gatewayKeys:{bookkeeper:join(root,'secrets','key')}},egress:{endpoints:{},legacyConsumers:[{name:'sync',address:'172.18.0.23',hosts:['api.notion.com']}],internalNetworks:['172.18.0.0/24'],directDestinations:[],infrastructureHosts:['brain.example.com']},installationPrepared:true};
 await pool.query("INSERT INTO agent_definitions(name,hash,definition,valid_at,status) VALUES($1,'test',$2::jsonb,now(),'valid')",['bookkeeper',JSON.stringify(definition)]);
 events=[];started=[];fail=undefined;
});
it('clones an owned workflow database, seals before starting and reserves the whole network inventory',async()=>{
 const l=lifecycle();await l.create('bookkeeper',definition);
 const row=await l.storage.row('bookkeeper');expect(row.address).toBe('172.18.0.24');expect(row.workflow_database).toMatch(/^lares_[a-f0-9]{32}$/);
 const own=quiet(new Pool({connectionString:pg.getConnectionUri().replace(/\/[^/]+$/,`/${row.workflow_database}`)}));
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
 const retained=quiet(new Pool({connectionString:pg.getConnectionUri().replace(/\/[^/]+$/,`/${row.workflow_database}`)}));expect((await retained.query('SELECT * FROM workflow.memory')).rows).toEqual([{value:'owned'}]);await retained.end();
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
it('refuses to publish agents until models.alias_prefix is set, and hands agents the prefix',async()=>{
 const l=lifecycle();
 await pool.query("DELETE FROM settings WHERE key='models.alias_prefix'");
 await expect(l.create('bookkeeper',definition)).rejects.toThrow('Set models.alias_prefix');
 await pool.query("INSERT INTO settings(key,value,updated_by) VALUES('models.alias_prefix','\"home\"','test')");
 await l.create('bookkeeper',definition);
 expect(parse(readFileSync(config.composeFile,'utf8')).services['lares-bookkeeper'].environment.LARES_MODEL_PREFIX).toBe('home');
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
const lifecycleWith=(d:DockerBoundary)=>new AgentLifecycle(pool,pool,config,{agentsDir:join(root,'agents'),secretsDir:join(root,'secrets')},d,()=>{},()=>{});
it('treats a health wait that runs out as a running agent, not an error',async()=>{
 const slow:DockerBoundary={...docker,start:async n=>{events.push('start:'+n);throw new AgentNotHealthyError();}};
 const l=lifecycleWith(slow);
 await l.create('bookkeeper',definition);
 const row=await l.storage.row('bookkeeper');
 await pool.query(`INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,principal)VALUES('bookkeeper','slack',$1,$1,'owner@example.test','U_OWNER')`,[row.ownership_token]);
 events=[];
 await expect(l.reconcile('bookkeeper',definition)).resolves.toEqual({pending:false,reason:null,running:true,healthy:false});
 expect(await l.status('bookkeeper')).toEqual({pending:false,reason:null});
 const after=await l.storage.row('bookkeeper');
 expect(after.applied_definition).toEqual(definition);
 expect((await pool.query("SELECT applied_revision,revision FROM agent_door_connections WHERE agent='bookkeeper'")).rows[0]).toMatchObject({applied_revision:row.ownership_token});
});
it('records applied only after stop and the egress seal succeeded, and before start',async()=>{
 const l=lifecycle();await l.create('bookkeeper',definition);
 const changed={...definition,description:'Changed text'};
 for(const step of ['stop:bookkeeper','apply-nft']){
  fail=step;events=[];
  await expect(l.reconcile('bookkeeper',changed)).rejects.toThrow('injected');
  expect(events).not.toContain('start:bookkeeper');
  expect((await l.storage.row('bookkeeper')).applied_definition).toEqual(definition);
  expect(await l.status('bookkeeper')).toMatchObject({pending:true,reason:'Runtime reconciliation in progress'});
 }
 fail=undefined;
 const seen:any[]=[];
 const probe:DockerBoundary={...docker,start:async n=>{seen.push((await l.storage.row('bookkeeper')).applied_definition);events.push('start:'+n);}};
 await lifecycleWith(probe).reconcile('bookkeeper',changed);
 expect(seen).toEqual([changed]);
});
it('keeps reading live status: running but not answering, then answering, with no new reconcile',async()=>{
 let answering=false;
 const live:DockerBoundary={...docker,start:async n=>{events.push('start:'+n);throw new AgentNotHealthyError();},inspect:async()=>({id:'abc',running:true,incarnation:null,notionRevision:null,image,mounts:[],addresses:[]}),healthy:async()=>answering};
 const l=lifecycleWith(live);await l.create('bookkeeper',definition);events=[];
 expect(await l.liveStatus('bookkeeper')).toEqual({pending:false,reason:null,running:true,healthy:false});
 answering=true;
 expect(await l.liveStatus('bookkeeper')).toEqual({pending:false,reason:null,running:true,healthy:true});
 expect(events).toEqual([]);
});
it('reports stopped when the container is down and null when Docker cannot be asked; never throws',async()=>{
 const l=lifecycle();await l.create('bookkeeper',definition);
 const stopped:DockerBoundary={...docker,inspect:async()=>({id:'abc',running:false,incarnation:null,notionRevision:null,image,mounts:[],addresses:[]}),healthy:async()=>{throw new Error('must not be asked');}};
 expect(await lifecycleWith(stopped).liveStatus('bookkeeper')).toEqual({pending:false,reason:null,running:false,healthy:null});
 const broken:DockerBoundary={...docker,inspect:async()=>{throw new Error('docker unreachable');},inventory:async()=>{throw new Error('docker unreachable');}};
 expect(await lifecycleWith(broken).liveStatus('bookkeeper')).toEqual({pending:false,reason:null,running:null,healthy:null});
 const absent:DockerBoundary={...docker,inspect:async()=>{throw new NoOwnedContainerError();}};
 const ambiguous:DockerBoundary={...docker,inspect:async()=>{throw new Error('Owned runtime inventory unavailable');}};
 expect(await lifecycleWith(ambiguous).liveStatus('bookkeeper')).toMatchObject({running:null,healthy:null});
 expect(await lifecycleWith(absent).liveStatus('bookkeeper')).toEqual({pending:false,reason:null,running:false,healthy:null});
 expect(await lifecycle().liveStatus('bookkeeper')).toEqual({pending:false,reason:null,running:null,healthy:null});
});
it('leaves a failed compose start applied (the console shows it as stopped) and keeps the error',async()=>{
 const l=lifecycle();fail='start:bookkeeper';await expect(l.create('bookkeeper',definition)).rejects.toThrow('injected');
 expect(events).toContain('apply-nft');expect(events.at(-1)).toBe('start:bookkeeper');
 expect(await l.status('bookkeeper')).toEqual({pending:false,reason:null});
 fail=undefined;events=[];await l.reconcile('bookkeeper',definition);
 expect(events.at(-1)).toBe('start:bookkeeper');expect(await l.status('bookkeeper')).toEqual({pending:false,reason:null});
});
it('opens the https host of an outside tool and mounts its token file; plain-http service names add nothing',async()=>{
 const l=lifecycle();await l.create('bookkeeper',definition);
 const outside=(url:string,token:boolean)=>({...definition,grants:[{capability:'outside',scope:'write-with-confirm'}],autonomy:{outside:'gated'},outsideTools:[{name:'registry',url,description:'Looks up companies.',token,tools:{allow:['lookup'],read:['lookup']}}]});
 await l.saved('bookkeeper',outside('https://tools.example.org/mcp',true));
 expect(readFileSync(join(config.egressDir,'squid.conf'),'utf8')).toContain('tools.example.org');
 await l.reconcile('bookkeeper',outside('https://tools.example.org/mcp',true));
 const s=parse(readFileSync(config.composeFile,'utf8'));
 expect(s.services['lares-bookkeeper'].secrets).toContainEqual({source:'bookkeeper-outside-registry-token',target:'outside-registry'});
 expect(s.secrets['bookkeeper-outside-registry-token'].file).toBe(join(root,'secrets','bookkeeper-outside-registry-token'));
 await l.saved('bookkeeper',outside('http://registry-svc:3000/mcp',false));
 expect(readFileSync(join(config.egressDir,'squid.conf'),'utf8')).not.toContain('registry-svc');
});
it('provisions outside token files before stopping the agent, and a changed token list needs a restart',async()=>{
 const provisioned:string[]=[];
 const l=new AgentLifecycle(pool,pool,config,{agentsDir:join(root,'agents'),secretsDir:join(root,'secrets')},docker,(p:string)=>{provisioned.push(p);},()=>{});
 await l.create('bookkeeper',definition);await l.reconcile('bookkeeper',definition);
 const withToken={...definition,grants:[{capability:'outside',scope:'write-with-confirm'}],autonomy:{outside:'gated'},outsideTools:[{name:'registry',url:'https://tools.example.org/mcp',description:'Looks up companies.',token:true,tools:{allow:['lookup'],read:['lookup']}}]};
 expect((await l.saved('bookkeeper',withToken)).pending).toBe(true);
 provisioned.length=0;await l.reconcile('bookkeeper',withToken);
 expect(provisioned).toContain(join(root,'secrets','bookkeeper-outside-registry-token'));
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
 expect((await runAction('definition.get',{name:'bookkeeper'},ctx) as any).runtime).toMatchObject(pending);
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
 expect(events).toEqual([]);expect(await l.status('bookkeeper')).toMatchObject({pending:true});
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

// The email door follows the register's id: the keeper's own email row holds the same value as
// oauth_tokens and is looked up against the installation's configured principal, so a
// configuration that still names an old spelling is refused. Neutral fixture names throughout.
it('accepts the email door once the configured principal is the register id, and refuses another spelling',async()=>{
 try{
  const l=lifecycle();await l.create('bookkeeper',definition);
  const row=await l.storage.row('bookkeeper');
  const secret=join(root,'secrets','google');writeFileSync(secret,'fixture',{mode:0o600});
  const google=(principal:string)=>({principal,tokenKeyFile:secret,clients:{tenant:{clientIdFile:secret,clientSecretFile:secret}}});
  const withMail={...definition,role:'chief-of-staff',doors:[{kind:'email',enabled:true}]};
  await pool.query("INSERT INTO users(id,display_name) VALUES('fixture-owner','Fixture Owner')");
  await pool.query("INSERT INTO user_aliases(system,alias,user_id) VALUES('google','U_fixture','fixture-owner')");
  await pool.query("INSERT INTO oauth_tokens(principal,provider,org_id,email_address,refresh_token_enc) VALUES('fixture-owner','google','tenant','selected@example.test','not-a-token')");
  await pool.query(`INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,principal,org,mailbox,applied_connection)
    VALUES('bookkeeper','email',$1::uuid,$1::uuid,'owner@example.test','fixture-owner','tenant','selected@example.test',
      jsonb_build_object('kind','email','principal','fixture-owner','revision',$1::text,'owner_email','owner@example.test','org','tenant','mailbox','selected@example.test'))`,[row.ownership_token]);
  // The configuration names another spelling -> refused.
  config.runtime.google=google('U_fixture');
  await expect(lifecycle().prepare('bookkeeper',withMail,false)).rejects.toThrow('Configure and select a Google mailbox before enabling email');
  // The configuration names the register id -> accepted, and the token is found under it.
  config.runtime.google=google('fixture-owner');
  await expect(lifecycle().prepare('bookkeeper',withMail,false)).resolves.toBeUndefined();
  await pool.query(`INSERT INTO connected_accounts(id,owner_member_id,connector_id,provider_issuer,provider_subject,provider_label,status)
    VALUES('fixture-account','fixture-owner','google','https://accounts.google.com','fixture-subject','Mailbox','revoked')`);
  await pool.query(`INSERT INTO connected_account_credentials(account_id,owner_member_id,connector_id,account_generation,oauth_token_id)
    SELECT 'fixture-account','fixture-owner','google',0,id FROM oauth_tokens WHERE principal='fixture-owner'`);
  await expect(lifecycle().prepare('bookkeeper',withMail,false)).rejects.toThrow('Selected Google mailbox is no longer connected');
  await pool.query("DELETE FROM connected_accounts WHERE id='fixture-account'");

 }finally{await pool.query("DELETE FROM connected_accounts WHERE id='fixture-account'");await pool.query('DELETE FROM agent_door_connections');await pool.query('DELETE FROM oauth_tokens');await pool.query('DELETE FROM user_aliases');await pool.query('DELETE FROM users');}
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
it('ignores an unsupported egress endpoint from an older config, with a log line',async()=>{
 const {lifecycleSchema}=await import('../lib/lifecycle-config.js');
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  const parsed=lifecycleSchema.parse({...config,egress:{...config.egress,endpoints:{...config.egress.endpoints,RETIRED_URL:'https://old.example.org'}}});
  expect(parsed.egress.endpoints).toEqual(config.egress.endpoints);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('RETIRED_URL'));
 }finally{warn.mockRestore();}
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
// : three agents on a server whose stored definitions still spell retired capability names.
async function oldStyleServer(){
 const names=['bookkeeper','ledger','scribe'];
 config.runtime.gatewayKeys={bookkeeper:join(root,'secrets','key'),ledger:join(root,'secrets','key-ledger'),scribe:join(root,'secrets','key-scribe')};
 const make=(name:string,grants:any[])=>({...definition,name,grants});
 const l=lifecycle();
 for(const n of names){
  await pool.query("INSERT INTO agent_definitions(name,hash,definition,valid_at,status) VALUES($1,'test',$2::jsonb,now(),'valid') ON CONFLICT(name) DO NOTHING",[n,JSON.stringify(make(n,[]))]);
  await l.create(n,make(n,[]));
 }
 for(const [n,cap] of [['bookkeeper','brain'],['ledger','atlas'],['scribe','memory']])
  await pool.query("UPDATE agent_definitions SET definition=$2::jsonb WHERE name=$1",[n,JSON.stringify(make(n,[{capability:cap,scope:'read'}]))]);
 events=[];
 return {l,make};
}
it(': converting one of three old-style agents succeeds without stopping anyone and opens nothing for the old names',async()=>{
 const {l,make}=await oldStyleServer();const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  const converted=make('bookkeeper',[{capability:'vault',scope:'read',areas:['shared']}]);
  await l.saved('bookkeeper',converted);
  expect(events).toEqual(['parse-squid','parse-nft','apply-nft','reload-squid']);
  expect(warn.mock.calls.map(c=>String(c[0]))).toEqual([expect.stringContaining('ledger still grants atlas'),expect.stringContaining('scribe still grants memory')]);
  const squid=readFileSync(join(config.egressDir,'squid.conf'),'utf8');
  for(const n of ['bookkeeper','ledger','scribe'])expect(squid).toContain(`src_${n}`);
  for(const n of ['ledger','scribe'])expect(squid).toContain(`acl dst_${n} dstdomain brain.example.com\n`); // the infrastructure host only; nothing from the old names
 }finally{warn.mockRestore();}
});
it(': an agent that grants a retired name itself is refused before anything is marked or stopped, on save and on apply',async()=>{
 const {l,make}=await oldStyleServer();const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  const before=await l.status('ledger');
  await expect(l.saved('ledger',make('ledger',[{capability:'atlas',scope:'read'}]))).rejects.toThrow('Agent ledger grants atlas');
  await expect(l.reconcile('ledger',make('ledger',[{capability:'atlas',scope:'read'}]))).rejects.toThrow('Agent ledger grants atlas');
  await expect(l.prepare('ledger',make('ledger',[{capability:'atlas',scope:'read'}]),false)).rejects.toThrow('Agent ledger grants atlas');
  config.runtime.gatewayKeys.newcomer=join(root,'secrets','key-newcomer');
  await expect(l.prepare('newcomer',make('newcomer',[{capability:'memory',scope:'read'}]),true)).rejects.toThrow('Agent newcomer grants memory');
  expect(events).toEqual([]);expect(await l.status('ledger')).toEqual(before);
 }finally{warn.mockRestore();}
});
it(': a real reload failure after a good plan still stops the agent',async()=>{
 const {l,make}=await oldStyleServer();const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  const converted=make('bookkeeper',[{capability:'vault',scope:'read',areas:['shared']}]);
  fail='reload-squid';await expect(l.saved('bookkeeper',converted)).rejects.toThrow('injected');
  expect(events.at(-1)).toBe('stop:bookkeeper');expect((await l.status('bookkeeper')).pending).toBe(true);
 }finally{warn.mockRestore();}
});
it('skips a stored agent of the removed travel role with a message, and the other agents still publish',async()=>{
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  const old={...definition,name:'wanderer',role:'travel'};
  await pool.query("INSERT INTO agent_definitions(name,hash,definition,valid_at,status) VALUES('wanderer','test',$1::jsonb,now(),'valid')",[JSON.stringify(old)]);
  await pool.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,applied_definition,pending) VALUES('wanderer','172.18.0.30','legacy_travel','owned','22222222-2222-4222-8222-222222222222','22222222-2222-4222-8222-222222222222','ready',$1::jsonb,false)",[JSON.stringify(old)]);
  const l=lifecycle();await l.create('bookkeeper',definition);
  expect(warn.mock.calls.map(c=>String(c[0])).some(m=>m.includes('skipping agent wanderer')&&m.includes('no longer part of the engine'))).toBe(true);
  const doc=parse(readFileSync(config.composeFile,'utf8'));
  expect(doc.services['lares-bookkeeper']).toBeDefined();
  expect(doc.services['lares-wanderer']).toBeUndefined();
 }finally{warn.mockRestore();}
});
it('re-applies the last installed firewall at startup, unchanged, and a restart re-applies the same one',async()=>{
 const {readdirSync}=await import('node:fs');
 const firewall=vi.spyOn(docker,'firewall'),log=vi.spyOn(console,'log').mockImplementation(()=>{});
 try{
  const l=lifecycle();await l.create('bookkeeper',definition);
  await l.saved('bookkeeper',{...definition,grants:[{capability:'notion',scope:'read'}]});
  const installed=firewall.mock.calls.at(-1)![0];expect(firewall.mock.calls.at(-1)![1]).toBe(false);
  // A later seal that nft refused is never what startup applies.
  fail='apply-nft';await expect(l.saved('bookkeeper',definition)).rejects.toThrow('injected');fail=undefined;
  const files=readdirSync(config.egressDir).sort();firewall.mockClear();events=[];
  await lifecycle().resealAtStart();
  expect(events).toEqual(['parse-nft','apply-nft']);
  expect(firewall.mock.calls).toEqual([[installed,true],[installed,false]]);
  expect(readFileSync(join(config.egressDir,`${installed}.nft`),'utf8')).toContain('counter drop');
  expect(readdirSync(config.egressDir).sort()).toEqual(files);
  expect(log).toHaveBeenCalledWith('keeper: re-applied the installed outbound firewall at startup');
  // nft replaces its one table (add, delete, define), so a second start changes nothing.
  firewall.mockClear();await lifecycle().resealAtStart();
  expect(firewall.mock.calls).toEqual([[installed,true],[installed,false]]);
 }finally{firewall.mockRestore();log.mockRestore();}
});
it('changes nothing and says so in one line when no usable firewall is on record',async()=>{
 const {readdirSync}=await import('node:fs');
 const {generateEgress}=await import('../lib/egress.js');
 const error=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  await lifecycle().resealAtStart();
  expect(events).toEqual([]);expect(readdirSync(config.egressDir)).toEqual([]);
  expect(error).toHaveBeenCalledTimes(1);expect(String(error.mock.calls[0]![0])).toContain('no firewall is on record yet');
  // A record whose firewall seals no source is never applied: that would be an empty seal.
  const stage='00000000-0000-4000-8000-000000000000';
  writeFileSync(join(config.egressDir,'installed-stage'),`${stage}\n`);writeFileSync(join(config.egressDir,`${stage}.nft`),generateEgress([]).nft);
  error.mockClear();await lifecycle().resealAtStart();
  expect(events).toEqual([]);expect(error).toHaveBeenCalledTimes(1);expect(String(error.mock.calls[0]![0])).toContain('seals no agent');
  writeFileSync(join(config.egressDir,'installed-stage'),'../elsewhere\n');
  error.mockClear();await lifecycle().resealAtStart();
  expect(events).toEqual([]);expect(error).toHaveBeenCalledTimes(1);expect(String(error.mock.calls[0]![0])).toContain('does not name a stage');
 }finally{error.mockRestore();}
});
it('logs one line when the startup re-apply fails, never throws, and the next agent change seals afresh',async()=>{
 const error=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  await lifecycle().create('bookkeeper',definition);
  const record=readFileSync(join(config.egressDir,'installed-stage'),'utf8');
  const l=lifecycle();events=[];fail='apply-nft';
  await expect(l.resealAtStart()).resolves.toBeUndefined();
  expect(events).toEqual(['parse-nft','apply-nft']);expect(error).toHaveBeenCalledTimes(1);
  expect(String(error.mock.calls[0]![0])).toContain('could not re-apply the outbound firewall at startup (injected apply-nft)');
  expect(readFileSync(join(config.egressDir,'installed-stage'),'utf8')).toBe(record);
  fail=undefined;events=[];await l.saved('bookkeeper',definition);
  expect(events).toEqual(['parse-squid','parse-nft','apply-nft','reload-squid']);
  expect(readFileSync(join(config.egressDir,'installed-stage'),'utf8')).not.toBe(record);
 }finally{error.mockRestore();}
});
it('holds an agent change\'s seal until the startup re-apply is done, so an older firewall never replaces a newer one',async()=>{
 const log=vi.spyOn(console,'log').mockImplementation(()=>{});
 const firewall=vi.spyOn(docker,'firewall');
 try{
  await lifecycle().create('bookkeeper',definition);
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  firewall.mockImplementationOnce(async()=>{events.push('startup-check');await gate;});
  const l=lifecycle();events=[];
  const startup=l.resealAtStart(),change=l.saved('bookkeeper',definition);
  await new Promise(r=>setTimeout(r,300));
  expect(events).toEqual(['startup-check']);
  release();await startup;await change;
  expect(events).toEqual(['startup-check','apply-nft','parse-squid','parse-nft','apply-nft','reload-squid']);
 }finally{firewall.mockRestore();log.mockRestore();}
});

function personalGoogleFixture() {
 const tokenKeyFile=join(root,'secrets/personal-google-key');writeFileSync(tokenKeyFile,'fixture-key');
 const clients=Object.fromEntries(['acme','second'].map(org=>{
  const clientIdFile=join(root,`secrets/${org}-id`),clientSecretFile=join(root,`secrets/${org}-secret`);
  writeFileSync(clientIdFile,`${org}-id-value`);writeFileSync(clientSecretFile,`${org}-secret-value`);
  return [org,{clientIdFile,clientSecretFile}];
 }));
 config.runtime.google={tokenKeyFile,clients};
 return config.runtime.google;
}
const personalChief=()=>({...definition,role:'chief-of-staff',grants:[{capability:'gmail',scope:'read'}],autonomy:{}});
it('mounts personal clients without any email door, claim, legacy principal or OAuth token selection',async()=>{
 const google=personalGoogleFixture(),chief=personalChief(),provisioned:string[]=[];
 const l=new AgentLifecycle(pool,pool,config,{agentsDir:join(root,'agents'),secretsDir:join(root,'secrets')},docker,path=>{provisioned.push(path);},()=>{});
 await l.create('bookkeeper',chief);
 const doc=parse(readFileSync(config.composeFile,'utf8')),env=doc.services['lares-bookkeeper'].environment;
 expect(Object.keys(JSON.parse(env.LARES_PERSONAL_GOOGLE_CLIENTS))).toEqual(['acme','second']);
 expect(env.TOKEN_ENC_KEY_FILE).toBe('/run/secrets/google-token-key');
 expect(env.GOOGLE_PRINCIPAL_ID).toBeUndefined();expect(env.LARES_EMAIL_ORG).toBeUndefined();
 for(const file of [google.tokenKeyFile,...Object.values(google.clients).flatMap(c=>[c.clientIdFile,c.clientSecretFile])])expect(provisioned).toContain(file);
 expect(JSON.stringify(env)).not.toMatch(/value|personal-google-key/);
});
it('applies Gmail mount additions/removals only on explicit reconciliation and preserves other pending agents applied setup',async()=>{
 personalGoogleFixture();
 const base={...definition,role:'chief-of-staff',grants:[],autonomy:{}},chief=personalChief();
 const l=lifecycle();await l.create('bookkeeper',base);
 const current=()=>parse(readFileSync(config.composeFile,'utf8')).services['lares-bookkeeper'].environment.LARES_PERSONAL_GOOGLE_CLIENTS;
 expect(current()).toBeUndefined();
 await pool.query("UPDATE agent_definitions SET definition=$1 WHERE name='bookkeeper'",[JSON.stringify(chief)]);
 expect((await l.saved('bookkeeper',chief)).pending).toBe(true);
 const other={...definition,name:'other'};config.runtime.gatewayKeys.other=config.runtime.gatewayKeys.bookkeeper!;
 await pool.query("INSERT INTO agent_definitions(name,definition,hash,status) VALUES('other',$1,'fixture','valid')",[JSON.stringify(other)]);
 await l.create('other',other);expect(current()).toBeUndefined();
 await l.reconcile('bookkeeper',chief);expect(current()).toBeDefined();
 await pool.query("UPDATE agent_definitions SET definition=$1 WHERE name='bookkeeper'",[JSON.stringify(base)]);
 expect((await l.saved('bookkeeper',base)).pending).toBe(true);
 await l.reconcile('other',other);expect(current()).toBeDefined();
 await l.reconcile('bookkeeper',base);expect(current()).toBeUndefined();
});
it('preflights all personal files before a definition save without affecting unrelated agents',async()=>{
 const google=personalGoogleFixture(),l=lifecycle();
 rmSync(google.clients.acme!.clientSecretFile);
 await expect(l.create('bookkeeper',definition)).resolves.toMatchObject({healthy:true});
 const before=readFileSync(config.composeFile,'utf8');events=[];
 await expect(l.prepare('bookkeeper',personalChief(),false)).rejects.toThrow('Personal-read runtime files unavailable');
 expect(events).toEqual([]);expect(readFileSync(config.composeFile,'utf8')).toBe(before);
 const noGmail={...personalChief(),autonomy:{gmail:'never'}};
 await expect(l.prepare('bookkeeper',noGmail,false)).resolves.toBeUndefined();
});
it('credential preflight and rollback reconciliation preserve the applied personal client files',async()=>{
 const google=personalGoogleFixture(),chief=personalChief(),l=lifecycle();
 writeFileSync(config.runtime.passwordFile,'fixture-db');writeFileSync(config.runtime.gatewayKeys.bookkeeper!,'fixture-gateway');
 await l.create('bookkeeper',chief);
 const before=parse(readFileSync(config.composeFile,'utf8')).services['lares-bookkeeper'];
 // This is the same path used for managed credential rollback, using applied definitions.
 const state:any={...initialCredentialRecord(),effectiveRevision:null,activationIntent:{targetRevision:null}};
 l.setCredentialState(async()=>state);
 await l.credentialPreflight(['bookkeeper']);await l.reconcileCredential('bookkeeper',null);
 const after=parse(readFileSync(config.composeFile,'utf8')).services['lares-bookkeeper'];
 expect(after.environment.LARES_PERSONAL_GOOGLE_CLIENTS).toBe(before.environment.LARES_PERSONAL_GOOGLE_CLIENTS);
 expect(after.secrets).toEqual(before.secrets);
 for(const file of [google.tokenKeyFile,...Object.values(google.clients).flatMap(c=>[c.clientIdFile,c.clientSecretFile])]) {
  const content=readFileSync(file,'utf8');rmSync(file);events=[];
  await expect(l.credentialPreflight(['bookkeeper'])).rejects.toThrow();expect(events).toEqual([]);
  writeFileSync(file,content);
 }
});
it('preserves an all-legacy native email client and adds only canonical personal clients in mixed config',async()=>{
 const fixture=personalGoogleFixture(),legacy=fixture.clients.acme!,chief=personalChief(),l=lifecycle();
 config.runtime.google={principal:'legacy-member',tokenKeyFile:fixture.tokenKeyFile,clients:{old_tenant:legacy}};
 await l.create('bookkeeper',chief);
 const row=await l.storage.row('bookkeeper');
 const service=()=>parse(readFileSync(config.composeFile,'utf8')).services['lares-bookkeeper'];
 expect(service().environment.LARES_PERSONAL_GOOGLE_CLIENTS).toBeUndefined();
 try {
  await pool.query("INSERT INTO users(id,display_name) VALUES('legacy-member','Fixture')");
  await pool.query("INSERT INTO oauth_tokens(principal,provider,org_id,email_address,refresh_token_enc) VALUES('legacy-member','google','old_tenant','legacy@example.invalid','fixture')");
  await pool.query(`INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,principal,org,mailbox)
    VALUES('bookkeeper','email',$1,$1,'owner@example.invalid','legacy-member','old_tenant','legacy@example.invalid')`,[row.ownership_token]);
  const withEmail={...chief,doors:[{kind:'email',enabled:true}]};
  await l.reconcile('bookkeeper',withEmail);
  expect(service().environment.LARES_EMAIL_ORG).toBe('old_tenant');
  expect(service().environment.LARES_PERSONAL_GOOGLE_CLIENTS).toBeUndefined();
  config.runtime.google.clients.acme=fixture.clients.acme!;
  await l.reconcile('bookkeeper',withEmail);
  expect(service().environment.LARES_EMAIL_ORG).toBe('old_tenant');
  expect(Object.keys(JSON.parse(service().environment.LARES_PERSONAL_GOOGLE_CLIENTS))).toEqual(['acme']);
  expect(service().secrets.filter((s:any)=>s.target==='google-token-key')).toHaveLength(1);
 } finally {
  await pool.query("DELETE FROM agent_door_connections WHERE agent='bookkeeper'; DELETE FROM oauth_tokens WHERE principal='legacy-member'; DELETE FROM users WHERE id='legacy-member'");
 }
});

function personalMicrosoftFixture(tokenKeyFile=join(root,'secrets/personal-ms-key')) {
 const configFiles={tenantIdFile:join(root,'secrets/ms-tenant'),clientIdFile:join(root,'secrets/ms-id'),clientSecretFile:join(root,'secrets/ms-secret'),tokenKeyFile};
 for(const file of Object.values(configFiles))writeFileSync(file,'fixture');
 config.runtime.microsoft=configFiles;return configFiles;
}
it('reconciles explicit neutral grants, retains applied mounts during pending changes and preserves rollback sources',async()=>{
 const ms=personalMicrosoftFixture(),google=personalGoogleFixture();config.runtime.microsoft!.tokenKeyFile=google.tokenKeyFile;
 const base={...definition,role:'chief-of-staff',grants:[],autonomy:{}},chief={...base,grants:[{capability:'personal_mailbox',scope:'read'},{capability:'personal_calendar',scope:'read'}]};
 const l=lifecycle();writeFileSync(config.runtime.passwordFile,'fixture');writeFileSync(config.runtime.gatewayKeys.bookkeeper!,'fixture');
 await l.create('bookkeeper',base);
 const current=()=>parse(readFileSync(config.composeFile,'utf8')).services['lares-bookkeeper'];
 expect(current().environment.LARES_PERSONAL_MICROSOFT_CLIENT_ID_FILE).toBeUndefined();
 await pool.query("UPDATE agent_definitions SET definition=$1 WHERE name='bookkeeper'",[JSON.stringify(chief)]);
 expect((await l.saved('bookkeeper',chief)).pending).toBe(true);expect(current().environment.LARES_PERSONAL_MICROSOFT_CLIENT_ID_FILE).toBeUndefined();
 await l.reconcile('bookkeeper',chief);
 expect(current().environment.LARES_PERSONAL_MICROSOFT_CLIENT_ID_FILE).toBe('/run/secrets/personal-microsoft-client-id');
 expect(current().environment.LARES_PERSONAL_GOOGLE_CLIENTS).toBeDefined();
 const before=current();l.setCredentialState(async()=>({...initialCredentialRecord(),effectiveRevision:null,activationIntent:{targetRevision:null}}));
 await l.credentialPreflight(['bookkeeper']);await l.reconcileCredential('bookkeeper',null);
 expect(current().secrets).toEqual(before.secrets);
 for(const file of Object.values(ms).filter(file=>file!==ms.tokenKeyFile)) {
  const content=readFileSync(file);rmSync(file);events=[];
  await expect(l.credentialPreflight(['bookkeeper'])).rejects.toThrow();expect(events).toEqual([]);writeFileSync(file,content);
 }
 await pool.query("UPDATE agent_definitions SET definition=$1 WHERE name='bookkeeper'",[JSON.stringify(base)]);await l.saved('bookkeeper',base);await l.reconcile('bookkeeper',base);
 expect(current().environment.LARES_PERSONAL_MICROSOFT_CLIENT_ID_FILE).toBeUndefined();expect(current().environment.LARES_PERSONAL_GOOGLE_CLIENTS).toBeUndefined();
});
it('preflights Microsoft-only sources before save and ignores unavailable ungranted sources',async()=>{
 const ms=personalMicrosoftFixture(),l=lifecycle();await l.create('bookkeeper',definition);
 const chief={...definition,role:'chief-of-staff',grants:[{capability:'personal_calendar',scope:'read'}],autonomy:{}};
 await expect(l.prepare('bookkeeper',chief,false)).resolves.toBeUndefined();
 rmSync(ms.clientSecretFile);const before=readFileSync(config.composeFile,'utf8');events=[];
 await expect(l.prepare('bookkeeper',chief,false)).rejects.toThrow('Personal-read runtime files');expect(events).toEqual([]);expect(readFileSync(config.composeFile,'utf8')).toBe(before);
 await expect(l.prepare('bookkeeper',{...chief,autonomy:{personal_calendar:'never'}},false)).resolves.toBeUndefined();
});
