import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

if (process.getuid?.() !== 0) throw new Error('Eve startup admission subprocess proof requires the isolated CI root fixture');

const role = process.argv[2];
if (role !== 'chief-of-staff' && role !== 'creative') throw new Error('pass the role image being proved');
const roleRequire = createRequire(new URL(`../../${role}/package.json`, import.meta.url));
function eveRoot() {
  let current = path.dirname(roleRequire.resolve('eve'));
  while (current !== path.dirname(current)) {
    const packageFile = path.join(current, 'package.json');
    if (existsSync(packageFile) && JSON.parse(readFileSync(packageFile, 'utf8')).name === 'eve') return current;
    current = path.dirname(current);
  }
  throw new Error('could not locate installed pinned Eve package');
}

const productionPath = path.join(eveRoot(), 'dist/src/internal/nitro/host/start-production-server.js');
const pinnedProduction = readFileSync(productionPath, 'utf8');
for (const marker of [
  'function validateMaintenanceAdmission(participating=false)',
  'statError.code!==`EBADF`',
  'if(participating||gateFd.isFile())',
  'const checkAdmission=()=>',
  'stdio:(checkAdmission()?',
]) assert.ok(pinnedProduction.includes(marker), `installed Eve patch is missing ${marker}`);

const root = fsMkdirScratch();
const admissionDir = '/run/lares-maintenance/admission';
const parentDir = '/run/lares-maintenance';
if (existsSync(parentDir)) throw new Error('fixed Eve admission test path already exists on the CI runner');
mkdirSync(parentDir, { mode: 0o755 });
mkdirSync(admissionDir, { mode: 0o755 });
const installationId = '11111111-1111-4111-8111-111111111111';
const epoch = '7';
const gatePath = path.join(admissionDir, 'service-gate.lock');
const intentPath = path.join(admissionDir, 'intent.json');
writeFileSync(gatePath, '', { mode: 0o444 });
writeFileSync(intentPath, JSON.stringify({ epoch: Number(epoch), installationId, state: 'normal', version: 1 }) + '\n', { mode: 0o444 });

const appRoot = path.join(root, 'app');
const serverDir = path.join(appRoot, '.output/server');
mkdirSync(serverDir, { recursive: true });
writeFileSync(path.join(serverDir, 'index.mjs'), `import { createServer } from 'node:http';
import { fstatSync, writeFileSync } from 'node:fs';
const stat = (() => { try { const s=fstatSync(9); return {dev:s.dev,ino:s.ino,mode:s.mode}; } catch (e) { return {error:e.code}; } })();
if (process.env.LARES_TEST_CHILD_MARKER) writeFileSync(process.env.LARES_TEST_CHILD_MARKER, JSON.stringify(stat));
const server=createServer((_req,res)=>{res.statusCode=200;res.end('ready');});
server.listen(Number(process.env.PORT), '127.0.0.1', ()=>console.log('http://127.0.0.1:'+process.env.PORT));
`);

