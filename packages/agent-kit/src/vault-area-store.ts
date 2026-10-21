/** Server-only Vault metadata authority. No filesystem or model-tool entry points.
 * Callers supplying db own its transaction and must retain it through protected use. */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { currentMember } from './member-store.js';
import { vaultAreaBindingSchema, type Member, type VaultAreaBinding } from './authority-contract.js';
import type { GrantDatabase } from './grant-store.js';

type Db=GrantDatabase;
type Permission='use'|'edit';
const id=z.string().min(1).max(200).refine(v=>v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v));
const revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const owner=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('member'),id}),z.strictObject({kind:z.literal('organisation'),id}),
]);
const relativePath=z.string().min(1).max(1000).refine(p=>p.trim()===p&&!p.startsWith('/')&&!/[\\\x00-\x1f\x7f]/.test(p)&&p.split('/').every(v=>v!==''&&v!=='.'&&v!=='..'));
export const vaultBackingProvisionSchema=z.strictObject({id,kind:z.enum(['git','files'])});
export const vaultAreaProvisionSchema=z.strictObject({id,kind:z.enum(['private','shared','place','taste']),owner,backingStoreId:id,relativePath})
  .refine(a=>a.kind!=='private'||a.owner.kind==='member','Private areas require a member owner');
const grant=z.strictObject({principal:owner,permission:z.enum(['use','edit']),expiresAt:z.iso.datetime().nullable()});
export const vaultAreaAccessUpdateSchema=z.strictObject({areaId:id,expectedRevision:revision,grants:z.array(grant).max(200)})
  .refine(a=>a.grants.every(g=>g.principal.kind==='member'||g.permission==='use'),'Organisation editing is unavailable')
  .refine(a=>new Set(a.grants.map(g=>JSON.stringify([g.principal.kind,g.principal.id,g.permission]))).size===a.grants.length,'Duplicate grants');
export class VaultStoreError extends Error {
  constructor(public readonly code:'denied'|'invalid'|'stale'){super(`Vault access refused: ${code}`);this.name='VaultStoreError';}
}
export interface VaultAreaRow {
  id:string;organisation_id:string;kind:VaultAreaBinding['kind'];owner_member_id:string|null;owner_organisation_id:string|null;
  backing_store_id:string;relative_path:string;revision:string;status:string;
}
export interface VaultAreaView {areaId:string;accessRevision:number;status:'active'|'retired'}
type Authority={designatedOwnerMemberId:string;db?:Db};

/** Internal adapter shared by can, listVisible and binding capture. Actor/org locks are held. */
export async function currentVaultArea(db:Db,member:Member,areaId:string,write=false):Promise<VaultAreaRow|undefined>{
  const snapshot=await db.query<VaultAreaRow>('SELECT * FROM vault_areas WHERE id=$1 AND organisation_id=$2',[areaId,member.organisationId]);
  if(!snapshot.rows[0])return undefined;
  // Area ownership is immutable: lock its current member before backing/area locks.
  if(snapshot.rows[0].owner_member_id!==null){
    const areaOwner=await currentMember(db,snapshot.rows[0].owner_member_id!,{lock:'share'});
    if(!areaOwner||areaOwner.organisationId!==member.organisationId)return undefined;
  }
  // Backing precedes area in every path, including retirement and provisioning.
  const backing=await db.query(`SELECT 1 FROM vault_backing_stores WHERE id=$1 AND organisation_id=$2 AND status='active' FOR ${write?'UPDATE':'SHARE'}`,[snapshot.rows[0].backing_store_id,member.organisationId]);
  if(!backing.rowCount)return undefined;
  const result=await db.query<VaultAreaRow>(`SELECT * FROM vault_areas WHERE id=$1 AND organisation_id=$2 AND status='active' FOR ${write?'UPDATE':'SHARE'}`,[areaId,member.organisationId]);
  const row=result.rows[0];
  if(!row)return undefined;
  if(row.owner_member_id===null&&row.owner_organisation_id!==member.organisationId)return undefined;
  return row;
}
export async function vaultAreaAllows(db:Db,member:Member,row:VaultAreaRow,permission:Permission,captureExpiry?:(validUntil:string|null)=>void):Promise<boolean>{
  if(row.owner_member_id===member.id){captureExpiry?.(null);return true;}
  if(row.kind==='private')return false;
  const matching=await db.query<{id:string}>(`SELECT id FROM resource_grants WHERE resource_kind='vault-area' AND resource_id=$1 AND permission=$2
    AND revoked_at IS NULL AND (principal_member_id=$3 OR ($4::boolean AND principal_organisation_id=$5)) ORDER BY id FOR SHARE`,
  [row.id,permission,member.id,member.role!=='restricted',member.organisationId]);
  if(!matching.rowCount)return false;
  // The lock itself may have waited past expiry. Evaluate database wall time AFTER all
  // matching grant locks are held, never against transaction-start time or a pre-wait test.
  const current=await db.query(`SELECT expires_at::text AS valid_until FROM resource_grants WHERE id=ANY($1::uuid[]) AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY expires_at DESC NULLS FIRST,id LIMIT 1`,[matching.rows.map(g=>g.id)]);
  if(current.rows[0])captureExpiry?.(current.rows[0].valid_until);
  return !!current.rowCount;
}
function view(row:VaultAreaRow):VaultAreaView{return {areaId:row.id,accessRevision:Number(row.revision),status:row.status as 'active'|'retired'};}

