import { google } from 'googleapis';
import { buildOAuth2Client, decryptSecret, readTokenEncKey } from '@lares/agent-kit/google-auth';
import { personalOrgConfig } from './google-orgs.js';
import { bindPersonalGoogleDeadline, toMailMessage } from './google.js';
import { inWindow, requiredId, timestamp, optionalText, PersonalReadError, type PersonalReadAdapter } from './personal-read-contract.js';

/** Exact associated credential supplied only inside a locked server callback. Legacy Gmail
 * query APIs remain separate. A broad second-granularity query is verified against internalDate.
 */
export function googlePersonalReads(credential: {orgId:string;refreshTokenEnc:string}, signal: AbortSignal, fetchImplementation?: typeof fetch): PersonalReadAdapter {
  const auth = buildOAuth2Client(personalOrgConfig(credential.orgId), decryptSecret(credential.refreshTokenEnc,readTokenEncKey()));
  if(fetchImplementation)auth.transporter.defaults={...auth.transporter.defaults,fetchImplementation};
  bindPersonalGoogleDeadline(auth,signal);
  let tokenRequests=0;
  auth.transporter.interceptors.request.add({resolved:async options=>{
    if(String(options.url)===String(auth.endpoints.oauth2TokenUrl) && ++tokenRequests!==1)throw new PersonalReadError();
    return {...options,redirect:'error',maxRedirects:0};
  }});
  const gmail=google.gmail({version:'v1',auth}),calendar=google.calendar({version:'v3',auth});
  return {
    async listMail(window) {
      const response=await gmail.users.messages.list({userId:'me',maxResults:window.limit+1,
        q:`after:${Math.floor(Date.parse(window.from)/1000)-1} before:${Math.ceil(Date.parse(window.until)/1000)}`});
      if (response.data.messages !== undefined && !Array.isArray(response.data.messages)) throw new PersonalReadError();
      const refs=[];
      for (const candidate of (response.data.messages??[]).slice(0,window.limit+1)) {
        const id=requiredId(candidate.id);
        const metadata=await gmail.users.messages.get({userId:'me',id,format:'metadata',fields:'id,internalDate'});
        if(metadata.data.id!==id||typeof metadata.data.internalDate!=='string'||!/^\d+$/.test(metadata.data.internalDate))throw new PersonalReadError();
        const receivedAt=new Date(Number(metadata.data.internalDate)).toISOString();
        if(inWindow(receivedAt,window))refs.push({id,receivedAt});
      }
      return {items:refs.slice(0,window.limit),truncated:!!response.data.nextPageToken||(response.data.messages?.length??0)>window.limit+1||refs.length>window.limit};
    },
    async readMail(input) {
      const id=requiredId(input);
      try {
        const response=await gmail.users.messages.get({userId:'me',id,format:'full'});
        if(response.data.id!==id)throw new PersonalReadError();
        const m=toMailMessage(response.data as unknown as Parameters<typeof toMailMessage>[0]);
        return {id:m.id,threadId:m.threadId||null,from:m.from||null,to:m.to,cc:m.cc,subject:m.subject||null,
          sentAt:m.sentAt&&Number.isFinite(Date.parse(m.sentAt))?timestamp(m.sentAt):null,bodyText:m.bodyText};
      } catch(error) {
        if((error as {response?:{status?:number}})?.response?.status===404)return null;
        throw error;
      }
    },
    async listCalendar(input,window) {
      const calendarId=requiredId(input);
      const response=await calendar.events.list({calendarId,timeMin:window.from,timeMax:window.until,
        maxResults:window.limit+1,singleEvents:true,orderBy:'startTime'});
      if(response.data.items!==undefined&&!Array.isArray(response.data.items))throw new PersonalReadError();
      const items=(response.data.items??[]).slice(0,window.limit).map(e=>{
        const start=e.start?.dateTime??e.start?.date,end=e.end?.dateTime??e.end?.date;
        if(typeof start!=='string'||typeof end!=='string'||!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end)))throw new PersonalReadError();
        return {id:requiredId(e.id),summary:optionalText(e.summary),start,end,startTimeZone:optionalText(e.start?.timeZone),
          endTimeZone:optionalText(e.end?.timeZone),allDay:e.start?.date?true:false,location:optionalText(e.location),
          cancelled:e.status?e.status==='cancelled':null};
      });
      return {items,truncated:!!response.data.nextPageToken||(response.data.items?.length??0)>window.limit};
    },
  };
}
