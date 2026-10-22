import {describe,expect,it,vi} from 'vitest';
import {BudgetNativeCredentialClient,type NativeKeyExpectation,type NativeTeamExpectation} from '../lib/budget-native-client.js';

const MASTER='sk-master-fixture-0123456789';
const KEY='sk-caller-selected-fixture-0123456789';
const HASH='a'.repeat(64);
const TEAM='team-fixture-123';
const USER='member-fixture-123';
const POLICY={maxBudget:5,budgetDuration:'1d',models:['lares-brain'] as const};
const keyExpected:NativeKeyExpectation={keyAlias:'probe-key-fixture',teamId:TEAM,userId:USER,...POLICY};
const teamExpected:NativeTeamExpectation={teamId:TEAM,teamMaxBudget:100,teamBudgetDuration:'1d',teamModels:['lares-brain'],memberUserId:USER,
  memberMaxBudget:25,memberBudgetDuration:'1d',memberModels:['lares-brain'],memberRole:'user'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const keyRow={key_alias:keyExpected.keyAlias,key_type:'llm_api',team_id:TEAM,user_id:USER,max_budget:5,budget_duration:'1d',
  models:['lares-brain'],blocked:true,allowed_routes:['llm_api_routes'],access_group_ids:[],object_permission_id:null,object_permission:null,
  allowed_cache_controls:[],soft_budget_cooldown:false,max_parallel_requests:null,tpm_limit:null,rpm_limit:null,
  metadata:{},config:{},permissions:{},aliases:{},router_settings:{},budget_fallbacks:{},
  model_max_budget:{},budget_limits:[],budget_id:null,project_id:null,organization_id:null,agent_id:null};
const teamBody={team_info:{team_id:TEAM,max_budget:100,budget_duration:'1d',models:['lares-brain'],blocked:false,metadata:{},members_with_roles:[{user_id:USER,role:'user'}]},
  team_memberships:[{team_id:TEAM,user_id:USER,litellm_budget_table:{max_budget:25,budget_duration:'1d',allowed_models:['lares-brain']}}]};
function setup(responder:(url:string,init?:RequestInit)=>Promise<Response>){
  const request=vi.fn(responder);
  return {request,client:new BudgetNativeCredentialClient('https://gateway.example:4000/',MASTER,request as unknown as typeof fetch,1000)};
}
const info=(hash:string,row:unknown[])=>({key:[hash],info:row});

describe('fixed native gateway client',()=>{
  it('rejects non-origin configuration without echoing it',()=>{
    for(const url of ['https://user:secret@gateway.example/','https://gateway.example/base','https://gateway.example/?key=secret','ftp://gateway.example/'])
      expect(()=>new BudgetNativeCredentialClient(url,MASTER)).toThrow('origin is invalid');
    expect(()=>new BudgetNativeCredentialClient('https://gateway.example/','not-a-native-key')).toThrow('configuration is invalid');
  });

  it('sends only fixed POST routes, with one bounded request and no redirects',async()=>{
    const {request,client}=setup(async()=>json({ok:true}));
    await client.createTeam({teamId:TEAM,maxBudget:100,budgetDuration:'1d',models:['lares-brain']});
    await client.createUser({userId:USER,maxBudget:25,userRole:'internal_user'});
    await client.addMember({teamId:TEAM,userId:USER,maxBudget:25,budgetDuration:'1d',models:['lares-brain'],role:'user'});
    const urls=request.mock.calls.map(call=>String(call[0]));
    expect(urls).toEqual(['https://gateway.example:4000/team/new','https://gateway.example:4000/user/new','https://gateway.example:4000/team/member_add']);
    for(const [,init] of request.mock.calls){expect(init?.method).toBe('POST');expect(init?.redirect).toBe('manual');expect(init?.signal).toBeTruthy();}
    expect(JSON.parse(request.mock.calls[1]![1]!.body as string)).toEqual({user_id:USER,max_budget:25,auto_create_key:false,user_role:'internal_user'});
  });

  it('acknowledges only the expected user id and cap, without claiming user policy verification',async()=>{
    const {client}=setup(async()=>json({user_id:USER,max_budget:25}));
    await expect(client.createUser({userId:USER,maxBudget:25,userRole:'internal_user'})).resolves.toEqual({kind:'acknowledged'});
    const wrong=setup(async()=>json({user_id:USER,max_budget:24}));
    await expect(wrong.client.createUser({userId:USER,maxBudget:25,userRole:'internal_user'})).resolves.toEqual({kind:'uncertain'});
  });

  it('does not send invalid ids, budgets, durations, models, roles or oversized requests',async()=>{
    const {request,client}=setup(async()=>json({ok:true}));
    expect(await client.createTeam({teamId:'bad/id',maxBudget:100,budgetDuration:'1d',models:['lares-brain']})).toEqual({kind:'malformed'});
    expect(await client.createTeam({teamId:TEAM,maxBudget:Infinity,budgetDuration:'1d',models:['lares-brain']})).toEqual({kind:'malformed'});
    expect(await client.addMember({teamId:TEAM,userId:USER,maxBudget:25,budgetDuration:'',models:['lares-brain'],role:'user'})).toEqual({kind:'malformed'});
    expect(await client.addMember({teamId:TEAM,userId:USER,maxBudget:25,budgetDuration:'1d',models:['lares-brain','lares-brain'],role:'user'})).toEqual({kind:'malformed'});
    expect(await client.createUser({userId:USER,maxBudget:25,userRole:'proxy_admin' as 'internal_user'})).toEqual({kind:'malformed'});
    const longModels=Array.from({length:16},(_,i)=>'x'.repeat(150)+i);
    expect(await client.createTeam({teamId:TEAM,maxBudget:1,budgetDuration:'1d',models:longModels})).toEqual({kind:'malformed'});
    expect(request).not.toHaveBeenCalled();
  });

  it('requires a bounded exact team and membership policy readback',async()=>{
    const {request,client}=setup(async()=>json(teamBody));
    await expect(client.readTeam(teamExpected)).resolves.toEqual({kind:'match',value:true});
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]![0])).toBe(`https://gateway.example:4000/team/info?team_id=${TEAM}`);
    expect(request.mock.calls[0]![1]!.method).toBe('GET');
    const mismatch=setup(async()=>json({...teamBody,team_info:{...teamBody.team_info,max_budget:99}}));
    await expect(mismatch.client.readTeam(teamExpected)).resolves.toEqual({kind:'mismatch'});
    const durationMismatch=setup(async()=>json({...teamBody,team_info:{...teamBody.team_info,budget_duration:'30d'}}));
    await expect(durationMismatch.client.readTeam(teamExpected)).resolves.toEqual({kind:'mismatch'});
  });

  it('distinguishes exact key match, strict absence, mismatch and malformed readbacks',async()=>{
    const match=setup(async()=>json(info(HASH,[keyRow])));
    await expect(match.client.lookupKey(HASH,keyExpected)).resolves.toEqual({kind:'match',value:true});
    const absent=setup(async()=>json(info(HASH,[])));
    await expect(absent.client.lookupKey(HASH,keyExpected)).resolves.toEqual({kind:'absent'});
    const policyMismatch=setup(async()=>json(info(HASH,[{...keyRow,blocked:false}])));
    await expect(policyMismatch.client.lookupKey(HASH,keyExpected)).resolves.toEqual({kind:'mismatch'});
    for(const changed of [
      {allowed_routes:['management_routes']},
      {allowed_routes:[]},
      {access_group_ids:['fixture-group']},
      {object_permission_id:'fixture-permission'},
      {object_permission:{agents:['fixture-agent']}},
      {policies:['fixture-policy']},
      {allowed_cache_controls:['fixture-control']},
      {max_parallel_requests:1},
    ]){
      const widened=setup(async()=>json(info(HASH,[{...keyRow,...changed}])));
      await expect(widened.client.lookupKey(HASH,keyExpected)).resolves.toEqual({kind:'mismatch'});
    }
    const malformed=setup(async()=>new Response('{"key":["'+HASH+'"],"info":[],"info":[]}'));
    await expect(malformed.client.lookupKey(HASH,keyExpected)).resolves.toEqual({kind:'malformed'});
    const wrongHash=setup(async()=>json(info('b'.repeat(64),[])));
    await expect(wrongHash.client.lookupKey(HASH,keyExpected)).resolves.toEqual({kind:'malformed'});
  });

  it('never infers absence from refusal, server errors, redirects or malformed content',async()=>{
    for(const [status,kind] of [[401,'refused'],[403,'refused'],[404,'unavailable'],[500,'unavailable'],[302,'unavailable']] as const){
      const {client}=setup(async()=>new Response('secret body',{status}));
      await expect(client.lookupKey(HASH,keyExpected)).resolves.toEqual({kind});
    }
    const bad=setup(async()=>new Response('not-json'));
    await expect(bad.client.lookupKey(HASH,keyExpected)).resolves.toEqual({kind:'malformed'});
    const unavailable=setup(async()=>{throw new Error(KEY);});
    const result=await unavailable.client.lookupKey(HASH,keyExpected);
    expect(result).toEqual({kind:'unavailable'});expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('requires a complete exact owned-key inventory, including native pagination metadata',async()=>{
    const inventory={keys:[HASH],total_count:1,current_page:1,total_pages:1};
    const {client}=setup(async()=>json(inventory));
    await expect(client.listOwnedKeys(USER)).resolves.toEqual({kind:'match',value:[HASH]});
    for(const body of [
      {...inventory,total_count:11,total_pages:2},
      {...inventory,total_count:2},
      {...inventory,keys:[{token:HASH}]},
      {...inventory,current_page:2},
      {keys:[]},
    ]){
      const bad=setup(async()=>json(body));
      await expect(bad.client.listOwnedKeys(USER)).resolves.toEqual({kind:'malformed'});
    }
    const emptyList=setup(async()=>json({keys:[],total_count:0,current_page:1,total_pages:0}));
    await expect(emptyList.client.listOwnedKeys(USER)).resolves.toEqual({kind:'match',value:[]});
  });

  it('creates only blocked caller keys and suppresses plaintext from results',async()=>{
    const {request,client}=setup(async()=>json({key:KEY}));
    const result=await client.createBlockedKey({...POLICY,key:KEY,keyAlias:keyExpected.keyAlias,teamId:TEAM,userId:USER});
    expect(result).toEqual({kind:'acknowledged'});expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({key:KEY,key_alias:keyExpected.keyAlias,key_type:'llm_api',team_id:TEAM,
      user_id:USER,max_budget:5,budget_duration:'1d',models:['lares-brain'],blocked:true});
    const mismatched=setup(async()=>json({key:'sk-unexpected-native-key-0123456789'}));
    await expect(mismatched.client.createBlockedKey({...POLICY,key:KEY,keyAlias:keyExpected.keyAlias,teamId:TEAM,userId:USER})).resolves.toEqual({kind:'uncertain'});
  });

  it('reports write refusal separately and ambiguous outcomes as uncertain without retry',async()=>{
    for(const [status,kind] of [[403,'refused'],[500,'uncertain'],[302,'uncertain']] as const){
      const {request,client}=setup(async()=>new Response('body contains '+KEY,{status}));
      const result=await client.deleteKey(HASH);
      expect(result).toEqual({kind});expect(request).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toContain(KEY);
    }
    const lost=setup(async()=>{throw new Error(KEY);});
    await expect(lost.client.deleteKey(HASH)).resolves.toEqual({kind:'uncertain'});expect(lost.request).toHaveBeenCalledTimes(1);
    const malformed=setup(async()=>new Response('{bad'));
    // For this route the confirmed contract is its successful HTTP status; the caller must
    // still perform strict hash lookup before treating deletion as complete.
    await expect(malformed.client.deleteKey(HASH)).resolves.toEqual({kind:'acknowledged'});
  });

  it('bounds streamed response bodies before parsing or retaining them',async()=>{
    const response=new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(65_537));controller.close();}}));
    const {client}=setup(async()=>response);
    await expect(client.lookupKey(HASH,keyExpected)).resolves.toEqual({kind:'malformed'});
    const deep='{"key":["'+HASH+'"],"info":[],"extra":'+ '['.repeat(34)+'0'+']'.repeat(34)+'}';
    const nested=setup(async()=>new Response(deep));
    await expect(nested.client.lookupKey(HASH,keyExpected)).resolves.toEqual({kind:'malformed'});
  });

  it('returns unavailable when the total deadline aborts a stalled response body',async()=>{
    const request=vi.fn(async(_url:string,init?:RequestInit)=>new Response(new ReadableStream<Uint8Array>({start(controller){
      const signal=init?.signal;
      if(!signal)throw new Error('missing deadline signal');
      signal.addEventListener('abort',()=>controller.error(new Error('aborted')), {once:true});
      if(signal.aborted)controller.error(new Error('aborted'));
    }})));
    const client=new BudgetNativeCredentialClient('https://gateway.example:4000/',MASTER,request as unknown as typeof fetch,100);
    const started=Date.now();
    await expect(client.lookupKey(HASH,keyExpected)).resolves.toEqual({kind:'unavailable'});
    expect(Date.now()-started).toBeLessThan(1_000);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
