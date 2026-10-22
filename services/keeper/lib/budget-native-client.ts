const MAX_REQUEST_BYTES=1024;
const MAX_RESPONSE_BYTES=65_536;
const MAX_LIST_KEYS=10;
const MAX_MODELS=16;
const TIMEOUT_MS=5_000;
const ID=/^[A-Za-z0-9-]{1,80}$/;
const MODEL=/^[A-Za-z0-9_.:-]{1,160}$/;
const KEY=/^sk-[A-Za-z0-9_-]{16,256}$/;
const HASH=/^[a-f0-9]{64}$/;
const DURATION=/^[1-9][0-9]{0,3}(?:s|m|h|d|w|M|y)$/;

export type NativeRead<T>={kind:'match';value:T}|{kind:'mismatch'}|{kind:'absent'}|{kind:'refused'}|{kind:'malformed'}|{kind:'unavailable'};
export type NativeWrite={kind:'acknowledged'}|{kind:'refused'}|{kind:'malformed'}|{kind:'uncertain'};

export interface NativeBudgetPolicy {
  maxBudget:number;
  budgetDuration:string;
  models:readonly string[];
}
export interface NativeTeamCreate extends NativeBudgetPolicy {teamId:string}
export interface NativeUserCreate {userId:string;maxBudget:number;userRole:'internal_user'}
export interface NativeMemberAdd extends NativeBudgetPolicy {teamId:string;userId:string;role:'user'}
export interface NativeBlockedKeyCreate extends NativeBudgetPolicy {
  key:string;
  keyAlias:string;
  teamId:string;
  userId:string;
}
export interface NativeTeamExpectation {
  teamId:string;
  teamMaxBudget:number;
  teamBudgetDuration:string;
  teamModels:readonly string[];
  memberUserId:string;
  memberMaxBudget:number;
  memberBudgetDuration:string;
  memberModels:readonly string[];
  memberRole:'user';
}
export interface NativeKeyExpectation {
  keyAlias:string;
  teamId:string;
  userId:string;
  maxBudget:number;
  budgetDuration:string;
  models:readonly string[];
}

type RecordValue=Record<string,unknown>;
type ResponseShape='ack'|'user'|'key';

class BodyUnavailable extends Error {}
class BodyTooLarge extends Error {}

const isObject=(value:unknown):value is RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const empty=(value:unknown)=>value===undefined||value===null||(Array.isArray(value)&&value.length===0)||(isObject(value)&&Object.keys(value).length===0);
const validBudget=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=1_000_000_000;
const validDuration=(value:unknown):value is string=>typeof value==='string'&&DURATION.test(value);
const validModels=(value:unknown):value is readonly string[]=>Array.isArray(value)&&value.length>0&&value.length<=MAX_MODELS&&
  value.every(model=>typeof model==='string'&&MODEL.test(model))&&new Set(value).size===value.length;
const validId=(value:unknown):value is string=>typeof value==='string'&&ID.test(value);
const validHash=(value:unknown):value is string=>typeof value==='string'&&HASH.test(value);
const validKey=(value:unknown):value is string=>typeof value==='string'&&KEY.test(value);
const sameModels=(actual:unknown,expected:readonly string[])=>Array.isArray(actual)&&actual.length===expected.length&&
  actual.every((value,index)=>value===expected[index]);

/** Scan JSON structure before JSON.parse so escaped duplicate object keys cannot be accepted. */
function rejectDuplicateKeys(text:string):void {
  let index=0;
  const whitespace=()=>{while(index<text.length&&/[\u0009\u000a\u000d\u0020]/.test(text[index]!))index++;};
  const string=():string=>{
    const start=index;
    if(text[index]!=='"')throw new Error();
    index++;
    while(index<text.length){
      const char=text[index]!;
      if(char==='"'){index++;return JSON.parse(text.slice(start,index)) as string;}
      if(char==='\\')index+=2;else index++;
    }
    throw new Error();
  };
  const value=(depth:number):void=>{
    if(depth>32)throw new Error();
    whitespace();
    const char=text[index];
    if(char==='{'){
      index++;whitespace();const keys=new Set<string>();
      if(text[index]==='}'){index++;return;}
      while(true){
        whitespace();const key=string();if(keys.has(key))throw new Error();keys.add(key);
        whitespace();if(text[index++]!==':')throw new Error();value(depth+1);whitespace();
        const separator=text[index++];if(separator==='}')return;if(separator!==',')throw new Error();
      }
    }
    if(char==='['){
      index++;whitespace();if(text[index]===']'){index++;return;}
      while(true){value(depth+1);whitespace();const separator=text[index++];if(separator===']')return;if(separator!==',')throw new Error();}
    }
    if(char==='"'){string();return;}
    const start=index;
    while(index<text.length&&!/[\u0009\u000a\u000d\u0020,\]}]/.test(text[index]!))index++;
    if(index===start)throw new Error();
  };
  value(0);whitespace();if(index!==text.length)throw new Error();
}

