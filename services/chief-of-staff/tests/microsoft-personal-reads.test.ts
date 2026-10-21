/** Actual maintained OIDC + official Graph SDK, fake fetch only. No provider requests. */
import { beforeAll,beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { generateKeyPair,exportJWK,SignJWT } from 'jose';
import { encryptSecret,decryptSecret } from '@lares/agent-box/lib/crypto.js';
import { microsoftPersonalReads } from '../lib/microsoft-personal-reads.js';
import { personalReadOperationSchema } from '../lib/personal-reads.js';
const tenantId='11111111-2222-4333-8444-555555555555',subject='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const issuer=`https://login.microsoftonline.com/${tenantId}/v2.0`,key='1'.repeat(64);
const settings={tenantId,clientId:'data-client',clientSecret:'data-secret',tokenKeyHex:key};
const identity={issuer,tenantId,subject},scopes=['openid','offline_access','User.Read','Mail.Read','Calendars.Read'];
const window={from:'2026-10-01T00:00:00Z',until:'2026-10-02T00:00:00Z',limit:1};
let signing:Awaited<ReturnType<typeof generateKeyPair>>,jwk:Awaited<ReturnType<typeof exportJWK>>;
let claims:Record<string,unknown>,token:Record<string,unknown>,me:Record<string,unknown>,idToken:boolean,badSignature:boolean;
let page:Record<string,unknown>,mail:Record<string,unknown>,events:Record<string,unknown>,status:number;
let calls:{url:URL;signal:AbortSignal|null|undefined;redirect:RequestRedirect|undefined;headers:Headers;body:unknown}[];
let block:string|undefined,controller:AbortController,entered:()=>void,settled:boolean;
let tokenStatus:number,discoveryOverrides:Record<string,unknown>;
let rotation:ReturnType<typeof vi.fn>;
beforeAll(async()=>{signing=await generateKeyPair('RS256');jwk=await exportJWK(signing.publicKey);});
beforeEach(()=>{
  tokenStatus=200;discoveryOverrides={};calls=[];claims={};token={};me={id:subject,userType:'Member'};idToken=false;badSignature=false;status=200;block=undefined;settled=false;
  controller=new AbortController();rotation=vi.fn(async()=>{});entered=()=>{};
  page={value:[{id:'mail',receivedDateTime:'2026-10-01T01:00:00Z'}],'@odata.nextLink':'https://untrusted.invalid/do-not-follow'};
  mail={id:'mail',subject:'Subject',body:{contentType:'text',content:'Private body'},from:{emailAddress:{address:'sender@example.invalid'}}};
  events={value:[{id:'event',start:{dateTime:'2026-10-01T01:00:00.0000000',timeZone:'UTC'},end:{dateTime:'2026-10-01T02:00:00.0000000',timeZone:'UTC'}}]};
  vi.stubGlobal('fetch',vi.fn<typeof fetch>(async(input,options)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    calls.push({url,signal:options?.signal,redirect:options?.redirect,headers:new Headers(options?.headers),body:options?.body});
    options?.signal?.throwIfAborted();
    if(block && url.pathname.endsWith(block))return new Promise<Response>((_resolve,reject)=>{entered();options!.signal!.addEventListener('abort',()=>{settled=true;reject(options!.signal!.reason);},{once:true});});
    if(url.pathname.endsWith('openid-configuration'))return Response.json({issuer,authorization_endpoint:`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,token_endpoint:`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,jwks_uri:`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],...discoveryOverrides});
    if(url.pathname.endsWith('/keys'))return Response.json({keys:[{...jwk,kid:'test',alg:'RS256',use:'sig'}]});
    if(url.pathname.endsWith('/token')){
      let signed:string|undefined;
      if(idToken)signed=await new SignJWT({tid:tenantId,oid:subject,...claims}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(String(claims.iss??issuer)).setSubject('client-scoped').setAudience('data-client').setIssuedAt().setExpirationTime('5m').sign(badSignature?(await generateKeyPair('RS256')).privateKey:signing.privateKey);
      return Response.json({access_token:'opaque-access',refresh_token:'rotated-refresh',token_type:'Bearer',scope:scopes.join(' '),...(signed?{id_token:signed}:{}),...token},{status:tokenStatus});
    }
    if(url.hostname==='graph.microsoft.com'){
      if(status!==200)return Response.json({error:{code:'fixture',message:'PRIVATE ERROR'}},{status});
      if(url.pathname==='/v1.0/me')return Response.json(me);
      if(url.pathname==='/v1.0/me/messages')return Response.json(page);
      if(url.pathname.endsWith('/calendarView'))return Response.json(events);
      return Response.json(mail);
    }
    throw new Error('Unexpected fixture request');
  }));
});
afterEach(()=>vi.unstubAllGlobals());
const open=(overrides:Partial<Parameters<typeof microsoftPersonalReads>[0]>={})=>microsoftPersonalReads({settings,identity,credential:{orgId:'microsoft',scopes,refreshTokenEnc:encryptSecret('old-refresh',key)},signal:controller.signal,persistRotation:rotation,...overrides});
const resourceCalls=()=>calls.filter(c=>c.url.hostname==='graph.microsoft.com'&&c.url.pathname!=='/v1.0/me');
describe('private Microsoft reads, real SDKs',()=>{
  it('accepts no refresh ID token, verifies same-token /me then rotates encrypted custody and lists a bounded window',async()=>{
    const adapter=await open(),result=await adapter.listMail(window);
    expect(result).toEqual({items:[{id:'mail',receivedAt:'2026-10-01T01:00:00.000Z'}],truncated:true});
    expect(decryptSecret(rotation.mock.calls[0][0] as string,key)).toBe('rotated-refresh');
    expect(resourceCalls()).toHaveLength(1);
    expect(calls.every(c=>c.signal===controller.signal&&c.redirect==='error')).toBe(true);
    expect(calls.filter(c=>c.url.hostname==='graph.microsoft.com').every(c=>c.headers.get('authorization')==='Bearer opaque-access'&&!c.headers.has('sdkversion'))).toBe(true);
    const refresh=calls.find(c=>c.url.pathname.endsWith('/token'))!;
    expect(String(refresh.body)).toContain('grant_type=refresh_token');expect(String(refresh.body)).not.toContain('.default');
    expect(resourceCalls()[0].url.searchParams.get('$top')).toBe('2');
  });
  it('preserves positive-offset window instants in actual SDK mail and calendar queries',async()=>{
    const operation=personalReadOperationSchema.parse({kind:'mailWindow',window:{from:'2026-10-01T00:00:00+02:00',until:'2026-10-02T00:00:00+02:00',limit:1}});
    if(operation.kind!=='mailWindow')throw new Error('Unexpected fixture operation');
    const adapter=await open();
    await adapter.listMail(operation.window);
    await adapter.listCalendar('selected-calendar',operation.window);
    const [mailRequest,calendarRequest]=resourceCalls();
    expect(mailRequest.url.searchParams.get('$filter')).toBe('receivedDateTime ge 2026-09-30T22:00:00.000Z and receivedDateTime lt 2026-10-01T22:00:00.000Z');
    expect(calendarRequest.url.searchParams.get('startDateTime')).toBe('2026-09-30T22:00:00.000Z');
    expect(calendarRequest.url.searchParams.get('endDateTime')).toBe('2026-10-01T22:00:00.000Z');
  });
  it('validates a returned signed refresh ID token without using sub or email as account authority',async()=>{
    idToken=true;claims={sub:'different-sub',email:'another@example.invalid'};
    await expect(open()).resolves.toBeDefined();expect(calls.some(c=>c.url.pathname.endsWith('/keys'))).toBe(true);
  });
  it.each([{tid:'99999999-2222-4333-8444-555555555555'},{oid:'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'},{idp:'live.com'}])('refuses contradictory signed claims %s',async changed=>{idToken=true;claims=changed;await expect(open()).rejects.toThrow();expect(resourceCalls()).toEqual([]);expect(rotation).not.toHaveBeenCalled();});
  it('refuses bad JWS before Graph',async()=>{idToken=true;badSignature=true;await expect(open()).rejects.toThrow();expect(calls.filter(c=>c.url.hostname==='graph.microsoft.com')).toEqual([]);});
  it.each([{scope:undefined},{scope:'User.Read Mail.Read Calendars.Read Mail.Send'},{scope:'User.Read Mail.Read Calendars.Read'}])('refuses changed/missing actual scope response %s',async changed=>{token=changed;await expect(open()).rejects.toThrow();expect(resourceCalls()).toEqual([]);expect(rotation).not.toHaveBeenCalled();});
  it.each([{id:'another-object'},{userType:'Guest'},{userType:undefined}])('refuses /me mismatch before any resource or rotation %s',async changed=>{Object.assign(me,changed);await expect(open()).rejects.toThrow();expect(resourceCalls()).toEqual([]);expect(rotation).not.toHaveBeenCalled();});
  it.each([{identity:{...identity,tenantId:'wrong'}},{identity:{...identity,issuer:'https://wrong.invalid'}},{credential:{orgId:'legacy',scopes,refreshTokenEnc:'no'}}])('refuses invalid trusted binding before network %s',async changed=>{await expect(open(changed)).rejects.toThrow();expect(calls).toEqual([]);});
  it('encodes opaque IDs, uses selected calendar only, maps missing optional fields honestly',async()=>{
    const adapter=await open(),id='opaque/with?query=#percent%';mail.id=id;
    expect(await adapter.readMail(id)).toMatchObject({id,threadId:null,to:null,cc:null,sentAt:null});
    const result=await adapter.listCalendar(id,window);expect(result.items[0]).toMatchObject({summary:null,allDay:null,cancelled:null,start:'2026-10-01T01:00:00.000Z'});
    expect(resourceCalls().map(c=>c.url.pathname)).toEqual([`/v1.0/me/messages/${encodeURIComponent(id)}`,`/v1.0/me/calendars/${encodeURIComponent(id)}/calendarView`]);
    expect(resourceCalls()[0].url.search).not.toContain('query');
    await expect(adapter.readMail('..')).rejects.toThrow();expect(resourceCalls()).toHaveLength(2);
  });
  it('requires plaintext body and matching id; unavailable optional headers remain unknown',async()=>{
    const adapter=await open();mail.body={contentType:'html',content:'<b>html</b>'};await expect(adapter.readMail('mail')).rejects.toThrow();
    mail.body={contentType:'text',content:''};mail.id='wrong';await expect(adapter.readMail('mail')).rejects.toThrow();
  });
  it.each([302,429,503])('does not follow redirects or retry Graph status%s',async code=>{status=code;await expect(open()).rejects.toThrow();expect(calls.filter(c=>c.url.hostname==='graph.microsoft.com')).toHaveLength(1);});
  it.each([302,429,503])('does not retry/redirect refresh status%s',async code=>{tokenStatus=code;await expect(open()).rejects.toThrow();expect(calls.filter(c=>c.url.pathname.endsWith('/token'))).toHaveLength(1);expect(calls.filter(c=>c.url.hostname==='graph.microsoft.com')).toEqual([]);});
  it.each([{token_endpoint:'https://untrusted.invalid/token'},{jwks_uri:'https://untrusted.invalid/keys'}])('refuses unpinned discovery endpoint%s before token',async changed=>{discoveryOverrides=changed;await expect(open()).rejects.toThrow();expect(calls).toHaveLength(1);});
  it('refuses before discovery on an expired deadline',async()=>{controller.abort();await expect(open()).rejects.toThrow();expect(calls).toEqual([]);});
  it.each(['openid-configuration','/token','/me','/messages'])('waits for cancelled %s transport to settle',async stage=>{
    block=stage;let ready!:()=>void;const waiting=new Promise<void>(resolve=>{ready=resolve;});entered=ready;
    const running=stage==='/messages'?open().then(a=>a.listMail(window)):open();const refused=expect(running).rejects.toThrow();
    await waiting;controller.abort();await refused;expect(settled).toBe(true);expect(calls.filter(c=>c.url.pathname.endsWith(stage))).toHaveLength(1);
  });
  it('does not start a resource after deadline expires between identity and read',async()=>{const adapter=await open();controller.abort();await expect(adapter.listMail(window)).rejects.toThrow();expect(resourceCalls()).toEqual([]);});
  it('refuses invalid or excessive neutral windows before any provider adapter',()=>{
    for(const changed of [{until:window.from},{until:'2027-01-01T00:00:00Z'},{limit:101},{query:'from:someone'}])expect(()=>personalReadOperationSchema.parse({kind:'mailWindow',window:{...window,...changed}})).toThrow();
  });
});

it('reads and rotates a stored eight-scope send grant using the exact same effective scope set',async()=>{
  const granted=[...scopes,'profile','email','Mail.Send'];
  token={scope:granted.map(s=>['User.Read','Mail.Read','Calendars.Read','Mail.Send'].includes(s)?`https://graph.microsoft.com/${s}`:s).reverse().join(' ')};
  const adapter=await open({credential:{orgId:'microsoft',scopes:granted,refreshTokenEnc:encryptSecret('old-refresh',key)}});
  expect(await adapter.readMail('mail')).toMatchObject({id:'mail'});expect(rotation).toHaveBeenCalledOnce();
  const refresh=calls.find(c=>c.url.pathname.endsWith('/token'))!;
  expect(new URLSearchParams(String(refresh.body)).get('scope')).toBe(granted.join(' '));
});
it.each(['Mail.Send.Shared','Mail.Read.Shared','.default','Mail.ReadWrite','https://untrusted.invalid/Mail.Send'])('refuses forbidden stored permission %s before discovery',async scope=>{
  await expect(open({credential:{orgId:'microsoft',scopes:[...scopes,scope],refreshTokenEnc:encryptSecret('old-refresh',key)}})).rejects.toThrow();expect(calls).toEqual([]);
});
it('refuses loss of sending permission during refresh without rotating custody or reading Graph',async()=>{
  await expect(open({credential:{orgId:'microsoft',scopes:[...scopes,'Mail.Send'],refreshTokenEnc:encryptSecret('old-refresh',key)}})).rejects.toThrow();
  expect(calls.filter(c=>c.url.hostname==='graph.microsoft.com')).toEqual([]);expect(rotation).not.toHaveBeenCalled();
});