const helperPath = path.join(root, 'runner.mjs');
const modulePath = path.join(root, 'start-production-server.mjs');
const hostPath = JSON.stringify(admissionDir);
let source = pinnedProduction.replace('ADMISSION_DIR=`/run/lares-maintenance/admission`', `ADMISSION_DIR=${hostPath}`);
const loaderImport = 'import{loadDevelopmentEnvironmentFiles}from"#cli/dev/environment.js";';
const prewarmImport = 'import{prewarmBuiltAppSandboxes}from"#execution/sandbox/prewarm.js";';
const spawnImport = 'import{spawn}from"node:child_process";';
assert.ok(source.includes(loaderImport) && source.includes(prewarmImport) && source.includes(spawnImport));
source = source.replace(loaderImport, `const loadDevelopmentEnvironmentFiles=async()=>{if(process.env.LARES_TEST_DOTENV_MARKER)writeFileSync(process.env.LARES_TEST_DOTENV_MARKER,'called');if(process.env.LARES_TEST_MUTATE==='dotenv'){delete process.env.LARES_MAINTENANCE_ADMISSION_DIR;delete process.env.LARES_MAINTENANCE_INSTALLATION_ID;delete process.env.LARES_MAINTENANCE_EPOCH;closeSync(9)}};`)
  .replace(prewarmImport, `const prewarmBuiltAppSandboxes=async()=>{if(process.env.LARES_TEST_PREWARM_MARKER)writeFileSync(process.env.LARES_TEST_PREWARM_MARKER,'called');if(process.env.LARES_TEST_MUTATE==='prewarm'){delete process.env.LARES_MAINTENANCE_ADMISSION_DIR;delete process.env.LARES_MAINTENANCE_INSTALLATION_ID;delete process.env.LARES_MAINTENANCE_EPOCH;closeSync(9)}};`)
  .replace(spawnImport, `import{spawn as realSpawn}from"node:child_process";const spawn=(...args)=>{writeFileSync(process.env.LARES_TEST_SPAWN_MARKER,JSON.stringify(args[2].stdio));return realSpawn(...args)};`);
// The private imports above become local stubs; the production function and its control flow are
// copied from the installed, patched Eve 0.60.1 file verbatim.
source = source.replace('import{closeSync,constants,existsSync,fstatSync,lstatSync,openSync,readSync}from"node:fs";',
  'import{closeSync,constants,existsSync,fstatSync,lstatSync,openSync,readSync,writeFileSync}from"node:fs";');
writeFileSync(modulePath, source);
writeFileSync(helperPath, `import { startProductionServer } from ${JSON.stringify(modulePath)};
const appRoot=${JSON.stringify(appRoot)};
try { const server=await startProductionServer(appRoot,{host:'127.0.0.1',port:0}); await server.close(); await server.wait(); }
catch (error) { if (error?.code !== undefined) console.error('unexpected startup error'); process.exitCode=1; }
`);

function fsMkdirScratch() {
  const directory = path.join(os.tmpdir(), `lares-eve-admission-${process.pid}-${Date.now()}`);
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}
function run(label, { metadata = false, fd9, mutate, nonEbafd = false } = {}) {
  const env = { ...process.env, LARES_TEST_SPAWN_MARKER: path.join(root, `${label}.spawn`),
    LARES_TEST_DOTENV_MARKER: path.join(root, `${label}.dotenv`),
    LARES_TEST_PREWARM_MARKER: path.join(root, `${label}.prewarm`),
    LARES_TEST_CHILD_MARKER: path.join(root, `${label}.child`) };
  delete env.LARES_MAINTENANCE_ADMISSION_DIR;
  delete env.LARES_MAINTENANCE_INSTALLATION_ID;
  delete env.LARES_MAINTENANCE_EPOCH;
  if (metadata) Object.assign(env, { LARES_MAINTENANCE_ADMISSION_DIR: admissionDir,
    LARES_MAINTENANCE_INSTALLATION_ID: installationId, LARES_MAINTENANCE_EPOCH: epoch });
  if (mutate) env.LARES_TEST_MUTATE = mutate;
  const stdio = ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore'];
  let fd;
  if (fd9) { fd = openSync(fd9, constants.O_RDONLY); stdio.push(fd); }
  if (nonEbafd) {
    let fsSource = readFileSync(modulePath, 'utf8');
    fsSource = fsSource.replace('import{closeSync,constants,existsSync,fstatSync,lstatSync,openSync,readSync,writeFileSync}from"node:fs";',
      'import{closeSync,constants,existsSync,fstatSync as nativeFstatSync,lstatSync,openSync,readSync,writeFileSync}from"node:fs";const fstatSync=(fd)=>{if(fd===9){const e=new Error();e.code="EIO";throw e}return nativeFstatSync(fd)};');
    const errorModule = path.join(root, `${label}-eio.mjs`); writeFileSync(errorModule, fsSource);
    const runner = path.join(root, `${label}-eio-runner.mjs`);
    writeFileSync(runner, readFileSync(helperPath, 'utf8').replace(modulePath, errorModule));
    return spawnSync(process.execPath, [runner], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  try { return spawnSync(process.execPath, [helperPath], { env, encoding: 'utf8', stdio }); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function refused(result, label) {
  assert.equal(result.status, 78, `${label} status; stdout=${result.stdout} stderr=${result.stderr}`);
  assert.equal(result.stderr.trim(), 'maintenance admission refused');
  assert.equal(existsSync(path.join(root, `${label}.spawn`)), false, `${label} reached Eve child spawn`);
}

test('ordinary upstream startup keeps three stdio entries with Node-owned fd 9', () => {
  const result = run('ordinary');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(existsSync(path.join(root, 'ordinary.prewarm')));
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'ordinary.spawn'), 'utf8')), ['ignore', 'pipe', 'pipe']);
});

