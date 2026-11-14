/** Trusted synthetic private contexts; admission remains designated-owner-only.
 *
 * Each role's real instruction, tool and skill resolvers are called the way eve 1.0 calls them:
 * a `defineDynamic()` value is an opaque brand holding ONE function, `(ctx) => value`, run before
 * every model call with the session, the latest turn and a `memo`. The old version of this file
 * drove eve 0.60's internal lifecycle modules, which are gone.
 */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const fake=vi.hoisted(()=>({binding:vi.fn(),turn:vi.fn(),resume:vi.fn(),docsRead:vi.fn(),docsIndex:vi.fn(),definition:vi.fn(),connections:vi.fn(),clock:vi.fn(),source:vi.fn(),facts:vi.fn(),outside:vi.fn(),granted:['fixture','gmail_accounts','gmail_read','gmail_search']}));
vi.mock('../src/console-turn-authority.js',async original=>({...await original<typeof import('../src/console-turn-authority.js')>(),requireConsoleSessionBinding:fake.binding,guardConsoleToolContext:fake.turn}));
vi.mock('../src/private-console-resume.js',async original=>({...await original<typeof import('../src/private-console-resume.js')>(),
 privateResolverAdmission:(auth:any)=>auth?.attributes?.lares_purpose==='resolver'?{memberId:auth.attributes.lares_resolver_member_id,requestId:auth.attributes.lares_resume_request_id,optionId:auth.attributes.lares_resume_option}:undefined,
 requirePrivateConsoleResume:fake.resume,requireConsoleResume:fake.resume}));
vi.mock('@lares/agent-kit/public-docs-runtime',()=>({publicDocsIndex:fake.docsIndex,readBakedPublicDoc:fake.docsRead}));
vi.mock('../src/catalogue.js',async original=>({...await original<typeof import('../src/catalogue.js')>(),grantedToolNames:()=>fake.granted}));
vi.mock('../../../services/chief-of-staff/lib/outside-tools.js',()=>({acceptedOutsideTools:fake.outside,runOutsideTool:vi.fn(),requestOutsideApproval:vi.fn(),respondOutsideApproval:vi.fn()}));
vi.mock('../../../services/chief-of-staff/catalogue/index.js',()=>({CATALOGUE:Object.fromEntries(['fixture','gmail_accounts','gmail_read','gmail_search'].map(name=>[name,{capability:'fixture',tool:{description:name==='fixture'?'OWNER_TOOL_CANARY':'Personal mail read',inputSchema:{type:'object'},execute:fake.source}}]))}));
vi.mock('../../../services/creative/catalogue/index.js',()=>({CATALOGUE:Object.fromEntries(['fixture','gmail_accounts','gmail_read','gmail_search'].map(name=>[name,{capability:'fixture',tool:{description:'OWNER_TOOL_CANARY',inputSchema:{type:'object'},execute:fake.source}}]))}));
vi.mock('../../../services/chief-of-staff/lib/definition.js',()=>({thisAgent:fake.definition,roleMdPath:()=>fileURLToPath(new URL('../templates/chief-of-staff/role.md',import.meta.url))}));
vi.mock('../../../services/creative/lib/definition.js',()=>({thisAgent:fake.definition,roleMdPath:()=>fileURLToPath(new URL('../templates/creative/role.md',import.meta.url))}));
vi.mock('../../../services/chief-of-staff/lib/connections.js',()=>({readConnections:fake.connections,connectionsMarkdown:()=> 'OWNER_CONNECTION_CANARY'}));
vi.mock('../../../services/chief-of-staff/lib/owner-clock.js',()=>({ownerTz:fake.clock}));
import {parseDefinition} from '../src/definition.js';
const auth={authenticator:'lares-console',principalType:'user',principalId:'synthetic',attributes:{lares_member_id:'synthetic',lares_admission_nonce:'a'.repeat(43),lares_purpose:'human'}};
const context={session:{id:'private',turn:{id:'turn-1',sequence:0},auth:{current:auth,initiator:auth}}};
const native={session:{id:'native',auth:{current:null,initiator:null}}};
/** The context eve 1.0 gives a dynamic value: the session, its latest turn, and a memo (here: no cache, run the function). */
const dynamicCtx=(base:{session:Record<string,unknown>})=>({...base,turn:{id:'turn_0',status:'running',input:[]},now:new Date(),memo:(_key:unknown,fn:(o:unknown)=>unknown)=>fn({idempotencyKey:'k',abortSignal:new AbortController().signal}),view:{}}) as never;
/** Runs a dynamic value's one function. */
const resolve=async(module:any,base:{session:Record<string,unknown>})=>{
 const fn=Reflect.get(module.default,Symbol.for('eve.dynamic'));
 expect(typeof fn,'a defineDynamic() value').toBe('function');
 return contextStorage.run(new ContextContainer(),()=>fn(dynamicCtx(base)));
};
const load=(path:string)=>import(new URL(path,import.meta.url).href);
// `defineState` (the private-surface marker) needs the container eve runs authored code in.
const {ContextContainer,contextStorage}=await import(pathToFileURL(fileURLToPath(new URL('../node_modules/eve/dist/src/context/container.js',import.meta.url))).href);
const nativeDefinition=(role:string)=>({loaded:{definition:parseDefinition(JSON.parse(readFileSync(new URL(`../../../services/${role}/agent.json`,import.meta.url),'utf8'))),voiceMd:'OWNER_VOICE_CANARY',dutiesMd:'OWNER_DUTIES_CANARY'}});
beforeEach(()=>{vi.stubEnv('LARES_AGENT_NAME','helper');vi.stubEnv('LARES_AGENT_INCARNATION','11111111-1111-4111-8111-111111111111');fake.binding.mockResolvedValue({});fake.turn.mockResolvedValue(undefined);fake.resume.mockResolvedValue({});fake.docsRead.mockImplementation((id:string)=>({markdown:`PUBLIC_DOC:${id}`}));fake.docsIndex.mockReturnValue('- install: reviewed page');fake.source.mockResolvedValue('mail result');fake.definition.mockResolvedValue({loaded:{definition:{}}});});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});

