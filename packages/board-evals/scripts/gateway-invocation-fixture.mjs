/** Local HTTP provider for the compiled-role invocation proof. No external provider access. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROMPT_CACHE_BOUNDARY } from '@lares/agent-kit/prompt-cache';

export function gatewayModelSource(source) {
  const prefix = source.slice(0, source.indexOf('const attacked='));
  return prefix + `
import {createGatewayProvider} from '@lares/agent-kit/gateway-provider';
import {currentModelInvocation} from '@lares/agent-kit/definition-model';
import {wrapLanguageModel} from 'ai';
const provider=createGatewayProvider({defaultKeyFile:process.env.PROOF_GATEWAY_KEY!});
function record(method:string){const scope=currentModelInvocation();if(!scope)throw new Error('Missing actual invocation scope');appendFileSync(process.env.PROOF_MODEL_LOG+'.scope',JSON.stringify({method,...scope})+'\\n');}
export const gatewayModel=(alias:string)=>wrapLanguageModel({model:provider.gatewayModel(alias) as Exclude<ReturnType<typeof provider.gatewayModel>,string>,middleware:{
 wrapGenerate:async({doGenerate})=>{record('generate');return doGenerate();},
 wrapStream:async({doStream})=>{record('stream');return doStream();},
}});
export const gatewayUrl=provider.gatewayUrl;
export const gatewayKey=provider.gatewayKey;
export const IDENTITY_ENCODING_HEADERS={'Accept-Encoding':'identity'};
`;
}
/** Instrument only the disposable copied hook. Re-throw the exact production error after
 * recording its actual event so a private workflow's generic failure cannot fake the proof. */
export function compactionHookSource(source) {
  const marker="'compaction.requested': refuseModelCompaction";
  assert.ok(source.includes(marker),'Actual role hook changed; review proof instrumentation');
  return "import {appendFileSync} from 'node:fs';\n"+source.replace(marker,`'compaction.requested': (event, ctx) => {
    try { return refuseModelCompaction(); }
    catch (error) {
      appendFileSync(process.env.PROOF_COMPACTION_LOG!,JSON.stringify({event,sessionId:ctx.session.id,error:error instanceof Error?error.message:null})+'\\n');
      throw error;
    }
  }`);
}
const text = content => typeof content === 'string' ? content : (content ?? []).map(p => p.type === 'text' ? p.text : p.type === 'tool_result' ? text(p.content) : '').join('\n');
/** The Anthropic SDK merges adjacent user messages into one array. Keep text blocks
 * distinct from tool results and framework approval notes when scripting the fake reply. */