test('no metadata refuses a deliberately supplied regular-file fd 9 before dotenv', () => {
  const file = path.join(root, 'regular-fd9'); writeFileSync(file, 'sentinel');
  const result = run('regular', { fd9: file }); refused(result, 'regular');
  assert.equal(existsSync(path.join(root, 'regular.dotenv')), false);
});

test('partial admission metadata refuses before dotenv', () => {
  const env = { ...process.env, LARES_TEST_SPAWN_MARKER: path.join(root, 'partial.spawn') };
  env.LARES_MAINTENANCE_ADMISSION_DIR = '';
  delete env.LARES_MAINTENANCE_INSTALLATION_ID; delete env.LARES_MAINTENANCE_EPOCH;
  const partial = spawnSync(process.execPath, [helperPath], { env, encoding: 'utf8' });
  refused(partial, 'partial');
});

test('complete metadata refuses a regular fd 9 that is not the named gate inode', () => {
  const wrong = path.join(root, 'wrong-inode'); writeFileSync(wrong, 'other gate');
  const result = run('wrong-inode', { metadata: true, fd9: wrong }); refused(result, 'wrong-inode');
});

test('complete metadata refuses a nonregular fd 9', () => {
  const result = run('wrong-type', { metadata: true, fd9: root }); refused(result, 'wrong-type');
});

test('a non-EBADF fd 9 stat failure refuses before dotenv', () => {
  const result = run('eio', { nonEbafd: true }); refused(result, 'eio');
});

test('valid participation passes fd 9 to Eve child and records its gate inode', () => {
  const result = run('valid', { metadata: true, fd9: gatePath });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const stdio = JSON.parse(readFileSync(path.join(root, 'valid.spawn'), 'utf8'));
  assert.equal(stdio.length, 10); assert.equal(stdio[9], 9);
  const child = JSON.parse(readFileSync(path.join(root, 'valid.child'), 'utf8'));
  const gate = readFileSync(gatePath);
  assert.equal(child.error, undefined); assert.equal(child.mode & 0o170000, 0o100000);
  assert.equal(child.ino, (awaitStat(gatePath)).ino);
  assert.ok(gate.length === 0);
});

test('sticky participant status refuses when dotenv removes metadata and closes fd 9', () => {
  const result = run('dotenv-loss', { metadata: true, fd9: gatePath, mutate: 'dotenv' }); refused(result, 'dotenv-loss');
  assert.ok(existsSync(path.join(root, 'dotenv-loss.dotenv')));
  assert.equal(existsSync(path.join(root, 'dotenv-loss.prewarm')), false);
});

test('sticky participant status refuses when prewarm removes metadata and closes fd 9', () => {
  const result = run('prewarm-loss', { metadata: true, fd9: gatePath, mutate: 'prewarm' }); refused(result, 'prewarm-loss');
  assert.ok(existsSync(path.join(root, 'prewarm-loss.prewarm')));
});

function awaitStat(file) {
  const stat = roleRequire('node:fs').statSync(file);
  return { dev: stat.dev, ino: stat.ino };
}

test.after(() => {
  rmSync(parentDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});
