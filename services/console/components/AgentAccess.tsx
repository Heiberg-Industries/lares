'use client';
import { useActionState } from 'react';
import type { AgentAccessView } from '@lares/agent-kit/grant-store';
import { Choice, Field, FieldGroup, Notice } from '@lares/ui/patterns';
import { Button } from '@lares/ui/primitives/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lares/ui/primitives/card';
import { Checkbox } from '@lares/ui/primitives/checkbox';
import { Input } from '@lares/ui/primitives/input';
import { Select } from '@lares/ui/primitives/select';
import { adoptAgent,saveAgentAccess,type AccessResult } from '../app/actions/agent-access';
export function AgentAccess({name,hash,access,members}:{name:string;hash:string;access:AgentAccessView|undefined;members:{id:string;displayName:string}[]}) {
  const [adoption,adopt,adopting]=useActionState<AccessResult,FormData>(adoptAgent,{});
  const [state,save,saving]=useActionState<AccessResult,FormData>(saveAgentAccess,{});
  const organisation=access?.grants.some(g=>g.principal.kind==='organisation'),readers=access?.grants.filter(g=>g.permission==='use'&&g.principal.kind==='member').map(g=>g.principal.id)??[],editors=access?.grants.filter(g=>g.permission==='edit').map(g=>g.principal.id)??[];
  const others=members.filter(m=>m.id!==access?.ownerMemberId);
  return <Card><CardHeader><CardTitle role="heading" aria-level={2}>Agent access</CardTitle>
    <CardDescription>Sharing records who may use or edit this agent. Other members cannot chat with it until chats for members are switched on for this installation. Private sources and connected accounts are shared separately.</CardDescription></CardHeader>
    <CardContent className="lares-stack">
    {!access?<form action={adopt} className="lares-stack"><p>No member owns this agent yet. Adopting it puts it under the account you are signed in with. Only the owner of this installation may adopt an agent.</p><input type="hidden" name="agentName" value={name}/><input type="hidden" name="definitionHash" value={hash}/><Button type="submit" variant="outline" disabled={adopting}>Adopt under my identity</Button></form>:<form key={access.accessRevision} action={save} className="lares-stack">
      <p>Access settings, version {access.accessRevision}. Saving ends this agent’s open conversations in the console; start a fresh conversation afterwards.</p>
      <ul className="lares-data-list">{access.grants.map((grant,index)=><li key={index}>{grant.principal.kind==='organisation'?'Organisation':members.find(member=>member.id===grant.principal.id)?.displayName??'Member'}: {grant.permission}{grant.expiresAt?` until ${grant.expiresAt}`:' with no expiry'}</li>)}</ul>
      <input type="hidden" name="agentName" value={name}/><input type="hidden" name="revision" value={access.accessRevision}/>
      <Field label="Who may use this agent"><Select name="use" defaultValue={organisation?'organisation':readers.length?'named':'personal'}><option value="personal">Only me</option><option value="named">Named members</option><option value="organisation">Organisation, excluding restricted members</option></Select></Field>
      <FieldGroup legend="Named users (when selected above)">{others.length?others.map(m=><Choice key={m.id}><Checkbox name="readers" value={m.id} defaultChecked={readers.includes(m.id)}/>{m.displayName}</Choice>):<p className="lares-muted">No other members yet.</p>}</FieldGroup>
      <FieldGroup legend="Named editors (editing does not grant use)">{others.length?others.map(m=><Choice key={m.id}><Checkbox name="editors" value={m.id} defaultChecked={editors.includes(m.id)}/>{m.displayName}</Choice>):<p className="lares-muted">No other members yet.</p>}</FieldGroup>
      <Field label="Expiry for all selected grants (optional, UTC)" hint="Saving replaces all grants with this selection and expiry. Leave expiry empty for no expiry."><Input type="datetime-local" name="expiresAt"/></Field>
      <Button type="submit" variant="outline" disabled={saving}>Save agent access</Button>
    </form>}
    {(state.error||adoption.error)&&<Notice error>{state.error||adoption.error}</Notice>}{(state.saved||adoption.saved)&&<Notice tone="success">Agent access saved.</Notice>}
    </CardContent>
  </Card>;
}
