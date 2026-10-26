import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { GuardedVaultFiles, VAULT_AREA_MARKER, VaultFilesDeniedError, VaultFilesUnavailableError, type VaultFilesBackings, type VaultFilesContext } from '../src/vault-files.js';
import { vaultContentRevision, VaultContentChangedError, VaultPushFailedError } from '../src/vault-git.js';
import { readOriginFrontmatter } from '../src/origin.js';
import { VaultTracksHome } from '../src/tracks.js';
import { withVaultRepositoryLock } from '../src/note-lock.js';
import { NotePathEscapesStoreError, resolveInStore } from '../src/notes-store.js';
import type { VaultAreaBinding, VaultWriteBinding } from '../src/authority-contract.js';
import type { PgVaultStore } from '../src/vault-area-store.js';

const binding:VaultAreaBinding={areaId:'area-a',kind:'private',owner:{kind:'member',id:'member-a'},resource:{kind:'vault-area',id:'area-a'},backingStoreId:'backing',relativePath:'member-a',accessRevision:1};
const authority={agentId:'agent',turnId:'turn',sessionId:'session',placeId:'private-place',audience:{placeId:'private-place',revision:1,participants:[{kind:'member' as const,memberId:'member-a'}]},policyRevision:1,origin:'human' as const,actingMemberId:'member-a',spokenByMemberId:'member-a'};
let tmp:string,root:string,origin:string,backings:VaultFilesBackings,api:GuardedVaultFiles,ctx:VaultFilesContext,enabled:boolean;
let current:ReturnType<typeof vi.fn<PgVaultStore['vaultAreaBinding']>>;
function git(dir:string,...args:string[]){return execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});}
function seed(path:string,content:string){const abs=join(root,path);mkdirSync(dirname(abs),{recursive:true});writeFileSync(abs,content);git(root,'add','--',path);git(root,'commit','-qm','seed '+path);git(root,'push','-q','origin','HEAD');}
function writeBinding(path:string,revision:string|null=null):VaultWriteBinding{return {areaId:binding.areaId,relativePath:path,expectedContentRevision:revision,accessRevision:1,approvedOrigin:'synced',authority};}
function setupArea(path:string,area:VaultAreaBinding,bare:string){
  execFileSync('git',['init','--quiet','--bare',bare]);
  execFileSync('git',['init','--quiet',path]);
  git(path,'config','user.name','Vault Test');git(path,'config','user.email','vault@example.invalid');git(path,'remote','add','origin',bare);
  writeFileSync(join(path,VAULT_AREA_MARKER),JSON.stringify({version:1,areaId:area.areaId,backingStoreId:area.backingStoreId,relativePath:area.relativePath,kind:area.kind,owner:area.owner}));
  git(path,'add','--',VAULT_AREA_MARKER);git(path,'commit','-qm','initialize area');git(path,'push','-q','origin','HEAD');
}
beforeEach(()=>{
  tmp=mkdtempSync(join(tmpdir(),'vault-files-'));root=join(tmp,'working','member-a');origin=join(tmp,'bare','area-a.git');mkdirSync(join(tmp,'working'),{recursive:true});mkdirSync(join(tmp,'bare'));
  setupArea(root,binding,origin);enabled=true;
  current=vi.fn(async(memberId,input,options)=>{
    expect(options?.db).toBe(ctx.db);expect(options?.requiredBackingKind).toBe('git');
    return enabled&&memberId==='member-a'&&input.areaId===binding.areaId&&input.expectedRevision===1?binding:undefined;
  });
  backings=new Map([['backing',{kind:'git',root:join(tmp,'working'),areas:new Map([['area-a',{origin}]])}]]);
  api=new GuardedVaultFiles({vaultAreaBinding:current},backings);
  ctx={memberId:'member-a',areaId:'area-a',expectedRevision:1,db:{query:vi.fn()} as unknown as VaultFilesContext['db']};
});
afterEach(()=>rmSync(tmp,{force:true,recursive:true}));