async function boundedBytes(response:Response,retain:boolean):Promise<Uint8Array>{
  if(!response.body)return new Uint8Array();
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){
      let part:ReadableStreamReadResult<Uint8Array>;
      try{part=await reader.read();}catch{throw new BodyUnavailable();}
      if(part.done)break;
      size+=part.value.byteLength;if(size>MAX_RESPONSE_BYTES){void reader.cancel().catch(()=>{});throw new BodyTooLarge();}
      if(retain)chunks.push(part.value);
    }
  }finally{reader.releaseLock();}
  if(!retain)return new Uint8Array();
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return bytes;
}

async function jsonBody(response:Response):Promise<unknown>{
  const bytes=await boundedBytes(response,true);
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  rejectDuplicateKeys(text);
  const parsed:unknown=JSON.parse(text);
  const finite=(value:unknown,depth=0):boolean=>{
    if(depth>32)return false;
    if(typeof value==='number')return Number.isFinite(value);
    if(Array.isArray(value))return value.every(item=>finite(item,depth+1));
    if(isObject(value))return Object.values(value).every(item=>finite(item,depth+1));
    return true;
  };
  if(!finite(parsed))throw new Error();
  return parsed;
}

function validateBudgetPolicy(value:NativeBudgetPolicy):boolean {
  return validBudget(value.maxBudget)&&validDuration(value.budgetDuration)&&validModels(value.models);
}

function exactKeyRow(row:RecordValue,expected:NativeKeyExpectation,blocked:boolean):boolean {
  return row.key_alias===expected.keyAlias&&row.key_type==='llm_api'&&row.team_id===expected.teamId&&row.user_id===expected.userId&&
    row.max_budget===expected.maxBudget&&row.budget_duration===expected.budgetDuration&&sameModels(row.models,expected.models)&&row.blocked===blocked&&
    Array.isArray(row.allowed_routes)&&row.allowed_routes.length===1&&row.allowed_routes[0]==='llm_api_routes'&&
    Array.isArray(row.access_group_ids)&&row.access_group_ids.length===0&&row.object_permission_id===null&&empty(row.object_permission)&&
    empty(row.policies)&&empty(row.allowed_cache_controls)&&row.max_parallel_requests==null&&row.tpm_limit==null&&row.rpm_limit==null&&
    row.soft_budget_cooldown===false&&
    empty(row.metadata)&&empty(row.config)&&empty(row.permissions)&&empty(row.aliases)&&empty(row.router_settings)&&empty(row.budget_fallbacks)&&
    empty(row.model_max_budget)&&empty(row.budget_limits)&&row.budget_id==null&&row.project_id==null&&row.organization_id==null&&row.agent_id==null&&
    !('token' in row);
}

function validKeyRow(row:RecordValue):boolean {
  return typeof row.key_alias==='string'&&typeof row.key_type==='string'&&typeof row.team_id==='string'&&typeof row.user_id==='string'&&
    validBudget(row.max_budget)&&validDuration(row.budget_duration)&&validModels(row.models)&&typeof row.blocked==='boolean'&&
    Array.isArray(row.allowed_routes)&&row.allowed_routes.every(value=>typeof value==='string')&&
    Array.isArray(row.access_group_ids)&&row.access_group_ids.every(value=>typeof value==='string')&&
    (row.object_permission_id===null||typeof row.object_permission_id==='string')&&
    (row.object_permission===undefined||row.object_permission===null||isObject(row.object_permission))&&
    Array.isArray(row.allowed_cache_controls)&&row.allowed_cache_controls.every(value=>typeof value==='string')&&
    typeof row.soft_budget_cooldown==='boolean'&&
    (row.max_parallel_requests===null||typeof row.max_parallel_requests==='number'&&Number.isFinite(row.max_parallel_requests))&&
    (row.tpm_limit===null||typeof row.tpm_limit==='number'&&Number.isFinite(row.tpm_limit))&&
    (row.rpm_limit===null||typeof row.rpm_limit==='number'&&Number.isFinite(row.rpm_limit))&&
    !('token' in row);
}

/** Fixed-route, master-authenticated LiteLLM client. It never creates keys except atomically blocked ones. */
export class BudgetNativeCredentialClient {
  private readonly origin:string;

