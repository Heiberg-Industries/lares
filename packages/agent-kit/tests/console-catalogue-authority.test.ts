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
   expect(callbacks.execute.closure).toEqual({name:'fixture'});expect(callbacks.approvalRequest.closure).toEqual({name:'fixture'});
   await expect(tool.execute({},context('resolver'))).rejects.toThrow('Conversation authority');
   await expect(tool.approval(context('resolver'))).rejects.toThrow('Conversation authority');
   expect(fake.execute).not.toHaveBeenCalled();expect(fake.approval).not.toHaveBeenCalled();
   fake.query.mockResolvedValue({rows:[]});
   await expect(tool.approval(context())).rejects.toThrow('Conversation authority');expect(fake.approval).not.toHaveBeenCalled();
   fake.query.mockResolvedValue({rows:[{agent:'helper',incarnation:inc,session_id:'wrun_test',member_id:'Owner-ID',admission_nonce:'a'.repeat(43),place_id:'place',audience_revision:1,policy_revision:1}]});
   fake.execute.mockResolvedValue('executed');fake.approval.mockResolvedValue('user-approval');
   await expect(tool.execute({},context())).resolves.toBe('executed');
   await expect(tool.approval(context())).resolves.toBe('user-approval');
  });
 }
 it('an approval resolver cannot become a new human instruction',()=>{
  expect(humanTurnRefusal({current:auth('resolver'),initiator:auth()},'Refused.',{LARES_AGENT_INCARNATION:inc,LARES_CONSOLE_PRINCIPAL:'owner@example.invalid'})).toContain('no new human instruction');
 });
});
