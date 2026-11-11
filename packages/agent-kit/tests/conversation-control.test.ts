import {fileURLToPath,pathToFileURL} from 'node:url';
import {it,expect,vi} from 'vitest';
import {observeConversation, resetConversation} from '../src/conversation-control.js';
const env={LARES_AGENT_NAME:'example',LARES_AGENT_INCARNATION:'11111111-1111-4111-8111-111111111111'};
// eve 1.0 events, shaped from `node_modules/eve/dist/src/protocol/session-events/families/*.d.ts`.
const opened=(kind:string)=>({type:'interaction.opened',data:{interactionId:'int_1',subject:{callId:'call_1'},request:{kind,prompt:'Approve?'}}});
const ended=(outcome='completed')=>({type:'session.ended',data:{outcome}});
const settled={type:'delivery.settled',data:{deliveryId:'del_1',outcome:'handled',turnId:'turn_1'}};
it('projects only root conversational sessions under the runtime incarnation',async()=>{
 const db={query:vi.fn().mockResolvedValue({rows:[]})};
 const ctx={session:{id:'wrun_one',auth:{initiator:null}},channel:{kind:'channel:telegram'}};
 await observeConversation({type:'session.started',data:{}},ctx,db,env);
 expect(db.query).toHaveBeenCalledTimes(2);expect(db.query.mock.calls[0][1]).toEqual(['example',env.LARES_AGENT_INCARNATION,'wrun_one','telegram',false]);
 db.query.mockClear();
 await observeConversation({type:'session.started',data:{}},{...ctx,session:{...ctx.session,parent:{}}},db,env);
 await observeConversation({type:'session.started',data:{}},{...ctx,session:{...ctx.session,auth:{initiator:{principalId:'eve:app',principalType:'runtime'}}}},db,env);
 expect(db.query).not.toHaveBeenCalled();
});
it('a finished request and a person being asked keep the row current; the end of the session closes it',async()=>{
 const db={query:vi.fn().mockResolvedValue({rows:[]})};
 const ctx={session:{id:'wrun_one',auth:{initiator:null}},channel:{kind:'channel:slack'}};
 await observeConversation(settled,ctx,db,env);
 expect(db.query.mock.calls[0][1]).toEqual(['example',env.LARES_AGENT_INCARNATION,'wrun_one','slack',false]);
 db.query.mockClear();
 // The conversation is waiting on the owner from the moment an approval or a question opens.
 for(const kind of ['approval','question','budget']){
  await observeConversation(opened(kind),ctx,db,env);
  expect(db.query.mock.calls[0][0]).toMatch(/INSERT INTO agent_conversations/);
  expect(db.query.mock.calls[0][1]).toEqual(['example',env.LARES_AGENT_INCARNATION,'wrun_one','slack',false]);
  db.query.mockClear();
 }
 // A sign-in is not the owner approving anything.
 await observeConversation(opened('sign-in'),ctx,db,env);
 expect(db.query).not.toHaveBeenCalled();
 // session.ended is the one terminal event, whatever its outcome.
 for(const outcome of ['completed','failed']){
  await observeConversation(ended(outcome),ctx,db,env);
  expect(db.query.mock.calls[0][1]).toEqual(['example',env.LARES_AGENT_INCARNATION,'wrun_one','slack',true]);
  db.query.mockClear();
 }
});
it('ignores an event type it does not know, and the 0.60 names, without throwing or writing',async()=>{
 const db={query:vi.fn().mockResolvedValue({rows:[]})};
 const ctx={session:{id:'wrun_one',auth:{initiator:null}},channel:{kind:'channel:telegram'}};
 for(const event of [{type:'brand.new.event',data:{}},{type:'future.thing'},{type:'session.completed'},{type:'session.failed'},{type:'session.reset'},{type:'session.waiting'},{type:'input.requested'},{type:'turn.settled',data:{outcome:'failed'}},{type:'content.completed',data:{}},{type:'usage.recorded',data:{}},{type:'interaction.opened'},{type:'interaction.opened',data:null},{type:'interaction.opened',data:{request:null}}]){
  await expect(observeConversation(event as never,ctx,db,env)).resolves.toBeUndefined();
 }
 expect(db.query).not.toHaveBeenCalled();
});
it('files the default eve channel under the web label, and only the known channels at all',async()=>{
 const db={query:vi.fn().mockResolvedValue({rows:[]})};
 const at=(kind:string|undefined)=>({session:{id:'wrun_one',auth:{initiator:null}},channel:{kind}});
 await observeConversation({type:'session.started',data:{}},at('channel:eve'),db,env);
 expect(db.query.mock.calls[0][1][3]).toBe('http');db.query.mockClear();
 await observeConversation({type:'session.started',data:{}},at('http'),db,env);
 expect(db.query.mock.calls[0][1][3]).toBe('http');db.query.mockClear();
 for(const kind of ['channel:mystery','schedule','subagent','unknown','constructor','__proto__',undefined])await observeConversation({type:'session.started',data:{}},at(kind),db,env);
 await observeConversation({type:'session.started',data:{}},{session:{id:'x',auth:null}} as never,db,env);
 expect(db.query).not.toHaveBeenCalled();
});
it('never throws when the database does: it warns and moves on',async()=>{
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
 const db={query:vi.fn().mockRejectedValue(new Error('down'))};
 const ctx={session:{id:'wrun_one',auth:{initiator:null}},channel:{kind:'channel:slack'}};
 await expect(observeConversation({type:'session.started',data:{}},ctx,db,env)).resolves.toBeUndefined();
 expect(warn).toHaveBeenCalled();warn.mockRestore();
});
/** What eve 1.0's `session.end()` resolves with: a delivery receipt whose `result()` settles later. */
const delivery=(sessionEnded:boolean)=>({result:vi.fn().mockResolvedValue({sessionEnded,outcome:'handled'})});
it('ends only a proven exact session and refuses replacement incarnations',async()=>{
 const db={query:vi.fn().mockResolvedValue({rows:[{session_id:'wrun_one'}]})};
 const end=vi.fn().mockResolvedValue(delivery(true));const attach=vi.fn(()=>({end}));
 await expect(resetConversation({sessionId:'wrun_one',incarnation:'wrong',confirm:true},attach,db,env)).rejects.toThrow(/incarnation/);
 expect(attach).not.toHaveBeenCalled();
 await expect(resetConversation({sessionId:'wrun_one',incarnation:env.LARES_AGENT_INCARNATION,confirm:false as never},attach,db,env)).rejects.toThrow(/Confirmed/);
 await expect(resetConversation({sessionId:'not-a-run',incarnation:env.LARES_AGENT_INCARNATION,confirm:true},attach,db,env)).rejects.toThrow(/Confirmed/);
 expect(attach).not.toHaveBeenCalled();
 await expect(resetConversation({sessionId:'wrun_one',incarnation:env.LARES_AGENT_INCARNATION,confirm:true},attach,db,env)).resolves.toEqual({status:'reset'});
 expect(attach).toHaveBeenCalledWith('wrun_one');expect(end).toHaveBeenCalledOnce();
 expect(db.query.mock.calls.at(-1)?.[0]).toMatch(/UPDATE agent_conversations SET terminal=true/);
 db.query.mockResolvedValue({rows:[]});
 await expect(resetConversation({sessionId:'wrun_other',incarnation:env.LARES_AGENT_INCARNATION,confirm:true},attach,db,env)).rejects.toThrow(/owned/);
 expect(attach).toHaveBeenCalledTimes(1);
});
it('marks the conversation finished only when eve confirms the end (or says nothing is active)',async()=>{
 const owned={query:vi.fn().mockResolvedValue({rows:[{session_id:'wrun_one'}]})};
 const input={sessionId:'wrun_one',incarnation:env.LARES_AGENT_INCARNATION,confirm:true};
 const marked=()=>owned.query.mock.calls.some(call=>/UPDATE agent_conversations/.test(String(call[0])));
 // Accepted but the session did not end: refuse to say it did, and leave the row alone.
 await expect(resetConversation(input,()=>({end:vi.fn().mockResolvedValue(delivery(false))}),owned,env)).rejects.toThrow();
 expect(marked()).toBe(false);
 // eve refuses the request.
 await expect(resetConversation(input,()=>({end:vi.fn().mockRejectedValue(new Error('boom'))}),owned,env)).rejects.toThrow('boom');
 expect(marked()).toBe(false);
 // The result never arrives in time.
 vi.useFakeTimers();
 const never={result:vi.fn(()=>new Promise<never>(()=>{}))};
 const pending=resetConversation(input,()=>({end:vi.fn().mockResolvedValue(never)}),owned,env);
 const assertion=expect(pending).rejects.toThrow(/not confirmed/);
 await vi.advanceTimersByTimeAsync(20_000);await assertion;vi.useRealTimers();
 expect(marked()).toBe(false);
 // eve says the session is not active (409 session_not_active): nothing left to end, mark it done.
 const gone=Object.assign(new Error('not active'),{code:'session_not_active'});
 await expect(resetConversation(input,()=>({end:vi.fn().mockRejectedValue(gone)}),owned,env)).resolves.toEqual({status:'no_active_session'});
 expect(marked()).toBe(true);
 // session_not_ready is a retry, not an end.
 owned.query.mockClear();
 const notReady=Object.assign(new Error('retry'),{code:'session_not_ready'});
 await expect(resetConversation(input,()=>({end:vi.fn().mockRejectedValue(notReady)}),owned,env)).rejects.toThrow('retry');
 expect(marked()).toBe(false);
});
it('a schedule-opened session joins only once it asks the owner something, then stays current',async()=>{
 const db={query:vi.fn().mockResolvedValue({rows:[]})};
 const ctx={session:{id:'wrun_push',auth:{initiator:{principalId:'eve:app',principalType:'runtime'}}},channel:{kind:'channel:slack'}};
 // Before it asks anything it is not a conversation: nothing is written.
 await observeConversation({type:'session.started',data:{}},ctx,db,env);
 await observeConversation(settled,ctx,db,env);
 await observeConversation(opened('sign-in'),ctx,db,env);
 expect(db.query).not.toHaveBeenCalled();
 // Its first approval card makes it one (the console's waiting page reads this row).
 await observeConversation(opened('approval'),ctx,db,env);
 expect(db.query.mock.calls[0][0]).toMatch(/INSERT INTO agent_conversations/);
 expect(db.query.mock.calls[0][1]).toEqual(['example',env.LARES_AGENT_INCARNATION,'wrun_push','slack',false]);
 db.query.mockClear();
 // Afterwards its lifecycle only updates the row it has, and never inserts one.
 await observeConversation(ended(),ctx,db,env);
 expect(db.query).toHaveBeenCalledTimes(1);
 expect(db.query.mock.calls[0][0]).toMatch(/^UPDATE agent_conversations/);
 expect(db.query.mock.calls[0][1]).toEqual(['example',env.LARES_AGENT_INCARNATION,'wrun_push',true]);
});

