"use client";
import {useState} from 'react';
import { Button } from '@lares/ui/primitives/button';
import {listConversations,startFreshConversation} from '../app/actions/definition';
type Conversation={sessionId:string;incarnation:string;door:string;observedAt:string;terminal:boolean};
export function ConversationControl({name}:{name:string}) {
 const [rows,setRows]=useState<Conversation[]|null>(null),[selected,setSelected]=useState<Conversation|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[blocked,setBlocked]=useState(false);
 return <section><h2>Start a fresh conversation now</h2><p>Choose the exact conversation to end. Your next message through its door starts a fresh one using the saved definition.</p>
 <Button variant="outline" type="button" disabled={busy} onClick={async()=>{setBusy(true);setMessage('');setSelected(null);try{const response=await listConversations({name});if(!response.ok)throw new Error(response.error.message);setRows(response.result);setBlocked(false);}catch(e){setRows(null);setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}>Load recent conversations</Button>
 {rows?.length===0&&<p>No recorded conversations for this agent’s current incarnation. Older conversations may predate runtime tracking.</p>}
 {rows?.map(row=><p key={row.sessionId}><Button variant="outline" type="button" disabled={busy||blocked||row.terminal} onClick={()=>setSelected(row)}>{row.door} · {new Date(row.observedAt).toLocaleString()} · {row.sessionId}{row.terminal?' (ended)':''}</Button></p>)}
 {selected&&<div role="alertdialog" aria-label="Confirm fresh conversation"><p>End conversation {selected.sessionId}? This cancels pending replies and approvals in this conversation. Its history remains; pending approvals are not executed. The next message starts fresh.</p><Button type="button" disabled={busy||blocked} onClick={async()=>{setBusy(true);setMessage('');try{const result=await startFreshConversation({name,sessionId:selected.sessionId,incarnation:selected.incarnation,confirm:true});if(!result.ok)throw new Error(result.error.message);setMessage(result.result.status==='reset'?'Conversation ended. Send your next message to start fresh.':'This conversation was already inactive. Send your next message to start fresh.');setSelected(null);setRows(null);}catch(e){setMessage(`${e instanceof Error?e.message:String(e)} The outcome may be unknown. Inspect session state before retrying.`);setBlocked(true);}finally{setBusy(false);}}}>End this conversation and start fresh on my next message</Button><Button variant="outline" type="button" disabled={busy} onClick={()=>setSelected(null)}>Cancel</Button></div>}
 {message&&<p role="status">{message}</p>}</section>;
}
