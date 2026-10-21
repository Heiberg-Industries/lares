/** Actual maintained OAuth + provider SDKs. Every network response is synthetic. */
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { encryptSecret,decryptSecret } from '@lares/agent-box/lib/crypto.js';
import { ProxyAgent } from 'undici';
import { googlePersonalSend } from '../lib/google-personal-send.js';
import { microsoftPersonalSend } from '../lib/microsoft-personal-send.js';
vi.mock('node:fs',async original=>{
  const fs=await original<typeof import('node:fs')>();
  return {...fs,readFileSync:(path:Parameters<typeof fs.readFileSync>[0],...args:unknown[])=>{
    const files:Record<string,string>={'/run/secrets/google-token-key':'1'.repeat(64),'/run/secrets/personal-google-acme-id':'client','/run/secrets/personal-google-acme-secret':'secret'};
    return typeof path==='string'&&Object.hasOwn(files,path)?files[path]:(fs.readFileSync as (...args:unknown[])=>unknown)(path,...args);
  }};
});
const key='1'.repeat(64),tenantId='11111111-2222-4333-8444-555555555555',subject='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const issuer=`https://login.microsoftonline.com/${tenantId}/v2.0`;
const scopes={google:['openid','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/calendar.readonly','https://www.googleapis.com/auth/gmail.send'],
  microsoft:['openid','offline_access','User.Read','Mail.Read','Calendars.Read','Mail.Send']};