  constructor(gatewayUrl:string,private readonly masterKey:string,private readonly request:typeof fetch=globalThis.fetch,
    private readonly timeoutMs=TIMEOUT_MS){
    let url:URL;
    try{url=new URL(gatewayUrl);}catch{throw new Error('keeper: native gateway origin is invalid');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin==='null')
      throw new Error('keeper: native gateway origin is invalid');
    if(!validKey(masterKey)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>TIMEOUT_MS)
      throw new Error('keeper: native gateway client configuration is invalid');
    this.origin=url.origin;
  }

  async createTeam(input:NativeTeamCreate):Promise<NativeWrite>{
    if(!validId(input.teamId)||!validateBudgetPolicy(input))return {kind:'malformed'};
    return this.write('/team/new',{team_id:input.teamId,max_budget:input.maxBudget,models:input.models,budget_duration:input.budgetDuration},'ack');
  }

  async createUser(input:NativeUserCreate):Promise<NativeWrite>{
    if(!validId(input.userId)||!validBudget(input.maxBudget)||input.userRole!=='internal_user')return {kind:'malformed'};
    return this.write('/user/new',{user_id:input.userId,max_budget:input.maxBudget,auto_create_key:false,user_role:input.userRole},'user',input.userId,input.maxBudget);
  }

  async addMember(input:NativeMemberAdd):Promise<NativeWrite>{
    if(!validId(input.teamId)||!validId(input.userId)||!validateBudgetPolicy(input)||input.role!=='user')return {kind:'malformed'};
    return this.write('/team/member_add',{team_id:input.teamId,max_budget_in_team:input.maxBudget,budget_duration:input.budgetDuration,
      allowed_models:input.models,member:{role:input.role,user_id:input.userId}},'ack');
  }

  async readTeam(expected:NativeTeamExpectation):Promise<NativeRead<true>>{
    if(!validId(expected.teamId)||!validBudget(expected.teamMaxBudget)||!validDuration(expected.teamBudgetDuration)||!validModels(expected.teamModels)||!validId(expected.memberUserId)||
      !validBudget(expected.memberMaxBudget)||!validDuration(expected.memberBudgetDuration)||!validModels(expected.memberModels)||expected.memberRole!=='user')
      return {kind:'malformed'};
    const result=await this.read(`/team/info?team_id=${expected.teamId}`);
    if(result.kind!=='body')return result;
    const body=result.value;const team=body.team_info;const memberships=body.team_memberships;
    if(!isObject(team)||!Array.isArray(memberships)||!Array.isArray(team.members_with_roles))return {kind:'malformed'};
    const memberRows=memberships.filter((row):row is RecordValue=>isObject(row)&&row.team_id===expected.teamId&&row.user_id===expected.memberUserId);
    const roleRows=team.members_with_roles.filter((row):row is RecordValue=>isObject(row)&&row.user_id===expected.memberUserId);
    if(memberRows.length!==1||roleRows.length!==1)return {kind:'mismatch'};
    const budget=memberRows[0]!.litellm_budget_table;
    if(!isObject(budget))return {kind:'malformed'};
    const exact=team.team_id===expected.teamId&&team.max_budget===expected.teamMaxBudget&&team.budget_duration===expected.teamBudgetDuration&&sameModels(team.models,expected.teamModels)&&
      team.blocked===false&&empty(team.metadata)&&budget.max_budget===expected.memberMaxBudget&&budget.budget_duration===expected.memberBudgetDuration&&
      sameModels(budget.allowed_models,expected.memberModels)&&roleRows[0]!.role===expected.memberRole;
    return exact?{kind:'match',value:true}:{kind:'mismatch'};
  }

  async createBlockedKey(input:NativeBlockedKeyCreate):Promise<NativeWrite>{
    if(!validKey(input.key)||!validId(input.keyAlias)||!validId(input.teamId)||!validId(input.userId)||!validateBudgetPolicy(input))
      return {kind:'malformed'};
    return this.write('/key/generate',{key:input.key,key_alias:input.keyAlias,key_type:'llm_api',team_id:input.teamId,user_id:input.userId,
      max_budget:input.maxBudget,budget_duration:input.budgetDuration,models:input.models,blocked:true},'key',undefined,undefined,input.key);
  }

  async lookupKey(hash:string,expected:NativeKeyExpectation):Promise<NativeRead<true>>{
    if(!validHash(hash)||!validId(expected.keyAlias)||!validId(expected.teamId)||!validId(expected.userId)||!validateBudgetPolicy(expected))
      return {kind:'malformed'};
    const result=await this.read('/v2/key/info',{keys:[hash]});
    if(result.kind!=='body')return result;
    const body=result.value;
    if(!Array.isArray(body.key)||body.key.length!==1||body.key[0]!==hash||!Array.isArray(body.info))return {kind:'malformed'};
    if(body.info.length===0)return {kind:'absent'};
    if(body.info.length!==1||!isObject(body.info[0])||!validKeyRow(body.info[0]))return {kind:'malformed'};
    return exactKeyRow(body.info[0],expected,true)?{kind:'match',value:true}:{kind:'mismatch'};
  }

