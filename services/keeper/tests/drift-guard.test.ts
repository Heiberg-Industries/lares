import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect,it } from 'vitest';
it('compares independent owned files on both sides, diagnoses with the same arrays, and requires explicit reaccept',()=>{
 const root=mkdtempSync(join(tmpdir(),'lares-drift-'));
 try {
  for(const d of ['bin','box','repo','state'])mkdirSync(join(root,d));
  writeFileSync(join(root,'bin','date'),'#!/bin/sh\necho 2026-09-16T00:00:00Z\n',{mode:0o755});
  writeFileSync(join(root,'bin','git'),'#!/bin/sh\nif [ "$3" = rev-parse ]; then echo fixture; fi\nexit 0\n',{mode:0o755});
  writeFileSync(join(root,'bin','docker'),`#!/usr/bin/env python3
import sys,os
args=sys.argv[1:]
files=[args[i+1] for i,a in enumerate(args) if a=='-f']
with open(os.environ['CALLS'],'a') as out: out.write('|'.join(files)+'\\n')
for f in files:
 with open(f) as inp: print(inp.read().strip())
`,{mode:0o755});
  for(const dir of ['box','repo'])for(const f of ['compose.yaml','compose.override.yaml','compose.lares-agents.yaml','compose.lares-keeper.yaml'])writeFileSync(join(root,dir,f),f+' baseline');
  const env={...process.env,PATH:join(root,'bin')+':'+process.env.PATH,ENV_FILE:join(root,'absent'),STATE_DIR:join(root,'state'),BOX_DIR:join(root,'box'),REPO_DIR:join(root,'repo'),REPO_COMPOSE:join(root,'repo','compose.yaml'),REPO_OVERRIDE:join(root,'repo','compose.override.yaml'),KUMA_PUSH_URL:'',CALLS:join(root,'calls')};
  const run=(args:string[]=[])=>execFileSync('bash',[resolve('../box/ops/compose-drift-guard.sh'),...args],{env,encoding:'utf8'});
  expect(run(['--accept'])).toContain('baseline accepted');expect(run()).toContain('drift unchanged');
  writeFileSync(join(root,'box','compose.lares-agents.yaml'),'new agent');expect(run()).toContain('NEW compose drift');
  expect(readFileSync(join(root,'state','accepted-drift.diff'),'utf8')).toBe('');
  const calls=readFileSync(join(root,'calls'),'utf8').trim().split('\n');expect(calls.at(-2)?.split('|')).toHaveLength(4);expect(calls.at(-1)?.split('|')).toHaveLength(4);
  expect(run(['--accept'])).toContain('baseline accepted');expect(run()).toContain('drift unchanged');
 } finally {rmSync(root,{recursive:true,force:true});}
});
