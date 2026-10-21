/** Server-only area-scoped files. This is NOT runtime admission or a model tool.
 * The trusted caller authenticates memberId, owns BEGIN/COMMIT on db, and retains that
 * transaction through the entire awaited operation. Never accept backings from a model.
 * Advisory locks coordinate engine writers; hostile concurrent OS processes are out of scope.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import { vaultAreaBindingSchema, vaultWriteBindingSchema, type VaultAreaBinding, type VaultWriteBinding } from './authority-contract.js';
import type { GrantDatabase } from './grant-store.js';
import type { PgVaultStore } from './vault-area-store.js';
import { findBacklinks, listNotes, NoteNotFoundError, NotePathEscapesStoreError, resolveInStore, searchNotes } from './notes-store.js';
import { withVaultRepositoryLock } from './note-lock.js';
import { commitNote, moveNote, removeNote, runVaultGit, vaultCompanionOf, vaultContentRevision, VaultContentChangedError, VaultPushFailedError, VaultStagedChangesError, type VaultGitGuard } from './vault-git.js';
import { articleCompanionPath } from '@lares/vault-format/article';

export const VAULT_AREA_MARKER = '.lares-vault-area.json';
/** Provisioning must explicitly initialize an EMPTY area with this marker and its own Git repository.
 * Access revision is deliberately absent: changing grants never adopts or recreates files. */
export const vaultAreaInitializationSchema = vaultAreaBindingSchema.pick({areaId:true, backingStoreId:true, relativePath:true, kind:true, owner:true})
  .extend({version:z.literal(1)}).strict();
export type VaultAreaInitialization = z.infer<typeof vaultAreaInitializationSchema>;
export interface VaultBackingFiles {
  kind: 'git' | 'files';
  root: string;
  /** One local bare repository per area; neither off-site URLs nor shared histories. */
  areas: ReadonlyMap<string, {origin:string}>;
}
export type VaultFilesBackings = ReadonlyMap<string, VaultBackingFiles>;
export interface VaultFilesContext {
  memberId:string;
  areaId:string;
  expectedRevision:number;
  db:GrantDatabase;
}
export interface VaultFileCompanion {path:string; revision:string}
export interface VaultFileContent {
  path:string; content:string; lines:number; contentRevision:string; companion:VaultFileCompanion|null;
}
export class VaultFilesUnavailableError extends Error {
  constructor() {super('Vault area unavailable');this.name='VaultFilesUnavailableError';}
}
export class VaultFilesDeniedError extends Error {
  constructor() {super('Vault access refused');this.name='VaultFilesDeniedError';}
}
function safeFailure(error:unknown):never {
  if(error instanceof VaultPushFailedError)throw new VaultPushFailedError(error.commit,new Error('Local bare origin rejected the push'));
  if(error instanceof VaultFilesDeniedError||error instanceof VaultFilesUnavailableError||error instanceof NoteNotFoundError||error instanceof NotePathEscapesStoreError||error instanceof VaultContentChangedError||error instanceof VaultStagedChangesError)throw error;
  throw new VaultFilesUnavailableError();
}
const under=(candidate:string,root:string)=>candidate===root||candidate.startsWith(root+sep);
function directory(path:string):string {
  if (!isAbsolute(path)||!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink()) throw new VaultFilesUnavailableError();
  return realpathSync(path);
}
function regular(path:string):void {
  const st=lstatSync(path);
  if (!st.isFile()||st.isSymbolicLink()||st.nlink!==1) throw new VaultFilesUnavailableError();
}