export class PgVaultStore {
  constructor(private readonly pool?:Pool){}
  private async transaction<T>(db:Db|undefined,fn:(db:Db)=>Promise<T>):Promise<T>{
    if(db)return fn(db);
    if(!this.pool)throw new Error('A Vault transaction client is required');
    const client=await this.pool.connect();
    try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
    catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  private async actor(db:Db,memberId:string,write=false):Promise<Member>{
    const before=await currentMember(db,memberId);if(!before)throw new VaultStoreError('denied');
    await db.query(`SELECT id FROM orgs WHERE id=$1 FOR ${write?'UPDATE':'SHARE'}`,[before.organisationId]);
    const member=await currentMember(db,memberId,{lock:'share'});
    if(!member||member.organisationId!==before.organisationId)throw new VaultStoreError('denied');
    return member;
  }
  private async provisioner(db:Db,memberId:string,options:Authority):Promise<Member>{
    const member=await this.actor(db,memberId,true);
    if(member.role!=='owner'||member.id!==options.designatedOwnerMemberId)throw new VaultStoreError('denied');
    return member;
  }
  async provisionBacking(memberId:string,input:z.infer<typeof vaultBackingProvisionSchema>,options:Authority):Promise<void>{
    const parsed=vaultBackingProvisionSchema.safeParse(input);if(!parsed.success)throw new VaultStoreError('invalid');
    return this.transaction(options.db,async db=>{
      const actor=await this.provisioner(db,memberId,options);
      const existing=await db.query('SELECT id FROM vault_backing_stores WHERE id=$1 FOR UPDATE',[input.id]);
      if(existing.rowCount)throw new VaultStoreError('stale');
      await db.query('INSERT INTO vault_backing_stores(id,organisation_id,kind) VALUES($1,$2,$3)',[input.id,actor.organisationId,input.kind]);
    });
  }
  async provisionArea(memberId:string,input:z.infer<typeof vaultAreaProvisionSchema>,options:Authority):Promise<VaultAreaView>{
    const parsed=vaultAreaProvisionSchema.safeParse(input);if(!parsed.success)throw new VaultStoreError('invalid');
    return this.transaction(options.db,async db=>{
      const actor=await this.provisioner(db,memberId,options);
      if(input.owner.kind==='member'){
        const member=await currentMember(db,input.owner.id,{lock:'share'});
        if(!member||member.organisationId!==actor.organisationId)throw new VaultStoreError('denied');
      }else if(input.owner.id!==actor.organisationId)throw new VaultStoreError('denied');
      const backing=await db.query("SELECT id FROM vault_backing_stores WHERE id=$1 AND organisation_id=$2 AND status='active' FOR UPDATE",[input.backingStoreId,actor.organisationId]);
      if(!backing.rowCount)throw new VaultStoreError('denied');
      const existing=await db.query('SELECT id FROM vault_areas WHERE id=$1 FOR UPDATE',[input.id]);
      if(existing.rowCount)throw new VaultStoreError('stale');
      const result=await db.query<VaultAreaRow>(`INSERT INTO vault_areas(id,organisation_id,kind,owner_member_id,owner_organisation_id,backing_store_id,relative_path)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[input.id,actor.organisationId,input.kind,input.owner.kind==='member'?input.owner.id:null,input.owner.kind==='organisation'?input.owner.id:null,input.backingStoreId,input.relativePath]);
      return view(result.rows[0]);
    });
  }
  /** Only explicit sharing is configured. Private areas cannot receive any grant. The
   * designated provisioning authority does not inherit member-owned area management. */
  async configureAccess(memberId:string,input:z.infer<typeof vaultAreaAccessUpdateSchema>,options:Authority):Promise<VaultAreaView>{
    const parsed=vaultAreaAccessUpdateSchema.safeParse(input);if(!parsed.success)throw new VaultStoreError('invalid');
    return this.transaction(options.db,async db=>{
      const actor=await this.provisioner(db,memberId,options);
      // Validate and lock every named recipient in stable order before backing/area locks.
      for(const memberId of [...new Set(input.grants.filter(g=>g.principal.kind==='member').map(g=>g.principal.id))].sort()){
        const member=await currentMember(db,memberId,{lock:'share'});
        if(!member||member.organisationId!==actor.organisationId)throw new VaultStoreError('denied');
      }
      for(const g of input.grants){
        if(g.principal.kind==='organisation'&&g.principal.id!==actor.organisationId)throw new VaultStoreError('denied');
        if(g.expiresAt!==null&&!((await db.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp()',[g.expiresAt])).rowCount))throw new VaultStoreError('invalid');
      }
      const row=await currentVaultArea(db,actor,input.areaId,true);
      if(!row||row.kind==='place'||(row.owner_member_id!==null&&row.owner_member_id!==actor.id))throw new VaultStoreError('denied');
      if(row.kind==='private'&&input.grants.length)throw new VaultStoreError('denied');
      if(Number(row.revision)!==input.expectedRevision)throw new VaultStoreError('stale');
      await db.query("UPDATE resource_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE resource_kind='vault-area' AND resource_id=$1 AND revoked_at IS NULL",[row.id]);
      const changed=await db.query<VaultAreaRow>("UPDATE vault_areas SET revision=nextval('vault_access_revision_seq') WHERE id=$1 RETURNING *",[row.id]);
      for(const g of input.grants)await db.query(`INSERT INTO resource_grants(id,resource_kind,resource_id,principal_member_id,principal_organisation_id,permission,grantor_member_id,issued_access_revision,expires_at)
        VALUES($1,'vault-area',$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),row.id,g.principal.kind==='member'?g.principal.id:null,g.principal.kind==='organisation'?g.principal.id:null,g.permission,actor.id,changed.rows[0].revision,g.expiresAt]);
      return view(changed.rows[0]);
    });
  }
  async retireArea(memberId:string,input:{areaId:string;expectedRevision:number},options:Authority):Promise<VaultAreaView>{
    if(!id.safeParse(input.areaId).success||!revision.safeParse(input.expectedRevision).success)throw new VaultStoreError('invalid');
    return this.transaction(options.db,async db=>{
      const actor=await this.provisioner(db,memberId,options),row=await currentVaultArea(db,actor,input.areaId,true);
      if(!row)throw new VaultStoreError('denied');
      if(Number(row.revision)!==input.expectedRevision)throw new VaultStoreError('stale');
      const result=await db.query<VaultAreaRow>("UPDATE vault_areas SET status='retired',revision=nextval('vault_access_revision_seq') WHERE id=$1 RETURNING *",[row.id]);
      await db.query("UPDATE resource_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE resource_kind='vault-area' AND resource_id=$1 AND revoked_at IS NULL",[row.id]);
      return view(result.rows[0]);
    });
  }
  async retireBacking(memberId:string,backingStoreId:string,options:Authority):Promise<void>{
    if(!id.safeParse(backingStoreId).success)throw new VaultStoreError('invalid');
    return this.transaction(options.db,async db=>{
      const actor=await this.provisioner(db,memberId,options);
      const backing=await db.query("SELECT id FROM vault_backing_stores WHERE id=$1 AND organisation_id=$2 AND status='active' FOR UPDATE",[backingStoreId,actor.organisationId]);
      if(!backing.rowCount)throw new VaultStoreError('denied');
      await db.query('SELECT id FROM vault_areas WHERE backing_store_id=$1 ORDER BY id FOR UPDATE',[backingStoreId]);
      await db.query("UPDATE vault_backing_stores SET status='retired' WHERE id=$1",[backingStoreId]);
      await db.query("UPDATE resource_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE resource_kind='vault-area' AND resource_id IN (SELECT id FROM vault_areas WHERE backing_store_id=$1) AND revoked_at IS NULL",[backingStoreId]);
    });
  }
  async vaultAreaBinding(memberId:string,input:{areaId:string;expectedRevision:number;permission:Permission},options:{db?:Db;requiredBackingKind?:'git'|'files'}={}):Promise<VaultAreaBinding|undefined>{
    if(!id.safeParse(input.areaId).success||!revision.safeParse(input.expectedRevision).success||!['use','edit'].includes(input.permission))return undefined;
    return this.transaction(options.db,async db=>{
      let member:Member;try{member=await this.actor(db,memberId);}catch(e){if(e instanceof VaultStoreError)return undefined;throw e;}
      const row=await currentVaultArea(db,member,input.areaId);
      if(!row||row.kind==='place'||Number(row.revision)!==input.expectedRevision||!await vaultAreaAllows(db,member,row,input.permission))return undefined;
      if(options.requiredBackingKind&&!(await db.query('SELECT 1 FROM vault_backing_stores WHERE id=$1 AND kind=$2',[row.backing_store_id,options.requiredBackingKind])).rowCount)return undefined;
      return vaultAreaBindingSchema.parse({areaId:row.id,kind:row.kind,
        owner:row.owner_member_id?{kind:'member',id:row.owner_member_id}:{kind:'organisation',id:row.owner_organisation_id},
        resource:{kind:'vault-area',id:row.id},backingStoreId:row.backing_store_id,relativePath:row.relative_path,accessRevision:Number(row.revision)});
    });
  }
}
