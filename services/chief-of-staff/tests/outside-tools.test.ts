import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { runDynamic } from '../../../packages/agent-kit/tests/helpers/eve-dynamic.js';
const fake=vi.hoisted(()=>({broker:vi.fn(),execute:vi.fn(),privateSession:vi.fn(),definition:vi.fn(),reserve:vi.fn(),reserveOrDeny:vi.fn(),response:vi.fn(),approved:vi.fn()}));
vi.mock('@lares/agent-kit/vault-broker-client',()=>({vaultBrokerRequest:fake.broker,executeApprovedOutsideCall:fake.execute}));
vi.mock('@lares/agent-kit/private-console-surface',()=>({verifyPrivateConsoleSession:fake.privateSession}));
vi.mock('@lares/agent-kit/approval-execution',()=>({reserveExactApproval:fake.reserve,reserveExactApprovalOrDeny:fake.reserveOrDeny,approveExactResponse:fake.response,requireApprovedExecution:fake.approved}));
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
const dyn=(sentinel:unknown,ctx:object=context,store?:Map<string,string>)=>runDynamic(sentinel,ctx as never,store);
it('builds ordinary tools that still execute after the original admitted turn closes',async()=>{
 await hook.events['turn.started']!(started as never,context as never);
 const tools=await dyn(resolver);expect(Object.keys(tools)).toEqual(['registry__lookup']);
 {const events=hook.events as Record<string,((e:never,c:never)=>unknown)|undefined>;await (events['turn.settled']??events['turn.completed'])!(started as never,context as never);}
 const responder={...auth,attributes:{...auth.attributes,lares_purpose:'resolver'}};
 const answer={...context,callId:'call-1',toolName:'registry__lookup',session:{...context.session,auth:{current:responder,initiator:auth},turn:{id:'answer-turn',sequence:2}}};
 await expect(tools['registry__lookup'].execute({company:'Example'},answer)).resolves.toEqual({content:[{type:'text',text:'Example'}]});
 expect(fake.execute).toHaveBeenCalledWith({outsideCapability:capability,sessionId:context.session.id,
  memberId:'member-a',admissionNonce:nonce},{callId:'call-1',connectionName:'registry',toolName:'lookup',input:{company:'Example'}});
});
it('keeps the accepted catalogue and the private-conversation verdict for the whole conversation, and does not keep a failed read',async()=>{
 const store=new Map<string,string>();
 await dyn(resolver,context,store);const reads=()=>fake.broker.mock.calls.filter(([op])=>op==='outside.tools').length;
 expect(reads()).toBe(1);await dyn(resolver,context,store);expect(reads()).toBe(1);
 fake.broker.mockRejectedValue(Error('metadata unavailable'));
 expect(await dyn(resolver,{...context,session:{...context.session,id:'other-session'}},store)).toBeNull();
 fake.broker.mockImplementation(async op=>op==='outside.tools'?{tools:[{name:'lookup',inputSchema:{type:'object',properties:{}}}]}:{});
 expect(Object.keys(await dyn(resolver,{...context,session:{...context.session,id:'other-session'}},store))).toEqual(['registry__lookup']);
});
it('every outside tool has the object-form approval with a card title naming the connection, tool and arguments',async()=>{
 const tools=await dyn(resolver),approval=tools['registry__lookup'].approval;
 expect(typeof approval).toBe('object');expect(typeof approval.request).toBe('function');expect(typeof approval.response).toBe('function');
 expect(approval.prompt({toolName:'registry__lookup',input:{company:'Acme'},callId:'c'})).toBe('Ask outside tool registry: lookup — company: "Acme"');
 expect(()=>approval.prompt({toolName:'registry__lookup',input:{get company():never{throw new Error('boom')}},callId:'c'})).not.toThrow();
});
it('the exact-approval rules still fire for an outside tool, whichever way the model reached it',async()=>{
 const approval=(await dyn(resolver))['registry__lookup'].approval;
 const human={...context,callId:'call-1',toolName:'registry__lookup',toolInput:{company:'Acme'}};
 fake.reserveOrDeny.mockResolvedValue(null);
 expect(await approval.request(human)).toBe('user-approval');expect(fake.reserveOrDeny).toHaveBeenCalledTimes(1);
 fake.reserveOrDeny.mockResolvedValueOnce({type:'denied',reason:'not prepared'});
 expect(await approval.request(human)).toEqual({type:'denied',reason:'not prepared'});
 // An approval resume asks for the exact approved call; without it the call is denied, never asked again.
 const responder={...auth,attributes:{...auth.attributes,lares_purpose:'resolver'}};
 const resume={...human,session:{...context.session,auth:{current:responder,initiator:auth}}};
 fake.approved.mockRejectedValueOnce(new Error('no'));expect(await approval.request(resume)).toBe('denied');
 fake.approved.mockResolvedValueOnce({});expect(await approval.request(resume)).toBe('user-approval');
});
it('asks the exact response check for a Deny as well as an Approve, and a refusal reaches eve',async()=>{
 const approval=(await dyn(resolver))['registry__lookup'].approval;
 const answer=(decision:string)=>({request:{interactionId:'i1',callId:'call-1',toolName:'registry__lookup',toolInput:{}},response:{decision,principal:auth},session:{id:context.session.id,initiator:auth}});
 fake.response.mockResolvedValue({status:'allowed'});
 for(const decision of ['approve','deny']){
  expect(await approval.response(answer(decision))).toEqual({status:'allowed'});
  expect(fake.response).toHaveBeenLastCalledWith(expect.objectContaining({response:expect.objectContaining({decision})}),expect.anything());
 }
 fake.response.mockRejectedValue(new Error('Exact approval is unavailable'));
 await expect(approval.response(answer('deny'))).rejects.toThrow();
 await expect(approval.response(answer('approve'))).rejects.toThrow();
});
it('refuses missing exact approval, invalid call IDs and non-resolver execution before the signed client',async()=>{
 const tools=await dyn(resolver),execute=(tools as any)['registry__lookup'].execute;
 const responder={...auth,attributes:{...auth.attributes,lares_purpose:'resolver'}};
 const ctx={...context,callId:'call-1',toolName:'registry__lookup',session:{...context.session,auth:{current:responder,initiator:auth}}};
 for(const changed of [{callId:''},{toolName:'registry__write'},{session:context.session}])
  await expect(execute({}, {...ctx,...changed})).rejects.toThrow('unavailable');
 fake.approved.mockRejectedValueOnce(new Error('Exact approval unavailable'));
 await expect(execute({},ctx)).rejects.toThrow('Exact approval unavailable');
 expect(fake.execute).not.toHaveBeenCalled();expect(fake.broker.mock.calls.some(([op])=>op==='outside.approve')).toBe(false);
});
it('offers no direct connection in either role and no outside tools on native or unresolved sessions',async()=>{
 expect(await dyn(creative)).toBeNull();
 expect(await dyn(chiefConnections)).toBeNull();
 fake.privateSession.mockResolvedValue(false);expect(await dyn(resolver)).toBeNull();
 fake.privateSession.mockResolvedValue(true);fake.broker.mockRejectedValue(Error('metadata unavailable'));
 expect(await dyn(resolver,{...context,session:{...context.session,id:'fresh'}})).toBeNull();expect(fake.execute).not.toHaveBeenCalled();
});
