'use client';
import { useActionState } from 'react';
import type { AgentAccessView } from '@lares/agent-kit/grant-store';
import { adoptAgent,saveAgentAccess,type AccessResult } from '../app/actions/agent-access';
export function AgentAccess({name,hash,access,members}:{name:string;hash:string;access:AgentAccessView|undefined;members:{id:string;displayName:string}[]}) {
  const [adoption,adopt,adopting]=useActionState<AccessResult,FormData>(adoptAgent,{});
  const [state,save,saving]=useActionState<AccessResult,FormData>(saveAgentAccess,{});
  const organisation=access?.grants.some(g=>g.principal.kind==='organisation'),readers=access?.grants.filter(g=>g.permission==='use'&&g.principal.kind==='member').map(g=>g.principal.id)??[],editors=access?.grants.filter(g=>g.permission==='edit').map(g=>g.principal.id)??[];
  return <section className="lares-surface lares-stack"><h2 className="lares-section-title">Agent access</h2>
    <p>Sharing records who may use or edit this agent. Member conversations remain unavailable until isolated runtime access is enabled. Private sources and connected accounts need their own authority.</p>
    {!access?<form action={adopt} className="lares-stack"><p>This agent has no adopted member owner. Adoption uses your signed-in identity and requires your current owner capability policy.</p><input type="hidden" name="agentName" value={name}/><input type="hidden" name="definitionHash" value={hash}/><button disabled={adopting}>Adopt under my identity</button></form>:<form key={access.accessRevision} action={save} className="lares-stack">
      <p>Access revision {access.accessRevision}. Saving ends existing console conversations; start a fresh conversation afterwards.</p>
      <ul>{access.grants.map((grant,index)=><li key={index}>{grant.principal.kind==='organisation'?'Organisation':members.find(member=>member.id===grant.principal.id)?.displayName??'Member'}: {grant.permission}{grant.expiresAt?` until ${grant.expiresAt}`:' with no expiry'}</li>)}</ul>
      <input type="hidden" name="agentName" value={name}/><input type="hidden" name="revision" value={access.accessRevision}/>
      <label>Who may use this agent <select name="use" defaultValue={organisation?'organisation':readers.length?'named':'personal'}><option value="personal">Only me</option><option value="named">Named members</option><option value="organisation">Organisation, excluding restricted members</option></select></label>
      <fieldset><legend>Named users (when selected above)</legend>{members.filter(m=>m.id!==access.ownerMemberId).map(m=><label key={m.id}><input type="checkbox" name="readers" value={m.id} defaultChecked={readers.includes(m.id)}/>{m.displayName}</label>)}</fieldset>
      <fieldset><legend>Named editors (editing does not grant use)</legend>{members.filter(m=>m.id!==access.ownerMemberId).map(m=><label key={m.id}><input type="checkbox" name="editors" value={m.id} defaultChecked={editors.includes(m.id)}/>{m.displayName}</label>)}</fieldset>
      <label>Expiry for all selected grants (optional, UTC) <input type="datetime-local" name="expiresAt"/></label><p>Saving replaces all grants with this selection and expiry. Leave expiry empty for no expiry.</p>
      <button disabled={saving}>Save agent access</button>
    </form>}
    {(state.error||adoption.error)&&<p role="alert">{state.error||adoption.error}</p>}{(state.saved||adoption.saved)&&<p role="status">Agent access saved.</p>}
  </section>;
}
