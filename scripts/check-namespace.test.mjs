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

// Internal planning labels: one rejected input and one near-miss per pattern.
const labelCases = [
  ['slice id', '// W8B-s5 added this\n', '// W3C is a name, and s5 alone is fine\n'],
  ['slice id with a letter suffix', 'see W5I-s7b\n', 'W5I-sprint\n'],
  ['fix round', '// Fix round 2: hardened\n', 'a round of fixes; round 2 of the tournament\n'],
  ['controller ruling', 'per the controller ruling\n', 'the controller decides; a ruling was made\n'],
  ['migration number', 'Box 085 renamed it\n', 'the box 85 items; a box 4000 pixels wide\n'],
  ['owner decision', 'owner decision C1 says so\n', 'the owner decision was to wait; owner decisions\n'],
  ['ruling', 'ruling D4 applies\n', 'ruling out the rest; ruling 4\n'],
];
for (const [name, bad, ok] of labelCases) {
  test(`planning label (${name}) is rejected, a near-miss passes`, () => {
    const rejected = run({ 'src/a.ts': bad });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /src\/a\.ts:1 \(internal planning label/);
    assert.equal(run({ 'src/a.ts': ok }).status, 0);
  });
}

test('planning labels are tolerated only in the dated board evidence records', () => {
  const label = 'measured at W2-s11 after box 086\n';
  assert.equal(run({ 'packages/board-evals/proofs/p.md': label }).status, 0);
  assert.equal(run({ 'packages/board-evals/snapshots/s.md': label }).status, 0);
  assert.equal(run({ 'packages/board-evals/src/x.ts': label }).status, 1);
  // Shipped migration files are referenced by release records and never rewritten.
  assert.equal(run({ 'services/chief-of-staff/sql/006-x.sql': '-- upgrade (W2-s8c)\n' }).status, 0);
  assert.equal(run({ 'services/chief-of-staff/lib/x.ts': '// upgrade (W2-s8c)\n' }).status, 1);
});

test('an unreadable deny-list file fails the check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-check-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = spawnSync('node', [script], { cwd: dir, env: { ...process.env, LARES_DENYLIST_FILE: join(dir, 'missing.txt') }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
});
