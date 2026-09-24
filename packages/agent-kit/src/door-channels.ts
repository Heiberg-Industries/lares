import {createHmac,timingSafeEqual} from 'node:crypto';
import {assertDoorAuthority,consumeClaim,managedIdentity,type DoorDatabase} from './door-authority.js';
/** Installed eve SlackWebhookVerifier receives (Request, raw body) before events OR HITL.
 * https://docs.slack.dev/authentication/verifying-requests-from-slack/ */
export function slackDoorVerifier(secret:()=>string,db?:DoorDatabase,env:NodeJS.ProcessEnv=process.env) {
 return async(request:Request,body:string):Promise<boolean>=>{
  const timestamp=request.headers.get('x-slack-request-timestamp')??'';
  if(!/^\d+$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300)return false;
  const supplied=request.headers.get('x-slack-signature')??'';
  if(!/^v0=[a-f0-9]{64}$/.test(supplied))return false;
  const expected='v0='+createHmac('sha256',secret()).update(`v0:${timestamp}:${body}`).digest('hex');
  if(!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return false;
  await assertDoorAuthority('slack',true,db,env);return true;
 };
}
export async function interceptSlackClaim(message:{text:string;channelId:string;author?:{isBot?:boolean;userId:string}},db?:DoorDatabase,env:NodeJS.ProcessEnv=process.env) {
 if(!managedIdentity(env))return false;
 if(await consumeClaim('slack',message.text,message.author?.userId??'',message.channelId.startsWith('D')&&message.author?.isBot===false,db,env))return true;
 await assertDoorAuthority('slack',false,db,env);return false;
}
export async function interceptTelegramClaim(message:{text:string;chat:{type:string};from?:{id:string;isBot:boolean}},db?:DoorDatabase,env:NodeJS.ProcessEnv=process.env) {
 if(!managedIdentity(env))return false;
 if(await consumeClaim('telegram',message.text,message.from?.id??'',message.chat.type==='private'&&message.from?.isBot===false,db,env))return true;
 await assertDoorAuthority('telegram',false,db,env);return false;
}
