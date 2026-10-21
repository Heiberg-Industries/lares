import {beforeEach,it,expect,vi} from 'vitest';
const f=vi.hoisted(()=>({member:vi.fn(),query:vi.fn(),custody:vi.fn(),proposal:vi.fn(),reference:vi.fn(),binding:vi.fn(),session:vi.fn()}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>({value:'opaque-session'})})}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('../lib/auth',()=>({sessionMember:f.member,isConsoleOwner:()=>false}));
vi.mock('../lib/db',()=>({pool:{query:f.query}}));
vi.mock('../lib/accounts',()=>({consolePrincipal:()=>'',tokenEncKeyHex:()=> '1'.repeat(64)}));
vi.mock('@lares/agent-kit/account-store',()=>({PgAccountStore:class{withPersonalResourceCredential=f.custody;}}));
vi.mock('@lares/agent-kit/personal-action-store',()=>({PgPersonalActionStore:class{proposalInTransaction=f.proposal;},personalActionForRequest:f.reference}));
vi.mock('@lares/agent-kit/console-turn-authority',()=>({requireConsoleSessionBinding:f.binding}));
vi.mock('@lares/agent-kit/member-store',()=>({currentSession:f.session}));
import {readPersonalSendCard} from '../app/actions/accounts';
const selected={account:{id:'own-account',generation:3,connectorId:'google',providerAccount:{label:'VERIFIED_LABEL'}},resource:{id:'own-mailbox'}};
const payload={to:['recipient@example.invalid'],subject:'STORED_SUBJECT',body:'STORED_BODY'};
beforeEach(()=>{
 vi.resetAllMocks();f.member.mockResolvedValue({id:'member-a'});
 f.query.mockResolvedValue({rows:[{id:'action',account_id:'own-account',account_generation:3,resource_binding_id:'own-mailbox',agent:'helper',session_id:'private',incarnation:'11111111-1111-4111-8111-111111111111'}]});
 f.custody.mockImplementation(async(_member,_selection,_kind,work)=>work(selected,{},{}));
 f.proposal.mockResolvedValue({selection:{resourceBindingId:'own-mailbox'},payload});
 f.reference.mockResolvedValue({alive:true,approvalOutcome:null,outcome:{state:'awaiting_dispatch'}});
 f.binding.mockResolvedValue({});f.session.mockResolvedValue({id:'member-a'});
});
it('derives the account label and full body only from authenticated current stored action',async()=>{
 expect(await readPersonalSendCard('request')).toEqual({accountLabel:'VERIFIED_LABEL',connectorId:'google',accountId:'own-account',generation:3,resourceBindingId:'own-mailbox',...payload});
 expect(f.query).toHaveBeenCalledWith(expect.stringContaining('actor_member_id=$2'),['request','member-a']);
 expect(f.custody).toHaveBeenCalledWith('member-a',{accountId:'own-account',generation:3,resourceBindingId:'own-mailbox'},'mailbox',expect.any(Function));
 expect(f.session).toHaveBeenCalledWith({},'opaque-session','member-a',{lock:'share'});
});
it.each(['unauthenticated','wrong-member','retired-binding','cancelled','expired','logout','account-generation','tamper'] as const)('does not expose proposal data for %s',async failure=>{
 if(failure==='unauthenticated')f.member.mockResolvedValue(null);
 if(failure==='wrong-member')f.query.mockResolvedValue({rows:[]});
 if(failure==='retired-binding')f.binding.mockRejectedValue(new Error('PRIVATE BINDING'));
 if(failure==='cancelled')f.reference.mockResolvedValue({alive:true,approvalOutcome:'cancelled',outcome:{state:'cancelled'}});
 if(failure==='expired')f.reference.mockResolvedValue({alive:false,approvalOutcome:null,outcome:{state:'awaiting_dispatch'}});
 if(failure==='logout')f.session.mockResolvedValue(null);
 if(failure==='account-generation')f.custody.mockRejectedValue(new Error('PRIVATE ACCOUNT'));
 if(failure==='tamper')f.proposal.mockRejectedValue(new Error('PRIVATE CIPHERTEXT'));
 await expect(readPersonalSendCard('request')).rejects.toThrow(/Personal mail review/);
});
