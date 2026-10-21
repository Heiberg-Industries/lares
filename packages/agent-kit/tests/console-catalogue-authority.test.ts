import { fileURLToPath,pathToFileURL } from 'node:url';
import { afterEach,describe,expect,it,vi } from 'vitest';
const fake=vi.hoisted(()=>({query:vi.fn(),execute:vi.fn(),approval:vi.fn()}));
vi.mock('../src/db.js',()=>({getPool:()=>fake}));
vi.mock('../../../services/chief-of-staff/catalogue/index.js',()=>({CATALOGUE:{fixture:{capability:'fixture',tool:{description:'Fixture',inputSchema:{type:'object'},execute:fake.execute,approval:fake.approval}}}}));
vi.mock('../../../services/creative/catalogue/index.js',()=>({CATALOGUE:{fixture:{capability:'fixture',tool:{description:'Fixture',inputSchema:{type:'object'},execute:fake.execute,approval:fake.approval}}}}));
vi.mock('../../../services/chief-of-staff/lib/definition.js',()=>({thisAgent:async()=>({loaded:{definition:{}}})}));
vi.mock('../../../services/creative/lib/definition.js',()=>({thisAgent:async()=>({loaded:{definition:{}}})}));
vi.mock('../src/catalogue.js',()=>({grantedToolNames:()=>['fixture']}));
const chiefPath=new URL('../../../services/chief-of-staff/agent/tools/catalogue.ts',import.meta.url).href;
const chief=(await import(chiefPath)).default;
const creativePath=new URL('../../../services/creative/agent/tools/catalogue.ts',import.meta.url).href;
const creative=(await import(creativePath)).default;
const approvalsPath=new URL('../../../services/chief-of-staff/lib/approvals.ts',import.meta.url).href;
const {humanTurnRefusal}=await import(approvalsPath);
const dist=pathToFileURL(fileURLToPath(new URL('../node_modules/eve/dist/src/',import.meta.url))).href;
const inc='11111111-1111-4111-8111-111111111111';
const auth=(purpose='human')=>({authenticator:'lares-console',attributes:{user_id:'owner@example.invalid',lares_member_id:'Owner-ID',lares_admission_nonce:'a'.repeat(43),lares_purpose:purpose}});
const context=(purpose='human')=>({session:{id:'wrun_test',turn:{id:'turn-1',sequence:0},auth:{current:auth(purpose),initiator:auth()}},abortSignal:new AbortController().signal,approvedTools:new Set(),callId:'call-1',toolInput:{},toolName:'fixture'});
afterEach(()=>{vi.unstubAllEnvs();fake.query.mockReset();fake.execute.mockReset();fake.approval.mockReset();});
describe('both catalogues guard real durable callbacks before underlying execution or approval policy',()=>{
 for(const [role,resolver] of [['chief',chief],['creative',creative]] as const){
  it(`${role}: preserves descriptors; resolver resumes and missing bindings refuse before policy`,async()=>{
   vi.stubEnv('LARES_AGENT_NAME','helper');vi.stubEnv('LARES_AGENT_INCARNATION',inc);vi.stubEnv('AGENT_OWNER_USER_ID','Owner-ID');
   const tool=(await (resolver.events['session.started'] as any)({},context())).fixture;
   const {validateDurableDynamicToolCallbacks}=await import(`${dist}context/dynamic-tool-lifecycle.js`);
   const callbacks=validateDurableDynamicToolCallbacks('fixture',tool,{sessionId:'wrun_test',scope:'session',resolverSlug:'catalogue',entryKey:'fixture',name:'fixture'});
   expect(callbacks.execute.closure).toEqual({name:'fixture'});expect(callbacks.approvalRequest.closure).toEqual({name:'fixture'});expect(callbacks.approvalResponse.closure).toEqual({name:'fixture'});
   await expect(tool.execute({},context('resolver'))).rejects.toThrow();
   await expect(tool.approval.request(context('resolver'))).rejects.toThrow();
   expect(fake.execute).not.toHaveBeenCalled();expect(fake.approval).not.toHaveBeenCalled();
   fake.query.mockResolvedValue({rows:[]});
   await expect(tool.approval.request(context())).rejects.toThrow();expect(fake.approval).not.toHaveBeenCalled();
   fake.query.mockResolvedValue({rows:[{agent:'helper',incarnation:inc,session_id:'wrun_test',member_id:'Owner-ID',admission_nonce:'a'.repeat(43),place_id:'place',audience_revision:1,policy_revision:1}]});
   fake.execute.mockResolvedValue('executed');fake.approval.mockResolvedValue('user-approval');
   await expect(tool.execute({},context())).resolves.toBe('executed');
   await expect(tool.approval.request(context())).rejects.toThrow('Exact approval');
   expect(fake.approval).not.toHaveBeenCalled();
  });
 }
 for(const [role,resolver] of [['chief',chief],['creative',creative]] as const){
  for(const optionId of ['approve','cancel']){
   it(`${role}: native Telegram ${optionId} with auth:null reaches Eve's legacy input resolver`,async()=>{
    const nativeAuth={current:null,initiator:{authenticator:'telegram',principalId:'fixture-owner',principalType:'user'}};
    const nativeContext={session:{id:'wrun_native',auth:nativeAuth,turn:{id:'native-turn',sequence:1}}};
    const tool=(await (resolver.events['session.started'] as any)({},nativeContext)).fixture;
    const {validateDurableDynamicToolCallbacks}=await import(`${dist}context/dynamic-tool-lifecycle.js`);
    const callbacks=validateDurableDynamicToolCallbacks('fixture',tool,{sessionId:'wrun_native',scope:'session',resolverSlug:'catalogue',entryKey:'fixture',name:'fixture'});
    expect(callbacks.approvalRequest).toBeDefined();expect(callbacks.approvalResponse).toBeUndefined();
    expect(tool.approval.response).toBeUndefined();
    const request={kind:'tool-approval',requestId:'native-request',prompt:'Fixture',options:[{id:'approve',label:'Approve'},{id:'cancel',label:'Cancel'}],action:{kind:'tool-call',callId:'native-call',toolName:'fixture',input:{}}};
    // This is the marker Eve's tool loop derives from the resolved response descriptor.
    const session={state:{'eve.runtime.pendingInputBatches':[{event:{sequence:0,stepIndex:0,turnId:'native-turn'},requests:[request],responseMessages:[],responseAuthRequiredRequestIds:tool.approval.response?['native-request']:[]}]}};
    const stepInput={attributedInputResponses:[{auth:null,response:{requestId:'native-request',optionId}}]};
    const {ContextContainer,contextStorage}=await import(`${dist}context/container.js`);
    const {coordinateApprovalDelivery}=await import(`${dist}harness/approval-delivery-coordinator.js`);
    const {resolvePendingInput}=await import(`${dist}harness/input-requests.js`);
    const container=new ContextContainer();container.set({name:'eve.session'},{sessionId:'wrun_native',auth:nativeAuth,turn:nativeContext.session.turn});
    const coordinated=await contextStorage.run(container,()=>coordinateApprovalDelivery({session,stepInput,tools:new Map([['fixture',tool]])}));
    expect(coordinated.feedback).toEqual([]);expect(coordinated.stepInput.inputResponses).toEqual([{requestId:'native-request',optionId}]);
    const resolved=resolvePendingInput({session:coordinated.session,stepInput:coordinated.stepInput,history:[]});
    expect(resolved.outcome).toBe('resolved');
    expect(resolved.resolvedInputs).toMatchObject([{inputs:[{request:{requestId:'native-request'},outcome:optionId==='approve'?'approved':'denied'}]}]);
   });
  }
  it(`${role}: strict response descriptors persist when cold refresh has only the tagged initiator`,async()=>{
   const c=context('resolver');c.session.auth.current=null as never;
   const tool=(await (resolver.events['session.started'] as any)({},c)).fixture;
   expect(typeof tool.approval.response).toBe('function');
   const r={request:{requestId:'strict',callId:'strict',toolName:'fixture',toolInput:{}},responder:null,session:{id:'wrun_test',initiator:auth(),turn:{id:'resolver',sequence:1}}};
   await expect(tool.approval.response(r)).rejects.toThrow();
  });
 }
 it('an approval resolver cannot become a new human instruction',()=>{
  expect(humanTurnRefusal({current:auth('resolver'),initiator:auth()},'Refused.',{LARES_AGENT_INCARNATION:inc,LARES_CONSOLE_PRINCIPAL:'owner@example.invalid'})).toContain('no new human instruction');
 });
});
