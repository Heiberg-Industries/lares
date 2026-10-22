import { parse } from 'yaml';
import { expect,it,vi,afterEach } from 'vitest';
import { renderAgentsCompose,nextAddress,type AgentContainer } from '../lib/compose-agents.js';
const image='ghcr.io/example/runtime@sha256:'+'a'.repeat(64);
const opts={network:'test_default',imageByRole:{creative:image},agentsDir:'/srv/agents',secretsDir:'/srv/secrets',modelPrefix:'lares'};
const agent:AgentContainer={name:'bookkeeper',role:'creative',address:'172.18.0.24',doors:[{kind:'slack',enabled:true},{kind:'telegram',enabled:false}],runtime:{databaseUrl:'postgres://agent@db/domain',workflowUrl:'postgres://agent@db/owned',gatewayUrl:'https://brain.example.com',proxyUrl:'http://proxy:8888',gatewayKeyFile:'/srv/secrets/bookkeeper-key',passwordFile:'/srv/secrets/db'}};
it('renders real YAML with own identity, two Slack secrets and stable read-only directory mount',()=>{
 const doc=parse(renderAgentsCompose([agent],opts)),s=doc.services['lares-bookkeeper'];
 expect(s.image).toBe(image);expect(s.read_only).toBe(true);expect(s.user).toBe('10001:10001');
 expect(s.environment).toMatchObject({LARES_AGENT_NAME:'bookkeeper',LARES_DEFINITION_DIR:'/definition',SLACK_SIGNING_SECRET_FILE:'/run/secrets/bookkeeper-slack-signing-secret',WORKFLOW_POSTGRES_URL:'postgres://agent@db/owned'});
 expect(s.volumes).toEqual(['/srv/agents/bookkeeper:/definition:ro']);
 expect(JSON.stringify(doc)).not.toContain('telegram-token');expect(s.networks.test_default.ipv4_address).toBe(agent.address);
 expect(Object.keys(doc.services)).toEqual(['lares-bookkeeper']);
});
it('mounts Keeper-prepared Vault sockets only for the chief runtime',()=>{
 const chief={...agent,role:'chief-of-staff' as const};
 const chiefOpts={...opts,imageByRole:{'chief-of-staff':image}};
 const without=parse(renderAgentsCompose([chief],chiefOpts)).services['lares-bookkeeper'];
 expect(without.volumes).toEqual(['/srv/agents/bookkeeper:/definition:ro']);
 const withVault=parse(renderAgentsCompose([chief],{...chiefOpts,vaultRuntimeDir:'/srv/lares/run/vault'})).services['lares-bookkeeper'];
 expect(withVault.volumes).toContainEqual({type:'bind',source:'/srv/lares/run/vault',target:'/run/lares-vault',read_only:true,bind:{create_host_path:false}});
 expect(JSON.stringify(withVault)).not.toContain('/srv/lares/vault');
});
it('hands every agent the installation model prefix and refuses a missing or invalid one',()=>{
 expect(parse(renderAgentsCompose([agent],{...opts,modelPrefix:'home'})).services['lares-bookkeeper'].environment.LARES_MODEL_PREFIX).toBe('home');
 for(const bad of ['','Home','a-b','installation',undefined as unknown as string])
  expect(()=>renderAgentsCompose([agent],{...opts,modelPrefix:bad})).toThrow('models.alias_prefix');
});
it('refuses short digest, duplicate addresses and password URLs',()=>{
 expect(()=>renderAgentsCompose([agent],{...opts,imageByRole:{creative:'x@sha256:abc'}})).toThrow();
 expect(()=>renderAgentsCompose([agent,{...agent,name:'second'}],opts)).toThrow();
 expect(()=>renderAgentsCompose([{...agent,runtime:{...agent.runtime,workflowUrl:'postgres://u:secret@db/owned'}}],opts)).toThrow();
});
it('uses complete supplied reservations, excludes gateway/broadcast and refuses exhaustion',()=>{
 expect(nextAddress(['172.18.0.24','172.18.0.25','172.18.0.26'],'172.18.0.0/16')).toBe('172.18.0.27');
 expect(nextAddress(['172.18.0.1','172.18.0.2','172.18.0.3'],'172.18.0.0/29')).toBe('172.18.0.4');
});
it('rejects exhausted and malformed networks',()=>{
 expect(()=>nextAddress(['172.18.0.2'],'172.18.0.0/30')).toThrow('No free');
 expect(()=>nextAddress([],'172.18.0.4/16')).toThrow();
});

