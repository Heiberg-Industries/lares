import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { pathToFileURL,fileURLToPath } from 'node:url';
const fake=vi.hoisted(()=>({broker:vi.fn(),execute:vi.fn(),privateSession:vi.fn(),definition:vi.fn(),reserve:vi.fn(),response:vi.fn(),approved:vi.fn()}));
vi.mock('@lares/agent-kit/vault-broker-client',()=>({vaultBrokerRequest:fake.broker,executeApprovedOutsideCall:fake.execute}));
vi.mock('@lares/agent-kit/private-console-surface',()=>({verifyPrivateConsoleSession:fake.privateSession}));
vi.mock('@lares/agent-kit/approval-execution',()=>({reserveExactApproval:fake.reserve,approveExactResponse:fake.response,requireApprovedExecution:fake.approved}));
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
  op==='outside.approve'?{outsideCapability:capability}:op==='outside.tools'?{tools:[{name:'lookup',description:'Accepted lookup',inputSchema:{type:'object',properties:{company:{type:'string'}}}}]}:{});
 fake.execute.mockResolvedValue({content:[{type:'text',text:'Example'}]});
});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
it('uses installed Eve durable tool shape after the original admitted turn closes',async()=>{
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
  await hook.events['turn.completed']!(started as never,context as never);
  const responder={...auth,attributes:{...auth.attributes,lares_purpose:'resolver'}};
  storage.set(keys.AuthKey,responder);storage.set(keys.SessionKey,{sessionId:context.session.id,auth:{current:responder,initiator:auth},turn:{id:'answer-turn',sequence:2}});
  await expect(tools[0].execute({company:'Example'},{toolCallId:'call-1'})).resolves.toEqual({content:[{type:'text',text:'Example'}]});
 });
 expect(fake.execute).toHaveBeenCalledWith({outsideCapability:capability,sessionId:context.session.id,
  memberId:'member-a',admissionNonce:nonce},{callId:'call-1',connectionName:'registry',toolName:'lookup',input:{company:'Example'}});
});
it('refuses missing exact approval, invalid call IDs and non-resolver execution before the signed client',async()=>{
 const tools=await resolver.events['session.started']!({} as never,context as never),execute=(tools as any)['registry__lookup'].execute;
 const responder={...auth,attributes:{...auth.attributes,lares_purpose:'resolver'}};
 const ctx={...context,callId:'call-1',toolName:'registry__lookup',session:{...context.session,auth:{current:responder,initiator:auth}}};
 for(const changed of [{callId:''},{toolName:'registry__write'},{session:context.session}])
  await expect(execute({}, {...ctx,...changed})).rejects.toThrow('unavailable');
 fake.approved.mockRejectedValueOnce(new Error('Exact approval unavailable'));
 await expect(execute({},ctx)).rejects.toThrow('Exact approval unavailable');
 expect(fake.execute).not.toHaveBeenCalled();expect(fake.broker.mock.calls.some(([op])=>op==='outside.approve')).toBe(false);
});
it('offers no direct connection in either role and no outside tools on native or unresolved sessions',async()=>{
 expect(await creative.events['session.started']!({} as never,context as never)).toBeNull();
 expect(await chiefConnections.events['session.started']!({} as never,context as never)).toBeNull();
 fake.privateSession.mockResolvedValue(false);expect(await resolver.events['session.started']!({} as never,context as never)).toBeNull();
 fake.privateSession.mockResolvedValue(true);fake.broker.mockRejectedValue(Error('metadata unavailable'));
 expect(await resolver.events['session.started']!({} as never,context as never)).toBeNull();expect(fake.execute).not.toHaveBeenCalled();
});
