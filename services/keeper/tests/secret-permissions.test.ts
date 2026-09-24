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
