/** Server-only current resource authority. Not a model tool. Agent and Vault area adapters share the existing grant registry;
 * other kinds and place principals fail closed until trusted adapters are implemented.
 * Ownership never grants access to the agent's private sources, accounts or credentials. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { currentMember,currentSession } from './member-store.js';
import type { Member } from './authority-contract.js';
import { currentVaultArea, vaultAreaAllows } from './vault-area-store.js';

export type GrantDatabase = Pick<PoolClient,'query'>;
type Db = GrantDatabase;
type Permission = 'use' | 'edit';
export interface VisibleResource { resource: {kind:'agent'|'vault-area';id:string}; accessRevision:number; permissions:Permission[] }
export interface AgentAccessView { agentName:string; ownerMemberId:string; accessRevision:number; definitionHash:string; grants:{ principal:{kind:'member'|'organisation';id:string};permission:Permission;expiresAt:string|null }[] }
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
type AccessRow={agent_name:string;owner_member_id:string;organisation_id:string;revision:string;hash:string;definition:unknown;status:string};
type GrantRow={principal_member_id:string|null;principal_organisation_id:string|null;permission:Permission;expires_at:Date|null};
const accessColumns='a.agent_name,a.owner_member_id,a.organisation_id,a.revision,d.hash,d.definition,d.status';
function capabilities(definition:unknown): string[]|undefined {
  const parsed=z.object({grants:z.array(z.object({capability:z.string(),scope:z.string()}))}).safeParse(definition);
  return parsed.success ? parsed.data.grants.filter(g=>g.scope!=='none').map(g=>g.capability) : undefined;
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
  private async policyAllows(db:Db,member:Member,definition:unknown):Promise<boolean> {
    const caps=capabilities(definition); if(!caps)return false;
    const {rows}=await db.query<{allowed_capabilities:string[]|null}>('SELECT allowed_capabilities FROM org_member_policy WHERE user_id=$1 FOR SHARE',[member.id]);
    // Missing policy has no established permissive runtime meaning. Refuse explicitly.
    return !!rows[0]&&(rows[0].allowed_capabilities===null||caps.every(c=>rows[0].allowed_capabilities!.includes(c)));
  }
  private async access(db:Db,name:string,lock=false):Promise<AccessRow|undefined> {
    const {rows}=await db.query<AccessRow>(`SELECT ${accessColumns} FROM agent_access a JOIN agent_definitions d ON d.name=a.agent_name WHERE a.agent_name=$1${lock?' FOR UPDATE OF a,d':''}`,[name]);return rows[0];
  }
  private async evaluate(db:Db,member:Member,row:AccessRow,permission:Permission):Promise<boolean> {
    if(row.organisation_id!==member.organisationId||row.status!=='valid')return false;
    const owner=await currentMember(db,row.owner_member_id,{lock:'share'});
    if(!owner||owner.organisationId!==row.organisation_id||!await this.policyAllows(db,owner,row.definition))return false;
    // Recheck snapshots after acquiring the policy lock; a concurrent policy/definition
    // write may have advanced the resource revision while this reader was waiting.
    const definition=await db.query("SELECT 1 FROM agent_definitions WHERE name=$1 AND hash=$2 AND status='valid' FOR SHARE",[row.agent_name,row.hash]);
    if(!definition.rowCount)return false;
    const current=await db.query('SELECT 1 FROM agent_access WHERE agent_name=$1 AND revision=$2 FOR SHARE',[row.agent_name,row.revision]);
    if(!current.rowCount)return false;
    if(row.owner_member_id===member.id)return true;
    const {rowCount}=await db.query(`SELECT 1 FROM resource_grants WHERE resource_kind='agent' AND resource_id=$1
      AND permission=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())
      AND (principal_member_id=$3 OR ($4::boolean AND principal_organisation_id=$5)) LIMIT 1 FOR SHARE`,
    [row.agent_name,permission,member.id,member.role!=='restricted',member.organisationId]);
    return !!rowCount;
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
    return this.transaction(options.db,async db=>{
      let member:Member;try{member=await this.actor(db,memberId);}catch(e){if(e instanceof GrantStoreError)return undefined;throw e;}
      const row=await this.access(db,agentName);
      if(!row||(options.expectedRevision!==undefined&&Number(row.revision)!==options.expectedRevision)||!await this.evaluate(db,member,row,'use'))return undefined;
      return Number(row.revision);
    });
  }
  async listVisible(memberId:string,kind:string,options:{db?:Db}={}):Promise<VisibleResource[]> {
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
      const {rows}=await db.query<AccessRow>(`SELECT ${accessColumns} FROM agent_access a JOIN agent_definitions d ON d.name=a.agent_name WHERE a.organisation_id=$1 ORDER BY a.agent_name`,[member.organisationId]);
      const visible:VisibleResource[]=[];
      for(const row of rows){const permissions:Permission[]=[];for(const p of ['use','edit'] as const)if(await this.evaluate(db,member,row,p))permissions.push(p);
        if(permissions.length)visible.push({resource:{kind:'agent',id:row.agent_name},accessRevision:Number(row.revision),permissions});}
      return visible;
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
