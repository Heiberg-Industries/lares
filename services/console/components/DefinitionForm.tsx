"use client";
import {DoorSetup} from './DoorSetup';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { assertSkillsWithinGrants } from '@lares/agent-kit/skill-grants';
import type { AgentDefinition } from '@lares/agent-kit/definition';
import type { Capacity, DefinitionResult, Role, RuntimeState, StartingPoint } from '../lib/builder';
import type { BoardRowDTO } from '../lib/contracts';
import { createAgent, saveDefinition, retireAgent, deleteAgent, applyConnections } from '../app/actions/definition';
import { ConversationControl } from "./ConversationControl";
import { AutonomyControl } from './AutonomyControl';
import { TakesEffect } from './TakesEffect';
import { CeilingNotice } from './CeilingNotice';
import { firstChatPath } from '../lib/first-conversation';

export interface DefinitionFormProps {
  publicDoorOrigin?:string;
  startingPoints: StartingPoint[];
  aliases: {alias:string;label:string;when:string}[];
  timing: Record<string,string>;
  capacity: Capacity;
  initial?: {definition:AgentDefinition;duties:string;voice:string;hash:string;runtime?:RuntimeState;status:string};
  permissions?: BoardRowDTO[];
}
const LANGUAGES=['English','Norwegian','Swedish','Danish','French','German','Spanish'];
const fieldStyle={display:'block',width:'100%',maxWidth:760,marginBottom:8,padding:8};
export function DefinitionForm(p:DefinitionFormProps) {
  const router=useRouter();
  const editing=Boolean(p.initial);
  const first=p.startingPoints[0];
  const fresh=(point:StartingPoint):AgentDefinition=>({...point.definition,name:'',gender:'agent',description:'',language:'English',model:p.aliases[0]?.alias??'',duties:'duties.md',doors:[],channels:[]});
  const [definition,setDefinition]=useState<AgentDefinition>(p.initial?.definition??fresh(first));
  const [duties,setDuties]=useState(p.initial?.duties??'');
  const [voice,setVoice]=useState(p.initial?.voice??'');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [uncertain,setUncertain]=useState(false);
  const [runtime,setRuntime]=useState(p.initial?.runtime);
  const [hash,setHash]=useState(p.initial?.hash??'');
  const [deleteConfirm,setDeleteConfirm]=useState(false);
  const point=p.startingPoints.find(s=>s.id===definition.role)??first;
  const active=!p.initial || p.initial.status!=='retired';
  const timing=(field:string)=><TakesEffect text={p.timing[field]}/>;
  let validation='';
  try { assertSkillsWithinGrants(definition); } catch(e) { validation=e instanceof Error?e.message:String(e); }
  const validName=/^[a-z][a-z0-9-]{1,30}$/.test(definition.name);
  const validModel=p.aliases.some(a=>a.alias===definition.model);
  const patch=(value:Partial<AgentDefinition>)=>setDefinition(d=>({...d,...value}));
  async function run(work:()=>Promise<void>) {
    setBusy(true);setError('');setMessage('');
    try {await work();} catch(e) {
      // The keeper can fail after disk publication or after transmission. Never retry implicitly,
      // claim rollback, or invite a duplicate create. Reload authoritative state before another write.
      const unknown = !(e instanceof Error && 'outcomeMayBeUnknown' in e && e.outcomeMayBeUnknown === false);
      setError(`${e instanceof Error?e.message:String(e)}${unknown?' Inspect the current state before trying again; some changes may already have taken effect.':''}`);
      setUncertain(unknown);
    } finally {setBusy(false);}
  }
  function saved(result:DefinitionResult) {
    setHash(result.hash);setRuntime(result.runtime);
    setMessage(`Definition saved.${result.backup.ok?'':` ${result.backup.message??'Git backup failed; the definition remains saved.'}`}`);
  }
  return <div style={{maxWidth:880}}>
    {!active&&<p role="status">This agent is retired and stopped. Its definition is read-only; permanent deletion remains available below.</p>}
    <form onSubmit={event=>{event.preventDefault();if(validation||!validName||!validModel||uncertain)return;void run(async()=>{
      const input={name:definition.name,definition,duties,voice};
      const result=editing?await saveDefinition(input):await createAgent({...input,startingPoint:point.id as Role});
      if(!result.ok) throw Object.assign(new Error([result.error.message,...(result.error.findings??[]).map(f=>`[${f.check}] ${f.message}`)].join('\n')), {outcomeMayBeUnknown:result.error.outcomeMayBeUnknown});
      saved(result.result);
      if(!editing) {
        setUncertain(true);
        router.push(firstChatPath(definition.name,result.result.backup.ok));
      }
    });}}>
      <fieldset disabled={busy||uncertain||!active} style={{border:0,padding:0}}>
        <h2>Identity</h2>
        {!editing && <><label>Name (permanent slug)<input required pattern="[a-z][a-z0-9-]{1,30}" minLength={2} maxLength={31} style={fieldStyle} value={definition.name} onChange={e=>patch({name:e.target.value})}/></label><p>Lowercase letters, digits and hyphens, starting with a letter. The name cannot change later.</p>{timing('name')}</>}
        {editing && <p>Permanent name: <strong>{definition.name}</strong></p>}
        <label>Gender<select style={fieldStyle} value={definition.gender??'agent'} onChange={e=>patch({gender:e.target.value as AgentDefinition['gender']})}><option value="agent">Agent</option><option value="female">Female</option><option value="male">Male</option></select></label>{timing('gender')}
        <label>Description<input style={fieldStyle} value={definition.description??''} onChange={e=>patch({description:e.target.value})}/></label>{timing('description')}
        {!editing && <><h2>Starting point</h2>{p.startingPoints.map(s=><label key={s.id} className="card" style={{display:'block',padding:16,marginBottom:8}}><input type="radio" name="startingPoint" checked={point.id===s.id} onChange={()=>setDefinition({...fresh(s),name:definition.name,gender:definition.gender,description:definition.description})}/> <strong>{s.label}</strong><p>{s.description}</p><p>Integrations: {s.capabilities.join(', ')}</p><p>Schedules: {s.schedules.join(', ')||'None'}</p></label>)}{timing('startingPoint')}</>}
        <h2>Duties, personality and language</h2>
        <label>What is this agent for? Write it the way you would tell a person.<textarea rows={7} style={fieldStyle} value={duties} onChange={e=>setDuties(e.target.value)}/></label>{timing('duties')}
        <label>Personality<textarea rows={6} style={fieldStyle} value={voice} onChange={e=>setVoice(e.target.value)}/></label>{timing('voice')}
        <label>Language<select required style={fieldStyle} value={definition.language??''} onChange={e=>patch({language:e.target.value})}>{!definition.language&&<option value="">Choose a language</option>}{[...new Set([...LANGUAGES,...(definition.language?[definition.language]:[])])].map(l=><option key={l}>{l}</option>)}</select></label>{timing('language')}
        <h2>Model</h2><label>Purpose<select required style={fieldStyle} value={definition.model} onChange={e=>patch({model:e.target.value})}>{!validModel&&<option value="">Choose a configured purpose alias</option>}{p.aliases.map(a=><option key={a.alias} value={a.alias}>{a.label} — {a.alias}</option>)}</select></label>
        {p.aliases.map(a=><p key={a.alias}><strong>{a.label}:</strong> {a.when}</p>)}{timing('model')}
        <h2>Integrations</h2>
        {point.definition.grants.map(g=><label key={g.capability} style={{display:'block',marginBottom:8}}><input type="checkbox" checked={definition.grants.some(x=>x.capability===g.capability)} onChange={e=>{
          const grants=e.target.checked?[...definition.grants,g]:definition.grants.filter(x=>x.capability!==g.capability);
          const autonomy=Object.fromEntries(grants.map(x=>[x.capability,definition.autonomy[x.capability]??'gated']));
          patch({grants,autonomy});
        }}/> {g.capability} ({g.scope})</label>)}{timing('grants')}
        <h2>Skills</h2>{point.definition.skills?.map(s=><label key={s.name} style={{display:'block',marginBottom:8}}><input type="checkbox" checked={definition.skills.some(x=>x.name===s.name)} onChange={e=>patch({skills:e.target.checked?[...definition.skills,s]:definition.skills.filter(x=>x.name!==s.name)})}/> {s.name} — needs {s.requires.map(r=>`${r.capability}: ${r.scope}`).join(', ')}</label>)}{timing('skills')}
        {validation&&<p role="alert" style={{color:'var(--bad)'}}>{validation}</p>}
        <h2>Permission levels</h2><p><a href="/integrations">Open the permissions board</a> for evidence and always-ask actions.</p>
        {!editing?<p>Create this agent first, then set its permission levels here. New agents start with the starting point’s permission levels.</p>:<>{(p.permissions??[]).filter(row=>definition.grants.some(g=>g.capability===row.capability)).map(row=><div key={`${row.capability}:${row.action}`} style={{marginBottom:12}}><strong>{row.capability}{row.actionLabel?` · ${row.actionLabel}`:''}</strong>{' '}{row.controllable?<AutonomyControl agent={definition.name} capability={row.capability} action={row.action||undefined} level={row.level}/>:<span>{row.scope==='write'?'Acts without asking — plain write grant.':'Reads — allowed while granted.'}</span>}{row.lockedTools.map(t=><p key={t.tool}>🔒 {t.tool}: {t.reason}</p>)}</div>)}<p>These controls save immediately, independently of the definition.</p></>}{timing('autonomy')}
        <h2>Schedules</h2>{Object.entries(definition.schedules).map(([name,s])=><label key={name} style={{display:'block',marginBottom:8}}><input type="checkbox" checked={s.on} onChange={e=>patch({schedules:{...definition.schedules,[name]:{...s,on:e.target.checked}}})}/> {name}</label>)}{timing('schedules')}
        <h2>Doors</h2>{(definition.doors??definition.channels.map(kind=>({kind,enabled:true}))).map(door=><p key={door.kind}>{door.kind}: {door.enabled?'enabled in saved definition':'disabled'}{runtime?.pending?' — connection changes pending':''}</p>)}<p>Configure saved doors below. Saving a definition does not apply a connection.</p>{timing('doors')}
        <CeilingNotice capacity={p.capacity}/>
        <button type="submit" disabled={Boolean(validation)||!validName||!validModel||(!editing&&!p.capacity.creationAvailable)}>{editing?'Save definition':'Create agent'}</button>
      </fieldset>
    </form>
    {editing&&active&&p.initial&&<DoorSetup name={p.initial.definition.name} display={p.initial.definition.display??p.initial.definition.name} role={p.initial.definition.role??point.id} origin={p.publicDoorOrigin??''} hash={hash} onDefinitionChanged={next=>{setHash(next);setUncertain(true);}}/>}
    {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
    {uncertain&&<p><a href={`/agents/${encodeURIComponent(definition.name)}/edit`}>Reload this agent’s current state</a></p>}
    {editing&&<section><h2>Runtime</h2><p>{!active?'Agent stopped.':runtime?.pending?`Connection changes are pending. ${runtime.reason??''}`:runtime?'Saved connections are applied.':'Runtime connection status is unavailable.'}</p>{runtime?.pending&&<button type="button" disabled={busy||uncertain||!hash||!active} onClick={()=>void run(async()=>{const response=await applyConnections({name:definition.name,hash});if(!response.ok)throw new Error(response.error.message);setMessage('Connection changes applied. Reload to inspect runtime state.');router.refresh();setUncertain(true);})}>Apply connection changes (restarts agent)</button>}
      {active&&<ConversationControl name={definition.name}/>}
      <h2>Agent lifecycle</h2><p>Retiring preserves its workflow data. Deleting removes its owned data and requires confirmation.</p>
      {active&&<button type="button" disabled={busy||uncertain} onClick={()=>void run(async()=>{const response=await retireAgent({name:definition.name});if(!response.ok)throw new Error(response.error.message);setMessage(`Agent retired.${response.result.backup.ok?'':` ${response.result.backup.message??'Git backup failed; the agent remains retired.'}`}`);setUncertain(true);router.refresh();})}>Retire agent</button>}
      <button type="button" disabled={busy||uncertain} onClick={()=>setDeleteConfirm(true)}>Delete agent…</button>
      {deleteConfirm&&<div role="alertdialog" aria-label="Confirm deletion"><p>Permanently delete {definition.name} and its owned data? This cannot be undone.</p><button type="button" disabled={busy||uncertain} onClick={()=>void run(async()=>{const response=await deleteAgent({name:definition.name,confirm:true});if(!response.ok)throw new Error(response.error.message);router.push('/');})}>Confirm permanent deletion</button><button type="button" onClick={()=>setDeleteConfirm(false)}>Cancel</button></div>}
    </section>}
  </div>;
}