export class GuardedVaultFiles {
  constructor(private readonly authority:Pick<PgVaultStore,'vaultAreaBinding'>, private readonly backings:VaultFilesBackings) {}
  private async authorize(ctx:VaultFilesContext,permission:'use'|'edit'):Promise<VaultAreaBinding> {
    if (!ctx.db||typeof ctx.db.query!=='function') throw new VaultFilesDeniedError();
    const binding=await this.authority.vaultAreaBinding(ctx.memberId,
      {areaId:ctx.areaId,expectedRevision:ctx.expectedRevision,permission},{db:ctx.db,requiredBackingKind:'git'});
    if (!binding) throw new VaultFilesDeniedError();
    return binding;
  }
  /** Called only AFTER current area authorization. No fallback to parent/legacy roots. */
  private area(binding:VaultAreaBinding):{root:string;origin:string} {
    try {
      const selected=this.backings.get(binding.backingStoreId);
      if (!selected||selected.kind!=='git') throw new VaultFilesUnavailableError();
      const roots:string[]=[],origins:string[]=[];
      for (const backing of this.backings.values()) {
        const root=directory(backing.root);
        if (roots.some(other=>under(root,other)||under(other,root))) throw new VaultFilesUnavailableError();
        roots.push(root);
        for (const area of backing.areas.values()) {
          const origin=directory(area.origin);
          if(origins.some(other=>under(origin,other)||under(other,origin)))throw new VaultFilesUnavailableError();
          origins.push(origin);
        }
      }
      const parent=directory(selected.root),root=directory(resolveInStore(binding.relativePath,parent));
      const originEntry=selected.areas.get(binding.areaId);
      if(!originEntry)throw new VaultFilesUnavailableError();
      const origin=directory(originEntry.origin);
      if(under(origin,root)||under(root,origin))throw new VaultFilesUnavailableError();
      const gitDir=join(root,'.git');
      if(directory(gitDir)!==join(root,'.git') || runVaultGit(root,['rev-parse','--show-toplevel']).trim()!==root ||
        runVaultGit(root,['rev-parse','--path-format=absolute','--git-common-dir']).trim()!==gitDir) throw new VaultFilesUnavailableError();
      // An alternate object store could expose another area's retained history.
      try {lstatSync(join(gitDir,'objects/info/alternates'));throw new VaultFilesUnavailableError();}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const marker=join(root,VAULT_AREA_MARKER);regular(marker);
      const parsed=vaultAreaInitializationSchema.parse(JSON.parse(readFileSync(marker,'utf8')));
      const expected={version:1,areaId:binding.areaId,backingStoreId:binding.backingStoreId,relativePath:binding.relativePath,kind:binding.kind,owner:binding.owner};
      if(parsed.version!==expected.version||parsed.areaId!==expected.areaId||parsed.backingStoreId!==expected.backingStoreId||
        parsed.relativePath!==expected.relativePath||parsed.kind!==expected.kind||parsed.owner.kind!==expected.owner.kind||parsed.owner.id!==expected.owner.id)
        throw new VaultFilesUnavailableError();
      // No external origin is needed for basic notes, including reads of initialized areas.
      for(const args of [['remote','get-url','--all','origin'],['remote','get-url','--push','--all','origin']]){
        const urls=runVaultGit(root,args).trim().split('\n');
        if(urls.length!==1||!isAbsolute(urls[0])||realpathSync(urls[0])!==origin)throw new VaultFilesUnavailableError();
      }
      if(runVaultGit(origin,['rev-parse','--is-bare-repository']).trim()!=='true'||runVaultGit(origin,['rev-parse','--path-format=absolute','--git-common-dir']).trim()!==origin)throw new VaultFilesUnavailableError();
      try {lstatSync(join(origin,'objects/info/alternates'));throw new VaultFilesUnavailableError();}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      return {root,origin};
    } catch {throw new VaultFilesUnavailableError();}
  }
  private async readArea<T>(ctx:VaultFilesContext,fn:(root:string)=>T):Promise<T> {
    const binding=await this.authorize(ctx,'use'),area=this.area(binding);
    return withVaultRepositoryLock(area.root,async()=>{
      const current=await this.authorize(ctx,'use');
      const checked=this.area(current);
      if(checked.root!==area.root||checked.origin!==area.origin)throw new VaultFilesUnavailableError();
      return fn(area.root);
    }).catch(safeFailure);
  }
  async list(ctx:VaultFilesContext):Promise<{paths:string[];files:number}> {
    return this.readArea(ctx,root=>{const paths=listNotes(root,{allowEmpty:true});return {paths,files:paths.length};});
  }
  async count(ctx:VaultFilesContext):Promise<number> {return (await this.list(ctx)).files;}
  async search(ctx:VaultFilesContext,query:string) {
    return this.readArea(ctx,root=>searchNotes(query,root,undefined,{allowEmpty:true,fresh:true}));
  }
  async backlinks(ctx:VaultFilesContext,path:string) {
    return this.readArea(ctx,root=>findBacklinks(path,root,undefined,{allowEmpty:true,fresh:true}));
  }
  async read(ctx:VaultFilesContext,path:string):Promise<VaultFileContent> {
    return this.readArea(ctx,root=>{
      const abs=resolveInStore(path,root);
      let bytes:Buffer;
      try{regular(abs);bytes=readFileSync(abs);}catch(error){
        if((error as NodeJS.ErrnoException).code==='ENOENT')throw new NoteNotFoundError(path);
        throw error;
      }
      const content=bytes.toString('utf8'),parts=content.split('\n'),companion=vaultCompanionOf(root,path);
      return {path,content,lines:parts.at(-1)===''?parts.length-1:parts.length,contentRevision:vaultContentRevision(bytes),
        companion:companion===null?null:{path:companion,revision:vaultContentRevision(readFileSync(resolveInStore(companion,root)))}};
    });
  }
  private async writeArea(ctx:VaultFilesContext,write:VaultWriteBinding,expectedContents:Readonly<Record<string,string|null>>,companion:VaultFileCompanion|null) {
    // Shape parsing is not authentication. These fields must come from the trusted caller's
    // approved operation; the separate runtime adapter must enforce agent/audience/origin policy.
    const parsed=vaultWriteBindingSchema.parse(write);
    if(parsed.areaId!==ctx.areaId||parsed.accessRevision!==ctx.expectedRevision||parsed.authority.actingMemberId!==ctx.memberId)throw new VaultFilesDeniedError();
    const binding=await this.authorize(ctx,'edit'),area=this.area(binding);
    const guard:VaultGitGuard={expectedContents,companion,localOrigin:area.origin,revalidate:async()=>{
      const current=await this.authorize(ctx,'edit'),checked=this.area(current);
      if(checked.root!==area.root||checked.origin!==area.origin)throw new VaultFilesUnavailableError();
    }};
    return {root:area.root,guard};
  }
  async write(ctx:VaultFilesContext,input:{binding:VaultWriteBinding;frontmatter:Record<string,unknown>;body:string;message?:string}) {
    for(const [key,value] of Object.entries(input.frontmatter)){
      if(!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)||![value].flat().every(v=>v===null||v===undefined||typeof v==='boolean'||typeof v==='number'||(typeof v==='string'&&!/[\r\n\x00-\x1f\x7f]/.test(v))))throw new VaultFilesDeniedError();
    }
    const {root,guard}=await this.writeArea(ctx,input.binding,{[input.binding.relativePath]:input.binding.expectedContentRevision},null);
    return commitNote({vaultRoot:root,path:input.binding.relativePath,frontmatter:{...input.frontmatter,lares_origin:input.binding.approvedOrigin},body:input.body,message:input.message,guard}).catch(safeFailure);
  }
  async move(ctx:VaultFilesContext,input:{binding:VaultWriteBinding;destination:string;expectedDestinationRevision:string|null;companion:VaultFileCompanion|null;expectedCompanionDestinationRevision:string|null}) {
    if(input.binding.expectedContentRevision===null)throw new VaultFilesDeniedError();
    const companionDest=input.companion===null?null:articleCompanionPath(input.destination,basename(input.companion.path));
    if(input.companion!==null&&companionDest===null)throw new VaultFilesDeniedError();
    if(companionDest===input.companion?.path&&input.expectedCompanionDestinationRevision!==input.companion.revision)throw new VaultFilesDeniedError();
    const expected={ [input.binding.relativePath]:input.binding.expectedContentRevision,[input.destination]:input.expectedDestinationRevision,
      ...(input.companion?{[input.companion.path]:input.companion.revision}:{}),...(companionDest&&companionDest!==input.companion?.path?{[companionDest]:input.expectedCompanionDestinationRevision}:{}) };
    const {root,guard}=await this.writeArea(ctx,input.binding,expected,input.companion);
    return moveNote({vaultRoot:root,sourcePath:input.binding.relativePath,destPath:input.destination,message:`file: ${input.binding.relativePath}`,guard}).catch(safeFailure);
  }
  async remove(ctx:VaultFilesContext,input:{binding:VaultWriteBinding;companion:VaultFileCompanion|null}) {
    if(input.binding.expectedContentRevision===null)throw new VaultFilesDeniedError();
    const expected={ [input.binding.relativePath]:input.binding.expectedContentRevision,...(input.companion?{[input.companion.path]:input.companion.revision}:{}) };
    const {root,guard}=await this.writeArea(ctx,input.binding,expected,input.companion);
    return removeNote({vaultRoot:root,path:input.binding.relativePath,message:`drop: ${input.binding.relativePath}`,guard}).catch(safeFailure);
  }
}
