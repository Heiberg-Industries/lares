import { mkdtempSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderAgentsCompose, type AgentContainer } from '../lib/compose-agents.js';
import { personalGoogleSchema, personalGoogleConfig, personalGoogleEnabled, googleSecretFiles, verifyGoogleSecretSources } from '../lib/personal-google.js';
const image='example/runtime@sha256:'+'a'.repeat(64);
const opts={network:'fixture_default',imageByRole:{'chief-of-staff':image,creative:image},agentsDir:'/srv/agents',secretsDir:'/srv/secrets',modelPrefix:'lares'};
const google={tokenKeyFile:'/srv/secrets/key',clients:{second:{clientIdFile:'/srv/secrets/second-id',clientSecretFile:'/srv/secrets/second-secret'},acme:{clientIdFile:'/srv/secrets/acme-id',clientSecretFile:'/srv/secrets/acme-secret'}}};
const agent:AgentContainer={name:'helper',role:'chief-of-staff',address:'172.18.0.25',incarnation:'11111111-1111-4111-8111-111111111111',doors:[],personalGoogle:google,runtime:{databaseUrl:'postgres://lares_app@db/domain',workflowUrl:'postgres://lares_workflow@db/workflow',gatewayUrl:'https://gateway.example',proxyUrl:'http://proxy:8888',gatewayKeyFile:'/srv/secrets/gateway',passwordFile:'/srv/secrets/db',workflowPasswordFile:'/srv/secrets/workflow-db'}};
const document=()=>parse(renderAgentsCompose([agent],opts));
it('mounts exact root-configured files for all declared clients with bounded sorted path-only metadata',()=>{
 const doc=document(),runtime=doc.services['lares-helper'];
 expect(Object.keys(JSON.parse(runtime.environment.LARES_PERSONAL_GOOGLE_CLIENTS))).toEqual(['acme','second']);
 expect(JSON.parse(runtime.environment.LARES_PERSONAL_GOOGLE_CLIENTS)).toEqual(Object.fromEntries(['acme','second'].map(org=>[org,{clientIdFile:`/run/secrets/personal-google-${org}-id`,clientSecretFile:`/run/secrets/personal-google-${org}-secret`}])));
 expect(runtime.environment.TOKEN_ENC_KEY_FILE).toBe('/run/secrets/google-token-key');
 expect(runtime.environment.GOOGLE_PRINCIPAL_ID).toBeUndefined(); expect(runtime.environment.LARES_EMAIL_ORG).toBeUndefined();
 expect(JSON.stringify(runtime.environment)).not.toContain('/srv/');
 expect(runtime.secrets).toContainEqual({source:'helper-personal-google-acme-id',target:'personal-google-acme-id'});
 expect(doc.secrets['helper-personal-google-acme-id']).toEqual({file:'/srv/secrets/acme-id'});
 expect(new Set(runtime.secrets.map((s:any)=>s.target)).size).toBe(runtime.secrets.length);
});
it('deduplicates the shared token key with legacy email and rejects conflicting sources',()=>{
 const email={principal:'legacy',org:'acme',mailbox:'legacy@example.invalid',revision:'11111111-1111-4111-8111-111111111111',owner:'owner',tokenKeyFile:google.tokenKeyFile,clientIdFile:'/srv/secrets/acme-id',clientSecretFile:'/srv/secrets/acme-secret'};
 const doc=parse(renderAgentsCompose([{...agent,email}],opts)),runtime=doc.services['lares-helper'];
 expect(runtime.secrets.filter((s:any)=>s.target==='google-token-key')).toHaveLength(1);
 expect(runtime.environment.LARES_EMAIL_ORG).toBe('acme');
 expect(()=>renderAgentsCompose([{...agent,email:{...email,tokenKeyFile:'/srv/other'}}],opts)).toThrow('Conflicting Google token');
});
it('does not add mounts without trusted configuration and refuses another role',()=>{
 const runtime=parse(renderAgentsCompose([{...agent,personalGoogle:undefined}],opts)).services['lares-helper'];
 expect(runtime.environment.LARES_PERSONAL_GOOGLE_CLIENTS).toBeUndefined(); expect(runtime.environment.TOKEN_ENC_KEY_FILE).toBeUndefined();
 expect(()=>renderAgentsCompose([{...agent,role:'creative'}],opts)).toThrow('Role has no personal');
});
it.each(['ACME','ac_me','ac-me','../acme','a'.repeat(33)])('refuses noncanonical org config %s rather than renaming',org=>{
 expect(()=>personalGoogleSchema.parse({...google,clients:{[org]:google.clients.acme}})).toThrow();
});
it('bounds registry size, rejects unsafe host paths and keys outside the contract',()=>{
 for(const invalid of [{...google,clients:{}},{...google,clients:Object.fromEntries(Array.from({length:33},(_,i)=>[`org${i}`,google.clients.acme]))},
 {...google,tokenKeyFile:'/srv/../key'},{...google,tokenKeyFile:'/srv/$key'},{...google,token:'private-value'}]) expect(()=>personalGoogleSchema.parse(invalid)).toThrow();
});
it('gates file access by actual role, Gmail scope and never autonomy',()=>{
 const d:any={role:'chief-of-staff',grants:[{capability:'gmail',scope:'read'}],autonomy:{}};
 expect(personalGoogleEnabled(d)).toBe(true);
 for(const value of [{...d,role:'creative'},{...d,grants:[]},{...d,grants:[{capability:'gmail',scope:'none'}]},{...d,autonomy:{gmail:'never'}}]) expect(personalGoogleEnabled(value)).toBe(false);
});
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('preflights every mounted Google file and refuses missing, empty, symbolic and hard links',()=>{
 const dir=mkdtempSync(join(tmpdir(),'personal-google-'));dirs.push(dir);
 const config={tokenKeyFile:join(dir,'key'),clients:{acme:{clientIdFile:join(dir,'id'),clientSecretFile:join(dir,'secret')}}};
 const sources={personalGoogle:config};
 const files=googleSecretFiles(sources); expect(files).toHaveLength(3);
 for(const file of files)writeFileSync(file,'fixture');
 expect(()=>verifyGoogleSecretSources(sources)).not.toThrow();
 for(const file of files) { rmSync(file); expect(()=>verifyGoogleSecretSources(sources)).toThrow('Google runtime files');writeFileSync(file,'fixture'); }
 writeFileSync(config.tokenKeyFile,'');expect(()=>verifyGoogleSecretSources(sources)).toThrow();writeFileSync(config.tokenKeyFile,'fixture');
 rmSync(config.clients.acme.clientIdFile);symlinkSync(config.tokenKeyFile,config.clients.acme.clientIdFile);expect(()=>verifyGoogleSecretSources(sources)).toThrow();
 rmSync(config.clients.acme.clientIdFile);linkSync(config.tokenKeyFile,config.clients.acme.clientIdFile);expect(()=>verifyGoogleSecretSources(sources)).toThrow();
});