for(const role of ['chief-of-staff','creative'])describe(`${role} real resolvers`,()=>{
 it('assembles neutral private instructions with no installation canary, and reads no definition, owner source or discovery',async()=>{
  const persona=await load(`../../../services/${role}/agent/instructions/aa-definition.ts`);
  const prompt=await resolve(persona,context);
  expect(JSON.stringify(prompt)).not.toMatch(/OWNER_|outside tool inventory/);
  expect(JSON.stringify(prompt)).toContain('private conversation');
  // The private persona comes from the bound surface alone: the definition is never read.
  expect(fake.definition).not.toHaveBeenCalled();
  expect(fake.connections).not.toHaveBeenCalled();
 });
 it('native owner keeps the custom persona',async()=>{
  fake.definition.mockResolvedValue(nativeDefinition(role));
  const persona=await load(`../../../services/${role}/agent/instructions/aa-definition.ts`);
  const prompt=await resolve(persona,native);
  expect(JSON.stringify(prompt)).toContain('OWNER_VOICE_CANARY');expect(JSON.stringify(prompt)).toContain('OWNER_DUTIES_CANARY');
 });
 it('a conversation that claims to be private but cannot prove it fails the turn instead of being offered anything',async()=>{
  fake.binding.mockRejectedValue(new Error('binding revoked'));
  for(const file of ['instructions/aa-definition.ts','tools/public_doc.ts','skills/lares-docs.ts']){
   await expect(resolve(await load(`../../../services/${role}/agent/${file}`),context),file).rejects.toThrow('binding revoked');
  }
 });
});