it('never projects tagged private lifecycle or approval events',async()=>{
 const db={query:vi.fn()};const auth={attributes:{lares_member_id:'synthetic-private'}};
 const ctx={session:{id:'private',auth:{initiator:auth}},channel:{kind:'channel:eve'}};
 for(const event of [{type:'session.started',data:{}},opened('approval'),settled,ended('completed'),ended('failed')])await observeConversation(event,ctx as never,db,env);
 expect(db.query).not.toHaveBeenCalled();
});

// The real eve 1.0 session handle (`attachSession` builds it with `createSession`) and eve's own fact
// and line builders. Only storage and timing are stood in for: the runtime records the end a moment
// after it accepts the request, as a running agent does, and serves recorded history as eve does.
const eveDist=(path:string)=>pathToFileURL(fileURLToPath(new URL(`../node_modules/eve/dist/src/${path}`,import.meta.url))).href;
type Line={at:string;facts:unknown[]};
type Control={kind:string;deliveryId:string};
async function eveSession(recordEnd:(control:Control)=>unknown[]|undefined) {
 const {createSession}=await import(eveDist('channel/session.js'));
 const {fact}=await import(eveDist('harness/facts.js'));
 const {eventsOfLine}=await import(eveDist('protocol/session-lines.js'));
 const lines:Line[]=[{at:new Date().toISOString(),facts:[fact('session.started',{})]}];
 const runtime={
  async dispatchSession({command,sessionId}:{command:Control;sessionId:string}) {
   setTimeout(()=>{const facts=recordEnd(command);if(facts)lines.push({at:new Date().toISOString(),facts});},30);
   return {status:'accepted',sessionId};
  },
  async getEventStream(_id:string,options:{follow?:boolean}={}) {
   if(options.follow!==false)throw new Error('this stand-in serves recorded history only');
   const events=lines.slice().flatMap((line,index)=>eventsOfLine(line,index,line.at));
   return new ReadableStream({start(controller){for(const event of events)controller.enqueue(event);controller.close();}});
  },
 };
 return (id:string)=>createSession(id,runtime);
}
it('the console reset reports success once eve records the end, with the real eve session handle',async()=>{
 const {sessionEndedFacts}=await import(eveDist('harness/facts.js'));
 const owned={query:vi.fn().mockResolvedValue({rows:[{session_id:'wrun_one'}]})};
 const marked=()=>owned.query.mock.calls.some(call=>/UPDATE agent_conversations SET terminal=true/.test(String(call[0])));
 const input={sessionId:'wrun_one',incarnation:env.LARES_AGENT_INCARNATION,confirm:true};
 // What eve records when it applies an end: the request admitted and applied, then the session ended.
 const attach=await eveSession(control=>sessionEndedFacts(undefined,{control:{deliveryId:control.deliveryId},outcome:'completed'}));
 await expect(resetConversation(input,attach,owned,env)).resolves.toEqual({status:'reset'});
 expect(marked()).toBe(true);
});
it('a refused end through the real eve session handle still answers an error and leaves the row open',async()=>{
 const {controlSettled}=await import(eveDist('harness/facts.js'));
 const owned={query:vi.fn().mockResolvedValue({rows:[{session_id:'wrun_one'}]})};
 const marked=()=>owned.query.mock.calls.some(call=>/UPDATE agent_conversations/.test(String(call[0])));
 const input={sessionId:'wrun_one',incarnation:env.LARES_AGENT_INCARNATION,confirm:true};
 const attach=await eveSession(control=>controlSettled({control:{deliveryId:control.deliveryId},outcome:'refused',reason:'not allowed',source:'reset'}));
 await expect(resetConversation(input,attach,owned,env)).rejects.toThrow();
 expect(marked()).toBe(false);
});
