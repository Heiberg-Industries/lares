/** Official Google SDK. Refresh + same-token identity precede one access-token-only mutation.
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
 */
import { google } from 'googleapis';
import { z } from 'zod';
import { buildOAuth2Client,decryptSecret,readTokenEncKey } from '@lares/agent-kit/google-auth';
import { encryptSecret } from '@lares/agent-box/lib/crypto.js';
import { validateGooglePersonalScopes } from '@lares/agent-kit/personal-consent';
import type { StoredAccountCredential } from '@lares/agent-kit/account-credentials';
import type { PersonalMailPayload } from '@lares/agent-kit/personal-action-store';
import { personalOrgConfig } from './google-orgs.js';
import { bindPersonalGoogleDeadline } from './google.js';
import { oneShotSend,PersonalSendError,type PersonalSendAdapter } from './personal-send-contract.js';
function rawMail(from:string,payload:PersonalMailPayload):string {
  // RFC2047 folding avoids long/non-ASCII subject headers; base64 body preserves exact text.
  const chunks:string[]=[];let chunk='';
  for(const point of payload.subject){if(Buffer.byteLength(chunk+point,'utf8')>45){chunks.push(chunk);chunk='';}chunk+=point;}
  if(chunk)chunks.push(chunk);
  const subject=chunks.map(s=>`=?UTF-8?B?${Buffer.from(s,'utf8').toString('base64')}?=`).join('\r\n ');
  const body=Buffer.from(payload.body,'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n')??'';
  return Buffer.from([`From: ${from}`,`To: ${payload.to.join(',\r\n ')}`,`Subject: ${subject}`,
    'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',body].join('\r\n')).toString('base64url');
}
export async function googlePersonalSend(args:{identity:{issuer:string;subject:string};credential:StoredAccountCredential;
  signal:AbortSignal;persistRotation:(encrypted:string)=>Promise<void>;fetch?:typeof fetch}):Promise<PersonalSendAdapter> {
  const {credential,identity,signal}=args;
  if(identity.issuer!=='https://accounts.google.com'||!identity.subject)throw new PersonalSendError();
  validateGooglePersonalScopes(credential.scopes,'read+mail-send');
  const cfg=personalOrgConfig(credential.orgId),key=readTokenEncKey(),refresh=decryptSecret(credential.refreshTokenEnc,key);
  function client(token:string){
    const auth=buildOAuth2Client(cfg,token);
    if(args.fetch)auth.transporter.defaults={...auth.transporter.defaults,fetchImplementation:args.fetch};
    bindPersonalGoogleDeadline(auth,signal);
    auth.transporter.interceptors.request.add({resolved:async options=>({...options,redirect:'error',maxRedirects:0})});
    return auth;
  }
  const auth=client(refresh);
  let refreshes=0,rotated:string|undefined;
  auth.on('tokens',tokens=>{if(tokens.refresh_token&&tokens.refresh_token!==refresh)rotated=tokens.refresh_token;});
  auth.transporter.interceptors.request.add({resolved:async options=>{
    if(String(options.url)===String(auth.endpoints.oauth2TokenUrl)&&++refreshes!==1)throw new PersonalSendError();
    return options;
  }});
  const {credentials}=await auth.refreshAccessToken();
  if(typeof credentials.access_token!=='string'||!credentials.access_token)throw new PersonalSendError();
  const info=await auth.getTokenInfo(credentials.access_token);
  if(info.sub!==identity.subject||info.aud!==cfg.clientId||!Number.isFinite(info.expiry_date)||info.expiry_date<=Date.now())throw new PersonalSendError();
  validateGooglePersonalScopes(info.scopes,'read+mail-send');
  if(JSON.stringify([...new Set(info.scopes)].sort())!==JSON.stringify([...new Set(credential.scopes)].sort()))throw new PersonalSendError();
  // Overwrite ALL refresh material. OAuth2Client replays 401/403 when a refresh token or handler
  // exists even with transport retries disabled. This client has neither, including no expiry.
  const writeAuth=client('');writeAuth.setCredentials({access_token:credentials.access_token});
  const gmail=google.gmail({version:'v1',auth:writeAuth});
  const profile=await gmail.users.getProfile({userId:'me'});
  const from=z.email().max(254).parse(profile.data.emailAddress);
  if(from!==credential.emailAddress)throw new PersonalSendError();
  if(rotated)await args.persistRotation(encryptSecret(rotated,key));
  return oneShotSend(signal,async payload=>{
    const result=await gmail.users.messages.send({userId:'me',requestBody:{raw:rawMail(from,payload)}});
    signal.throwIfAborted();
    // Empty/malformed success is uncertainty, never a made-up message ID.
    const id=z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).parse(result.data.id);
    return {state:'accepted',providerReceiptId:id};
  });
}
