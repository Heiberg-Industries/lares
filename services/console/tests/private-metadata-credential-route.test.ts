import {expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';

const mocks=vi.hoisted(()=>({keeper:vi.fn()}));
vi.mock('../lib/keeper-client',async original=>({...await original<typeof import('../lib/keeper-client')>(),keeper:mocks.keeper}));
import {POST} from '../app/api/private-metadata/credential/route';
import {middleware} from '../middleware';
const token='T'.repeat(43);
const request=(body:unknown,authorization=`Bearer ${token}`)=>new Request('https://console.example/api/private-metadata/credential',{
  method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(body)});

it('relays only bearer plus requested scope and returns server-derived generation zero without caching',async()=>{
  mocks.keeper.mockResolvedValue({accountId:'account-1',datasetId:'dataset-1',scope:'read',generation:0});
  const response=await POST(request({scope:'read'}));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ok:true,accountId:'account-1',datasetId:'dataset-1',scope:'read',generation:0});
  expect(response.headers.get('cache-control')).toBe('no-store, private');
  expect(mocks.keeper).toHaveBeenCalledWith('private-metadata.credential.validate',{token,scope:'read'},'private-metadata-server@localhost.invalid');
});

it('passes the exact machine POST through real middleware and lets the route reject a missing bearer',async()=>{
  const request=new NextRequest('https://console.example/api/private-metadata/credential',{method:'POST',headers:{'content-type':'application/json'},body:'{"scope":"read"}'});
  const gate=await middleware(request);
  expect(gate.headers.get('x-middleware-next')).toBe('1');
  const response=await POST(request);
  expect(response.status).toBe(401);
  expect(mocks.keeper).not.toHaveBeenCalled();
});

it('does not exempt validator queries or other browser mutation paths from origin protection',async()=>{
  const wrongPath=new NextRequest('https://console.example/api/private-metadata/credential?scope=read',{method:'POST'});
  expect((await middleware(wrongPath)).status).toBe(403);
  const other=new NextRequest('https://console.example/api/private-metadata/credential/revoke',{method:'POST'});
  expect((await middleware(other)).status).toBe(403);
});

it('rejects caller-supplied identity and malformed bearer before the Keeper relay',async()=>{
  for(const [body,bearer] of [[{scope:'read',memberId:'member-b'},`Bearer ${token}`],[{scope:'read'},'Bearer invalid']] as const){
    const response=await POST(request(body,bearer));
    expect(response.status).toBe(body.scope==='read'&&bearer==='Bearer invalid'?401:400);
  }
  expect(mocks.keeper).not.toHaveBeenCalled();
});
