import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// These tests must keep rejecting the retired private name. Do not rename their
// negative assertions to the public name. Geography is unrelated project data.
const exceptions = new Set([
  'scripts/check-namespace.mjs',
  'services/console/data/cities.json',
]);
const guards = /not\.toMatch\(\/.*(?:\|orbis|orbis\|)/i;
const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const failures = [];
for (const path of new Set(paths)) {
  if (exceptions.has(path)) continue;
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { continue; }
  if (text.includes('\0') && !/\.(?:ts|tsx|js|mjs|json|md|sql|sh|ya?ml)$/.test(path)) continue;
  text.split('\n').forEach((line, index) => {
    if (/orbis/i.test(line) && !(path.includes('/tests/') && guards.test(line))) failures.push(`${path}:${index + 1}`);
  });
}
if (failures.length) {
  console.error('Retired namespace references remain:\n' + failures.join('\n'));
  process.exitCode = 1;
} else console.log('Lares namespace check passed (privacy guards and geographic names preserved).');