describe('authorized initialized area reads',()=>{
  it('does not inspect a backing mapping or enumerate files before current authorization',async()=>{
    const get=vi.fn(()=>{throw Error('mapping observed before authority');});
    const hidden=new GuardedVaultFiles({vaultAreaBinding:current},{get} as unknown as VaultFilesBackings);
    for(const request of [{...ctx,memberId:'member-b'},{...ctx,areaId:'hidden'},{...ctx,expectedRevision:2}]){
      await expect(hidden.list(request)).rejects.toThrow(VaultFilesDeniedError);
      await expect(hidden.search(request,'secret')).rejects.toThrow(VaultFilesDeniedError);
      await expect(hidden.read(request,'anything.md')).rejects.toThrow(VaultFilesDeniedError);
      await expect(hidden.backlinks(request,'anything.md')).rejects.toThrow(VaultFilesDeniedError);
      await expect(hidden.count(request)).rejects.toThrow(VaultFilesDeniedError);
    }
    expect(get).not.toHaveBeenCalled();
  });
  it('treats an initialized empty area as healthy zero',async()=>{
    expect(await api.list(ctx)).toEqual({paths:[],files:0});expect(await api.count(ctx)).toBe(0);
    expect(await api.search(ctx,'anything')).toEqual({hits:[],files:0});
    expect(await api.backlinks(ctx,'anything.md')).toEqual({path:'anything.md',backlinks:[],files:0});
  });
  it('bounds reads/search/backlinks/count to this area, with ownership only from current authority',async()=>{
    seed('note.md','---\nscope: private\nowner: another-member\n---\nunique needle\n');seed('link.md','[[note]]');
    const sibling=join(tmp,'working','member-b');mkdirSync(sibling);writeFileSync(join(sibling,'secret.md'),'secret sibling needle [[note]]');
    writeFileSync(join(root,'.hidden.md'),'hidden needle');mkdirSync(join(root,'_meta'));writeFileSync(join(root,'_meta','transcript.md'),'hidden needle');
    expect(await api.list(ctx)).toEqual({paths:['link.md','note.md'],files:2});
    expect(await api.search(ctx,'needle')).toEqual({hits:['note.md'],files:2});
    expect(await api.backlinks(ctx,'note.md')).toEqual({path:'note.md',backlinks:['link.md'],files:2});
    expect((await api.read(ctx,'note.md')).content).toContain('another-member');
    expect(await api.count(ctx)).toBe(2);
  });
  it('returns SHA256 of exact bytes and refreshes same-size/same-mtime search content',async()=>{
    seed('note.md','alpha\r\n');const old=await api.read(ctx,'note.md');expect(old.contentRevision).toBe(vaultContentRevision(readFileSync(join(root,'note.md'))));
    await api.search(ctx,'alpha');const {statSync,utimesSync}=await import('node:fs');const mtime=statSync(join(root,'note.md')).mtime;
    writeFileSync(join(root,'note.md'),'bravo\r\n');utimesSync(join(root,'note.md'),mtime,mtime);
    expect((await api.search(ctx,'bravo')).hits).toEqual(['note.md']);expect((await api.search(ctx,'alpha')).hits).toEqual([]);
  });
  it('rechecks authority after a repository-lock wait, before reading or writing',async()=>{
    let release!:()=>void,locked!:()=>void;const held=new Promise<void>(r=>{locked=r;});
    const holder=withVaultRepositoryLock(root,async()=>{locked();await new Promise<void>(r=>{release=r;});});await held;
    const pending=api.write(ctx,{binding:writeBinding('new.md'),frontmatter:{},body:'forbidden'});
    // The first decision is synchronous through this stub; the subsequent lock must wait.
    await new Promise(r=>setTimeout(r,50));enabled=false;release();await holder;
    await expect(pending).rejects.toThrow(VaultFilesDeniedError);expect(existsSync(join(root,'new.md'))).toBe(false);expect(current.mock.calls.length).toBeGreaterThan(1);
  });
  it('refuses missing mapping, wrong initialization, absent root and non-Git backing',async()=>{
    const missing=new GuardedVaultFiles({vaultAreaBinding:current},new Map());await expect(missing.list(ctx)).rejects.toThrow(VaultFilesUnavailableError);
    const wrong={version:1,...binding,areaId:'other'};writeFileSync(join(root,VAULT_AREA_MARKER),JSON.stringify(wrong));await expect(api.list(ctx)).rejects.toThrow(VaultFilesUnavailableError);
    rmSync(root,{recursive:true,force:true});await expect(api.list(ctx)).rejects.toThrow(VaultFilesUnavailableError);
    const files=new GuardedVaultFiles({vaultAreaBinding:current},new Map([['backing',{kind:'files',root:join(tmp,'working'),areas:new Map()}]]));await expect(files.list(ctx)).rejects.toThrow(VaultFilesUnavailableError);
  });
  it('refuses marker ownership/kind mismatch and never adopts existing unmarked files',async()=>{
    const marker=JSON.parse(readFileSync(join(root,VAULT_AREA_MARKER),'utf8'));
    for(const patch of [{owner:{kind:'member',id:'other'}},{kind:'shared'}]){writeFileSync(join(root,VAULT_AREA_MARKER),JSON.stringify({...marker,...patch}));await expect(api.list(ctx)).rejects.toThrow(VaultFilesUnavailableError);}
    rmSync(join(root,VAULT_AREA_MARKER));writeFileSync(join(root,'old.md'),'legacy content');await expect(api.list(ctx)).rejects.toThrow(VaultFilesUnavailableError);
  });
  it('refuses physical backing aliases, nested roots and shared local histories',async()=>{
    const aliases=new Map(backings);aliases.set('alias',{kind:'git',root:join(tmp,'working'),areas:new Map()});await expect(new GuardedVaultFiles({vaultAreaBinding:current},aliases).list(ctx)).rejects.toThrow(VaultFilesUnavailableError);
    aliases.set('alias',{kind:'git',root,areas:new Map()});await expect(new GuardedVaultFiles({vaultAreaBinding:current},aliases).list(ctx)).rejects.toThrow(VaultFilesUnavailableError);
    const shared=new Map(backings);shared.set('second',{kind:'git',root:join(tmp,'second'),areas:new Map([['area-b',{origin}]])});mkdirSync(join(tmp,'second'));await expect(new GuardedVaultFiles({vaultAreaBinding:current},shared).list(ctx)).rejects.toThrow(VaultFilesUnavailableError);
  });
  it('refuses a filesystem-root backing because no local origin can be outside it',async()=>{
    const fullRoot={...binding,relativePath:realpathSync(root).slice(1)};
    const marker=JSON.parse(readFileSync(join(root,VAULT_AREA_MARKER),'utf8'));writeFileSync(join(root,VAULT_AREA_MARKER),JSON.stringify({...marker,relativePath:fullRoot.relativePath}));
    current.mockResolvedValue(fullRoot);
    const allFiles:VaultFilesBackings=new Map([['backing',{kind:'git',root:'/',areas:new Map([['area-a',{origin}]])}]]);
    await expect(new GuardedVaultFiles({vaultAreaBinding:current},allFiles).list(ctx)).rejects.toThrow(new VaultFilesUnavailableError());
  });
  it('refuses a real private area origin placed inside another initialized member area',async()=>{
    const second:VaultAreaBinding={...binding,areaId:'area-b',relativePath:'member-b',owner:{kind:'member',id:'member-b'},resource:{kind:'vault-area',id:'area-b'}};
    const rootB=join(tmp,'working','member-b'),originB=join(tmp,'bare','area-b.git');setupArea(rootB,second,originB);
    const nestedOrigin=join(rootB,'a-history.git');renameSync(origin,nestedOrigin);git(root,'remote','set-url','origin',nestedOrigin);
    const stores:VaultFilesBackings=new Map([['backing',{kind:'git',root:join(tmp,'working'),areas:new Map([['area-a',{origin:nestedOrigin}],['area-b',{origin:originB}]])}]]);
    current.mockImplementation(async(memberId,input)=>memberId==='member-b'&&input.areaId==='area-b'?second:memberId==='member-a'&&input.areaId==='area-a'?binding:undefined);
    const guarded=new GuardedVaultFiles({vaultAreaBinding:current},stores),ctxB={...ctx,memberId:'member-b',areaId:'area-b'};
    expect(readFileSync(join(nestedOrigin,'HEAD'),'utf8')).toContain('ref:');
    for(const member of [ctx,ctxB]){
      await expect(guarded.list(member)).rejects.toThrow(new VaultFilesUnavailableError());
      await expect(guarded.count(member)).rejects.toThrow(new VaultFilesUnavailableError());
    }
    for(const path of ['a-history.git/HEAD','a-history.git/config'])await expect(guarded.read(ctxB,path)).rejects.toThrow(new VaultFilesUnavailableError());
    await expect(guarded.search(ctxB,'ref')).rejects.toThrow(new VaultFilesUnavailableError());
    await expect(guarded.backlinks(ctxB,'note.md')).rejects.toThrow(new VaultFilesUnavailableError());
    await expect(guarded.write(ctx,{binding:writeBinding('new.md'),frontmatter:{},body:'bad'})).rejects.toThrow(new VaultFilesUnavailableError());expect(existsSync(join(root,'new.md'))).toBe(false);
  });
  it.each(['ordinary','bare','bare-without-config'])('refuses nested %s repositories on every guarded file path',async(kind)=>{
    seed('safe.md','safe note');const note=await api.read(ctx,'safe.md'),nested=join(root,'nested-history');
    execFileSync('git',['init','--quiet',...(kind==='ordinary'?[]:['--bare']),nested]);
    if(kind==='bare-without-config')rmSync(join(nested,'config'));
    const secretPath=kind==='ordinary'?'private.md':'HEAD';if(kind==='ordinary')writeFileSync(join(nested,secretPath),'other private history');
    await expect(api.read(ctx,'nested-history/'+secretPath)).rejects.toThrow(new VaultFilesUnavailableError());
    await expect(api.list(ctx)).rejects.toThrow(new VaultFilesUnavailableError());
    await expect(api.count(ctx)).rejects.toThrow(new VaultFilesUnavailableError());
    await expect(api.search(ctx,'private')).rejects.toThrow(new VaultFilesUnavailableError());
    await expect(api.backlinks(ctx,'safe.md')).rejects.toThrow(new VaultFilesUnavailableError());
    await expect(api.write(ctx,{binding:writeBinding('nested-history/new.md'),frontmatter:{},body:'bad'})).rejects.toThrow(new VaultFilesUnavailableError());
    await expect(api.move(ctx,{binding:writeBinding('safe.md',note.contentRevision),destination:'nested-history/moved.md',expectedDestinationRevision:null,companion:null,expectedCompanionDestinationRevision:null})).rejects.toThrow(new VaultFilesUnavailableError());
    expect(existsSync(join(root,'safe.md'))).toBe(true);expect(existsSync(join(nested,'new.md'))).toBe(false);expect(existsSync(join(nested,'moved.md'))).toBe(false);
  });
  it('refuses a parent Git repository, gitfile/worktree and object alternates',async()=>{
    renameSync(join(root,'.git'),join(tmp,'saved.git'));execFileSync('git',['init','--quiet',join(tmp,'working')]);await expect(api.list(ctx)).rejects.toThrow(VaultFilesUnavailableError);
    writeFileSync(join(root,'.git'),'gitdir: '+join(tmp,'saved.git')+'\n');await expect(api.list(ctx)).rejects.toThrow(VaultFilesUnavailableError);
    rmSync(join(root,'.git'));renameSync(join(tmp,'saved.git'),join(root,'.git'));writeFileSync(join(root,'.git','objects','info','alternates'),join(tmp,'saved.git','objects')+'\n');await expect(api.list(ctx)).rejects.toThrow(VaultFilesUnavailableError);
  });
  it('refuses traversal, hidden paths, symlinks, missing leaves under symlinks, and nonregular files',async()=>{
    const outside=join(tmp,'outside');mkdirSync(outside);writeFileSync(join(outside,'secret.md'),'secret');symlinkSync(outside,join(root,'link'));
    for(const path of ['../member-b/secret.md','/etc/passwd','.git/config','notes/.hidden.md','link/missing.md','link/secret.md','notes\\escape.md']){
      await expect(api.read(ctx,path)).rejects.toThrow(NotePathEscapesStoreError);
      await expect(api.write(ctx,{binding:writeBinding(path),frontmatter:{},body:'bad'})).rejects.toThrow();
    }
    expect(existsSync(join(outside,'missing.md'))).toBe(false);
    rmSync(join(root,'link'));execFileSync('mkfifo',[join(root,'pipe.md')]);expect(()=>resolveInStore('pipe.md',root)).toThrow(NotePathEscapesStoreError);
    linkSync(join(outside,'secret.md'),join(root,'hardlink.md'));expect(()=>resolveInStore('hardlink.md',root)).toThrow(NotePathEscapesStoreError);
  });
  it('refuses external origins before filesystem mutation',async()=>{
    git(root,'remote','set-url','origin','https://example.invalid/notes.git');await expect(api.write(ctx,{binding:writeBinding('new.md'),frontmatter:{},body:'bad'})).rejects.toThrow(VaultFilesUnavailableError);expect(existsSync(join(root,'new.md'))).toBe(false);
  });
});

