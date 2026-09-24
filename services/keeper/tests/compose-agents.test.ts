import { parse } from 'yaml';
import { expect,it,vi,afterEach } from 'vitest';
import { renderAgentsCompose,nextAddress,type AgentContainer } from '../lib/compose-agents.js';
const image='ghcr.io/example/runtime@sha256:'+'a'.repeat(64);
const opts={network:'test_default',imageByRole:{creative:image},agentsDir:'/srv/agents',secretsDir:'/srv/secrets'};
const agent:AgentContainer={name:'bookkeeper',role:'creative',address:'172.18.0.24',doors:[{kind:'slack',enabled:true},{kind:'telegram',enabled:false}],runtime:{databaseUrl:'postgres://agent@db/domain',workflowUrl:'postgres://agent@db/owned',gatewayUrl:'https://brain.example.com',proxyUrl:'http://proxy:8888',gatewayKeyFile:'/srv/secrets/bookkeeper-key',passwordFile:'/srv/secrets/db'}};
it('renders real YAML with own identity, two Slack secrets and stable read-only directory mount',()=>{
 const doc=parse(renderAgentsCompose([agent],opts)),s=doc.services['lares-bookkeeper'];
 expect(s.image).toBe(image);expect(s.read_only).toBe(true);expect(s.user).toBe('10001:10001');
 expect(s.environment).toMatchObject({LARES_AGENT_NAME:'bookkeeper',LARES_DEFINITION_DIR:'/definition',SLACK_SIGNING_SECRET_FILE:'/run/secrets/bookkeeper-slack-signing-secret',WORKFLOW_POSTGRES_URL:'postgres://agent@db/owned'});
 expect(s.volumes).toEqual(['/srv/agents/bookkeeper:/definition:ro']);
 expect(JSON.stringify(doc)).not.toContain('telegram-token');expect(s.networks.test_default.ipv4_address).toBe(agent.address);
 expect(Object.keys(doc.services)).toEqual(['lares-bookkeeper']);
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
});

it('does not render an adapter absent from its role and carries only explicit claimed principal fields',()=>{
 expect(()=>renderAgentsCompose([{...agent,doors:[{kind:'telegram',enabled:true}]}],opts)).toThrow('Role');
 const doc=parse(renderAgentsCompose([{...agent,claims:[{kind:'slack',principal:'U_SELECTED',revision:'11111111-1111-4111-8111-111111111111',owner:'owner@example.test'}]}],opts));
 expect(doc.services['lares-bookkeeper'].environment).toMatchObject({LARES_SLACK_PRINCIPAL:'U_SELECTED',SLACK_ALLOWED_USER_IDS:'U_SELECTED',AGENT_OWNER_USER_ID:'owner@example.test'});
 expect(doc.services['lares-bookkeeper'].environment.TELEGRAM_PRINCIPAL_ID).toBeUndefined();
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
