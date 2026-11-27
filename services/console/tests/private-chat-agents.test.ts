import {beforeEach,describe,expect,it,vi} from 'vitest';
const fake=vi.hoisted(()=>({query:vi.fn(),release:vi.fn(),visible:vi.fn(),connect:vi.fn()}));
vi.mock('../lib/db',()=>({pool:{connect:fake.connect}}));
vi.mock('@lares/agent-kit/grant-store',()=>({PgGrantStore:class {listVisible=fake.visible;}}));
import {listPrivateChatAgents} from '../lib/agents';
const member={id:'Member-ID',organisationId:'org',role:'member' as const,status:'active' as const,automationMode:'draft-and-ask' as const};
beforeEach(()=>{vi.clearAllMocks();fake.connect.mockResolvedValue({query:fake.query,release:fake.release});fake.query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{name:'allowed',display_name:'Allowed agent',role:'chief-of-staff',grants:'PRIVATE',skills:'PRIVATE'}]:[]}));});
describe('private chat identity listing',()=>{
 it('queries ready metadata only for use-authorised resources and returns the minimal DTO',async()=>{
  fake.visible.mockResolvedValue([{resource:{id:'allowed'},permissions:['use']},{resource:{id:'editor-only'},permissions:['edit']}]);
  expect(await listPrivateChatAgents(member)).toEqual([{name:'allowed',displayName:'Allowed agent',role:'Chief of Staff'}]);
  const [sql,values]=fake.query.mock.calls.find(([sql])=>sql.startsWith('SELECT'))!;
  expect(values).toEqual([['allowed']]);expect(sql).toContain("NOT r.pending");expect(sql).toContain("d.status='valid'");
  expect(sql).not.toMatch(/grants|autonomy|skills|doors|tools|started_at|count\(/);
  expect(fake.visible).toHaveBeenCalledWith(member.id,'agent',{db:expect.any(Object)});expect(fake.release).toHaveBeenCalledOnce();
 });
 it('carries the picture version so Chat shows the agent\'s picture, and none when there is no picture',async()=>{
  fake.visible.mockResolvedValue([{resource:{id:'allowed'},permissions:['use']},{resource:{id:'plain'},permissions:['use']}]);
  fake.query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{name:'allowed',display_name:'Allowed agent',role:'chief-of-staff',avatar_version:'1700000000.5'},{name:'plain',display_name:'Plain agent',role:'creative',avatar_version:null}]:[]}));
  const agents=await listPrivateChatAgents(member);
  expect(agents[0]).toEqual({name:'allowed',displayName:'Allowed agent',role:'Chief of Staff',avatarVersion:'1700000000.5'});
  expect(agents[1]).not.toHaveProperty('avatarVersion');
  expect(fake.query.mock.calls.find(([sql])=>sql.startsWith('SELECT'))![0]).toContain('LEFT JOIN agent_avatars');
 });
 it('does not query metadata for ungranted or edit-only callers',async()=>{
  fake.visible.mockResolvedValue([{resource:{id:'editor-only'},permissions:['edit']}]);
  expect(await listPrivateChatAgents(member)).toEqual([]);expect(fake.query.mock.calls.some(([sql])=>sql.startsWith('SELECT'))).toBe(false);
 });
});