it('passes the actual Docker Compose config parser without contacting or changing containers',async()=>{
 const {mkdtempSync,writeFileSync,mkdirSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'lares-compose-parser-'));
 try {
  mkdirSync(join(dir,'bookkeeper'));writeFileSync(join(dir,'key'),'test-only');writeFileSync(join(dir,'db'),'test-only');
  const a={...agent,doors:[],runtime:{...agent.runtime,gatewayKeyFile:join(dir,'key'),passwordFile:join(dir,'db')}};
  const file=join(dir,'compose.yaml');writeFileSync(file,renderAgentsCompose([a],{...opts,agentsDir:dir,secretsDir:dir}));
  const doc=JSON.parse(execFileSync('docker',['compose','--project-name','task14-parser','-f',file,'config','--format','json'],{encoding:'utf8',timeout:15000}));
  expect(doc.services['lares-bookkeeper'].read_only).toBe(true);expect(doc.services['lares-bookkeeper'].user).toBe('10001:10001');
 } finally {rmSync(dir,{recursive:true,force:true});}
// The docker call may take up to 15 s on a cold CI runner; the default 5 s test limit cut it off.
},20000);

it('does not render an adapter absent from its role and carries only explicit claimed principal fields',()=>{
 expect(()=>renderAgentsCompose([{...agent,doors:[{kind:'telegram',enabled:true}]}],opts)).toThrow('Role');
 const doc=parse(renderAgentsCompose([{...agent,claims:[{kind:'slack',principal:'U_SELECTED',revision:'11111111-1111-4111-8111-111111111111',owner:'owner@example.test'}]}],opts));
 expect(doc.services['lares-bookkeeper'].environment).toMatchObject({LARES_SLACK_PRINCIPAL:'U_SELECTED',SLACK_ALLOWED_USER_IDS:'U_SELECTED',AGENT_OWNER_USER_ID:'owner@example.test'});
 expect(doc.services['lares-bookkeeper'].environment.TELEGRAM_PRINCIPAL_ID).toBeUndefined();
});
it('a telegram claim sets only the principal field, no legacy admin variable',()=>{
 const doc=parse(renderAgentsCompose([{...agent,role:'chief-of-staff',doors:[{kind:'telegram',enabled:true}],claims:[{kind:'telegram',principal:'12345',revision:'11111111-1111-4111-8111-111111111111',owner:'owner@example.test'}]}],{...opts,imageByRole:{'chief-of-staff':image}}));
 const e=doc.services['lares-bookkeeper'].environment;
 expect(e.TELEGRAM_PRINCIPAL_ID).toBe('12345');
});
it('mounts only explicit selected Google client files and identity without a synthetic email token',()=>{
 const email={principal:'explicit-owner',org:'tenant',mailbox:'selected@example.test',revision:'11111111-1111-4111-8111-111111111111',owner:'owner@example.test',tokenKeyFile:'/srv/secrets/encryption',clientIdFile:'/srv/secrets/tenant-id',clientSecretFile:'/srv/secrets/tenant-secret'};
 const doc=parse(renderAgentsCompose([{...agent,role:'chief-of-staff',doors:[{kind:'email',enabled:true}],email}],{...opts,imageByRole:{'chief-of-staff':image}}));
 const e=doc.services['lares-bookkeeper'].environment;
 expect(e).toMatchObject({GOOGLE_PRINCIPAL_ID:'explicit-owner',LARES_EMAIL_MAILBOX:'selected@example.test',LARES_EMAIL_ORG:'tenant',GMAIL_PRIMARY_EMAIL:'selected@example.test',CALENDAR_PRIMARY_EMAIL:'selected@example.test',EGRESS_PROXY_URL:'http://proxy:8888'});
 expect(doc.secrets['bookkeeper-google-client-secret'].file).toBe('/srv/secrets/tenant-secret');
 expect(JSON.stringify(doc)).not.toContain('bookkeeper-email-token');expect(e.SLACK_ALLOWED_USER_IDS).toBeUndefined();
});

