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
/**
 * What a person who may not answer a card on Slack is told when they tap it: privately, in an
 * ephemeral reply only they see. One fixed sentence that is true for every card on a role's Slack
 * door (approval and question alike are the owner's alone) and names nothing about the card, who
 * asked, or the tapper. Shared by every role's Slack door, so the doors cannot drift apart.
 */
export const SLACK_TAP_REFUSAL='Only the owner of this bot can answer this. Nothing was done.';
/** The part of eve's Slack answer context the refusal note uses: the card's own thread. */
export interface SlackRefusalNoticeContext{readonly thread?:{postEphemeral?(userId:string,message:string):Promise<unknown>}}
/**
 * What may be logged about a failed Slack call: Slack's own error code (`channel_not_found`), an
 * HTTP status, or the kind of error, and nothing else. The error's text is not logged: for an
 * answer Slack could not parse it can quote what came back, and that is not this log's to keep.
 */
export function slackFailureCode(error:unknown):string{
 const failure=(typeof error==='object'&&error!==null?error:{}) as {response?:unknown;status?:unknown;name?:unknown};
 const code=typeof failure.response==='object'&&failure.response!==null?(failure.response as {error?:unknown}).error:undefined;
 if(typeof code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(code))return code;
 if(typeof failure.status==='number'&&Number.isInteger(failure.status))return `http_${failure.status}`;
 if(typeof failure.name==='string'&&/^[A-Za-z]{1,64}$/.test(failure.name))return failure.name;
 return 'unknown error';
}
/**
 * Tells a person whose tap on a card was refused, and only them, that nothing was done. Started,
 * never awaited: the refusal is already decided and returned, so this cannot change it, and it does
 * not touch the card (an ephemeral is a new message; nothing is edited, repainted or deleted). It
 * keeps no state, so repeated taps send one note each and leave nothing behind. A failure to send
 * is logged in one line that names nobody (the Slack error code only), and the refusal stands.
 * `door` names the role in that line, for example `chief-of-staff`.
 */
export function tellRefusedSlackTapper(ctx:SlackRefusalNoticeContext|undefined,tapper:unknown,door:string):void{
 // A tap that names nobody has nobody to tell.
 if(typeof tapper!=='string'||tapper.length===0)return;
 const thread=ctx?.thread;
 if(typeof thread?.postEphemeral!=='function')return;
 Promise.resolve()
  .then(()=>thread.postEphemeral!(tapper,SLACK_TAP_REFUSAL))  .catch((error:unknown)=>{
   console.warn(`${door} slack: could not tell a person their tap on a card was not accepted; the card is unchanged and still pending`,slackFailureCode(error));
  });
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
