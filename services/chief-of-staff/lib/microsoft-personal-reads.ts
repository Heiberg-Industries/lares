/** Server-only delegated DATA client. No environment, email, actor, or owner fallback. */
import * as oidc from 'openid-client';
import { Client, AuthenticationHandler, HTTPMessageHandler, GraphError } from '@microsoft/microsoft-graph-client';
import type { User, Message, Event, Recipient } from '@microsoft/microsoft-graph-types';
import { decryptSecret, encryptSecret } from '@lares/agent-box/lib/crypto.js';
import type { Dispatcher } from 'undici';
import { z } from 'zod';
import { inWindow, timestamp, requiredId, optionalText, PersonalReadError, type PersonalReadAdapter, type PrivateEvent } from './personal-read-contract.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const consumer='9188040d-6c67-4c5b-b112-36a304b66dad';
export const microsoftReadSettingsSchema=z.strictObject({tenantId:z.string().regex(uuid).refine(t=>t!==consumer),
  clientId:z.string().min(1).max(256),clientSecret:z.string().min(1).max(8192),tokenKeyHex:z.string().regex(/^[a-fA-F0-9]{64}$/)});
export type MicrosoftReadSettings=z.infer<typeof microsoftReadSettingsSchema>;
export interface MicrosoftReadIdentity { issuer:string; tenantId?:string|null; subject:string }
export function validateMicrosoftIdentity(settings:MicrosoftReadSettings, identity:MicrosoftReadIdentity) {
  microsoftReadSettingsSchema.parse(settings);
  if(identity.issuer!==`https://login.microsoftonline.com/${settings.tenantId}/v2.0` ||
    identity.tenantId!==settings.tenantId || !uuid.test(identity.subject)) throw new PersonalReadError();
}
const normalize=(scopes:readonly string[])=>[...new Set(scopes.map(s=>s.replace(/^https:\/\/graph\.microsoft\.com\//,'')))].sort();
export function microsoftReadScopes(scopes:readonly string[]) {
  if(scopes.length>7 || scopes.some(s=>typeof s!=='string'||s.length>128))throw new PersonalReadError();
  const normalized=normalize(scopes);
  if(['User.Read','Mail.Read','Calendars.Read'].some(s=>!normalized.includes(s)) ||
    normalized.some(s=>!['openid','offline_access','profile','email','User.Read','Mail.Read','Calendars.Read'].includes(s)))throw new PersonalReadError();
  return normalized;
}
function address(recipient:Recipient|undefined|null):string|null {
  const value=recipient?.emailAddress?.address;
  return typeof value==='string' && value ? value : null;
}
function addresses(recipients:Recipient[]|undefined|null):string[]|null {
  if(recipients==null)return null;
  if(!Array.isArray(recipients))throw new PersonalReadError();
  const result=recipients.map(address);return result.some(a=>a===null)?null:result as string[];
}
function eventTime(value:Event['start']):string {
  if(typeof value?.dateTime!=='string'||!value.dateTime || value.timeZone!=='UTC')throw new PersonalReadError();
  // Prefer UTC avoids guessing Windows timezone names. Graph returns UTC without an offset.
  return timestamp(/(?:Z|[+-]\d\d:\d\d)$/.test(value.dateTime)?value.dateTime:`${value.dateTime}Z`);
}
/** Called and consumed entirely inside the resource transaction. SDK HTTP transport receives
 * the same signal and refuses redirects. An optional trusted dispatcher supplies sealed egress.
 * fetch is an offline test seam for OIDC; Graph retains its official HTTPMessageHandler.
 */
export async function microsoftPersonalReads(args:{settings:MicrosoftReadSettings;identity:MicrosoftReadIdentity;
  credential:{orgId:string;refreshTokenEnc:string;scopes:string[]};signal:AbortSignal;
  persistRotation:(encrypted:string)=>Promise<void>;dispatcher?:Dispatcher;fetch?:typeof fetch}):Promise<PersonalReadAdapter> {
  const {settings,identity,credential,signal}=args;
  validateMicrosoftIdentity(settings,identity);
  if(credential.orgId!=='microsoft')throw new PersonalReadError();
  const scopes=microsoftReadScopes(credential.scopes);
  const issuer=identity.issuer, tokenEndpoint=`https://login.microsoftonline.com/${settings.tenantId}/oauth2/v2.0/token`;
  const discovery=`https://login.microsoftonline.com/${settings.tenantId}/v2.0/.well-known/openid-configuration`;
  const keys=[`https://login.microsoftonline.com/${settings.tenantId}/discovery/v2.0/keys`,'https://login.microsoftonline.com/common/discovery/v2.0/keys'];
  let tokenRequests=0;
  const boundedFetch:oidc.CustomFetch=async(url,options)=>{
    signal.throwIfAborted();
    if(![discovery,tokenEndpoint,...keys].includes(url))throw new PersonalReadError();
    if(url===tokenEndpoint && ++tokenRequests!==1)throw new PersonalReadError();
    const response=await (args.fetch??fetch)(url,{...options,body:options.body as BodyInit,signal,redirect:'error',
      ...(args.dispatcher?{dispatcher:args.dispatcher}:{})});
    signal.throwIfAborted();
    return response;
  };
  const config=await oidc.discovery(new URL(issuer),settings.clientId,settings.clientSecret,undefined,{[oidc.customFetch]:boundedFetch});
  const metadata=config.serverMetadata();
  if(metadata.issuer!==issuer || metadata.token_endpoint!==tokenEndpoint || !keys.includes(metadata.jwks_uri??''))throw new PersonalReadError();
  oidc.enableNonRepudiationChecks(config);
  const tokens=await oidc.refreshTokenGrant(config,decryptSecret(credential.refreshTokenEnc,settings.tokenKeyHex),{scope:credential.scopes.join(' ')});
  if(!tokens.access_token || typeof tokens.scope!=='string' ||
    JSON.stringify(microsoftReadScopes(tokens.scope.split(/\s+/).filter(Boolean)))!==JSON.stringify(scopes))throw new PersonalReadError();
  // A refresh ID token is optional. If returned, the maintained library validates it; reject
  // contradictions but never use its claims instead of the same access token's Graph /me.
  const claims=tokens.claims();
  if(claims && (claims.iss!==issuer || claims.tid!==settings.tenantId || claims.oid!==identity.subject ||
    claims.idp==='live.com' || claims.idp===`https://sts.windows.net/${consumer}/`))throw new PersonalReadError();
  const client=Client.initWithMiddleware({middleware:[new AuthenticationHandler({getAccessToken:async()=>{
    signal.throwIfAborted();return tokens.access_token;
  }}),new HTTPMessageHandler()]});
  async function get<T>(path:string,select:string,query?:Record<string,string|number>):Promise<T> {
    signal.throwIfAborted();
    let request=client.api(path).option('signal',signal).option('redirect','error').header('Prefer','outlook.timezone="UTC", outlook.body-content-type="text"').select(select);
    if(args.dispatcher)request=request.option('dispatcher',args.dispatcher);
    if(query)request=request.query(query);
    const result=await request.get() as T;
    signal.throwIfAborted();return result;
  }
  const me=await get<User>('/me','id,userType');
  if(me.id!==identity.subject || me.userType!=='Member')throw new PersonalReadError();
  if(tokens.refresh_token)await args.persistRotation(encryptSecret(tokens.refresh_token,settings.tokenKeyHex));
  return {
    async listMail(window) {
      // Graph SDK query values are not escaped; UTC avoids '+' offset decoding as a space.
      const page=await get<{value?:Message[];'@odata.nextLink'?:string}>('/me/messages','id,receivedDateTime',{
        '$filter':`receivedDateTime ge ${timestamp(window.from)} and receivedDateTime lt ${timestamp(window.until)}`,'$top':window.limit+1,'$orderby':'receivedDateTime asc'});
      if(!Array.isArray(page.value))throw new PersonalReadError();
      const refs=page.value.slice(0,window.limit+1).map(m=>({id:requiredId(m.id),receivedAt:timestamp(m.receivedDateTime)}));
      if(refs.some(m=>!inWindow(m.receivedAt,window)))throw new PersonalReadError();
      return {items:refs.slice(0,window.limit),truncated:!!page['@odata.nextLink']||page.value.length>window.limit};
    },
    async readMail(input) {
      const id=requiredId(input);
      try {
        const m=await get<Message>(`/me/messages/${encodeURIComponent(id)}`,'id,conversationId,from,toRecipients,ccRecipients,subject,sentDateTime,body');
        if(m.id!==id || m.body?.contentType!=='text' || typeof m.body.content!=='string')throw new PersonalReadError();
        return {id,threadId:optionalText(m.conversationId),from:address(m.from),to:addresses(m.toRecipients),cc:addresses(m.ccRecipients),
          subject:optionalText(m.subject),sentAt:m.sentDateTime?timestamp(m.sentDateTime):null,bodyText:m.body.content};
      }catch(error){if(error instanceof GraphError&&error.statusCode===404)return null;throw error;}
    },
    async listCalendar(input,window) {
      const id=requiredId(input);
      const page=await get<{value?:Event[];'@odata.nextLink'?:string}>(`/me/calendars/${encodeURIComponent(id)}/calendarView`,
        'id,subject,start,end,isAllDay,location,isCancelled',{startDateTime:timestamp(window.from),endDateTime:timestamp(window.until),'$top':window.limit+1});
      if(!Array.isArray(page.value))throw new PersonalReadError();
      const items:PrivateEvent[]=page.value.slice(0,window.limit).map(e=>({id:requiredId(e.id),summary:optionalText(e.subject),
        start:eventTime(e.start),end:eventTime(e.end),startTimeZone:e.start?.timeZone??null,endTimeZone:e.end?.timeZone??null,
        allDay:typeof e.isAllDay==='boolean'?e.isAllDay:null,location:optionalText(e.location?.displayName),
        cancelled:typeof e.isCancelled==='boolean'?e.isCancelled:null}));
      return {items,truncated:!!page['@odata.nextLink']||page.value.length>window.limit};
    },
  };
}