// Exercise real consumer routing against a disposable loopback CONNECT receiver.
// The receiver refuses tunnels: no traffic can reach a provider.
afterEach(() => vi.unstubAllEnvs());
it('routes Slack, Telegram and generic proxy fetch through the configured nondefault proxy', async () => {
 const {createServer}=await import('node:http');
 const {createRequire}=await import('node:module');
 const {resolve}=await import('node:path');
 const require=createRequire(import.meta.url);
 const undici=require(require.resolve('undici',{paths:[resolve('../../packages/agent-kit')]}));
 const original=undici.getGlobalDispatcher();
 const requests:string[]=[];
 const server=createServer();
 server.on('connect',(request,socket)=>{requests.push(request.url!);socket.end('HTTP/1.1 502 Test tunnel refused\r\nConnection: close\r\n\r\n');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {
  const proxyUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const env=parse(renderAgentsCompose([{...agent,runtime:{...agent.runtime,proxyUrl}}],opts)).services['lares-bookkeeper'].environment;
  for(const key of ['SLACK_PROXY_URL','TELEGRAM_PROXY_URL','EGRESS_PROXY_URL'])vi.stubEnv(key,env[key]);
  const {installSlackProxyDispatcher}=await import('@lares/agent-kit/slack-dispatcher');
  const {createTelegramFetch,createProxyFetch}=await import('@lares/agent-kit/telegram-fetch');
  expect(installSlackProxyDispatcher().proxyUrl).toBe(proxyUrl);
  await expect(undici.fetch('https://slack.com/api/test',{signal:AbortSignal.timeout(2000)})).rejects.toThrow();
  await expect(createTelegramFetch()('https://api.telegram.org/test',{signal:AbortSignal.timeout(2000)})).rejects.toThrow();
  await expect(createProxyFetch()('https://example.test/test',{signal:AbortSignal.timeout(2000)})).rejects.toThrow();
  expect(requests).toEqual(['slack.com:443','api.telegram.org:443','example.test:443']);
  expect(env.EGRESS_PROXY_URL).toBe(proxyUrl);
 }finally{
  undici.setGlobalDispatcher(original);
  await new Promise<void>((r,j)=>server.close(error=>error?j(error):r()));
 }
});

it('mounts one token file per outside tool that asks for one, at a target named after the tool',()=>{
 const doc=parse(renderAgentsCompose([{...agent,outsideTokens:['registry','crm-lookup']}],opts)),s=doc.services['lares-bookkeeper'];
 expect(s.secrets).toContainEqual({source:'bookkeeper-outside-registry-token',target:'outside-registry'});
 expect(s.secrets).toContainEqual({source:'bookkeeper-outside-crm-lookup-token',target:'outside-crm-lookup'});
 expect(doc.secrets['bookkeeper-outside-registry-token']).toEqual({file:'/srv/secrets/bookkeeper-outside-registry-token'});
 expect(JSON.stringify(parse(renderAgentsCompose([agent],opts)))).not.toContain('outside');
 expect(()=>renderAgentsCompose([{...agent,outsideTokens:['Bad/../name']}],opts)).toThrow();
});
it('passes the owner time zone from the binding into the agent container',()=>{
 const bound={...agent,bindings:{role:'creative' as const,ownerId:'owner-1',environment:{OWNER_HOME_TZ:'Europe/Berlin'},mounts:[],secrets:{}}};
 expect(parse(renderAgentsCompose([bound],opts)).services['lares-bookkeeper'].environment.OWNER_HOME_TZ).toBe('Europe/Berlin');
 expect(parse(renderAgentsCompose([agent],opts)).services['lares-bookkeeper'].environment.OWNER_HOME_TZ).toBeUndefined();
});
it('gives a managed agent with no claim the installation administrator as console approver; a claim wins',()=>{
 const inc='22222222-2222-4222-8222-222222222222',o={...opts,consoleAdministrator:'admin@example.test'};
 const none=parse(renderAgentsCompose([{...agent,incarnation:inc}],o)).services['lares-bookkeeper'].environment;
 expect(none.LARES_CONSOLE_PRINCIPAL).toBe('admin@example.test');
 const claimed=parse(renderAgentsCompose([{...agent,incarnation:inc,claims:[{kind:'slack',principal:'U_SELECTED',revision:'11111111-1111-4111-8111-111111111111',owner:'owner@example.test'}],consoleOwner:'owner@example.test'}],o)).services['lares-bookkeeper'].environment;
 expect(claimed.LARES_CONSOLE_PRINCIPAL).toBe('owner@example.test');
 expect(parse(renderAgentsCompose([{...agent,incarnation:inc}],opts)).services['lares-bookkeeper'].environment.LARES_CONSOLE_PRINCIPAL).toBeUndefined();
});
it('uses the one computed console owner whatever order the claims arrive in',()=>{
 const inc='22222222-2222-4222-8222-222222222222',o={...opts,consoleAdministrator:'admin@example.test'};
 const slack={kind:'slack' as const,principal:'U_A',revision:'11111111-1111-4111-8111-111111111111',owner:'second@example.test'};
 const telegram={kind:'telegram' as const,principal:'777',revision:'33333333-3333-4333-8333-333333333333',owner:'first@example.test'};
 const principal=(claims:(typeof slack|typeof telegram)[])=>parse(renderAgentsCompose([{...agent,incarnation:inc,claims,consoleOwner:'first@example.test'}],o)).services['lares-bookkeeper'].environment.LARES_CONSOLE_PRINCIPAL;
 expect(principal([slack,telegram])).toBe('first@example.test');
 expect(principal([telegram,slack])).toBe('first@example.test');
 expect(parse(renderAgentsCompose([{...agent,incarnation:inc}],o)).services['lares-bookkeeper'].environment.LARES_CONSOLE_PRINCIPAL).toBe('admin@example.test');
});