it('chief private automatic source resolvers and native skills cannot expose owner context',async()=>{
 for(const name of ['ac-connections','standing-facts']){
  const module=await load(`../../../services/chief-of-staff/agent/instructions/${name}.ts`);
  expect(await resolve(module,context),name).toBeNull();
 }
 // The clock is built after the cache marker by zz-cache-boundary; the resolver itself contributes nothing.
 expect(await resolve(await load('../../../services/chief-of-staff/agent/instructions/clock.ts'),context)).toBeNull();
 for(const name of ['signals','sales-outreach']){
  const skill=await load(`../../../services/chief-of-staff/agent/skills/${name}.ts`);
  expect(await resolve(skill,context),name).toBeNull();
 }
 expect(fake.connections).not.toHaveBeenCalled();expect(fake.clock).not.toHaveBeenCalled();
});
it('native chief skills are offered with their exact text, and the private one differs',async()=>{
 fake.definition.mockResolvedValue(nativeDefinition('chief-of-staff'));
 const signals=await load('../../../services/chief-of-staff/agent/skills/signals.ts');
 const offered=await resolve(signals,native);
 expect(offered).not.toBeNull();
 expect(JSON.stringify(offered)).toContain('agent-kit__signals_recent');
 expect(await resolve(signals,context)).toBeNull();
});
it('the native sales-outreach skill is offered where the definition grants it, with its exact text, and never in a private conversation',async()=>{
 const outreach=await load('../../../services/chief-of-staff/agent/skills/sales-outreach.ts');
 fake.definition.mockResolvedValue(nativeDefinition('chief-of-staff'));
 const offered=await resolve(outreach,native);
 // The shipped chief declares the commercial skill, so it is offered natively.
 expect(offered).not.toBeNull();
 expect(JSON.stringify(offered)).toContain('# Sales outreach');
 expect(await resolve(outreach,context)).toBeNull();
 // A definition that grants nothing does not get it: an unreadable one is "no", not "yes".
 fake.definition.mockResolvedValue({loaded:{definition:{}}});
 expect(await resolve(outreach,native)).toBeNull();
 fake.definition.mockRejectedValue(new Error('definition unreadable'));
 expect(await resolve(outreach,native)).toBeNull();
});
it('private skills resolve only the reviewed docs skill, natively and privately alike',async()=>{
 for(const role of ['chief-of-staff','creative']){
  const docs=await load(`../../../services/${role}/agent/skills/lares-docs.ts`);
  const privateDocs=await resolve(docs,context);
  expect(privateDocs,role).not.toBeNull();
  expect(JSON.stringify(privateDocs)).toContain('Public Lares documentation');
  expect(JSON.stringify(privateDocs)).not.toMatch(/OWNER_/);
  expect(await resolve(docs,native),role).not.toBeNull();
  fake.binding.mockRejectedValueOnce(new Error('binding revoked'));
  await expect(resolve(docs,context),role).rejects.toThrow('binding revoked');
 }
});
it('both roles expose only the fixed public reader and recheck private or resumed authority on execution',async()=>{
 for(const role of ['chief-of-staff','creative']){
  fake.docsRead.mockClear();
  const tools=await resolve(await load(`../../../services/${role}/agent/tools/public_doc.ts`),context);
  expect(Object.keys(tools),role).toEqual(['lares_read_public_doc']);
  const tool=tools.lares_read_public_doc;
  await expect(tool.execute({id:'install'},context)).resolves.toBe('PUBLIC_DOC:install');
  expect(fake.docsRead).toHaveBeenCalledTimes(1);
  fake.binding.mockRejectedValueOnce(new Error('binding revoked'));
  await expect(tool.execute({id:'install'},context)).rejects.toThrow('unavailable or this conversation is no longer authorized');
  expect(fake.docsRead).toHaveBeenCalledTimes(1);
 }
 // A resumed (resolver) conversation re-checks the resume surface, not the human binding.
 const resumeAuth={authenticator:'lares-console',attributes:{lares_resolver_member_id:'synthetic',lares_resume_request_id:'request-1',lares_resume_option:'approve',lares_purpose:'resolver'}};
 const resumed={session:{id:'resumed-public-doc',turn:{id:'turn-resumed',sequence:0},auth:{current:resumeAuth,initiator:auth}}};
 fake.docsRead.mockClear();
 const tools=await resolve(await load('../../../services/creative/agent/tools/public_doc.ts'),resumed);
 await expect(tools.lares_read_public_doc.execute({id:'install'},resumed)).resolves.toBe('PUBLIC_DOC:install');
 expect(fake.resume.mock.calls.length).toBeGreaterThanOrEqual(2);
 expect(fake.resume.mock.calls.every(([ctx,phase])=>ctx.session.id==='resumed-public-doc'&&phase==='surface')).toBe(true);
 expect(fake.docsRead).toHaveBeenCalledTimes(1);
});
it('the framework todo tool is off in both roles, so no per-session todo state exists to cross between private sessions',async()=>{
 // eve 0.60 kept todo state in the session container; eve 1.0 has `defaultTools: false`, which drops every
 // framework tool that has no file of its own. The cross-session property this case guarded rests on the
 // agent not being handed that tool: checked on the REAL agent definition and the INSTALLED framework's own
 // list of default tools, not on source text.
 const {installedFrameworkDefaultTools}=await import('../src/framework-default-tools.js');
 const {existsSync}=await import('node:fs');
 const defaults=await installedFrameworkDefaultTools(import.meta.url);
 for(const role of ['chief-of-staff','creative']){
  const module=await load(`../../../services/${role}/agent/agent.ts`);
  expect((module.default as {defaultTools?:unknown}).defaultTools,`${role} defaultTools`).toBe(false);
  // The only way a dropped default tool survives is a file of its own in agent/tools/.
  for(const tool of defaults.filter(name=>/todo/i.test(name)))
   expect(existsSync(new URL(`../../../services/${role}/agent/tools/${tool}.ts`,import.meta.url)),`${role} must not re-add ${tool}`).toBe(false);
  expect(existsSync(new URL(`../../../services/${role}/agent/tools/todo.ts`,import.meta.url)),role).toBe(false);
 }
});
describe('usage hooks never count a private conversation',()=>{
 // eve 1.0: usage is the `usage.recorded` fact, its place on the stream is `ctx.position`, its turn is `scope.turnId`.
 const event={type:'usage.recorded',scope:{turnId:'turn'},data:{kind:'model',owner:{runId:'run_1'},usage:{inputTokens:12,outputTokens:3,cacheReadTokens:0,cacheWriteTokens:0}}};
 const position={line:4,index:0};
 for(const role of ['chief-of-staff','creative'])it(`${role}: private (including tagged initiator-only resumes) is omitted, a native session is counted once`,async()=>{
  const {makeModelUsage}=await load(`../../../services/${role}/agent/hooks/model-usage.ts`);const record=vi.fn();const hook=makeModelUsage({record});
  await hook['usage.recorded'](event,{...context,position});
  await hook['usage.recorded'](event,{session:{id:'private-resume',auth:{initiator:auth,current:null}},position});
  expect(record).not.toHaveBeenCalled();
  await hook['usage.recorded'](event,{session:{id:'native'},position});expect(record).toHaveBeenCalledOnce();
 });
});