it('keeps legacy-only aliases separate and emits only exact canonical personal clients',()=>{
 const mixed={tokenKeyFile:google.tokenKeyFile,clients:{acme:google.clients.acme,ac_me:google.clients.second,'old-client':google.clients.second,ACME:google.clients.second}};
 expect(personalGoogleConfig(mixed)).toEqual({tokenKeyFile:google.tokenKeyFile,clients:{acme:google.clients.acme}});
 expect(personalGoogleConfig({...mixed,clients:{ac_me:google.clients.second}})).toBeUndefined();
 expect(personalGoogleConfig({...mixed,clients:{ACME:google.clients.second}})).toBeUndefined();
 expect(personalGoogleConfig(undefined)).toBeUndefined();
 expect(()=>personalGoogleConfig({...mixed,clients:Object.fromEntries(Array.from({length:33},(_,i)=>[`org${i}`,google.clients.acme]))})).toThrow();
});
it('passes the actual Compose parser with the personal registry and unique secret targets',async()=>{
 const {execFileSync}=await import('node:child_process');
 const dir=mkdtempSync(join(tmpdir(),'personal-google-compose-'));dirs.push(dir);
 const file=join(dir,'compose.yaml');writeFileSync(file,renderAgentsCompose([agent],opts));
 const doc=JSON.parse(execFileSync('docker',['compose','-p','personal-google-parser','-f',file,'config','--format','json'],{encoding:'utf8',timeout:15000}));
 expect(doc.services['lares-helper'].environment.LARES_PERSONAL_GOOGLE_CLIENTS).toBe(document().services['lares-helper'].environment.LARES_PERSONAL_GOOGLE_CLIENTS);
 expect(new Set(doc.services['lares-helper'].secrets.map((s:any)=>s.target)).size).toBe(doc.services['lares-helper'].secrets.length);
},20000);
