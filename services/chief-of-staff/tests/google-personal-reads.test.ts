import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { encryptSecret } from '@lares/agent-box/lib/crypto.js';
import { googlePersonalReads } from '../lib/google-personal-reads.js';
vi.mock('node:fs',async original=>{
  const fs=await original<typeof import('node:fs')>();
  return {...fs,readFileSync:(path:Parameters<typeof fs.readFileSync>[0],...args:unknown[])=>{
    const files:Record<string,string>={'/run/secrets/google-token-key':'1'.repeat(64),'/run/secrets/personal-google-acme-id':'client','/run/secrets/personal-google-acme-secret':'secret'};
    return typeof path==='string'&&Object.hasOwn(files,path)?files[path]:(fs.readFileSync as (...args:unknown[])=>unknown)(path,...args);
  }};
});
const window={from:'2026-10-01T00:00:00Z',until:'2026-10-02T00:00:00Z',limit:1};
const credential={orgId:'acme',refreshTokenEnc:encryptSecret('fixture-refresh','1'.repeat(64))};
let calls:{url:URL;signal:AbortSignal|null|undefined;redirect?:RequestRedirect}[],get:Record<string,unknown>,list:Record<string,unknown>,events:Record<string,unknown>;
let controller:AbortController,tokenStatus:number,resourceStatus:number,expiry:boolean;
beforeEach(()=>{
  vi.stubEnv('TOKEN_ENC_KEY_FILE','/run/secrets/google-token-key');
  vi.stubEnv('LARES_PERSONAL_GOOGLE_CLIENTS',JSON.stringify({acme:{clientIdFile:'/run/secrets/personal-google-acme-id',clientSecretFile:'/run/secrets/personal-google-acme-secret'}}));
  calls=[];controller=new AbortController();tokenStatus=200;resourceStatus=200;expiry=true;
  list={messages:[{id:'mail'}],nextPageToken:'do-not-follow'};
  get={id:'mail',internalDate:String(Date.parse('2026-10-01T01:00:00Z')),payload:{mimeType:'text/plain',headers:[{name:'From',value:'Sender <sender@example.invalid>'},{name:'Subject',value:'Subject'}],body:{data:Buffer.from('Private body').toString('base64url')}}};
  events={items:[{id:'event',start:{date:'2026-10-01'},end:{date:'2026-10-02'}}],nextPageToken:'do-not-follow'};
});
afterEach(()=>vi.unstubAllEnvs());
const fetcher=vi.fn<typeof fetch>(async(input,options)=>{
  const url=new URL(String(input));calls.push({url,signal:options?.signal,redirect:options?.redirect});options?.signal?.throwIfAborted();
  if(url.pathname.includes('token'))return Response.json({access_token:'fixture-access',...(expiry?{expires_in:3600}:{})},{status:tokenStatus});
  if(resourceStatus!==200)return Response.json({error:'fixture'},{status:resourceStatus});
  if(url.pathname.endsWith('/messages'))return Response.json(list);
  if(url.pathname.endsWith('/events'))return Response.json(events);
  return Response.json(get);
});
const open=()=>googlePersonalReads(credential,controller.signal,fetcher);
describe('neutral Google reads with actual OAuth and Google SDKs',()=>{
  it('uses users.me, verifies internalDate against exact window and reports provider truncation',async()=>{
    const result=await open().listMail(window);
    expect(result).toEqual({items:[{id:'mail',receivedAt:'2026-10-01T01:00:00.000Z'}],truncated:true});
    const resources=calls.filter(c=>!c.url.pathname.includes('token'));
    expect(resources.every(c=>c.url.pathname.includes('/users/me/'))).toBe(true);
    expect(calls.every(c=>c.signal===controller.signal&&c.redirect==='error')).toBe(true);
    expect(resources[0].url.searchParams.get('q')).toMatch(/^after:\d+ before:\d+$/);
    expect(resources[0].url.searchParams.get('maxResults')).toBe('2');expect(resources).toHaveLength(2);
  });
  it('filters second-granularity query boundary candidates using exact received timestamp',async()=>{
    get.internalDate=String(Date.parse(window.until));expect((await open().listMail(window)).items).toEqual([]);
  });
  it('reuses Gmail MIME mapping and selects an encoded calendar id without any owner fallback',async()=>{
    const adapter=open();expect(await adapter.readMail('mail')).toMatchObject({id:'mail',subject:'Subject',bodyText:'Private body',sentAt:null});
    expect(await adapter.listCalendar('opaque/calendar?x=#',window)).toEqual({items:[{id:'event',summary:null,start:'2026-10-01',end:'2026-10-02',startTimeZone:null,endTimeZone:null,allDay:true,location:null,cancelled:null}],truncated:true});
    const calendar=calls.find(c=>c.url.pathname.endsWith('/events'))!;
    expect(calendar.url.pathname).toContain('/calendars/opaque%2Fcalendar%3Fx%3D%23/events');expect(calendar.url.searchParams.get('timeMin')).toBe(window.from);
  });
  it('refuses wrong returned message id and malformed event times',async()=>{
    get.id='other';await expect(open().readMail('mail')).rejects.toThrow();events={items:[{id:'event'}]};await expect(open().listCalendar('selected',window)).rejects.toThrow();
  });
  it('fails closed for an unmounted exact org without any token request',()=>{
    expect(()=>googlePersonalReads({...credential,orgId:'ACME'},controller.signal,fetcher)).toThrow();expect(calls).toEqual([]);
  });
  it('prevents OAuth automatic re-refresh/replay after a401 with absent expiry',async()=>{
    expiry=false;resourceStatus=401;await expect(open().listMail(window)).rejects.toThrow();expect(calls).toHaveLength(2);
  });
  it('refuses a pre-aborted signal and does not retry refresh503',async()=>{
    controller.abort();await expect(open().listMail(window)).rejects.toThrow();expect(calls).toEqual([]);
    controller=new AbortController();tokenStatus=503;await expect(open().listMail(window)).rejects.toThrow();expect(calls).toHaveLength(1);
  });
});
