/** Metadata-only source dependencies. A future broker must capture before any output. */
import {currentMember} from './member-store.js';
import {currentVaultArea,vaultAreaAllows} from './vault-area-store.js';
import {grantedVaultAreas} from './manifest.js';
import {hashOf,type LoadedDefinition} from './definition.js';
import {invalidateConsoleSource,requireConsoleSourceOwner,requireNewConsoleSourcesBeforeBinding,retainConsoleSourceDeadline,type SourceBinding,type SourceDatabase} from './console-source-transaction.js';
/** Only canonical definition material crosses the role/Keeper boundary. A local `dir` is never
 * needed to validate the trusted loaded-definition hash and must not cross that boundary. */
export type SessionDefinitionMaterial=Pick<LoadedDefinition,'definition'|'dutiesMd'|'voiceMd'|'hash'>;
export interface RequestedVaultSources {sessionDefinition:SessionDefinitionMaterial;areaIds:readonly string[]}
interface Capture {area_id:string;access_revision:string;session_definition_hash:string;original_valid_until:string|null}
const values=(b:SourceBinding)=>[b.agent,b.incarnation,b.sessionId,b.memberId,b.admissionNonce];
export async function retainedConsoleSources(db:SourceDatabase,b:SourceBinding):Promise<Capture[]>{
  requireConsoleSourceOwner(db);
  return (await db.query(`SELECT area_id,access_revision,session_definition_hash,original_valid_until::text FROM console_vault_source_captures
    WHERE agent=$1 AND incarnation=$2::uuid AND session_id=$3 AND member_id=$4 AND admission_nonce=$5 ORDER BY area_id`,values(b))).rows;
}
/** Validate the union BEFORE locking the binding. Return only captures not already retained.
 * The caller holds current definition/access locks before entering; all source locks remain
 * held through binding validation, insertion and the eventual protected use. */
export async function prepareConsoleVaultSources(db:SourceDatabase,b:SourceBinding,retained:Capture[],requested?:RequestedVaultSources):Promise<Capture[]>{
  requireConsoleSourceOwner(db);
  if(!retained.length&&!requested?.areaIds.length)return [];
  const member=await currentMember(db as never,b.memberId,{lock:'share'});
  if(!member)invalidateConsoleSource(db,b);
  const definition=(await db.query("SELECT hash,definition FROM agent_definitions WHERE name=$1 AND status='valid' FOR SHARE",[b.agent])).rows[0];
  if(!definition)invalidateConsoleSource(db,b);
  // A malformed/unauthorised new request must never hide an invalid retained dependency.
  // Collect ordinary request refusals while inspecting the full sorted lock union.
  let refused=false;const requestedAreas=new Set<string>();
  if(requested){try{
    if(requested.sessionDefinition.definition.name!==b.agent||hashOf(requested.sessionDefinition)!==requested.sessionDefinition.hash||requested.sessionDefinition.hash!==definition.hash)refused=true;
    else for(const area of grantedVaultAreas(requested.sessionDefinition.definition))requestedAreas.add(area);
  }catch{refused=true;}}
  const union=new Map<string,Capture|undefined>(retained.map(c=>[c.area_id,c]));
  for(const id of requested?.areaIds??[]){if(typeof id!=='string'||!id||id.trim()!==id){refused=true;continue;}if(!union.has(id))union.set(id,undefined);}
  try{requireNewConsoleSourcesBeforeBinding(db,b,[...union.values()].some(value=>value===undefined));}catch{refused=true;}
  const pending:Capture[]=[];
  for(const [id,capture] of [...union].sort(([a],[b])=>a.localeCompare(b))){
    const row=await currentVaultArea(db as never,member!,id);
    let expiry:string|null=null;
    const allowed=row&&row.kind!=='place'&&await vaultAreaAllows(db as never,member!,row,'use',value=>{expiry=value;});
    if(capture){
      if(!allowed||String(row!.revision)!==String(capture.access_revision)||capture.session_definition_hash!==definition.hash)invalidateConsoleSource(db,b);
      retainConsoleSourceDeadline(db,b,capture.original_valid_until);
      if(capture.original_valid_until!==null&&!(await db.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp()',[capture.original_valid_until])).rows.length)invalidateConsoleSource(db,b);
    }else{
      if(!allowed||!requestedAreas.has(row!.kind)){refused=true;continue;}
      pending.push({area_id:id,access_revision:String(row!.revision),session_definition_hash:requested!.sessionDefinition.hash,original_valid_until:expiry});
    }
  }
  if(refused)throw new Error('Conversation authority is not available');
  for(const capture of pending)retainConsoleSourceDeadline(db,b,capture.original_valid_until);
  return pending;
}
export async function insertConsoleVaultSources(db:SourceDatabase,b:SourceBinding,pending:Capture[]):Promise<void>{
  requireConsoleSourceOwner(db);
  for(const c of pending)await db.query(`INSERT INTO console_vault_source_captures
    (agent,incarnation,session_id,member_id,admission_nonce,area_id,access_revision,session_definition_hash,original_valid_until)
    VALUES($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[...values(b),c.area_id,c.access_revision,c.session_definition_hash,c.original_valid_until]);
}