const payload={to:['recipient@example.invalid','second@example.invalid'],subject:'Subject æ',body:'Plaintext\nOne more line'};
let calls:{url:URL;method:string;body:unknown;signal:AbortSignal|null|undefined;redirect:RequestRedirect|undefined;headers:Headers;agent:unknown;dispatcher:unknown}[];
let status:number,tokenStatus:number,wrongIdentity:boolean,badScopes:boolean,malformed:boolean,timeout:boolean,requestId:string|null;
let proxy:ProxyAgent;
let controller:AbortController,rotation:ReturnType<typeof vi.fn>;
const mutations=()=>calls.filter(c=>c.url.pathname.endsWith('/messages/send')||c.url.pathname.endsWith('/sendMail'));
beforeEach(()=>{
  calls=[];status=200;tokenStatus=200;wrongIdentity=false;badScopes=false;malformed=false;timeout=false;requestId=null;
  controller=new AbortController();rotation=vi.fn(async()=>{});proxy=new ProxyAgent('http://proxy:8888');
  vi.stubEnv('EGRESS_PROXY_URL','http://proxy:8888');
  vi.stubEnv('TOKEN_ENC_KEY_FILE','/run/secrets/google-token-key');
  vi.stubEnv('LARES_PERSONAL_GOOGLE_CLIENTS',JSON.stringify({acme:{clientIdFile:'/run/secrets/personal-google-acme-id',clientSecretFile:'/run/secrets/personal-google-acme-secret'}}));
  vi.stubGlobal('fetch',vi.fn<typeof fetch>(async(input,options)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    calls.push({url,method:options?.method??'GET',body:options?.body,signal:options?.signal,redirect:options?.redirect,headers:new Headers(options?.headers),agent:(options as any)?.agent,dispatcher:(options as any)?.dispatcher});
    options?.signal?.throwIfAborted();
    if(url.pathname.endsWith('/messages/send')||url.pathname.endsWith('/sendMail')){
      if(timeout){controller.abort();options?.signal?.throwIfAborted();}
      if(status!==200)return Response.json({error:{code:'fixture',message:'PRIVATE PROVIDER ERROR'}},{status});
      if(url.pathname.endsWith('/sendMail'))return new Response(null,{status:202,headers:requestId?{'request-id':requestId}:{}});
      return Response.json(malformed?{}:{id:'real_message_id'});
    }
    if(url.pathname.endsWith('/tokeninfo'))return Response.json({aud:'client',sub:wrongIdentity?'wrong':subject,expires_in:3600,scope:(badScopes?scopes.google.slice(0,-1):scopes.google).join(' ')});
    if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'google-access',refresh_token:'rotated-google',token_type:'Bearer'},{status:tokenStatus});
    if(url.pathname.endsWith('/profile'))return Response.json({emailAddress:'own@example.invalid'});
    if(url.pathname.endsWith('openid-configuration'))return Response.json({issuer,authorization_endpoint:`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,token_endpoint:`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,jwks_uri:`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256']});
    if(url.pathname.endsWith('/token'))return Response.json({access_token:'ms-access',refresh_token:'rotated-ms',token_type:'Bearer',scope:(badScopes?scopes.microsoft.slice(0,-1):scopes.microsoft).join(' ')},{status:tokenStatus});
    if(url.pathname==='/v1.0/me')return Response.json({id:wrongIdentity?'wrong':subject,userType:'Member'});
    throw new Error(`Unexpected fixture URL ${url}`);
  }));
});
afterEach(async()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();await proxy.close();});
async function open(provider:'google'|'microsoft'){
  const credential={orgId:provider==='google'?'acme':'microsoft',refreshTokenEnc:encryptSecret('old-refresh',key),scopes:scopes[provider],emailAddress:'own@example.invalid'};
  return provider==='google'?googlePersonalSend({identity:{issuer:'https://accounts.google.com',subject},credential,signal:controller.signal,persistRotation:rotation,fetch}):
    microsoftPersonalSend({settings:{tenantId,clientId:'data-client',clientSecret:'data-secret',tokenKeyHex:key},identity:{issuer,tenantId,subject},credential,signal:controller.signal,persistRotation:rotation,dispatcher:proxy,fetch});
}
describe.each(['google','microsoft'] as const)('%s own plaintext write with actual SDK',provider=>{
  it('refreshes and verifies identity before sending exact payload once; refuses reusing the adapter',async()=>{
    const adapter=await open(provider);expect(mutations()).toEqual([]);
    const result=await adapter.send(payload);
    expect(result).toEqual(provider==='google'?{state:'accepted',providerReceiptId:'real_message_id'}:{state:'accepted',providerStatus:202});
    await expect(adapter.send(payload)).rejects.toThrow();expect(mutations()).toHaveLength(1);
    expect(calls.every(c=>c.signal===controller.signal&&c.redirect==='error')).toBe(true);
    if(provider==='microsoft')expect(calls.every(c=>c.dispatcher===proxy)).toBe(true);
    else expect(calls.every(c=>(c.agent as {proxy?:URL})?.proxy?.href==='http://proxy:8888/')).toBe(true);
    expect(decryptSecret(rotation.mock.calls[0][0] as string,key)).toBe(provider==='google'?'rotated-google':'rotated-ms');
    const body=JSON.parse(String(mutations()[0].body));
    if(provider==='microsoft')expect(body).toEqual({message:{subject:payload.subject,body:{contentType:'Text',content:payload.body},toRecipients:payload.to.map(address=>({emailAddress:{address}}))}});
    else {
      expect(Object.keys(body)).toEqual(['raw']);const raw=Buffer.from(body.raw,'base64url').toString('utf8');
      expect(raw).toContain('From: own@example.invalid');expect(raw).toContain('To: recipient@example.invalid,\r\n second@example.invalid');
      expect(raw).not.toMatch(/(?:^|\r\n)(?:Cc|Bcc|In-Reply-To|References):/);
      expect(Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g,''),'base64').toString('utf8')).toBe(payload.body);
    }
  });
  it.each([401,403,429,503,302])('never refreshes/retries/replays mutation HTTP%s even without access-token expiry',async code=>{
    const adapter=await open(provider);status=code;await expect(adapter.send(payload)).rejects.toThrow();
    expect(mutations()).toHaveLength(1);expect(calls.filter(c=>c.url.pathname.endsWith('/token'))).toHaveLength(1);
    await expect(adapter.send(payload)).rejects.toThrow();expect(mutations()).toHaveLength(1);
  });
  it('burns the one-shot on transport cancellation and never sends a second request',async()=>{
    const adapter=await open(provider);timeout=true;await expect(adapter.send(payload)).rejects.toThrow();
    await expect(adapter.send(payload)).rejects.toThrow();expect(mutations()).toHaveLength(1);
  });
  it.each(['identity','scopes','refresh','pre-abort'] as const)('refuses %s before mutation',async failure=>{
    if(failure==='identity')wrongIdentity=true;if(failure==='scopes')badScopes=true;if(failure==='refresh')tokenStatus=503;if(failure==='pre-abort')controller.abort();
    await expect(open(provider)).rejects.toThrow();expect(mutations()).toEqual([]);expect(rotation).not.toHaveBeenCalled();
  });
});
it('requires a genuine Gmail message ID even on HTTP200',async()=>{
  const adapter=await open('google');malformed=true;await expect(adapter.send(payload)).rejects.toThrow();expect(mutations()).toHaveLength(1);
});
it('retains only a real bounded Graph request ID when supplied;202 alone is truthful',async()=>{
  requestId='11111111-1111-4111-8111-111111111111';
  expect(await (await open('microsoft')).send(payload)).toEqual({state:'accepted',providerStatus:202,providerReceiptId:requestId});
});

it('folds long UTF8 Gmail subjects on complete character boundaries',async()=>{
  const subject='æ € 😀 '.repeat(50),adapter=await open('google');await adapter.send({...payload,subject});
  const raw=Buffer.from(JSON.parse(String(mutations()[0].body)).raw,'base64url').toString('utf8');
  const encoded=raw.split('Subject: ')[1].split('\r\nMIME-Version:')[0];
  const decoded=[...encoded.matchAll(/=\?UTF-8\?B\?([^?]*)\?=/g)].map(m=>Buffer.from(m[1],'base64').toString('utf8')).join('');
  expect(decoded).toBe(subject);expect(encoded.split('\r\n').every(line=>line.length<=75)).toBe(true);
});
