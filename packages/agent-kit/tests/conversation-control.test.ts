import {it,expect,vi} from 'vitest';
import {observeConversation, resetConversation} from '../src/conversation-control.js';
const env={LARES_AGENT_NAME:'example',LARES_AGENT_INCARNATION:'11111111-1111-4111-8111-111111111111'};
it('projects only root conversational sessions under the runtime incarnation',async()=>{
 const db={query:vi.fn().mockResolvedValue({rows:[]})};
 const ctx={session:{id:'wrun_one',auth:{initiator:null}},channel:{kind:'channel:telegram'}};
 await observeConversation({type:'session.started'},ctx,db,env);
 expect(db.query).toHaveBeenCalledTimes(2);expect(db.query.mock.calls[0][1]).toEqual(['example',env.LARES_AGENT_INCARNATION,'wrun_one','telegram',false]);
 db.query.mockClear();
 await observeConversation({type:'session.started'},{...ctx,session:{...ctx.session,parent:{}}},db,env);
 await observeConversation({type:'session.started'},{...ctx,session:{...ctx.session,auth:{initiator:{principalId:'eve:app',principalType:'runtime'}}}},db,env);
 expect(db.query).not.toHaveBeenCalled();
});
it('resets only a proven exact session and refuses replacement incarnations',async()=>{
 const db={query:vi.fn().mockResolvedValue({rows:[{session_id:'wrun_one'}]})};
 const reset=vi.fn().mockResolvedValue({status:'reset',previousSessionId:'wrun_one'});const attach=vi.fn(()=>({reset}));
 await expect(resetConversation({sessionId:'wrun_one',incarnation:'wrong',confirm:true},attach,db,env)).rejects.toThrow(/incarnation/);
 expect(attach).not.toHaveBeenCalled();
 await resetConversation({sessionId:'wrun_one',incarnation:env.LARES_AGENT_INCARNATION,confirm:true},attach,db,env);
 expect(attach).toHaveBeenCalledWith('wrun_one');expect(reset).toHaveBeenCalledOnce();
 db.query.mockResolvedValue({rows:[]});
 await expect(resetConversation({sessionId:'wrun_other',incarnation:env.LARES_AGENT_INCARNATION,confirm:true},attach,db,env)).rejects.toThrow(/owned/);
 expect(attach).toHaveBeenCalledTimes(1);
});
