"use client";
import { FieldGroup } from "@lares/ui/patterns";
import { Input } from "@lares/ui/primitives/input";
import {useEffect,useRef,useState} from 'react';
import {slackClaimMessage,slackManifest,telegramConnectLink,telegramSteps,doorStateText,doorTouched} from '../lib/doors';
import {connectDoor,doorStatus,claimCode,registerTelegram,setDoorEnabled,applyConnections,verifyDoor,type DefinitionActionResult} from '../app/actions/definition';
import { Button } from '@lares/ui/primitives/button';
import { SaveEndsConversations } from './SaveEndsConversations';
import {sendTestBrief,testBriefStatus,type TestBriefStatus} from '../app/actions/delivery';
import {messagesFollowText} from '../lib/delivery';
export interface DoorStatus {kind:string;enabled:boolean;configured?:boolean;claimed:boolean;pending:boolean;pending_reason?:string;applied:boolean;webhook_set_at?:string}
/** What the owner still has to do once a chat door is applied: tap the link (Telegram) or send the message (Slack). */
export interface ConnectStep {kind:'slack'|'telegram';code:string;expiresAt:string;link?:string;message?:string;username?:string;who?:string}
const SUPPORTED:Record<string,('slack'|'telegram')[]>={creative:['slack'],'chief-of-staff':['slack','telegram']};
const LABEL:Record<string,string>={slack:'Slack',telegram:'Telegram'};
const POLL_MS=3000;
export function DoorSetup(p:{name:string;display:string;role:string;origin:string;hash:string;onDefinitionChanged?:(hash:string)=>void;
 /** Whether the agent runs now (the page's runtime state); the save warning shows only then. */
 running?:boolean|null;
 /** Called after every door action, whether it worked or not: a door change can stop or start the agent. */
 onRuntimeChanged?:()=>void}) {
 const [rows,setRows]=useState<DoorStatus[]>([]),[progress,setProgress]=useState(''),[message,setMessage]=useState(''),[error,setError]=useState(''),[unknown,setUnknown]=useState(false),[connect,setConnect]=useState<ConnectStep|null>(null);
 const [tokens,setTokens]=useState<Record<string,string>>({}),[signing,setSigning]=useState('');
 /** Set once a door switch also moved "Where messages go" to that door; stays until the page reloads. */
 const [follows,setFollows]=useState('');
 const [brief,setBrief]=useState<TestBriefStatus|null>(null),[briefRefusal,setBriefRefusal]=useState<{kind:string;text:string}|null>(null),[asking,setAsking]=useState(false);
 const busy=Boolean(progress);
 const testsBrief=p.role==='chief-of-staff';
 const latestHash=useRef(p.hash),polling=useRef(false);
 const unwrap=<T,>(r:DefinitionActionResult<T>):T=>{if(!r.ok)throw Object.assign(new Error([r.error.message,...(r.error.findings??[]).map(f=>f.message)].join(' ')),{unknown:r.error.outcomeMayBeUnknown});return r.result;};
 async function refresh(){const next=unwrap(await doorStatus(p.name));setRows(next);return next;}
 const reload=()=>{if(typeof window!=='undefined')window.location.reload();};
 useEffect(()=>{void refresh().catch(e=>setError(e.message));},[p.name]);
 useEffect(()=>{latestHash.current=p.hash;},[p.hash]);
 // "Send a test brief": the newest request's status line, polled at this section's own pace while it is on its way.
 async function refreshBrief(){try{setBrief(await testBriefStatus(p.name));}catch{}}
 useEffect(()=>{if(testsBrief)void refreshBrief();},[p.name,testsBrief]);
 useEffect(()=>{
  if(!brief?.view?.waiting)return;
  const id=setInterval(()=>{void refreshBrief();},POLL_MS);
  return()=>clearInterval(id);
 },[brief?.view?.waiting,brief?.view?.text]);
 async function askTestBrief(kind:'slack'|'telegram'){
  setAsking(true);setBriefRefusal(null);
  try{const r=await sendTestBrief({name:p.name,door:kind});if(!r.ok)setBriefRefusal({kind,text:r.message});await refreshBrief();}
  catch{setBriefRefusal({kind,text:'Could not ask the agent just now. Reload the page and try again; nothing was sent.'});}
  finally{setAsking(false);}
 }
 async function run(fn:()=>Promise<void>){setProgress('Working…');setError('');setMessage('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'Door operation failed.');setUnknown(previous=>previous||!(e instanceof Error&&'unknown'in e&&e.unknown===false));}finally{setProgress('');try{await refresh();}catch{}p.onRuntimeChanged?.();}}
 /** Applies whatever is waiting, then reloads the page so every part of it shows the new state. */
 async function applyAndReload(label:string){setProgress(label);unwrap(await applyConnections({name:p.name,hash:latestHash.current}));reload();}
 // After the one-time step is shown: watch for the owner to arrive, then apply the claim by itself.
 useEffect(()=>{
  if(!connect)return;let stopped=false;
  const id=setInterval(()=>{void (async()=>{
   if(stopped||polling.current)return;polling.current=true;
   try{
    const next=unwrap(await doorStatus(p.name));setRows(next);
    if(next.find(r=>r.kind===connect.kind)?.claimed){stopped=true;clearInterval(id);setConnect(null);await applyAndReload('Connected. Applying the last step (restarts the agent, about a minute)…');}
   }catch(e){stopped=true;clearInterval(id);setProgress('');setError(e instanceof Error?e.message:'Could not check the connection.');setUnknown(true);}
   finally{polling.current=false;}
  })();},POLL_MS);
  return()=>{stopped=true;clearInterval(id);};
 },[connect?.kind,connect?.code]);
 /** Verifies the saved token, registers Telegram's webhook, and issues the one-time code. */
 async function showConnectStep(kind:'slack'|'telegram'){
  if(kind==='telegram'){setProgress('Registering the Telegram webhook…');unwrap(await registerTelegram(p.name));}
  setProgress(`Checking the bot with ${LABEL[kind]}…`);const who=unwrap(await verifyDoor(p.name,kind));
  setProgress('Creating your one-time connection…');const issued=unwrap(await claimCode(p.name,kind));
  if(kind==='telegram'){if(!who.username)throw new Error('Telegram did not report the bot username.');setConnect({kind,code:issued.code,expiresAt:issued.expiresAt,username:who.username,link:telegramConnectLink(who.username,issued.code)});}
  else setConnect({kind,code:issued.code,expiresAt:issued.expiresAt,message:slackClaimMessage(issued.code),who:who.user&&who.team?`${who.user} in ${who.team}`:undefined});
 }
 /** Paste the credentials; saving, checking, switching on and applying all happen here in order. */
 async function connectChat(kind:'slack'|'telegram'){
  setConnect(null);
  setProgress('Saving the credentials…');unwrap(await connectDoor({name:p.name,kind,secret:tokens[kind],...(kind==='slack'?{signingSecret:signing}:{})}));
  setTokens(t=>({...t,[kind]:''}));setSigning('');
  setProgress(`Checking the bot with ${LABEL[kind]}…`);unwrap(await verifyDoor(p.name,kind));
  let current=await refresh();
  if(!current.find(r=>r.kind===kind)?.enabled){
   setProgress('Switching the door on…');const saved=unwrap(await setDoorEnabled(p.name,kind,true));
   latestHash.current=saved.hash;p.onDefinitionChanged?.(saved.hash);if(saved.messagesFollow)setFollows(messagesFollowText(saved.messagesFollow));current=await refresh();
  }
  if(current.some(r=>r.pending)){setProgress('Applying (restarts the agent, about a minute)…');unwrap(await applyConnections({name:p.name,hash:latestHash.current}));}
  await showConnectStep(kind);
 }
 const copy=(text:string,note:string)=>{void (async()=>{try{await navigator.clipboard.writeText(text);setMessage(note);}catch{setError('Could not copy; select the text and copy it by hand.');}})();};
 let createUrl='',manifestText='';try{const m=slackManifest({name:p.name,display:p.display},p.origin);createUrl=m.createUrl;manifestText=JSON.stringify(m.manifest,null,2);}catch{}
 const expiredAt=connect?Date.parse(connect.expiresAt):NaN;
 const touchedPending=rows.some(r=>doorTouched(r)&&r.pending);
 return <section aria-label="Door setup" className="lares-door-setup"><h2>Connect doors</h2>
 <p>Paste your bot's credentials and press Connect. Saving, switching the door on, applying it to this agent and checking it all happen by themselves; at the end you confirm it is you with one tap or one message.</p>
 <SaveEndsConversations running={p.running}/>
 {!createUrl&&<p role="alert">Configure the public HTTPS webhook address before creating new apps or connecting a chat door.</p>}
 {busy&&<p role="status" aria-live="polite" className="lares-door-progress"><strong>{progress}</strong> Keep this page open.</p>}
 {!busy&&touchedPending&&<p role="status" className="lares-door-progress"><strong>Changes are waiting to be applied.</strong> The agent restarts when you apply them.</p>}
 {SUPPORTED[p.role]?.map(kind=>{const row=rows.find(r=>r.kind===kind);const touched=doorTouched(row);const step=connect?.kind===kind?connect:null;return <FieldGroup key={kind} legend={LABEL[kind]} disabled={busy||unknown}>
 <p>{doorStateText(row)}</p>
 {kind==='slack'&&<><ol><li>Create the Slack app from the manifest below: pick your workspace and confirm.</li><li>Install the app into your workspace. Copy its Bot User OAuth Token (OAuth &amp; Permissions) and its Signing Secret (Basic Information).</li><li>Paste both here and press Connect.</li><li>Then send the app one direct message, <code>claim</code> followed by the code shown here. That is the only manual step.</li></ol>
  <p>{createUrl&&<a href={createUrl} target="_blank" rel="noreferrer">Create this Slack app from its manifest</a>}{manifestText&&<> <Button variant="outline" type="button" onClick={()=>copy(manifestText,'Manifest copied. In Slack, choose Create new app, From a manifest, and paste it.')}>Copy manifest</Button></>}</p>
  <label>Bot token<Input type="password" autoComplete="off" value={tokens.slack??''} onChange={e=>setTokens({...tokens,slack:e.target.value})}/></label><label>Signing secret<Input type="password" autoComplete="off" value={signing} onChange={e=>setSigning(e.target.value)}/></label></>}
 {kind==='telegram'&&<><ol>{telegramSteps(p.display).map(s=><li key={s.step}>{s.text}</li>)}</ol><label>Bot token<Input type="password" autoComplete="off" value={tokens.telegram??''} onChange={e=>setTokens({...tokens,telegram:e.target.value})}/></label></>}
 <>
 <Button variant="outline" type="button" disabled={!tokens[kind]||(kind==='slack'&&!signing)||(kind==='telegram'&&!createUrl)||(kind==='slack'&&!createUrl)} onClick={()=>void run(()=>connectChat(kind))}>{touched?'Replace credentials and connect':'Connect'}</Button>
 {!step&&row?.enabled&&!row.claimed&&!row.pending&&<Button variant="outline" type="button" onClick={()=>void run(()=>showConnectStep(kind))}>{kind==='telegram'?'Show the tap-to-connect link':'Show the one-time code'}</Button>}
 {testsBrief&&doorStateText(row)==='Connected'&&<div className="lares-test-brief">
  <Button variant="outline" type="button" disabled={asking||Boolean(brief?.view?.waiting)} onClick={()=>void askTestBrief(kind)}>{`Send a test brief to ${LABEL[kind]}`}</Button>
  {briefRefusal?.kind===kind?<p role="alert">{briefRefusal.text}</p>:brief?.view?.door===kind&&<p role="status">{brief.view.text}</p>}
  {brief?.dnd&&<p className="lares-muted">Do-not-disturb is on; this test still goes out because you asked.</p>}
 </div>}
 {kind==='telegram'&&row?.enabled&&!row.pending&&createUrl&&<Button variant="outline" type="button" onClick={()=>void run(async()=>{unwrap(await registerTelegram(p.name));setMessage('Webhook registered.');})}>Register Telegram webhook</Button>}
 {step?.link&&<div role="status" className="lares-door-connect"><p><strong>Last step:</strong> open Telegram with this link and press Start.</p><p><a className="lares-door-tap" href={step.link} target="_blank" rel="noreferrer">Tap to connect</a></p><p>This page notices by itself and finishes applying. The link works once, for 10 minutes{Number.isFinite(expiredAt)&&expiredAt<Date.now()?' (it has expired; ask for a new one above)':''}.</p></div>}
 {step?.message&&<div role="status" className="lares-door-connect"><p><strong>Last step:</strong> {step.who?`open a direct message with ${step.who}`:'open a direct message with the app'} in Slack and send exactly:</p><p><code>{step.message}</code> <Button variant="outline" type="button" onClick={()=>copy(step.message!,'Copied. Paste it into the direct message with the app.')}>Copy</Button></p><p>This page notices by itself and finishes applying. The code works once, for 10 minutes{Number.isFinite(expiredAt)&&expiredAt<Date.now()?' (it has expired; ask for a new one above)':''}.</p></div>}</>
 {touched&&<Button variant="outline" type="button" onClick={()=>void run(async()=>{const result=unwrap(await setDoorEnabled(p.name,kind,!row?.enabled));latestHash.current=result.hash;p.onDefinitionChanged?.(result.hash);if(result.messagesFollow)setFollows(messagesFollowText(result.messagesFollow));setMessage(`Door ${row?.enabled?'disabled':'enabled'} in the saved definition.${result.backup.ok?'':` ${result.backup.message??'Git backup failed; definition remains saved.'}`} Apply connection changes to update runtime mounts.`);})}>{row?.enabled?'Disable door':'Enable door'}</Button>}
 </FieldGroup>;})}
 {touchedPending&&<Button variant="outline" type="button" disabled={busy||unknown} onClick={()=>void run(()=>applyAndReload('Applying (restarts the agent, about a minute)…'))}>Apply connection changes (restarts agent)</Button>}
 {follows&&<p role="status">{follows}</p>}
 {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}{unknown?' Some changes may already have taken effect. Inspect current state before retrying.':''}</p>}
 {unknown&&<p><a href={`/agents/${encodeURIComponent(p.name)}/edit`}>Reload this agent’s current state</a> before trying again.</p>}
 </section>;
}
