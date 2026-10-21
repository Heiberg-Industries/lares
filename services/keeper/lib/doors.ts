import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {z} from 'zod';
import {claimHash} from '@lares/agent-kit/door-authority';
import {registerAction,KeeperRefusedError} from './actions.js';
const NAME=/^[a-z][a-z0-9-]{1,30}$/;
const roles:Record<string,string[]>={creative:['slack'],'chief-of-staff':['slack','telegram','email']};
export function doorOrigin(value:string):string {
  const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('Explicit HTTPS public door origin required');return u.origin;
}
function readSecretFile(secretsDir:string,name:string,suffix:string):string {
  const path=join(secretsDir,`${name}-${suffix}`);const st=lstatSync(path);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw new Error('Invalid secret file');
  return readFileSync(path,'utf8').trim();
}
const OTHER_OWNER='Another member already connects this agent. Only they can connect its other doors.';
/** One owner per agent: refuse when another member holds a claimed door, or an unexpired pending code, on this incarnation. */
async function refuseOtherOwner(db:Pick<Pool,'query'>,agent:string,incarnation:string,actor:string):Promise<void> {
  const {rows}=await db.query(`SELECT 1 FROM agent_door_connections WHERE agent=$1 AND incarnation=$2::uuid AND owner_email<>$3 AND (principal IS NOT NULL OR expires_at>now()) LIMIT 1`,[agent,incarnation,actor]);
  if(rows.length)throw new KeeperRefusedError(OTHER_OWNER);
}
/** Caller-supplied names cannot choose URLs, secret paths, platform methods or transports. */
export function registerDoorActions(o:{pool:Pool;secretsDir:string;publicOrigin?:string;emailPrincipal?:string;googleOrgs?:string[];fetch?:typeof fetch;namespaceGuard?():Promise<void>}) {
 const query=o.pool.query.bind(o.pool);
 async function resource(name:string,kind:string,db:Pick<Pool,'query'>=o.pool) {
  const {rows}=await db.query(`SELECT r.*,d.definition,d.status FROM agent_resources r JOIN agent_definitions d ON d.name=r.name WHERE r.name=$1`,[name]);
  const row=rows[0];
  if(!row||!row.runtime_control_token||row.runtime_control_token!==row.ownership_token||row.state!=='ready'||row.status!=='valid'||!roles[row.definition.role]?.includes(kind))throw new KeeperRefusedError('Door requires active runtime control with this adapter');
  return row;
 }
 registerAction({name:'door.status',input:z.strictObject({name:z.string().regex(NAME)}),run:async({name})=>{
  const {rows}=await query(`SELECT k.kind,COALESCE(d.enabled,false) AS enabled,d.secret_set_at IS NOT NULL AS configured,c.principal IS NOT NULL AS claimed,c.mailbox,c.org,c.expires_at,c.attempts,c.webhook_set_at,
    r.pending,r.pending_reason,c.revision=c.applied_revision AND NOT r.pending AS applied
    FROM agent_resources r CROSS JOIN (VALUES('slack'),('telegram'),('email')) k(kind) LEFT JOIN agent_doors d ON d.agent=r.name AND d.kind=k.kind
    LEFT JOIN agent_door_connections c ON c.agent=r.name AND c.kind=k.kind AND c.incarnation=r.ownership_token
    WHERE r.name=$1 AND r.runtime_control_token=r.ownership_token AND r.state='ready'`,[name]);
  return rows;
 }});
 /** Asks the platform whether the saved bot token works and who the bot is, so the console can
  * show a "Tap to connect" link (Telegram) or name the app to message (Slack). Read only. */
 registerAction({name:'door.verify',input:z.strictObject({name:z.string().regex(NAME),kind:z.enum(['slack','telegram'])}),run:async({name,kind})=>{
  await resource(name,kind);
  let token:string;
  try{token=readSecretFile(o.secretsDir,name,`${kind}-token`);}catch{throw new KeeperRefusedError('Save the bot token first');}
  const call=async(url:string,init:RequestInit):Promise<any>=>{
   try{
    const response=await (o.fetch??fetch)(url,{...init,signal:AbortSignal.timeout(15000),redirect:'error'});
    return await response.json();
   }catch{throw new Error(`Could not reach ${kind==='slack'?'Slack':'Telegram'}; try again`);}
  };
  if(kind==='telegram') {
   if(!/^\d+:[A-Za-z0-9_-]+$/.test(token))throw new KeeperRefusedError('Telegram credentials are incomplete');
   const data=await call(`https://api.telegram.org/bot${token}/getMe`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
   if(data?.ok!==true||data.result?.is_bot!==true||typeof data.result.username!=='string'||!/^[A-Za-z0-9_]{4,32}$/.test(data.result.username))throw new KeeperRefusedError('Telegram did not accept this bot token');
   return {kind,username:data.result.username as string};
  }
  const data=await call('https://slack.com/api/auth.test',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/x-www-form-urlencoded'},body:''});
  if(data?.ok!==true||typeof data.team!=='string'||typeof data.user!=='string')throw new KeeperRefusedError('Slack did not accept this bot token');
  return {kind,team:data.team as string,user:data.user as string};
 }});
 registerAction({name:'door.claim_issue',input:z.strictObject({name:z.string().regex(NAME),kind:z.enum(['slack','telegram'])}),run:async({name,kind},ctx)=>{
  const client=await o.pool.connect();
  try {
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(1279349317,12)');await o.namespaceGuard?.();
   const row=await resource(name,kind,client);await refuseOtherOwner(client,name,row.ownership_token,ctx.actor);const code=randomBytes(12).toString('hex').toUpperCase();
   const inserted=await client.query(`INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,code_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')
      ON CONFLICT(agent,kind) DO UPDATE SET revision=EXCLUDED.revision,owner_email=EXCLUDED.owner_email,code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,attempts=0
      WHERE agent_door_connections.incarnation=EXCLUDED.incarnation AND agent_door_connections.principal IS NULL
        AND (agent_door_connections.owner_email=EXCLUDED.owner_email OR agent_door_connections.expires_at IS NULL OR agent_door_connections.expires_at<=now())
      RETURNING expires_at`,[name,kind,row.ownership_token,randomUUID(),ctx.actor,claimHash(code)]);
   if(!inserted.rows.length)throw new KeeperRefusedError('This door is already claimed or belongs to another incarnation');
   await client.query('COMMIT');return {code,expiresAt:inserted.rows[0].expires_at.toISOString(),instruction:`Send claim ${code} as an ordinary message in a private chat with this agent (no slash), then apply connection changes in the console.`};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }});
 registerAction({name:'email.connect',input:z.strictObject({name:z.string().regex(NAME),incarnation:z.string().uuid(),principal:z.string().min(1),org:z.string().min(1),mailbox:z.string().email()}),run:async(input,ctx)=>{
  const row=await resource(input.name,'email');
  if(row.ownership_token!==input.incarnation||!o.emailPrincipal||input.principal!==o.emailPrincipal||!o.googleOrgs?.includes(input.org))throw new KeeperRefusedError('Google installation configuration or agent incarnation does not match');
  const token=await query("SELECT 1 FROM oauth_tokens t WHERE principal=$1 AND provider='google' AND org_id=$2 AND email_address=$3 AND NOT EXISTS(SELECT 1 FROM connected_account_credentials c WHERE c.oauth_token_id=t.id) AND refresh_token_enc IS NOT NULL",[input.principal,input.org,input.mailbox]);
  if(!token.rows.length)throw new KeeperRefusedError('Complete the real Google OAuth connection first');
  const client=await o.pool.connect();
  try {
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(1279349317,12)');await o.namespaceGuard?.();
   const current=await client.query("SELECT 1 FROM agent_resources WHERE name=$1 AND ownership_token=$2::uuid AND runtime_control_token=ownership_token AND state='ready' FOR UPDATE",[input.name,input.incarnation]);
   if(!current.rows.length)throw new KeeperRefusedError('Agent incarnation changed');
   await refuseOtherOwner(client,input.name,input.incarnation,ctx.actor);
   const saved=await client.query(`INSERT INTO agent_door_connections(agent,kind,incarnation,revision,owner_email,principal,org,mailbox,claimed_at)
    VALUES($1,'email',$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(agent,kind) DO UPDATE SET revision=EXCLUDED.revision,principal=EXCLUDED.principal,org=EXCLUDED.org,mailbox=EXCLUDED.mailbox,claimed_at=now()
    WHERE agent_door_connections.incarnation=EXCLUDED.incarnation AND agent_door_connections.owner_email=EXCLUDED.owner_email RETURNING agent`,[input.name,input.incarnation,randomUUID(),ctx.actor,input.principal,input.org,input.mailbox]);
   if(!saved.rows.length)throw new KeeperRefusedError('Email connection belongs to a different owner or incarnation');
   await client.query("UPDATE agent_resources SET pending=true,pending_reason='Apply email connection changes (restarts agent)' WHERE name=$1",[input.name]);
   await client.query('COMMIT');return {pending:true,mailbox:input.mailbox};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }});
 registerAction({name:'telegram.webhook_set',input:z.strictObject({name:z.string().regex(NAME)}),run:async({name})=>{
  const client=await o.pool.connect();
  try {
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(1279349317,12)');await o.namespaceGuard?.();
  const row=await resource(name,'telegram',client);
  if(row.pending||!row.applied_definition?.doors?.some((d:any)=>d.kind==='telegram'&&d.enabled))throw new KeeperRefusedError('Apply the Telegram connection changes before registering its webhook');
  if(!o.publicOrigin)throw new KeeperRefusedError('Configure the public door origin and reviewed public routing first');
  const url=`${doorOrigin(o.publicOrigin)}/api/doors/${name}/telegram/events`;
  const read=(suffix:string)=>readSecretFile(o.secretsDir,name,suffix);
  const token=read('telegram-token'),secret=read('telegram-webhook-secret');
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(token)||!/^[-_A-Za-z0-9]{32,256}$/.test(secret))throw new KeeperRefusedError('Telegram credentials are incomplete');
  async function api(method:'getWebhookInfo'|'setWebhook',body:object={}) {
    const response=await (o.fetch??fetch)(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000),redirect:'error'});
    const data=await response.json() as {ok?:boolean;result?:unknown};
    if(!response.ok||data.ok!==true)throw new Error('Telegram request failed; inspect state before retry');
    return data.result;
  }
  const before=await api('getWebhookInfo') as {url?:unknown};
  if(typeof before?.url!=='string')throw new Error('Unexpected Telegram webhook state');
  if(before.url&&before.url!==url)throw new KeeperRefusedError('Bot already has another webhook. Preserve its restoration data and disconnect it explicitly before using this door');
  if(await api('setWebhook',{url,secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:false})!==true)throw new Error('Telegram webhook registration failed; inspect state before retry');
  await client.query(`UPDATE agent_doors SET settings=jsonb_set(settings,'{webhookRegistered}','true'),updated_at=now() WHERE agent=$1 AND kind='telegram'`,[name]);
  await client.query('COMMIT');
  return {registered:true,url,claimed:false};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }});
}
