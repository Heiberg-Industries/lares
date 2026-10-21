import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const m=vi.hoisted(()=>({member:vi.fn(),list:vi.fn()}));
vi.mock('../lib/auth',()=>({requireMember:m.member,isConsoleOwner:()=>false}));
vi.mock('../lib/db',()=>({pool:{}}));
vi.mock('@lares/agent-kit/account-store',()=>({PgAccountStore:class{list=m.list;}}));
vi.mock('../app/actions/accounts',()=>({removeAccount:vi.fn()}));
vi.mock('../app/actions/members',()=>({signOutEverywhere:vi.fn()}));
import MembershipPage from '../app/membership/page';
beforeEach(()=>{vi.clearAllMocks();m.member.mockResolvedValue({id:'member-a',role:'member'});m.list.mockResolvedValue([{id:'stable-account',connectorId:'google',providerAccount:{label:'Own mailbox'},generation:7,status:'ok'}]);});
it('lets a normal member manage only their personal account by stable ID and generation',async()=>{
 const html=renderToStaticMarkup(await MembershipPage({searchParams:Promise.resolve({})}));
 expect(m.list).toHaveBeenCalledWith('member-a');expect(html).toContain('Own mailbox');
 expect(html).toContain('name="accountId" value="stable-account"');expect(html).toContain('name="generation" value="7"');
 expect(html).toContain('name="intent" value="reconnect"');expect(html).toContain('name="intent" value="new"');
 expect(html).toContain('Agent use is pending integration');expect(html).not.toContain('Open the owner console');
});
it('renders unavailable and neutral flash text without claiming an empty list or exposing URL error text',async()=>{
 m.list.mockRejectedValue(new Error('PRIVATE DATABASE ERROR'));
 const html=renderToStaticMarkup(await MembershipPage({searchParams:Promise.resolve({error:'PRIVATE PROVIDER RESPONSE'})}));
 expect(html).toContain('Personal accounts unavailable');expect(html).not.toContain('No personal accounts');expect(html).not.toContain('PRIVATE');expect(html).not.toContain('name="intent"');
});

it('renders Microsoft account controls and escapes provider labels without exposing raw flash text',async()=>{
 m.list.mockResolvedValue([{id:'ms-account',connectorId:'microsoft',providerAccount:{label:'<script>secret</script>'},generation:2,status:'ok'}]);
 const html=renderToStaticMarkup(await MembershipPage({searchParams:Promise.resolve({added:'PRIVATE RAW RESPONSE'})}));
 expect(html).toContain('/api/accounts/microsoft/start'); expect(html).toContain('Reconnect Microsoft account');
 expect(html).toContain('Connect Microsoft work account'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>secret</script>'); expect(html).not.toContain('PRIVATE RAW');
});
