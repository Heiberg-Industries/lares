/** Official Graph SDK without RetryHandler or RedirectHandler. Raw HTTP202 is accepted,
 * never a fabricated message ID or evidence of delivery.
 * https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0
 */
import * as oidc from 'openid-client';
import { Client,AuthenticationHandler,HTTPMessageHandler,ResponseType } from '@microsoft/microsoft-graph-client';
import type { User } from '@microsoft/microsoft-graph-types';
import { decryptSecret,encryptSecret } from '@lares/agent-box/lib/crypto.js';
import { normalizeMicrosoftPersonalScopes } from '@lares/agent-kit/personal-consent';
import type { StoredAccountCredential } from '@lares/agent-kit/account-credentials';
import type { Dispatcher } from 'undici';
import { validateMicrosoftIdentity,type MicrosoftReadSettings,type MicrosoftReadIdentity } from './microsoft-personal-reads.js';
import { PersonalReadError } from './personal-read-contract.js';
import { oneShotSend,type PersonalSendAdapter } from './personal-send-contract.js';
const consumer='9188040d-6c67-4c5b-b112-36a304b66dad';
export async function microsoftPersonalSend(args:{settings:MicrosoftReadSettings;identity:MicrosoftReadIdentity;
  credential:StoredAccountCredential;signal:AbortSignal;persistRotation:(encrypted:string)=>Promise<void>;
  dispatcher?:Dispatcher;fetch?:typeof fetch}):Promise<PersonalSendAdapter> {
  const {settings,identity,credential,signal}=args;
  validateMicrosoftIdentity(settings,identity);
  if(credential.orgId!=='microsoft')throw new PersonalReadError();
  const scopes=normalizeMicrosoftPersonalScopes(credential.scopes,'read+mail-send');
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
    JSON.stringify(normalizeMicrosoftPersonalScopes(tokens.scope.split(/\s+/).filter(Boolean),'read+mail-send'))!==JSON.stringify(scopes))throw new PersonalReadError();
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
  return oneShotSend(signal,async payload=>{
    let request=client.api('/me/sendMail').option('signal',signal).option('redirect','error').responseType(ResponseType.RAW);
    if(args.dispatcher)request=request.option('dispatcher',args.dispatcher);
    const response=await request.post({message:{subject:payload.subject,body:{contentType:'Text',content:payload.body},
      toRecipients:payload.to.map(address=>({emailAddress:{address}}))}}) as Response;
    signal.throwIfAborted();
    if(!(response instanceof Response)||response.status!==202)throw new PersonalReadError();
    const id=response.headers.get('request-id');
    const providerReceiptId=id&&/^[A-Za-z0-9._:@/+=-]{1,256}$/.test(id)?id:undefined;
    return {state:'accepted',providerStatus:202,...(providerReceiptId?{providerReceiptId}:{})};
  });
}
