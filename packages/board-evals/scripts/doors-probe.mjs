// Isolated copy: never replay or delete the repository fixture's existing workflow world.
import {mkdtempSync,cpSync,symlinkSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ensureProbeExtensionBuilt} from './proof-harness.mjs';
const source=resolve(fileURLToPath(new URL('..',import.meta.url))),root=mkdtempSync(join(tmpdir(),'lares-inert-door-')),run=promisify(execFile);
try {
 await ensureProbeExtensionBuilt();
 cpSync(source,root,{recursive:true,filter:path=>!['node_modules','.eve','.output','.workflow-data','.git'].includes(basename(path))});
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'));
 const env={...process.env};
 for(const [key,value]of Object.entries({SEAM_GRANTS:'[]',BOARD_LEVELS:'{}',BOARD_SKEW:'0',BOARD_LOG:'',BOARD_EVENTS:''})){env[key]=join(root,key);writeFileSync(env[key],value);}
 writeFileSync(env.BOARD_EVENTS+'.resumed','');
 const eve=join(source,'node_modules/.bin/eve');
 await run(eve,['build'],{cwd:root,env,maxBuffer:16*1024*1024});
 const result=await run(eve,['eval','doors','--verbose','--timeout','180000','--max-concurrency','1'],{cwd:root,env,maxBuffer:16*1024*1024});
 console.log(result.stdout);if(result.stderr)console.error(result.stderr);
}finally{rmSync(root,{recursive:true,force:true});}
