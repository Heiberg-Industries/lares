/** Server-only current resource authority. Not a model tool. Agent and Vault area adapters share the existing grant registry;
 * other kinds and place principals fail closed until trusted adapters are implemented.
 * Ownership never grants access to the agent's private sources, accounts or credentials. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { currentMember,currentSession } from './member-store.js';
import type { Member } from './authority-contract.js';
import { currentVaultArea, vaultAreaAllows } from './vault-area-store.js';
import { definitionSchema, OUTSIDE_TOOL_NAME_RE, type AgentDefinition } from './definition.js';
import { autonomyOf } from './manifest.js';
import { checkOutsideUrl } from './outside-tools.js';

export type GrantDatabase = Pick<PoolClient,'query'>;
type Db = GrantDatabase;
type Permission = 'use' | 'edit';
export interface VisibleResource { resource: {kind:'agent'|'vault-area';id:string}; accessRevision:number; permissions:Permission[] }
export interface HumanOutsideDiscoveryTarget { agentName:string; connectionName:string }
export interface AgentAccessView { agentName:string; ownerMemberId:string; accessRevision:number; definitionHash:string; grants:{ principal:{kind:'member'|'organisation';id:string};permission:Permission;expiresAt:string|null }[] }
export type OutsideUseCapture = {
  version: 1;
  actor: { memberId: string; organisationId: string; role: Member['role'] };
  agent: { name: string; ownerMemberId: string; accessRevision: number; definitionHash: string };
  ownerPolicy: { kind: 'unrestricted' } | { kind: 'ceiling'; requiredCapabilities: readonly string[] };
  outside: {
    scope: Exclude<AgentDefinition['grants'][number]['scope'], 'none'>;
    autonomy: 'gated' | 'autonomous';
    connection: { name: string; url: string; auth: 'bearer'; allow: readonly string[]; read: readonly string[]; trusted: boolean; runsAt?: string };
  };
  grant: { kind: 'owner'; validUntil: null } | { kind: 'grant'; id: string; principal: { kind: 'member' | 'organisation'; id: string }; permission: 'use'; validUntil: string | null };
};
export class GrantStoreError extends Error {
  constructor(public readonly code:'denied'|'invalid'|'stale') { super(`Agent access refused: ${code}`); this.name='GrantStoreError'; }
}
const id=z.string().min(1).max(200).refine(v=>v.trim()===v);
const revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const selection=z.strictObject({principal:z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('member'),id}),z.strictObject({kind:z.literal('organisation'),id}),
]),permission:z.enum(['use','edit']),expiresAt:z.iso.datetime().nullable()});
export const agentAccessUpdateSchema=z.strictObject({agentName:id,expectedRevision:revision,grants:z.array(selection).max(200)})
  .refine(v=>v.grants.every(g=>g.principal.kind==='member'||g.permission==='use'),'Organisation editing is unavailable')
  .refine(v=>new Set(v.grants.map(g=>`${g.principal.kind}:${g.principal.id}:${g.permission}`)).size===v.grants.length,'Duplicate grants');
type AccessRow={agent_name:string;owner_member_id:string;organisation_id:string;revision:string;hash:string;definition:unknown;status:string;
  definition_bytes?:number;outside_type?:string|null;declared?:number};
type GrantRow={principal_member_id:string|null;principal_organisation_id:string|null;permission:Permission;expires_at:Date|null};
type OutsideOwnerPolicy = OutsideUseCapture['ownerPolicy'];
type OutsideGrant = Extract<OutsideUseCapture['grant'],{kind:'grant'}>;
type OutsideEvaluation = { ownerPolicy?:OutsideOwnerPolicy; grant?:OutsideUseCapture['grant']; definition?:AgentDefinition };
const accessColumns='a.agent_name,a.owner_member_id,a.organisation_id,a.revision,d.hash,d.definition,d.status';
const outsideHash=z.string().regex(/^[a-f0-9]{64}$/);
const positiveIntegerText=z.string().regex(/^[1-9]\d*$/);
const custodyConnectionName=z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
function capabilities(definition:unknown): string[]|undefined {
  const parsed=z.object({grants:z.array(z.object({capability:z.string(),scope:z.string()}))}).safeParse(definition);
  return parsed.success ? parsed.data.grants.filter(g=>g.scope!=='none').map(g=>g.capability) : undefined;
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value!==null&&typeof value==='object'){
    const record=value as Record<string,unknown>;
    return `{${Object.keys(record).sort().filter(key=>record[key]!==undefined).map(key=>`${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value)??'null';
}
function outsideDefinition(value:unknown,agentName:string,connectionName:string):{definition:AgentDefinition;connection:NonNullable<AgentDefinition['outsideTools']>[number];scope:Exclude<AgentDefinition['grants'][number]['scope'],'none'>;autonomy:'gated'|'autonomous'}|undefined {
  const parsed=definitionSchema.safeParse(value);
  if(!parsed.success||parsed.data.name!==agentName)return undefined;
  const outside=parsed.data.grants.filter(grant=>grant.capability==='outside');
  if(outside.length!==1||outside[0]!.scope==='none')return undefined;
  if(outside[0]!.scope!=='read'&&outside[0]!.scope!=='write-with-confirm')return undefined;
  const autonomy=autonomyOf(parsed.data,'outside');
  if(autonomy==='never')return undefined;
  const selected=(parsed.data.outsideTools??[]).filter(entry=>entry.name===connectionName);
  if(selected.length!==1||!custodyConnectionName.safeParse(connectionName).success)return undefined;
  const connection=selected[0]!;
  if(connection.token!==true||!checkOutsideUrl(connection.url).ok)return undefined;
  const names=[...connection.tools.allow,...connection.tools.read];
  if(names.length>256||names.some(name=>name.trim().length===0||name.length>200))return undefined;
  const allow=new Set(connection.tools.allow);
  if(connection.tools.read.some(name=>!allow.has(name)))return undefined;
  if(outside[0]!.scope==='read'){
    const reads=new Set(connection.tools.read);
    if(connection.tools.allow.some(name=>!reads.has(name)))return undefined;
  }
  return {definition:parsed.data,connection,scope:outside[0]!.scope as Exclude<AgentDefinition['grants'][number]['scope'],'none'>,autonomy};
}

export class PgGrantStore {
  /** Without a pool, every operation requires a caller-owned transaction client. */
  constructor(private readonly pool?:Pool) {}
  private async transaction<T>(client:Db|undefined,fn:(db:Db)=>Promise<T>):Promise<T> {
    if(client) return fn(client); // caller owns the transaction; never acquire a second connection
    if(!this.pool)throw new Error('A grant transaction client is required');
    const db=await this.pool.connect();
    try {await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}
    catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  }
  private async actor(db:Db,memberId:string,write=false):Promise<Member> {
    const before=await currentMember(db,memberId);
    if(!before) throw new GrantStoreError('denied');
    await db.query(`SELECT id FROM orgs WHERE id=$1 FOR ${write?'UPDATE':'SHARE'}`,[before.organisationId]);
    const member=await currentMember(db,memberId,{lock:'share'});
    if(!member||member.organisationId!==before.organisationId) throw new GrantStoreError('denied');
    return member;
  }
  private async policyAllows(db:Db,member:Member,definition:unknown,captureOutsidePolicy?:(policy:OutsideOwnerPolicy)=>void):Promise<boolean> {
    const caps=capabilities(definition); if(!caps)return false;
    const {rows}=await db.query<{allowed_capabilities:string[]|null}>('SELECT allowed_capabilities FROM org_member_policy WHERE user_id=$1 FOR SHARE',[member.id]);
    // Missing policy has no established permissive runtime meaning. Refuse explicitly.
    if(!rows[0])return false;
    const allowed=rows[0].allowed_capabilities;
    if(captureOutsidePolicy&&allowed!==null&&(!Array.isArray(allowed)||allowed.some(capability=>typeof capability!=='string')))return false;
    if(allowed!==null&&!caps.every(c=>allowed.includes(c)))return false;
    captureOutsidePolicy?.(allowed===null?{kind:'unrestricted'}:{kind:'ceiling',requiredCapabilities:[...new Set(caps)].sort()});
    return true;
  }
  private async access(db:Db,name:string,lock=false):Promise<AccessRow|undefined> {
    const {rows}=await db.query<AccessRow>(`SELECT ${accessColumns} FROM agent_access a JOIN agent_definitions d ON d.name=a.agent_name WHERE a.agent_name=$1${lock?' FOR UPDATE OF a,d':''}`,[name]);return rows[0];
  }
  private async evaluate(db:Db,member:Member,row:AccessRow,permission:Permission,captureExpiry?:(validUntil:string|null)=>void,outside?:OutsideEvaluation):Promise<boolean> {
    if(row.organisation_id!==member.organisationId||row.status!=='valid')return false;
    const owner=await currentMember(db,row.owner_member_id,{lock:'share'});
    if(!owner||owner.organisationId!==row.organisation_id||!await this.policyAllows(db,owner,row.definition, outside ? proof=>{outside.ownerPolicy=proof;} : undefined))return false;
    // Recheck snapshots after acquiring the policy lock; a concurrent policy/definition
    // write may have advanced the resource revision while this reader was waiting.
    if(outside){
      const locked=await db.query<{hash:string;definition:unknown;status:string}>("SELECT hash,definition,status FROM agent_definitions WHERE name=$1 FOR SHARE",[row.agent_name]);
      const snapshot=locked.rows[0];
      if(!snapshot||snapshot.hash!==row.hash||snapshot.status!=='valid')return false;
      const initial=definitionSchema.safeParse(row.definition),current=definitionSchema.safeParse(snapshot.definition);
      if(!initial.success||!current.success||canonical(initial.data)!==canonical(current.data))return false;
      outside.definition=current.data;
    }else{
      const definition=await db.query("SELECT 1 FROM agent_definitions WHERE name=$1 AND hash=$2 AND status='valid' FOR SHARE",[row.agent_name,row.hash]);
      if(!definition.rowCount)return false;
    }
    const current=await db.query('SELECT 1 FROM agent_access WHERE agent_name=$1 AND revision=$2 FOR SHARE',[row.agent_name,row.revision]);
    if(!current.rowCount)return false;
    if(row.owner_member_id===member.id){captureExpiry?.(null);if(outside)outside.grant={kind:'owner',validUntil:null};return true;}
    if(outside){
      const {rows}=await db.query<{id:string;principal_member_id:string|null;principal_organisation_id:string|null;permission:Permission;no_expiry:boolean;finite_expiry:boolean|null;valid_until:string|null}>(`SELECT id,principal_member_id,principal_organisation_id,permission,
          expires_at IS NULL AS no_expiry,isfinite(expires_at) AS finite_expiry,
          CASE WHEN expires_at IS NULL THEN NULL ELSE to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS valid_until
        FROM resource_grants WHERE resource_kind='agent' AND resource_id=$1 AND permission=$2 AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND (principal_member_id=$3 OR ($4::boolean AND principal_organisation_id=$5))
        ORDER BY CASE WHEN principal_member_id=$3 THEN 0 ELSE 1 END,id LIMIT 1 FOR SHARE`,
      [row.agent_name,permission,member.id,member.role!=='restricted',member.organisationId]);
      const grant=rows[0];
      if(!grant||grant.permission!=='use'||!z.string().uuid().safeParse(grant.id).success)return false;
      let principal:OutsideGrant['principal'];
      if(grant.principal_member_id===member.id&&grant.principal_organisation_id===null)principal={kind:'member',id:member.id};
      else if(grant.principal_member_id===null&&grant.principal_organisation_id===member.organisationId&&member.role!=='restricted')principal={kind:'organisation',id:member.organisationId};
      else return false;
      if(grant.no_expiry===true){
        if(grant.finite_expiry!==null||grant.valid_until!==null)return false;
      }else if(grant.no_expiry===false&&grant.finite_expiry===true){
        if(typeof grant.valid_until!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(grant.valid_until))return false;
        const stillValid=await db.query<{valid:boolean}>("SELECT $1::timestamptz>clock_timestamp() AS valid",[grant.valid_until]);
        if(stillValid.rows[0]?.valid!==true)return false;
      }else return false;
      outside.grant={kind:'grant',id:grant.id,principal,permission:'use',validUntil:grant.valid_until};
      return true;
    }
    const {rows}=await db.query<{valid_until:string|null}>(`SELECT expires_at::text AS valid_until FROM resource_grants WHERE resource_kind='agent' AND resource_id=$1
      AND permission=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())
      AND (principal_member_id=$3 OR ($4::boolean AND principal_organisation_id=$5)) LIMIT 1 FOR SHARE`,
    [row.agent_name,permission,member.id,member.role!=='restricted',member.organisationId]);
    if(!rows[0])return false;
    captureExpiry?.(rows[0].valid_until);return true;
  }
  async can(memberId:string,resource:{kind:string;id:string},permission:string,options:{expectedRevision?:number;db?:Db}={}):Promise<boolean> {
    if(!['agent','vault-area'].includes(resource.kind)||!['use','edit'].includes(permission))return false;
    return this.transaction(options.db,async db=>{
      let member:Member;try{member=await this.actor(db,memberId);}catch(e){if(e instanceof GrantStoreError)return false;throw e;}
      if(resource.kind==='vault-area'){
        const row=await currentVaultArea(db,member,resource.id);
        return !!row&&row.kind!=='place'&&(options.expectedRevision===undefined||Number(row.revision)===options.expectedRevision)&&await vaultAreaAllows(db,member,row,permission as Permission);
      }
      const row=await this.access(db,resource.id);
      if(!row||(options.expectedRevision!==undefined&&Number(row.revision)!==options.expectedRevision))return false;
      return this.evaluate(db,member,row,permission as Permission);
    });
  }
  /** Trusted admission capture. The caller keeps its transaction open through binding/use. */
  async captureUse(memberId:string,agentName:string,options:{expectedRevision?:number;db?:Db}={}):Promise<number|undefined> {
    return (await this.captureUseWithExpiry(memberId,agentName,options))?.accessRevision;
  }
  /** Exact deadline of the winning grant locked by the common evaluator. Keep this caller
   * transaction open; later transitions must compare the deadline with the database clock.
   * Ownership and non-expiring grants have no time deadline. */
  async captureUseWithExpiry(memberId:string,agentName:string,options:{expectedRevision?:number;db?:Db}={}):Promise<{accessRevision:number;validUntil:string|null}|undefined> {
    return this.transaction(options.db,async db=>{
      let member:Member;try{member=await this.actor(db,memberId);}catch(e){if(e instanceof GrantStoreError)return undefined;throw e;}
      const row=await this.access(db,agentName);let validUntil:string|null=null;
      if(!row||(options.expectedRevision!==undefined&&Number(row.revision)!==options.expectedRevision)||!await this.evaluate(db,member,row,'use',expiry=>{validUntil=expiry;}))return undefined;
      return {accessRevision:Number(row.revision),validUntil};
    });
  }
  /** Trusted internal capture for one saved bearer connection. The supplied transaction must
   * remain open through any later use; this method neither authenticates memberId nor retains a deadline. */
  async captureOutsideUse(memberId:string,agentName:string,options:{db:Db;connectionName:string;expected?:{definitionHash:string;accessRevision:number}}):Promise<OutsideUseCapture|undefined> {
    const input=z.strictObject({memberId:id,agentName:id,connectionName:z.string().regex(OUTSIDE_TOOL_NAME_RE),
      expected:z.strictObject({definitionHash:outsideHash,accessRevision:revision}).optional(),
      db:z.custom<Db>(value=>value!==null&&typeof value==='object'&&typeof (value as Db).query==='function')});
    const valid=input.safeParse({memberId,agentName,...(options as unknown as Record<string,unknown>)});
    if(!valid.success)throw new GrantStoreError('invalid');
    return this.transaction(options.db,async db=>{
      let member:Member;try{member=await this.actor(db,memberId);}catch(error){if(error instanceof GrantStoreError)return undefined;throw error;}
      const row=await this.access(db,agentName);
      if(!row||row.agent_name!==agentName||row.status!=='valid'||!outsideHash.safeParse(row.hash).success)return undefined;
      if(!positiveIntegerText.safeParse(row.revision).success)return undefined;
      const accessRevision=Number(row.revision);
      if(!Number.isSafeInteger(accessRevision)||accessRevision<1||!id.safeParse(row.owner_member_id).success)return undefined;
      const initial=outsideDefinition(row.definition,agentName,options.connectionName);
      if(!initial)return undefined;
      const proof:OutsideEvaluation={};
      if(!await this.evaluate(db,member,row,'use',undefined,proof)||!proof.ownerPolicy||!proof.grant||!proof.definition)return undefined;
      const locked=outsideDefinition(proof.definition,agentName,options.connectionName);
      if(!locked)return undefined;
      if(options.expected&&(options.expected.definitionHash!==row.hash||options.expected.accessRevision!==accessRevision))return undefined;
      const connection=locked.connection;
      const allow=[...new Set(connection.tools.allow)].sort();
      const read=[...new Set(connection.tools.read)].sort();
      return {
        version:1,
        actor:{memberId:member.id,organisationId:member.organisationId,role:member.role},
        agent:{name:agentName,ownerMemberId:row.owner_member_id,accessRevision,definitionHash:row.hash},
        ownerPolicy:proof.ownerPolicy,
        outside:{scope:locked.scope,autonomy:locked.autonomy,connection:{name:connection.name,url:connection.url,auth:'bearer',allow,read,trusted:connection.trusted,...(connection.runsAt===undefined?{}:{runsAt:connection.runsAt})}},
        grant:proof.grant,
      };
    });
  }
  async listVisible(memberId:string,kind:string,options:{db?:Db;maxCandidates?:number;expectedCandidates?:ReadonlyMap<string,{revision:string;hash:string}>}={}):Promise<VisibleResource[]> {
    if(!['agent','vault-area'].includes(kind))return [];
    return this.transaction(options.db,async db=>{
      let member:Member;try{member=await this.actor(db,memberId);}catch(e){if(e instanceof GrantStoreError)return [];throw e;}
      if(kind==='vault-area'){
        const candidates=await db.query<{id:string}>("SELECT id FROM vault_areas WHERE organisation_id=$1 AND status='active' ORDER BY backing_store_id,id",[member.organisationId]);
        const visible:VisibleResource[]=[];
        for(const candidate of candidates.rows){
          const row=await currentVaultArea(db,member,candidate.id);if(!row||row.kind==='place')continue;
          const permissions:Permission[]=[];
          for(const p of ['use','edit'] as const)if(await vaultAreaAllows(db,member,row,p))permissions.push(p);
          if(permissions.length)visible.push({resource:{kind:'vault-area',id:row.id},accessRevision:Number(row.revision),permissions});
        }
        return visible;
      }
      const maxCandidates=options.maxCandidates;
      if(maxCandidates!==undefined&&(!Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>1000))throw new GrantStoreError('invalid');
      const boundedMetadata=options.expectedCandidates?`,octet_length(d.definition::text) AS definition_bytes,
          jsonb_typeof(d.definition->'outsideTools') AS outside_type,
          CASE WHEN jsonb_typeof(d.definition->'outsideTools')='array'
            THEN jsonb_array_length(d.definition->'outsideTools') ELSE 0 END AS declared`:'';
      const {rows}=await db.query<AccessRow>(`SELECT ${accessColumns}${boundedMetadata} FROM agent_access a JOIN agent_definitions d ON d.name=a.agent_name WHERE a.organisation_id=$1 ORDER BY a.agent_name${maxCandidates===undefined?'':' LIMIT $2'}`,
        maxCandidates===undefined?[member.organisationId]:[member.organisationId,maxCandidates+1]);
      // Refuse before evaluating any row. Returning the first N would make a partial selector
      // look complete and would change the shared evaluator's decision set.
      if(maxCandidates!==undefined&&rows.length>maxCandidates)throw new GrantStoreError('denied');
      if(options.expectedCandidates){
        const expectedNames=[...options.expectedCandidates.keys()];
        if(rows.length!==expectedNames.length||rows.some((row,index)=>{
          const expected=options.expectedCandidates!.get(row.agent_name);
          return row.agent_name!==expectedNames[index]||!expected||expected.revision!==row.revision||expected.hash!==row.hash||
            !Number.isSafeInteger(row.definition_bytes)||row.definition_bytes!<1||row.definition_bytes!>262144||
            row.outside_type!==null&&row.outside_type!=='array'||!Number.isSafeInteger(row.declared)||row.declared!<0;
        }))throw new GrantStoreError('stale');
        if(rows.reduce((total,row)=>total+(row.declared??0),0)>128)throw new GrantStoreError('denied');
      }
      const visible:VisibleResource[]=[];
      for(const row of rows){const permissions:Permission[]=[];for(const p of ['use','edit'] as const)if(await this.evaluate(db,member,row,p))permissions.push(p);
        if(permissions.length)visible.push({resource:{kind:'agent',id:row.agent_name},accessRevision:Number(row.revision),permissions});}
      return visible;
    });
  }
  /** Bounded private member selector. Metadata limits are checked before any full definition is
   * fetched or passed to the shared visibility evaluator. The caller supplies its owned client. */
  async listHumanOutsideDiscoveryTargets(memberId:string,options:{db:Db}):Promise<HumanOutsideDiscoveryTarget[]> {
    return this.transaction(options.db,async db=>{
      const member=await this.actor(db,memberId);
      const metadata=await db.query<{agent_name:string;revision:string;hash:string;definition_bytes:number;outside_type:string|null;declared:number}>(`
        SELECT a.agent_name,a.revision::text,d.hash,octet_length(d.definition::text) AS definition_bytes,
          jsonb_typeof(d.definition->'outsideTools') AS outside_type,
          CASE WHEN jsonb_typeof(d.definition->'outsideTools')='array'
            THEN jsonb_array_length(d.definition->'outsideTools') ELSE 0 END AS declared
        FROM agent_access a JOIN agent_definitions d ON d.name=a.agent_name
        WHERE a.organisation_id=$1 ORDER BY a.agent_name LIMIT 51`,[member.organisationId]);
      if(metadata.rows.length>50)throw new GrantStoreError('denied');
      let declaredTotal=0;
      for(const row of metadata.rows){
        if(!Number.isSafeInteger(row.definition_bytes)||row.definition_bytes<1||row.definition_bytes>262144||
            row.outside_type!==null&&row.outside_type!=='array'||!Number.isSafeInteger(row.declared)||row.declared<0)
          throw new GrantStoreError('denied');
        declaredTotal+=row.declared;
        if(declaredTotal>128)throw new GrantStoreError('denied');
      }
      const expectedCandidates=new Map(metadata.rows.map(row=>[row.agent_name,{revision:row.revision,hash:row.hash}]));
      const visible=await this.listVisible(memberId,'agent',{db,maxCandidates:50,expectedCandidates});
      const permitted=new Map(visible.filter(row=>row.permissions.includes('use')).map(row=>[row.resource.id,row.accessRevision]));
      if(permitted.size===0)return [];
      const {rows}=await db.query<{agent_name:string;revision:string;hash:string;definition:unknown;status:string}>(
        `SELECT a.agent_name,a.revision::text,d.hash,d.definition,d.status FROM agent_access a JOIN agent_definitions d ON d.name=a.agent_name
         WHERE a.organisation_id=$1 AND a.agent_name=ANY($2::text[]) ORDER BY a.agent_name`,[member.organisationId,[...permitted.keys()]]);
      const byName=new Map(metadata.rows.map(row=>[row.agent_name,row]));
      const targets:HumanOutsideDiscoveryTarget[]=[];
      for(const row of rows){
        const snapshot=byName.get(row.agent_name);
        if(!snapshot||snapshot.revision!==row.revision||snapshot.hash!==row.hash||permitted.get(row.agent_name)!==Number(row.revision)||row.status!=='valid')
          throw new GrantStoreError('stale');
        const definition=definitionSchema.safeParse(row.definition);
        if(!definition.success||definition.data.name!==row.agent_name)continue;
        for(const connection of definition.data.outsideTools??[]){
          if(!custodyConnectionName.safeParse(connection.name).success||connection.token!==true)continue;
          const capture=await this.captureOutsideUse(memberId,row.agent_name,{db,connectionName:connection.name,
            expected:{definitionHash:row.hash,accessRevision:Number(row.revision)}});
          if(capture)targets.push({agentName:row.agent_name,connectionName:connection.name});
        }
      }
      return targets;
    });
  }
  /** Initial adoption is a trusted designated-owner operation, bound to the current definition.
   * No arbitrary target owner is accepted. No creation, definition mutation or source adoption. */
  async adoptAgent(memberId:string,input:{agentName:string;expectedDefinitionHash:string},options:{designatedOwnerMemberId:string;sessionToken?:string;db?:Db}):Promise<AgentAccessView> {
    if(!id.safeParse(input.agentName).success||!input.expectedDefinitionHash)throw new GrantStoreError('invalid');
    return this.transaction(options.db,async db=>{
      const member=await this.actor(db,memberId,true);
      if(member.role!=='owner'||member.id!==options.designatedOwnerMemberId)throw new GrantStoreError('denied');
      const {rows}=await db.query<{hash:string;definition:unknown;status:string}>('SELECT hash,definition,status FROM agent_definitions WHERE name=$1 FOR UPDATE',[input.agentName]);
      const definition=rows[0];
      if(!definition||definition.status!=='valid'||!await this.policyAllows(db,member,definition.definition))throw new GrantStoreError('denied');
      if(definition.hash!==input.expectedDefinitionHash)throw new GrantStoreError('stale');
      if(await this.access(db,input.agentName))throw new GrantStoreError('stale');
      if(options.sessionToken!==undefined&&!await currentSession(db,options.sessionToken,memberId,{lock:'share'}))throw new GrantStoreError('denied');
      await db.query('INSERT INTO agent_access(agent_name,owner_member_id,organisation_id) VALUES($1,$2,$3)',[input.agentName,member.id,member.organisationId]);
      await db.query('UPDATE console_session_bindings SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE agent=$1',[input.agentName]);
      return (await this.manageView(db,member,input.agentName))!;
    });
  }
  private async manageView(db:Db,member:Member,name:string):Promise<AgentAccessView|undefined> {
    const row=await this.access(db,name);
    if(!row||row.owner_member_id!==member.id||!await this.evaluate(db,member,row,'edit'))return undefined;
    const {rows}=await db.query<GrantRow>(`SELECT principal_member_id,principal_organisation_id,permission,expires_at FROM resource_grants
      WHERE resource_kind='agent' AND resource_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY permission,id`,[name]);
    return {agentName:name,ownerMemberId:row.owner_member_id,accessRevision:Number(row.revision),definitionHash:row.hash,grants:rows.map(g=>({principal:g.principal_member_id?{kind:'member',id:g.principal_member_id}:{kind:'organisation',id:g.principal_organisation_id!},permission:g.permission,expiresAt:g.expires_at?.toISOString()??null}))};
  }
  async agentAccess(memberId:string,name:string,options:{db?:Db}={}):Promise<AgentAccessView|undefined> {
    return this.transaction(options.db,async db=>this.manageView(db,await this.actor(db,memberId),name));
  }
  async updateAgentAccess(memberId:string,input:z.infer<typeof agentAccessUpdateSchema>,options:{sessionToken?:string;db?:Db}={}):Promise<AgentAccessView> {
    const parsed=agentAccessUpdateSchema.safeParse(input);if(!parsed.success)throw new GrantStoreError('invalid');
    return this.transaction(options.db,async db=>{
      const member=await this.actor(db,memberId,true),snapshot=await this.access(db,input.agentName);
      if(!snapshot||!await this.evaluate(db,member,snapshot,'edit'))throw new GrantStoreError('denied');
      const row=await this.access(db,input.agentName,true);
      // Editing an agent is distinct from changing its owner-controlled sharing policy.
      if(!row||row.owner_member_id!==member.id||!await this.evaluate(db,member,row,'edit'))throw new GrantStoreError('denied');
      if(Number(row.revision)!==input.expectedRevision)throw new GrantStoreError('stale');
      for(const grant of input.grants){
        if(grant.principal.kind==='organisation'){if(grant.principal.id!==member.organisationId)throw new GrantStoreError('denied');}
        else {const target=await currentMember(db,grant.principal.id,{lock:'share'});
          if(!target||target.organisationId!==member.organisationId)throw new GrantStoreError('denied');}
        if(grant.expiresAt!==null){const valid=await db.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp()',[grant.expiresAt]);if(!valid.rowCount)throw new GrantStoreError('invalid');}
      }
      if(options.sessionToken!==undefined&&!await currentSession(db,options.sessionToken,memberId,{lock:'share'}))throw new GrantStoreError('denied');
      await db.query('UPDATE resource_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE resource_kind=\'agent\' AND resource_id=$1',[input.agentName]);
      const changed=await db.query<{revision:string}>('UPDATE agent_access SET revision=nextval(\'resource_access_revision_seq\') WHERE agent_name=$1 RETURNING revision',[input.agentName]);
      for(const grant of input.grants)await db.query(`INSERT INTO resource_grants(id,resource_kind,resource_id,principal_member_id,principal_organisation_id,permission,grantor_member_id,issued_access_revision,expires_at)
        VALUES($1,'agent',$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),input.agentName,grant.principal.kind==='member'?grant.principal.id:null,grant.principal.kind==='organisation'?grant.principal.id:null,grant.permission,member.id,changed.rows[0].revision,grant.expiresAt]);
      return (await this.manageView(db,member,input.agentName))!;
    });
  }
}
