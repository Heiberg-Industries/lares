import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
function fixture(encrypted:boolean){
 const root=mkdtempSync(join(tmpdir(),'lares-backup-'));roots.push(root);
 for(const p of ['bin','etc/agent-box','etc/lares/secrets','opt/agent-box','srv/lares/agents/example','var/backups','var/lib/docker/volumes/fixture_workflow/_data'])mkdirSync(join(root,p),{recursive:true});
 writeFileSync(join(root,'opt/agent-box/.env'),'OLD_TEST_SECRET=old-secret');
 writeFileSync(join(root,'etc/lares/keeper.json'),'{"privateConfig":"test-only"}');
 writeFileSync(join(root,'etc/lares/secrets/key'),'NEW_TEST_SECRET');
 writeFileSync(join(root,'srv/lares/agents/example/agent.json'),'{"name":"example"}');
 const key=join(root,'identity');
 execFileSync('age-keygen',['-o',key],{stdio:'pipe'});
 const recipient=execFileSync('age-keygen',['-y',key],{encoding:'utf8'}).trim();
 const envFile=join(root,'backup.env');
 writeFileSync(envFile,`RESTIC_PASSWORD_FILE=/dev/null\nSTORAGEBOX_SSH_KEY=/dev/null\nSTORAGEBOX_USER=test\nSTORAGEBOX_HOST=example.invalid\nRESTIC_REPO_PATH=test\nLARES_WORKFLOW_VOLUMES=fixture_workflow\n${encrypted?`AGE_SECRETS_RECIPIENT=${recipient}\n`:''}`);
 writeFileSync(join(root,'bin/docker'),`#!/usr/bin/env python3
import sys,os
a=sys.argv
if 'volume' in a:
 if os.environ.get('MISSING_WORKFLOW'): sys.exit(1)
 print(os.environ['FIXTURE_ROOT']+'/var/lib/docker/volumes/fixture_workflow/_data')
elif 'psql' in a: print('fixture_db')
elif 'pg_dump' in a: print('x'*2048)
elif 'pg_dumpall' in a: print('-- fixture roles')
`,{mode:0o755});
 writeFileSync(join(root,'bin/stat'),`#!/usr/bin/env python3
import os,sys
print(os.stat(sys.argv[-1]).st_size)
`,{mode:0o755});
 writeFileSync(join(root,'bin/restic'),`#!/usr/bin/env python3
import json,os,pathlib,shutil,sys
r=pathlib.Path(os.environ['FIXTURE_ROOT'])
(r/'restic-args.json').write_text(json.dumps(sys.argv[1:]))
shutil.copytree(r/'var/backups/pg',r/'captured-dumps')
`,{mode:0o755});
 // Relocate only filesystem roots into this disposable fixture. The actual dump,
 // path selection, encryption pipeline, restic invocation and failure gates run.
 let script=readFileSync(resolve('ops/backup.sh'),'utf8');
 for(const prefix of ['/etc/','/opt/','/srv/','/var/backups/','/var/lib/docker/'])script=script.replaceAll(prefix,root+prefix);
 script=script.replace('tar -C / -cf -',`tar -C '${root}' -cf -`);
 const file=join(root,'backup.sh');writeFileSync(file,script);
 return {root,key,file,env:{...process.env,PATH:join(root,'bin')+':'+process.env.PATH,AGENT_BOX_BACKUP_ENV:envFile,FIXTURE_ROOT:root}};
}
it('backs up Lares definitions and encrypts new keeper configuration/secrets with the existing escrow key',()=>{
 const f=fixture(true);execFileSync('bash',[f.file],{env:f.env,stdio:'pipe'});
 const args=JSON.parse(readFileSync(join(f.root,'restic-args.json'),'utf8'));
 expect(args).toContain(join(f.root,'srv/lares'));expect(args).not.toContain(join(f.root,'etc/lares'));
 expect(args).toContain(join(f.root,'var/lib/docker/volumes/fixture_workflow/_data'));
 const encrypted=join(f.root,'captured-dumps/secrets/agent-box-secrets.tar.age');
 expect(readFileSync(encrypted).includes(Buffer.from('NEW_TEST_SECRET'))).toBe(false);
 const archive=execFileSync('age',['-d','-i',f.key,encrypted]);
 const entries=execFileSync('tar',['-tf','-'],{input:archive,encoding:'utf8'});
 expect(entries).toContain('etc/lares/keeper.json');expect(entries).toContain('etc/lares/secrets/key');expect(entries).toContain('opt/agent-box/.env');
 expect(execFileSync('tar',['-xOf','-','etc/lares/secrets/key'],{input:archive,encoding:'utf8'})).toBe('NEW_TEST_SECRET');
});
it('refuses an incomplete backup when a required workflow file volume is unavailable',()=>{
 const f=fixture(true);const result=spawnSync('bash',[f.file],{env:{...f.env,MISSING_WORKFLOW:'1'},encoding:'utf8'});
 expect(result.status).not.toBe(0);expect(()=>readFileSync(join(f.root,'restic-args.json'))).toThrow();
});
it('fails before recording a snapshot if Lares exists without encrypted-secret escrow',()=>{
 const f=fixture(false);const result=spawnSync('bash',[f.file],{env:f.env,encoding:'utf8'});
 expect(result.status).not.toBe(0);expect(result.stderr).toContain('secrets encryption is not configured');
 expect(()=>readFileSync(join(f.root,'restic-args.json'))).toThrow();
});
// LAR-54-s6: without RESTIC_REPOSITORY, backup.sh must keep talking to restic exactly
// as it always has — the Hetzner Storage Box over rclone is a real, deployed consumer
// of that form, not a fallback to delete later.
it('keeps the rclone form when RESTIC_REPOSITORY is not set',()=>{
 const f=fixture(true);execFileSync('bash',[f.file],{env:f.env,stdio:'pipe'});
 const args=JSON.parse(readFileSync(join(f.root,'restic-args.json'),'utf8'));
 expect(args).toContain('-o');expect(args.some((a:string)=>a.startsWith('rclone.program='))).toBe(true);
 expect(args).toContain('-r');expect(args).toContain('rclone:test');
});
// LAR-54-s6: when RESTIC_REPOSITORY is set, restic is pointed at it directly (any
// repository restic supports: sftp:, s3:, a local path) and the rclone-over-SSH form
// disappears entirely — no '-o'/'rclone.program' at all.
it('uses RESTIC_REPOSITORY directly and drops the rclone option when it is set',()=>{
 const f=fixture(true);
 execFileSync('bash',[f.file],{env:{...f.env,RESTIC_REPOSITORY:'s3:https://key:secret@example.invalid/bucket'},stdio:'pipe'});
 const args=JSON.parse(readFileSync(join(f.root,'restic-args.json'),'utf8'));
 expect(args).toContain('-r');expect(args).toContain('s3:https://key:secret@example.invalid/bucket');
 expect(args).not.toContain('-o');
 expect(args.some((a:string)=>String(a).includes('rclone.program'))).toBe(false);
});
