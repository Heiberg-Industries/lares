/** Internal private read entry point. Server wrappers supply runtime configuration; model input
 * supplies only an exact selection and one bounded operation. No catalogue exposure in this slice.
 */
import { z } from 'zod';
import { PgAccountStore, type PersonalResourceSelection } from '@lares/agent-kit/account-store';
import { rotateAccountCredential } from '@lares/agent-kit/account-credentials';
import { getPool } from '@lares/agent-kit/db';
import { requireConsoleTurnAuthority, type ConsoleAuthorityContext } from '@lares/agent-kit/console-turn-authority';
import { boundText, DEFAULT_READ_LIMIT } from '@lares/agent-kit/bounded-text';
import type { Dispatcher } from 'undici';
import { googlePersonalReads } from './google-personal-reads.js';
import { microsoftPersonalReads, validateMicrosoftIdentity, microsoftReadScopes, type MicrosoftReadSettings } from './microsoft-personal-reads.js';
import { opaqueId, readWindowSchema, PersonalReadError, type PersonalReadAdapter } from './personal-read-contract.js';
const selectionSchema=z.strictObject({accountId:z.string().min(1),generation:z.number().int().nonnegative(),resourceBindingId:z.string().min(1)});
export const personalReadOperationSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('mailWindow'),window:readWindowSchema}),
  z.strictObject({kind:z.literal('readMail'),id:opaqueId,offset:z.number().int().nonnegative().default(0)}),
  z.strictObject({kind:z.literal('calendarWindow'),window:readWindowSchema}),
]);
export type PersonalReadOperation=z.input<typeof personalReadOperationSchema>;
/** Trusted server configuration only, supplied by a future mounted runtime wrapper. Not a model
 * argument. Absent configuration refuses Microsoft; runtime.google personal registry stays exact.
 */
export interface PersonalReadRuntime {
  microsoft?:()=>{settings:MicrosoftReadSettings;dispatcher?:Dispatcher};
}
function ownAuthority(authority:Awaited<ReturnType<typeof requireConsoleTurnAuthority>>) {
  const member=authority.actingMemberId;
  if(!member || authority.spokenByMemberId!==member || authority.audience.participants.length!==1 ||
    authority.audience.participants[0]?.kind!=='member' || authority.audience.participants[0].memberId!==member)throw new PersonalReadError();
  return member;
}
export async function readPersonalResource(ctx:ConsoleAuthorityContext,input:PersonalResourceSelection,
  operation:PersonalReadOperation,runtime:PersonalReadRuntime={}) {
  try {
    const selection=selectionSchema.parse(input),op=personalReadOperationSchema.parse(operation);
    const memberId=ownAuthority(await requireConsoleTurnAuthority(ctx));
    const kind=op.kind==='calendarWindow'?'calendar':'mailbox';
    return await new PgAccountStore(getPool()).withPersonalResourceCredential(memberId,selection,kind,
      async({account,resource},credential,db)=>{
        if(ownAuthority(await requireConsoleTurnAuthority(ctx,db))!==memberId)throw new PersonalReadError();
        const signal=AbortSignal.timeout(15_000);
        let adapter:PersonalReadAdapter;
        if(account.connectorId==='google') {
          if(account.providerAccount.issuer!=='https://accounts.google.com' ||
            (kind==='mailbox' && resource.externalId!==account.providerAccount.subject))throw new PersonalReadError();
          const allowed=kind==='mailbox'?['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.modify','https://mail.google.com/']:
            ['https://www.googleapis.com/auth/calendar.readonly','https://www.googleapis.com/auth/calendar.events.readonly','https://www.googleapis.com/auth/calendar','https://www.googleapis.com/auth/calendar.events'];
          if(!allowed.some(scope=>credential.scopes.includes(scope)))throw new PersonalReadError();
          adapter=googlePersonalReads(credential,signal);
        }else if(account.connectorId==='microsoft') {
          const mounted=runtime.microsoft?.();
          if(!mounted || credential.orgId!=='microsoft' || (kind==='mailbox' && resource.externalId!==account.providerAccount.subject))throw new PersonalReadError();
          validateMicrosoftIdentity(mounted.settings,account.providerAccount);
          microsoftReadScopes(credential.scopes);
          adapter=await microsoftPersonalReads({...mounted,identity:account.providerAccount,credential,signal,
            persistRotation:encrypted=>rotateAccountCredential(db,{id:account.id,ownerMemberId:memberId,connectorId:account.connectorId,generation:account.generation},credential,encrypted)});
        }else throw new PersonalReadError();
        if(op.kind==='mailWindow')return {kind:op.kind,...await adapter.listMail(op.window)};
        if(op.kind==='calendarWindow')return {kind:op.kind,...await adapter.listCalendar(resource.externalId,op.window)};
        const mail=await adapter.readMail(op.id);
        if(!mail)return {kind:op.kind,message:null};
        const page=boundText(mail.bodyText,{limit:DEFAULT_READ_LIMIT,offset:op.offset});
        return {kind:op.kind,message:{...mail,bodyText:page.text,senderStanding:'I could not check' as const},
          bodyPage:{totalChars:page.totalChars,truncated:page.truncated,nextOffset:page.nextOffset,note:page.note}};
      });
  }catch{throw new PersonalReadError();}
}