  async listOwnedKeys(userId:string):Promise<NativeRead<readonly string[]>>{
    if(!validId(userId))return {kind:'malformed'};
    const result=await this.read(`/key/list?user_id=${userId}`);
    if(result.kind!=='body')return result;
    const body=result.value;const keys=body.keys;
    if(!Array.isArray(keys)||!keys.every(validHash)||new Set(keys).size!==keys.length||
      !Number.isSafeInteger(body.total_count)||!Number.isSafeInteger(body.current_page)||!Number.isSafeInteger(body.total_pages))return {kind:'malformed'};
    const count=body.total_count as number;const page=body.current_page as number;const pages=body.total_pages as number;
    if(count<0||page!==1||count>MAX_LIST_KEYS||keys.length!==count||pages!==(count===0?0:1))return {kind:'malformed'};
    return {kind:'match',value:keys};
  }

  async deleteKey(hash:string):Promise<NativeWrite>{
    if(!validHash(hash))return {kind:'malformed'};
    return this.write('/key/delete',{keys:[hash]},'ack');
  }

  private async read(path:string,body?:unknown):Promise<{kind:'body';value:RecordValue}|Exclude<NativeRead<never>,{kind:'match'}>>{
    const response=await this.send(path,body);
    if(response.kind!=='response')return {kind:'unavailable'};
    if(response.value.status===401||response.value.status===403){void response.value.body?.cancel().catch(()=>{});return {kind:'refused'};}
    if(response.value.status!==200){void response.value.body?.cancel().catch(()=>{});return {kind:'unavailable'};}
    try{const parsed=await jsonBody(response.value);return isObject(parsed)?{kind:'body',value:parsed}:{kind:'malformed'};}
    catch(error){return error instanceof BodyUnavailable?{kind:'unavailable'}:{kind:'malformed'};}
  }

  private async write(path:string,body:unknown,responseShape:ResponseShape,expectedUserId?:string,expectedUserBudget?:number,expectedKey?:string):Promise<NativeWrite>{
    let raw:Uint8Array;
    try{raw=new TextEncoder().encode(JSON.stringify(body));}catch{return {kind:'malformed'};}
    if(raw.byteLength>MAX_REQUEST_BYTES)return {kind:'malformed'};
    const sent=await this.send(path,body);
    if(sent.kind!=='response')return {kind:'uncertain'};
    const response=sent.value;
    if(response.status===401||response.status===403){void response.body?.cancel().catch(()=>{});return {kind:'refused'};}
    if(response.status<200||response.status>=300){void response.body?.cancel().catch(()=>{});return {kind:'uncertain'};}
    try{
      if(responseShape==='ack'){await boundedBytes(response,false);return {kind:'acknowledged'};}
      const parsed=await jsonBody(response);
      if(!isObject(parsed))return {kind:'uncertain'};
      if(responseShape==='user'&&(parsed.user_id!==expectedUserId||parsed.max_budget!==expectedUserBudget))return {kind:'uncertain'};
      if(responseShape==='key'&&parsed.key!==expectedKey)return {kind:'uncertain'};
      return {kind:'acknowledged'};
    }catch{return {kind:'uncertain'};}
  }

  private async send(path:string,body?:unknown):Promise<{kind:'response';value:Response}|{kind:'unavailable'}>{
    const fixedRoute=['/team/new','/user/new','/team/member_add','/v2/key/info','/key/generate','/key/delete'].includes(path);
    const fixedQueryRoute=/^\/team\/info\?team_id=[A-Za-z0-9-]{1,80}$/.test(path)||/^\/key\/list\?user_id=[A-Za-z0-9-]{1,80}$/.test(path);
    if(!fixedRoute&&!fixedQueryRoute)return {kind:'unavailable'};
    let raw:Uint8Array|undefined;
    if(body!==undefined){try{raw=new TextEncoder().encode(JSON.stringify(body));}catch{return {kind:'unavailable'};}if(raw.byteLength>MAX_REQUEST_BYTES)return {kind:'unavailable'};}
    const method=body===undefined?'GET':'POST';
    try{
      const response=await this.request(`${this.origin}${path}`,{method,redirect:'manual',signal:AbortSignal.timeout(this.timeoutMs),
        headers:{authorization:`Bearer ${this.masterKey}`,...(body===undefined?{}:{'content-type':'application/json'})},
        ...(raw===undefined?{}:{body:new TextDecoder().decode(raw)})});
      return {kind:'response',value:response};
    }catch{return {kind:'unavailable'};}
  }
}
