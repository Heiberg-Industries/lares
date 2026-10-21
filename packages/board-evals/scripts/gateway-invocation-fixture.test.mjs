import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactionHookSource, fixtureInput, gatewayModelSource } from './gateway-invocation-fixture.mjs';

test('merged Anthropic text, pending approval notes, tool results, and a later human input remain distinct',()=>{
  const fixture={messages:[{role:'user',content:[{type:'text',text:'Available skills: none'},{type:'text',text:'SEND_ATTACK {"subject":"prior"}'},{type:'text',text:'[Pending approvals]\nA pending card'}]},
    {role:'assistant',content:[{type:'tool_use',name:'personal_mailbox_send',id:'fixture-call',input:{}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'fixture-call',content:'Tool execution was denied.'}]}]};
  const resumed=fixtureInput(fixture);
  assert.equal(resumed.message,'SEND_ATTACK {"subject":"prior"}');assert.equal(resumed.currentResults,true);
  assert.deepEqual(resumed.toolResults,['Tool execution was denied.']);
  assert.equal(resumed.messages[0].text,'Available skills: none');
  fixture.messages.at(-1).content.push({type:'text',text:'SEND {"subject":"new"}'});
  const fresh=fixtureInput(fixture);assert.equal(fresh.message,'SEND {"subject":"new"}');assert.equal(fresh.currentResults,false);
});
test('OpenAI text and tool role messages preserve the same synthetic scripting boundary',()=>{
  const input=fixtureInput({messages:[{role:'user',content:'MAIL {}'},{role:'tool',content:'fixture result'}]});
  assert.equal(input.message,'MAIL {}');assert.deepEqual(input.toolResults,['fixture result']);
});
test('generated model scope record uses a runtime newline rather than a literal backslash-n',()=>{
  const source=gatewayModelSource('const attacked=');
  const record=source.slice(source.indexOf('function record'),source.indexOf('export const gatewayModel'));
  let output;
  const execute=new Function('currentModelInvocation','appendFileSync','process',record.replace('method:string','method')+';record("stream");');
  execute(()=>({event:{type:'step.started'}}),(_path,value)=>{output=value;},{env:{PROOF_MODEL_LOG:'fixture'}});
  assert.equal(output.split('\n').filter(Boolean).length,1);assert.ok(output.endsWith('\n'));assert.equal(JSON.parse(output).method,'stream');
});

test('copied hook receipt preserves exact production error and actual event',()=>{
  const source=compactionHookSource("export default defineHook({ events: { 'compaction.requested': refuseModelCompaction } });");
  const body=source.replace(/^import[^\n]+\n/,'').replace('export default','return').replace('PROOF_COMPACTION_LOG!','PROOF_COMPACTION_LOG');
  const failure=new Error('Model compaction requires a fresh trusted invocation');let receipt;
  const hook=new Function('defineHook','refuseModelCompaction','appendFileSync','process',body)(value=>value,()=>{throw failure;},(_path,line)=>{receipt=JSON.parse(line);},{env:{PROOF_COMPACTION_LOG:'fixture'}});
  const event={type:'compaction.requested',data:{sequence:4,turnId:'turn-actual'}};
  assert.throws(()=>hook.events['compaction.requested'](event,{session:{id:'actual-session'}}),error=>error===failure);
  assert.deepEqual(receipt,{event,sessionId:'actual-session',error:failure.message});
});
