import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Runs the real check inside a throwaway git repository with a made-up deny-list.
const script = resolve(import.meta.dirname, 'check-namespace.mjs');

function run(files, denylist) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-check-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  const env = { ...process.env };
  delete env.LARES_DENYLIST_FILE;
  if (denylist !== undefined) {
    const list = join(mkdtempSync(join(tmpdir(), 'ns-list-')), 'list.txt');
    writeFileSync(list, denylist);
    env.LARES_DENYLIST_FILE = list;
  }
  return spawnSync('node', [script], { cwd: dir, env, encoding: 'utf8' });
}

test('passes without a deny-list and says only generic checks ran', () => {
  const r = run({ 'a.md': 'zorblax appears here\n' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /generic checks only/);
});

test('fails when a file contains a listed word, reporting file:line without the word', () => {
  const r = run({ 'a.md': 'fine\nthe Zorblax thing\n' }, '# comment\n\nzorb(lax|lex)\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.md:2 \(matches a private deny-list entry\)/);
  assert.doesNotMatch(r.stderr + r.stdout, /zorb/i);
});

test('whole words only, and a negative assertion in a test is allowed', () => {
  const ok = run({ 'a.md': 'zorblaxes\n', 'pkg/tests/x.test.ts': 'expect(t).not.toContain("zorblax");\n' }, 'zorblax\n');
  assert.equal(ok.status, 0);
});

test('an underscore or a literal escape before the word still counts as the word', () => {
  const joined = run({ 'a.ts': 'const id = "U_ZORBLAX";\n' }, 'zorblax\n');
  assert.equal(joined.status, 1);
  const escaped = run({ 'b.ts': 'const s = "Hi\\n\\nZorblax";\n' }, 'zorblax\n');
  assert.equal(escaped.status, 1);
  const embedded = run({ 'c.ts': 'const s = "unzorblaxed and zorblaxes";\n' }, 'zorblax\n');
  assert.equal(embedded.status, 0);
});

test('an unreadable deny-list file fails the check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-check-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = spawnSync('node', [script], { cwd: dir, env: { ...process.env, LARES_DENYLIST_FILE: join(dir, 'missing.txt') }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
});
