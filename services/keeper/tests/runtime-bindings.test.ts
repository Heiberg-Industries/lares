import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderAgentsCompose, type AgentContainer } from '../lib/compose-agents.js';
import { runtimeBindingsSchema, verifyBindingSources, type RuntimeBindings } from '../lib/runtime-bindings.js';
import { storeRoot } from '../../../packages/agent-kit/src/notes-store.js';

const roots:string[]=[];
const root=()=>{const d=mkdtempSync(join(tmpdir(),'lares-bindings-'));roots.push(d);return d;};
afterEach(()=>roots.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
const image='node@sha256:'+'a'.repeat(64);
const agent:AgentContainer={name:'writer',role:'creative',address:'172.18.0.24',doors:[],runtime:{databaseUrl:'postgres://u@db/domain',workflowUrl:'postgres://u@db/workflow',gatewayUrl:'https://gateway.example.test',proxyUrl:'http://proxy:8888',gatewayKeyFile:'/etc/secrets/key',passwordFile:'/etc/secrets/password'}};
const opts={network:'test_network',imageByRole:{creative:image,'chief-of-staff':image},agentsDir:'/srv/agents',secretsDir:'/etc/secrets',modelPrefix:'lares'};
const binding=(source:string,readOnly=false):RuntimeBindings=>({role:'creative',environment:{ATLAS_PATH:'/srv/atlas'},mounts:[{source,target:'/srv/atlas',readOnly}],secrets:{NOTION_TOKEN_FILE:'/etc/secrets/notion'}});

it('repairs the reproduced Atlas path failure and preserves explicit mounts, credentials and workflow files',()=>{
 expect(()=>storeRoot('atlas',parse(renderAgentsCompose([agent],opts)).services['lares-writer'].environment)).toThrow('ATLAS_PATH');
 const b={...binding(root()),workflowVolume:'previous_workflow_files',ownerId:'existing-owner-namespace',legacySandboxRoots:['/app/services/previous-writer']};
 const doc=parse(renderAgentsCompose([{...agent,bindings:b,claims:[{kind:'slack',principal:'U_OWNER',revision:'11111111-1111-4111-8111-111111111111',owner:'owner@example.test'}]}],opts));const s=doc.services['lares-writer'];
 expect(storeRoot('atlas',s.environment)).toBe('/srv/atlas');
 expect(s.volumes).toContainEqual({type:'bind',source:b.mounts[0].source,target:'/srv/atlas',read_only:false,bind:{create_host_path:false}});
 expect(s.volumes).toContainEqual({type:'volume',source:'writer-workflow-files',target:'/app/services/creative/.eve/.workflow-data',volume:{nocopy:true}});
 expect(doc.volumes['writer-workflow-files']).toEqual({external:true,name:'previous_workflow_files'});
 expect(s.environment.NOTION_TOKEN_FILE).toBe('/run/secrets/notion-token');
 expect(doc.secrets['writer-integration-notion-token']).toEqual({file:'/etc/secrets/notion'});
 expect(s.environment.EVE_SCHEDULES_LIVE).toBe('0');
 expect(s.environment.AGENT_OWNER_USER_ID).toBe('existing-owner-namespace');
 expect(s.environment.LARES_SLACK_PRINCIPAL).toBe('U_OWNER');
 expect(s.tmpfs).toContain('/app/services/previous-writer:uid=10001,gid=10001,mode=0700,size=256m');
 expect(s.tmpfs).toContain('/app/packages/agent-kit/node_modules/.cache:uid=10001,gid=10001,mode=0700,size=64m');
 expect(s.tmpfs.some((p:string)=>p.startsWith('/app/services/creative/.eve:'))).toBe(false);
});

it('binds the eve route-password secret for creative under one role-neutral env var',()=>{
 // One role-neutral key: every role shares EVE_ROUTE_PASSWORD_FILE rather than each getting
 // a role-named key. An installation supplies its own eve-route-password secret per agent
 // container.
 const creativeDoc=parse(renderAgentsCompose([{...agent,bindings:{role:'creative',environment:{},mounts:[],secrets:{EVE_ROUTE_PASSWORD_FILE:'/etc/secrets/creative-route-password'}}}],opts));
 expect(creativeDoc.services['lares-writer'].environment.EVE_ROUTE_PASSWORD_FILE).toBe('/run/secrets/eve-route-password');
 expect(creativeDoc.secrets['writer-integration-eve-route-password']).toEqual({file:'/etc/secrets/creative-route-password'});
});
it.each(['EVE_SCHEDULES_LIVE','LARES_AGENT_INCARNATION','LARES_EMAIL_MAILBOX','NODE_OPTIONS','PGPASSWORD','SLACK_ALLOWED_USER_IDS','GOOGLE_CLIENT_SECRET','AGENT_OWNER_USER_ID','HTTPS_PROXY'])('rejects a binding that overrides %s',key=>{
 expect(()=>runtimeBindingsSchema.parse({...binding(root()),environment:{[key]:'unsafe'}})).toThrow();
});
it.each(['shared','private'])('lets the installation bind the article area as %s and hands it to the agent',value=>{
 const b:RuntimeBindings={role:'chief-of-staff',environment:{LARES_ARTICLE_AREA:value},mounts:[],secrets:{}};
 expect(runtimeBindingsSchema.parse(b).environment.LARES_ARTICLE_AREA).toBe(value);
 const doc=parse(renderAgentsCompose([{...agent,role:'chief-of-staff',bindings:b}],opts));
 expect(doc.services['lares-writer'].environment.LARES_ARTICLE_AREA).toBe(value);
});
it.each(['everyone','Shared ','','both'])('refuses an article area of %j: only shared or private are values',value=>{
 expect(()=>runtimeBindingsSchema.parse({role:'chief-of-staff',environment:{LARES_ARTICLE_AREA:value},mounts:[],secrets:{}})).toThrow();
});
it('lets the installation bind the four chief-of-staff business settings and hands them to the agent',()=>{
 const environment={CRM_BRANDS:'[{"id":"EXAMPLE_BRAND","description":"an example brand"}]',COMMERCIAL_BRANDS:'["EXAMPLE_BRAND"]',INSTITUTIONAL_SENDER_DOMAINS:'["authority.example"]',DEADLINE_CALENDAR_FILE:'/srv/deadlines/calendar.json'};
 const b:RuntimeBindings={role:'chief-of-staff',environment,mounts:[{source:'/srv/deadlines/calendar.json',target:'/srv/deadlines/calendar.json',readOnly:true}],secrets:{}};
 expect(runtimeBindingsSchema.parse(b).environment).toEqual(environment);
 const doc=parse(renderAgentsCompose([{...agent,role:'chief-of-staff',bindings:b}],opts));
 expect(doc.services['lares-writer'].environment).toMatchObject(environment);
 expect(doc.services['lares-writer'].volumes).toContainEqual({type:'bind',source:'/srv/deadlines/calendar.json',target:'/srv/deadlines/calendar.json',read_only:true,bind:{create_host_path:false}});
});
it('lets the installation name the CRM field that holds the org number',()=>{
 const b:RuntimeBindings={role:'chief-of-staff',environment:{TWENTY_ORG_NUMBER_FIELD:'registryNumber'},mounts:[],secrets:{}};
 expect(runtimeBindingsSchema.parse(b).environment).toEqual({TWENTY_ORG_NUMBER_FIELD:'registryNumber'});
});
it('lets the installation name the console address a long Telegram approval card links to',()=>{
 const b:RuntimeBindings={role:'chief-of-staff',environment:{LARES_CONSOLE_URL:'https://console.example.com'},mounts:[],secrets:{}};
 expect(runtimeBindingsSchema.parse(b).environment).toEqual({LARES_CONSOLE_URL:'https://console.example.com'});
});
it('refuses a deadline calendar file that no explicit mount covers',()=>{
 const environment={DEADLINE_CALENDAR_FILE:'/srv/deadlines/calendar.json'};
 expect(()=>runtimeBindingsSchema.parse({role:'chief-of-staff',environment,mounts:[],secrets:{}})).toThrow();
 expect(()=>runtimeBindingsSchema.parse({role:'chief-of-staff',environment,mounts:[{source:'/srv/other',target:'/srv/other',readOnly:true}],secrets:{}})).toThrow();
});
it('accepts a single-file mount as a data source',()=>{
 const d=root();const f=join(d,'calendar.json');writeFileSync(f,'{}');
 expect(()=>verifyBindingSources({role:'chief-of-staff',environment:{},mounts:[{source:f,target:'/srv/deadlines/calendar.json',readOnly:true}],secrets:{}})).not.toThrow();
});
it('refuses role changes, unsafe paths, missing mount coverage, overlapping targets and managed Google bypasses',()=>{
 const b=binding(root());
 for(const invalid of [
  {...b,mounts:[{...b.mounts[0],target:'/definition'}]},
  {...b,mounts:[{...b.mounts[0],source:'/srv/a/../b'}]},
  {...b,mounts:[{...b.mounts[0],source:'/srv/$BAD'}]},
  {...b,mounts:[]},
  {...b,mounts:[...b.mounts,{...b.mounts[0],target:'/srv/atlas/private'}]},
  {...b,secrets:{TOKEN_ENC_KEY_FILE:'/etc/secrets/google'}},
  {...b,environment:{GOOGLE_PRINCIPAL_ID:'another-owner'}},
  {...b,environment:{SIGNAL_SPINE_URL:'https://user:password@example.test'}},
  {...b,legacySandboxRoots:['/app/services/creative']},
  {...b,legacySandboxRoots:['/app/services/other/../../packages']},
 ]) expect(()=>runtimeBindingsSchema.parse(invalid)).toThrow();
 expect(()=>renderAgentsCompose([{...agent,role:'chief-of-staff',bindings:b}],opts)).toThrow('role mismatch');
});
it('refuses missing and symlinked data sources without creating them',()=>{
 const d=root();const b=binding(join(d,'absent'));
 expect(()=>verifyBindingSources(b)).toThrow();
 mkdirSync(join(d,'store'));symlinkSync(join(d,'store'),join(d,'link'));
 expect(()=>verifyBindingSources(binding(join(d,'link')))).toThrow();
 expect(()=>verifyBindingSources(binding(join(d,'store')))).not.toThrow();
});

it('the generated bind options expose an actual store to a non-root process and enforce read-only access',()=>{
 const d=root();writeFileSync(join(d,'note.md'),'preserved knowledge',{mode:0o644});
 // Docker Desktop maps these fixture mounts; no provider, model, shared DB or agent container.
 for(const ro of [false,true]){
  const b=binding(d,ro);b.secrets={};
  const s=parse(renderAgentsCompose([{...agent,bindings:b}],opts)).services['lares-writer'];
  const mount=s.volumes.find((v:any)=>typeof v==='object'&&v.target==='/srv/atlas');
  const program=`const fs=require('fs');if(fs.readFileSync(process.env.ATLAS_PATH+'/note.md','utf8')!=='preserved knowledge')process.exit(2);try{fs.writeFileSync(process.env.ATLAS_PATH+'/note.md','preserved knowledge');if(${ro})process.exit(3)}catch(e){if(!${ro})throw e}console.log('store-access-ok')`;
  // Fixture file writable by runtime uid; read-only must come from the mount itself.
  chmodSync(d,0o777);chmodSync(join(d,'note.md'),0o666);
  const output=execFileSync('docker',['run','--rm','--network','none','--read-only','--user','10001:10001','--cap-drop','ALL','--env',`ATLAS_PATH=${s.environment.ATLAS_PATH}`,'--mount',`type=bind,src=${mount.source},dst=${mount.target}${mount.read_only?',readonly':''}`,'node:24-alpine','node','-e',program],{encoding:'utf8',timeout:60000});
  expect(output).toContain('store-access-ok');expect(readFileSync(join(d,'note.md'),'utf8')).toBe('preserved knowledge');
 }
},120000);

it('mounts the signals read token and passes the owner register id as the Slack sign-in for a chief of staff',()=>{
 const chief:AgentContainer={...agent,name:'chief',role:'chief-of-staff',address:'172.18.0.25'};
 const slackClaim=[{kind:'slack' as const,principal:'U_OWNER',revision:'11111111-1111-4111-8111-111111111111',owner:'owner@example.test'}];
 const b:RuntimeBindings={role:'chief-of-staff',ownerId:'register-owner-1',environment:{},mounts:[],secrets:{SIGNAL_READ_TOKEN_FILE:'/etc/secrets/signal-read'}};
 const s=parse(renderAgentsCompose([{...chief,claims:slackClaim,bindings:b}],opts)).services['lares-chief'];
 expect(s.environment.SIGNAL_READ_TOKEN_FILE).toBe('/run/secrets/signal-read-token');
 expect(s.environment.SLACK_TOKEN_PRINCIPAL_ID).toBe('register-owner-1');
 // an explicit binding wins; with neither, nothing is set
 const explicit=parse(renderAgentsCompose([{...chief,claims:slackClaim,bindings:{...b,environment:{SLACK_TOKEN_PRINCIPAL_ID:'explicit-id'}}}],opts)).services['lares-chief'];
 expect(explicit.environment.SLACK_TOKEN_PRINCIPAL_ID).toBe('explicit-id');
 const none=parse(renderAgentsCompose([{...chief,claims:slackClaim,bindings:{...b,ownerId:undefined}}],opts)).services['lares-chief'];
 expect(none.environment.SLACK_TOKEN_PRINCIPAL_ID).toBeUndefined();
 // an owner id without any Slack door or claim sets no principal (the brief leaves Slack out quietly)
 const noSlack=parse(renderAgentsCompose([{...chief,bindings:b}],opts)).services['lares-chief'];
 expect(noSlack.environment.SLACK_TOKEN_PRINCIPAL_ID).toBeUndefined();
 const door=parse(renderAgentsCompose([{...chief,doors:[{kind:'slack',enabled:true}],bindings:b}],opts)).services['lares-chief'];
 expect(door.environment.SLACK_TOKEN_PRINCIPAL_ID).toBe('register-owner-1');
 expect(runtimeBindingsSchema.safeParse({...b,environment:{ROUTE_HOURS:'9'}}).success).toBe(false);
});
