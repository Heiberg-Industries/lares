/** Trusted synthetic private contexts; admission remains designated-owner-only. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const fake=vi.hoisted(()=>({binding:vi.fn(),turn:vi.fn(),definition:vi.fn(),connections:vi.fn(),clock:vi.fn(),source:vi.fn(),outside:vi.fn(),granted:['fixture','gmail_accounts','gmail_read','gmail_search']}));
vi.mock('../src/console-turn-authority.js',async original=>({...await original<typeof import('../src/console-turn-authority.js')>(),requireConsoleSessionBinding:fake.binding,guardConsoleToolContext:fake.turn}));
vi.mock('../src/catalogue.js',()=>({grantedToolNames:()=>fake.granted}));
vi.mock('../src/outside-connections.js',()=>({checkedOutsideConnections:fake.outside,descriptionChecks:vi.fn()}));
vi.mock('../../../services/chief-of-staff/lib/definition.js',()=>({thisAgent:fake.definition,roleMdPath:()=>fileURLToPath(new URL('../templates/chief-of-staff/role.md',import.meta.url))}));
vi.mock('../../../services/creative/lib/definition.js',()=>({thisAgent:fake.definition,roleMdPath:()=>fileURLToPath(new URL('../templates/creative/role.md',import.meta.url))}));
vi.mock('../../../services/chief-of-staff/lib/connections.js',()=>({readConnections:fake.connections,connectionsMarkdown:()=> 'OWNER_CONNECTION_CANARY'}));
vi.mock('../../../services/chief-of-staff/lib/owner-clock.js',()=>({ownerTz:fake.clock}));
vi.mock('../../../services/chief-of-staff/catalogue/index.js',()=>({CATALOGUE:Object.fromEntries(['fixture','gmail_accounts','gmail_read','gmail_search'].map(name=>[name,{capability:'fixture',tool:{description:name==='fixture'?'OWNER_TOOL_CANARY':'Personal mail read',inputSchema:{type:'object'},execute:fake.source}}]))}));
vi.mock('../../../services/creative/catalogue/index.js',()=>({CATALOGUE:Object.fromEntries(['fixture','gmail_accounts','gmail_read','gmail_search'].map(name=>[name,{capability:'fixture',tool:{description:'OWNER_TOOL_CANARY',inputSchema:{type:'object'},execute:fake.source}}]))}));
import {parseDefinition} from '../src/definition.js';
const dist=pathToFileURL(fileURLToPath(new URL('../node_modules/eve/dist/src/',import.meta.url))).href;
const {ContextContainer,contextStorage}=await import(`${dist}context/container.js`);
const keys=await import(`${dist}context/keys.js`);
const {dispatchDynamicInstructionEvent,buildDynamicInstructionMessages}=await import(`${dist}context/dynamic-instruction-lifecycle.js`);
const {dispatchDynamicToolEvent}=await import(`${dist}context/dynamic-tool-lifecycle.js`);
const {buildDynamicTools}=await import(`${dist}context/build-dynamic-tools.js`);
const auth={authenticator:'lares-console',principalType:'user',principalId:'synthetic',attributes:{lares_member_id:'synthetic',lares_admission_nonce:'a'.repeat(43),lares_purpose:'human'}};
const context={session:{id:'private',turn:{id:'turn-1',sequence:0},auth:{current:auth,initiator:auth}}};
const event={type:'session.started',data:{},meta:{}};
const load=(path:string)=>import(new URL(path,import.meta.url).href);
beforeEach(()=>{vi.stubEnv('LARES_AGENT_NAME','helper');vi.stubEnv('LARES_AGENT_INCARNATION','11111111-1111-4111-8111-111111111111');fake.binding.mockResolvedValue({});fake.turn.mockResolvedValue(undefined);fake.source.mockResolvedValue('mail result');fake.granted=['fixture','gmail_accounts','gmail_read','gmail_search'];fake.definition.mockResolvedValue({loaded:{definition:{}}});});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
for(const role of ['chief-of-staff','creative'])describe(`${role} real resolvers`,()=>{
 it('installed Eve assembles neutral private instructions and only the safe intersection, with no installation canary',async()=>{
  const instructions=(await load(`../../../services/${role}/agent/instructions/aa-definition.ts`)).default;
  const catalogue=(await load(`../../../services/${role}/agent/tools/catalogue.ts`)).default;
  const outside=(await load(`../../../services/${role}/agent/connections/outside-tools.ts`)).default;
  const storage=new ContextContainer();storage.set(keys.SessionIdKey,'private');storage.set(keys.StaticModelReferenceKey,null);storage.set(keys.AuthKey,auth);storage.set(keys.InitiatorAuthKey,auth);storage.set(keys.SessionKey,{sessionId:'private',auth:context.session.auth,turn:context.session.turn});
  await contextStorage.run(storage,async()=>{
   await dispatchDynamicInstructionEvent({ctx:storage,resolvers:[{slug:'aa-definition',logicalPath:'aa-definition.ts',eventNames:['session.started'],events:instructions.events}],event,messages:[]});
   await dispatchDynamicToolEvent({ctx:storage,resolvers:[{slug:'catalogue',logicalPath:'catalogue.ts',eventNames:['session.started'],events:catalogue.events}],event,messages:[]});
   const prompt=buildDynamicInstructionMessages(storage);expect(JSON.stringify(prompt)).not.toMatch(/OWNER_|outside tool inventory/);
   expect(JSON.stringify(prompt)).toContain('private conversation');
   const tools=buildDynamicTools(storage);
   expect(tools.map((t:any)=>t.name).sort()).toEqual(role==='creative'?[]:['gmail_accounts','gmail_read','gmail_search']);
   expect(JSON.stringify(tools)).not.toContain('OWNER_TOOL_CANARY');
   if(role!=='creative'){await tools.find((t:any)=>t.name==='gmail_read').execute({},context);expect(fake.turn).toHaveBeenCalled();expect(fake.source).toHaveBeenCalledOnce();}
   await expect(outside.events['session.started']({},context)).resolves.toBeNull();expect(fake.outside).not.toHaveBeenCalled();
  });
  // Private prompt/MCP resolution performs no definition, owner-source or discovery reads.
  expect(fake.definition).toHaveBeenCalledTimes(1); // catalogue grant intersection only
 });
 it('native owner keeps custom persona and native source tool surface',async()=>{
  const declaration=JSON.parse(readFileSync(new URL(`../../../services/${role}/agent.json`,import.meta.url),'utf8'));
  fake.definition.mockResolvedValue({loaded:{definition:parseDefinition(declaration),voiceMd:'OWNER_VOICE_CANARY',dutiesMd:'OWNER_DUTIES_CANARY'}});
  const instructions=(await load(`../../../services/${role}/agent/instructions/aa-definition.ts`)).default;
  const catalogue=(await load(`../../../services/${role}/agent/tools/catalogue.ts`)).default;
  const native={session:{id:'native',auth:{current:null,initiator:null}}};
  const prompt=await instructions.events['session.started']({},native);
  expect(JSON.stringify(prompt)).toContain('OWNER_VOICE_CANARY');expect(JSON.stringify(prompt)).toContain('OWNER_DUTIES_CANARY');
  const tools=await catalogue.events['session.started']({},native);expect(Object.keys(tools)).toContain('fixture');
 });
});
it('chief private automatic source resolvers and native skills cannot expose owner context',async()=>{
 for(const name of ['ac-connections','standing-facts','clock']){
  const resolver=(await load(`../../../services/chief-of-staff/agent/instructions/${name}.ts`)).default;
  for(const handler of Object.values(resolver.events) as any[])await expect(handler({},context)).resolves.toMatchObject({markdown:''});
 }
 for(const name of ['signals','sales-outreach']){
  const resolver=(await load(`../../../services/chief-of-staff/agent/skills/${name}.ts`)).default;
  await expect(resolver.events['session.started']({},context)).resolves.toBeNull();
  const native=await resolver.events['session.started']({},{});expect(native.description.length).toBeGreaterThan(0);expect(native.markdown.length).toBeGreaterThan(20);
 }
 expect(fake.connections).not.toHaveBeenCalled();expect(fake.clock).not.toHaveBeenCalled();
});
it('both usage hooks omit private counts, including tagged initiator-only resumes',async()=>{
 const event={data:{turnId:'turn',stepIndex:0,usage:{inputTokens:12}},meta:{id:'usage',at:'2026-01-01'}};
 for(const role of ['chief-of-staff','creative']){
  const {makeModelUsage}=await load(`../../../services/${role}/agent/hooks/model-usage.ts`);const record=vi.fn();const hook=makeModelUsage({record});
  await hook['step.completed'](event,context);await hook['step.completed'](event,{session:{auth:{initiator:auth,current:null}}});expect(record).not.toHaveBeenCalled();
  await hook['step.completed'](event,{session:{id:'native'}});expect(record).toHaveBeenCalledOnce();
 }
});

it('private load_skill sees an empty installed manifest; native loader preserves exact skill content without a sandbox',async()=>{
 const {dispatchDynamicSkillEvent}=await import(`${dist}context/dynamic-skill-lifecycle.js`);
 const {executeLoadSkill}=await import(`${dist}execution/tools/load-skill.js`);
 const {BundleKey}=await import(`${dist}runtime/sessions/runtime-context-keys.js`);
 const storage=new ContextContainer();storage.set(keys.StaticModelReferenceKey,null);storage.set(keys.AuthKey,auth);storage.set(keys.InitiatorAuthKey,auth);storage.set(keys.SessionIdKey,'private-skill');storage.set(keys.SandboxKey,{get:async()=>null});storage.set(BundleKey,{resolvedAgent:{skills:[]}});
 const skills=await Promise.all(['signals','sales-outreach'].map(async slug=>({slug,logicalPath:slug+'.ts',eventNames:['session.started'],events:(await load(`../../../services/chief-of-staff/agent/skills/${slug}.ts`)).default.events})));
 await contextStorage.run(storage,async()=>{
  await dispatchDynamicSkillEvent({ctx:storage,resolvers:skills,event,messages:[]});
  expect(storage.get(keys.DynamicSkillManifestKey)).toEqual({});
  await expect(executeLoadSkill({skill:'signals'})).rejects.toThrow('No skill named "signals".');
  await expect(executeLoadSkill({skill:'sales-outreach'})).rejects.toThrow('No skill named "sales-outreach".');
 });
 const loader=(await load('../../../services/chief-of-staff/agent/tools/load_skill.ts')).default;
 await expect(loader.events['session.started']({},context)).resolves.toBeNull();
 const native={session:{id:'native',auth:{current:null,initiator:null}}};
 const tool=await loader.events['session.started']({},native);
 for(const name of ['signals','sales-outreach']){
  const definition=(await load(`../../../services/chief-of-staff/agent/skills/${name}.ts`)).default;
  const skill=await definition.events['session.started']({},native);
  await expect(tool.execute({skill:name},native)).resolves.toBe(skill.markdown);
 }
 await expect(tool.execute({skill:'signals'},context)).rejects.toThrow('Conversation authority');
});
it('installed session-local todo state cannot cross between private sessions or into native sessions',async()=>{
 const {executeTodoTool}=await import(`${dist}execution/tools/todo.js`);
 const a=new ContextContainer(),b=new ContextContainer();
 contextStorage.run(a,()=>executeTodoTool({todos:[{content:'PRIVATE_TODO_CANARY',status:'pending',priority:'low'}]}));
 expect(JSON.stringify(contextStorage.run(a,()=>executeTodoTool({})))).toContain('PRIVATE_TODO_CANARY');
 expect(JSON.stringify(contextStorage.run(b,()=>executeTodoTool({})))).not.toContain('PRIVATE_TODO_CANARY');
 const replay=new ContextContainer();for(const [key,value] of a.entries())replay.set(key,structuredClone(value));
 expect(JSON.stringify(contextStorage.run(replay,()=>executeTodoTool({})))).toContain('PRIVATE_TODO_CANARY');
});

it('installed Eve resolves the native load_skill override with durable callbacks and refuses its private cold replay',async()=>{
 const loader=(await load('../../../services/chief-of-staff/agent/tools/load_skill.ts')).default;
 const native=new ContextContainer();native.set(keys.SessionIdKey,'native-loader');native.set(keys.StaticModelReferenceKey,null);native.set(keys.SessionKey,{sessionId:'native-loader',auth:{current:null,initiator:null},turn:{id:'native-turn',sequence:0}});
 await contextStorage.run(native,async()=>{
  await dispatchDynamicToolEvent({ctx:native,resolvers:[{slug:'load_skill',logicalPath:'tools/load_skill.ts',eventNames:['session.started'],events:loader.events}],event,messages:[]});
  const tools=buildDynamicTools(native);expect(tools.map((t:any)=>t.name)).toEqual(['load_skill']);
  const expected=(await load('../../../services/chief-of-staff/agent/skills/signals.ts')).default;
  await expect(tools[0].execute({skill:'signals'},{toolCallId:'native-load'})).resolves.toBe((await expected.events['session.started']({},{})).markdown);
  native.set(keys.SessionKey,{sessionId:'native-loader',auth:context.session.auth,turn:context.session.turn});
  await expect(tools[0].execute({skill:'signals'},{toolCallId:'private-load'})).rejects.toThrow('Conversation authority');
 });
});
it('installed Eve trace policy drops HTTP content and metadata exports',async()=>{
 const {resolveTracePolicy}=await import(`${dist}shared/trace-policy.js`);
 const {privateConsoleTracePolicy}=await import('../src/private-console-surface.js');
 expect(resolveTracePolicy(privateConsoleTracePolicy,{agentName:'helper',channel:{kind:'http'},audience:'private',principalType:'user',mode:'conversation',environment:'production'})).toEqual({action:'drop'});
});
