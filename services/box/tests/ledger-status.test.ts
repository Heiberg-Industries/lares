import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach,expect,it} from 'vitest';

const script=fileURLToPath(new URL('../ops/ledger-status.py',import.meta.url));
const roots:string[]=[];
const line=(kind:string)=>JSON.stringify({record:{kind},digest:'0'.repeat(64)});
function run(prefix:string){const result=spawnSync('python3',[script,'--prefix',prefix],{encoding:'utf8'});return {status:result.status,out:result.stdout.trim()};}
function prefix(){const root=mkdtempSync(join(tmpdir(),'lares-ledger-status-'));roots.push(root);return root;}
function custody(root:string,books:Record<string,string[]>){
  const directory=join(root,'var/lib/lares/budget-financial');mkdirSync(directory,{recursive:true});
  for(const [name,kinds] of Object.entries(books))writeFileSync(join(directory,name),kinds.map(line).join('\n')+'\n');
}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

it('says nothing when spending has not been set up',()=>{
  expect(run(prefix())).toEqual({status:0,out:''});
});
it('reports the current book',()=>{
  const root=prefix();custody(root,{'journal.jsonl':['genesis','book-seal'],'journal-000002.jsonl':['book-open','begin']});
  const result=run(root);
  expect(result.status).toBe(0);
  expect(result.out).toMatch(/^ledger: ok\. Book 2 is 0% full, .* used, .* free on disk\.$/);
});
it('reads the newest book, not the first one in name order',()=>{
  const root=prefix();custody(root,{'journal.jsonl':['genesis','book-seal'],'journal-000002.jsonl':['book-open','freeze']});
  const result=run(root);
  expect(result.status).toBe(1);
  expect(result.out).toContain('frozen itself');
});
it('says why spending is frozen, and that the owner has lifted it',()=>{
  const write=(root:string,records:object[],tail='')=>{const directory=join(root,'var/lib/lares/budget-financial');mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'journal.jsonl'),records.map(record=>JSON.stringify({record,digest:'0'.repeat(64)})).join('\n')+'\n'+tail);};
  const frozen=prefix();write(frozen,[{kind:'genesis'},{kind:'freeze',reason:'continuity'}]);
  expect(run(frozen)).toMatchObject({status:1,out:expect.stringContaining('the database and the ledger disagree')});
  expect(run(frozen).out).toContain('sudo lares budget recover --check');
  const lifted=prefix();write(lifted,[{kind:'genesis'},{kind:'freeze',reason:'uncertain'},{kind:'recovered',by:'owner'}]);
  expect(run(lifted).status).toBe(0);
  const keeperSettled=prefix();write(keeperSettled,[{kind:'genesis'},{kind:'recovered',by:'keeper'}]);
  expect(run(keeperSettled).status).toBe(0);
  const older=prefix();write(older,[{kind:'genesis'},{kind:'freeze',reason:'uncertain'},{kind:'book-seal'}]);
  writeFileSync(join(older,'var/lib/lares/budget-financial/journal-000002.jsonl'),JSON.stringify({record:{kind:'book-open'},digest:'0'.repeat(64)})+'\n');
  expect(run(older).status).toBe(1);
  const torn=prefix();write(torn,[{kind:'genesis'}],'{"record":{"kind":"comm');
  expect(run(torn).status).toBe(0);
});
it('tells the owner when the files cannot be understood, without changing them',()=>{
  const root=prefix();custody(root,{'journal.jsonl':['genesis']});
  writeFileSync(join(root,'var/lib/lares/budget-financial/journal.jsonl'),'not json\n');
  const result=run(root);
  expect(result.status).toBe(1);
  expect(result.out).toContain('could not be read');
});
it('tells the owner when the folder has no ledger files',()=>{
  const root=prefix();custody(root,{});
  const result=run(root);
  expect(result.status).toBe(1);
  expect(result.out).toContain('no ledger files');
});
