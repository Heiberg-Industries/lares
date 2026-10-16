import {beforeEach,it,expect,vi} from 'vitest';
import {registerConversationActions, runtimeReset} from '../lib/conversations.js';
import {resetActions,runAction} from '../lib/actions.js';
const incarnation='11111111-1111-4111-8111-111111111111';
const query=vi.fn(),reset=vi.fn();
beforeEach(()=>{resetActions();vi.clearAllMocks();registerConversationActions({query} as never,reset);});
it('binds reset to current agent incarnation and exact listed session',async()=>{
 query.mockResolvedValue({rows:[{name:'example',ownership_token:incarnation,session_id:'wrun_one'}]});reset.mockResolvedValue({status:'reset'});
 const ctx={actor:'owner@example.test',audit:vi.fn()};
 await runAction('conversation.reset',{name:'example',incarnation,sessionId:'wrun_one',confirm:true},ctx);
 expect(reset).toHaveBeenCalledWith('example',incarnation,'wrun_one');
 expect(ctx.audit.mock.calls.at(-1)?.[0]).toMatchObject({outcome:'ok',actor:ctx.actor});
 query.mockResolvedValue({rows:[]});
 await expect(runAction('conversation.reset',{name:'example',incarnation,sessionId:'wrun_one',confirm:true},ctx)).rejects.toThrow(/incarnation/);
 expect(reset).toHaveBeenCalledTimes(1);
});
it('requires explicit confirmation before any reset',async()=>{
 await expect(runAction('conversation.reset',{name:'example',incarnation,sessionId:'wrun_one',confirm:false},{actor:'owner',audit:vi.fn()})).rejects.toThrow('invalid input');
 expect(reset).not.toHaveBeenCalled();
});
it('exec bridge uses only a matching owned container and fixed program, never caller shell',async()=>{
 const exec=vi.fn().mockResolvedValueOnce({stdout:'a'.repeat(64)+'\n'}).mockResolvedValueOnce({stdout:'{"status":"reset"}'});
 expect(await runtimeReset('project','example',incarnation,'wrun_one',exec)).toEqual({status:'reset'});
 expect(exec.mock.calls[0][1]).toContain('label=com.docker.compose.project=project');
 expect(exec.mock.calls[0][1]).toContain(`label=lares.incarnation=${incarnation}`);
 expect(exec.mock.calls[1][1].slice(0,5)).toEqual(['exec','a'.repeat(64),'node','--input-type=module','-e']);
 expect(exec.mock.calls[1][1].slice(-2)).toEqual([incarnation,'wrun_one']);
});