describe('exact content mutations and local durability',()=>{
  it('creates, lists, adds, closes and moves shared Tracks files through GuardedVaultFiles',async()=>{
    const shared:VaultAreaBinding={...binding,kind:'shared',owner:{kind:'organisation',id:'org-a'}};
    writeFileSync(join(root,VAULT_AREA_MARKER),JSON.stringify({version:1,areaId:shared.areaId,backingStoreId:shared.backingStoreId,relativePath:shared.relativePath,kind:shared.kind,owner:shared.owner}));
    current.mockImplementation(async(memberId,input,options)=>{
      expect(options?.db).toBe(ctx.db);expect(options?.requiredBackingKind).toBe('git');
      return enabled&&memberId==='member-a'&&input.areaId===shared.areaId&&input.expectedRevision===1?shared:undefined;
    });
    const sharedApi=new GuardedVaultFiles({vaultAreaBinding:current},backings),writer={
      async list(){return (await sharedApi.list(ctx)).paths;},
      async read(path:string){try{const file=await sharedApi.read(ctx,path);return {path,content:file.content,contentRevision:file.contentRevision};}catch(error){if((error as Error).name==='NoteNotFoundError')return undefined;throw error;}},
      async write(input:{path:string;expectedContentRevision:string|null;frontmatter:Record<string,unknown>;body:string}){
        await sharedApi.write(ctx,{binding:writeBinding(input.path,input.expectedContentRevision),frontmatter:input.frontmatter,body:input.body});
      },
    };
    const home=new VaultTracksHome(writer,()=> '2026-10-26',()=> 'application-1');
    await home.createTrack({id:'funding',name:'Funding',purpose:'Grant applications',steps:['draft','submitted','won'],closingSteps:['won']});
    const item=await home.addItem('funding',{organisationId:'org-a'},'draft','Prepare the grant','owner-said');
    expect(await home.listTracks()).toHaveLength(1);expect(await home.listItems('funding')).toEqual([item]);
    await home.moveItem(item.id,'won','Awarded','owner-said');expect(await home.listItems('funding')).toEqual([]);
    expect(readFileSync(join(root,'tracks/funding/track.md'),'utf8')).toContain('lares_origin: synced');
    expect(readFileSync(join(root,'tracks/funding/items/application-1.md'),'utf8')).toContain('type: track-item');
  });
  it.each(['*.md',':(glob)*.md',':(top)other.md','[a-z]?.md'])('treats %s literally through create, move and remove without committing an unrelated edit',async(path)=>{
    seed('other.md','original canary');writeFileSync(join(root,'other.md'),'unrelated unstaged modification');
    await api.write(ctx,{binding:writeBinding(path),frontmatter:{},body:'literal path'});
    expect(git(origin,'show','HEAD:other.md')).toBe('original canary');expect(readFileSync(join(root,path),'utf8')).toContain('literal path');
    expect(git(root,'show','--pretty=','--name-only','HEAD').trim()).toBe(path);
    const note=await api.read(ctx,path),destination='moved/'+path;
    await api.move(ctx,{binding:writeBinding(path,note.contentRevision),destination,expectedDestinationRevision:null,companion:null,expectedCompanionDestinationRevision:null});
    expect(existsSync(join(root,path))).toBe(false);expect(existsSync(join(root,destination))).toBe(true);
    expect(git(origin,'show','HEAD:other.md')).toBe('original canary');
    const moved=await api.read(ctx,destination);await api.remove(ctx,{binding:writeBinding(destination,moved.contentRevision),companion:null});
    expect(existsSync(join(root,destination))).toBe(false);expect(git(origin,'show','HEAD:other.md')).toBe('original canary');expect(readFileSync(join(root,'other.md'),'utf8')).toBe('unrelated unstaged modification');
    expect(git(root,'status','--porcelain').trim()).toBe('M other.md');expect(git(root,'diff','--cached')).toBe('');
  });
  it.each([0x2028,0x2029,0x85])('refuses Unicode line separator %i which can forge a provenance field',async(codepoint)=>{
    const separator=String.fromCodePoint(codepoint),forgery='title'+separator+'lares_origin: owner'+separator;
    if(codepoint!==0x85)expect(readOriginFrontmatter('---\ntitle: '+forgery+'\nlares_origin: synced\n---\n')).toBe('owner');
    for(const frontmatter of [{title:forgery},{tags:[forgery]}])await expect(api.write(ctx,{binding:writeBinding('forged.md'),frontmatter,body:'bad'})).rejects.toThrow(new VaultFilesDeniedError());
    expect(existsSync(join(root,'forged.md'))).toBe(false);
    await api.write(ctx,{binding:writeBinding('safe.md'),frontmatter:{title:'safe'},body:'safe'});
    expect(readOriginFrontmatter(readFileSync(join(root,'safe.md'),'utf8'))).toBe('synced');
  });
  it('creates only when absent, stamps approved origin, and refuses stale or omitted revisions',async()=>{
    const result=await api.write(ctx,{binding:writeBinding('notes/new.md'),frontmatter:{lares_origin:'owner',owner:'other'},body:'created'});
    expect(git(origin,'show','HEAD:notes/new.md')).toContain('lares_origin: synced');expect(result.commit).toBeTruthy();
    await expect(api.write(ctx,{binding:writeBinding('notes/new.md'),frontmatter:{},body:'overwrite'})).rejects.toThrow(VaultContentChangedError);
    const old=await api.read(ctx,'notes/new.md');writeFileSync(join(root,'notes/new.md'),'changed outside this operation');
    await expect(api.write(ctx,{binding:writeBinding('notes/new.md',old.contentRevision),frontmatter:{},body:'overwrite'})).rejects.toThrow(VaultContentChangedError);
    await expect(api.write(ctx,{binding:{...writeBinding('absent.md'),expectedContentRevision:undefined} as unknown as VaultWriteBinding,frontmatter:{},body:'bad'})).rejects.toThrow();
    expect(readFileSync(join(root,'notes/new.md'),'utf8')).toBe('changed outside this operation');
  });
  it.each(['ordinary','intent-to-add'])('rejects unexpected %s staging without committing or disturbing it',async(kind)=>{
    writeFileSync(join(root,'other.md'),'someone else');git(root,'add',...(kind==='intent-to-add'?['-N']:[]),'--','other.md');const staged=git(root,'status','--porcelain');const head=git(root,'rev-parse','HEAD');
    await expect(api.write(ctx,{binding:writeBinding('new.md'),frontmatter:{},body:'bad'})).rejects.toThrow(/staged changes/);
    expect(git(root,'status','--porcelain')).toBe(staged);expect(git(root,'rev-parse','HEAD')).toBe(head);expect(existsSync(join(root,'new.md'))).toBe(false);
  });
  it('moves and removes exact article bytes and companion bytes in explicit single commits',async()=>{
    seed('articles/a.md','---\nfull_text: a.txt\n---\nSummary');seed('articles/a.txt','exact companion\r\n');const note=await api.read(ctx,'articles/a.md');
    await api.move(ctx,{binding:writeBinding(note.path,note.contentRevision),destination:'archive/b.md',expectedDestinationRevision:null,companion:note.companion,expectedCompanionDestinationRevision:null});
    expect(git(origin,'show','HEAD:archive/a.txt')).toBe('exact companion\r\n');expect(existsSync(join(root,note.path))).toBe(false);
    expect(git(root,'show','--pretty=','--no-renames','--name-only','HEAD').trim().split('\n').sort()).toEqual(['archive/a.txt','archive/b.md','articles/a.md','articles/a.txt']);
    const moved=await api.read(ctx,'archive/b.md');await api.remove(ctx,{binding:writeBinding(moved.path,moved.contentRevision),companion:moved.companion});expect(existsSync(join(root,'archive/a.txt'))).toBe(false);expect(existsSync(join(root,'archive/b.md'))).toBe(false);
  });
  it.each(['source','companion','destination','companion-destination','companion-deleted'])('refuses changed %s before moving either file',async(which)=>{
    seed('articles/a.md','---\nfull_text: a.txt\n---\nSummary');seed('articles/a.txt','companion');const note=await api.read(ctx,'articles/a.md');
    const target=which==='source'?'articles/a.md':which==='companion'||which==='companion-deleted'?'articles/a.txt':which==='destination'?'archive/b.md':'archive/a.txt';
    if(which==='companion-deleted')rmSync(join(root,target));else{mkdirSync(dirname(join(root,target)),{recursive:true});writeFileSync(join(root,target),'newer content');}
    const head=git(root,'rev-parse','HEAD');await expect(api.move(ctx,{binding:writeBinding(note.path,note.contentRevision),destination:'archive/b.md',expectedDestinationRevision:null,companion:note.companion,expectedCompanionDestinationRevision:null})).rejects.toThrow(VaultContentChangedError);
    expect(git(root,'rev-parse','HEAD')).toBe(head);expect(existsSync(join(root,'articles/a.md'))).toBe(true);expect(git(root,'diff','--cached')).toBe('');
  });
  it('renames an article inside its existing directory without moving its unchanged companion',async()=>{
    seed('articles/a.md','---\nfull_text: a.txt\n---\nSummary');seed('articles/a.txt','companion');const note=await api.read(ctx,'articles/a.md');
    await api.move(ctx,{binding:writeBinding(note.path,note.contentRevision),destination:'articles/b.md',expectedDestinationRevision:null,companion:note.companion,expectedCompanionDestinationRevision:note.companion!.revision});
    expect(readFileSync(join(root,'articles/a.txt'),'utf8')).toBe('companion');expect(existsSync(join(root,'articles/b.md'))).toBe(true);
  });
  it('refuses frontmatter which can inject another origin line',async()=>{
    await expect(api.write(ctx,{binding:writeBinding('new.md'),frontmatter:{title:'title\nlares_origin: owner'},body:'bad'})).rejects.toThrow(VaultFilesDeniedError);expect(existsSync(join(root,'new.md'))).toBe(false);
  });
  it('refuses delete when its source or companion changed',async()=>{
    seed('a.md','---\nfull_text: a.txt\n---\nSummary');seed('a.txt','companion');const note=await api.read(ctx,'a.md');writeFileSync(join(root,'a.txt'),'changed');
    await expect(api.remove(ctx,{binding:writeBinding(note.path,note.contentRevision),companion:note.companion})).rejects.toThrow(VaultContentChangedError);expect(existsSync(join(root,'a.md'))).toBe(true);
  });
  it('redacts unexpected Git errors instead of returning backing paths or stderr',async()=>{
    writeFileSync(join(root,'.git','hooks','pre-commit'),'#!/bin/sh\nprintf \"private backing detail\\n\" >&2\nexit 1\n');chmodSync(join(root,'.git','hooks','pre-commit'),0o755);
    let failure:unknown;try{await api.write(ctx,{binding:writeBinding('new.md'),frontmatter:{},body:'new'});}catch(error){failure=error;}
    expect(failure).toBeInstanceOf(VaultFilesUnavailableError);expect(String(failure)).not.toContain(tmp);expect((failure as Error).cause).toBeUndefined();
  });
  it('reports a failed local push with the durable local commit',async()=>{
    writeFileSync(join(origin,'hooks','pre-receive'),'#!/bin/sh\nexit 1\n');chmodSync(join(origin,'hooks','pre-receive'),0o755);
    let failure:unknown;try{await api.write(ctx,{binding:writeBinding('durable.md'),frontmatter:{},body:'durable'});}catch(error){failure=error;}
    expect(failure).toBeInstanceOf(VaultPushFailedError);expect((failure as VaultPushFailedError).commit).toBe(git(root,'rev-parse','--short','HEAD').trim());expect(git(root,'show','HEAD:durable.md')).toContain('durable');expect(git(origin,'ls-tree','-r','--name-only','HEAD')).not.toContain('durable.md');expect(git(root,'diff','--cached')).toBe('');
  });
  it('serializes two actual processes writing different notes into separate commits',async()=>{
    writeFileSync(join(root,'.git','hooks','pre-commit'),'#!/bin/sh\nsleep 0.15\n');chmodSync(join(root,'.git','hooks','pre-commit'),0o755);
    const module=resolve('src/vault-git.ts');
    const child=(path:string)=>new Promise<void>((resolveChild,reject)=>{
      const script=`import {commitNote} from ${JSON.stringify(module)};await commitNote({vaultRoot:${JSON.stringify(root)},path:${JSON.stringify(path)},frontmatter:{},body:'separate'});`;
      const proc=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:resolve('.'),stdio:['ignore','pipe','pipe']});let stderr='';proc.stderr.on('data',chunk=>{stderr+=chunk;});proc.once('error',reject);proc.once('exit',code=>code===0?resolveChild():reject(Error(stderr)));
    });
    await Promise.all([child('one.md'),child('two.md')]);
    const commits=git(root,'rev-list','-2','HEAD').trim().split('\n');const changed=commits.map(commit=>git(root,'show','--format=','--name-only',commit).trim());expect(changed.sort()).toEqual(['one.md','two.md']);expect(git(root,'rev-parse','HEAD')).toBe(git(origin,'rev-parse','HEAD'));expect(git(root,'status','--porcelain')).toBe('');
  },15000);
});
