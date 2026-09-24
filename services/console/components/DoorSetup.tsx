"use client";
import {useEffect,useState} from 'react';
import {slackManifest,telegramSteps} from '../lib/doors';
import {connectDoor,doorStatus,claimCode,registerTelegram,setDoorEnabled,applyConnections,type DefinitionActionResult} from '../app/actions/definition';
export interface DoorStatus {kind:string;enabled:boolean;claimed:boolean;mailbox?:string;pending:boolean;pending_reason?:string;applied:boolean;webhook_set_at?:string}
const SUPPORTED:Record<string,('slack'|'telegram'|'email')[]>={creative:['slack'],travel:['telegram'],'chief-of-staff':['slack','telegram','email']};
export function DoorSetup(p:{name:string;display:string;role:string;origin:string;hash:string;onDefinitionChanged?:(hash:string)=>void}) {
 const [rows,setRows]=useState<DoorStatus[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[unknown,setUnknown]=useState(false),[code,setCode]=useState(''),[hash,setHash]=useState(p.hash);
 const [tokens,setTokens]=useState<Record<string,string>>({}),[signing,setSigning]=useState('');
 const unwrap=<T,>(r:DefinitionActionResult<T>):T=>{if(!r.ok)throw Object.assign(new Error([r.error.message,...(r.error.findings??[]).map(f=>f.message)].join(' ')),{unknown:r.error.outcomeMayBeUnknown});return r.result;};
 async function refresh(){setRows(unwrap(await doorStatus(p.name)));}
 useEffect(()=>{void refresh().catch(e=>setError(e.message));},[p.name]);
 useEffect(()=>setHash(p.hash),[p.hash]);
 async function run(fn:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await fn();await refresh();}catch(e){setError(e instanceof Error?e.message:'Door operation failed.');setUnknown(previous=>previous||!(e instanceof Error&&'unknown'in e&&e.unknown===false));}finally{setBusy(false);}}
 let createUrl='';try{createUrl=slackManifest({name:p.name,display:p.display},p.origin).createUrl;}catch{}
 return <section aria-label="Door setup"><h2>Connect doors</h2>
 <p>Save credentials, enable the door, and apply connection changes to mount them. Claim chat doors with a private one-time code, then apply once more to activate their owner. Each apply restarts this agent.</p>
 {!createUrl&&<p role="alert">Configure the public HTTPS webhook address before creating new apps or registering webhooks. Existing applied chat doors can still be claimed.</p>}
 {SUPPORTED[p.role]?.map(kind=>{const row=rows.find(r=>r.kind===kind);return <fieldset key={kind} disabled={busy||unknown}><legend>{kind==='slack'?'Slack':kind==='telegram'?'Telegram':'Email'}</legend>
 <p>{row?.pending?`Pending: ${row.pending_reason??'Apply connection changes'}`:row?.applied&&row.enabled?'Owner connection applied':row?.enabled?'Credentials applied; owner claim still required':'Disabled or not configured'}</p>
 {kind==='slack'&&<><p>{createUrl&&<a href={createUrl} target="_blank" rel="noreferrer">Create this Slack app from its manifest</a>}</p><p>Install the app into your workspace. Paste its Bot User OAuth Token and its Basic Information signing secret.</p><label>Bot token<input type="password" autoComplete="off" value={tokens.slack??''} onChange={e=>setTokens({...tokens,slack:e.target.value})}/></label><label>Signing secret<input type="password" autoComplete="off" value={signing} onChange={e=>setSigning(e.target.value)}/></label></>}
 {kind==='telegram'&&<><ol>{telegramSteps(p.display).map(s=><li key={s.step}>{s.text}</li>)}</ol><label>Bot token<input type="password" autoComplete="off" value={tokens.telegram??''} onChange={e=>setTokens({...tokens,telegram:e.target.value})}/></label></>}
 {kind!=='email'&&<><button type="button" disabled={!tokens[kind]||(kind==='slack'&&!signing)} onClick={()=>void run(async()=>{unwrap(await connectDoor({name:p.name,kind,secret:tokens[kind],...(kind==='slack'?{signingSecret:signing}:{})}));setTokens({...tokens,[kind]:''});setSigning('');setMessage('Credentials saved. Enable the door and apply connection changes.');})}>Save credentials</button>
 {kind==='telegram'&&<button type="button" disabled={!createUrl||row?.pending||!row?.enabled} onClick={()=>void run(async()=>{unwrap(await registerTelegram(p.name));setMessage('Webhook registered. Claim the bot in a private chat.');})}>Register Telegram webhook</button>}
 <button type="button" disabled={row?.claimed||!row?.enabled||row?.pending} onClick={()=>void run(async()=>{const result=unwrap(await claimCode(p.name,kind));setCode(result.instruction+' Expires in 10 minutes.');})}>Get one-time owner code</button></>}
 {kind==='email'&&<><p>Connect one mailbox using Google consent. This agent can use only that selected mailbox. Email triage also requires an applied Slack owner door for its approval cards.</p>{row?.mailbox&&<p>Selected mailbox: {row.mailbox}</p>}<form method="post" action="/api/accounts/google/start"><input type="hidden" name="agent" value={p.name}/><label>Mailbox<input name="email" type="email" required/></label><button type="submit">Connect mailbox with Google</button></form></>}
 <button type="button" onClick={()=>void run(async()=>{const result=unwrap(await setDoorEnabled(p.name,kind,!row?.enabled));setHash(result.hash);p.onDefinitionChanged?.(result.hash);setMessage(`Door ${row?.enabled?'disabled':'enabled'} in the saved definition.${result.backup.ok?'':` ${result.backup.message??'Git backup failed; definition remains saved.'}`} Apply connection changes to update runtime mounts.`);})}>{row?.enabled?'Disable door':'Enable door'}</button>
 </fieldset>;})}
 {code&&<p role="status">{code}</p>}
 <button type="button" disabled={busy||unknown||!rows.some(r=>r.pending)} onClick={()=>void run(async()=>{unwrap(await applyConnections({name:p.name,hash}));setMessage('Connection changes applied. Reload the editor before editing its definition.');setUnknown(true);})}>Apply connection changes (restarts agent)</button>
 <button type="button" disabled={busy} onClick={()=>void run(refresh)}>Refresh connection status</button>
 {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}{unknown?' Some changes may already have taken effect. Inspect current state before retrying.':''}</p>}
 {unknown&&<p><a href={`/agents/${encodeURIComponent(p.name)}/edit`}>Reload this agent’s current state</a>. A read-only status refresh does not unlock changes.</p>}
 </section>;
}
