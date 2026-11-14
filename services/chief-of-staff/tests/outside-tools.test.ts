import { beforeEach,afterEach,describe,expect,it,vi } from 'vitest';
import { runDynamic } from '../../../packages/agent-kit/tests/helpers/eve-dynamic.js';
const fake=vi.hoisted(()=>({broker:vi.fn(),execute:vi.fn(),privateSession:vi.fn(),definition:vi.fn(),reserve:vi.fn(),reserveOrDeny:vi.fn(),response:vi.fn(),approved:vi.fn(),recheck:vi.fn()}));
vi.mock('@lares/agent-kit/vault-broker-client',()=>({vaultBrokerRequest:fake.broker,executeApprovedOutsideCall:fake.execute}));
vi.mock('@lares/agent-kit/private-console-surface',()=>({verifyPrivateConsoleSession:fake.privateSession}));
vi.mock('@lares/agent-kit/approval-execution',async orig=>({...(await orig<typeof import('@lares/agent-kit/approval-execution')>()),reserveExactApproval:fake.reserve,reserveExactApprovalOrDeny:fake.reserveOrDeny,approveExactResponse:fake.response,requireApprovedExecution:fake.approved,requireApprovedRecheck:fake.recheck}));
vi.mock('../lib/definition.js',()=>({thisAgent:fake.definition}));
// eve keeps Lares's per-session marks (which turn applied an answer to a card) in its durable session
// state, which only a running eve session can read; here those `lares.` states are held in memory.
const eveState=vi.hoisted(()=>({values:new Map<string,unknown>(),readable:true}));
vi.mock('eve/context',async original=>{
 const real=await original<typeof import('eve/context')>();
 return {...real,defineState:(key:string,initial:()=>unknown)=>!key.startsWith('lares.')?(real.defineState as (k:string,i:()=>unknown)=>unknown)(key,initial):
  {get:()=>{if(!eveState.readable)throw new Error('no active eve context');return eveState.values.has(key)?eveState.values.get(key):initial();},
   update:(fn:(v:unknown)=>unknown)=>{eveState.values.set(key,fn(eveState.values.has(key)?eveState.values.get(key):initial()));}}};
});
import { noteAnswerApplied } from '../lib/approval-card-turns.js';
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
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();eveState.values.clear();eveState.readable=true;});
const dyn=(sentinel:unknown,ctx:object=context,store?:Map<string,string>)=>runDynamic(sentinel,ctx as never,store);
it('builds ordinary tools that still execute after the original admitted turn closes',async()=>{
 await hook.events['turn.started']!(started as never,context as never);
 const tools=await dyn(resolver);expect(Object.keys(tools)).toEqual(['registry__lookup']);
 {const events=hook.events as Record<string,((e:never,c:never)=>unknown)|undefined>;await (events['turn.settled']??events['turn.completed'])!(started as never,context as never);}
 const responder={...auth,attributes:{...auth.attributes,lares_purpose:'resolver'}};
 // eve 1.0: the approved call runs as the requester (session.auth.current stays the human); the answerer is approval.responder.
 const answer={...context,callId:'call-1',toolName:'registry__lookup',approval:{responder}};
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
 // The re-check before an approved call (eve marks it): the exact approved card must exist, or the call is denied.
 const recheck={...human,[Symbol.for('eve.approval-evaluation')]:{recheck:true}};
 fake.recheck.mockRejectedValueOnce(new Error('no'));expect(await approval.request(recheck)).toBe('denied');
 fake.recheck.mockResolvedValueOnce(undefined);expect(await approval.request(recheck)).toBe('user-approval');
 expect(fake.reserveOrDeny).toHaveBeenCalledTimes(2); // the re-check reserves nothing
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
 const ctx={...context,callId:'call-1',toolName:'registry__lookup',approval:{responder}};
 for(const changed of [{callId:''},{toolName:'registry__write'},{approval:undefined},{approval:{responder:auth}},{approval:{responder:{...responder,attributes:{...responder.attributes,lares_purpose:'human'}}}}])
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

/** The owner's ruling: in the turn an answer to a card was applied in, a NEW outside-tool call (every one
 *  asks first) is refused before its card, its reservation and any contact with the tool or its
 *  connection; the answered card's own approved call still runs once; the next message works as before.
 *  The settle hook's mark is written the way agent/hooks/approval-record.ts writes it (`noteAnswerApplied`;
 *  Approve and Deny both set it); tests/turn-after-answered-card.test.ts drives the hooks themselves. */
describe('outside tools in the reply to an answered request',()=>{
 const refusal={type:'denied',reason:'That cannot be started in the reply to an answered request. Ask again in a new message.'};
 const contacted=()=>fake.broker.mock.calls.filter(([op])=>op==='outside.approve').length+fake.execute.mock.calls.length;
 const newCall=(session:object=context.session)=>({...context,session,callId:'call-new',toolName:'registry__lookup',toolInput:{company:'Other'}});
 it.each(['Approve','Deny'])('after %s: a new outside-tool call in the continued turn is refused, with no card and no contact with the tool',async()=>{
  const approval=(await dyn(resolver))['registry__lookup'].approval;
  noteAnswerApplied(context.session.turn.id); // the settle hook marks the turn for an Approve and for a Deny alike
  const before=contacted();
  expect(await approval.request(newCall())).toEqual(refusal);
  expect(fake.reserveOrDeny).not.toHaveBeenCalled(); // no reservation, so no card
  expect(contacted()).toBe(before);
 });
 it('the answered card\'s own approved call still passes the recheck and runs exactly once',async()=>{
  const tools=await dyn(resolver),approval=tools['registry__lookup'].approval;
  noteAnswerApplied(context.session.turn.id);
  const approved={...context,callId:'call-1',toolName:'registry__lookup',toolInput:{company:'Example'}};
  fake.recheck.mockResolvedValueOnce(undefined);
  expect(await approval.request({...approved,[Symbol.for('eve.approval-evaluation')]:{recheck:true}})).toBe('user-approval');
  const responder={...auth,attributes:{...auth.attributes,lares_purpose:'resolver'}};
  await expect(tools['registry__lookup'].execute({company:'Example'},{...approved,approval:{responder}})).resolves.toEqual({content:[{type:'text',text:'Example'}]});
  expect(fake.execute).toHaveBeenCalledOnce();
  expect(await approval.request(newCall())).toEqual(refusal); // and a new one next to it is refused
  expect(fake.execute).toHaveBeenCalledOnce();
 });
 it('the next message is a new turn: the call reserves and asks as before',async()=>{
  const approval=(await dyn(resolver))['registry__lookup'].approval;
  noteAnswerApplied(context.session.turn.id);
  fake.reserveOrDeny.mockResolvedValue(null);
  expect(await approval.request(newCall({...context.session,turn:{id:'turn-2',sequence:2}}))).toBe('user-approval');
  expect(fake.reserveOrDeny).toHaveBeenCalledOnce();
 });
 it('fails closed when the turn cannot be told: no turn id, or session state that cannot be read',async()=>{
  const approval=(await dyn(resolver))['registry__lookup'].approval;
  const {turn:_turn,...noTurn}=context.session;
  expect(await approval.request(newCall(noTurn))).toEqual(refusal);
  eveState.readable=false;
  expect(await approval.request(newCall())).toEqual(refusal);
  expect(fake.reserveOrDeny).not.toHaveBeenCalled();expect(contacted()).toBe(0);
 });
});
