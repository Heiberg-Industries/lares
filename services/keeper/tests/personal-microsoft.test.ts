import {mkdtempSync,writeFileSync,rmSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {parse} from 'yaml';
import {renderAgentsCompose,type AgentContainer} from '../lib/compose-agents.js';
import {personalMicrosoftSchema,personalMicrosoftEnabled,personalReadSecretFiles,verifyPersonalReadSecretSources} from '../lib/personal-microsoft.js';
import {personalGoogleEnabled} from '../lib/personal-google.js';
const microsoft={tenantIdFile:'/srv/secrets/tenant',clientIdFile:'/srv/secrets/id',clientSecretFile:'/srv/secrets/client-secret',tokenKeyFile:'/srv/secrets/key'};
const image='example/runtime@sha256:'+'a'.repeat(64);
const opts={network:'fixture_default',imageByRole:{'chief-of-staff':image,creative:image},agentsDir:'/srv/agents',secretsDir:'/srv/secrets',modelPrefix:'lares'};
const agent:AgentContainer={name:'helper',role:'chief-of-staff',address:'172.18.0.25',doors:[],personalMicrosoft:microsoft,runtime:{databaseUrl:'postgres://lares_app@db/domain',workflowUrl:'postgres://lares_workflow@db/workflow',gatewayUrl:'https://gateway.example',proxyUrl:'http://proxy:8888',gatewayKeyFile:'/srv/secrets/gateway',passwordFile:'/srv/secrets/db',workflowPasswordFile:'/srv/secrets/workflow-db'}};
it('Microsoft-only mounts are fixed, path-only and never overwrite the Google key variable',()=>{
 const doc=parse(renderAgentsCompose([agent],opts)),runtime=doc.services['lares-helper'];
 expect(runtime.environment.TOKEN_ENC_KEY_FILE).toBeUndefined();
 for(const name of ['TENANT_ID','CLIENT_ID','CLIENT_SECRET','TOKEN_KEY'])expect(runtime.environment[`LARES_PERSONAL_MICROSOFT_${name}_FILE`]).toBe(`/run/secrets/personal-microsoft-${name.toLowerCase().replaceAll('_','-')}`);
 expect(runtime.environment.EGRESS_PROXY_URL).toBe('http://proxy:8888');
 expect(JSON.stringify(runtime.environment)).not.toContain('/srv/');
 expect(personalReadSecretFiles(agent)).toEqual(Object.values(microsoft));
 expect(()=>renderAgentsCompose([{...agent,role:'creative'}],opts)).toThrow('Role has no personal');
});
it('requires a shared custody key source only when Google or native email is also mounted',()=>{
 const personalGoogle={tokenKeyFile:microsoft.tokenKeyFile,clients:{acme:{clientIdFile:'/srv/id',clientSecretFile:'/srv/secret'}}};
 const runtime=parse(renderAgentsCompose([{...agent,personalGoogle}],opts)).services['lares-helper'];
 expect(runtime.environment.TOKEN_ENC_KEY_FILE).toBe('/run/secrets/google-token-key');
 expect(runtime.environment.LARES_PERSONAL_MICROSOFT_TOKEN_KEY_FILE).toBe('/run/secrets/personal-microsoft-token-key');
 expect(personalReadSecretFiles({...agent,personalGoogle}).filter(p=>p===microsoft.tokenKeyFile)).toHaveLength(1);
 expect(()=>renderAgentsCompose([{...agent,personalGoogle:{...personalGoogle,tokenKeyFile:'/srv/other'}}],opts)).toThrow('custody key');
});
it('does not infer personal grants from legacy Gmail/calendar and respects none, never and role',()=>{
 const base:any={role:'chief-of-staff',grants:[],autonomy:{}};
 for(const capability of ['personal_mailbox','personal_calendar']) {
  const d={...base,grants:[{capability,scope:'read'}]};
  expect(personalMicrosoftEnabled(d)).toBe(true);expect(personalGoogleEnabled(d)).toBe(true);
  for(const invalid of [{...d,role:'creative'},{...d,grants:[{capability,scope:'none'}]},{...d,autonomy:{[capability]:'never'}}])expect(personalMicrosoftEnabled(invalid)).toBe(false);
 }
 for(const capability of ['gmail','calendar'])expect(personalMicrosoftEnabled({...base,grants:[{capability,scope:'read'}]})).toBe(false);
});
it('refuses unsafe and extra config fields',()=>{
 for(const config of [{...microsoft,clientIdFile:'relative'},{...microsoft,tokenKeyFile:'/srv/../key'},{...microsoft,tokenKeyFile:'/srv/$key'},{...microsoft,clientSecret:'private'}, {...microsoft,tenantIdFile:'/srv/file\n'}])expect(()=>personalMicrosoftSchema.parse(config)).toThrow();
});
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('preflights every file and refuses missing, empty, linked and directory sources',()=>{
 const dir=mkdtempSync(join(tmpdir(),'personal-ms-'));dirs.push(dir);
 const config=Object.fromEntries(Object.keys(microsoft).map((field,i)=>[field,join(dir,`file${i}`)])) as typeof microsoft;
 const files=personalReadSecretFiles({personalMicrosoft:config});for(const file of files)writeFileSync(file,'fixture');
 expect(()=>verifyPersonalReadSecretSources({personalMicrosoft:config})).not.toThrow();
 for(const file of files){rmSync(file);expect(()=>verifyPersonalReadSecretSources({personalMicrosoft:config})).toThrow();writeFileSync(file,'fixture');}
 writeFileSync(config.tokenKeyFile,'');expect(()=>verifyPersonalReadSecretSources({personalMicrosoft:config})).toThrow();writeFileSync(config.tokenKeyFile,'fixture');
 rmSync(config.clientIdFile);symlinkSync(config.tokenKeyFile,config.clientIdFile);expect(()=>verifyPersonalReadSecretSources({personalMicrosoft:config})).toThrow();
 rmSync(config.clientIdFile);linkSync(config.tokenKeyFile,config.clientIdFile);expect(()=>verifyPersonalReadSecretSources({personalMicrosoft:config})).toThrow();
 expect(()=>verifyPersonalReadSecretSources({personalMicrosoft:{...config,tenantIdFile:dir}})).toThrow();
});