export function fixtureInput(body) {
  const messages=body.messages.flatMap(m=>Array.isArray(m.content)?m.content.map(p=>({
    role:p.type==='tool_result'?'tool':m.role,content:[p],text:p.type==='tool_result'?text(p.content):p.type==='text'?p.text:'',
  })):[{...m,text:text(m.content)}]);
  const human=messages.findLastIndex(m=>m.role==='user'&&m.text&&!m.text.startsWith('[Pending approvals]'));
  const current=messages.slice(human+1).filter(m=>m.role==='tool');
  return {messages,message:messages[human]?.text??'',currentResults:current.length>0,toolResults:current.map(m=>m.text)};
}
export async function startGatewayFixture(root, lane) {
  assert.ok(['anthropic','openai-compatible'].includes(lane));
  let role, count=0;
  const attacked=new Set(), calls=[];
  const server=createServer(async(req,res)=>{
    try {
      assert.equal(req.url,lane==='anthropic'?'/v1/messages':'/v1/chat/completions');
      assert.equal(req.method,'POST');
      assert.equal(req.headers['accept-encoding'],'identity');
      assert.equal(lane==='anthropic'?req.headers['x-api-key']:req.headers.authorization,lane==='anthropic'?'fixture-gateway-key':'Bearer fixture-gateway-key');
      let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
      assert.equal(body.model,'fixture-brain');
      assert.ok(!raw.includes(PROMPT_CACHE_BOUNDARY));
      const {messages,message,currentResults,toolResults}=fixtureInput(body);
      const tools=body.tools.map(t=>({name:t.name??t.function.name}));
      const frame={message,messages,tools,toolResults};
      appendFileSync(join(root,role+'-model.jsonl'),JSON.stringify(frame)+'\n');
      calls.push({role,message,path:req.url});count++;
      const inputTokens=Math.max(10,Math.ceil(raw.length/4));
      if(message==='TRANSIENT_ERROR'||message==='UNSUPPORTED_TOOL'){
        const error={type:message==='TRANSIENT_ERROR'?'overloaded_error':'invalid_request_error',message:message==='TRANSIENT_ERROR'?'Synthetic transient failure':`Tool type 'web_search_20250305' is not supported`};
        res.writeHead(message==='TRANSIENT_ERROR'?503:400,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error}));return;
      }
      let answer=message==='EMPTY_RESPONSE'?'':message.startsWith('LONG ') ? 'ANSWER LONG' : message==='question'?'Which topic would you like to discuss?':'ANSWER '+message+' '+JSON.stringify(toolResults);
      let toolCalls=[];
      if(message.startsWith('SEND ')&&!currentResults)toolCalls=[{name:'personal_mailbox_send',input:JSON.parse(message.slice(5))}];
      if(message.startsWith('SEND_ATTACK ')&&!currentResults)toolCalls=[{name:'personal_mailbox_send',input:JSON.parse(message.slice(12))}];
      if(message.startsWith('SEND_ATTACK ')&&currentResults&&!attacked.has(message)){attacked.add(message);const input=JSON.parse(message.slice(12));toolCalls=[{name:'personal_mailbox_send',input},{name:'personal_mailbox_read',input:{selection:input.selection,id:'proof-message'}}];}
      if(message.startsWith('MAIL ')&&!currentResults)toolCalls=[{name:'gmail_read',input:{id:'proof-message',selection:JSON.parse(message.slice(5))}}];
      if(message.startsWith('SKILL ')&&!currentResults)toolCalls=[{name:'load_skill',input:{skill:message.slice(6)}}];
      toolCalls=toolCalls.map((t,i)=>({...t,id:`fixture-call-${count}-${i}`}));
      const stop=toolCalls.length?'tool_use':'end_turn';
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
      const emit=(event,data)=>res.write((lane==='anthropic'?`event: ${event}\n`:'')+'data: '+JSON.stringify(data)+'\n\n');
      if(lane==='anthropic'){
        emit('message_start',{type:'message_start',message:{id:`message-${count}`,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:inputTokens,output_tokens:0}}});
        if(message==='STREAM_TRANSIENT_ERROR'){emit('error',{type:'error',error:{type:'overloaded_error',message:'Synthetic transient stream'}});res.end();return;}
        for(const [index,part]of(toolCalls.length?toolCalls:[{text:answer}]).entries()){
          if(part.text!==undefined){emit('content_block_start',{type:'content_block_start',index,content_block:{type:'text',text:''}});if(part.text)emit('content_block_delta',{type:'content_block_delta',index,delta:{type:'text_delta',text:part.text}});}
          else {emit('content_block_start',{type:'content_block_start',index,content_block:{type:'tool_use',id:part.id,name:part.name,input:{}}});emit('content_block_delta',{type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(part.input)}});}
          emit('content_block_stop',{type:'content_block_stop',index});
        }
        emit('message_delta',{type:'message_delta',delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:1}});emit('message_stop',{type:'message_stop'});
      }else{
        const chunk=delta=>({id:`message-${count}`,object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:null}]});
        emit('',chunk({role:'assistant'}));
        if(message==='STREAM_TRANSIENT_ERROR'){emit('',{error:{type:'overloaded_error',message:'Synthetic transient stream'}});res.end();return;}
        if(toolCalls.length)for(const [index,t]of toolCalls.entries())emit('',chunk({tool_calls:[{index,id:t.id,type:'function',function:{name:t.name,arguments:JSON.stringify(t.input)}}]}));
        else if(answer)emit('',chunk({content:answer}));
        emit('',{...chunk({}),choices:[{index:0,delta:{},finish_reason:toolCalls.length?'tool_calls':'stop'}],usage:{prompt_tokens:inputTokens,completion_tokens:1,total_tokens:inputTokens+1}});res.write('data: [DONE]\n\n');
      }
      res.end();
    }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic fixture failed'}}));server.fixtureError=error;}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,calls,setRole(value){role=value;},assertHealthy(){if(server.fixtureError)throw server.fixtureError;},close:()=>new Promise(resolve=>server.close(resolve))};
}
