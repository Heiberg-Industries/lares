import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Pool} from 'pg';
import {z} from 'zod';
import {registerAction,KeeperRefusedError} from './actions.js';
const execute=promisify(execFile);
const name=z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
const incarnation=z.string().uuid();
const sessionId=z.string().regex(/^wrun_[A-Za-z0-9_-]{1,200}$/);
// Fixed in-container program. Secret is read inside the owned runtime; never appears in argv,
// output, keeper audit, or a caller-provided URL. The HTTP route still authenticates loopback.
const PROGRAM=`import{readFileSync}from'node:fs';
const [incarnation,sessionId]=process.argv.slice(1);
const password=readFileSync('/run/secrets/runtime-control','utf8').trim();
const response=await fetch('http://127.0.0.1:3000/lares/runtime/conversations/reset',{method:'POST',headers:{'content-type':'application/json',authorization:'Basic '+Buffer.from('keeper:'+password).toString('base64')},body:JSON.stringify({incarnation,sessionId,confirm:true}),signal:AbortSignal.timeout(15000)});
if(!response.ok)process.exit(1);
const result=await response.json();if(!['reset','no_active_session'].includes(result.status))process.exit(1);
process.stdout.write(JSON.stringify({status:result.status}));`;
type Execute=(file:string,args:string[],opts:{timeout:number;maxBuffer:number})=>Promise<{stdout:string}>;
export async function runtimeReset(project:string,agent:string,token:string,id:string,run:Execute=execute) {
  name.parse(agent);incarnation.parse(token);sessionId.parse(id);
  if(!/^[a-z0-9][a-z0-9_-]*$/.test(project))throw new Error('Invalid configured project');
  const opts={timeout:20000,maxBuffer:8192};
  const inventory=(await run('docker',['ps','--quiet','--filter',`label=com.docker.compose.project=${project}`,'--filter',`label=com.docker.compose.service=lares-${agent}`,'--filter',`label=lares.incarnation=${token}`],opts)).stdout.trim().split(/\s+/).filter(Boolean);
  if(inventory.length!==1||!/^[a-f0-9]{12,64}$/.test(inventory[0]))throw new KeeperRefusedError('Current owned runtime unavailable');
  const output=(await run('docker',['exec',inventory[0],'node','--input-type=module','-e',PROGRAM,token,id],opts)).stdout;
  const result=JSON.parse(output);
  if(!['reset','no_active_session'].includes(result.status))throw new Error('Reset outcome unknown');
  return {status:result.status as 'reset'|'no_active_session'};
}
export function registerConversationActions(pool:Pool,reset:(name:string,incarnation:string,sessionId:string)=>Promise<unknown>) {
  registerAction({name:'conversation.list',input:z.strictObject({name}),run:async({name:agent})=>{
    const resource=await pool.query("SELECT ownership_token FROM agent_resources WHERE name=$1 AND runtime_control_token=ownership_token AND state='ready'",[agent]);
    if(!resource.rows.length)throw new KeeperRefusedError('Current agent incarnation unavailable');
    const rows=await pool.query(`SELECT session_id AS "sessionId",incarnation,door,observed_at AS "observedAt",terminal
      FROM agent_conversations WHERE agent=$1 AND incarnation=$2 ORDER BY observed_at DESC LIMIT 50`,[agent,resource.rows[0].ownership_token]);
    return rows.rows;
  }});
  registerAction({name:'conversation.reset',input:z.strictObject({name,incarnation,sessionId,confirm:z.literal(true)}),run:async(input)=>{
    const {rows}=await pool.query(`SELECT c.session_id FROM agent_conversations c JOIN agent_resources r ON r.name=c.agent AND r.ownership_token=c.incarnation
      WHERE c.agent=$1 AND c.incarnation=$2::uuid AND c.session_id=$3 AND r.runtime_control_token=r.ownership_token AND NOT r.pending AND r.state='ready'`,[input.name,input.incarnation,input.sessionId]);
    if(!rows.length)throw new KeeperRefusedError('Conversation is not owned by the current agent incarnation');
    return reset(input.name,input.incarnation,input.sessionId);
  }});
}
