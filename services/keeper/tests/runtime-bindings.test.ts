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
const opts={network:'test_network',imageByRole:{creative:image,travel:image,'chief-of-staff':image},agentsDir:'/srv/agents',secretsDir:'/etc/secrets'};
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

it('binds the eve route-password secret for travel and creative under one role-neutral env var (LAR-1)',()=>{
 // Mirrors eve-saga's existing EVE_SAGA_ROUTE_PASSWORD_FILE binding, but under a single
 // role-neutral key — this engine repo carries no persona names, so travel and creative
 // share EVE_ROUTE_PASSWORD_FILE rather than each getting a persona-named key. An overlay
 // supplies its own eve-route-password secret per agent container.
 const travelDoc=parse(renderAgentsCompose([{...agent,role:'travel',bindings:{role:'travel',environment:{},mounts:[],secrets:{EVE_ROUTE_PASSWORD_FILE:'/etc/secrets/travel-route-password'}}}],opts));
 expect(travelDoc.services['lares-writer'].environment.EVE_ROUTE_PASSWORD_FILE).toBe('/run/secrets/eve-route-password');
 expect(travelDoc.secrets['writer-integration-eve-route-password']).toEqual({file:'/etc/secrets/travel-route-password'});
 const creativeDoc=parse(renderAgentsCompose([{...agent,bindings:{role:'creative',environment:{},mounts:[],secrets:{EVE_ROUTE_PASSWORD_FILE:'/etc/secrets/creative-route-password'}}}],opts));
 expect(creativeDoc.services['lares-writer'].environment.EVE_ROUTE_PASSWORD_FILE).toBe('/run/secrets/eve-route-password');
 expect(creativeDoc.secrets['writer-integration-eve-route-password']).toEqual({file:'/etc/secrets/creative-route-password'});
});
it.each(['EVE_SCHEDULES_LIVE','LARES_AGENT_INCARNATION','LARES_EMAIL_MAILBOX','NODE_OPTIONS','PGPASSWORD','SLACK_ALLOWED_USER_IDS','GOOGLE_CLIENT_SECRET','AGENT_OWNER_USER_ID','HTTPS_PROXY'])('rejects a binding that overrides %s',key=>{
 expect(()=>runtimeBindingsSchema.parse({...binding(root()),environment:{[key]:'unsafe'}})).toThrow();
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
 expect(()=>renderAgentsCompose([{...agent,role:'travel',bindings:b}],opts)).toThrow('role mismatch');
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
