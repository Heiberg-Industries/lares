import {beforeEach,it,expect,vi} from 'vitest';
import {signAccountState,verifyAccountState} from '../lib/account-oauth-state';
const mocks=vi.hoisted(()=>({query:vi.fn(),store:vi.fn(),keeper:vi.fn(),profile:vi.fn(),consent:vi.fn()}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>({value:'session'})})}));
vi.mock('../lib/auth',()=>({verify:async()=>'owner@example.test'}));
vi.mock('../lib/db',()=>({pool:{query:mocks.query}}));
vi.mock('../lib/keeper-client',()=>({keeper:mocks.keeper}));
vi.mock('@lares/agent-box/lib/oauth-tokens.js',()=>({storeToken:mocks.store}));
vi.mock('../lib/accounts',()=>({consolePrincipal: () => 'legacy',googleOrgClientConfig:()=>({clientId:'id',clientSecret:'secret'}),tokenEncKeyHex:()=>'key',googleOrgs:()=>[{id:'tenant'}],orgDomains:()=>({}),resolveOrgForEmail:()=>({org:'tenant'})}));
vi.mock('../lib/account-oauth',()=>({consoleOrigin:()=>'https://console.example.test',callbackRedirect:(origin:string,p:Record<string,string>)=>`${origin}/integrations?${new URLSearchParams(p)}`,buildConsentUrl:(p:unknown)=>{mocks.consent(p);return 'https://accounts.google.com/consent';}}));
vi.mock('googleapis',()=>({google:{auth:{OAuth2:class {getToken=async()=>({tokens:{refresh_token:'refresh',scope:'gmail.readonly'}});setCredentials=()=>{};}},gmail:()=>({users:{getProfile:mocks.profile}})}}));
import {GET} from '../app/api/accounts/google/callback/route';
import {POST} from '../app/api/accounts/google/start/route';
const identity={org:'tenant',principal:'explicit',email:'owner@example.test'};
const binding={agent:'example',incarnation:'11111111-1111-4111-8111-111111111111',mailbox:'selected@example.test'};
const callback=(managed=true)=>GET(new Request(`https://console.example.test/api/accounts/google/callback?code=code&state=${signAccountState({...identity,...(managed?binding:{})})}`));
beforeEach(()=>{vi.clearAllMocks();process.env.CONSOLE_PRINCIPAL_ID='explicit';process.env.CONSOLE_SESSION_SECRET='test';mocks.query.mockResolvedValue({rows:[{ownership_token:binding.incarnation}]});mocks.profile.mockResolvedValue({data:{emailAddress:binding.mailbox}});});
it('signs the selected managed mailbox separately from the authenticated owner',async()=>{
 const form=new FormData();form.set('email',binding.mailbox);form.set('agent',binding.agent);
 expect((await POST(new Request('https://console.example.test/start',{method:'POST',body:form}))).status).toBe(303);
 expect(verifyAccountState(mocks.consent.mock.calls[0][0].state)).toEqual({ok:true,data:{...identity,...binding}});
});
it('rejects a different Google profile before any token store or agent binding',async()=>{
 mocks.profile.mockResolvedValue({data:{emailAddress:'different@example.test'}});
 const result=await callback();expect(result.headers.get('location')).toContain('error=');
 expect(mocks.store).not.toHaveBeenCalled();expect(mocks.keeper).not.toHaveBeenCalled();
});
it('stores and binds the matching selected mailbox',async()=>{
 const result=await callback();expect(result.headers.get('location')).toContain('/agents/example/edit');
 expect(mocks.store).toHaveBeenCalledWith(expect.anything(),'key',expect.objectContaining({emailAddress:binding.mailbox}));
 expect(mocks.keeper).toHaveBeenCalledWith('email.connect',expect.objectContaining({mailbox:binding.mailbox}),'owner@example.test');
});
it('preserves unmanaged OAuth acceptance and Integrations return for Google-selected mailbox',async()=>{
 mocks.profile.mockResolvedValue({data:{emailAddress:'another@example.test'}});
 expect((await callback(false)).headers.get('location')).toContain('added=another');
 expect(mocks.store).toHaveBeenCalledWith(expect.anything(),'key',expect.objectContaining({emailAddress:'another@example.test'}));
 expect(mocks.keeper).not.toHaveBeenCalled();expect(mocks.query).not.toHaveBeenCalled();
});

it('refuses managed consent when the runtime-authority lookup returns no current resource',async()=>{
 mocks.query.mockResolvedValue({rows:[]});
 const form=new FormData();form.set('email',binding.mailbox);form.set('agent',binding.agent);
 const response=await POST(new Request('https://console.example.test/start',{method:'POST',body:form}));
 expect(response.status).toBe(400);expect(mocks.consent).not.toHaveBeenCalled();
});
it('refuses stale or revoked managed callback before storing a token or binding a mailbox',async()=>{
 mocks.query.mockResolvedValue({rows:[]});
 const response=await callback();expect(response.headers.get('location')).toContain('error=');
 expect(mocks.store).not.toHaveBeenCalled();expect(mocks.keeper).not.toHaveBeenCalled();
});
