import {createHmac,timingSafeEqual} from 'node:crypto';
import {assertDoorAuthority,tryClaim,managedIdentity,type DoorDatabase} from './door-authority.js';
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
/** The only things a door says to someone it has not accepted yet. Fixed and generic on purpose:
 * the same words for a stranger, a wrong code and an owner who has not finished connecting, so
 * nothing about the installation (who owns it, which code is close, whether it is claimed) leaks. */
export const CLAIM_REPLY_CONNECTED='Connected. Once setup finishes applying, you can talk to me here.';
export const CLAIM_REPLY_NOT_YET='I cannot act on that message yet. To connect, send the word claim followed by your connection code.';
/** Sends one fixed line; a failure to send is logged and never changes the door's decision. */
export type DoorReply=(text:string)=>Promise<void>;
async function say(reply:DoorReply|undefined,text:string){
 if(!reply)return;
 try{await reply(text);}catch(err){console.error('door: could not send the fixed reply',err instanceof Error?err.message:'unknown error');}
}
async function intercept(kind:'slack'|'telegram',text:string,sender:string,privateHuman:boolean,db:DoorDatabase|undefined,env:NodeJS.ProcessEnv,reply:DoorReply|undefined) {
 if(!managedIdentity(env))return false;
 const outcome=await tryClaim(kind,text,sender,privateHuman,db,env);
 if(outcome==='claimed'){await say(reply,CLAIM_REPLY_CONNECTED);return true;}
 if(outcome==='ignored'){if(privateHuman)await say(reply,CLAIM_REPLY_NOT_YET);return true;}
 try{await assertDoorAuthority(kind,false,db,env);}
 catch(err){if(privateHuman)await say(reply,CLAIM_REPLY_NOT_YET);throw err;}
 return false;
}
export async function interceptSlackClaim(message:{text:string;channelId:string;author?:{isBot?:boolean;userId:string}},db?:DoorDatabase,env:NodeJS.ProcessEnv=process.env,reply?:DoorReply) {
 return intercept('slack',message.text,message.author?.userId??'',message.channelId.startsWith('D')&&message.author?.isBot===false,db,env,reply);
}
export async function interceptTelegramClaim(message:{text:string;chat:{type:string};from?:{id:string;isBot:boolean}},db?:DoorDatabase,env:NodeJS.ProcessEnv=process.env,reply?:DoorReply) {
 return intercept('telegram',message.text,message.from?.id??'',message.chat.type==='private'&&message.from?.isBot===false,db,env,reply);
}
