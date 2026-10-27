import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { pathToFileURL,fileURLToPath } from 'node:url';
const fake=vi.hoisted(()=>({broker:vi.fn(),execute:vi.fn(),privateSession:vi.fn(),definition:vi.fn()}));
vi.mock('@lares/agent-kit/vault-broker-client',()=>({vaultBrokerRequest:fake.broker,executeApprovedOutsideCall:fake.execute}));
vi.mock('@lares/agent-kit/private-console-surface',()=>({verifyPrivateConsoleSession:fake.privateSession}));
vi.mock('../lib/definition.js',()=>({thisAgent:fake.definition}));
import { clearSessionVaultTurnCapabilities } from '../agent/lib/vault-turn.js';
import resolver from '../agent/tools/outside-tools.js';
import hook from '../agent/hooks/private-vault-turn.js';
import creative from '../../creative/agent/connections/outside-tools.js';
import chiefConnections from '../agent/connections/outside-tools.js';
const incarnation='11111111-1111-4111-8111-111111111111',nonce='n'.repeat(43),capability='c'.repeat(43);
const definition={name:'helper',grants:[{capability:'outside',scope:'read'}],autonomy:{outside:'gated'},
 outsideTools:[{name:'registry',description:'Lookup',url:'https://tools.example.org/mcp',token:true,trusted:false,tools:{allow:['lookup'],read:['lookup']}}]};
const auth={authenticator:'lares-console',attributes:{lares_member_id:'member-a',lares_admission_nonce:nonce,lares_purpose:'human',lares_vault_pending:'p'.repeat(43)}};
const context={session:{id:'outside-session',turn:{id:'turn-1',sequence:1},auth:{current:auth,initiator:auth}}};
const started={data:{turnId:'turn-1',sequence:1}};
beforeEach(()=>{
 clearSessionVaultTurnCapabilities(context.session.id,incarnation);
 vi.stubEnv('LARES_AGENT_NAME','helper');vi.stubEnv('LARES_AGENT_INCARNATION',incarnation);
 fake.definition.mockResolvedValue({loaded:{definition,dutiesMd:'',voiceMd:'',hash:'a'.repeat(64)}});
 fake.privateSession.mockResolvedValue(true);
 fake.broker.mockImplementation(async op=>op==='turn.open'?{turnCapability:capability,expiresAt:Date.now()+60_000}:
  op==='outside.tools'?{tools:[{name:'lookup',description:'Accepted lookup',inputSchema:{type:'object',properties:{company:{type:'string'}}}}]}:{});
 fake.execute.mockResolvedValue({content:[{type:'text',text:'Example'}]});
});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
it('uses installed Eve durable ordinary tool shape and the existing admitted-turn hook',async()=>{
 await hook.events['turn.started']!(started as never,context as never);
 const dist=pathToFileURL(fileURLToPath(new URL('../node_modules/eve/dist/src/',import.meta.url))).href;
 const {ContextContainer,contextStorage}=await import(`${dist}context/container.js`),keys=await import(`${dist}context/keys.js`);
 const {dispatchDynamicToolEvent}=await import(`${dist}context/dynamic-tool-lifecycle.js`);
 const {buildDynamicTools}=await import(`${dist}context/build-dynamic-tools.js`);
 const storage=new ContextContainer();storage.set(keys.SessionIdKey,context.session.id);storage.set(keys.StaticModelReferenceKey,null);
 storage.set(keys.AuthKey,auth);storage.set(keys.InitiatorAuthKey,auth);
 storage.set(keys.SessionKey,{sessionId:context.session.id,auth:context.session.auth,turn:context.session.turn});
 await contextStorage.run(storage,async()=>{
  await dispatchDynamicToolEvent({ctx:storage,resolvers:[{slug:'outside-tools',logicalPath:'tools/outside-tools.ts',eventNames:['session.started'],events:resolver.events}],
   event:{type:'session.started',data:{},meta:{}},messages:[]});
  const tools=buildDynamicTools(storage);expect(tools.map((tool:any)=>tool.name)).toEqual(['registry__lookup']);
  await expect(tools[0].execute({company:'Example'},{toolCallId:'call-1'})).resolves.toEqual({content:[{type:'text',text:'Example'}]});
 });
 expect(fake.execute).toHaveBeenCalledWith({turnCapability:capability,turnId:'turn-1',sequence:1,sessionId:context.session.id,
  memberId:'member-a',admissionNonce:nonce},{callId:'call-1',connectionName:'registry',toolName:'lookup',input:{company:'Example'}});
});
it('refuses missing, ended, or mismatched turns before the signed execution client',async()=>{
 const tools=await resolver.events['session.started']!({} as never,context as never);
 const execute=(tools as any)['registry__lookup'].execute;
 const ctx={...context,callId:'call-1',toolName:'registry__lookup'};
 await expect(execute({},ctx)).rejects.toThrow('unavailable');
 await hook.events['turn.started']!(started as never,context as never);
 for(const changed of [{callId:''},{toolName:'registry__write'},{session:{...context.session,turn:{id:'other',sequence:1}}},
  {session:{...context.session,auth:{current:{...auth,attributes:{...auth.attributes,lares_purpose:'resolver'}},initiator:auth}}}])
  await expect(execute({memberId:'invented'}, {...ctx,...changed})).rejects.toThrow();
 await hook.events['turn.completed']!(started as never,context as never);
 await expect(execute({},ctx)).rejects.toThrow('unavailable');expect(fake.execute).not.toHaveBeenCalled();
});
it('offers no direct connection in either role and no outside tools on native or unresolved sessions',async()=>{
 expect(await creative.events['session.started']!({} as never,context as never)).toBeNull();
 expect(await chiefConnections.events['session.started']!({} as never,context as never)).toBeNull();
 fake.privateSession.mockResolvedValue(false);expect(await resolver.events['session.started']!({} as never,context as never)).toBeNull();
 fake.privateSession.mockResolvedValue(true);fake.broker.mockRejectedValue(Error('metadata unavailable'));
 expect(await resolver.events['session.started']!({} as never,context as never)).toBeNull();expect(fake.execute).not.toHaveBeenCalled();
});