for(const role of ['chief-of-staff','creative'])describe(`${role} tool resolvers`,()=>{
 it('private tools are only the safe intersection of the grant, with no owner-tool description, and run the turn check on execution',async()=>{
  const catalogue=await load(`../../../services/${role}/agent/tools/catalogue.ts`);
  const tools=await resolve(catalogue,context);
  expect(Object.keys(tools).sort()).toEqual(role==='creative'?[]:['gmail_accounts','gmail_read','gmail_search']);
  expect(JSON.stringify(tools)).not.toContain('OWNER_TOOL_CANARY');
  if(role!=='creative'){await tools.gmail_read.execute({},context);expect(fake.turn).toHaveBeenCalled();expect(fake.source).toHaveBeenCalledOnce();}
  // The tool list is decided from the definition's grant alone: one read, no owner source or discovery.
  expect(fake.definition).toHaveBeenCalledTimes(1);
 });
 it('native owner keeps the full native source tool surface',async()=>{
  fake.definition.mockResolvedValue(nativeDefinition(role));
  const catalogue=await load(`../../../services/${role}/agent/tools/catalogue.ts`);
  const tools=await resolve(catalogue,native);
  expect(Object.keys(tools)).toContain('fixture');
 });
 it('a private conversation gets no outside connection, and with none declared no outside tool and no read of the accepted list',async()=>{
  // What this pins, exactly, and no more. (1) The connections resolver offers nothing in a private
  // conversation, for either role: eve 1.0 has no live outside-connection discovery (main asserted
  // the same `null`). (2) With a definition that declares no outside tools, as here, the
  // chief-of-staff outside-tools resolver offers none and Keeper's accepted list is never read.
  // It does NOT show that declared outside tools stay out of a private conversation: the current
  // resolver (`agent/tools/outside-tools.ts`) offers them only in a verified private conversation.
  const connection=await load(`../../../services/${role}/agent/connections/outside-tools.ts`);
  expect(await resolve(connection,context)).toBeNull();
  if(role==='chief-of-staff')expect(await resolve(await load(`../../../services/${role}/agent/tools/outside-tools.ts`),context)).toBeNull();
  expect(fake.outside).not.toHaveBeenCalled();
 });
});
