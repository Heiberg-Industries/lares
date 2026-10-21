import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({owner:vi.fn(),adopt:vi.fn(),update:vi.fn()}));
vi.mock('../lib/auth',()=>({requireConsoleMember:mocks.owner}));
vi.mock('../lib/agent-access',()=>({agentAccess:{adoptAgent:mocks.adopt,updateAgentAccess:mocks.update}}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>({value:'session-token'})})}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
import { adoptAgent,saveAgentAccess } from '../app/actions/agent-access';
import { GrantStoreError } from '@lares/agent-kit/grant-store';
const form=(values:Record<string,string|string[]>)=>{const result=new FormData();for(const [key,value] of Object.entries(values))for(const item of Array.isArray(value)?value:[value])result.append(key,item);return result;};
beforeEach(()=>{vi.clearAllMocks();mocks.owner.mockReset().mockResolvedValue({id:'owner',organisationId:'org'});mocks.adopt.mockResolvedValue({});mocks.update.mockResolvedValue({});vi.stubEnv('AGENT_OWNER_USER_ID','owner');});
describe('agent access administrator input boundary',()=>{
  it('adopts the authenticated identity with trusted designation, session and current definition fingerprint',async()=>{
    expect(await adoptAgent({},form({agentName:'assistant',definitionHash:'current',ownerId:'attacker'}))).toEqual({saved:true});
    expect(mocks.adopt).toHaveBeenCalledWith('owner',{agentName:'assistant',expectedDefinitionHash:'current'},{designatedOwnerMemberId:'owner',sessionToken:'session-token'});
  });
  it('rejects every operation before mutation if console admission fails',async()=>{
    mocks.owner.mockRejectedValue(new Error('refused'));
    await expect(adoptAgent({},form({agentName:'assistant',definitionHash:'current'}))).rejects.toThrow('refused');
    await expect(saveAgentAccess({},form({agentName:'assistant',revision:'1',use:'organisation'}))).rejects.toThrow('refused');
    expect(mocks.adopt).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled();
  });
  it('takes organisation and actor only from admission and records named edit distinctly',async()=>{
    await saveAgentAccess({},form({agentName:'assistant',revision:'7',use:'organisation',organisationId:'other',actorId:'other',editors:['second']}));
    expect(mocks.update).toHaveBeenCalledWith('owner',{agentName:'assistant',expectedRevision:7,grants:[{principal:{kind:'organisation',id:'org'},permission:'use',expiresAt:null},{principal:{kind:'member',id:'second'},permission:'edit',expiresAt:null}]},{sessionToken:'session-token'});
  });
  it('supports personal revocation and named use with explicit UTC expiry',async()=>{
    await saveAgentAccess({},form({agentName:'assistant',revision:'8',use:'personal',readers:['ignored']}));
    expect(mocks.update).toHaveBeenLastCalledWith('owner',{agentName:'assistant',expectedRevision:8,grants:[]},expect.any(Object));
    await saveAgentAccess({},form({agentName:'assistant',revision:'9',use:'named',readers:['second'],expiresAt:'2030-01-01T12:30'}));
    expect(mocks.update).toHaveBeenLastCalledWith('owner',{agentName:'assistant',expectedRevision:9,grants:[{principal:{kind:'member',id:'second'},permission:'use',expiresAt:'2030-01-01T12:30:00.000Z'}]},expect.any(Object));
  });
  it('refuses malformed revision, selection, duplicate grants and expiry',async()=>{
    for(const change of ([{revision:'1e1'},{revision:'9007199254740992'},{use:'place'},{readers:['second','second']},{expiresAt:'garbage'}] as Record<string,string|string[]>[]))expect((await saveAgentAccess({},form({agentName:'assistant',revision:'1',use:'named',...change}))).error).toBeTruthy();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('reports stale and setup-needed refusals without returning database details',async()=>{
    mocks.update.mockRejectedValue(new GrantStoreError('stale'));expect((await saveAgentAccess({},form({agentName:'assistant',revision:'1',use:'personal'}))).error).toContain('Reload');
    mocks.adopt.mockRejectedValue(new GrantStoreError('denied'));expect((await adoptAgent({},form({agentName:'assistant',definitionHash:'current'}))).error).toContain('owner capability policy');
  });
});
