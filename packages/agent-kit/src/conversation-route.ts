import {readFileSync} from 'node:fs';
import {verifyHttpBasic} from 'eve/channels/auth';
import {resetConversation,type ResetHandle} from './conversation-control.js';
/** Separate credential, never an existing agent route password or a loopback auth bypass. */
export async function conversationResetRoute(request:Request,{attachSession}:{attachSession:(id:string)=>ResetHandle}):Promise<Response> {
  let password:string;
  try { password=readFileSync(process.env.LARES_RUNTIME_CONTROL_SECRET_FILE??'/run/secrets/runtime-control','utf8').trim(); }
  catch { return Response.json({error:'Runtime control unavailable'},{status:503}); }
  if(password.length<32||!verifyHttpBasic(request.headers.get('authorization'),{username:'keeper',password}).ok)return Response.json({error:'unauthorized'},{status:401});
  try {
    const raw=await request.text();if(raw.length>2048)return Response.json({error:'Invalid request'},{status:400});
    const body=JSON.parse(raw);
    if(!body||typeof body.sessionId!=='string'||typeof body.incarnation!=='string'||body.confirm!==true)return Response.json({error:'Invalid request'},{status:400});
    return Response.json(await resetConversation(body,attachSession));
  } catch {return Response.json({error:'Reset failed; inspect current session state before retrying'},{status:409});}
}
