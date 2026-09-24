import {describe,it,expect,vi} from 'vitest';
import {forwardDoor} from '../lib/door-forwarder';
const row={address:'172.29.0.10/32',role:'creative',enabled:true,applied:true,runtime_control_token:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',incarnation:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
function deps(value:any=row) {return {query:vi.fn(async()=>({rows:value?[value]:[]})),fetch:vi.fn(async()=>new Response('ok'))};}
const request=(body=' { "type": "url_verification" } ')=>(new Request('https://doors.example.com/api/doors/author/slack/events',{method:'POST',body,headers:{'x-slack-signature':'v0=signature','x-slack-request-timestamp':'123','authorization':'malicious','cookie':'session'}}));
describe('bounded door forwarding',()=>{
 it('preserves exact bytes and platform headers to fixed registered route',async()=>{
   const d=deps();expect((await forwardDoor(request(),'author','slack',d)).status).toBe(200);
   const [url,init]=d.fetch.mock.calls[0] as any;
   expect(url).toBe('http://172.29.0.10:3000/eve/v1/slack');
   expect(new TextDecoder().decode(init.body)).toBe(' { "type": "url_verification" } ');
   expect(init.headers.get('x-slack-signature')).toBe('v0=signature');
   expect(init.headers.has('authorization')).toBe(false);expect(init.headers.has('cookie')).toBe(false);
   expect(init.redirect).toBe('error');
 });
 it.each([null,{...row,enabled:false},{...row,applied:false},{...row,runtime_control_token:null},{...row,runtime_control_token:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},{...row,role:'travel'},{...row,address:'evil.example.com'},{...row,address:'127.0.0.1'}])('refuses unavailable or unowned runtime %#',async value=>{
   const d=deps(value);expect((await forwardDoor(request(),'author','slack',d)).status).toBe(404);expect(d.fetch).not.toHaveBeenCalled();
 });
 it('refuses arbitrary name/kind before lookup',async()=>{const d=deps();expect((await forwardDoor(request(),'../admin','runtime',d)).status).toBe(404);expect(d.query).not.toHaveBeenCalled();});
 it('bounds body before forwarding',async()=>{const d=deps();expect((await forwardDoor(request('x'.repeat(262145)),'author','slack',d)).status).toBe(413);expect(d.fetch).not.toHaveBeenCalled();});
 it('does not forward upstream response cookies',async()=>{const d=deps();d.fetch.mockResolvedValue(new Response('ok',{headers:{'set-cookie':'bad','content-type':'text/plain'}}));expect((await forwardDoor(request(),'author','slack',d)).headers.has('set-cookie')).toBe(false);});
});
