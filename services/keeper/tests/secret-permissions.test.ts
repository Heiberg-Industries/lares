import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect,it } from 'vitest';
it('provisions actual root:10001 0440 files readable by only a mounted runtime file, with directory keeper-only',()=>{
 const script=`
 const fs=require('node:fs'),cp=require('node:child_process');
 import('/helper.ts').then(({runtimeSecret,verifySecretRoot})=>{
 fs.mkdirSync('/tmp/keeper-only',{mode:0o700}); fs.writeFileSync('/tmp/keeper-only/secret','test-only',{mode:0o600});
 runtimeSecret('/tmp/keeper-only/secret');
 // The second call takes the read-only-safe verification path: no chown/chmod is attempted once
 // the installer or keeper has already established the exact runtime ownership and mode.
 runtimeSecret('/tmp/keeper-only/secret');verifySecretRoot('/tmp/keeper-only');
 const s=fs.statSync('/tmp/keeper-only/secret');if(s.uid!==0||s.gid!==10001||(s.mode&511)!==288)throw Error('permissions');
 // A bind mount exposes the file, not its keeper-only parent. Hardlink here models that file visibility only.
 fs.linkSync('/tmp/keeper-only/secret','/tmp/runtime-secret');
 const result=cp.execFileSync('node',['-e',"const f=require('fs');if(f.readFileSync('/tmp/runtime-secret','utf8')!=='test-only')process.exit(1);try{f.readdirSync('/tmp/keeper-only');process.exit(2)}catch{}"],{uid:10001,gid:10001});
 fs.symlinkSync('/tmp/runtime-secret','/tmp/link');let refused=false;try{runtimeSecret('/tmp/link')}catch{refused=true}if(!refused)throw Error('symlink accepted');
 console.log('permission-contract-ok');
 });`;
 const output=execFileSync('docker',['run','--rm','--network','none','--mount',`type=bind,src=${resolve('lib/secret-permissions.ts')},dst=/helper.ts,readonly`,'node:24-alpine','node','--experimental-strip-types','-e',script],{encoding:'utf8',timeout:60000});
 expect(output).toContain('permission-contract-ok');
},70000);

it('keeps credential candidates and rollback root-only, rejects links and read-only custody, and preserves the active file', async () => {
 const {mkdtempSync,mkdirSync,rmSync} = await import('node:fs');
 const {tmpdir} = await import('node:os');
 const {join} = await import('node:path');
 const {dirname} = await import('node:path');
 const {createRequire} = await import('node:module');
 const require = createRequire(import.meta.url);
 const repo = resolve('../..');
 const probe = mkdtempSync(join(tmpdir(), 'credential-permissions-'));
 mkdirSync(join(probe, 'readonly'), {mode:0o700});
 const esbuild = require(require.resolve('esbuild', {paths:[dirname(require.resolve('tsx'))]}));
 const script = `
 import fs from 'node:fs';
 import {CredentialFiles} from '${repo}/services/keeper/lib/credential-files.ts';
 fs.mkdirSync('/tmp/custody',{mode:0o700});
 const files=new CredentialFiles('/tmp/custody');
 fs.writeFileSync(files.activePath,'synthetic-old-token',{mode:0o600});
 const id='11111111-1111-4111-8111-111111111111';
 files.stage(id,'synthetic-new-token');files.preserveActive(id);
 for(const kind of ['candidate','rollback']) {
  const s=fs.statSync('/tmp/custody/.notion-'+id+'.'+kind);
  if(s.uid!==0||s.gid!==0||(s.mode&511)!==384)throw Error('custody permissions');
 }
 fs.linkSync('/tmp/custody/.notion-'+id+'.candidate','/tmp/linked-candidate');
 let refused=false;try{files.removeCandidate(id)}catch{refused=true}if(!refused)throw Error('hardlink accepted');
 fs.unlinkSync('/tmp/linked-candidate');files.removeCandidate(id);
 fs.unlinkSync(files.activePath);fs.symlinkSync('/tmp/custody/.notion-'+id+'.rollback',files.activePath);
 refused=false;try{files.activeExists()}catch{refused=true}if(!refused)throw Error('symlink accepted');
 fs.unlinkSync(files.activePath);fs.writeFileSync(files.activePath,'synthetic-old-token',{mode:0o600});
 // This mount has otherwise-correct ownership/mode, but access must detect EROFS.
 const ro=fs.statSync('/readonly');
 const readOnly = new CredentialFiles('/readonly',{uid:ro.uid,gid:ro.gid});
 refused=false;try{readOnly.verifyRoot()}catch{refused=true}if(!refused)throw Error('read-only root accepted');
 if(fs.readFileSync(files.activePath,'utf8')!=='synthetic-old-token')throw Error('active changed');
 console.log('credential-custody-ok');`;
 try {
  // Bundle locally, then execute plain JS on Linux. Never copy a macOS native compiler into Docker.
  esbuild.buildSync({stdin:{contents:script,resolveDir:repo,loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:join(probe,'probe.mjs')});
  const output=execFileSync('docker',['run','--rm','--network','none','--mount',`type=bind,src=${probe},dst=/probe,readonly`,'--mount',`type=bind,src=${probe}/readonly,dst=/readonly,readonly`,'node:24-alpine','node','/probe/probe.mjs'],{encoding:'utf8',timeout:60000});
  expect(output).toContain('credential-custody-ok');
 } finally {rmSync(probe,{recursive:true,force:true});}
},70000);
